import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Mark } from "../src/db.ts";
import { wallPage } from "../src/pages.ts";

// Every other test in spec/ drives the server over HTTP; none of them execute
// public/wall.js itself, so a client-only bug (like the stuck pointerdown
// listener fixed in 2e59190, where a hand could keep drawing after its mark
// had already landed) has no automated check at all --- only a manual
// agent-browser sequence caught it. This loads the real file into jsdom and
// drives it with synthetic pointer events instead, with fetch/EventSource
// stubbed since there's no server here.
const wallSource = readFileSync("public/wall.js", "utf8");

type Body = Record<string, unknown>;
const TODAY = "a shadow you noticed";
type Point = [number, number];

function buildWall({
  canDraw,
  deferFetch = false,
  markStatus = 201,
  networkFail = false,
  previewLease = 5000,
  previewStatus = 200,
  previewDelay = 0,
  serverMarks = [],
  liveMode = true,
  autoPublish = true,
  marks = [],
  lastSeen,
}: {
  canDraw: boolean;
  deferFetch?: boolean;
  markStatus?: number;
  networkFail?: boolean;
  previewLease?: number;
  previewStatus?: number;
  previewDelay?: number;
  serverMarks?: { id: number; path: string; colour: string; mine: boolean; prompt?: string | null }[];
  // Most tests are about streaming, so they start with Draw live on and
  // treat lifting the pointer as also pressing Add to the wall.
  liveMode?: boolean;
  autoPublish?: boolean;
  marks?: Mark[];
  lastSeen?: number;
}) {
  // The real page markup, so the controls wall.js looks for are exactly the
  // ones the server renders.
  const html = wallPage(
    marks,
    { id: "this-hand", colour: "#123456" },
    canDraw ? 0 : 3_600_000 * 5,
    previewLease,
    TODAY,
  ).replace(/<script[\s\S]*?<\/script>/, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  if (lastSeen !== undefined) dom.window.localStorage.setItem("trace:last-seen", String(lastSeen));
  const { window } = dom;
  const svg = window.document.getElementById("wall") as unknown as SVGSVGElement;
  const status = window.document.getElementById("status")!;
  const connection = window.document.getElementById("connection")!;

  // jsdom has no layout engine (getBoundingClientRect is always zero) and no
  // pointer-capture implementation; stub both so wall.js's own coordinate
  // math and capture call don't blow up on a geometry jsdom never computes.
  (svg as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
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
      if (previewDelay) await new Promise((resolve) => setTimeout(resolve, previewDelay));
      if (previewStatus !== 200) return Response.json({ error: "refused" }, { status: previewStatus });
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
    if (markStatus === 201) return Response.json({ id: 900 + posted.length, nextAt: Date.now() + 86_400_000 }, { status: 201 });
    return new Response("Your mark is already on the wall.", { status: markStatus });
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
  script.dataset.prompt = TODAY;
  script.textContent = wallSource;
  window.document.body.appendChild(script);
  const $ = (id: string) => window.document.getElementById(id) as HTMLElement & HTMLInputElement;
  if (liveMode && canDraw) $("mode").click();
  const publish = () => $("draft").dispatchEvent(new window.Event("submit", { cancelable: true }));

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
    if (autoPublish) publish();
  };
  const key = (k: string) => svg.dispatchEvent(new window.KeyboardEvent("keydown", { key: k }));
  // Enter, one arrow step, Enter: the keyboard-only path through the exact
  // same beginGesture/addPoint/finish a pointer gesture drives.
  const keyboardStroke = () => {
    key("Enter");
    key("ArrowRight");
    key("Enter");
    if (autoPublish) publish();
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
    $,
    publish,
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

it("during the cooldown, drawing is private practice: nothing is posted or streamed", async () => {
  const { $, svg, posted, previews, stroke, keyboardStroke, settle, flushPreviews } = buildWall({
    canDraw: false,
  });
  stroke(1, 9);
  keyboardStroke();
  await flushPreviews();
  await settle();
  expect(posted.length).toBe(0);
  expect(previews.length).toBe(0);
  // The practice stroke is on this screen only, and can't be added.
  expect(svg.querySelectorAll("path.mine.draft").length).toBe(1);
  expect($("publish").disabled).toBe(true);
  expect($("mode").disabled).toBe(true);
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
  // The second is a practice draft beside the landed mark, not a post.
  expect(svg.querySelectorAll("path:not(.halo)").length).toBe(2);
  expect(svg.querySelectorAll("path.draft").length).toBe(1);
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
  const { gesture, posted, previews, flushPreviews, settle, publish } = buildWall({ canDraw: true });
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
  expect(posted.length).toBe(0); // a draft until the hand adds it
  publish();
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
  expect(previews.flatMap((p) => p.points as Point[])).toEqual([[500, 300], [530, 300]]);
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

it("cancels the preview but keeps the drawing when the mark can't be submitted at all", async () => {
  const { $, stroke, cancels, posted, settle, status, svg, publish } = buildWall({
    canDraw: true,
    networkFail: true,
  });
  stroke(1, 9);
  await settle();
  await settle();
  expect(posted.length).toBe(1);
  expect(cancels.map((c) => c.gesture)).toEqual([posted[0].gesture]);
  expect(status.textContent).toContain("Couldn't reach the wall");
  expect(svg.querySelectorAll("path.mine.draft").length).toBe(1);
  expect($("draft").hidden).toBe(false);

  // Adding it again is the same submission: same nonce, same gesture.
  publish();
  await settle();
  await settle();
  expect(posted.length).toBe(2);
  expect(posted[1].nonce).toBe(posted[0].nonce);
  expect(posted[1].gesture).toBe(posted[0].gesture);
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

// --- Drafts, private practice and publishing ---------------------------------

it("never streams a stroke unless Draw live was deliberately turned on", async () => {
  const { gesture, previews, cancels, flushPreviews, $ } = buildWall({ canDraw: true, liveMode: false });
  expect($("mode").getAttribute("aria-pressed")).toBe("false");
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  gesture(30, 30, "pointerup");
  await flushPreviews();
  expect(previews.length).toBe(0);
  expect(cancels.length).toBe(0);

  // Turning it on doesn't reach back and share the draft already drawn.
  $("mode").click();
  expect($("mode").getAttribute("aria-pressed")).toBe("true");
  await flushPreviews();
  expect(previews.length).toBe(0);
});

it("turning Draw live off mid-stroke takes the stroke off everyone else's screen", async () => {
  const { gesture, previews, cancels, flushPreviews, $ } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  expect(previews.length).toBeGreaterThan(0);
  $("mode").click();
  expect(cancels.map((c) => c.gesture)).toEqual([previews[0].gesture]);
  gesture(30, 30, "pointermove");
  await flushPreviews();
  expect(previews.flatMap((p) => p.points as Point[])).not.toContainEqual([30, 30]);
});

it("holds a finished live stroke as a dashed preview while its hand decides", async () => {
  const { gesture, previews, flushPreviews, $ } = buildWall({ canDraw: true, autoPublish: false });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  gesture(30, 30, "pointerup");
  await flushPreviews();
  expect(previews.at(-1)!.held).toBe(true);
  expect($("draft").hidden).toBe(false);
});

it("Try again discards the draft and its preview, posting nothing", async () => {
  const { gesture, posted, cancels, previews, flushPreviews, settle, svg, $ } = buildWall({
    canDraw: true,
    autoPublish: false,
  });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  gesture(30, 30, "pointerup");
  await flushPreviews();
  $("retry").click();
  await settle();
  expect(posted.length).toBe(0);
  expect(cancels.map((c) => c.gesture)).toEqual([previews[0].gesture]);
  expect(svg.querySelectorAll("path").length).toBe(0);
  expect($("draft").hidden).toBe(true);
});

it("Escape discards a keyboard draft before it's added", async () => {
  const { key, posted, svg, settle } = buildWall({ canDraw: true, autoPublish: false });
  key("Enter");
  key("ArrowDown");
  key("Enter"); // now a draft
  key("Escape");
  await settle();
  expect(posted.length).toBe(0);
  expect(svg.querySelectorAll("path").length).toBe(0);
});

it("starting a new stroke replaces the waiting draft rather than stacking", async () => {
  const { stroke, posted, svg, settle } = buildWall({ canDraw: true, autoPublish: false });
  stroke(10, 20);
  stroke(30, 40);
  await settle();
  expect(posted.length).toBe(0);
  expect(svg.querySelectorAll("path.mine").length).toBe(1);
  expect(svg.querySelector("path.mine")!.getAttribute("d")).toBe("M30,30 L40,40");
});

it("sends the prompt it answered and a private note only when the hand gives them", async () => {
  const { stroke, posted, settle, $, publish } = buildWall({ canDraw: true, autoPublish: false });
  stroke(10, 20);
  ($("note") as unknown as HTMLTextAreaElement).value = "  the queue at the bus stop  ";
  publish();
  await settle();
  expect(posted[0].prompt).toBe(TODAY);
  expect(posted[0].note).toBe("the queue at the bus stop");

  const skip = buildWall({ canDraw: true, autoPublish: false });
  skip.stroke(10, 20);
  skip.$("answers").checked = false;
  skip.publish();
  await skip.settle();
  expect(skip.posted[0].prompt).toBeUndefined();
  expect(skip.posted[0].note).toBeUndefined();
});

it("keeps the drawing as practice when the server refuses the mark", async () => {
  const { stroke, settle, status, svg, $ } = buildWall({ canDraw: true, markStatus: 429 });
  stroke(1, 9);
  await settle();
  await settle();
  expect(status.textContent).toContain("already on the wall");
  expect(svg.querySelectorAll("path.mine.draft").length).toBe(1);
  expect($("publish").disabled).toBe(true);
  expect($("mode").disabled).toBe(true);
});

it("turns Draw live back off once a mark lands, and names it by its committed id", async () => {
  const { stroke, settle, svg, $ } = buildWall({ canDraw: true });
  stroke(1, 9);
  await settle();
  await settle();
  const mine = svg.querySelector("path.mine")!;
  expect(mine.classList.contains("draft")).toBe(false);
  expect(mine.getAttribute("data-id")).toBe("901");
  expect(mine.getAttribute("data-prompt")).toBe(TODAY);
  expect($("mode").getAttribute("aria-pressed")).toBe("false");
  expect($("mode").disabled).toBe(true);
  expect($("draft").hidden).toBe(true);
});

const markRow = (id: number, prompt: string | null, hand = "someone-else"): Mark => ({
  id,
  hand_id: hand,
  path: `M${id},1 L${id},2`,
  colour: "#cc4a28",
  created_at: id,
  prompt,
});

it("points out marks that are new since this browser last looked", () => {
  const { svg, $ } = buildWall({
    canDraw: true,
    marks: [markRow(1, null), markRow(2, null), markRow(3, null), markRow(4, null, "this-hand")],
    lastSeen: 2,
  });
  const freshIds = [...svg.querySelectorAll("path.fresh")].map((p) => p.getAttribute("data-id"));
  // Mark 4 is this hand's own, so it's not news to them.
  expect(freshIds).toEqual(["3"]);
  expect($("fresh").hidden).toBe(false);
  expect($("fresh").textContent).toContain("One mark is new");
});

it("dims everything that didn't answer today's prompt, live arrivals included", () => {
  const { svg, $, window, emitMark } = buildWall({
    canDraw: true,
    marks: [markRow(1, TODAY), markRow(2, "a sound you heard this morning"), markRow(3, null)],
  });
  $("only-prompt").checked = true;
  $("only-prompt").dispatchEvent(new window.Event("change"));
  const dimmed = () => [...svg.querySelectorAll("path.off-prompt")].map((p) => p.getAttribute("data-id"));
  expect(dimmed()).toEqual(["2", "3"]);
  emitMark({ id: 10, path: "M1,1 L9,9", colour: "#5177aa", prompt: TODAY } as never);
  emitMark({ id: 11, path: "M2,2 L8,8", colour: "#5177aa", prompt: null } as never);
  expect(dimmed()).toEqual(["2", "3", "11"]);
});

it("takes a deleted mark off the wall live", () => {
  const { svg, emit } = buildWall({ canDraw: true, marks: [markRow(1, null), markRow(2, null)] });
  emit("unmark", { id: 1 });
  expect([...svg.querySelectorAll("path[data-id]")].map((p) => p.getAttribute("data-id"))).toEqual(["2"]);
});

it("says so when the server refuses its live preview, instead of claiming to be live", async () => {
  const { gesture, previews, flushPreviews, $ } = buildWall({ canDraw: true, previewStatus: 401 });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  gesture(30, 30, "pointermove");
  await flushPreviews();
  expect(previews.length).toBe(1); // stopped after the refusal
  expect($("mode-note").textContent).toContain("only on your screen");
});

it("on a slow connection, coalesces a burst of movement into a few ordered updates, losing nothing", async () => {
  const { gesture, previews, $ } = buildWall({ canDraw: true, previewDelay: 200 });
  gesture(0, 0, "pointerdown");
  for (let i = 1; i <= 60; i++) {
    gesture(i, i, "pointermove");
    if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  // One request in flight at a time: about one per round trip, not one per move.
  expect(previews.length).toBeLessThanOrEqual(5);
  const sent = previews.flatMap((p) => p.points as Point[]);
  expect(sent).toEqual(Array.from({ length: 61 }, (_, i) => [i, i]));
  expect(previews.every((p, i) => i === 0 || (p.from as number) >= (previews[i - 1].from as number))).toBe(true);
  expect($("mode-note").textContent).not.toContain("only on your screen");
});

// --- Regressions from the independent review ---------------------------------

it("draws a mark that claims a gesture id this tab once used but didn't submit", async () => {
  const { gesture, previews, flushPreviews, emitMark, strokes, $ } = buildWall({ canDraw: true });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  const used = previews[0].gesture as string;
  gesture(30, 30, "pointerup"); // a draft, never added
  $("retry").click();
  emitMark({ id: 77, path: "M5,5 L9,9", colour: "#abcdef", gesture: used });
  expect(strokes().map((p) => p.getAttribute("data-id"))).toEqual(["77"]);
});

it("removes a duplicate when its own echo arrived untagged before the response", async () => {
  const { stroke, emitMark, releaseFetch, settle, strokes, posted } = buildWall({
    canDraw: true,
    deferFetch: true,
  });
  stroke(1, 9);
  await settle();
  // The server forgot the gesture id, so the echo carries none: drawn as foreign.
  emitMark({ id: 901, path: posted[0].path as string, colour: "#123456" });
  expect(strokes().length).toBe(2);
  releaseFetch();
  await settle();
  await settle();
  expect(strokes().length).toBe(1);
  expect(strokes()[0].classList.contains("mine")).toBe(true);
});

it("a reconnect refresh keeps marks that arrived after the server built its list", async () => {
  const { emit, emitMark, svg, settle } = buildWall({
    canDraw: true,
    serverMarks: [{ id: 1, path: "M1,1 L2,2", colour: "#cc4a28", mine: false }],
  });
  emit("open");
  emit("error");
  emit("open"); // refresh requested
  emitMark({ id: 2, path: "M3,3 L4,4", colour: "#cc4a28" }); // lands before the response
  await settle();
  await settle();
  expect([...svg.querySelectorAll("path[data-id]")].map((p) => p.getAttribute("data-id")).sort()).toEqual([
    "1",
    "2",
  ]);
});

it("ignores a second pointer going down mid-stroke", () => {
  const { svg, window } = buildWall({ canDraw: true });
  const down = (id: number, x: number) =>
    svg.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: x, clientY: x, pointerId: id, bubbles: true }));
  down(1, 10);
  svg.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 20, clientY: 20, pointerId: 1, bubbles: true }));
  down(2, 50);
  expect(svg.querySelectorAll("path.mine").length).toBe(1);
  expect(svg.querySelector("path.mine")!.getAttribute("d")).toBe("M10,10 L20,20");
});

it("stops sending, and says the draft is private again, once the server refuses its live preview for good", async () => {
  const { gesture, previews, flushPreviews, $ } = buildWall({ canDraw: true, previewStatus: 403, autoPublish: false });
  gesture(10, 10, "pointerdown");
  gesture(20, 20, "pointermove");
  await flushPreviews();
  gesture(30, 30, "pointerup");
  await flushPreviews();
  await flushPreviews();
  expect(previews.length).toBe(1);
  expect($("draft-audience").textContent).toBe("Only you can see it.");
});
