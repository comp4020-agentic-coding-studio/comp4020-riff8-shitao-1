import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";

// Trace's own promises, from README.md's "what's enforced" list: a
// first-time visitor gets a hand, a mark they draw shows up and survives a
// fresh request, a hand can't draw twice in one day, and the page carries no
// third-party request.
const baseUrl = inject("baseUrl");

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie");
  expect(raw, "expected a Set-Cookie header on a first visit").toBeTruthy();
  return raw!.split(";")[0];
}

it("gives a first-time visitor a hand cookie", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const cookie = cookieFrom(res);
  expect(cookie).toMatch(/^hand=[0-9a-f-]{36}$/);
});

it("a hand's mark appears on the wall and survives a fresh request", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);

  const path = "M1,2 L3,4 L5,6";
  const post = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ path }),
  });
  expect(post.status).toBe(201);

  // A completely fresh request (same cookie, new fetch) --- not just reading
  // back the POST's own response --- so this actually checks persistence.
  const after = await fetch(new URL("/", baseUrl), { headers: { Cookie: cookie } });
  const html = await after.text();
  expect(html).toContain(path);
});

it("a returning hand can tell its own mark from everyone else's", async () => {
  const mine = cookieFrom(await fetch(new URL("/", baseUrl)));
  const other = cookieFrom(await fetch(new URL("/", baseUrl)));

  // Unique per run: the app under test keeps its database between runs, and
  // an identical path drawn by an earlier run's hand would match first.
  const path = `M${Date.now() % 100_000},12 L13,14 L15,16`;
  const post = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: mine },
    body: JSON.stringify({ path }),
  });
  expect(post.status).toBe(201);
  // A later mark from someone else, so painting in time order would bury this one.
  const later = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: other },
    body: JSON.stringify({ path: `M${Date.now() % 100_000},20 L21,22` }),
  });
  expect(later.status).toBe(201);

  const strokeFor = async (cookie: string) => {
    const html = await (await fetch(new URL("/", baseUrl), { headers: { Cookie: cookie } })).text();
    const svg = new JSDOM(html).window.document.getElementById("wall")!;
    const strokes = [...svg.querySelectorAll("path")];
    return {
      ownMark: strokes.find((p) => p.getAttribute("d") === path && p.classList.contains("mine")),
      // On a busy wall, later marks would bury it unless it's painted last.
      paintedLast: strokes.at(-1)?.getAttribute("d") === path,
      anyMatch: strokes.some((p) => p.getAttribute("d") === path),
    };
  };

  const asMine = await strokeFor(mine);
  expect(asMine.ownMark).toBeDefined();
  expect(asMine.paintedLast).toBe(true);
  const asOther = await strokeFor(other);
  expect(asOther.anyMatch).toBe(true);
  expect(asOther.ownMark).toBeUndefined();
});

it("refuses a second mark from the same hand on the same day", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);

  const post = (path: string) =>
    fetch(new URL("/api/marks", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ path }),
    });

  expect((await post("M1,1 L2,2")).status).toBe(201);
  expect((await post("M9,9 L8,8")).status).toBe(429);
});

it("refuses a same-day double mark even when one request's body is slow to arrive", async () => {
  // A plain sequential double-POST (above) can't catch a check-then-insert
  // race: the server has to actually be mid-way through one request's body
  // when the other's completes. Held-open connection A proves the window is
  // closed by deliberately finishing B first while A's body is still en
  // route --- the shape a slow network or a second tab genuinely produces.
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);
  const { hostname, port } = new URL(baseUrl);

  const connect = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), hostname, () => resolve(sock));
      sock.on("error", reject);
    });

  const readStatus = (sock: net.Socket): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      sock.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n")) {
          resolve(data.split(" ")[1]);
          sock.destroy();
        }
      });
    });

  const headers = (contentLength: number) =>
    `POST /api/marks HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\n` +
    `Cookie: ${cookie}\r\nContent-Length: ${contentLength}\r\nConnection: close\r\n\r\n`;

  const bodyA = JSON.stringify({ path: "M1,3 L2,4" });
  const bodyB = JSON.stringify({ path: "M5,6 L7,8" });

  const [sockA, sockB] = await Promise.all([connect(), connect()]);
  const statusA = readStatus(sockA);
  const statusB = readStatus(sockB);

  sockA.write(headers(Buffer.byteLength(bodyA)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  sockB.write(headers(Buffer.byteLength(bodyB)) + bodyB);
  expect(await statusB).toBe("201");

  sockA.write(bodyA);
  expect(await statusA).toBe("429");
});

