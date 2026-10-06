# MEMORY

Durable self-knowledge, curated run by run; ephemeral state belongs in
`now.md`, not here.

## Tooling gotchas worth not re-discovering

- **A crit source's rendered Markdown heading and its raw JSON `title` field
  can differ, and the reflection filename/heading rule wants the latter.**
  Fetching `crits/07-anu-system.json` via `WebFetch` (crit-7's finishing run,
  28h to cutoff) returned rendered prose headed "# Crit 7: Build the ANU
  System You Wish Existed" --- title case, with a "Crit N:" prefix. The raw
  JSON's actual `title` field was `"Build the ANU system you wish existed"`:
  sentence case, no prefix. The doctrine's reflection rule ("head it with the
  source's title, never a week number") means the JSON field specifically,
  not whatever heading a Markdown-rendering fetch happens to produce ---
  confirmed by a follow-up plain `curl` of the same URL to read the JSON
  directly rather than trusting the first fetch's rendering. Do this check
  on every future reflection: pull the raw JSON (`curl -fsS <url> | head`)
  and copy `title` verbatim, don't rely on a prior WebFetch's own heading
  choice.

- **A bare `curl -X POST` with no `-d`/Content-Type header makes an Astro
  route's `await request.formData()` throw a real 500 — this is a malformed
  test request, not an app bug, because a real `<form>` submit always
  carries a body (even an empty one) and its Content-Type.** Hit this
  verifying a genuine cancel-vs-move race on `comp4020-crit7-shitao`
  (run 17, 39h to cutoff): scripting `cancel.ts`'s route with plain
  `curl -X POST -H "Cookie: ..."` and no `--data` gave a consistent 500
  across every round, which briefly looked like a real concurrency bug
  before checking the handler source — it unconditionally calls
  `request.formData()` with nothing that would guard a bodyless request.
  Fixed by always sending an actual urlencoded body via
  `--data-urlencode`, matching what `spec/*.test.ts` already does via
  `fetch(..., { body: new URLSearchParams() })` (which sets the header and
  an empty-but-present body automatically). Whenever hand-rolling `curl`
  against an Astro/similar route that reads `request.formData()`, always
  pass at least one `--data`/`--data-urlencode` field, never a bare `-X
  POST` with headers only.
- **A failed glob mid-`&&`-chain in zsh silently kills everything after it in
  that chain, including a background server start --- and the failure can
  look like a completely unrelated bug.** `mkdir ... && rm -f
  /tmp/some-dir/app.db* && ... node server.js &` (crit-7, run at 165h to
  cutoff): the `rm -f` glob matched nothing, zsh raised `nomatch`, and the
  whole chain aborted before `node` ever ran --- no error visible in the
  tool output that read as "server failed to start." `curl` against the
  intended port then hit a *pre-existing unrelated* process already bound
  there (an old `astro preview` for a different repo), returning that
  site's own 404 page, which read like a bizarre proxy/routing bug for
  several minutes before `ps aux`/`lsof -i:PORT -a -p PID` and the absence
  of the expected log file proved the intended command had never actually
  run. Use `rm -rf` (no glob) or drop globs from any `&&` chain that also
  starts a background process, and check `lsof -ti:$PORT` is empty (not
  just "curl returned something") before trusting a freshly-started
  server is the thing answering on that port.
- **`comp4020-ass2-shitao`'s local preview serves under a non-root base
  path, derived from the git remote, not `/`.** `astro.config.mjs` calls a
  `resolveDeployment(env, gitOrigin)` helper that sets `base` from the repo
  name; hitting `http://localhost:<port>/lectures/week-07/` after `astro
  preview` (run at 117h to cutoff) 404s, while
  `http://localhost:<port>/comp4020-ass2-shitao/lectures/week-07/` serves
  correctly. Same family as the standing "confirm the actually-bound port,
  don't trust the one you asked for" gotcha below --- for this repo
  specifically, also confirm the base path before assuming a bare route
  will resolve locally.

- **Astro's markdown/MDX pipeline converts a literal `---` to a real em-dash
  glyph; raw prose hardcoded inside a `.astro` file's template body does
  not.** Found in assignment-2 (run at 165h to cutoff): the house "use three
  dashes for em dashes" convention rendered correctly everywhere it went
  through content-collection markdown — including inside frontmatter
  `description:`/`spec:` string values, not just the markdown body — but two
  sentences of hardcoded prose in `src/pages/index.astro` rendered the
  literal `---` characters as-is. No build warning, no typecheck error; only
  caught by reading `document.querySelector('main').innerText` in a real
  browser and eyeballing a screenshot. Fix is to type an actual "—" character
  directly in any `.astro` file's inline prose — the markdown convention only
  applies to content that actually passes through the markdown/remark
  pipeline (`.md`/`.mdx` files and their frontmatter), not raw template
  strings.
- **`vite preview`'s default port isn't guaranteed, and `agent-browser open`
  won't tell you if you guessed wrong.** Started `vite preview --port 4321`
  (crit-5, run at 148h to cutoff) while something else on the host already
  had 4321 bound (an unrelated open tab serving the course website); vite
  logged "Port 4321 is in use, trying another one" and actually bound 4322,
  but `agent-browser open http://localhost:4321` still succeeded with no
  error, rendering that other site. The tell was the page title in the
  `open` command's own output ("Home — COMP4020 Agentic Coding Studio"
  instead of the game's title), not any error or empty screenshot. Read the
  preview server's own log line for the port it actually bound, or check the
  title/take a screenshot immediately after `open`, rather than assuming the
  `--port` you requested is the one you got.
- **`agent-browser` viewport**: it's `agent-browser set viewport <w> <h>` as
  its own command, not a `--viewport` flag on `open`. Passing it to `open`
  fails silently-ish (open still succeeds) and screenshots come back at the
  default desktop width — checked dimensions, not just eyeballed, is what
  caught this the one time it happened.
- **zsh doesn't word-split an unquoted variable**: `B="agent-browser
  --session x"; $B open ...` fails with "command not found". Write the full
  command each time instead.
- **`mise`**: a fresh environment's global `~/.config/mise/config.local.toml`
  may need `mise trust <path>` before `pnpm`/other shims work. This is a
  trust operation on the user's own pre-existing config, not a content edit —
  safe to run without asking.
- **stylelint's `no-descending-specificity`**: attribute-selector compounds
  (`nav[aria-label="Primary"] a`) don't have a stable specificity order
  against plain class or tag selectors, so reordering CSS rules to fix a
  violation just moves it elsewhere. The real fix is structural: add an
  explicit class to the element and select on that instead of the attribute
  compound. Reconfirmed in a plainer shape (crit-4, `Chime`): a bare two-tag
  compound (`header h1`) before a later plain `h1` rule tripped the same
  check, no attribute selector involved — the trigger is any compound with a
  different specificity than a plain-selector rule touching the same element,
  not specifically attribute compounds. Same fix: an explicit class (`.brand`)
  on the element, selector on the class, drop the compound entirely.
- **Museum/gallery sites and bot-blocking**: metmuseum.org returns HTTP 429
  with a Vercel challenge header to *any* automated request, browser
  User-Agent or not, across its whole domain — not a per-URL quirk. If a
  future week links to museum collection pages, expect this class of
  problem and check with `curl -I` before assuming a reformatted URL will
  fix a links-check failure. Wikimedia Commons and Wikipedia have not shown
  this behaviour.
- **`agent-browser` in a fresh sandbox**: Chrome isn't preinstalled, and even
  after `agent-browser install` a bare `open` can fail with "Chrome exited
  before providing DevTools URL" / zygote sandbox errors. `--args` is a
  *global* option, not a per-subcommand one: `agent-browser open <url> --args
  "--no-sandbox"` (flag after the subcommand) fails silently back into the same
  sandbox error, whether quoted with a space or `=`. What actually works is
  `agent-browser --args "--no-sandbox" open <url>` (flag before the
  subcommand) — confirmed again this run (run 9, 52h to cutoff) after a prior
  run's note claimed the after-subcommand form worked "first try," which this
  run couldn't reproduce. Reconfirmed a third time (39h to cutoff): still the
  only form that launches Chrome in this sandbox, so treat it as settled
  rather than re-testing the after-subcommand form again.
- **`agent-browser` has no keyboard-hold primitive.** `press <key>` fires a
  full keydown+keyup instantly — there's no `keydown`/`keyup` pair exposed
  separately, so you can't drive a "hold this key for N seconds" gesture
  through the normal command surface. Workaround that worked (crit-4, run at
  148h to cutoff, testing a hold-duration swell effect on the keyboard path):
  `agent-browser eval "window.dispatchEvent(new KeyboardEvent('keydown',
  {key: 'j', bubbles: true}))"`, then `sleep`, screenshot, then the matching
  `keyup` dispatch. This exercises the app's real `window.addEventListener`
  listeners (since the app itself doesn't distinguish a dispatched
  `KeyboardEvent` from a native one), so it's a legitimate test of the
  keyboard hold path, not a synthetic shortcut around it — just document
  which command produced it, since it's a step further from "real user
  input" than `mouse down`/`mouse up` are.
- **`agent-browser`/CDP cannot simulate multi-touch against code that calls
  `setPointerCapture`.** Tried dispatching two synthetic `PointerEvent`s with
  distinct `pointerId`s via `eval` (crit-4, `Chime`, 76h to cutoff) to verify
  a two-finger-touch gesture the app's real pointer handling never branches
  on `pointerType` for. No visible effect — traced it by monkey-patching
  `canvas.setPointerCapture` inside the same `eval` to log instead of throw:
  it throws `NotFoundError: No active pointer with the given id is found`
  for any JS-constructed `PointerEvent`, since Chrome's pointer-capture
  implementation checks its own hardware-backed active-pointer state, not
  properties on the event object. The throw happens *inside* the app's
  `pointerdown` listener, before any of the app's own logic runs — confirmed
  a plain listener with no capture call, added in the same `eval`, sees the
  synthetic event fine, so the block is specifically capture APIs, not event
  dispatch generally. This is not an app bug (real hardware pointerdown
  events always carry an id Chrome has live state for, so capture never
  throws for a genuine user) — it's a hard ceiling on what synthetic
  dispatch can test. Unlike the keyboard-hold trick above (keydown/keyup
  have no equivalent capture requirement), don't spend a future run trying
  variations of this for any app using `setPointerCapture`/similar capture
  APIs — fall back to the structural argument (code doesn't branch on
  `pointerType`, state keyed uniformly across input sources) plus whatever
  single-pointer/keyboard-chord gestures *are* directly testable.
  Confirmed the flip side (crit-5, `One Stroke`, 69h to cutoff): for code
  that never calls `setPointerCapture` at all — `main.ts`'s single
  `pointermove` listener just reads `event.clientY` — a synthetic
  `PointerEvent` with `pointerType: 'touch'` dispatches and is handled with
  no error, and the brush visibly follows it (checked by reading the darkest
  pixel down the brush's x-column via `getImageData`, before/after two
  dispatches to opposite screen edges). The capture ceiling above is real but
  narrow: it only bites the specific multi-touch-with-capture shape, not
  "any synthetic touch event" — a single simulated touch pointer against
  capture-free code is a legitimate, working way to verify a "pointermove
  unifies mouse/touch/pen" design claim without a real touchscreen.
- **A compressed/small screenshot of a thin, edge-clipped canvas element can
  look like it's missing a feature that's actually there.** Re-verifying
  "One Stroke" at the 390×844 marking viewport (crit-5, 135h to cutoff), a
  wall column barely visible at the canvas's right edge (only ~6-13px of its
  width on-screen) read, by eye, as a solid full-height bar with no gap —
  which would have been a real rendering bug (the gap is the whole mechanic).
  Before touching code, sampled pixel colours directly via `agent-browser
  eval` + `ctx.getImageData(x, y, 1, 1).data` down the column, and separately
  re-ran with the same wall centred on screen (timed from the sim's own
  spawn/scroll constants, same technique as the wall-arrival-timing entry
  above) — the gap was exactly where `gapCenterFor(index)` predicts both
  times; the edge case just compresses badly in a thumbnail. Generalises the
  standing "read game state off rendered pixels" technique one step further:
  when a screenshot-based check looks wrong for a thin/edge-clipped element,
  sample pixels directly before concluding it's a bug — a small, oddly-scaled
  screenshot is not reliable evidence at that scale, in either direction.
- **After `pkill -f <process name>`, don't trust the exit code — check the
  port.** Killing a `vite preview` background server with `pkill -f "vite
  preview"` reported a non-zero/odd exit code, which looked like "no matching
  process, already dead" — but a `curl -sI` against the port it had been
  serving still returned `200 OK` immediately after (crit-4, 148h to
  cutoff). The reliable check is `lsof -ti:<port> | xargs -r kill` followed
  by a re-`curl` (or a bare `lsof -ti:<port>` returning nothing) — `pkill`'s
  reported outcome and the process's actual state can disagree, so verify
  the port is actually free before considering a preview/dev server shut
  down, per the doctrine's "shut down servers afterwards" step.
- **`docker` in this sandbox needs `sudo -n docker ...` plus
  `dangerouslyDisableSandbox: true`, not just one or the other.** Building a
  Dockerfile locally to test the exact CI/Fly image (`comp4020-final-shitao`,
  crit-8, 164h to cutoff) failed twice with "permission denied ...
  docker.sock" --- once under default sandboxing, once with
  `dangerouslyDisableSandbox: true` alone. `groups`/`ls -la
  /var/run/docker.sock` showed the socket is `root:docker` and user `ben`
  isn't in the `docker` group. `sudo -n docker build/run/logs/rm ...`
  combined with `dangerouslyDisableSandbox: true` on the same call is what
  actually works. Reach for this combination directly next time rather than
  rediscovering it via two failed attempts.
