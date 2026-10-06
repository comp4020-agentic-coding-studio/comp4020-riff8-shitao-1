// The ephemeral layer: strokes still being drawn. Nothing here ever touches
// src/db.ts --- a preview lives in this process's memory, is broadcast to
// open tabs, and is gone when its gesture is committed, cancelled, replaced
// or simply goes quiet for longer than its lease. A restart forgets every
// preview, which is the point: an unfinished gesture is never artwork.

export type Point = [number, number];

export interface PreviewSnapshot {
  gesture: string;
  colour: string;
  points: Point[];
  held: boolean;
}

export type LiveEvent =
  | { type: "preview"; gesture: string; colour: string; from: number; points: Point[]; held: boolean }
  | { type: "preview-end"; gesture: string; reason: "cancelled" | "expired" | "replaced" };

export type UpdateResult =
  | { ok: true; count: number; events: LiveEvent[] }
  | { ok: false; status: number; reason: string; count?: number };

interface Preview {
  gesture: string;
  handId: string;
  colour: string;
  points: Point[];
  held: boolean;
  updatedAt: number;
}

// A gesture id is a fresh random UUID per stroke, chosen by the drawing tab
// so it can recognise its own preview and mark coming back over SSE before
// any response arrives. It's broadcast, so it must say nothing about the
// hand: it's never stored, never reused, and ownership is checked against
// the hand cookie, never against knowledge of the id.
export const GESTURE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LIMITS = {
  // Same cap as a finished mark's path (src/server.ts's PATH_RE).
  pointsPerGesture: 2001,
  pointsPerUpdate: 200,
  updatesPerSecond: 30,
  activeGestures: 100,
  // Ended ids are remembered so a delayed update can't resurrect a preview,
  // and a mark can't borrow another hand's gesture id.
  endedRemembered: 2000,
  endedForgetMs: 10 * 60 * 1000,
  // Generous enough for a phone that draws outside the wall with pointer
  // capture on; the viewBox itself is 1000 × 600.
  coordMin: -1000,
  coordMax: 2000,
};

const validPoint = (p: unknown): p is Point =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((n) => Number.isInteger(n) && n >= LIMITS.coordMin && n <= LIMITS.coordMax);

export function createLive({ leaseMs }: { leaseMs: number }) {
  const active = new Map<string, Preview>();
  const ended = new Map<string, { handId: string; at: number }>();
  // Per hand, not per gesture, so minting fresh gesture ids can't dodge it:
  // the start of the current one-second window and the updates within it.
  const rate = new Map<string, { start: number; count: number }>();

  const end = (preview: Preview, now: number) => {
    active.delete(preview.gesture);
    ended.set(preview.gesture, { handId: preview.handId, at: now });
    if (ended.size > LIMITS.endedRemembered) {
      ended.delete(ended.keys().next().value!);
    }
  };

  return {
    update(
      handId: string,
      colour: string,
      body: { gesture?: unknown; from?: unknown; points?: unknown; held?: unknown },
      now = Date.now(),
    ): UpdateResult {
      const { gesture, from, points } = body;
      if (typeof gesture !== "string" || !GESTURE_RE.test(gesture)) {
        return { ok: false, status: 400, reason: "bad gesture id" };
      }
      if (!Number.isInteger(from) || (from as number) < 0) {
        return { ok: false, status: 400, reason: "bad from" };
      }
      if (
        !Array.isArray(points) ||
        points.length > LIMITS.pointsPerUpdate ||
        !points.every(validPoint)
      ) {
        return { ok: false, status: 400, reason: "bad points" };
      }
      const held = body.held === true;

      const endedEntry = ended.get(gesture);
      if (endedEntry) return { ok: false, status: 410, reason: "gesture already ended" };

      const slot = rate.get(handId);
      if (!slot || now - slot.start >= 1000) {
        rate.set(handId, { start: now, count: 1 });
      } else if (++slot.count > LIMITS.updatesPerSecond) {
        return { ok: false, status: 429, reason: "too many updates" };
      }

      const events: LiveEvent[] = [];
      let preview = active.get(gesture);
      if (preview && preview.handId !== handId) {
        return { ok: false, status: 403, reason: "not your gesture" };
      }
      if (!preview) {
        if ((from as number) !== 0) return { ok: false, status: 409, reason: "unknown gesture", count: 0 };
        // One live stroke per hand: a second tab (or a stuck first one)
        // starting a new gesture ends the old one rather than stacking.
        for (const other of active.values()) {
          if (other.handId === handId) {
            end(other, now);
            events.push({ type: "preview-end", gesture: other.gesture, reason: "replaced" });
          }
        }
        if (active.size >= LIMITS.activeGestures) {
          return { ok: false, status: 503, reason: "too many people drawing right now" };
        }
        preview = { gesture, handId, colour, points: [], held, updatedAt: now };
        active.set(gesture, preview);
      }

      const start = from as number;
      const count = preview.points.length;
      if (start > count) return { ok: false, status: 409, reason: "gap", count };
      // A retried update overlaps what's already here; keep only what's new.
      const fresh = (points as Point[]).slice(count - start);
      if (count + fresh.length > LIMITS.pointsPerGesture) {
        return { ok: false, status: 413, reason: "stroke too long", count };
      }
      preview.points.push(...fresh);
      preview.updatedAt = now;
      const heldChanged = preview.held !== held;
      preview.held = held;
      if (fresh.length > 0 || heldChanged || count === 0) {
        events.push({ type: "preview", gesture, colour: preview.colour, from: count, points: fresh, held });
      }
      return { ok: true, count: preview.points.length, events };
    },

    cancel(handId: string, gesture: unknown, now = Date.now()): LiveEvent[] {
      if (typeof gesture !== "string") return [];
      const preview = active.get(gesture);
      if (!preview || preview.handId !== handId) return [];
      end(preview, now);
      return [{ type: "preview-end", gesture, reason: "cancelled" }];
    },

    // Called once a mark has been persisted. Returns the gesture id to tag
    // the mark's broadcast with, so viewers can swap the preview for the
    // committed stroke in place --- or undefined if the id isn't this hand's
    // to claim. The preview ends silently: the mark event is its end.
    commit(handId: string, gesture: unknown, now = Date.now()): string | undefined {
      if (typeof gesture !== "string" || !GESTURE_RE.test(gesture)) return undefined;
      const preview = active.get(gesture);
      if (preview) {
        if (preview.handId !== handId) return undefined;
        end(preview, now);
        return gesture;
      }
      const endedEntry = ended.get(gesture);
      if (endedEntry && endedEntry.handId !== handId) return undefined;
      ended.set(gesture, { handId, at: now });
      return gesture;
    },

    // Abandoned previews (a closed tab, a dropped connection, a cancel that
    // never arrived) end here, whether or not anyone said goodbye.
    sweep(now = Date.now()): LiveEvent[] {
      const events: LiveEvent[] = [];
      for (const preview of active.values()) {
        if (now - preview.updatedAt > leaseMs) {
          end(preview, now);
          events.push({ type: "preview-end", gesture: preview.gesture, reason: "expired" });
        }
      }
      for (const [gesture, entry] of ended) {
        if (now - entry.at > LIMITS.endedForgetMs) ended.delete(gesture);
      }
      for (const [handId, slot] of rate) {
        if (now - slot.start >= 1000) rate.delete(handId);
      }
      return events;
    },

    snapshot(): PreviewSnapshot[] {
      return [...active.values()].map((p) => ({
        gesture: p.gesture,
        colour: p.colour,
        points: [...p.points],
        held: p.held,
      }));
    },

    activeCount: () => active.size,
  };
}
