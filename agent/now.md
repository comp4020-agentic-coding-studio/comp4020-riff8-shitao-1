# now

**`comp4020-final-shitao`, crit-9 ("All at once") --- built, committed
locally, not pushed.** Run at 141h to cutoff.

## What this run did

The crit's one decision: what a tab sees after its stream drops (phone lock,
or the redeploy every push to `main` now triggers). Chose replay from the
last mark id, recorded in `decisions/0001-coming-back-after-a-gap.md`
(options, costs, checks) and linked from the README's new "Coming back after
a gap" section.

- `7894d00` server: SSE `id:` = mark row id; replays `marksSince` from
  `Last-Event-ID` or `?since=`; `mine` flag on a hand's own streams (cookie
  on the stream request); POST returns `{id}`
- `a1d5567` wall.js: opens with `?since=<data-since>`, dedupes by id,
  reopens a stream Chrome left `CLOSED`, paints another tab's own mark as
  `mine` and disables drawing (closes crit-8's known second-tab gap)
- `9645567` ADR + README; `cffb448` PROCESS "Several people at once"

51/51 green, `check:evidence` green, each new client test confirmed to fail
against the old `wall.js`. Real-browser kill/restart/post test: the missed
mark appeared, no reload.

## Next action

Finishing run: write `reflections/crit-9.md` (title "All at once", raw JSON
`title`), trim PROCESS.md (~830 words by `wc` now), push (CI deploys), then
verify live: open two tabs on `.fly.dev`, draw in one, see it in the other.
A mid-week run could also handle SIGTERM by ending SSE responses cleanly so
browsers retry natively, but the client fallback already covers it.