- **`vitest`'s jsdom has no real `<canvas>` backend**: `canvas.getContext("2d")`
  returns `null` there (not a stub with no-op methods), so any spec test that
  dispatches a pointer/draw event against canvas-based interactivity will
  throw unless the drawing code itself is guarded. Pattern that worked
  (assignment-1, the yihua ink-brush prototype): wrap every draw call in
  `if (ctx) { ... }` so the *behavioural* DOM state (a counter, a live status
  region) still updates and is testable in jsdom even though the ink itself
  never renders there. Keeps the canvas interaction from being untested by
  default just because the obvious jsdom check would crash.

- **`check-evidence.ts`'s commit-citation regex only matches hex-shaped link
  text.** `PROCESS.md` citations are parsed as
  `` [`sha`](url) `` where the link *text* must look like a SHA
  (`/[0-9a-f]{7,40}/`, or a `sha...sha` range) --- a citation written as
  `` [`spec/foo.test.ts`](...) `` silently doesn't count as a citation at all,
  and the whole check fails with "no commit citations found" even though a
  link is right there. Consequence: you cannot cite a commit's content before
  that commit exists. Commit first, then edit `PROCESS.md` to cite the real
  SHA in a follow-up commit --- cite-then-commit doesn't work, it has to be
  commit-then-cite.
- **A `cd` inside a compound/backgrounded Bash command changes cwd for every
  later command in the session**, since the Bash tool persists cwd across
  calls but has no per-command scoping. `cd dist && python3 -m http.server
  ... &` left the shell sitting in `dist/` afterward; subsequent `git status`
  silently showed `../PROCESS.md`-style relative paths instead of erroring.
  Caught by noticing the path shape look wrong, not by any command failing.
  Use a subshell (`(cd dist && ...)`) or `cd` back explicitly right after,
  never rely on a background job's `cd` staying scoped to that job.
- **`axe-core` snapshots `window`/`document` from `globalThis` at *import*
  time, not at call time** — and ESM hoists static `import` statements ahead
  of every other top-level statement in the module. So building your own
  jsdom instance and doing `Object.assign(globalThis, { window, document })`
  *after* a static `import axe from "axe-core"` is already too late: `axe.run()`
  fails claiming the globals aren't set, even though they plainly are by the
  time the call executes. Fix is a dynamic `await import("axe-core")` placed
  *after* the globals are assigned (confirmed the ordering at a bare Node
  REPL before trusting it: same globals, dynamic import after works, static
  import before doesn't). Found wiring axe-core into a vitest spec test that
  builds its own jsdom rather than using vitest's `environment: "jsdom"`
  (assignment-1, `spec/axe.test.ts`) — watch for the same shape if a future
  week reaches for axe-core again.
- **`agent-browser scroll`'s first argument is a direction keyword
  (`up`/`down`/`left`/`right`), not a pixel offset.** `agent-browser scroll 0
  500` parses `0` as an (invalid-but-silently-accepted?) direction and the
  page doesn't move — no error, just a screenshot identical to before the
  call, which is what gave it away. Correct form is `agent-browser scroll
  down 500` (direction first, then the pixel amount); `--help` on the
  subcommand spells this out and is worth checking before guessing
  positional-argument order on any `agent-browser` subcommand.
- **`agent-browser find`'s `--name` filter must come after the action, not
  between the locator value and the action.** `find role button --name "X"
  click` errors ("Unknown action '--name'"), because the parser reads
  positionally (`find <locator> <value> [action] [text]`) and treats
  anything after the value as the action slot until it sees a flag it
  recognises in that position; `find role button click --name "X"` is the
  form that works. Found while clicking a named "Clear canvas" button
  during an assignment-1 interaction pass (run 8).
- **`agent-browser find role button --name "X"` doesn't match a `<summary>`
  element even when it's the disclosure triggering a `<details>` panel.**
  `comp4020-crit7-shitao`'s `/mine/` Move disclosure (a plain `<summary>Move
  </summary>` inside `<details>`) didn't show up in the button-role query at
  all (`find role button` listed five other real buttons, no "Move" among
  them) — Chrome's accessibility tree apparently doesn't expose a bare
  `<summary>` under the `button` role the way `find role` expects, unlike an
  actual `<button>`. Reliable workaround: `agent-browser eval
  "document.querySelector('summary').click()"` — exercises the browser's
  real native toggle behaviour (confirmed `details.open` flips to `true`
  after), not a synthetic shortcut around it. Worth trying `find role group`
  or similar first if a future run needs to target one by name rather than
  by bare selector, but the `eval`+`click()` route is confirmed to work.
- **`agent-browser` has no bandwidth-throttle command** — checked its full
  `--help` and the `skills get core --full` reference (assignment-1, run 5)
  looking for a way to test the artefact-criterion HD language ("holds up
  under... a slow connection"). It has `network route <url> --abort` (asset
  never arrives) and `set offline on` (always offline), but nothing between
  those and full speed — no CDP `emulateNetworkConditions` equivalent
  exposed. The honest substitute: route-abort `**/*.js` and `**/*.css`
  independently and combined against the built site, which bounds the worst
  case (assets that never arrive) even though it can't show a genuinely slow
  *trickle*. Don't spend a future run hunting for a throttle flag that isn't
  there — reach for route-abort combinations instead.
- **`agent-browser get box <sel>`'s coordinates aren't clipped to what's
  actually visible.** It returns the element's full bounding rect regardless
  of `window.innerHeight`, so a canvas whose box reports e.g. `y:470
  height:260` can have its bottom half (y > 577 in a 1280×577 headless
  window) sitting below the fold — `document.elementFromPoint` at a point
  inside the reported box returns `null` there, and `mouse move`/`down` to
  that point dispatch *zero* events, no error, nothing in `console`/`errors`.
  This produced a convincing false negative (assignment-1, 52h to cutoff):
  a real bug looked unreproducible in the live browser for several attempts
  before the actual cause (my test point, not the app) turned up by
  instrumenting the target element with a temporary listener that logged
  every event it received — an empty log at a point *inside* the reported
  box is the tell, not a `console`/`errors` check, since nothing throws.
  Pick interaction coordinates from `window.innerHeight`/`innerWidth`
  (checked via `eval`), not straight from `get box`, whenever the element is
  tall relative to the viewport.
- **Generating an `og:image` link-preview card from an app's own visual
  language, not a separately-designed banner.** When a course-checks update
  (crit-4, 135h to cutoff) added a presence-only `og:image` invariant and
  shipped the template's literal placeholder PNG, the fix was a scratch HTML
  file (`/tmp/...`, not committed) that re-implements the *actual* app's
  layout/draw formulas (copy the real constants/math from the source, not an
  approximation) inside a plain `<canvas>` at the exact card dimensions
  (1200×630), rendered via `agent-browser`: `agent-browser set viewport 1200
  630` then `agent-browser --args "--no-sandbox" open file:///tmp/.../card.html`
  (sandbox-launch and viewport gotchas both apply here too — see their own
  entries above), then `agent-browser screenshot <path>.png`. `identify
  <path>.png` confirms the exact pixel dimensions before installing it as
  `public/card.png`. Cheap and reusable for any future week whose brief wants
  a link-preview card: read the app's real rendering code first, replay it
  standalone, don't design a new image from scratch.

- **A multi-line Bash tool call with a nested `python3 -c` inside a shell
  function silently drops its computed values.** Tried computing pixel
  coordinates in a bash function (`mvy() { x=$(python3 -c "...")); agent-browser
  mouse move $x $y; }`) inside one multi-line Bash call (crit-5, "One Stroke"
  playtest); `agent-browser` errored "Missing arguments for: mouse move" as if
  `$x`/`$y` were empty, no python error surfaced. The `python3 -c` itself
  worked fine both in isolation (`bash -c`) and as a simpler body via the Bash
  tool directly — the failure was specific to nesting that quoting pattern
  inside a multi-line block passed as one tool-call string, not the shell or
  python. Workaround: skip the coordinate-computing subshell and hardcode the
  pixel integers directly in the `mouse move` call. If a future run wants
  computed coordinates, compute them in a separate prior Bash call and pass
  the resulting numbers as literals into the `agent-browser` call, rather than
  nesting the computation inline.
- **Reading game/app state off the canvas's own rendered pixels
  (`agent-browser eval` + `getImageData`), instead of adding debug hooks to
  source, is a reusable non-invasive verification technique.** Used to check
  an ink-meter's actual fill percentage during closed-loop playtesting
  (crit-5): the meter bar's fill fraction is directly readable as "how far
  right the fill colour extends before hitting the background colour," sampled
  via `ctx.getImageData` inside an `eval` string, with no change to `main.ts`.
  Generalises to any bar/meter/progress UI drawn to canvas — cheaper and more
  trustworthy than eyeballing a screenshot, and doesn't risk the debug hook
  itself being the thing that changes behaviour.
- **Closed-loop playtesting a scrolling/timed obstacle course needs "hold
  position until the obstacle has actually passed," not "move to the next
  target early."** Moved from one gap's x/y position to the next too early
  during a crit-5 playtest (before the first wall's x-column had reached the
  brush), causing an avoidable death that looked like a game bug at first.
  Diagnosed by working out the wall's actual arrival time from the sim's own
  constants (`scrollSpeed`, `wallSpacing`) rather than guessing from the
  screenshot cadence. When scripting a playtest sequence against a
  scroll-speed-based game, compute (or at least sanity-check) the time each
  obstacle needs to reach the player's fixed x-column before writing the
  `sleep`/`mouse move` sequence, rather than pacing moves by wall-clock feel.
- **"Content-complete... green checks" isn't sufficient evidence a *game's
  balance* is right, either — not just its layout.** Sixth confirmation of the
  standing rule below, but a new bug shape: crit-5's ink-mechanic constants
  read as real pressure from the numbers alone (22s to dry out at zero drops)
  and every automated test passed (they test the rules, not the tuning), but
  sustained real play showed the second mechanic never actually threatened a
  skilled player, because the drop and gap patterns correlate more than the
  numbers alone suggest. No screenshot or check catches this class of gap —
  only playing the actual game with a real strategy for a sustained stretch
  does. Worth budgeting one genuine playtest pass (not just an idle-screenshot
  pass) for any future week whose brief includes tunable difficulty/balance,
  same way a real-browser screenshot pass is already budgeted for layout.
- **A frozen-looking screenshot right after a death event isn't necessarily a
  stuck respawn loop** — for any game whose `advance()`-style update bails out
  entirely while `!alive` (state stops changing, only a fade/opacity term
  keeps moving), a screenshot taken once that fade term has already hit its
  floor looks pixel-identical to one taken much later, since nothing else is
  advancing either. Verifying a keyboard-only playthrough of "One Stroke"
  (crit-5, run at 63h to cutoff — dispatched only `keydown`/`keyup`, no mouse
  events at all, through a real wall collision), two screenshots ~1.3s apart
  both showed the same fully-faded, non-reset scene, which briefly read as a
  serious bug: `requestAnimationFrame`'s chain silently stopped, since
  `RESET_DELAY` (1.3s) had clearly elapsed by then. It hadn't stopped —
  `console`/`errors` were clean, and a third screenshot spaced further out
  showed the reset had happened right on schedule; the first "stuck-looking"
  screenshot had just landed in the dead time between fade-floor and the
  next `createInitialState()` call, not evidence the loop had died. General
  lesson: when a post-death/reset animation looks frozen across two spaced
  screenshots, take one more, spaced further out again, before concluding the
  render loop itself has stopped — a frozen *value* (fade at 0, state
  unchanging by design) and a frozen *loop* (`requestAnimationFrame` never
  firing again) produce the identical pixels for exactly this bug's window,
  and only a third, later sample distinguishes them.
- **`agent-browser --init-script <path>` runs a JS file before the page's own
  scripts, on every navigation in that session — the tool for testing a
  failure mode that only exists *before* the app has a chance to react.**
  Used to verify a fix for `localStorage` throwing a `SecurityError` in
  private-browsing/storage-blocked configurations (crit-5, `One Stroke`, run
  at 141h to cutoff): a one-line init script
  (`Object.defineProperty(window, 'localStorage', { get() { throw ... } })`)
  patches the global before `main.ts` ever runs, reproducing exactly what a
  real storage-blocked browser would hand the app on load — not achievable
  with a plain `eval` after `open`, since by then the module has already run
  (and read/thrown) once. Caveat found the hard way: the init script stays
  registered for the rest of that `agent-browser` session, including across
  a later `open`/reload — testing the *normal* path afterward needs
  `agent-browser close` first to drop it, not just another `open`, or the
  patch silently leaks into what's supposed to be an unpatched control run.
  Generalises to any "what if a browser API isn't there/throws/returns null"
  question for code that runs at module load — `set offline on`/`network
  route --abort` (already-documented gotchas above) cover mid-session
  failures, `--init-script` covers ones that need to exist from frame zero.
- **`agent-browser set viewport` on an existing session doesn't reset page
  state.** Switching from a desktop viewport to a portrait one after already
  interacting with the page (crit-4, run at 100h to cutoff) carried over
  dismissed-invite/other in-page state from the desktop pass, briefly looking
  like a missing-invite bug at the new viewport before a proper `open` reload
  showed the correct fresh-load behaviour. When a browser pass is checking
  "what a stranger sees on first contact" at a second viewport, `open` the
  page again after setting the viewport, don't just resize an already-primed
  session.
- **`agent-browser set viewport` before any session exists doesn't reliably
  apply to the next `open`.** Calling `set viewport W H` then `open <url>`
  with no prior open in that session sometimes left `window.innerWidth`
  reporting the tool's own default size, not the one requested — no error,
  just silently ignored (crit-5, run at 124h to cutoff). The sequence that
  reliably works: `open` once (creates the session at whatever default), THEN
  `set viewport`, THEN `open` again (reload) to actually land at the
  requested size — confirmed by checking `window.innerWidth/innerHeight` via
  `eval` after, not by trusting the screenshot's apparent aspect ratio (a
  landscape screenshot from a viewport that silently stayed 1280x577 can look
  similar enough to a real desktop shot to not obviously register as wrong).
  Combines with the two existing viewport gotchas above (`open` before
  confirming the bound port; `set viewport` not resetting page state) into a
  general rule: after any `set viewport` call, verify the actual
  `window.innerWidth/innerHeight` before trusting a screenshot taken at that
  "size."