it("rejects a mark that isn't a plain stroke path", async () => {
  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);

  const res = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ path: "<script>alert(1)</script>" }),
  });
  expect(res.status).toBe(400);
});

it("broadcasts a new mark over /api/marks/stream within a second", async () => {
  const controller = new AbortController();
  const stream = await fetch(new URL("/api/marks/stream", baseUrl), {
    signal: controller.signal,
  });
  expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const nextMarkEvent = (): Promise<{ path: string; colour: string }> =>
    (async () => {
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary !== -1) {
          const chunk = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (chunk.startsWith("event: mark")) {
            const line = chunk.split("\n").find((l) => l.startsWith("data: "))!;
            return JSON.parse(line.slice("data: ".length));
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before a mark event arrived");
        buffered += decoder.decode(value, { stream: true });
      }
    })();

  const first = await fetch(new URL("/", baseUrl));
  const cookie = cookieFrom(first);
  const path = "M11,12 L13,14";

  const [event] = await Promise.all([
    Promise.race([
      nextMarkEvent(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no mark event within 3s")), 3000),
      ),
    ]),
    fetch(new URL("/api/marks", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ path }),
    }).then((res) => expect(res.status).toBe(201)),
  ]);

  expect(event.path).toBe(path);
  controller.abort();
});

it("ships no third-party script or stylesheet", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const srcs = [...dom.window.document.querySelectorAll("script[src], link[rel=stylesheet]")].map(
    (el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "",
  );
  expect(srcs.length).toBeGreaterThan(0);
  for (const src of srcs) {
    expect(src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//")).toBe(
      false,
    );
  }
});

// --- Live previews -----------------------------------------------------------

