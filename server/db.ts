import "dotenv/config";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const databasePath = resolve(
  process.env.DATABASE_PATH || "./data/mloprep.sqlite",
);
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
 CREATE TABLE IF NOT EXISTS users(
   id TEXT PRIMARY KEY,
   email TEXT NOT NULL UNIQUE,
   pwHash TEXT NOT NULL,
   createdAt TEXT NOT NULL,
   lastSeenAt TEXT
 );
 CREATE TABLE IF NOT EXISTS sessions(
   id TEXT PRIMARY KEY,
   userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   createdAt TEXT NOT NULL,
   expiresAt TEXT NOT NULL
 );
 -- append-only event log; the client generates the id so re-sending is idempotent
 CREATE TABLE IF NOT EXISTS attempts(
   id TEXT PRIMARY KEY,
   userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   questionId TEXT NOT NULL,
   correct INTEGER NOT NULL,
   mode TEXT NOT NULL DEFAULT 'drill',
   answeredAt TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS exams(
   id TEXT PRIMARY KEY,
   userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   score INTEGER NOT NULL,
   raw INTEGER NOT NULL,
   answered INTEGER NOT NULL,
   byDomain TEXT NOT NULL,
   takenAt TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS plans(
   userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
   testDate TEXT NOT NULL,
   minutesPerDay INTEGER NOT NULL,
   weekdays TEXT NOT NULL,
   done TEXT NOT NULL,
   updatedAt TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS attempts_user ON attempts(userId, answeredAt);
 CREATE INDEX IF NOT EXISTS attempts_user_q ON attempts(userId, questionId);
 CREATE INDEX IF NOT EXISTS exams_user ON exams(userId, takenAt);
 CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
`);

export const now = () => new Date().toISOString();

/** Drop expired sessions. Cheap enough to call on boot and hourly. */
export function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expiresAt < ?").run(now());
}

export type Hist = Record<
  string,
  { a: number; c: number; last: 0 | 1; streak: number; ever: 0 | 1 }
>;

/**
 * Replay the attempt log into the same shape the client keeps in localStorage.
 * Deriving rather than storing means the server and client can never disagree
 * about what "cleared" means - there is one implementation of the rule.
 */
export function historyFor(userId: string): Hist {
  const rows = db
    .prepare(
      "SELECT questionId, correct FROM attempts WHERE userId=? ORDER BY answeredAt ASC, id ASC",
    )
    .all(userId) as { questionId: string; correct: number }[];

  const hist: Hist = {};
  for (const r of rows) {
    const h = (hist[r.questionId] ||= { a: 0, c: 0, last: 0, streak: 0, ever: 0 });
    h.a++;
    if (r.correct) {
      h.c++;
      h.streak++;
      h.last = 1;
    } else {
      h.streak = 0;
      h.ever = 1;
      h.last = 0;
    }
  }
  return hist;
}

export function examsFor(userId: string) {
  return (
    db
      .prepare(
        "SELECT id, score, raw, answered, byDomain, takenAt FROM exams WHERE userId=? ORDER BY takenAt ASC",
      )
      .all(userId) as {
      id: string;
      score: number;
      raw: number;
      answered: number;
      byDomain: string;
      takenAt: string;
    }[]
  ).map((e) => ({ ...e, byDomain: JSON.parse(e.byDomain) }));
}

export function planFor(userId: string) {
  const p = db.prepare("SELECT * FROM plans WHERE userId=?").get(userId) as
    | {
        testDate: string;
        minutesPerDay: number;
        weekdays: string;
        done: string;
        updatedAt: string;
      }
    | undefined;
  if (!p) return null;
  return {
    testDate: p.testDate,
    minutesPerDay: p.minutesPerDay,
    weekdays: JSON.parse(p.weekdays),
    done: JSON.parse(p.done),
    updatedAt: p.updatedAt,
  };
}
