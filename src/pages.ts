import { marked } from "marked";
import type { Mark } from "./db.ts";

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

export function wallPage(
  marks: Mark[],
  hand: { id: string; colour: string },
  msUntilNextMark: number,
  previewLeaseMs: number,
): string {
  const alreadyMarked = msUntilNextMark > 0;
  // Ten colours across every hand means colour alone can't tell a returning
  // hand which strokes are theirs; `mine` is only ever rendered to the hand
  // that drew it, and never leaves the server as a hand id. A hand's own
  // strokes are painted last, each over a background-coloured halo, so a
  // busy wall's later marks can't bury them.
  const own = marks.filter((m) => m.hand_id === hand.id);
  const strokes = [
    ...marks
      .filter((m) => m.hand_id !== hand.id)
      .map((m) => `<path d="${escape(m.path)}" stroke="${escape(m.colour)}" data-id="${m.id}" />`),
    ...own.flatMap((m) => [
      `<path d="${escape(m.path)}" class="halo" data-id="${m.id}" />`,
      `<path d="${escape(m.path)}" stroke="${escape(m.colour)}" class="mine" data-id="${m.id}" />`,
    ]),
  ].join("\n      ");
  const ownCount = own.length;
  const handColour = hand.colour;

  const prompt = alreadyMarked
    ? `<p id="status">Your mark is already on the wall. You can add another ${untilPhrase(msUntilNextMark)}.</p>`
    : `<p id="status">Draw one mark with a pointer, or focus the wall and press Enter: arrow keys draw, Enter again finishes.</p>`;

  const svgAttrs = alreadyMarked
    ? `role="img" aria-label="The shared drawing, one mark per hand"`
    : `tabindex="0" role="application" aria-label="The shared drawing, one mark per hand. Press Enter or Space to start your mark, arrow keys to draw it, Enter or Space to finish, Escape to cancel."`;

  return layout(
    "Trace",
    `    <main>
      <h1>Trace</h1>
      <p>One wall. One mark each, once a day. Nothing else.</p>
      <svg id="wall" viewBox="0 0 1000 600" ${svgAttrs}>
      ${strokes}
      </svg>
      ${prompt}
      <p id="connection" aria-live="polite">Connecting to the wall…</p>
      <p><small>You draw as <strong style="color:${escape(handColour)}">this colour</strong>.${ownCount > 0 ? ` Your ${ownCount === 1 ? "mark is" : `${ownCount} marks are`} the thicker ${ownCount === 1 ? "stroke" : "strokes"}.` : ""} <a href="/readme/">What this is, and why</a>.</small></p>
    </main>
    <script
      src="/wall.js"
      data-can-draw="${alreadyMarked ? "false" : "true"}"
      data-hand-colour="${escape(handColour)}"
      data-preview-lease="${previewLeaseMs}"
    ></script>`,
  );
}

export function readmePage(readmeMarkdown: string): string {
  const html = marked.parse(readmeMarkdown, { async: false }) as string;
  return layout("About Trace", `    <main>\n${html}\n    </main>`);
}
