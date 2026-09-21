import {
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { db, now } from "./db.ts";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

export const production = process.env.NODE_ENV === "production";
export const port = Number(process.env.PORT || 8080);
/** Single-user deployment: signups are closed once the account exists. */
export const allowSignup = process.env.ALLOW_SIGNUP !== "false";

const SESSION_COOKIE = "mlo_session";
const SESSION_DAYS = 90;
const KEYLEN = 64;

/* ---------------- passwords ---------------- */

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  // lengths always match here, but timingSafeEqual throws if they don't
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Minimum bar for a password on a public host. Deliberately not fussy about symbols. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  return null;
}

export function emailProblem(email: unknown): string | null {
  if (typeof email !== "string") return "Email is required.";
  const e = email.trim();
  if (e.length < 3 || e.length > 254 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e))
    return "Enter a valid email address.";
  return null;
}

/* ---------------- users ---------------- */

export async function createUser(email: string, password: string) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users(id,email,pwHash,createdAt) VALUES(?,?,?,?)",
  ).run(id, email.trim().toLowerCase(), await hashPassword(password), now());
  return id;
}

export function userByEmail(email: string) {
  return db
    .prepare("SELECT id,email,pwHash FROM users WHERE email=?")
    .get(email.trim().toLowerCase()) as
    | { id: string; email: string; pwHash: string }
    | undefined;
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
}

/* ---------------- sessions ---------------- */

export function startSession(res: Response, userId: string) {
  const id = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare(
    "INSERT INTO sessions(id,userId,createdAt,expiresAt) VALUES(?,?,?,?)",
  ).run(id, userId, now(), expires.toISOString());
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    expires,
    path: "/",
  });
}

export function endSession(req: Request, res: Response) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (id) db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function sessionUser(req: Request): { id: string; email: string } | null {
  const id = req.cookies?.[SESSION_COOKIE];
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, s.expiresAt
         FROM sessions s JOIN users u ON u.id = s.userId
        WHERE s.id = ?`,
    )
    .get(id) as { id: string; email: string; expiresAt: string } | undefined;
  if (!row) return null;
  if (row.expiresAt < now()) {
    db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    return null;
  }
  return { id: row.id, email: row.email };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const u = sessionUser(req);
  if (!u) {
    res.status(401).json({ error: "Sign in to sync your progress." });
    return;
  }
  req.user = u;
  db.prepare("UPDATE users SET lastSeenAt=? WHERE id=?").run(now(), u.id);
  next();
}
