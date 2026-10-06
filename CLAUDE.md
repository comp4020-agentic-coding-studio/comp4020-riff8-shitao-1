# This repo is a pod riff: pods write the prompt, the agent does the work

This repo is a copy of [`comp4020-final-shitao`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao) at
`0b60b87e` --- shitao's crit agent's final project as it stood at
`08-its-alive`. Their repo is untouched and off limits. From here to the end of
semester, each crit a pod picks this repo up from wherever the last run left
it.

**Pods: the only file you change is `prompt.md`, at the repo root.** Read the
live app, the code and the history, then write the prompt that would take
this app to a strong, interesting answer to the next brief (the crit runsheet
links it). The prompt can point at any file here. After the session,
shitao's crit agent runs `prompt.md` once, unattended, start to finish, and
nobody is there to answer its questions --- so say what you want, what good
looks like and what to leave alone. Push it before you leave.

**Crit agent: when `prompt.md` exists, it is your brief.** Run it to
completion in one go, keep `main` deployable, and delete `prompt.md` in your
last commit. Leave this block of `CLAUDE.md` as it is.

**Nothing here is marked.** No cutoff, no reflection, no `PROCESS.md` entry.
The next crit opens by looking at where each pod repo ended up, beside the
prompt that got it there (the `prompt-crit<N>` tag).

**The agent's own spec tests are `spec/contrast.test.ts`, `spec/day.test.ts`, `spec/wall-client.test.ts` and `spec/wall.test.ts`.** They encode the brief it was
working to, and they gate the deploy. A prompt aimed at a different brief can
have them changed or deleted; keep `spec/invariants.test.ts` green, since that
one is true of any good site.

Everything below this line was written for the agent's graded submission. Its
marks, cutoff and weekly skills don't govern this repo: read it for how the
agent was directed, not for what anyone owes.

---

# Your harness

Trace's argument (`README.md`) is that a mark is a gesture, not a post, and
that the wall grows by care, not by engagement. These rules keep the code
honest to that, not just the README:

- **A public mark is a path, never text.** Nothing anyone else sees ---
  the wall, `/api/marks`, `/api/marks/stream`, a keepsake SVG --- carries
  words a visitor typed. A mark may record which listed prompt it answered
  (`src/prompts.ts`'s exact wording, never free text) and may carry a
  private note, which only its own hand ever reads (`/mine/` and its
  export). Anything that would make words public is a README rewrite first.
- **No accounts, ever.** Identity is the `hand` cookie `src/identity.ts`
  mints, nothing else. Don't add a login, an email field, or anything that
  outlives the cookie.
- **The one-mark-a-day limit is enforced in `src/db.ts`, not the client.**
  The server must refuse a second mark from the same hand within 24 hours
  of its last (a rolling window, never a calendar day) even from a bare
  `curl`. Deleting a mark never refunds it, a retry carrying the same nonce
  returns the original mark rather than making another, and drafts,
  practice and previews never count.
- **No third-party requests.** No analytics, no CDN-hosted fonts or scripts,
  no embeds. Every `<script>` and `<link>` the server sends is same-origin.
  `spec/wall.test.ts` checks this; don't add an exception without updating
  both the test and README's "what's enforced" list.
- **Persistence lives at `DB_PATH` (default `/data/trace.db`, matching
  `fly.toml`'s volume).** Never write app state anywhere else, and never
  assume `/data` is empty --- a redeploy reuses the volume.
- **A mark broadcasts over `/api/marks/stream` the moment it's persisted,
  never before.** `src/server.ts`'s `broadcastMark` runs after `addMark`
  returns. Live previews of strokes in progress share the stream but are a
  separate, ephemeral layer (`src/live.ts`): in memory only, owned by the
  hand cookie, ended by commit, cancel, a 5-second lease or a two-minute
  hold, and never written to `DB_PATH`.
- **Nothing streams unless the hand chose Draw live for that gesture.**
  Practice is the default; turning live on never shares a stroke already
  drawn.
- **When a check catches a real mistake, fix the check or the harness too**,
  not just the code once, so the same mistake can't silently ship again.

What the template ships is explained where it lives --- `fly.toml`, the
`Dockerfile`, the CI workflow and `spec/README.md` each say what they fix ---
and the course website publishes the
[final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/).
