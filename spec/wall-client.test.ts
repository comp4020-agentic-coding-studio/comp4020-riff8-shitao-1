import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Every other test in spec/ drives the server over HTTP; none of them execute
// public/wall.js itself, so a client-only bug (like the stuck pointerdown
// listener fixed in 2e59190, where a hand could keep drawing after its mark
// had already landed) has no automated check at all --- only a manual
// agent-browser sequence caught it. This loads the real file into jsdom and
// drives it with synthetic pointer events instead, with fetch/EventSource
// stubbed since there's no server here.
const wallSource = readFileSync("public/wall.js", "utf8");

type Body = Record<string, unknown>;
type Point = [number, number];

function buildWall({
  canDraw,
  deferFetch = false,
  markStatus = 201,
  networkFail = false,
  previewLease = 5000,
  serverMarks = [],
}: {
  canDraw: boolean;
  deferFetch?: boolean;
  markStatus?: number;
  networkFail?: boolean;
  previewLease?: number;
  serverMarks?: { id: number; path: string; colour: string; mine: boolean }[];
}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <svg id="wall" viewBox="0 0 100 100"></svg>
      <p id="status"></p>
      <p id="connection"></p>
    </body>`,
    { runScripts: "dangerously", url: "http://localhost/" },
  );
  const { window } = dom;
  const svg = window.document.getElementById("wall") as unknown as SVGSVGElement;
  const status = window.document.getElementById("status")!;
  const connection = window.document.getElementById("connection")!;

  // jsdom has no layout engine (getBoundingClientRect is always zero) and no
  // pointer-capture implementation; stub both so wall.js's own coordinate
  // math and capture call don't blow up on a geometry jsdom never computes.
  (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  (svg as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};

  // Every request wall.js makes, by route. deferFetch holds a mark's POST
  // open so a test can fire its SSE echo first --- the ordering server.ts
  // produces, since it broadcasts before it replies.
  const posted: Body[] = [];
  const previews: Body[] = [];
  const cancels: Body[] = [];
  let refreshes = 0;
  let resolveFetch: (() => void) | undefined;
  (window as unknown as { fetch: typeof fetch }).fetch = (async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url === "/api/strokes/live") {
      previews.push(body);
      return Response.json({ count: body.from + body.points.length });
    }
    if (url === "/api/strokes/live/cancel") {
      cancels.push(body);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/marks" && !init?.method) {
      refreshes++;
      return Response.json(serverMarks);
    }
    posted.push(body);
    if (networkFail) throw new TypeError("network down");
    if (deferFetch) {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
    }
    return new Response(markStatus === 201 ? null : "Your mark is already on the wall.", {
      status: markStatus,
    });
  }) as typeof fetch;

  // wall.js opens one unconditionally on load; there's no server to answer
  // it, so tests dispatch SSE events through this stub directly.
  const listeners = new Map<string, ((evt: { data?: string }) => void)[]>();
  (window as unknown as { EventSource: unknown }).EventSource = class {
    readyState = 1;
    addEventListener(type: string, listener: (evt: { data?: string }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }
  };
  const emit = (type: string, data?: unknown) => {
    for (const l of listeners.get(type) ?? []) {
      l(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  };

  const script = window.document.createElement("script");
  script.dataset.handColour = "#123456";
  script.dataset.canDraw = String(canDraw);
  script.dataset.previewLease = String(previewLease);
  script.textContent = wallSource;
  window.document.body.appendChild(script);

  const gesture = (x: number, y: number, type: string, pointerType = "mouse") =>
    svg.dispatchEvent(
      new window.PointerEvent(type, {
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType,
        bubbles: true,
      }),
    );
  const stroke = (from: number, to: number, pointerType = "mouse") => {
    gesture(from, from, "pointerdown", pointerType);
    gesture(to, to, "pointermove", pointerType);
    gesture(to + 1, to + 1, "pointerup", pointerType);
  };
  const key = (k: string) => svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: k }));
  // Enter, one arrow step, Enter: the keyboard-only path through the exact
  // same beginGesture/addPoint/finish a pointer gesture drives.
  const keyboardStroke = () => {
    key("Enter");
    key("ArrowRight");
    key("Enter");
  };
  // Flush the microtask queue fetch's promise chain runs on.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Long enough for wall.js's coalescing interval to send what's queued.
  const flushPreviews = () => new Promise((resolve) => setTimeout(resolve, 120));
  const emitMark = (mark: { id?: number; path: string; colour: string; gesture?: string }) =>
    emit("mark", { id: 1000 + posted.length, ...mark });
  const emitPreview = (p: { gesture: string; colour?: string; from: number; points: Point[]; held?: boolean }) =>
    emit("preview", { colour: "#abcdef", held: false, ...p });
  const releaseFetch = () => resolveFetch?.();
  const strokes = () => [...svg.querySelectorAll("path:not(.halo)")];
  const previewPaths = () => [...svg.querySelectorAll("path.preview")];

  return {
    window,
    svg,
    status,
    connection,
    posted,
    previews,
    cancels,
    refreshes: () => refreshes,
    gesture,
    stroke,
    key,
    keyboardStroke,
    settle,
    flushPreviews,
    emit,
    emitMark,
    emitPreview,
    releaseFetch,
    strokes,
    previewPaths,
  };
}

it("posts one mark for one pointer gesture when a hand can draw", async () => {
  const { svg, posted, stroke, settle } = buildWall({ canDraw: true });
  stroke(1, 9);
  await settle();
  expect(posted.length).toBe(1);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1);
});

it("tells a hand which stroke is theirs the moment its first mark lands", async () => {
  // The page footer only names "the thicker stroke" once a reload finds this
  // hand's marks on the server; without this, a first-time hand's only cue
  // is a line that vanishes into a busy wall.
  const { status, stroke, settle } = buildWall({ canDraw: true });
  stroke(1, 9);
  await settle();
  expect(status.textContent).toContain("the thicker stroke");
});

it("never attaches drawing listeners at all when canDraw starts false", async () => {
  const { svg, posted, stroke, keyboardStroke, settle } = buildWall({ canDraw: false });
  stroke(1, 9);
  keyboardStroke();
  await settle();
  expect(posted.length).toBe(0);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(0);
});

it("posts one mark for a keyboard-only gesture: Enter, an arrow step, Enter", async () => {
  // A pointer is otherwise the only way to draw at all --- a keyboard-only
  // visitor couldn't use the app's one interaction without this path, which
  // mirrors pointerdown/pointermove/pointerup through the same
  // beginGesture/addPoint/finish functions.
  const { svg, posted, keyboardStroke, settle } = buildWall({ canDraw: true });
  keyboardStroke();
  await settle();
  expect(posted.length).toBe(1);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1);
});

it("Escape cancels a keyboard gesture in progress without posting anything", async () => {
  const { svg, posted, key, settle } = buildWall({ canDraw: true });
  key("Enter");
  key("ArrowUp");
  key("Escape");
  await settle();
  expect(posted.length).toBe(0);
  expect(svg.querySelectorAll("path").length).toBe(0); // halo included
});

it("refuses a second gesture in the same tab once the first mark has landed", async () => {
  // Regression check for 2e59190: before that fix, the pointerdown listener
  // never rechecked canDraw after attaching, so a second gesture in the same
  // tab still appended a path and posted, only to be rejected (and removed)
  // at submit time by the server --- a contradiction the UI had no way to
  // avoid showing a visitor who kept gesturing after their mark landed.
  const { svg, posted, stroke, settle } = buildWall({ canDraw: true });
  stroke(1, 9);
  await settle();
  expect(posted.length).toBe(1);

  stroke(20, 40);
  await settle();
  expect(posted.length).toBe(1);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1);
});

it("draws another hand's mark even when its path is byte-identical to this tab's own", async () => {
  // Regression check: the echo filter used to compare by path string, not by
  // a per-mark token, so two different hands drawing the same short stroke
  // (a real possibility --- paths are rounded integer coordinates) would
  // have one hand's live view silently drop the other's genuine mark.
  const { svg, posted, stroke, settle, emitMark } = buildWall({ canDraw: true });
  stroke(1, 9);
  await settle();
  expect(posted.length).toBe(1);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1); // this tab's own `live` stroke

  emitMark({ path: posted[0].path as string, colour: "#abcdef", gesture: randomUUID() });
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(2);
  // Another hand's mark goes under this tab's own stroke and its halo, not on top.
  expect(svg.firstElementChild?.getAttribute("stroke")).toBe("#abcdef");
  expect(svg.lastElementChild?.classList.contains("mine")).toBe(true);
});

it("refuses a second gesture while the first one's post is still in flight", async () => {
  // Regression check: pointerdown only ever checked canDraw, which stays
  // true until the first post *succeeds* --- so a hand could start a second
  // gesture while the first was still in flight. Both posted; the server's
  // one-mark-a-day check correctly rejected the loser, and the winner's own
  // echo could be mistaken for someone else's and drawn a second time.
  const { svg, posted, stroke, settle, emitMark, releaseFetch } = buildWall({
    canDraw: true,
    deferFetch: true,
  });
  stroke(1, 9); // gesture 1, fetch pending
  await settle();
  expect(posted.length).toBe(1);

  stroke(20, 40); // gesture 2, started before gesture 1's fetch resolved
  await settle();
  expect(posted.length).toBe(1); // refused outright, never posted
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1); // just gesture 1's own `live` stroke

  emitMark({ path: posted[0].path as string, colour: "#123456", gesture: posted[0].gesture as string });
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1); // still recognised as its own echo

  releaseFetch();
  await settle();
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1);
});

it("doesn't duplicate its own mark when the SSE echo arrives before the post resolves", async () => {
  // Regression check: server.ts broadcasts before it replies to the POST, so
  // a tab's own echo can genuinely arrive before its fetch promise settles.
  // The gesture id is chosen before anything is sent, so this ordering must
  // not produce a second path for the same gesture.
  const { svg, posted, stroke, settle, emitMark, releaseFetch } = buildWall({
    canDraw: true,
    deferFetch: true,
  });
  stroke(1, 9);
  await settle();
  expect(posted.length).toBe(1);
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1); // the `live` stroke, fetch still pending

  emitMark({ path: posted[0].path as string, colour: "#123456", gesture: posted[0].gesture as string });
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1); // recognised as its own echo, not drawn again

  releaseFetch();
  await settle();
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(1);
});

// --- Live previews -----------------------------------------------------------

it("streams a pointer gesture as a preview while it's drawn, then commits under the same id", async () => {
  const { gesture, posted, previews, flushPreviews, settle } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  gesture(30, 30, "pointermove");
  gesture(40, 40, "pointermove");
  await flushPreviews();
  expect(posted.length).toBe(0); // nothing committed yet
  expect(previews.length).toBeGreaterThanOrEqual(2);
  const id = previews[0].gesture;
  expect(previews.every((p) => p.gesture === id)).toBe(true);
  // Coalesced and in order: each update starts where the last one ended.
  const sent = previews.flatMap((p) => p.points as Point[]);
  expect(sent).toEqual([[10, 10], [20, 20], [30, 30], [40, 40]]);
  expect(previews.every((p) => !("nonce" in p) && !("colour" in p))).toBe(true);

  gesture(41, 41, "pointerup");
  await settle();
  expect(posted.length).toBe(1);
  expect(posted[0].gesture).toBe(id);
});

it("ignores its own preview echoing back, rather than drawing it twice", async () => {
  const { gesture, previews, flushPreviews, emitPreview, strokes } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  emitPreview({ gesture: previews[0].gesture as string, colour: "#123456", from: 0, points: [[10, 10], [20, 20]] });
  expect(strokes().length).toBe(1);
});

it("shows another hand's stroke growing before it's submitted, then commits it in place", () => {
  const { emitPreview, emitMark, previewPaths, strokes } = buildWall({ canDraw: true });
  const id = randomUUID();
  emitPreview({ gesture: id, from: 0, points: [[1, 1], [2, 2]] });
  const el = previewPaths()[0];
  expect(el.getAttribute("d")).toBe("M1,1 L2,2");
  expect(el.getAttribute("stroke")).toBe("#abcdef");
  emitPreview({ gesture: id, from: 2, points: [[3, 3]] });
  expect(el.getAttribute("d")).toBe("M1,1 L2,2 L3,3");

  // The finished path has a point the throttled preview never sent; the
  // same element takes it, so there's no second line and no jump.
  emitMark({ id: 7, path: "M1,1 L2,2 L3,3 L4,4", colour: "#abcdef", gesture: id });
  expect(strokes()).toEqual([el]);
  expect(el.classList.contains("preview")).toBe(false);
  expect(el.getAttribute("d")).toBe("M1,1 L2,2 L3,3 L4,4");
  expect(el.getAttribute("data-id")).toBe("7");
});

it("keeps two hands drawing at once as two separate previews", () => {
  const { emitPreview, previewPaths } = buildWall({ canDraw: true });
  const [a, b] = [randomUUID(), randomUUID()];
  emitPreview({ gesture: a, colour: "#cc4a28", from: 0, points: [[1, 1]] });
  emitPreview({ gesture: b, colour: "#5177aa", from: 0, points: [[50, 50]] });
  emitPreview({ gesture: a, colour: "#cc4a28", from: 1, points: [[2, 2]] });
  emitPreview({ gesture: b, colour: "#5177aa", from: 1, points: [[60, 60]] });
  const [pa, pb] = previewPaths();
  expect(pa.getAttribute("d")).toBe("M1,1 L2,2");
  expect(pa.getAttribute("stroke")).toBe("#cc4a28");
  expect(pb.getAttribute("d")).toBe("M50,50 L60,60");
  expect(pb.getAttribute("stroke")).toBe("#5177aa");
});

it("never lets a remote preview overwrite or cover this hand's own stroke in progress", () => {
  const { svg, gesture, emitPreview } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  const mine = svg.querySelector("path.mine")!;
  emitPreview({ gesture: randomUUID(), from: 0, points: [[1, 1], [90, 90]] });
  expect(mine.getAttribute("d")).toBe("M10,10 L20,20");
  expect(svg.lastElementChild).toBe(mine);
});

it("clears a cancelled preview and refuses to bring it back from a late update", () => {
  const { emit, emitPreview, previewPaths, svg } = buildWall({ canDraw: true });
  const id = randomUUID();
  emitPreview({ gesture: id, from: 0, points: [[1, 1], [2, 2]] });
  emit("preview-end", { gesture: id, reason: "cancelled" });
  expect(svg.querySelectorAll("path").length).toBe(0);
  emitPreview({ gesture: id, from: 2, points: [[3, 3]] });
  expect(previewPaths().length).toBe(0);
});

it("refuses a preview update that arrives after its mark", () => {
  const { emitPreview, emitMark, strokes } = buildWall({ canDraw: true });
  const id = randomUUID();
  emitPreview({ gesture: id, from: 0, points: [[1, 1], [2, 2]] });
  emitMark({ id: 3, path: "M1,1 L2,2", colour: "#abcdef", gesture: id });
  emitPreview({ gesture: id, from: 2, points: [[3, 3]] });
  expect(strokes().length).toBe(1);
  expect(strokes()[0].getAttribute("d")).toBe("M1,1 L2,2");
});

it("draws a duplicated mark delivery once", () => {
  const { emitMark, strokes } = buildWall({ canDraw: true });
  const mark = { id: 42, path: "M1,1 L5,5", colour: "#abcdef", gesture: randomUUID() };
  emitMark(mark);
  emitMark(mark);
  expect(strokes().length).toBe(1);
});

it("drops a remote preview on its own once the lease runs out with no word from the server", async () => {
  const { emitPreview, previewPaths } = buildWall({ canDraw: true, previewLease: 20 });
  emitPreview({ gesture: randomUUID(), from: 0, points: [[1, 1], [2, 2]] });
  expect(previewPaths().length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(previewPaths().length).toBe(0);
});

it("cancels the preview, posting nothing, when the system cancels the pointer", async () => {
  const { svg, gesture, posted, previews, cancels, flushPreviews, settle } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown", "touch");
  gesture(20, 20, "pointermove", "touch");
  await flushPreviews();
  gesture(20, 20, "pointercancel", "touch");
  await settle();
  expect(posted.length).toBe(0);
  expect(cancels.map((c) => c.gesture)).toEqual([previews[0].gesture]);
  expect(svg.querySelectorAll("path").length).toBe(0);
});

it("cancels the preview when a gesture ends with under two points", async () => {
  const { gesture, posted, cancels, flushPreviews, settle } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown", "pen");
  await flushPreviews();
  gesture(10, 10, "pointerup", "pen");
  await settle();
  expect(posted.length).toBe(0);
  expect(cancels.length).toBe(1);
});

it("streams a keyboard gesture too, and Escape cancels its preview", async () => {
  const { key, previews, cancels, posted, flushPreviews, settle, svg } = buildWall({ canDraw: true });
  key("Enter");
  key("ArrowRight");
  await flushPreviews();
  expect(previews.flatMap((p) => p.points as Point[])).toEqual([[50, 50], [80, 50]]);
  key("Escape");
  await settle();
  expect(cancels.map((c) => c.gesture)).toEqual([previews[0].gesture]);
  expect(posted.length).toBe(0);
  expect(svg.querySelectorAll("path").length).toBe(0);
});

it("heartbeats a paused gesture so its preview outlives the lease", async () => {
  const { key, previews, flushPreviews } = buildWall({ canDraw: true, previewLease: 600 });
  key("Enter");
  await flushPreviews();
  const before = previews.length;
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(previews.length).toBeGreaterThan(before);
  expect(previews.at(-1)!.points).toEqual([]);
});

it("cancels the preview when the mark can't be submitted at all", async () => {
  const { stroke, cancels, posted, settle, status, svg } = buildWall({
    canDraw: true,
    networkFail: true,
  });
  stroke(1, 9);
  await settle();
  await settle();
  expect(posted.length).toBe(1);
  expect(cancels.map((c) => c.gesture)).toEqual([posted[0].gesture]);
  expect(status.textContent).toContain("Couldn't reach the wall");
  expect(svg.querySelectorAll("path").length).toBe(0);
});

it("on reconnect, catches up on committed marks and resyncs previews without touching local work", async () => {
  const { svg, gesture, emit, emitPreview, previewPaths, refreshes, settle } = buildWall({
    canDraw: true,
    serverMarks: [
      { id: 1, path: "M1,1 L2,2", colour: "#cc4a28", mine: false },
      { id: 2, path: "M3,3 L4,4", colour: "#123456", mine: true },
    ],
  });
  emit("open");
  const stale = randomUUID();
  emitPreview({ gesture: stale, from: 0, points: [[5, 5], [6, 6]] });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");

  // The connection drops and comes back.
  emit("error");
  emit("open");
  const fresh = randomUUID();
  emit("previews", [{ gesture: fresh, colour: "#5177aa", points: [[7, 7], [8, 8]], held: false }]);
  await settle();
  await settle();

  expect(refreshes()).toBe(1);
  expect(svg.querySelectorAll('path[data-id="1"]').length).toBe(1);
  expect(svg.querySelectorAll('path[data-id="2"].mine').length).toBe(1);
  // The stale preview's gesture ended while this tab was away; the fresh one is shown.
  expect(previewPaths().map((p) => p.getAttribute("d"))).toEqual(["M7,7 L8,8"]);
  // This hand's gesture in progress survives the whole thing, on top.
  expect(svg.lastElementChild!.getAttribute("d")).toBe("M10,10 L20,20");
});
