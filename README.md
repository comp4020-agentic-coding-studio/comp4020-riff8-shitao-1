# Trace

Trace is a shared wall and a small sketchbook. Each day there's a prompt
--- an ordinary moment, like "a shadow you noticed" --- and each hand
(yours, anonymous, remembered only by a cookie) can add one line to a
drawing that never resets. Draw something you noticed, keep a private note
about what it meant, and see how everyone else answered. Come back
tomorrow and your marks, and everyone else's, are still there, with the
new ones pointed out.

## What good means here

I read two things while deciding what this app should and shouldn't do.
Robin Sloan's
["An app can be a home-cooked meal"](https://www.robinsloan.com/notes/home-cooked-app/)
describes BoopSnoop, a photo-sharing app he built for exactly four people ---
his family --- with no login, no contact list, nothing to configure: "software
that stays put," made out of care rather than growth. Aral Balkan's
["What is the Small Web?"](https://ar.al/2020/08/07/what-is-the-small-web/)
names the pattern this is reacting against: the "Big Web" trusts servers
over people, and grows by trusting nobody, watching everybody, and never
sitting still.

Trace can't be single-tenant the way Balkan means (a marking crawler and a
stranger both need to reach it at the same URL), but I took the same stance
on what the *inside* of the app should feel like: nothing here is trying to
grow. There's no way to invite anyone, follow anyone, or find out who drew
which mark unless they tell you. A hand is a cookie and a colour, not a
profile. You get one mark a day, the same way you'd only add one line to a
guestbook --- not because the server can't take more, but because a wall
that everyone can flood stops being a wall anyone wants to add to.

## Who it's for, and why they'd come back

Students, friends and creative beginners who'd like a small daily ritual
that isn't a feed. The first visit: read today's prompt, practise on the
wall as much as you like (nothing leaves the browser), add one line when
it's right, and optionally write yourself a note about what it means. The
return visit: a new prompt, the marks made since you last looked drawn
wider, a "today's prompt only" filter to compare answers, and My traces,
which keeps every mark you've added beside its prompt, date and note.

That's a design hypothesis, not a finding: nobody outside the team has
used this version yet. The evidence it rests on is this README's own open
question from the previous version --- "whether 'no login, ever' survives
contact with people who want their marks back" --- and the pod brief that
asked for a reason to contribute and a reason to return. The crit is
where it gets tested.

## What I chose not to build

No public text. No titles, captions or usernames anyone else can read ---
a mark on the wall is still a gesture, not a post, and a gesture can't be
unkind the way a sentence can. The one place words are allowed is a
private note beside your own mark, which only you ever see: never on the
wall, never in `/api/marks`, never over the live stream, never in a
keepsake image. That's a deliberate departure from the old "no text at
all" rule: a line drawn for "how a conversation went" means far more to
the person who drew it with a sentence beside it, and keeping that
sentence private keeps the wall itself as safe as it was.

No accounts: identity is a browser cookie, so "coming back" means the same
browser. My traces says so plainly and offers a full export, because
clearing cookies or switching phones loses the link and Trace can't give
it back. No moderation queue: drawings can still be unpleasant without
words, so a hand can delete its own marks at any time, but there's no
reporting yet; for a wall this size, run by its own maker, that's the
proportionate first step (see later ideas).

## What's enforced, and what's judged

`spec/` checks the claims that are actually mechanical: a first-time
visitor gets a hand (a cookie, minted once); a mark they add shows up on
the wall and is still there on a completely fresh request; a hand can't add
a second mark until 24 hours after its last, measured from the mark rather
than from midnight, since UTC midnight lands at 11am in Canberra; deleting
a mark doesn't hand that day back, and a retried submission returns the
mark it already made rather than making another; a mark broadcasts over
`/api/marks/stream` within a second of landing and only after it's saved;
a stroke in progress streams as a preview that never reaches the database;
a note is readable by its own hand and nobody else, through any route; the
page ships no third-party script or tracking request; every hand colour
reads at WCAG 1.4.11's 3:1 non-text contrast minimum against both a white
and a black background. An old database, made before any of this, opens
with every mark intact (`spec/migration.test.ts`).

Whether the wall is good to look at, whether a daily prompt makes people
draw more thoughtfully or just more often, and whether private notes are
worth writing --- those are judgement calls, and the crit is where I find
out.

Nothing about "one hand, one mark" should mean one *input device*.
Focusing the wall and pressing Enter starts a line at its centre, the
arrow keys extend it a step at a time, Enter again finishes it into a
draft exactly as lifting a pointer does, and Escape discards it. From
there it's the same Add to the wall, the same nonce and the same
one-mark-a-day check, and with Draw live on it streams the same way.
`spec/wall-client.test.ts` drives this with real `KeyboardEvent`s against
the real `public/wall.js`, alongside mouse, touch and pen pointer events.

Coming back has to mean finding *your* trace, not just a trace. Ten
colours shared across every hand can't do that on their own, so a hand's own
strokes render thicker and on top of everyone else's, cut out by a thin
band of background so a busy wall's later marks can't bury them, and only
to that hand --- the server knows which
marks a cookie drew, but never sends a hand id to the page, so nobody else
can tell whose is whose. `spec/wall.test.ts` checks both halves: the hand
that drew a mark sees it marked as theirs, and a different hand looking at
the same wall doesn't.

## What's real-time, and why

Two things happen live on the wall, both over one same-origin
[server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream, `GET /api/marks/stream`. A finished mark appears in every open tab
the moment it's saved. And, if the person drawing chose to, you can watch
their line grow while they're still drawing it.

Live drawing works like this. While a hand draws with Draw live on,
`public/wall.js` posts its new points to `POST /api/strokes/live`, at most
one request in flight and no more than one every 50 ms, each carrying every
point drawn since the last, plus a heartbeat while the hand pauses.
`src/live.ts` holds these previews in memory, keyed by a fresh random id per
gesture, and the server fans them out as `preview` events, with a
`previews` snapshot at the start of every connection so a tab that arrives
(or reconnects) mid-stroke sees it straight away. Nothing about a preview
is written to the database. The server takes the colour and ownership from
the hand cookie, not from the request, refuses previews from a hand that
can't add a mark right now, and bounds everything: 200 points an update,
2,001 a stroke, 30 updates a second per hand, 100 strokes at once, 8 KB a
request, integer coordinates near the wall. SSE still fits: the only thing
a drawing tab sends is a short burst of small POSTs, and the server keeps
the one-way stream it already had, so there was no need for WebSockets.

A preview ends in one of five ways, and every viewer sees the same end:
its hand adds it (the committed `mark` event carries the gesture id, so
viewers turn the same element from translucent to solid where it stands,
with no second line); its hand cancels it (lifting after a single point,
Escape, Try again, the system cancelling the pointer, turning Draw live
off, or a failed submission); its hand starts another; it goes five seconds
without a heartbeat (a closed tab, a dropped connection: unload messages
are sent but never relied on); or it sits finished and undecided for two
minutes. A late update for an ended gesture is refused by the server and
ignored by every tab. A viewer leaving never ends anyone else's stroke.

On a laptop, against a local server, the server's own fan-out took a
median 1.1 ms (95th percentile 2.0 ms, 60 updates), and point-to-screen
between two real browser sessions took 36--89 ms per point (8 points), most
of it the 50 ms coalescing interval. I couldn't measure the deployed app
from this run. On a slow link the design degrades gracefully rather than
queueing: with one request in flight at a time, a viewer sees a hand's line
about one round trip behind, in larger steps, and a 200 ms-per-request test
in `spec/wall-client.test.ts` shows 61 points arriving complete and in order
in five requests or fewer.

### The decision: who sees a stroke before it's finished

This is the multi-user behaviour that matters most here, so it's the one
written down. **Drawing is private by default, and live only when the hand
turns it on for that stroke.** A finished stroke is a draft --- dashed, on
the drawer's screen, and dashed for viewers if it was live --- until its
hand presses Add to the wall.

The alternatives I weighed:

- **Always live** (every stroke streams as it's drawn, which is what the
  pod brief first describes). It makes the wall feel the most alive, and
  it's the version a pod will argue for. But it turns every hesitation and
  false start into a public performance, and an accidental gesture --- a
  phone in a pocket, a slipped trackpad --- would be broadcast before its
  owner even knew. For a wall whose argument is care, not engagement,
  watching someone draw should be something they've offered.
- **Never live, finished marks only** (the previous version). Simple and
  private, but it misses the thing that makes several people on one wall
  at once feel like company rather than a feed refreshing.
- **Live by default with an opt-out.** It reads the same as always-live
  for anyone who doesn't find the toggle first.

The costs of my choice: fewer strokes are watchable, because most people
won't turn it on; there's one more control on the page; and a draft step
means one more press before a mark lands. The draft step pays for itself
twice, though: an accidental gesture never spends the day, and the private
note has somewhere to live.

### Persistence, restarts and reconnecting

Marks live in SQLite at `DB_PATH` (on Fly, the `/data` volume). New
columns are added in place at boot, guarded so it's safe to run every time,
so a redeploy onto the existing volume keeps every mark. Previews live only
in memory, so a restart simply forgets strokes in progress --- which is
correct, since none of them are artwork yet. When the server goes away,
`public/wall.js` reconnects on its own (browsers don't always), refetches
the committed wall from `GET /api/marks` to catch up on anything missed,
and replaces its previews with the server's snapshot, without touching the
stroke or draft on its own screen. I checked this by killing the server
with tabs open, restarting it, and adding a mark before the tab had
reconnected: the tab caught up with no reload.

Rolling back to the previous version is safe: it reads the same `marks`
table and ignores the new columns and the `notes` table. Deleted marks
would come back as empty paths (invisible), and notes would sit unread
until the new version returned.

## Later ideas

These are deliberately not built yet:

- a visual duet: spend your next mark responding to someone else's,
  invited, with both drawings kept together and withdrawal handled
- reporting a drawing, if the wall ever outgrows its maker's attention
- replaying the wall's day as an animation, from the marks' timestamps
- carrying your traces to a new device with a one-time code, instead of
  only an export file
