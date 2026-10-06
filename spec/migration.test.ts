import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// A database exactly as the live app left it before the sketchbook (the
// schema src/db.ts created at 0b60b87), opened by today's src/db.ts: every
// old mark survives, gains the new columns empty, and still counts toward
// its hand's daily limit. A redeploy onto the Fly volume does exactly this.
const dbPath = join(mkdtempSync(join(tmpdir(), "trace-migrate-")), "trace.db");
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE hands (id TEXT PRIMARY KEY, name TEXT NOT NULL, colour TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id TEXT NOT NULL REFERENCES hands(id),
    path TEXT NOT NULL,
    colour TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
const now = Date.now();
old.prepare("INSERT INTO hands VALUES (?, ?, ?, ?)").run("old-hand", "quiet-heron", "#cc4a28", now - 1000);
old.prepare("INSERT INTO marks (hand_id, path, colour, created_at) VALUES (?, ?, ?, ?)").run(
  "old-hand",
  "M1,1 L2,2",
  "#cc4a28",
  now - 1000,
);
old.close();

process.env.DB_PATH = dbPath;

it("keeps every existing mark, with the new fields empty", async () => {
  const db = await import("../src/db.ts");
  expect(db.allMarks()).toEqual([
    { id: 1, hand_id: "old-hand", path: "M1,1 L2,2", colour: "#cc4a28", created_at: now - 1000, prompt: null },
  ]);
  expect(db.ownMarks("old-hand")).toMatchObject([{ id: 1, note: null }]);
  // The old mark still spends today's allowance.
  expect(db.msUntilNextMark("old-hand")).toBeGreaterThan(0);
  // And the new features work on it.
  expect(db.setNote("old-hand", 1, "from before the notes existed")).toBe(true);
  expect(db.ownMarks("old-hand")[0].note).toBe("from before the notes existed");
});

it("is safe to run again on an already-migrated database", async () => {
  vi.resetModules();
  const db = await import("../src/db.ts");
  expect(db.allMarks().length).toBe(1);
  expect(db.ownMarks("old-hand")[0].note).toBe("from before the notes existed");
});
