import { marked } from "marked";
import type { Mark, OwnMark } from "./db.ts";

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)}</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
${body}
  </body>
</html>
`;

// Hours, not a clock time: the server doesn't know a hand's time zone, and a
// duration reads the same in every one.
export function untilPhrase(ms: number): string {
  const hours = Math.ceil(ms / 3_600_000);
  return ms <= 3_600_000 ? "within the hour" : `in about ${hours} hours`;
}

const nav = (current: "wall" | "mine" | "readme"): string => `<header class="top">
      <${current === "wall" ? "h1" : "p"} class="brand"><a href="/">Trace</a></${current === "wall" ? "h1" : "p"}>
      <nav aria-label="Primary">
        <a href="/"${current === "wall" ? ' aria-current="page"' : ""}>The wall</a>
        <a href="/mine/"${current === "mine" ? ' aria-current="page"' : ""}>My traces</a>
        <a href="/readme/"${current === "readme" ? ' aria-current="page"' : ""}>About</a>
      </nav>
    </header>`;

const drawnOn = (t: number): string =>
  new Date(t).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "medium",
    timeStyle: "short",
  });

// Exact, in Canberra time, for pages without script; public/wall.js
// rewrites it in the visitor's own zone where it can.
const nextAtTime = (msUntilNextMark: number): string => {
  const at = new Date(Date.now() + msUntilNextMark);
  const exact = at.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
  return `<time id="next-at" datetime="${at.toISOString()}">from ${escape(exact)} Canberra time (${untilPhrase(msUntilNextMark)})</time>`;
};

export function wallPage(
  marks: Mark[],
  hand: { id: string; colour: string },
  msUntilNextMark: number,
  previewLeaseMs: number,
  prompt: string,
): string {
  const alreadyMarked = msUntilNextMark > 0;
  // Ten colours across every hand means colour alone can't tell a returning
  // hand which strokes are theirs; `mine` is only ever rendered to the hand
  // that drew it, and never leaves the server as a hand id. A hand's own
  // strokes are painted last, each over a background-coloured halo, so a
  // busy wall's later marks can't bury them.
  const own = marks.filter((m) => m.hand_id === hand.id);
  const promptAttr = (m: Mark) => (m.prompt ? ` data-prompt="${escape(m.prompt)}"` : "");
  const strokes = [
    ...marks
      .filter((m) => m.hand_id !== hand.id)
      .map(
        (m) =>
          `<path d="${escape(m.path)}" stroke="${escape(m.colour)}" data-id="${m.id}"${promptAttr(m)} />`,
      ),
    ...own.flatMap((m) => [
      `<path d="${escape(m.path)}" class="halo" data-id="${m.id}" />`,
      `<path d="${escape(m.path)}" stroke="${escape(m.colour)}" class="mine" data-id="${m.id}"${promptAttr(m)} />`,
    ]),
  ].join("\n      ");
  const ownCount = own.length;
  const handColour = hand.colour;

  const status = alreadyMarked
    ? `Your mark is on the wall. You can add your next one ${nextAtTime(msUntilNextMark)}. Until then, practise as much as you like: nothing you draw leaves this browser.`
    : `Draw with a pointer, or focus the wall and press Enter: arrow keys draw, Enter finishes. Nothing is shared until you choose to add it.`;

  return layout(
    "Trace",
    `    ${nav("wall")}
    <main>
      <p class="lede">One wall, one mark each a day. Draw something you noticed, keep what it meant to you, and see how everyone else answered.</p>
      <p class="prompt">Today's prompt: <strong id="today">${escape(prompt)}</strong></p>
      <div class="toolbar">
        <button id="mode" type="button" aria-pressed="false" aria-describedby="mode-note"${alreadyMarked ? " disabled" : ""}>Draw live</button>
        <span id="mode-note">${alreadyMarked ? "Live drawing opens again when you can add your next mark." : "Off: you're practising privately. Turn it on to let everyone here watch your line as you draw it."}</span>
        <label class="filter"><input type="checkbox" id="only-prompt" /> Only today's prompt</label>
      </div>
      <svg id="wall" viewBox="0 0 1000 600" tabindex="0" role="application" aria-label="The shared wall. Press Enter or Space to start a drawing, arrow keys to draw, Enter or Space to finish, Escape to cancel." aria-describedby="status">
      ${strokes}
      </svg>
      <form id="draft" hidden>
        <p><strong>Your drawing isn't on the wall yet.</strong> <span id="draft-audience">Only you can see it.</span></p>
        <label class="check"><input type="checkbox" id="answers" checked /> It answers today's prompt</label>
        <label for="note">A note for yourself, about what it means <span class="quiet">(optional, never shown to anyone else)</span></label>
        <textarea id="note" maxlength="500" rows="2"></textarea>
        <div class="actions">
          <button id="publish" type="submit"${alreadyMarked ? " disabled" : ""}>Add to the wall</button>
          <button id="retry" type="button">Try again</button>
        </div>
      </form>
      <p id="status" aria-live="polite">${status}</p>
      <p id="connection">Connecting to the wall…</p>
      <p id="fresh" hidden></p>
      <p><small>You draw as <strong style="color:${escape(handColour)}">this colour</strong>.${ownCount > 0 ? ` Your ${ownCount === 1 ? "mark is" : `${ownCount} marks are`} the thicker ${ownCount === 1 ? "stroke" : "strokes"}, and <a href="/mine/">My traces</a> keeps ${ownCount === 1 ? "it" : "them"} with your notes.` : ""}</small></p>
    </main>
    <script
      src="/wall.js"
      data-can-draw="${alreadyMarked ? "false" : "true"}"
      data-hand-colour="${escape(handColour)}"
      data-preview-lease="${previewLeaseMs}"
      data-prompt="${escape(prompt)}"
    ></script>`,
  );
}

const strokeSvg = (m: Mark, attrs: string): string =>
  `<svg viewBox="0 0 1000 600" ${attrs}><path d="${escape(m.path)}" stroke="${escape(m.colour)}" /></svg>`;

export function minePage(marks: OwnMark[], msUntilNextMark: number, flash = ""): string {
  const items = marks
    .map(
      (m) => `      <li id="mark-${m.id}">
        <article>
          ${strokeSvg(m, `class="thumb" role="img" aria-label="Your mark from ${escape(drawnOn(m.created_at))}"`)}
          <div>
            <h2>${m.prompt ? escape(m.prompt) : "No prompt"}</h2>
            <p class="quiet">Drawn <time datetime="${new Date(m.created_at).toISOString()}">${escape(drawnOn(m.created_at))}</time></p>
            <form method="post" action="/mine/marks/${m.id}/note">
              <label for="note-${m.id}">Your note <span class="quiet">(only you see this)</span></label>
              <textarea id="note-${m.id}" name="note" maxlength="500" rows="2">${m.note ? escape(m.note) : ""}</textarea>
              <div class="actions">
                <button type="submit">Save note</button>
                <a href="/mine/marks/${m.id}.svg" download>Save the drawing as an image</a>
              </div>
            </form>
            <details>
              <summary>Delete this mark</summary>
              <form method="post" action="/mine/marks/${m.id}/delete">
                <p>This takes the drawing off the wall and deletes its note for good. Trace keeps only the time it was made, so deleting doesn't give you another mark today.</p>
                <button type="submit" class="danger">Delete it</button>
              </form>
            </details>
          </div>
        </article>
      </li>`,
    )
    .join("\n");

  const body =
    marks.length === 0
      ? `<p>You haven't added a mark from this browser yet. <a href="/">Go to the wall</a>: practise as much as you like, then add one when it's right.</p>`
      : `<p>${marks.length === 1 ? "One mark" : `${marks.length} marks`}, newest first. ${msUntilNextMark > 0 ? `You can add your next ${nextAtTime(msUntilNextMark)}.` : `You can add one now, on <a href="/">the wall</a>.`}</p>
      <ol class="traces">
