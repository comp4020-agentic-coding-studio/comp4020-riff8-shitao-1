import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { nameFor } from "../src/identity.ts";
import { handTag } from "../src/log.ts";

// The log is read, not rendered: a presenter narrates two visitors from
// `flyctl logs` alone. So this boots its own server (a scratch database, a
// free port) and reads what it prints, rather than asking the shared app.
let server: ChildProcess;
let base: string;
let out = "";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(mkdtempSync(join(tmpdir(), "trace-log-")), "trace.db") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (chunk: Buffer) => (out += chunk));
  server.stderr!.on("data", (chunk: Buffer) => (out += chunk));
  for (let i = 0; !out.includes("Trace listening"); i++) {
    if (i > 100) throw new Error(`server didn't start:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  server?.kill();
});

interface Visitor {
  cookie: string;
  who: string;
}

async function visit(): Promise<Visitor> {
  const res = await fetch(new URL("/", base));
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const id = cookie.slice("hand=".length);
  return { cookie, who: `${nameFor(id)}/${handTag(id)}` };
}

const post = (path: string, cookie: string | null, body: unknown, form = false) =>
  fetch(new URL(path, base), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
  });

// Log lines are written synchronously before the response, but stdout is a
// pipe: give the chunk a moment to arrive.
async function lines(): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 100));
  return out.split("\n").filter(Boolean);
}

function expectLine(all: string[], who: string, action: string): void {
  const line = all.find((l) => l.includes(`  ${who}`) && l.endsWith(`  ${action}`));
  expect(line, `no log line "${who} ... ${action}" in:\n${all.join("\n")}`).toBeTruthy();
  expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ  /);
}

it("tells two hands apart, and logs every refused cross-hand action, without logging content", async () => {
  const a = await visit();
  const b = await visit();
  expect(a.who).not.toBe(b.who);

  const path = "M101,202 L303,404 L505,606";
  const secret = `private-${randomUUID()}`;
  const added = await post("/api/marks", a.cookie, { path, nonce: randomUUID() });
  expect(added.status).toBe(201);
  const { id } = (await added.json()) as { id: number };

  expect((await post(`/mine/marks/${id}/note`, a.cookie, { note: secret }, true)).status).toBe(303);
  expect((await post(`/mine/marks/${id}/note`, b.cookie, { note: "mine now" }, true)).status).toBe(404);
  expect((await post(`/mine/marks/${id}/delete`, b.cookie, {}, true)).status).toBe(404);
  expect((await post(`/mine/marks/${id}/delete`, null, {}, true)).status).toBe(404);
  expect((await fetch(new URL(`/mine/marks/${id}.svg`, base), { headers: { Cookie: b.cookie } })).status).toBe(404);
  expect((await post("/api/marks", a.cookie, { path: "M1,1 L2,2" })).status).toBe(429);
  expect((await post(`/mine/marks/${id}/note`, a.cookie, { note: "" }, true)).status).toBe(303);
  expect((await post(`/mine/marks/${id}/delete`, a.cookie, {}, true)).status).toBe(303);
  expect((await post(`/mine/marks/${id}/delete`, a.cookie, {}, true)).status).toBe(404);

  const all = await lines();
  expectLine(all, a.who, "new hand");
  expectLine(all, b.who, "new hand");
  expectLine(all, a.who, `added mark #${id}`);
  expectLine(all, a.who, `set a note on mark #${id}`);
  expectLine(all, b.who, `denied: tried to set a note on mark #${id} (not owner)`);
  expectLine(all, b.who, `denied: tried to delete mark #${id} (not owner)`);
  expectLine(all, "(no hand)", `denied: tried to delete mark #${id} (no hand cookie)`);
  expectLine(all, b.who, `denied: tried to download mark #${id} (not owner)`);
  expectLine(all, a.who, "denied: tried to add a second mark within 24h");
  expectLine(all, a.who, `cleared the note on mark #${id}`);
  expectLine(all, a.who, `deleted mark #${id}`);
  expectLine(all, a.who, `denied: tried to delete mark #${id} (already deleted)`);

  // What was drawn and written never reaches the log, nor the cookie itself.
  expect(out).not.toContain(secret);
  expect(out).not.toContain("mine now");
  expect(out).not.toContain("101,202");
  expect(out).not.toContain(a.cookie.slice("hand=".length));
});

it("logs a live stroke's start, commit and cancel, and a hand reaching for another's", async () => {
  const c = await visit();
  const d = await visit();
  const g1 = randomUUID();
  const g2 = randomUUID();

  expect((await post("/api/strokes/live", c.cookie, { gesture: g1, from: 0, points: [[10, 10]] })).status).toBe(200);
  expect((await post("/api/strokes/live", d.cookie, { gesture: g1, from: 1, points: [[20, 20]] })).status).toBe(403);
  expect((await post("/api/strokes/live/cancel", d.cookie, { gesture: g1 })).status).toBe(204);
  expect((await post("/api/strokes/live/cancel", c.cookie, { gesture: g1 })).status).toBe(204);
  expect((await post("/api/strokes/live", null, { gesture: g2, from: 0, points: [[1, 1]] })).status).toBe(401);

  expect((await post("/api/strokes/live", c.cookie, { gesture: g2, from: 0, points: [[30, 30]] })).status).toBe(200);
  const added = await post("/api/marks", c.cookie, { path: "M30,30 L40,40", gesture: g2, nonce: randomUUID() });
  const { id } = (await added.json()) as { id: number };

  const all = await lines();
  expectLine(all, c.who, "started a live stroke");
  expectLine(all, d.who, "denied: tried to extend another hand's live stroke (not owner)");
  expectLine(all, d.who, "denied: tried to cancel another hand's live stroke (not owner)");
  expectLine(all, c.who, "cancelled a live stroke");
  expectLine(all, "(no hand)", "denied: tried to draw live (no hand cookie)");
  expectLine(all, c.who, `committed its live stroke as mark #${id}`);
});
