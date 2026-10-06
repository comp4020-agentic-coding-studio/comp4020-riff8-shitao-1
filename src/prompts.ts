// One shared prompt a day, all of them ordinary moments: something anyone
// could have noticed since yesterday, drawable as a single line. Answering
// is optional, and the prompt is stored on each mark as worded that day, so
// rewording or reordering this list never changes what an old mark answered.
const PROMPTS = [
  "the way you got here today",
  "something that was in your pocket",
  "a sound you heard this morning",
  "the shape of a queue you stood in",
  "a shadow you noticed",
  "the edge of something you held",
  "how the weather moved",
  "a path someone else walked",
  "the last thing you waited for",
  "a plant you passed",
  "how a conversation went",
  "the outline of a window",
  "something that fell",
  "the route of a bird, a bus or a bike",
  "a corner you turned",
  "the steam off a drink",
  "where your attention drifted",
  "a crack, a seam or a join",
  "something small you fixed",
  "the rhythm of a walk",
  "a stair, a ramp or a hill",
  "a line you crossed",
  "the horizon, wherever you found one",
  "something you almost missed",
  "a knot, a loop or a tangle",
  "how today ended",
];

// The day is Canberra's: the prompt is a shared talking point, not an
// allowance, so one fixed zone everyone can see beats a different prompt
// per visitor. (The mark limit stays a rolling 24 hours; see src/db.ts.)
const dayIndex = (now: number): number => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" })
    .format(now)
    .split("-")
    .map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};

export function promptFor(now = Date.now()): string {
  return PROMPTS[dayIndex(now) % PROMPTS.length];
}

// A mark records the prompt its hand was shown, which may be yesterday's
// if the page stayed open past midnight; any wording from the list is fine,
// and nothing else is, so the field can never carry free text.
export function isPrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string" && PROMPTS.includes(prompt);
}
