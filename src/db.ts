import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Hand {
  id: string;
  name: string;
  colour: string;
  created_at: number;
}

export interface Mark {
  id: number;
  hand_id: string;
  path: string;
  colour: string;
  created_at: number;
  // The shared prompt a mark answered, as worded that day (null if the hand
  // chose not to answer it, or the mark predates prompts).
  prompt: string | null;
}

// What only the hand that drew a mark ever sees.
export interface OwnMark extends Mark {
  note: string | null;
}

const dbPath = process.env.DB_PATH ?? "./data/trace.db";
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS hands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    colour TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id TEXT NOT NULL REFERENCES hands(id),
    path TEXT NOT NULL,
    colour TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Migrations for databases made before the sketchbook: add columns in
// place, never rebuild the table, so a redeploy onto the existing volume
// keeps every mark. Each step checks first, so this runs safely on every
// boot.
const markColumns = new Set(
  (db.prepare("PRAGMA table_info(marks)").all() as { name: string }[]).map((c) => c.name),
);
if (!markColumns.has("prompt")) db.exec("ALTER TABLE marks ADD COLUMN prompt TEXT");
// Set when a hand deletes a mark: the path is blanked, but the row (and its
// created_at) stays, so deleting never hands back the day's mark.
if (!markColumns.has("deleted_at")) db.exec("ALTER TABLE marks ADD COLUMN deleted_at INTEGER");
// The submission's retry token, so a retried POST after a lost response
// finds the mark it already made instead of making another. Never sent to
// any page.
if (!markColumns.has("nonce")) db.exec("ALTER TABLE marks ADD COLUMN nonce TEXT");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS marks_hand_nonce ON marks (hand_id, nonce) WHERE nonce IS NOT NULL;
  CREATE TABLE IF NOT EXISTS notes (
    mark_id INTEGER PRIMARY KEY REFERENCES marks(id),
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const MARK_FIELDS = "id, hand_id, path, colour, created_at, prompt";

const insertHandStmt = db.prepare(
  "INSERT INTO hands (id, name, colour, created_at) VALUES (?, ?, ?, ?)",
);
const getHandStmt = db.prepare("SELECT * FROM hands WHERE id = ?");
const insertMarkStmt = db.prepare(
  "INSERT INTO marks (hand_id, path, colour, created_at, prompt, nonce) VALUES (?, ?, ?, ?, ?, ?)",
);
const allMarksStmt = db.prepare(
  `SELECT ${MARK_FIELDS} FROM marks WHERE deleted_at IS NULL ORDER BY created_at ASC`,
);
// Deleted marks still count: the limit is on adding, not on keeping.
const latestMarkStmt = db.prepare("SELECT MAX(created_at) as t FROM marks WHERE hand_id = ?");
const markByNonceStmt = db.prepare(
  `SELECT ${MARK_FIELDS} FROM marks WHERE hand_id = ? AND nonce = ? AND deleted_at IS NULL`,
);
const ownMarksStmt = db.prepare(
  `SELECT ${MARK_FIELDS.split(", ").map((f) => `m.${f}`).join(", ")}, n.body AS note
   FROM marks m LEFT JOIN notes n ON n.mark_id = m.id
   WHERE m.hand_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC`,
);
const ownsMarkStmt = db.prepare(
  "SELECT 1 FROM marks WHERE id = ? AND hand_id = ? AND deleted_at IS NULL",
);
const upsertNoteStmt = db.prepare(
  `INSERT INTO notes (mark_id, body, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(mark_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
);
const deleteNoteStmt = db.prepare("DELETE FROM notes WHERE mark_id = ?");
const deleteMarkStmt = db.prepare(
  "UPDATE marks SET path = '', prompt = NULL, nonce = NULL, deleted_at = ? WHERE id = ?",
);

export function getHand(id: string): Hand | undefined {
  return getHandStmt.get(id) as unknown as Hand | undefined;
}

export function createHand(id: string, name: string, colour: string): Hand {
  const created_at = Date.now();
  insertHandStmt.run(id, name, colour, created_at);
  return { id, name, colour, created_at };
}

export function allMarks(): Mark[] {
  return allMarksStmt.all() as unknown as Mark[];
}

// "A day" is the 24 hours since a hand's last mark, not a calendar day: any
// calendar boundary (UTC midnight is 11am in Canberra) lets a hand mark twice
// in an hour across it, or refuses one that comes back "tomorrow" in its own
// time zone.
export const MARK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function msUntilNextMark(handId: string, now = Date.now()): number {
  const row = latestMarkStmt.get(handId) as unknown as { t: number | null };
  return row.t === null ? 0 : Math.max(0, row.t + MARK_INTERVAL_MS - now);
}

export function addMark(
  handId: string,
  path: string,
  colour: string,
  created_at = Date.now(),
  { prompt = null, nonce = null }: { prompt?: string | null; nonce?: string | null } = {},
): Mark {
  const result = insertMarkStmt.run(handId, path, colour, created_at, prompt, nonce);
  return { id: Number(result.lastInsertRowid), hand_id: handId, path, colour, created_at, prompt };
}

export function markByNonce(handId: string, nonce: string): Mark | undefined {
  return markByNonceStmt.get(handId, nonce) as unknown as Mark | undefined;
}

export function ownMarks(handId: string): OwnMark[] {
  return ownMarksStmt.all(handId) as unknown as OwnMark[];
}

const owns = (handId: string, markId: number) => ownsMarkStmt.get(markId, handId) !== undefined;

// A blank note deletes it. Returns false if the mark isn't this hand's.
export function setNote(handId: string, markId: number, body: string, now = Date.now()): boolean {
  if (!owns(handId, markId)) return false;
  if (body.trim() === "") deleteNoteStmt.run(markId);
  else upsertNoteStmt.run(markId, body, now);
  return true;
}

// Removes the drawing, its prompt and its note; keeps only when it was made.
export function deleteMark(handId: string, markId: number, now = Date.now()): boolean {
  if (!owns(handId, markId)) return false;
  deleteNoteStmt.run(markId);
  deleteMarkStmt.run(now, markId);
  return true;
}