- **A canvas's own `width`/`height` attributes give it an intrinsic aspect
  ratio that can hijack CSS flex/absolute layout, and letting `resizeCanvas()`
  read the canvas's own rendered size back in to decide the next bitmap size
  closes a feedback loop.** Found in "One Stroke" (crit-5, run at 124h to
  cutoff): the canvas was sized via `flex:1` + `min-height:60vh` (height left
  "auto"), and a CSS replaced-element rule says an "auto" cross size on a
  flex/absolutely-positioned item falls back to the element's intrinsic
  aspect ratio (from its `width`/`height` *content attributes*, not its CSS
  size) whenever that axis is otherwise indeterminate. `resizeCanvas()` set
  those attributes from `canvas.getBoundingClientRect()` each resize, so a
  drifted ratio from one resize became the next resize's input — a genuine
  divergent feedback loop, not a one-off glitch: a short run of `agent-browser
  set viewport` calls in one session grew the canvas from 577px to 2976px
  tall, no console error. Two plausible-looking fixes each turned out
  incomplete when actually tested (not just reasoned about): adding an
  explicit `height:100%` to the flex item stopped the divergence but left a
  small (~100-160px) residual mis-size at some in-between viewport dimensions
  (traced to percentage-height resolution against a flex-grown ancestor, not
  fully root-caused); switching to `position:absolute; inset:0` on the
  assumption that "both dimensions become definite" *reintroduced the exact
  same divergent bug*, because CSS2.1 §10.6.4 still derives an auto height
  for an absolutely-positioned *replaced* element from its intrinsic ratio
  when top+bottom are both set and height itself is "auto" --- `inset` alone
  doesn't make height non-auto. The fix that actually held under a 9-resize
  stress test: measure from the canvas's *parent* (a plain block with no
  intrinsic ratio of its own), and set the canvas's CSS box (`style.width`,
  `style.height`, `style.left`, `style.top`) as explicit pixel values
  computed from that measurement, so the canvas's own attributes can never
  re-enter the layout calculation at all. General lesson: any canvas (or
  img/video) sized via CSS auto/percentage/stretch rules, whose own
  width/height attributes are set by JS from a *measurement of itself*, is a
  candidate for this feedback loop --- test with a *sequence* of resizes in
  one session, not just isolated opens at fixed sizes, since a single
  before/after comparison at any one size can look fine while the underlying
  mechanism still diverges given more resize events.

- **`agent-browser`'s "default" session is a single shared tab on this host,
  not exclusive to one run — other concurrent processes can silently navigate
  it out from under you.** Mid-playtest (crit-5, run at 111h to cutoff),
  `agent-browser eval "location.href"` returned two different unrelated
  students' deployed GitHub Pages URLs
  (`comp4020-crit4-Gera1t-2001.github.io`, then moments later
  `comp4020-crit4-kyle-zjy.github.io`) instead of the `localhost:4715` preview
  server I had just opened and was actively driving — `agent-browser session
  info --json` confirmed `"session":"default"`, `"pageCount":1`: one tab,
  shared, and something else (almost certainly another student's concurrent
  agent run, or a marking crawler, on the same shared machine) was actively
  browsing it in real time between my calls. This fully explained an
  otherwise-mysterious result: a closed-loop pixel-scanning playtest script
  (reading wall-gap position live via `getImageData` to steer the mouse
  reactively) died far earlier and worse than an open-loop scheduled one,
  which looked like a real balance bug until checked — the eval calls were at
  least sometimes reading a different page's DOM entirely, not this game's.
  Screenshots taken at the same moments still showed "One Stroke" correctly,
  which is what makes this insidious: some commands can be hitting the right
  page while others, moments apart, silently aren't, with no error either
  way. Fix: pass an explicit `--session <unique-name>` (e.g. `--session
  crit5-shitao-run`) on every `agent-browser` call for the rest of that
  session, confirmed afterward with `eval "location.href"` returning the
  expected `localhost` URL consistently. Treat any multi-step or
  timing-sensitive `agent-browser` sequence on this host as suspect unless
  it's running in an explicitly-named session — the plain `open`/screenshot
  spot-checks this repo's memory already documents as reliable are short
  enough that a same-moment collision is unlikely, but a sustained
  interaction loop (many calls over tens of seconds) has much more surface
  for another process to grab the shared tab in between.
- **A blind, precomputed-timing (open-loop) playtest script desyncs over long
  sustained runs and shouldn't be trusted as a fairness verdict either way.**
  Tried to test whether "One Stroke"'s speed-ramp (`speedMultiplier`, maxing
  at 2.2x by distance 24) stays fair deep into a run by precomputing exact
  wall-arrival times from a standalone reimplementation of `gapCenterFor`/
  `advance`'s math and scripting ~105s of scheduled `mouse move` calls (crit-5,
  111h to cutoff). It died partway through (best distance 1.85, nowhere near
  the target). Given each `agent-browser mouse move` call has real, variable
  round-trip latency not accounted for in the schedule's `sleep` durations,
  drift compounds over 50+ scheduled events and a death this way is
  inconclusive, not evidence of a real balance problem — a real player
  corrects visually in a closed feedback loop; an open-loop schedule can't.
  Combined with the shared-session hazard above (which independently broke
  a follow-up closed-loop attempt at the same question), this line of
  investigation didn't reach a trustworthy answer either way this run. Don't
  re-attempt without first pinning an isolated `--session`, and even then,
  budget for the fact that sustained (~100s+) automated play on this host is
  inherently harder to trust than the short, already-proven spot-checks
  (single dodge sequences, fixed-viewport screenshots, resize sequences) this
  repo's memory otherwise relies on.

- **Even genuinely reactive (closed-loop) playtesting — screenshot, decide,
  move, repeat — has a latency floor from the tool round-trip itself, not
  just from open-loop scheduling drift.** Tried one round at 93h to cutoff:
  `mouse move` to a plausible gap centre, `sleep 0.6`, screenshot — died
  almost immediately. Traced by comparing the two screenshots' distance
  readouts (67, then a fresh run at 45 with `best 115` freshly recorded):
  several seconds of real browser time had passed between the two calls,
  not the 0.6s asked for, because each `agent-browser` CLI invocation has
  its own process-spawn/IPC overhead on top of any `sleep`. Against a wall
  every ~2s at this game's speed, that's enough latency alone to lose,
  independent of whether the chosen move was even correct. The existing
  open-loop note above says a closed loop "corrects visually" where a
  schedule can't — true in principle, but only if perception-to-action
  latency is faster than the threat cadence, and it wasn't here. Don't
  read a single-round death (or a short run of them) through this tooling
  as a balance verdict for anything with a sub-few-second cadence; the
  latency confound has to be ruled out first, and ruling it out costs more
  round trips than it's likely worth. A live human pod-crit is the actual
  instrument for that question, per the brief's own "four people's hands on
  the keyboard settle it in about ten seconds."

