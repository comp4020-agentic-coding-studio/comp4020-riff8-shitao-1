import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  addMark,
  allMarks,
  createHand,
  deleteMark,
  getHand,
  MARK_INTERVAL_MS,
  markByNonce,
  msUntilNextMark,
  ownMarks,
  setNote,
} from "./db.ts";
import { createLive, type LiveEvent } from "./live.ts";
import { colourFor, nameFor, newHandId, parseHandCookie, setHandCookie } from "./identity.ts";
import { keepsakeSvg, minePage, readmePage, untilPhrase, wallPage } from "./pages.ts";
import { isPrompt, promptFor } from "./prompts.ts";

const PORT = Number(process.env.PORT ?? 8080);
// Fly's proxy terminates TLS and forwards plain http; FLY_APP_NAME is only
// set on a real Fly machine, so it's a reliable stand-in for "the browser's
// connection is actually https" without trusting a header the app can't verify.
const isProd = Boolean(process.env.FLY_APP_NAME);

// How long a preview survives without an update before it's swept away: the
// drawing tab heartbeats well inside this, so only an abandoned gesture (a
// closed tab, a dropped connection) ever reaches it.
const PREVIEW_LEASE_MS = Number(process.env.PREVIEW_LEASE_MS ?? 5000);

const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// One "M" then one or more "L" segments, in the viewBox's integer-ish
// coordinate space --- exactly what public/wall.js emits. Capped at 2000
// points so a hand-rolled request can't post an arbitrarily large stroke.
const PATH_RE = /^M-?\d+(\.\d+)?,-?\d+(\.\d+)?(\sL-?\d+(\.\d+)?,-?\d+(\.\d+)?){1,2000}$/;

interface HandInfo {
  id: string;
  colour: string;
}

// Preview routes never mint a hand: only a visitor who already loaded the
// wall (and so holds a cookie the server issued) can draw live.
function existingHand(req: IncomingMessage): HandInfo | undefined {
  const id = parseHandCookie(req.headers.cookie);
  const found = id ? getHand(id) : undefined;
  return found ? { id: found.id, colour: found.colour } : undefined;
}

function ensureHand(req: IncomingMessage, res: ServerResponse): HandInfo {
  const existing = parseHandCookie(req.headers.cookie);
  const found = existing ? getHand(existing) : undefined;
  if (found) return { id: found.id, colour: found.colour };

  const id = newHandId();
  const hand = createHand(id, nameFor(id), colourFor(id));
  res.setHeader("Set-Cookie", setHandCookie(id, isProd));
  return { id: hand.id, colour: hand.colour };
}