// Reads one SSE connection, handing back events of a given type as they
// arrive (and remembering everything seen, so a test can check what never
// came).
async function openStream() {
  const controller = new AbortController();
  const res = await fetch(new URL("/api/marks/stream", baseUrl), { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const seen: { event: string; data: any }[] = [];
  const pending: { match: (e: { event: string; data: any }) => boolean; resolve: (d: any) => void }[] = [];
  const offer = (e: { event: string; data: any }) => {
    seen.push(e);
    const i = pending.findIndex((p) => p.match(e));
    if (i !== -1) pending.splice(i, 1)[0].resolve(e.data);
  };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          const chunk = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const event = chunk.match(/^event: (.*)$/m)?.[1];
          const data = chunk.match(/^data: (.*)$/m)?.[1];
          if (event && data) offer({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  const next = (event: string, where: (d: any) => boolean = () => true, ms = 3000): Promise<any> => {
    const already = seen.find((e) => e.event === event && where(e.data));
    if (already) return Promise.resolve(already.data);
    return new Promise((resolve, reject) => {
      const entry = { match: (e: { event: string; data: any }) => e.event === event && where(e.data), resolve };
      pending.push(entry);
      setTimeout(() => reject(new Error(`no ${event} event within ${ms}ms`)), ms);
    });
  };
  return { next, seen, close: () => controller.abort() };
}

const freshHand = async () => {
  const res = await fetch(new URL("/", baseUrl));
  const html = await res.text();
  const colour = html.match(/data-hand-colour="([^"]+)"/)![1];
  return { cookie: cookieFrom(res), colour };
};

const previewUpdate = (cookie: string, body: object) =>
  fetch(new URL("/api/strokes/live", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

const previewCancel = (cookie: string, gesture: string) =>
  fetch(new URL("/api/strokes/live/cancel", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ gesture }),
  });

const committedPaths = async () =>
  ((await (await fetch(new URL("/api/marks", baseUrl))).json()) as { path: string }[]).map(
    (m) => m.path,
  );

it("broadcasts a stroke point by point while it's drawn, in the hand's own colour, with nothing persisted", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const gesture = randomUUID();
  const x = 100 + (Date.now() % 500);

  // The colour a client claims is ignored: the server derives it from the hand.
  let res = await previewUpdate(hand.cookie, { gesture, from: 0, points: [[x, 1], [x, 2]], colour: "#000000" });
  expect(res.status).toBe(200);
  const first = await stream.next("preview", (d) => d.gesture === gesture);
  expect(first).toEqual({ gesture, colour: hand.colour, from: 0, points: [[x, 1], [x, 2]], held: false });

  res = await previewUpdate(hand.cookie, { gesture, from: 2, points: [[x, 3]] });
  expect(await res.json()).toEqual({ count: 3 });
  const second = await stream.next("preview", (d) => d.gesture === gesture && d.from === 2);
  expect(second.points).toEqual([[x, 3]]);

  // Nothing identifying goes out with it.
  const raw = JSON.stringify(stream.seen);
  expect(raw).not.toContain(hand.cookie.split("=")[1]);

  // Not a mark: absent from the committed wall, and the hand can still draw today.
  expect(await committedPaths()).not.toContain(`M${x},1 L${x},2 L${x},3`);
  expect(await committedPaths()).not.toContain(`M${x},1 L${x},2`);
  const page = await (await fetch(new URL("/", baseUrl), { headers: { Cookie: hand.cookie } })).text();
  expect(page).toContain('data-can-draw="true"');

  await previewCancel(hand.cookie, gesture);
  stream.close();
});

it("tells a new connection which strokes are being drawn right now", async () => {
  const hand = await freshHand();
  const gesture = randomUUID();
  await previewUpdate(hand.cookie, { gesture, from: 0, points: [[5, 5], [6, 6]] });
  const stream = await openStream();
  const snapshot = await stream.next("previews");
  expect(snapshot).toContainEqual({ gesture, colour: hand.colour, points: [[5, 5], [6, 6]], held: false });
  await previewCancel(hand.cookie, gesture);
  stream.close();
});

it("commits a previewed stroke under its gesture id, after persisting it, and never broadcasts the nonce", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const gesture = randomUUID();
  const nonce = randomUUID();
  const path = `M${Date.now() % 100_000},30 L31,32 L33,34`;
  await previewUpdate(hand.cookie, { gesture, from: 0, points: [[1, 30], [31, 32]] });
  await stream.next("preview", (d) => d.gesture === gesture);

  const post = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: hand.cookie },
    body: JSON.stringify({ path, nonce, gesture }),
  });
  expect(post.status).toBe(201);
  const mark = await stream.next("mark", (d) => d.gesture === gesture);
  expect(mark.path).toBe(path);
  expect(typeof mark.id).toBe("number");
  expect(JSON.stringify(stream.seen)).not.toContain(nonce);
  // Broadcast only once persisted: the committed wall already has it.
  expect(await committedPaths()).toContain(path);

  // The preview is over: a late update is refused, and a new viewer doesn't see it.
  expect((await previewUpdate(hand.cookie, { gesture, from: 2, points: [[40, 40]] })).status).toBe(403);
  const late = await openStream();
  expect((await late.next("previews")).some((p: { gesture: string }) => p.gesture === gesture)).toBe(false);
  late.close();
  stream.close();
});

