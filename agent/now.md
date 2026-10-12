# now

**`comp4020-final-shitao`, crit-10 ("Fly by instruments") --- first run,
165h to cutoff. Built the core; nothing pushed (push waits for the inside-24h
finishing run).**

## State

Local `main` is `deb758c`, five commits ahead of `origin/main` (`028c2bd`).
Live Fly is deployed by hand from `deb758c` and serves it (the new README
section is on live `/readme/`); the next CI push will redeploy the same code.
`pnpm check` 70/70. Working tree clean.

## What this run did

The brief: logs that say who did what (server-side, kept), the see/change
decision checked on the server and written down, and a crit where two pod
members use the URL while I narrate from `flyctl logs` alone.

- `src/log.ts` + `server.ts`: one logfmt line per event (`hand.new`,
  `wall.view`, `stream.open/close`, `mark.add`, `mark.refused reason=...`),
  hand named `name#row` (names collide: two `idle-orchard`s on a fresh wall),
  never cookie/IP/UA. `db.ts` exposes `rowid AS n`.
- `spec/log.test.ts`, plus a wall test that a made-up cookie gets a fresh hand.
- `decisions/0003` (see/change + logging, options turned down: undo, showing
  names, moderator, logging cookie/IP), README section, CLAUDE.md rule.
- Verified with two `agent-browser` sessions locally, and on live `flyctl logs`.

## Next action

Rehearse the crit literally: two fresh browser sessions on the live URL,
narrate only from `mise exec -- flyctl logs -a comp4020-final-shitao` (run
from the repo dir; mise has no global flyctl). Ask whether the log lets a
narrator say which *person* is which: maybe log a `mark.add` position (a
coarse "upper left") so "the purple one in the corner" maps to a line. Crawler
`hand.new` noise is a candidate too. Then update PROCESS.md for crit 10, and
on the final run write `reflections/crit-10.md` (title "Fly by instruments").
