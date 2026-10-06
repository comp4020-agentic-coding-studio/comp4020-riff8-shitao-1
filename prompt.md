# Brief: show a stroke while it's being drawn, not only once it's finished

Right now a hand's gesture is invisible to every other open tab until it
posts: `appendStroke` only runs when an `event: mark` arrives over
`/api/marks/stream`, and `broadcastMark` only fires after `addMark` persists
a finished path (`src/server.ts`). The README's own "What's real-time, and
why" section names this as the current, known shape: "only marks made while
they're actually looking stream in... the wall reads as a wall, not an
activity feed" — and separately flags that showing an *in-progress* gesture
to other hands hasn't been tried yet.

Make the wall show a stroke live, point by point, while the hand drawing it
is still mid-gesture — so two open tabs watching the same wall see the line
grow in something close to real time, the same way the drawing hand already
sees their own `live`/`halo` path grow locally in `public/wall.js`.

## What "good" looks like here

- This is a second, ephemeral layer on top of the existing one, not a
  replacement for it. The existing invariant stays true word for word: **"A
  mark broadcasts over `/api/marks/stream` the moment it's persisted, never
  before."** A live, in-progress stroke is not a mark — it hasn't been typed
  into the one-per-day limit, hasn't been persisted, and must never be
  treated as if it had been. If a tab reloads mid-gesture, or the gesture
  never finishes, there is nothing left behind: the live preview is pure
  broadcast, with no row in `trace.db`.
- When the gesture finishes and its real mark lands (persisted, broadcast,
  same as today), the other tabs' in-progress preview for that gesture has
  to resolve into the same finished stroke the existing `mark` event
  already draws — no visible jump, no leftover duplicate line sitting under
  or over it.
- When a gesture is abandoned instead of finished — pointer cancelled, lifted
  after fewer than two points, `Escape`, the tab closing, the SSE connection
  dropping mid-draw — every other tab's preview of that gesture has to
  disappear too. A half-drawn line that never resolves and never clears is
  worse than the current all-or-nothing reveal.
- Keep "one hand, one mark" exactly as strict as it is today: only a hand
  that `canDraw` ever starts a gesture (unchanged), and the one-mark-a-day
  check in `src/db.ts`/`msUntilNextMark` still gates the *finished* mark
  exactly as it does now. Streaming the in-progress points changes nothing
  about who's allowed to end up with a stroke on the wall.
- Don't let this become a second identity channel. A live stroke renders in
  the drawing hand's colour, same as it does locally already and same as a
  finished mark would — nothing about this should let one tab infer *which*
  other hand (cookie) is drawing, beyond what colour already discloses today.
- No accounts, no text, no third-party requests, no new persisted state,
  `DB_PATH` untouched — every rule in `CLAUDE.md`'s "Your harness" section
  still applies to whatever you build.
- Keep the mechanism as plain as the rest of this app. SSE was chosen over
  WebSockets because the wall only ever pushed one thing, one direction;
  that reasoning still holds for *delivering* live points to other tabs
  (keep using `/api/marks/stream`, with a new event type alongside `mark`,
  rather than reaching for WebSockets). The one new wrinkle is that a
  drawing tab now needs to *send* its in-progress points somewhere — pick
  the smallest mechanism that does that (an endpoint the existing
  `sseClients` broadcast loop can feed from is probably enough; you don't
  need to persist or rate-limit-per-day anything that isn't a finished
  mark). Do throttle how often a single gesture broadcasts (e.g. on
  `pointermove`/arrow-key steps, not unconditionally on every point) so one
  busy hand can't flood every open tab.
- A gesture needs some way for other tabs to tell "this update continues
  that stroke" from "this is a new one," and a way to know a gesture ended
  without a finished mark. A per-gesture id generated client-side the
  moment a gesture begins (sibling to the existing per-POST `nonce`, not a
  replacement for it) is the obvious shape; use whatever's simplest as long
  as two hands drawing at once never merge into one preview.

## Testing

`spec/wall-client.test.ts` already loads the real `public/wall.js` into
jsdom and drives it with real pointer/keyboard events, stubbing only what
jsdom lacks — extend it (or add alongside it) rather than asserting behaviour
in prose: at minimum, two simulated hands where one's in-progress gesture is
visible to the other before it posts, and a cancelled gesture that leaves
nothing behind. `spec/wall.test.ts` covers the server/SSE side; add coverage
there for "an in-progress stroke never reaches `allMarks()`/the database."
Keep `spec/invariants.test.ts` green. Update README's "What's real-time, and
why" section to describe what you actually built and tested, the same way
every other section there reports what was driven and confirmed, not just
what was intended.