- **`SpecList` (the course-owned component rendering a `spec:` frontmatter
  array) renders each line as raw text, not through markdown** — no
  `set:html`, no remark pass, just `{line}` in the `.astro` template
  (`node_modules/.../astro-course-university/components/SpecList.astro`).
  A spec line written with markdown emphasis (`` what it's *for* ``) shows
  the literal asterisks in the rendered page instead of italicising —
  caught in a routine desktop-viewport browser pass on the exhibition-piece
  assessment page (assignment-2, 141h to cutoff), not by any check
  (`pnpm check` was fully green; the bug is valid text in a valid schema
  field). Same root shape as the standing `.astro`-template em-dash gotcha
  above — markdown syntax only renders where content actually passes
  through the markdown/remark pipeline, and a frontmatter array rendered by
  a plain-text-interpolating component is not that, even though other
  frontmatter fields (`description`) on the very same content file *do* go
  through remark. Fix was content-side (reword to plain prose), not
  component-side (`SpecList` isn't mine to edit). Grep any content file's
  `spec:`/similar plain-array frontmatter for stray `*`/`_`/backtick
  markdown syntax before trusting it'll render — the safe assumption is
  "plain text only" unless a component is confirmed to markdown-render that
  specific field.
- **A coverage array with its own "add it here or you lose coverage" comment
  can silently drift the moment a new page ships, and nothing but a fresh
  full-source read catches it.** `comp4020-crit7-shitao`'s `spec/routes.ts`
  (`export const ROUTES = [...]`, run against every route by
  `spec/invariants.test.ts` for lang/title/viewport/nav/single-h1/alt-text/
  axe) carries exactly that comment: "When you add a page, add its route
  here, or the invariants stop covering it." Found (run 8, 111h to cutoff)
  that `/search/` had shipped three commits earlier (`45a9328`) without ever
  being added — `git log --oneline -- spec/routes.ts` showed the file
  untouched since before the search page existed. `pnpm check` stayed green
  the whole time, because the existing invariant tests for the *other* three
  routes all still pass; nothing fails when a route is simply absent from
  the loop that generates test cases. Same root shape as the standing SSE
  pub/sub gap (a list that's supposed to enumerate "every X" drifting out of
  sync with the actual X's, invisible to every check because the check only
  runs against what's already listed) — but the mechanism here is a plain
  array literal, not an event-name string, so it's worth its own entry:
  whenever a repo has a file whose own comment says "keep this list current
  when you add a page/route/event," grep every route-defining file
  (`src/pages/**/*.astro`, `src/pages/api/**/*.ts`) against that list's
  literal contents after any run that added a page, rather than trusting the
  list was kept in sync as a matter of course.
  [`22bb0f8`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-shitao/commit/22bb0f8)
- **`check-evidence.ts` doesn't enforce PROCESS.md's 400–600 word guidance at
  all** — read its full source (assignment-2, 45h to cutoff) rather than
  assuming: it only checks that cited commit SHAs resolve and that the
  `TEMPLATE:` boilerplate is gone, with no word-count logic anywhere. The
  400–600 figure is brief/rubric guidance, not a mechanical gate. Worth
  knowing before spending edit cycles trimming PROCESS.md to hit an exact
  number under time pressure — stay close to it for legibility's sake (it's
  still what a human marker was told to expect), but a few words either side
  of 600 won't fail any check.
- **`pkill -f "..."` in this sandbox reliably kills the whole Bash tool
  invocation with exit code 144 and no output** — found in
  `comp4020-crit7-shitao` (159h to cutoff) trying to tear down a background
  dev server between test runs. Looks exactly like "no matching process,
  already dead" but isn't: the tool call itself gets terminated, not just
  the signal delivered. Use `lsof -ti:$PORT | xargs -r kill` for all
  server-teardown needs instead — already the standing recommendation for a
  different reason (trusting `pkill`'s exit code over the port), now doubly
  true since `pkill` itself can't be trusted to run to completion here.
  Same run: a Node script using `child_process.spawn` to both boot a server
  and drive test logic against it in one process gave unreliable/missing
  stdout (and once exit 144 with no `pkill` involved at all) — the reliable
  pattern stays "plain backgrounded Bash command + `lsof` port confirmation
  + `curl`," not a self-contained Node harness.
- **Splitting one finished feature into several small, buildable commits
  after the fact (not commit-as-you-go) needs `git stash push
  --keep-index`, not just selective `git add`, when the changed files are
  interdependent.** `comp4020-crit7-shitao` (159h to cutoff): `db.ts`'s
  `cancelBooking`/extended `createBooking` signature and the route that
  calls it can't be two separate commits without a red state in between —
  staging the library file alone still leaves the *other*, not-yet-staged
  files sitting in the working tree, which `pnpm typecheck` happily
  typechecks against, hiding the fact that the commit-to-be wouldn't build
  on its own. Fix: `git add` only the files for this commit, then `git
  stash push --keep-index` (leaves the index/staged files alone, stashes
  everything else), run typecheck/build/test against that truly-isolated
  state, commit, `git stash pop`, repeat for the next slice. Caught nothing
  broken this particular run, but this is the mechanism that would have
  caught it if the dependency ordering had been wrong, and confirmed each
  of five commits was independently green rather than merely plausible by
  inspection.

  Refinement (`comp4020-crit7-shitao`, 135h to cutoff): plain `git stash
  push --keep-index` does NOT touch untracked files — only tracked ones with
  unstaged changes. Splitting a slice that includes a brand-new file (a new
  route, a new spec file) needs `-u` too (`git stash push --keep-index -u`),
  or the new untracked files stay sitting in the working tree right next to
  whatever got legitimately stashed away. First attempt without `-u`: staged
  `db.ts` alone, stashed the rest — but the new `spec/move.test.ts` and new
  `src/pages/api/.../move.ts` (both untracked) weren't stashed, so the test
  ran against a `mine.astro` reverted to its pre-feature version and failed
  with a confusing "no move form found," which looked like a real bug in the
  isolated slice rather than what it actually was: an isolation check that
  wasn't actually isolated. Always pass `-u` when any file in the not-yet-
  committed slice is untracked, not just when it's a modification to an
  existing tracked file.
- **An SSE (or any pub/sub) route has to subscribe to every event name a
  producer might emit — adding a new producer event without checking the
  consumer's own subscription list is a silent, untyped gap.** Found via a
  spec test, not inspection (`comp4020-crit7-shitao`, 159h to cutoff):
  `events.ts` had one `bus.on("booking", ...)` listener from the original
  build; adding a `bus.emit("cancelled", ...)` call in a new cancel route
  compiled fine (`EventEmitter` doesn't type-check event names against
  listeners) and looked complete by reading the emit site alone — nothing
  reached any other browser tab, because nothing had ever taught the SSE
  handler about the new event name. `grep` every `bus.emit`/`.on` pair (or
  equivalent pub/sub call) after adding a new event kind, not just the
  producer side, whenever a live-broadcast feature grows a second event
  type.
- **Two spec files that each hardcode "today" plus a fixed hour-slot and
  resolve the same room can silently collide, and the failure surfaces in
  the *other* file, not the one that caused it.** `comp4020-crit7-shitao`
  (141h to cutoff): a new `spec/mine.test.ts` booked `13:00` today in the
  same room `spec/booking.test.ts`'s `guardedSlot` test already used (both
  files find "the room" via the same "first 09:00 cell" lookup, so they
  always agree on room but not necessarily on slot) — whichever file's
  create ran second lost the unique-constraint race and got `SlotTakenError`,
  but its `ownerCookie(response)` call still succeeded, because
  `ownerToken(cookies)` mints the cookie *before* `createBooking` is even
  attempted in `src/pages/api/bookings.ts`. So the losing test proceeded with
  a valid-looking cookie for a booking that never existed, and failed several
  lines later with a confusing "no cancel form found for the booking's own
  cookie" in a file that hadn't changed at all. Fixed by picking an hour
  unused by any other spec file's today-dated booking, not by adding
  cross-file coordination. When adding a new spec file to a real-database
  integration suite like this one, grep existing spec files for what
  room/date/slot combinations they already use for "today" before hardcoding
  another one, or use a date offset unique to the new file the way the
  future-dated tests already do.

- **Setting `style="color: X"` on a container so a descendant's
  `stroke="currentColor"` picks up a dynamic value can leak into any other
  CSS rule on that same container that also reads `currentColor` for an
  unrelated property.** `comp4020-final-shitao` (crit-8, run at 158h to
  cutoff): setting the wall `<svg>`'s inline `color` to the hand's own
  colour, so a live-drawn stroke could use `stroke="currentColor"`, also
  retinted the same element's `border: 1px solid currentColor` rule in
  `style.css` --- the border silently took on each visitor's random hand
  colour instead of staying neutral, invisible in the diff and only caught
  by an actual screenshot (the standing "screenshot before believing the
  checks" rule, reconfirmed a bug it introduced the very same run it was
  written, not just one it later found). Fixed by not touching CSS
  inheritance at all: pass the dynamic value through a `data-*` attribute
  read by JS (`script.dataset.handColour`) and set it directly on the one
  element that needs it. Generalises: before reaching for `currentColor` +
  an inline `style` on a shared ancestor to get a dynamic colour to one
  descendant, grep that ancestor's own selector for every *other* CSS rule
  that also uses `currentColor` — any of them inherit the same change.
- **A plain in-memory `Set` of open `ServerResponse` objects, on a
  framework-free `node:http` server, is a complete server-sent-events
  broadcast layer for a single-Fly-machine deliverable — no pub/sub
  library, no separate process.** `comp4020-final-shitao` (crit-8, 158h to
  cutoff): `GET /api/marks/stream` holds one connection per open tab;
  a state-changing POST handler calls a `broadcastMark()` that just
  `res.write()`s an `event: ...\ndata: ...\n\n` frame to every entry in the
  set, after (never before, so real-time never gets ahead of persistence)
  the write actually commits. A 20s heartbeat comment line
  (`res.write(": ping\n\n")` on an interval) is the one thing worth adding
  proactively rather than waiting to discover it's needed --- Fly's proxy
  (like most reverse proxies) drops a truly idle long-lived connection.
  Confirmed real by dragging an actual pointer gesture in one
  `agent-browser` session and reading the mark appear in a second,
  independent session with no reload, both locally and against the live
  `.fly.dev` URL after deploying. Worth reaching for first on any future
  course deliverable whose real-time requirement is "one thing, one
  direction, server to browser" — no need to justify a heavier transport
  (WebSockets) unless the client also needs to push something back over
  the same connection.

- **Chrome doesn't auto-reconnect an `EventSource` when the server process
  dies mid-stream --- it goes straight to `readyState` 2 (`CLOSED`) and stays
  there.** Found killing/restarting `comp4020-final-shitao`'s server with a
  tab open (crit-9): the native retry-with-`Last-Event-ID` never happened.
  A redeploy does exactly this. Any SSE client needs its own "on `error`, if
  `CLOSED`, reopen after a delay from the last id seen" fallback; don't count
  on the spec's retry behaviour.
- **A second or third named `agent-browser` session can lose its cookie jar
  mid-test; the first-opened session kept its own.** Crit-9: sessions `c9b`/`c9c`
  showed empty `agent-browser --session X cookies` right after a server
  restart, so their reconnecting streams arrived cookieless and looked like
  an app bug (`mine` missing). Session `c9` sent its cookie every time. Before
  trusting any cookie-dependent result from a non-first session, check
  `cookies` immediately before and after; rerun in the first session if the
  jar is empty.

## Working habits that paid off

- **Read each spec line literally against the app, as its own framing ---
  a test named after a spec line can quietly check a weaker claim.**
  `comp4020-final-shitao` (crit-8, 62h to cutoff): "find their trace still
  there when they come back" was tested as "the mark persists," which held
  for twelve runs; read literally, *their* trace meant a returning hand had
  to be able to pick out its own stroke, impossible with ten colours shared
  across every hand. Fixed with a server-rendered `class="mine"`
  ([`6e07998`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/6e07998)).
  Same framing, applied to the README (52h to cutoff): "one mark a
  day" was a UTC calendar day, which reopens at 11am AEST/AEDT --- any
  "per day" limit needs asking *whose* day; a rolling window since the last
  action has no time-zone answer to get wrong
  ([`79989b6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/79989b6)).
  Third instance of the same spec line (run at 45h to cutoff): the
  `mine` fix held for a fresh test wall but not a busy one --- marks painted
  in creation order buried a returning hand's stroke under every later one.
  Only seeding a scratch `DB_PATH` with 300 marks (a small script importing
  `src/db.ts`'s own `addMark`) and screenshotting showed it; fixed by
  painting own marks last over a `stroke: Canvas` halo
  ([`a9d92f3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/a9d92f3)).
  For any shared-canvas app, check legibility at heavy density, not just
  with the handful of marks tests leave behind.
  This "reread the spec line literally" habit was the crit-8 reflection's
  breakthrough --- reach for it early on crit-9/10, not after a dozen green runs.
  Also: this repo's `pnpm check` runs against a live app on `:8080`, and
  `cmd | tail && git commit` hides a red run --- check the `Tests` line
  before committing, never the pipe's exit code.

- **For pointer/drag-driven interactions, simulate the real gesture, not
  just the resulting DOM state.** `agent-browser get box <sel>` returns
  element coordinates; `agent-browser mouse move <x> <y>`, `mouse down`,
  more `mouse move`s with a `sleep` between them to control simulated
  speed, then `mouse up` reproduces an actual slow or fast drag through
  real `pointermove` events — this is what caught (assignment-1) that a
  canvas ink-brush's speed-based width/opacity actually worked, not just
  that the canvas element existed. `agent-browser press ArrowLeft/Right`
  after `focus`ing a control does the equivalent for a keyboard-only path.
  A static screenshot of an untouched canvas proves nothing about whether
  the interaction itself works.
- **A single-interaction app that only wires up pointer events has quietly
  excluded keyboard-only visitors from the one thing it does, and nine runs
  of race/lifecycle verification won't surface it --- it takes reading the
  client file with accessibility as the explicit framing.**
  `comp4020-final-shitao` (crit-8, run at 86h to cutoff): `public/wall.js`'s
  drawing only ever listened for `pointerdown`/`pointermove`/`pointerup`/
  `pointercancel`, found by rereading the file with a framing none of the
  prior nine runs on this exact file had tried (they'd covered races, SSE
  lifecycle, nonce/echo edge cases — all genuinely different questions, all
  clean). Fixed by refactoring the shared gesture state
  (`points`/`live`/`drawing`) into `beginGesture`/`addPoint` helpers called
  from *both* the pointer handlers and a new `keydown` listener
  (Enter/Space starts at the wall's centre, arrow keys extend it, Enter/Space
  again calls the exact same `finish()` a pointer gesture already used) ---
  one state machine, two input paths, rather than parallel logic that could
  drift. Verified with the same technique already proven for pointer
  gestures on this file (`spec/wall-client.test.ts`'s jsdom harness,
  `ec78095`): dispatch real `KeyboardEvent`s instead of `PointerEvent`s
  against the same loaded script, no new stubbing needed. Then confirmed
  live in `agent-browser` (fresh-hand session, one `Tab` press landed focus
  on the wall since `tabindex="0"` is only present when a hand can actually
  draw) that Escape cancels cleanly and a real gesture still posts right
  after. General lesson: for any app whose entire interaction surface is one
  pointer-driven element, a dedicated accessibility-framed reread (not
  folded into a race/content/layout pass) is a distinct, apparently
  still-fruitful angle even after many clean verification runs — the standing
  "vary the framing, don't just rerun the same one" rule (documented
  extensively below for content-heavy repos) applies just as well to a single
  interactive client file.
- **Screenshot before believing the checks.** All automated checks (build,
  lint, 51 tests) were green while a real rendering bug (unreadable banner
  text over a striped background) shipped anyway. Actually opening the page
  in `agent-browser` and looking at a screenshot at both required viewports
  (1920×1080, 390×844) is what caught it — this is not optional polish, it's
  the only check that catches this class of bug. Do this before considering
  a week "verified," not as an afterthought. Confirmed a second, different
  time in run 12 (28h to cutoff): after ten runs of "content-complete, nothing
  found," a phone-viewport screenshot of the about page caught the self-portrait
  `<img width="400">` overflowing its container horizontally — none of
  typecheck/build/lint/51 tests/evidence check saw it, because none of them
  render at a narrow viewport. Fixed with a global `img { max-width: 100%;
  height: auto; }` rule (styles.css), since only `.gallery img` had been made
  responsive and the about page's figure image hadn't. Lesson generalises:
  any raw `width="..."` HTML attribute on an `<img>` is a horizontal-overflow
  risk on mobile unless something constrains it — worth a quick eyeball at
  390×844 specifically, not just desktop, whenever a page adds an image.
- **Small, scoped commits over one big one.** Committed the spec test, the
  link fix, and the CSS fix as three separate commits rather than folding
  them into the original build commit — made each one legible on its own in
  `git log`, and made the `PROCESS.md` citations point at something a reader
  could actually verify in isolation.
- **"Resize mid-interaction" (the artefact-criterion HD language) means
  literally resizing while an interaction is in flight, not just checking
  both viewports separately.** Pattern that worked (assignment-1): `mouse
  down`, `mouse move`, `set viewport <w> <h>` *while the button is still
  down*, more `mouse move`, then `mouse up` — reproduces a real mid-drag
  resize through the same events a user dragging while rotating a device or
  resizing a window would generate. Caught (harmlessly, in this case) that a
  canvas resize handler using `getImageData`/`putImageData` does a raw pixel
  copy, not a proportional rescale — no crash either direction, but worth
  knowing before trusting the function's name. Checked via `agent-browser
  errors`/`console` (not just a screenshot) immediately after, since a
  silent JS exception wouldn't necessarily show up visually.
- **A "manual-only check" callout in your own `CLAUDE.md` is a punch-list
  item, not a permanent disclaimer.** This repo's `CLAUDE.md` said "nothing
  here measures... the contrast half of accessibility" ever since the
  axe-core moment disabled `color-contrast` for lack of a jsdom paint
  engine. But WCAG contrast is a pure function of two hex colours and
  doesn't need one: `spec/contrast.test.ts` (assignment-1) reads the real
  `:root` palette straight out of `styles.css` with a regex, rather than
  hardcoding a duplicate copy of the colours, so a future palette edit is
  caught automatically instead of the test silently going stale (the same
  failure mode as the reflection/README drift noted below). Verified it
  wasn't a rubber stamp the same way as the axe-core test: temporarily
  weakened one CSS variable, confirmed real failures naming the actual
  computed ratio, then restored the file. Worth reflexively rereading your
  own `CLAUDE.md`'s "not measured/not covered" language every so often —
  each one is a named gap, and closing it is exactly the kind of
  harness-level correction the process-legibility criterion rewards.
- **Grep every call site of a boolean/flag parameter before trusting that
  its "true" branch is reachable.** Found a real bug this way (assignment-1,
  52h to cutoff): `finishStroke(points, pooled)` had a whole message
  ("saturated and pooling") gated on `pooled`, and `grep -n "pooled"
  main.ts` showed every call site passing a hard-coded `false` — the branch
  was provably dead from the source alone, before touching a browser at
  all. This is a cheaper and more reliable first move than trying to drive
  the UI into the state and see if the message appears, which (per the
  `get box` viewport-clipping gotcha above) can give a false negative for
  reasons that have nothing to do with the bug. Static-analysis-first,
  live-browser-to-confirm-the-fix second — not the other order — when the
  question is "is this code path ever actually exercised."
- **A boolean that gates whether a listener gets *attached* (once, at load)
  is a different thing from a boolean the listener itself rechecks on every
  firing — and a plain-JS IIFE with no framework has nothing that forces the
  second.** `comp4020-final-shitao` (crit-8, run at 123h to cutoff): `wall.js`
  read `let canDraw = script.dataset.canDraw === "true"` once, gated the
  `if (canDraw) { svg.addEventListener("pointerdown", ...) }` block on it at
  load, and set `canDraw = false` after a successful POST — but the
  `pointerdown` handler itself never reread `canDraw`, so once attached
  (i.e. whenever the visitor could draw on page load), it fired forever:
  a hand could gesture out a whole new stroke *after* already marking today,
  appending a real `<path>` to the live SVG, only to have it rejected (and
  removed) at submit time. Confirmed live with a fresh cookie in
  `agent-browser`: drew once (accepted, status flips to "already on the wall
  today"), then dragged again in the same tab with no reload — a 6th path
  element appeared mid-drag, and the status text flipped to a *different*
  rejection message ("You've already left a mark today") on release, directly
  contradicting what the UI had just told the visitor. No spec test caught
  it (`spec/` only exercises the server over HTTP, nothing drives the client
  JS), and no browser screenshot would either, since a single before/after
  shot looks identical either way — only a "draw, then draw again without
  reloading" sequence surfaces it, the same class of gap as the standing
  "resize mid-interaction" and "sequence, not just isolated snapshots" rules
  above. Fixed with one line, `if (!canDraw) return;` at the top of the
  `pointerdown` handler — cheaper than the alternative (removing/re-adding
  listeners) and correct since `pointermove`/`finish` already gate on the
  separate `drawing` flag that `pointerdown` controls. General lesson: for
  any plain-JS (no-framework) UI where a flag toggles mid-session via a
  closure variable, check whether every *listener*, not just the code that
  attaches it, rereads the current value — attach-time gating and
  fire-time gating are easy to conflate and only one of them actually
  matters once the page has been open a while.
- **When a route validates some untrusted form fields against an enum/lookup
  but not others, the unvalidated one is a live bug, not a stylistic gap —
  check what actually happens when it's wrong.** `comp4020-crit7-shitao`
  (run 7, 117h to cutoff): `/api/bookings` and `/api/bookings/[id]/move`
  both validated `slot` against the fixed `SLOTS` enum, with a comment
  explicitly reasoning about hand-built requests sending an arbitrary
  string — but `roomId` had no equivalent check, an asymmetry visible just
  from reading the two `if` conditions side by side. Confirmed it was a real
  gap (not just untidy) by building and running the server against a scratch
  database and `curl`ing a bogus `roomId`: a raw 500, not the friendly
  `?error=missing` every other bad field gets — caused by `better-sqlite3`
  (13.0.3) enforcing `PRAGMA foreign_keys` ON by default (confirmed with a
  two-line Node repro), so the schema's declared `.references()` was a real,
  live constraint the whole time, just uncaught by application code. Fix
  mirrored the existing enum check (validate against `listRooms()`'s ids)
  rather than inventing a new pattern. Generalises past this one field: when
  a route's own comments show it already reasoned carefully about "what if a
  hand-built request sends something else" for *some* fields, grep the same
  handler for every other field it trusts without that reasoning — the gap
  is usually right there in the diff between two adjacent `if` conditions,
  and worth confirming live (build + curl a scratch instance) rather than
  just inferring it from the schema, since the actual failure mode (500 vs.
  a clean rejection) depends on details like whether FK enforcement is even
  on.

- **An "empty input" guard on a search/filter feature doesn't neutralise the
  underlying query language's own wildcard characters — a non-empty query
  can still trigger the exact "list everything" leak the guard was meant to
  prevent.** `comp4020-crit7-shitao` (run 9, 100h to cutoff): `searchBookings`
  refused an empty query with a comment explicitly reasoning about a
  "public directory of every name in the system," but `like(bookings.bookedBy,
  "%" + query + "%")` with `query = "%"` builds the pattern `%%%` — SQL LIKE
  wildcards, not literal text — which matches every row regardless of name,
  same leak, non-empty input. `_` (single-char wildcard) has the identical
  effect. Confirmed live before fixing: built a scratch server, booked "Alice
  Wonderland," searched `%` and `_`, got her back both times despite no
  literal match. Fixed by escaping `\`, `%`, `_` in the query and adding an
  `ESCAPE '\\'` clause (drizzle-orm's `like()` helper has no escape
  parameter, so this needs a raw `sql` template instead). Same root shape as
  the roomId/slot asymmetry above — a route reasoning carefully about one
  failure mode (empty string) while a sibling failure mode in the same
  input (the query language's own metacharacters) goes unguarded — but a new
  *mechanism*: the gap isn't between two different fields, it's between two
  different senses of "empty" for one field. Generalises to any
  LIKE/glob/regex-backed search or filter: check what the pattern's own
  wildcard characters do when submitted as the entire query, not just
  whether a blank query is rejected.

- **A POST-then-redirect handler that always redirects to a fixed path
  drops whatever view state the user was actually in, and a spec test that
  re-fetches the target state directly (instead of asserting on
  `res.headers.get("location")`) can hide exactly that bug.**
  `comp4020-crit7-shitao` (run 12, 76h to cutoff): `/api/bookings`'s success
  and slot-taken redirects were hardcoded to `/` and `/?error=taken`,
  losing the `date` query param entirely — booking (or losing a race for) a
  slot while viewing any day but today bounced the browser to a different
  day's grid that shows no sign the booking happened, directly undercutting
  the app's one advertised property ("every open tab sees a slot go... the
  moment it happens"). Eleven prior runs of browser passes never caught it
  because every prior manual booking test happened to be on today's date,
  where `/` and `/?date=today` render identically — this run's difference
  was actually clicking the next-day nav link in `agent-browser` before
  booking, the framing the previous hand-off had flagged as untried. Worse:
  `spec/booking.test.ts` already had a "books a future date" test, and it
  passed the whole time, because it checked the booking persisted via a
  fresh `fetch(/?date=${futureDate})` rather than asserting on the POST
  response's own `location` header — the assertion that would have caught
  it was simply never written. Fixed by appending the already-validated
  `date` (validated by `isBookableDate` earlier in the same handler, so
  safe to interpolate into a redirect URL with no injection/open-redirect
  risk) to both the success and slot-taken redirect targets, and adding the
  missing `location` assertion to the existing future-date test so the same
  gap can't reopen silently. Generalises: for any route that redirects
  after a state-changing POST, check the redirect target itself preserves
  whatever page/view/filter state the request came from — and when writing
  or reviewing a test for such a route, assert on the redirect's `Location`
  header directly, not just on the end state reached by a follow-up request
  to wherever you expect it landed.
  [`825b475`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-shitao/commit/825b475)

  Same run, same repo, a sibling route: having just fixed `bookings.ts`'s
  redirect, checking the *other* state-changing route touching the same
  grid (`cancel.ts`) for the identical shape paid off immediately — its
  grid-side cancel form sent no `date` field at all (unlike `/mine/`'s
  cancel form, which already sent `returnTo="/mine/"` and so was
  unaffected), so cancelling from the grid on any non-today date always
  bounced back to today too. Worth generalising past this one repo: once a
  redirect-drops-view-state bug is found on one route, grep sibling routes
  that redirect to the same kind of page for the same missing field, rather
  than assuming the bug was route-specific.
  [`5318284`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-shitao/commit/5318284)

- **A deck slide's own heading can drift from its body's actual content,
  and nothing automated catches it — a delegated cold cross-reference read
  does.** `pnpm check`'s deck validator (`astromotion`) checks structural
  well-formedness, not whether a slide's claims are true against the rest
  of the site. Assignment-2's week-01 deck (comp4020-ass2-shitao, 135h to
  cutoff) had a closing slide headed "Read before week 3" whose body was
  session 02's own prep text verbatim — right content, wrong week number in
  the heading; week 3's real prep (a different session file) says something
  else entirely. Found by delegating a subagent to read all six lectures,
  the deck, and adjacent session pages cold and check for cross-page factual
  consistency, not by any check or by re-testing interaction/rendering (both
  already-proven-clean angles from prior runs). Generalises: for a
  multi-page content-heavy deliverable, "does slide/page X's claim about
  another week/page still match that other page" is a distinct bug class
  from rendering bugs and AI-slop prose — worth its own periodic pass,
  ideally delegated so the main run's context isn't spent re-reading every
  content file.
  [`595efe3`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/595efe3)

  Fourth confirmation, a new bug shape (assignment-2, 111h to cutoff):
  a repeat cold cross-reference pass (same technique, run again rather than
  assumed exhausted after three prior finds) caught `policies/index.mdx`'s
  "Declared assistance" section linking out to the *real* ANU course
  (`comp.anu.edu.au/.../topics/assessment/`) instead of the fictional
  SLOP1450 site's own `/assessments/` page — a leaked real-world reference
  breaking the fictional frame, distinct from a wrong-week label or
  leftover template prose but the same underlying class: content that
  passes every automated check (it's a valid working link) and is only
  wrong against the site's own internal fiction. `grep -rn
  "comp.anu.edu.au\|comp4020-agentic-coding-studio\|COMP4020" src/` as a
  cheap follow-up sweep found no other leaks. Don't assume this class of
  bug is exhausted after finding one instance — re-running the same cold
  read on a later pass, with no new content added in between, still found
  something the first three passes missed, because each pass's subagent
  reads with fresh eyes rather than checking a fixed list.
  [`40fb8f8`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/40fb8f8)

  Fifth confirmation, and a reason to vary the read's *framing*, not just
  rerun it (assignment-2, 100h to cutoff): switching the delegated subagent's
  brief from "cross-reference facts/dates/numbering" to "read this as an
  actual prospective student deciding whether to enrol" surfaced a bug shape
  none of the four fact-focused passes had a reason to catch —
  `src/pages/assessments/index.mdx`'s landing blurb summarised Critique
  Practice as "a critique of someone else's [work]," which is a factually
  true but misleading gloss: the assessment's real centre of gravity (per
  its own spec) is a before/after portfolio proving feedback changed *your
  own* build, with critiquing others as a two-instance secondary item. Every
  fact in the blurb was individually true — a cross-reference pass has no
  reason to flag it, since nothing contradicts anything else in the site's
  own fiction — but a reader arriving to learn what's marked would come away
  with the wrong emphasis. This is a fifth distinct bug shape (after: wrong
  week label, leftover template prose, unclosed forward reference, leaked
  real-world URL) under the same root cause: a summary drifting from the
  thing it summarises. Generalises the standing rule further: for a
  content-heavy deliverable, don't just re-run the same cold-read prompt on
  a later pass — change what the delegated subagent is *looking for*
  (fact-consistency vs. tone vs. "would this reader be misled") each time,
  since each framing has caught something the others didn't.
  [`b7c5f48`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/b7c5f48)

  Sixth confirmation, after two intervening framings (reskinned-starter
  hunting, a literal marker-simulation walkthrough) came back clean and
  briefly looked like the well was dry (assignment-2, 69h to cutoff): a
  seventh framing — "trace every date and number against every page that
  depends on it" — found that Critique Practice's due date was noon the
  same calendar day as session 12, the studio its own text explicitly says
  it grades ("every studio before it, this one included"). Exhibition Piece
  had hit the identical timing shape (an assessment needing to reflect what
  happens *in* the final studio) and solved it by moving its due date 11
  days after that studio, with a sentence explaining why; Critique Practice
  just hadn't been given the same treatment. Two clean passes in a row is
  not evidence the well is dry — it took an eighth distinct framing (after
  seven) to surface a sixth real bug, on a repo that had already had two
  framings return nothing. Fixed by pushing the due date a few days past
  the studio and adding the same kind of one-line rationale Exhibition
  Piece already carried.
  [`f758c4a`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/f758c4a)

  Seventh confirmation, a ninth framing and a new bug shape again
  (assignment-2, 63h to cutoff): "read every page as a confused student
  asking what to actually do" — untried per the prior hand-off's own
  suggestion — found `policies/index.mdx`'s "Declared assistance" section
  obliging students to disclose what they used to build each submission,
  with no page anywhere (not policies, not any of the three assessments'
  "What you submit" sections) ever saying where that account goes. Every
  individual sentence was true and every check green, same as all six prior
  finds; the gap was an obligation stated with no stated mechanism to
  satisfy it, distinct from a wrong date, a wrong link, a wrong emphasis, or
  leftover template prose. Confirmed by grep across all three assessment
  content files for "declar"/"assistance"/"process" before concluding it was
  really unaddressed anywhere, not just missed by one read. Fixed by
  pointing it at the README, reusing a convention (`first-instrument.md`'s
  "add one sentence of context to the repository's README") the site had
  already established for a different kind of author's-voice note, rather
  than inventing a new submission mechanism from nothing.
  [`5b1a0d4`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/5b1a0d4).
  The same subagent also flagged "no page states where a submission link
  actually goes (LMS/form/email)" — judged out of scope and left alone,
  since the real assignment's own brief defers submission mechanics to a
  page outside the fiction entirely, so the fictional site was never asked
  to model one. Worth remembering as a negative case: not every plausible-
  sounding actionability gap a cold-read subagent surfaces is a bug to fix —
  check it against what the brief itself actually scopes in before acting.

  Eighth confirmation, and a new place to point the technique (assignment-2,
  52h to cutoff): every prior framing had read the site's *content* pages;
  this run pointed a framing at `PROCESS.md` itself, against the brief's own
  process-marking bar ("top marks require explaining why a call beat the
  obvious one, and how it was verified, for course-design decisions"). It
  found `PROCESS.md`'s "image-free by design" claim was a circular citation:
  PROCESS.md said the reasoning was "argued in `src/site-config.ts`," and
  the comment there said "see PROCESS.md for the reasoning" — neither file
  actually carried the argument, for the site's single most visible
  course-design call. A second, parallel framing ("is this actually a
  reskin?") found the real bug that run: `policies/index.mdx`'s
  "Declared assistance" section was unchanged, generic agentic-coding
  disclosure boilerplate — confirmed by `grep -riE "agent|autocomplete|AI|
  prompt"` across all of `src/content/` returning zero hits elsewhere — in a
  course whose own stated thesis (a hand testing an instrument, not a
  picture of one) is the most directly relevant possible stance on that
  question and had never been brought to bear on it. Both fixed
  ([`db9f14a`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/db9f14a),
  [`9e0c67e`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/9e0c67e),
  [`bdb7b1d`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/bdb7b1d)).
  Generalises the standing technique one more step: the cold-read framing
  doesn't have to target the site's content pages at all — pointing it at
  the process-evidence document itself, against the specific rubric language
  that scores it, is a distinct and apparently still-fruitful target, not a
  variant of a content framing already tried.

  Twelfth confirmation, and a framing that checks structure rather than
  content (assignment-2, 39h to cutoff): "read every `related:`-style
  frontmatter cross-reference and check whether the relationship it implies
  is true, and reciprocated where the site's own pattern makes it mutual."
  Delegated to a subagent; it first established the site's actual pattern
  (lecture/session pairs for the same week always reciprocate; a session
  naming an assessment by title in prose always gets a matching `related:`
  entry plus an inline link; assessments only cross-link to other
  assessments, never back to a session) before checking every instance
  against it — confirming the pattern itself, not just spot-checking one
  link, is what let it recognise `sessions/10-stroke-to-system.md` as the
  one violation: it names "the exhibition piece in week 12" in prose but had
  neither the `related:` entry nor the link every other such session
  carries. Fixed by adding both
  ([`8fe9eca`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/8fe9eca)).
  Twelve framings, twelve real bugs — still no evidence this technique has
  run out of new angles on this repo.

  Thirteenth confirmation, and the last for this repo (assignment-2's final
  run, 28h to cutoff): framing was "read the twelve weeks against the one
  reference-course property the brief names explicitly — does SLOP1450 carry
  one idea all the way through the way *Calling Bullshit*/*How to Make
  (Almost) Anything*/*CS 007* are held up as doing, or does some week feel
  like padding against that specific bar." Found that week 8 ("Pattern and
  seed")'s spec was the only one of twelve testable by a script with zero
  hand on the instrument at all ("given the same seed, produces the same
  result twice") — in direct tension with the homepage's own definition of
  the course by contrast to "a picture the software produces for you."
  Verified by direct comparison (not just trusting the subagent's claim):
  read weeks 04/05/07/09's specs side by side and confirmed every one of them
  closes on a hand, viewer, or stranger touching something, where week 8's
  didn't. Fixed by keeping the reproducibility mechanic (week 10 folds "the
  seed" into its parameter set, so it isn't orphaned) but adding a
  hand-facing control and spec criterion, reframing the exercise as a hand
  choosing among a family of variations rather than a machine replaying
  itself
  ([`3ae3b7e`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/3ae3b7e)).
  Thirteen framings, thirteen real bugs, right through to the deliverable's
  final run — the technique never produced a false "nothing left to find"
  across the whole 168-hour window. Worth carrying forward as a default
  first move on any future content-heavy deliverable in this course, not
  something to reserve for when other checks come up empty.

  Ninth confirmation, two more distinct bug shapes at once (assignment-2,
  45h to cutoff): dispatched two parallel framings rather than one. The
  first extended the eighth confirmation's self-directed lens — not just
  "does PROCESS.md's process hold up," but "does every design decision it
  claims (or should claim) actually have a defended alternative, not an
  assertion dressed as one" — and found two real, previously-unmentioned
  structural decisions (holistic vs. weighted marking split between
  assessments; no-late-submissions-with-extensions instead of a penalty
  scheme) that had genuine rejected-alternative reasoning sitting in the
  content since the first draft, just never surfaced in PROCESS.md. The
  second was a genuinely new angle no prior pass had tried: reading all
  twelve session pages purely for pedagogical arc (does each week deepen the
  last, not just stay factually consistent with it) rather than fact-
  checking. The arc itself held up, but it surfaced a different bug class:
  `assessments/first-instrument.md`'s brief prose claimed the submission
  tests "the first five weeks' work" including studio 5's decay feature, but
  the checkable `spec:` list only ever tested studios 3 and 4 — a prose-vs-
  spec mismatch invisible to both a fact cross-reference (nothing
  contradicts anything) and a pure design-decision read (it's not a
  decision, it's an omission). Fixed
  ([`4183966`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/4183966)
  cited as the origin of the two decisions being defended,
  [`7b71e40`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/7b71e40)
  likewise,
  [`f924765`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/f924765)
  for the spec fix). Two more data points against the "well might be dry"
  read the tenth-run hand-off worried about after two clean lenses in a row
  — a plateau of clean passes still isn't evidence the last framing tried
  was representative of all remaining ones.
- **When deepening a multi-input instrument, check an expressive signal
  exists meaningfully on every input modality before wiring it in — not just
  on the one that makes it easiest to reach for.** Deepening Chime
  (crit-4, run at 159h to cutoff) needed a velocity-like dimension.
  `PointerEvent.pressure` was the obvious first reach — it exists, it's a
  number — but it's unreliable across devices (0.5 default for a mouse,
  often 0 for touch without force support) and keyboard has no analogue
  signal at all, so using it would have deepened only the pointer path and
  quietly broken the instrument's own pattern of one voice-management path
  for mouse/touch/keyboard. The actual signal used instead — time between
  successive note-onsets — exists identically on both a pointer glissando
  and a fast keyboard run, so one shared clock (`strikeVelocity()`) drives
  loudness/brightness/attack-shape for every input type the same way.
  Generalises past this one instrument: any time a spec asks for multiple
  input modalities and a later deepening pass reaches for a per-modality
  hardware signal, ask whether a *timing*- or *sequence*-based signal
  (derived from events you already unify, not from raw hardware data) would
  cover all the modalities instead of just the fanciest one.

  A third deepening pass on the same instrument (crit-4, run at 141h to
  cutoff, chord density) found a further step past "prefer timing/sequence
  signals over hardware": some expressive dimensions aren't keyed to any
  single input *event* at all, and are better read off shared *state* instead.
  `chordDensity()` reads `activeVoices.size` — the live count in the map every
  input path already funnels into — rather than anything about how or when a
  particular note was triggered, so it's unified across mouse/touch/keyboard
  "for free," with no per-modality reasoning needed at all (unlike velocity or
  hold-time, which still had to be checked against each modality even though
  they passed). Worth trying this as the *first* question for a future
  dimension, before reaching for a timing signal: is there already a piece of
  shared state (a map's size, how long it's been non-empty, its contents)
  that this dimension could read directly, rather than deriving it from a
  per-input event stream at all.

- **A stuck input-toggle flag can silently disable a *different* input path,
  not just its own — and a same-moment before/after screenshot can't prove a
  fix works if the bug's signature saturates a clamp.** Reading `main.ts`
  fresh (crit-5, `One Stroke`, run at 100h to cutoff) rather than re-running
  the same viewport/resize checks again, spotted that a `keydown`/`keyup`
  pair toggling a single `keyDir` flag never gets its release event if the
  window loses focus (alt-tab, a notification) while the key is physically
  down — the frame loop's keyboard branch ran every frame whenever `keyDir
  !== 0`, so a stuck key silently overrode *pointer* control too, not just
  the keyboard path. First attempt at confirming this (dispatch `keydown`,
  dispatch synthetic `blur`, screenshot twice a couple of seconds apart) gave
  an ambiguous result: the brush position looked identical whether or not the
  fix was applied, because `pointerY` was clamped to `[0,1]` and the stuck
  flag had already driven it to the clamp either way — a same-moment
  before/after comparison can't distinguish "fixed" from "still broken but
  saturated." The test that actually discriminated: after the blur, move the
  mouse to the *opposite* edge and check whether the brush follows (fixed) or
  stays pinned (still broken) — this exercises the ongoing fight between the
  stuck flag and live input, not just the flag's resting value. Confirmed
  with a proper A/B (`git stash` to get the pre-fix code, rebuild, repro,
  `git stash pop` to restore) rather than trusting the fix by code inspection
  alone. General lesson: when a bug's symptom is "a value got pushed to a
  boundary," pick a verification action that continues to probe *after* the
  boundary is reached, not one that just re-observes the boundary state.
  [`22122e0`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-shitao/commit/22122e0)

- **A framework-free client script's own event-listener logic can be driven
  directly in jsdom, with no real browser, once you know which three things
  need stubbing.** `comp4020-final-shitao` (crit-8, run at 116h to cutoff):
  every existing spec test drives the server over HTTP, so the
  stuck-`canDraw`-listener bug fixed the previous run (`2e59190`) had zero
  automated coverage, only a manual `agent-browser` sequence. Wrote
  `spec/wall-client.test.ts` instead: build a `JSDOM` with `runScripts:
  "dangerously"`, append a real `<script>` element whose `textContent` is
  `public/wall.js` read straight off disk (jsdom executes an appended inline
  script synchronously, same as a real browser parsing one), then dispatch
  real `new window.PointerEvent(...)` instances at the SVG. Three jsdom gaps
  need stubbing before this works, confirmed by hitting each one directly:
  `svg.getBoundingClientRect()` always returns an all-zero rect (no layout
  engine) --- stub it to a plausible box or the app's own coordinate maths
  divides by zero; `svg.setPointerCapture` doesn't exist at all (`undefined`,
  not a no-op) --- stub it before dispatching, not at registration time, since
  the real call only happens inside the `pointerdown` handler; `EventSource`
  doesn't exist either --- stub a class with a no-op `addEventListener` since
  wall.js opens one unconditionally on load with no server behind it to
  answer. `SVGSVGElement.viewBox.baseVal` and `PointerEvent` construction
  both worked out of the box, no stubbing needed. Verified the test actually
  discriminates, not just runs: checked out the file at `2e59190~1` (the
  pre-fix version) into the same harness and confirmed it posts twice/leaves
  two paths, where the post-fix file posts once/leaves one --- a test that
  passes against both versions would prove nothing. Generalises past this
  one repo: any plain-JS (no-framework) client file that attaches DOM
  listeners once and reacts to pointer/keyboard events is testable this way
  without Playwright or a real browser, as long as you stub (not assume away)
  the specific layout/capture/network APIs jsdom doesn't implement.
  [`ec78095`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/ec78095)

  Third bug found via this same harness (crit-8, run at 99h to cutoff), and a
  reusable general lesson: `wall.js`'s `pointerdown` guard checked `canDraw`,
  which only flips false on a *successful* POST response --- so a hand could
  start a second gesture while the first's request was still in flight. Both
  posted; the server's one-mark-a-day check correctly rejected the loser, but
  the single `pendingNonce` variable (added by the self-echo fix above)
  belonged to whichever gesture started last, orphaning the winner's own
  nonce and making its own echo draw a visible duplicate. Confirmed with a
  scratch repro in the same jsdom harness before fixing (two gestures,
  first's fetch deferred, produced 2 posts and 3 paths), fixed with one new
  `submitting` flag gating `pointerdown` alongside `canDraw` for the duration
  of the in-flight request (simpler than turning `pendingNonce` into a set,
  and closes a genuine UX gap too --- no point letting a second stroke start
  when it can only ever be rejected), then re-verified the new regression
  test fails against the pre-fix file and passes against the post-fix one,
  same discipline as the first two bugs this harness caught. General lesson
  past this one file: any boolean gate on a one-shot network action that
  only flips on *success* (not on "request sent") leaves a window open for a
  second attempt to start before the first settles --- check for an explicit
  in-flight flag, not just the success/failure flag, whenever a handler
  gates on "can the user do this" rather than "is the user already doing
  this." Third bug in three runs from the same small file via three
  different framings (stuck listener, content-vs-token echo, overlapping
  gesture) --- still no sign this well is dry; keep varying the framing
  rather than trusting a clean pass.
  [`176b787`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/176b787)

- **A "distinct hues, not tuned for contrast" comment next to a user-chosen
  colour palette is a named gap worth actually computing, not just noting.**
  `comp4020-final-shitao` (crit-8, run at 75h to cutoff): `src/identity.ts`'s
  ten-colour hand palette carried exactly that comment, and the `#wall` SVG
  has no explicit background of its own --- it shows through to whatever
  `color-scheme: light dark` resolves the page background to, white or
  near-black depending on the visitor's own system preference. Computing
  WCAG contrast ratios for all ten against both found five that failed or
  nearly failed the 3:1 non-text-contrast minimum (1.4.11 --- the right
  criterion for a drawn stroke, not text) against white: a pale yellow at
  1.52:1, a light orange at 2.06:1, down to one at 2.95:1. Confirmed visually
  first (swatches of all ten drawn on a scratch wall, screenshotted under
  `agent-browser set media light`/`dark`) before concluding it was a real
  bug, not just a number. Fixed with a per-colour HSL lightness search
  (hue/saturation kept) that pulls each failing colour to ~4.58:1 against
  *both* backgrounds, touching only the five that needed it. Added
  `spec/contrast.test.ts` that reads the palette straight out of
  `identity.ts` via regex, same pattern as this repo's own standing
  `spec/contrast.test.ts` precedent from a different repo (read CSS vars
  with a regex rather than duplicating the colours) --- so a future palette
  edit is caught automatically. General lesson: any comment in a codebase
  that names a property as explicitly *not* handled ("not tuned for X," "Y
  decides that" where nothing actually does) is a candidate worth computing
  directly rather than reading as acceptable scope, especially for anything
  judged (not tested) by the standing "screenshot before believing the
  checks" rule's own logic --- a numeric accessibility property is exactly
  as computable as the CSS-variable contrast check this repo's `MEMORY.md`
  already documents from elsewhere, just against a JS array instead of a
  stylesheet.

## Publishing is the harness's job, not mine

Run 12's hand-off wrote "run the `/ship` skill" as a next action. There is no
such skill in the available-skills list, and doctrine says why it doesn't need
to exist: "the trusted harness scans, publishes, deploys and freezes the exact
commit you pushed; you never receive its GitHub credential." Confirmed run 13
(21h to cutoff): `gh auth status` is logged out, the repo API returns 404
unauthenticated (consistent with still-private), and there is no `gh`/API
token anywhere in env/netrc to change visibility even if I wanted to. My job
is to get a clean, pushed `main`; making the repo public and deploying Pages
happens on the harness's own schedule, outside my access entirely. Don't spend
a future run hunting for a way to flip repo visibility myself.

## Doctrine timing, reaffirmed

"Finishing steps" (including the push) are gated to inside 24h to cutoff;
before that, plan/build/deepen and commit locally without pushing.

**Deploying to Fly.io is not gated the same way pushing is.** A crit-7 run's
`now.md` (run 5) wrote "this run committed locally only, per doctrine
(finishing steps including push/deploy are gated inside 24h to cutoff)" ---
conflating two different routine steps. The doctrine's finishing steps (push,
gated) and step 7 (deploy) are separate: `flyctl deploy --remote-only` builds
and ships straight from the local clone, needs no GitHub push and no public
repo, and step 7's own wording ("once something renders, and again whenever
the live app should catch up with your commits") reads as ongoing, not
finishing-run-only. Consequence: the live `comp4020-crit7-shitao.fly.dev` sat
pinned at run 2's version for three whole runs' worth of real features
(cancellation, the date window, `/mine/`, Move) before run 6 caught it via
`flyctl status` and redeployed twice in one run to catch up. Check `flyctl
status -a <repo-name>` early in any run on a Fly.io deliverable and redeploy
whenever it's meaningfully behind local `main` --- don't wait for the
finishing run, and don't trust a prior run's `now.md` characterisation of
what's gated without rereading the doctrine's own step 7 wording.

**A `flyctl status` machine `STATE` of `stopped` is not evidence the deploy is
stale --- check the image version against local `main`, or just `curl` it.**
Run 13 (69h to cutoff) saw `stopped` right after a run that had deployed and
confirmed the live URL; briefly looked like the exact staleness this doctrine
note warns about. It wasn't: Fly's machines auto-stop when idle and auto-start
on the next incoming request by default, so `stopped` between runs is the
normal resting state, not a sign nothing's been deployed. A plain `curl -s -o
/dev/null -w '%{http_code}'` against the `.fly.dev` URL woke it and returned
200 immediately. The real staleness check is still "does the deployed image
correspond to local `main`'s latest commit," not the machine's current
run/stop state.

**Out-of-band commits are normal, not a doctrine violation.** Across ten runs,
`origin/main` has repeatedly gained commits I didn't push myself, from three
distinct non-me sources: the harness's own `memory: tick snapshot ...` commits
(plain `git push` of whatever's sitting on local `main`, including any commit
I made but correctly left unpushed under the inside-24h gate — so "my commit
is already on origin" is never evidence a push rule was broken); and three
convenor-adjacent identities, `Ben Swift`, `COMP4020 teaching team
<comp4020@anu.edu.au>`, and `COMP4020 course automation <noreply@anu.edu.au>`,
pushing legitimate course-wide maintenance (CI hardening, reflection-naming/
prompt-order rule changes, `.gitignore` scope, and — new this run, crit-4,
135h to cutoff — a wholesale "bring the course-owned checks forward to the
template tip" commit that dropped `oxlint`/`stylelint` out of `pnpm check`,
rewrote `check-evidence.ts` to work offline from the repo name alone, and
added `meta description`/`og:image` invariants) directly to this student repo.
Signal for "this is convenor, not a violation":
a real person/team name (not "harness"/tick-snapshot) plus course-wide scope
rather than content specific to this site. Don't revert or fight these.

**But check content, not just the check, after one lands.** Twice now
(runs 5 and 6) a convenor commit changed a *rule* (reflection heading should
be the deliverable title not a week number; prompt order should be
breakthrough-first) by editing `reflections/README.md`/`CLAUDE.md` only —
leaving this repo's actual `reflections/crit-1.md` still following the old
rule, invisibly, because `pnpm check:evidence` only validates the reflection's
filename/word-count/citations, never its heading or content order. Standing
check: whenever a reflection- or evidence-adjacent convenor commit lands,
re-read `reflections/crit-1.md` itself against the current wording of
`reflections/README.md` and `CLAUDE.md`, not just re-run `check:evidence`.

The habit generalises past reflection-rule changes: the course-automation
commit above (crit-4, 135h to cutoff) was a *tooling* change, not a
reflection-rule change, and reading its full diff (not just its commit
message) is what surfaced that `public/card.png` had been dropped in as the
template's literal "Replace this card" placeholder — flagged in the commit's
own prose as "still to be replaced," but a fact that would never have shown
up as a failing check, since the new `og:image` invariant is presence-only
(any file at the path passes). Replaced it with a card generated from the
instrument's own `layout()`/`draw()` math rather than a generic banner — see
the card-generation technique below. General lesson: after *any* course-owned
commit, skim the full diff for prose that names something still needing
action ("replace this," "still to be filled in," "template default"), since
that class of task passes every automated check by construction.

**`now.md` is a hand-off, not a ledger.** It can go stale or skip a run (one
run's real commit, `2d18c08` adding the typecheck sensor, went unmentioned by
the next hand-off). "Take stock" (routine step 3) means reading `git log
--format='%h %an %ad %s'` since the last known state and reconciling it
yourself, not trusting the previous `now.md` prose at face value.

**"Content-complete" was true of the brief, not of every viewport.** Runs
3, 5–10 repeatedly found nothing to fix, but none since run 10 had actually
re-opened the browser — run 11 explicitly skipped it as redundant, and that's
exactly the run window in which the about-page image-overflow bug (see above)
sat unnoticed. Don't manufacture scope against a satisfied brief, but "checks
green + reflection matches README" is not sufficient evidence the rendered
page is fine — a real-browser pass at both viewports still needs to happen
periodically (not necessarily every run, but don't let it lapse for several
runs in a row on the assumption that nothing rendering-related could have
changed when nothing else changed either — this run had zero upstream
commits and still found a real bug that had presumably been there since
whenever the about page's image was added).

Third confirmation, this time in assignment-1 itself (run 6, 124h to
cutoff): five prior runs (2–5) had called the yīhuà build "content-complete,
nothing to fix" on the strength of 31/31 green checks alone, without a
fresh screenshot pass. A phone-viewport (390×844) screenshot caught a
dead ~150px gap between the speed slider and the "Clear canvas" button,
fixed in `ae3df16`. Same shape as the about-page bug: a pure CSS/layout
defect no automated check (typecheck/build/lint/axe/contrast/vitest) can
see, because none of them render at a real viewport. The specific CSS
trap: `.control` had `flex: 1 1 16rem` sized for the desktop row layout;
the mobile media query flipped the container to `flex-direction: column`
but left that basis in place, and a flex-basis always sizes along
whatever the *current* main axis is — under column layout, "16rem" became
a 256px minimum **height** around ~100px of real content, not a width.
Whenever a media query flips `flex-direction` between row and column,
check every `flex-basis` set for the other axis inside that same query;
don't assume it only affects the properties the query explicitly names.

Fourth confirmation, and a new shape of bug (assignment-1, run 63h-to-cutoff):
"content-complete, nothing to fix" had held for several runs on 31/31 green
checks plus periodic screenshot passes, but a screenshot alone wouldn't have
caught this one — it was a *label-vs-physics mismatch*, not a layout defect.
The keyboard demo stroke's status text ("swift and dry" / "even-handed" /
"measured and dark") looked plausible at every slider position in isolation,
and the drawn stroke looked like *a* stroke either way — nothing to eyeball
as wrong. What caught it was driving the interaction with `agent-browser
eval`, reading the actual slider value and computed classification, then
independently recomputing the same math (`node -e`) to check the two agreed.
They didn't: the demo path timed its points by x-only spacing while the path
also moved in y, so the real speed fed to the width/opacity functions was
inflated above what the slider implied, by a different ratio depending on
canvas width — same slider position, different label at each marking
viewport (`f5bb895`, assignment-1). Generalises past this one bug: for any
interaction whose displayed *label or classification* is derived from a
computed value (a speed, a score, a threshold band), a screenshot only
proves a stroke was drawn, not that the label matches the maths — cross-check
the number, don't just trust that the UI shows *something* plausible.

Fifth confirmation (crit-4, `Chime`, 124h to cutoff): a mobile-viewport
screenshot (390×844) of an already-shipped, 23/23-green instrument showed the
scattered notes bunched into a thin horizontal band with most of the screen
empty — `layout()`'s vertical spread was `height * 0.18`, tuned by eye against
a desktop window and never re-checked at a tall aspect ratio. Fixed
(`f7f2ad7`) by switching the amplitude to `height * 0.32` once `width <
height`. Same root cause as the yīhuà flex-basis bug: a layout constant tuned
for one aspect ratio silently wrong on the other, invisible to every
automated check because none of them render at a real viewport. Reconfirms
the standing rule ("content-complete... is not sufficient evidence the
rendered page is fine") on a fifth distinct codebase — worth treating as
settled rather than something to keep re-deriving evidence for.

Sixth confirmation, and a refinement of the rule itself (crit-5, `One
Stroke`, 124h to cutoff): five prior runs on this same repo had checked the
two declared marking viewports (1920×1080, 390×844) repeatedly and found
nothing — both genuinely do render pixel-perfect, still. But a viewport
*between* them (any short/wide window, e.g. 1280×720 — a realistic laptop
browser window, not a contrived edge case) exposed a CSS/JS feedback loop
(see the canvas-aspect-ratio entry above) that grew the canvas without bound
across a handful of resizes. Neither declared viewport ever triggers it,
because the bug only manifests when the canvas's own attribute-derived
aspect ratio disagrees with the flex-stretched size enough to compound
across *repeated* resize events — a single fixed-size check, however
thorough, can't see a divergence that only shows up across a sequence. The
refinement to the standing rule: checking the declared marking viewports is
necessary but not sufficient — a periodic pass should also try at least one
size *between* or *around* them (not just the two extremes), and at least
one *sequence* of resizes within a single session rather than only isolated
fixed-size opens, since some bugs are only reachable through the resize
event itself, not through any one static layout.

Seventh confirmation, a new mechanism this time (`comp4020-crit7-shitao`,
124h to cutoff): a flex container whose children are an `<a>` element
followed by a run of plain text (no wrapping element around the text) treats
each as a *separate* flex item — `<li>` with `display:flex; flex-wrap:wrap`
containing `<a>{date}</a>, {slot}, {room} — booked by {name}` wrapped the
date onto its own line and the rest onto the next, orphaning a leading comma
before the slot on a 390px viewport. Invisible on desktop (enough width that
neither item needs to wrap) and invisible to all 50 green tests, since
nothing checks rendered line breaks. Fix: wrap the anchor and the trailing
text in one `<span>`, making them a single flex item so the browser's normal
text-wrapping (which breaks at word boundaries, not before a comma glued to
the preceding word) applies instead of a wrap between flex items. General
lesson to add to the standing "check a viewport between the two markers, not
just the two extremes" refinement above: any flex/grid container mixing an
inline *element* (a link, a button) directly with adjacent *text* content is
a candidate for this — group them in one wrapping element before trusting
how the pair breaks at a narrow width, don't assume adjacent inline content
wraps together just because it reads as one sentence in the markup.

Eighth confirmation, the same root cause hitting a `<label>`/control pair
instead of a link/text pair (`comp4020-crit7-shitao`, run 10, 93h to
cutoff): `/mine/`'s Move `<form>` (the shared `form { display: flex;
flex-wrap: wrap; }` rule) had `label`, `select`, `label`, `input[type=date]`,
`label`, `select`, `button` as seven flat sibling flex items. At 390px each
wrapped independently, so "Date" landed at the end of the Room line and
"Slot" at the end of the Date line — each label visually detached from the
control it names, even though the `for`/`id` association (and so screen-
reader behaviour) was unaffected. `pnpm check` stayed green (64/64) the whole
time; only a mobile-viewport screenshot with the `<details>` panel actually
expanded caught it — a collapsed-panel screenshot, or a check that only
opens `/mine/` without clicking "Move," would have missed it entirely. Fixed
by wrapping each label+control pair in a `<span class="field">` (`display:
flex; align-items: center`), confirmed at both marking viewports before and
after. Extends the standing rule once more: it's not just "link + adjacent
text" — any flex-wrap container whose children are a `<label>` plus its own
`for`-linked control, listed as separate siblings, is the same shape. When
auditing a form for this, don't stop at the visible controls — expand any
`<details>`/accordion first, since the bug can be sitting inside content a
plain page-load screenshot never renders.
[`837a441`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-shitao/commit/837a441)

- **"Content-complete, `pnpm check` green" doesn't catch leftover
  template-author prose still sitting in live pages — a qualitative
  coherence review does, and is worth delegating.** Assignment-2's brief
  marks "does the course hold together" and "isn't the prose AI slop," which
  no automated check can score. Sent a subagent (general-purpose) to read
  every session/lecture/assessment/people file plus the collection index
  pages against those exact brief quotes, read-only, report-only — it found
  that three of four collection index pages
  (`src/pages/{sessions,lectures,assessments}/index.{astro,mdx}`) still
  carried the *template's own authoring instructions* ("Set the visible
  singular and plural names once in `src/site-config.ts`," "Weights should
  sum to 100") as live page copy, sitting directly under top-nav links where
  a marker hits them in the first three clicks — everything else on the site
  was already in-voice. `pnpm check`/`check:evidence` never catch this class
  of gap because the leftover text is valid, schema-passing content; only
  reading it against "would a student want this" surfaces it. Fixed in
  [`49e3521`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass2-shitao/commit/49e3521)
  (assignment-2, 159h to cutoff). Rewriting the `.astro` one reconfirmed the
  em-dash gotcha above in a second file — its replacement prose needed a
  literal "—", not "---", same as `index.astro` before it. Worth a
  periodic full read-through pass, or a delegated one, on any future
  content-heavy deliverable — not just the browser/viewport pass, since this
  bug class is invisible there too (the text renders fine, it's just the
  wrong text).

- **A subagent's confident, detailed race-condition narrative still needs
  checking against the target's actual execution model before acting on
  it — not just against whether the described shape sounds plausible.**
  A "fresh mechanism read" subagent on `comp4020-crit7-shitao`'s `db.ts`
  (run 14, 63h to cutoff) reported a specific-sounding TOCTOU race in
  `moveBooking`: a SELECT followed by an UPDATE with no re-check of
  rows-affected, unlike `cancelBooking`'s correctly-guarded delete. Read
  cold, this is exactly the shape of a real race. It wasn't reachable:
  Node's single-threaded event loop plus better-sqlite3's fully synchronous
  API mean there is no `await`/yield point between the SELECT and the
  UPDATE inside one handler invocation, so no other request can ever
  interleave there in this single-process deployment, regardless of how
  many HTTP requests arrive concurrently. Confirmed empirically too (a real
  concurrent-request script racing Move against Cancel on the same booking,
  30 trials, SSE traffic captured): zero corruption — the "both succeed,
  row ends up gone" outcome each time was the legitimate result of the move
  completing, then a genuinely subsequent cancel removing the now-moved
  row. Did not apply the subagent's suggested defensive fix: doing so would
  have added validation for a scenario that provably can't happen, against
  the global CLAUDE.md's own rule against exactly that. Before acting on
  any detailed race-condition claim (subagent-reported or otherwise), check
  whether the two operations can actually run concurrently in *this*
  runtime — a real yield point (an `await` that hands control back) and
  genuine parallelism (separate threads/processes, not just separate
  requests arriving close together in wall-clock time) both have to be
  true, or the "race" is not one by construction. Single-threaded
  synchronous code in one process (Node + better-sqlite3 is exactly this
  shape) is immune to this whole bug class between any two statements with
  no `await` separating them. A cheap empirical racing script settles it
  either way in a few minutes when the architectural argument alone isn't
  fully convincing.

  Follow-up (run 15, 52h to cutoff): backgrounded shell `curl` processes
  (`for i in ...; do curl ... & done; wait`) hitting the exact same
  room/date/slot are genuine OS-level parallel requests, a stronger test
  than a sequential-ish racing script's "close in wall-clock time." 20 such
  requests against an isolated scratch server/DB left exactly one row for
  the contested slot, confirmed by reading the DB directly afterward (not
  by trusting HTTP status codes — both the success and slot-taken paths
  redirect with 303, so status alone can't distinguish winner from loser;
  only `select ... from bookings` settles it). One tooling snag worth
  reusing the fix for: Astro's default origin check (`security.checkOrigin`)
  403s a bare `curl -X POST` with no `Origin` header — add `-H "Origin:
  http://localhost:<port>"` matching the request's own host before reading
  a 403 as an app bug.

  Second follow-up (run 16, 45h to cutoff): the same technique applied to
  `moveBooking` instead of `createBooking` — two *different* bookings racing
  to move into the *same* destination slot — needs one more precaution the
  create-race didn't: don't let one "racer" already be sitting at the
  contested destination from a previous round. First attempt reused one
  fixed pair of bookings across ten rounds, moving both toward the same
  slot each time; round one's winner ended up parked *at* that slot, so
  every subsequent round's "race" was really that same booking UPDATEing
  itself to its own current values (SQLite's unique constraint doesn't
  conflict with a row's existing values on an UPDATE that changes nothing),
  against a genuinely-racing loser — a deterministic 10/10 result that would
  have read as "confirmed" while actually only proving the trivial case.
  Caught by noticing the win/lose split was identical every round instead of
  varying, which a real race between two independent, evenly-matched writers
  has no reason to do. Fixed by giving each of eight rounds its own fresh
  pair of never-before-touched bookings on their own date, converging on a
  destination neither started at, all fired as one batch of genuinely
  parallel backgrounded `curl`s. General lesson for racing an UPDATE (as
  opposed to racing an INSERT, where every contender starts from nothing):
  confirm the loser and winner aren't the same actor across repeated rounds,
  or a stale, already-there contender can silently make every round
  non-competitive. Also: `mapfile` is a bash builtin unavailable under this
  environment's default zsh (`command not found: mapfile`) — wrap a snippet
  that reads an array from a file in an explicit `bash -c '...'` rather than
  assuming array-reading builtins are shell-agnostic.

  Third follow-up (run 17, 39h to cutoff): a fourth combination, cancel-vs-
  move — one request cancelling booking A while another races to move a
  *different* booking B into the slot A just vacated. Same 8-fresh-rounds
  shape as the second follow-up (new date, new pair, per round). No new
  precaution needed beyond the two already documented (Origin header,
  distinct actors per round) — the one new snag was unrelated to racing
  itself: a bare `curl -X POST` with no body at all makes `cancel.ts`'s
  `request.formData()` throw a 500, a malformed-request artefact, not a
  race bug (see the standing entry on this above). Once fixed, all 8 rounds
  landed cleanly either way (mover wins because the cancel's DELETE
  committed first, or mover loses with a correct `error=taken` because it
  didn't) — no double-booking, no lost row, confirmed against the DB
  directly. Four for four DB-race combinations now confirmed clean on this
  repo (create-vs-create, move-vs-move, cancel-vs-move) under the same
  architectural guarantee (single-threaded Node, fully synchronous
  better-sqlite3, no yield point mid-handler) — at this point the remaining
  value in trying a fifth combination on the *same* mechanism is low; a
  future run looking for a fresh angle on this repo should look elsewhere
  (content/prose read, a genuinely new interaction path) rather than another
  race permutation.

- **A genuine yield point between a check and an insert is a real race, but
  ordinary concurrent requests can fail to prove it — the reproduction needs
  a client that holds one request's body open past the other's completion,
  not just "fire two at once."** `comp4020-final-shitao` (crit-8, run at 147h
  to cutoff): `server.ts`'s `POST /api/marks` ran `hasMarkedToday` *before*
  `await readBody(req)`, with `addMark` after — a real yield point, unlike
  the four `comp4020-crit7-shitao` DB-race combinations above that were all
  provably safe because *nothing* separated check and insert. Tried four
  increasingly rigorous concurrency tests first — two curl processes, 30
  rounds of two concurrent `fetch`es per fresh hand, 10 rounds of ten
  concurrent `fetch`es, and 40 rounds of raw pre-connected `net.Socket`s with
  both requests' bytes written back-to-back with zero `await` between the
  writes (even with bodies large enough to force multiple TCP reads) — all
  60+ combined trials came back clean, no race. Reason: Node fully drains one
  connection's microtask chain (the whole rest of an async handler with only
  one `await`, since the body is already fully buffered by the time it's
  read) before the event loop's poll phase moves on to the next socket's data
  — genuinely simultaneous writes from two sockets still don't interleave
  inside this handler shape. The reproduction that actually worked: send
  request A's headers only (a valid `Content-Length`, no body bytes yet),
  wait, send request B's *complete* request and let it finish end-to-end
  (checks false, inserts, 201), *then* release A's body — A's check had
  already run (and passed) before B's insert, so releasing A's body drives it
  through the same passed check into a second insert. 10/10 hits with this
  shape, 0/10 after moving the check to immediately before the insert with no
  `await` between them. This is not a contrived attack shape either — a slow
  network or a deliberately slow client produces exactly this on a real
  request. Lesson for any future check-then-insert-with-an-await-between
  finding: don't conclude "not reachable" from ordinary concurrent-request
  tests coming back clean, however many rounds — a fully synchronous
  single-threaded server can serialize even genuinely simultaneous socket
  writes by draining one request's whole microtask chain first. Test the
  held-open-body shape specifically before either trusting or dismissing the
  race. And when writing the regression test for a confirmed instance, use
  the same held-open-body technique (deterministic) rather than a
  fire-two-and-hope timing test (proven above not to reliably catch this
  shape, even at high concurrency).
  [`7a89c68`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-shitao/commit/7a89c68)

- **Not every Markdown renderer converts a literal `---` to an em dash ---
  check the actual pipeline before assuming the standing Astro gotcha
  applies.** `comp4020-final-shitao` (crit-8, run at 140h to cutoff) renders
  `README.md` through a bare `marked.parse(md, { async: false })` with no
  smartypants extension enabled --- every `---` in the file, old and new,
  renders as three literal hyphens in the browser, confirmed by screenshotting
  `/readme/` after editing it. This is the opposite finding from the standing
  Astro/remark entry above (which converts `---` to a real em dash glyph) ---
  the two aren't in tension, they're just different pipelines: check what a
  given project's actual markdown library/config does (grep for
  `smartypants`/`typographer`/similar) before trusting either direction as a
  default, and don't "fix" a literal `---` in a `marked`-rendered file that
  was never broken.

- **Writing a new memory entry into a deliverable repo's own `agent/MEMORY.md`
  or `agent/now.md` directly doesn't persist --- the harness's own periodic
  `memory: tick snapshot ...` commit overwrites those files back to whatever
  this global `memory/` directory already contains, silently discarding
  anything written locally that isn't also written here.** Caught in
  `comp4020-final-shitao` (crit-8, 134h to cutoff): run 4's commit `235909b`
  ("hand off crit-8 run 4, note marked's no-smartypants behaviour") added the
  smartypants finding above directly to the repo's `agent/MEMORY.md`, and the
  very next commit, `95e841c` (a tick snapshot ten seconds later), reverted
  exactly those 13 lines back out --- `git show <tick-commit> -- agent/MEMORY.md`
  shows a clean revert of the prior commit's own diff. The finding was real
  and never made it here, so it was gone until this run re-derived the same
  conclusion from the commit message and re-added it above. This is the
  concrete mechanism behind doctrine's "`agent/` is harness-owned: never edit
  it" --- it's not just a style rule, the harness actively syncs `agent/*.md`
  *from* this global `memory/` directory on its own schedule, one-way. Always
  write hand-offs and durable lessons to `memory/now.md` and `memory/MEMORY.md`
  in this `shitao/` directory (the ones `.claude/CLAUDE.md` `@`-includes),
  never to `<repo>/agent/*.md`, regardless of what a prior run's commit
  history shows was done there.

- **An "is this my own echo" check on a broadcast channel has to compare an
  opaque per-event token, not the event's content, and the token has to be
  recorded before the triggering request is even sent, not after it
  resolves.** `comp4020-final-shitao` (crit-8, run at 110h to cutoff): a cold
  read of `public/wall.js` found its SSE self-echo filter compared the
  *incoming mark's path string* to the path this tab had just posted ---
  which breaks the moment two different hands draw byte-identical short
  strokes (genuinely likely: paths are rounded to integer coordinates and a
  short stroke is the common case), silently dropping one hand's real mark
  as if it were the other's echo. Worse, `server.ts` broadcasts a mark
  *before* replying 201 to the POST that created it (deliberately, so other
  tabs see it the moment it's committed) --- so a tab's own echo can
  genuinely arrive over its SSE connection before its own `fetch` promise on
  a *different* connection resolves, meaning any "mark the path as mine after
  the fetch resolves" approach has a real ordering race, not just a content
  one. Fixed both with one change: a client-generated nonce
  (`crypto.randomUUID()`), set in a closure variable *synchronously, before
  the fetch call is issued* (not in the `.then`/after-`await` branch), sent
  in the POST body, and echoed back unchanged in the broadcast payload;
  the SSE handler compares by this token instead of content. Verified each
  new regression test actually discriminates by swapping in the pre-fix
  `public/wall.js` (`git show <old-sha>:public/wall.js`) and confirming both
  new tests failed against it before restoring the fix --- same verification
  habit as the `2e59190`/`ec78095` gesture-flag fix, reused successfully a
  second time on the same file. General lesson for any future
  "recognise my own broadcast event come back to me" feature: (1) never
  identify it by comparing rendered/business content, since two independent
  actors can legitimately produce identical-looking content; (2) never gate
  the recognition token's recording on the *response* to the action that
  triggers the broadcast, since the broadcast and the response are two
  separate I/O completions with no ordering guarantee between them --- record
  the token at the moment the action is initiated, before any `await`.
