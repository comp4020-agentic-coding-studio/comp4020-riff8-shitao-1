# Brief: make two hands distinguishable from the logs alone

Next crit's provocation: two people use this app, each in their own browser,
from the URL alone. The presenter narrates what's happening purely by reading
server logs — `flyctl logs -a <this app>` — never by looking at the screen.
Right now that's not possible: `src/server.ts` logs almost nothing (one
startup line, and `console.error` on crashes). Fix that, and document why the
identity model already in place is the right server-side enforcement
mechanism for this.

## What already works, and why it's enough

Don't build accounts or sessions. `hand` is already a stable per-visitor
identity (`src/identity.ts`): a cookie, a deterministic nickname like
`quiet-sparrow`, a colour. Ownership is already enforced server-side — only a
mark's own hand can delete it, note it, or see it in `/mine/`. That already
satisfies "two people the app tells apart" and "enforced server-side, not
just hidden in the UI." The gap is purely that none of it is ever logged.

## What to add

Add one `console.log` line per mutating action in `src/server.ts`, in this
shape — timestamp, nickname, verb, target:

```
2026-10-19T14:32:10Z  quiet-sparrow      added mark #482
2026-10-19T14:32:15Z  bold-ember         started a live stroke
2026-10-19T14:32:18Z  bold-ember         added mark #483
2026-10-19T14:32:22Z  quiet-sparrow      deleted mark #482
2026-10-19T14:32:28Z  quiet-sparrow      set a note on mark #481
2026-10-19T14:32:30Z  bold-ember         denied: tried to delete mark #482 (not owner)
```

Cover: mark added, note set/cleared, mark deleted, live stroke started,
committed, cancelled — and every denied/not-owner case, since a refused
cross-hand action is the actual proof that enforcement works. A helper
function for the "nickname  verb  target" formatting beats repeating it at
each call site.

Also log the one distinction `ensureHand` (`src/server.ts`) already makes for
free: when it mints a brand-new id via `createHand`, that's a new hand; when
it resolves an existing cookie, that's a returning one. A line like
`quiet-sparrow  new hand` the first time, nothing extra on later requests, is
enough — this is surfacing a fact the server already computes, not adding
new tracking.

**Never log content.** No private note text, no stroke path data, no prompt
text beyond what's already public on the wall. The log line says what
happened and to which mark id, never what was drawn or written — logging
must not become a second way to leak what the private-note rule in
`CLAUDE.md` keeps private.

No dashboard, no admin page, no new log storage. `console.log` already
reaches Fly's log collector, which is all `flyctl logs -a <app>` needs — the
whole point is that a human reads these live, not that the app renders them.

## Also do

- Add a short section to `README.md` (or `PROCESS.md`, whichever already
  holds this kind of decision record) stating plainly: identity here is a
  cookie-and-nickname hand, ownership checks are server-side, and now every
  mutating action and every denied cross-hand attempt is logged by hand
  nickname — with the reasoning that this is the smallest mechanism that
  makes two visitors distinguishable without becoming accounts.
- Keep every existing rule in this file's top block intact: no public text,
  no accounts, the rolling 24-hour one-mark limit, no third-party requests,
  broadcast-after-persist ordering, live previews staying ephemeral.
- Run `pnpm check` before committing. This is additive logging only —
  nothing in `spec/*.test.ts` should need to change, and if one does, that's
  a sign the change went further than this brief asks for.
- Delete this file in your last commit, per the standing rule above.
