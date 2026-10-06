import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLive, LIMITS } from "../src/live.ts";

// The preview registry is pure in-memory state with the clock passed in, so
// lifecycle rules (ordering, ownership, expiry, bounds) are driven directly
// here; spec/wall.test.ts checks the same rules end to end over HTTP and SSE.
const LEASE = 5000;

describe("live previews", () => {
  it("grows a preview point by point and broadcasts only what's new", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    const a = live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1]] }, 0);
    expect(a).toMatchObject({ ok: true, count: 1 });
    const b = live.update(
      "hand-a",
      "#cc4a28",
      { gesture: g, from: 0, points: [[1, 1], [2, 2], [3, 3]] },
      100,
    );
    // A retry overlapping the first update only appends the two new points.
    expect(b).toMatchObject({ ok: true, count: 3 });
    expect(b.ok && b.events).toEqual([
      { type: "preview", gesture: g, colour: "#cc4a28", from: 1, points: [[2, 2], [3, 3]], held: false },
    ]);
    expect(live.snapshot()[0].points).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("keeps two hands' simultaneous gestures separate", () => {
    const live = createLive({ leaseMs: LEASE });
    const [g1, g2] = [randomUUID(), randomUUID()];
    live.update("hand-a", "#cc4a28", { gesture: g1, from: 0, points: [[1, 1]] }, 0);
    live.update("hand-b", "#5177aa", { gesture: g2, from: 0, points: [[9, 9]] }, 0);
    live.update("hand-a", "#cc4a28", { gesture: g1, from: 1, points: [[2, 2]] }, 10);
    const snap = Object.fromEntries(live.snapshot().map((p) => [p.gesture, p]));
    expect(snap[g1].points).toEqual([[1, 1], [2, 2]]);
    expect(snap[g2].points).toEqual([[9, 9]]);
    expect(snap[g2].colour).toBe("#5177aa");
  });

  it("refuses to let one hand update or cancel another hand's preview", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1]] }, 0);
    const hijack = live.update("hand-b", "#5177aa", { gesture: g, from: 1, points: [[5, 5]] }, 10);
    expect(hijack).toMatchObject({ ok: false, status: 403 });
    expect(live.cancel("hand-b", g, 10)).toEqual([]);
    expect(live.commit("hand-b", g, 10)).toBeUndefined();
    expect(live.snapshot()[0].points).toEqual([[1, 1]]);
  });

  it("cancels, and refuses a delayed update that would resurrect the preview", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1]] }, 0);
    expect(live.cancel("hand-a", g, 10)).toEqual([
      { type: "preview-end", gesture: g, reason: "cancelled" },
    ]);
    const late = live.update("hand-a", "#cc4a28", { gesture: g, from: 1, points: [[2, 2]] }, 20);
    expect(late).toMatchObject({ ok: false, status: 410 });
    expect(live.snapshot()).toEqual([]);
  });

  it("ends a committed gesture without a separate event, and refuses updates after", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1]] }, 0);
    expect(live.commit("hand-a", g, 10)).toBe(g);
    expect(live.snapshot()).toEqual([]);
    const late = live.update("hand-a", "#cc4a28", { gesture: g, from: 1, points: [[2, 2]] }, 20);
    expect(late).toMatchObject({ ok: false, status: 410 });
  });

  it("expires an abandoned preview once its lease runs out, and not before", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1]] }, 0);
    // An empty update is a heartbeat: it renews the lease without points.
    live.update("hand-a", "#cc4a28", { gesture: g, from: 1, points: [] }, 4000);
    expect(live.sweep(LEASE + 1)).toEqual([]);
    expect(live.sweep(4000 + LEASE + 1)).toEqual([
      { type: "preview-end", gesture: g, reason: "expired" },
    ]);
    expect(live.snapshot()).toEqual([]);
  });

  it("sweeps a stroke held awaiting its hand's decision once it's waited too long", () => {
    const live = createLive({ leaseMs: LEASE, heldMaxMs: 60_000 });
    const g = randomUUID();
    live.update("hand-a", "#cc4a28", { gesture: g, from: 0, points: [[1, 1], [2, 2]] }, 0);
    const held = live.update("hand-a", "#cc4a28", { gesture: g, from: 2, points: [], held: true }, 1000);
    expect(held.ok && held.events[0]).toMatchObject({ type: "preview", held: true, points: [] });
    // Heartbeats keep it inside the lease, but not past the held limit.
    for (let t = 4000; t <= 61_000; t += 3000) {
      live.update("hand-a", "#cc4a28", { gesture: g, from: 2, points: [], held: true }, t);
      if (t < 61_000) expect(live.sweep(t)).toEqual([]);
    }
    expect(live.sweep(61_001)).toEqual([{ type: "preview-end", gesture: g, reason: "expired" }]);
  });

  it("replaces a hand's older preview when the same hand starts a new one", () => {
    const live = createLive({ leaseMs: LEASE });
    const [g1, g2] = [randomUUID(), randomUUID()];
    live.update("hand-a", "#cc4a28", { gesture: g1, from: 0, points: [[1, 1]] }, 0);
    const second = live.update("hand-a", "#cc4a28", { gesture: g2, from: 0, points: [[5, 5]] }, 10);
    expect(second.ok && second.events[0]).toEqual({
      type: "preview-end",
      gesture: g1,
      reason: "replaced",
    });
    expect(live.snapshot().map((p) => p.gesture)).toEqual([g2]);
  });

  it("bounds ids, coordinates, update size, stroke length, rate and active gestures", () => {
    const live = createLive({ leaseMs: LEASE });
    const g = randomUUID();
    const up = (body: object, hand = "hand-a", now = 0) => live.update(hand, "#000", body, now);
    expect(up({ gesture: "not-a-uuid", from: 0, points: [] })).toMatchObject({ status: 400 });
    expect(up({ gesture: g, from: 0, points: [[1.5, 2]] })).toMatchObject({ status: 400 });
    expect(up({ gesture: g, from: 0, points: [[1, 99999]] })).toMatchObject({ status: 400 });
    const tooMany = Array.from({ length: LIMITS.pointsPerUpdate + 1 }, () => [1, 1]);
    expect(up({ gesture: g, from: 0, points: tooMany })).toMatchObject({ status: 400 });
    // A gap (points 5.. before 0..4 arrived) is refused with the count to resume from.
    expect(up({ gesture: randomUUID(), from: 5, points: [[1, 1]] })).toMatchObject({
      status: 409,
      count: 0,
    });

    // Rate: the per-hand window, whichever gesture the updates name.
    const rateLive = createLive({ leaseMs: LEASE });
    const results = Array.from({ length: LIMITS.updatesPerSecond + 1 }, () =>
      rateLive.update("hand-r", "#000", { gesture: randomUUID(), from: 0, points: [[1, 1]] }, 0),
    );
    expect(results.at(-1)).toMatchObject({ ok: false, status: 429 });

    // Length: a stroke can't grow past a finished mark's own cap.
    const longLive = createLive({ leaseMs: LEASE });
    const lg = randomUUID();
    let from = 0;
    let now = 0;
    let last;
    while (from <= LIMITS.pointsPerGesture) {
      last = longLive.update(
        "hand-l",
        "#000",
        { gesture: lg, from, points: Array.from({ length: 200 }, () => [1, 1]) },
        (now += 1000),
      );
      if (!last.ok) break;
      from = last.count;
    }
    expect(last).toMatchObject({ ok: false, status: 413 });

    // Active gestures: one per hand, and a global ceiling.
    const crowd = createLive({ leaseMs: LEASE });
    for (let i = 0; i < LIMITS.activeGestures; i++) {
      crowd.update(`hand-${i}`, "#000", { gesture: randomUUID(), from: 0, points: [[1, 1]] }, 0);
    }
    expect(
      crowd.update("hand-late", "#000", { gesture: randomUUID(), from: 0, points: [[1, 1]] }, 0),
    ).toMatchObject({ ok: false, status: 503 });
    expect(crowd.activeCount()).toBe(LIMITS.activeGestures);
  });
});
