import { createHash } from "node:crypto";

// One line per thing a hand does, for whoever is reading `flyctl logs`:
// when, which hand, what, to which mark. Never content --- no path, no note
// text, no prompt wording --- only ids and verbs, so the log can't become a
// second way to read what /mine/ keeps private.

export interface Who {
  id: string;
  name: string;
}

// Ten adjectives times ten nouns is only a hundred nicknames, so two hands
// can share one. A few hex digits of a hash of the id tell them apart in the
// log without writing the cookie value itself anywhere.
export function handTag(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 4);
}

export function formatAction(who: Who | undefined, action: string, now = new Date()): string {
  const when = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const name = who ? `${who.name}/${handTag(who.id)}` : "(no hand)";
  return `${when}  ${name.padEnd(24)}  ${action}`;
}

export function logAction(who: Who | undefined, action: string): void {
  console.log(formatAction(who, action));
}
