import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  db,
  now,
  pruneSessions,
  historyFor,
  examsFor,
  planFor,
} from "./db.ts";
import {
  allowSignup,
  createUser,
  emailProblem,
  endSession,
  passwordProblem,
  port,
  production,
  requireUser,
  sessionUser,
  startSession,
  userByEmail,
  userCount,
  verifyPassword,
} from "./auth.ts";

const distDir = resolve("./dist");
if (!existsSync(distDir)) {
  throw new Error("dist/ not found. Run `npm run build` before starting the server.");
}

pruneSessions();
setInterval(pruneSessions, 60 * 60 * 1000).unref();

const app = express();
app.set("trust proxy", 1); // behind nginx
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // no 'unsafe-inline' here - the build extracts the app's inline script
        // to app.js precisely so this can stay strict
        scriptSrc: ["'self'"],
        // the app renders style="" attributes through innerHTML, which CSP
        // treats as inline styles. Allowing them is a far smaller concession
        // than allowing inline script: a style attribute cannot execute code.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    // the app is same-origin only; this keeps the font CDN usable
    crossOriginEmbedderPolicy: false,
  }),
);

/* ---------------- rate limits ---------------- */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Wait 15 minutes and try again." },
});
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Syncing too often. Slow down." },
});

/* ---------------- auth ---------------- */

app.get("/api/me", (req, res) => {
  const u = sessionUser(req);
  res.json({
    user: u ? { email: u.email } : null,
    signupOpen: allowSignup && userCount() === 0,
  });
});

app.post("/api/signup", authLimiter, async (req, res) => {
  if (!allowSignup || userCount() > 0) {
    res.status(403).json({ error: "Signups are closed on this server." });
    return;
  }
  const { email, password } = req.body ?? {};
  const problem = emailProblem(email) || passwordProblem(password);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  if (userByEmail(email)) {
    res.status(409).json({ error: "That email is already registered." });
    return;
  }
  const id = await createUser(email, password);
  startSession(res, id);
  res.json({ user: { email: String(email).trim().toLowerCase() } });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }
  const user = userByEmail(email);
  // verify even when the user is missing so timing does not reveal accounts
  const ok = user
    ? await verifyPassword(password, user.pwHash)
    : await verifyPassword(password, "scrypt$00$00");
  if (!user || !ok) {
    res.status(401).json({ error: "That email and password do not match." });
    return;
  }
  startSession(res, user.id);
  res.json({ user: { email: user.email } });
});

app.post("/api/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

/* ---------------- state + sync ---------------- */

function stateFor(userId: string, email: string) {
  return {
    user: { email },
    hist: historyFor(userId),
    exams: examsFor(userId),
    plan: planFor(userId),
    serverTime: now(),
  };
}

app.get("/api/state", requireUser, (req, res) => {
  res.json(stateFor(req.user!.id, req.user!.email));
});

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isISO = (s: unknown) =>
  typeof s === "string" && s.length <= 32 && !Number.isNaN(Date.parse(s));

app.post("/api/sync", syncLimiter, requireUser, (req, res) => {
  const userId = req.user!.id;
  const { attempts, exams, plan } = req.body ?? {};

  if (attempts != null && (!Array.isArray(attempts) || attempts.length > 2000)) {
    res.status(400).json({ error: "Bad attempts payload." });
    return;
  }
  if (exams != null && (!Array.isArray(exams) || exams.length > 100)) {
    res.status(400).json({ error: "Bad exams payload." });
    return;
  }

  const insertAttempt = db.prepare(
    `INSERT INTO attempts(id,userId,questionId,correct,mode,answeredAt)
     VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  );
  const insertExam = db.prepare(
    `INSERT INTO exams(id,userId,score,raw,answered,byDomain,takenAt)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  );
  const upsertPlan = db.prepare(
    `INSERT INTO plans(userId,testDate,minutesPerDay,weekdays,done,updatedAt)
     VALUES(@userId,@testDate,@minutesPerDay,@weekdays,@done,@updatedAt)
     ON CONFLICT(userId) DO UPDATE SET
       testDate=excluded.testDate,
       minutesPerDay=excluded.minutesPerDay,
       weekdays=excluded.weekdays,
       done=excluded.done,
       updatedAt=excluded.updatedAt
     WHERE excluded.updatedAt > plans.updatedAt`,
  );

  let accepted = 0;
  const apply = db.transaction(() => {
    for (const a of attempts ?? []) {
      if (!a || !ID.test(String(a.id)) || !ID.test(String(a.questionId))) continue;
      if (!isISO(a.answeredAt)) continue;
      const mode = ["drill", "exam", "notebook"].includes(a.mode) ? a.mode : "drill";
      insertAttempt.run(
        String(a.id),
        userId,
        String(a.questionId),
        a.correct ? 1 : 0,
        mode,
        String(a.answeredAt),
      );
      accepted++;
    }
    for (const e of exams ?? []) {
      if (!e || !ID.test(String(e.id)) || !isISO(e.takenAt)) continue;
      insertExam.run(
        String(e.id),
        userId,
        Number(e.score) | 0,
        Number(e.raw) | 0,
        Number(e.answered) | 0,
        JSON.stringify(e.byDomain ?? {}),
        String(e.takenAt),
      );
    }
    if (
      plan &&
      typeof plan.testDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(plan.testDate) &&
      Array.isArray(plan.weekdays) &&
      isISO(plan.updatedAt)
    ) {
      upsertPlan.run({
        userId,
        testDate: plan.testDate,
        minutesPerDay: Math.min(600, Math.max(5, Number(plan.minutesPerDay) | 0)),
        weekdays: JSON.stringify(
          plan.weekdays.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6),
        ),
        done: JSON.stringify(plan.done ?? {}),
        updatedAt: plan.updatedAt,
      });
    }
  });
  apply();

  res.json({ ...stateFor(userId, req.user!.email), accepted });
});

/* ---------------- static site ---------------- */

app.use(
  express.static(distDir, {
    etag: true,
    lastModified: true,
    // small site, frequent content edits: always revalidate, serve 304s
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.use((_req, res) => {
  res.status(404).sendFile(resolve(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(
    `[mlo-prep] listening on :${port} (${production ? "production" : "development"}) db=${process.env.DATABASE_PATH || "./data/mloprep.sqlite"}`,
  );
  if (userCount() === 0) {
    console.log("[mlo-prep] no account yet - the first visitor can sign up, or run `npm run user:create`");
  }
});