// The real-time layer: every open tab holds one of these open. Two kinds of
// event share it. `mark` is a committed stroke, written only after `addMark`
// returns; `preview`/`preview-end` (and the `previews` snapshot a fresh
// connection starts with) are the ephemeral strokes still being drawn, which
// src/live.ts keeps in memory and never persists. A plain in-memory Set is
// enough because fly.toml runs exactly one machine --- there's no
// cross-machine fan-out to build.
interface SseClient {
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

const sseClients = new Set<SseClient>();
const live = createLive({ leaseMs: PREVIEW_LEASE_MS });

function send(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.res.write(frame);
}

function broadcastLive(events: LiveEvent[]): void {
  for (const { type, ...data } of events) send(type, data);
}

// The gesture id lets viewers swap a preview for its committed stroke in
// place. Nothing a tab sends to prove who it is (the cookie, a submission
// nonce) ever goes out over this stream.
function broadcastMark(mark: {
  id: number;
  path: string;
  colour: string;
  prompt: string | null;
  gesture?: string;
}): void {
  send("mark", {
    id: mark.id,
    path: mark.path,
    colour: mark.colour,
    prompt: mark.prompt,
    gesture: mark.gesture,
  });
}

setInterval(() => broadcastLive(live.sweep()), 1000).unref();

// Private to the hand that writes it: stored beside the mark, shown only on
// that hand's /mine/ page and its own export, never on the wall, in
// /api/marks or over SSE.
const NOTE_MAX = 500;
const NONCE_RE = /^[A-Za-z0-9-]{8,64}$/;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      const hand = ensureHand(req, res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(wallPage(allMarks(), hand, msUntilNextMark(hand.id), PREVIEW_LEASE_MS, promptFor()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/readme/") {
      const readme = readFileSync("README.md", "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readmePage(readme));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/marks/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      // Fly's proxy (and some browsers) will drop an idle connection; a
      // comment line every 20s is invisible to EventSource but keeps it open.
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
      const client: SseClient = { res, heartbeat };
      sseClients.add(client);
      // Every connection (first or reconnect) starts from the strokes being
      // drawn right now, so a viewer never waits for the next point to see
      // one, and a reconnecting viewer drops any it missed the end of.
      res.write(`event: previews\ndata: ${JSON.stringify(live.snapshot())}\n\n`);
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(client);
      });
      return;
    }

    // Committed marks as data, for a tab that reconnects and needs to catch
    // up on what it missed. `mine` is computed per request and the hand id
    // itself never leaves the server.
    if (req.method === "GET" && url.pathname === "/api/marks") {
      const handId = parseHandCookie(req.headers.cookie);
      json(
        res,
        200,
        allMarks().map((m) => ({
          id: m.id,
          path: m.path,
          colour: m.colour,
          prompt: m.prompt,
          mine: m.hand_id === handId,
        })),
      );
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/strokes/live" || url.pathname === "/api/strokes/live/cancel")) {
      const hand = existingHand(req);
      if (!hand) {
        json(res, 401, { error: "Load the wall first." });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req, 8_000)) as Record<string, unknown>;
        if (typeof body !== "object" || body === null) throw new Error("not an object");
      } catch {
        json(res, 400, { error: "Malformed request." });
        return;
      }
      if (url.pathname.endsWith("/cancel")) {
        broadcastLive(live.cancel(hand.id, body.gesture));
        res.writeHead(204);
        res.end();
        return;
      }
      // The same eligibility as a finished mark: a hand that can't add a
      // mark right now has nothing to show live either.
      // 403, not 429: this won't change by retrying, unlike a rate limit.
      if (msUntilNextMark(hand.id) > 0) {
        json(res, 403, { error: "Your mark is already on the wall." });
        return;
      }
      const result = live.update(hand.id, hand.colour, body);
      if (!result.ok) {
        json(res, result.status, { error: result.reason, count: result.count });
        return;
      }
      broadcastLive(result.events);
      json(res, 200, { count: result.count });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/style.css" || url.pathname === "/wall.js")) {
      const filePath = join("public", url.pathname);
      const type = STATIC_TYPES[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(readFileSync(filePath));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/marks") {
      const hand = ensureHand(req, res);

      const raw = await readBody(req);
      let body: { path?: unknown; gesture?: unknown; nonce?: unknown; prompt?: unknown; note?: unknown };
      try {
        body = JSON.parse(raw);
        if (typeof body !== "object" || body === null) throw new Error("not an object");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Malformed request.");
        return;
      }
      const { path, gesture } = body;
      const nonce = typeof body.nonce === "string" && NONCE_RE.test(body.nonce) ? body.nonce : null;
      const prompt = isPrompt(body.prompt) ? body.prompt : null;

      if (typeof path !== "string" || !PATH_RE.test(path)) {
        broadcastLive(live.cancel(hand.id, gesture));
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("That doesn't look like a mark.");
        return;
      }
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > NOTE_MAX)) {
        broadcastLive(live.cancel(hand.id, gesture));
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`A note can be up to ${NOTE_MAX} characters.`);
        return;
      }

      // A retry of a submission that already landed (its response lost on
      // the way back): answer as if it had just succeeded, and change
      // nothing. The original already broadcast.
      const existing = nonce ? markByNonce(hand.id, nonce) : undefined;
      if (existing) {
        json(res, 201, { id: existing.id, nextAt: existing.created_at + MARK_INTERVAL_MS });
        return;
      }

      // The check has to be the last thing before the insert, with no
      // `await` between them: a client that holds its request body open
      // (a slow POST, or just a second tab) can otherwise pass this check
      // before either request has inserted, and post twice in one day.
      // node:sqlite's DatabaseSync is fully synchronous, so once nothing
      // separates the two, nothing can interleave here.
      const wait = msUntilNextMark(hand.id);
      if (wait > 0) {
        broadcastLive(live.cancel(hand.id, gesture));
        res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Your mark is already on the wall. You can add another ${untilPhrase(wait)}.`);
        return;
      }

      const mark = addMark(hand.id, path, hand.colour, Date.now(), { prompt, nonce });
      if (typeof body.note === "string") setNote(hand.id, mark.id, body.note);
      broadcastMark({ ...mark, gesture: live.commit(hand.id, gesture) });
      json(res, 201, { id: mark.id, nextAt: mark.created_at + MARK_INTERVAL_MS });
      return;
    }

    // --- My traces: everything here is about the requesting hand only. -----

    if (url.pathname.startsWith("/mine/")) {
      const hand = existingHand(req);
      if (req.method === "GET" && url.pathname === "/mine/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        const flash = url.searchParams.has("saved")
          ? "Note saved."
          : url.searchParams.has("deleted")
            ? "Deleted: that mark is off the wall and its note is gone."
            : "";
        res.end(minePage(hand ? ownMarks(hand.id) : [], hand ? msUntilNextMark(hand.id) : 0, flash));
        return;
      }
      if (req.method === "GET" && url.pathname === "/mine/export.json" && hand) {
        const marks = ownMarks(hand.id).map((m) => ({
          drawn_at: new Date(m.created_at).toISOString(),
          path: m.path,
          colour: m.colour,
          prompt: m.prompt,
          note: m.note,
        }));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="my-traces.json"',
        });
        res.end(JSON.stringify({ exported_at: new Date().toISOString(), marks }, null, 2));
        return;
      }
      const keepsake = url.pathname.match(/^\/mine\/marks\/(\d+)\.svg$/);
      if (req.method === "GET" && keepsake && hand) {
        const mark = ownMarks(hand.id).find((m) => m.id === Number(keepsake[1]));
        if (mark) {
          res.writeHead(200, {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="trace-${mark.id}.svg"`,
          });
          res.end(keepsakeSvg(mark));
          return;
        }
      }
      const action = url.pathname.match(/^\/mine\/marks\/(\d+)\/(note|delete)$/);
      if (req.method === "POST" && action && hand) {
        const markId = Number(action[1]);
        // 500 characters of note can urlencode to several KB.
        let raw: string;
        try {
          raw = await readBody(req, 32_000);
        } catch {
          res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("That's too long.");
          return;
        }
        const form = new URLSearchParams(raw);
        if (action[2] === "note") {
          const note = form.get("note") ?? "";
          if (note.length <= NOTE_MAX && setNote(hand.id, markId, note)) {
            res.writeHead(303, { Location: `/mine/?saved=${markId}#mark-${markId}` });
            res.end();
            return;
          }
        } else if (deleteMark(hand.id, markId)) {
          send("unmark", { id: markId });
          res.writeHead(303, { Location: "/mine/?deleted=1" });
          res.end();
          return;
        }
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Something went wrong.");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trace listening on 0.0.0.0:${PORT}`);
});