it("refuses a preview from a visitor with no hand, or (for good, not 'retry later') a hand that has already marked today", async () => {
  const anonymous = await previewUpdate("", { gesture: randomUUID(), from: 0, points: [[1, 1]] });
  expect(anonymous.status).toBe(401);

  const hand = await freshHand();
  const mark = await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: hand.cookie },
    body: JSON.stringify({ path: "M7,7 L8,8" }),
  });
  expect(mark.status).toBe(201);
  const after = await previewUpdate(hand.cookie, { gesture: randomUUID(), from: 0, points: [[1, 1]] });
  expect(after.status).toBe(403);
});

it("won't let one hand update, cancel or claim another hand's preview", async () => {
  const stream = await openStream();
  const owner = await freshHand();
  const intruder = await freshHand();
  const gesture = randomUUID();
  await previewUpdate(owner.cookie, { gesture, from: 0, points: [[1, 1]] });

  expect((await previewUpdate(intruder.cookie, { gesture, from: 1, points: [[9, 9]] })).status).toBe(403);
  await previewCancel(intruder.cookie, gesture);
  // A mark that tries to borrow the id lands, but untagged: viewers won't
  // mistake it for the owner's stroke.
  const path = `M${Date.now() % 100_000},50 L51,52`;
  await fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: intruder.cookie },
    body: JSON.stringify({ path, gesture }),
  });
  const intruderMark = await stream.next("mark", (d) => d.path === path);
  expect(intruderMark.gesture).toBeUndefined();

  const check = await openStream();
  const snapshot = await check.next("previews");
  expect(snapshot.find((p: { gesture: string }) => p.gesture === gesture)?.points).toEqual([[1, 1]]);
  expect(stream.seen.some((e) => e.event === "preview-end" && e.data.gesture === gesture)).toBe(false);

  await previewCancel(owner.cookie, gesture);
  check.close();
  stream.close();
});

it("clears a cancelled preview for every viewer, and won't let it be resurrected", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const gesture = randomUUID();
  await previewUpdate(hand.cookie, { gesture, from: 0, points: [[1, 1]] });
  expect((await previewCancel(hand.cookie, gesture)).status).toBe(204);
  expect(await stream.next("preview-end", (d) => d.gesture === gesture)).toEqual({
    gesture,
    reason: "cancelled",
  });
  expect((await previewUpdate(hand.cookie, { gesture, from: 1, points: [[2, 2]] })).status).toBe(410);
  stream.close();
});

it("sweeps away an abandoned preview once its lease runs out, without it ever becoming a mark", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const gesture = randomUUID();
  const x = 200 + (Date.now() % 500);
  await previewUpdate(hand.cookie, { gesture, from: 0, points: [[x, 9], [x, 10]] });
  // No cancel, no more updates: a tab that closed without saying goodbye.
  const ended = await stream.next("preview-end", (d) => d.gesture === gesture, 9000);
  expect(ended.reason).toBe("expired");
  expect(await committedPaths()).not.toContain(`M${x},9 L${x},10`);
  stream.close();
}, 15_000);

it("a viewer disconnecting doesn't end anyone else's preview", async () => {
  const hand = await freshHand();
  const gesture = randomUUID();
  const viewer = await openStream();
  await previewUpdate(hand.cookie, { gesture, from: 0, points: [[1, 1]] });
  await viewer.next("preview", (d) => d.gesture === gesture);
  viewer.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const other = await openStream();
  expect((await other.next("previews")).some((p: { gesture: string }) => p.gesture === gesture)).toBe(true);
  await previewCancel(hand.cookie, gesture);
  other.close();
});

it("bounds preview payloads and rejects bad coordinates", async () => {
  const hand = await freshHand();
  const bad = [
    { gesture: "not-a-uuid", from: 0, points: [[1, 1]] },
    { gesture: randomUUID(), from: 0, points: [[1.5, 1]] },
    { gesture: randomUUID(), from: 0, points: [[1, 1e9]] },
    { gesture: randomUUID(), from: 0, points: Array.from({ length: 201 }, () => [1, 1]) },
  ];
  for (const body of bad) {
    expect((await previewUpdate(hand.cookie, body)).status).toBe(400);
  }
  // Over the 8 KB body cap: refused outright, never parsed.
  const huge = { gesture: randomUUID(), from: 0, points: [[1, 1]], pad: "x".repeat(20_000) };
  const res = await previewUpdate(hand.cookie, huge).catch(() => undefined);
  expect(res === undefined || res.status === 400).toBe(true);
});