${items}
      </ol>`;

  return layout(
    "My traces — Trace",
    `    ${nav("mine")}
    <main>
      <h1>My traces</h1>
      ${flash ? `<p class="flash" role="status">${escape(flash)}</p>` : ""}
      <p>Everything here is yours alone. The drawings are on the shared wall, but the notes beside them are never shown to anyone else, never sent over the live stream and never part of anyone's view of the wall.</p>
      <p>Trace knows you only by this browser's cookie: no account, no email. Clear your cookies or switch device and these can't be recovered, so <a href="/mine/export.json" download>download everything as a file</a> if you want to keep it.</p>
      ${body}
    </main>`,
  );
}

// A standalone image of one mark, to keep or share. The note stays behind.
export function keepsakeSvg(m: Mark): string {
  const title = `${m.prompt ?? "A mark"} — Trace, ${drawnOn(m.created_at)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" width="1000" height="600">
  <title>${escape(title)}</title>
  <rect width="1000" height="600" fill="#ffffff" />
  <path d="${escape(m.path)}" stroke="${escape(m.colour)}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
</svg>
`;
}

export function readmePage(readmeMarkdown: string): string {
  const html = marked.parse(readmeMarkdown, { async: false }) as string;
  return layout("About Trace", `    ${nav("readme")}\n    <main>\n${html}\n    </main>`);
}