// --- The sketchbook: prompts, private notes, My traces -----------------------

const postMark = (cookie: string, body: object) =>
  fetch(new URL("/api/marks", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

const todaysPrompt = async () => {
  const html = await (await fetch(new URL("/", baseUrl))).text();
  return new JSDOM(html).window.document.getElementById("today")!.textContent!;
};

const minePage = async (cookie: string) =>
  (await fetch(new URL("/mine/", baseUrl), { headers: { Cookie: cookie } })).text();

it("keeps a mark's note private to its hand: never on the wall, the API or the stream", async () => {
  const stream = await openStream();
  const owner = await freshHand();
  const other = await freshHand();
  const note = `the bus was late again ${randomUUID()}`;
  const path = `M${Date.now() % 100_000},60 L61,62`;
  const res = await postMark(owner.cookie, { path, prompt: await todaysPrompt(), note });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  await stream.next("mark", (d) => d.id === id);

  expect(await minePage(owner.cookie)).toContain(note);
  expect(await minePage(other.cookie)).not.toContain(note);
  for (const cookie of [owner.cookie, other.cookie]) {
    const wall = await (await fetch(new URL("/", baseUrl), { headers: { Cookie: cookie } })).text();
    expect(wall).not.toContain(note);
    const api = await (await fetch(new URL("/api/marks", baseUrl), { headers: { Cookie: cookie } })).text();
    expect(api).not.toContain(note);
  }
  expect(JSON.stringify(stream.seen)).not.toContain(note);
  stream.close();
});

it("records the prompt a mark answered, and only ever a real prompt", async () => {
  const prompt = await todaysPrompt();
  const a = await freshHand();
  const b = await freshHand();
  const answered = await (await postMark(a.cookie, { path: "M70,70 L71,71", prompt })).json();
  const freeText = await (await postMark(b.cookie, { path: "M72,72 L73,73", prompt: "anything I like" })).json();
  const marks = (await (await fetch(new URL("/api/marks", baseUrl))).json()) as { id: number; prompt: string | null }[];
  expect(marks.find((m) => m.id === answered.id)!.prompt).toBe(prompt);
  expect(marks.find((m) => m.id === freeText.id)!.prompt).toBeNull();
});

it("treats a retried submission as the same mark, not a second one", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const nonce = randomUUID();
  const path = `M${Date.now() % 100_000},80 L81,82`;
  const first = await postMark(hand.cookie, { path, nonce });
  const retry = await postMark(hand.cookie, { path, nonce });
  expect(first.status).toBe(201);
  expect(retry.status).toBe(201);
  const [a, b] = [await first.json(), await retry.json()];
  expect(b.id).toBe(a.id);
  expect(typeof a.nextAt).toBe("number");
  expect((await committedPaths()).filter((p) => p === path).length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stream.seen.filter((e) => e.event === "mark" && e.data.path === path).length).toBe(1);
  // A different nonce is a genuinely new attempt, and today is spent.
  expect((await postMark(hand.cookie, { path, nonce: randomUUID() })).status).toBe(429);
  stream.close();
});

it("rejected attempts don't spend the day", async () => {
  const hand = await freshHand();
  expect((await postMark(hand.cookie, { path: "not a path" })).status).toBe(400);
  expect((await postMark(hand.cookie, { path: "M1,1 L2,2", note: "x".repeat(501) })).status).toBe(400);
  expect((await postMark(hand.cookie, { path: "M1,1 L2,2" })).status).toBe(201);
});

it("lets only the hand that drew a mark edit its note or delete it", async () => {
  const owner = await freshHand();
  const other = await freshHand();
  const { id } = await (await postMark(owner.cookie, { path: `M${Date.now() % 100_000},90 L91,92` })).json();
  const form = (cookie: string, action: string, body: Record<string, string> = {}) =>
    fetch(new URL(`/mine/marks/${id}/${action}`, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  expect((await form(other.cookie, "note", { note: "hijacked" })).status).toBe(404);
  expect((await form(other.cookie, "delete")).status).toBe(404);

  const saved = await form(owner.cookie, "note", { note: "a later reflection" });
  expect(saved.status).toBe(303);
  expect(saved.headers.get("location")).toBe(`/mine/?saved=${id}#mark-${id}`);
  expect(await minePage(owner.cookie)).toContain("a later reflection");
  // A blank note deletes it.
  await form(owner.cookie, "note", { note: "" });
  expect(await minePage(owner.cookie)).not.toContain("a later reflection");
});

it("deleting a mark takes it off every wall, live, without handing back the day", async () => {
  const stream = await openStream();
  const hand = await freshHand();
  const path = `M${Date.now() % 100_000},95 L96,97`;
  const { id } = await (await postMark(hand.cookie, { path, note: "gone soon" })).json();
  const del = await fetch(new URL(`/mine/marks/${id}/delete`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: hand.cookie },
    body: new URLSearchParams(),
    redirect: "manual",
  });
  expect(del.status).toBe(303);
  expect(await stream.next("unmark", (d) => d.id === id)).toEqual({ id });
  expect(await committedPaths()).not.toContain(path);
  expect(await minePage(hand.cookie)).not.toContain("gone soon");
  expect((await postMark(hand.cookie, { path: "M1,1 L3,3" })).status).toBe(429);
  stream.close();
});

it("exports a hand's own marks and notes, and keeps each mark as a standalone image", async () => {
  const owner = await freshHand();
  const other = await freshHand();
  const note = `exported ${randomUUID()}`;
  const path = `M${Date.now() % 100_000},40 L41,42`;
  const { id } = await (await postMark(owner.cookie, { path, note })).json();

  const exp = await fetch(new URL("/mine/export.json", baseUrl), { headers: { Cookie: owner.cookie } });
  expect(exp.headers.get("content-disposition")).toContain("attachment");
  const data = await exp.json();
  expect(data.marks).toEqual([expect.objectContaining({ path, note, colour: owner.colour })]);
  expect(JSON.stringify(data)).not.toContain(owner.cookie.split("=")[1]);

  const otherExport = await (
    await fetch(new URL("/mine/export.json", baseUrl), { headers: { Cookie: other.cookie } })
  ).json();
  expect(otherExport.marks).toEqual([]);

  const svg = await fetch(new URL(`/mine/marks/${id}.svg`, baseUrl), { headers: { Cookie: owner.cookie } });
  expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
  const text = await svg.text();
  expect(text).toContain(`d="${path}"`);
  expect(text).not.toContain(note);
  const stranger = await fetch(new URL(`/mine/marks/${id}.svg`, baseUrl), { headers: { Cookie: other.cookie } });
  expect(stranger.status).toBe(404);
});

it("a note too long to accept is refused, not taken as a blank note that deletes the old one", async () => {
  const hand = await freshHand();
  const { id } = await (await postMark(hand.cookie, { path: "M5,5 L6,6", note: "keep me" })).json();
  const res = await fetch(new URL(`/mine/marks/${id}/note`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: hand.cookie },
    body: new URLSearchParams({ note: "字".repeat(500) }),
    redirect: "manual",
  });
  // 500 characters is legal however many bytes they urlencode to.
  expect(res.status).toBe(303);
  const tooLong = await fetch(new URL(`/mine/marks/${id}/note`, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: hand.cookie },
    body: new URLSearchParams({ note: "x".repeat(40_000) }),
    redirect: "manual",
  }).catch(() => undefined);
  expect(tooLong === undefined || tooLong.status === 413 || tooLong.status === 404).toBe(true);
  expect(await minePage(hand.cookie)).toContain("字".repeat(500));
});
