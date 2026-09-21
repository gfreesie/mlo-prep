/* End-to-end smoke test against a running server on a throwaway database.
 * Usage:  DATABASE_PATH=./data/smoke.sqlite npx tsx server/index.ts
 *         node scripts/smoke.mjs
 */
const BASE = process.env.BASE || "http://localhost:8789";
let cookie = "";
let pass = 0,
  fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? "  -> " + JSON.stringify(detail) : ""}`);
  }
}

async function call(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}

const iso = (min) => new Date(Date.now() - min * 60000).toISOString();

console.log("smoke test ->", BASE);

// --- validation runs before any account exists ---
let r = await call("/api/signup", {
  method: "POST",
  body: JSON.stringify({ email: "her@example.com", password: "short" }),
});
check("short password rejected", r.status === 400 && /10 characters/.test(r.body?.error || ""), r.body);

r = await call("/api/signup", {
  method: "POST",
  body: JSON.stringify({ email: "not-an-email", password: "a-good-long-password" }),
});
check("bad email rejected", r.status === 400, r.body);

// --- signup ---
r = await call("/api/signup", {
  method: "POST",
  body: JSON.stringify({ email: "Her@Example.com", password: "a-good-long-password" }),
});
check("signup succeeds", r.status === 200 && r.body?.user?.email === "her@example.com", r.body);
check("email normalised to lowercase", r.body?.user?.email === "her@example.com");

r = await call("/api/signup", {
  method: "POST",
  body: JSON.stringify({ email: "second@example.com", password: "a-good-long-password" }),
});
check("second signup blocked", r.status === 403, r.body);

// --- sync: attempts replay into history ---
const attempts = [
  { id: "a1", questionId: "F01", correct: 0, mode: "exam", answeredAt: iso(50) },
  { id: "a2", questionId: "F01", correct: 1, mode: "drill", answeredAt: iso(40) },
  { id: "a3", questionId: "F01", correct: 1, mode: "drill", answeredAt: iso(30) },
  { id: "a4", questionId: "G10", correct: 0, mode: "exam", answeredAt: iso(20) },
];
r = await call("/api/sync", { method: "POST", body: JSON.stringify({ attempts }) });
check("sync accepts attempts", r.status === 200 && r.body?.accepted === 4, r.body);

const f01 = r.body?.hist?.F01;
check("F01 replayed: 3 attempts, 2 correct", f01?.a === 3 && f01?.c === 2, f01);
check("F01 ever-missed flag set", f01?.ever === 1, f01);
check("F01 streak is 2 (cleared)", f01?.streak === 2, f01);
const g10 = r.body?.hist?.G10;
check("G10 still owed (streak 0, ever 1)", g10?.streak === 0 && g10?.ever === 1, g10);

// --- idempotency: resending the same ids changes nothing ---
r = await call("/api/sync", { method: "POST", body: JSON.stringify({ attempts }) });
check("resend is idempotent", r.body?.hist?.F01?.a === 3, r.body?.hist?.F01);

// --- exams ---
r = await call("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    exams: [{ id: "e1", score: 71, raw: 74, answered: 120, byDomain: { eth: { r: 9, n: 22 } }, takenAt: iso(60) }],
  }),
});
check("exam stored", r.body?.exams?.length === 1 && r.body.exams[0].score === 71, r.body?.exams);
check("exam byDomain round-trips", r.body?.exams?.[0]?.byDomain?.eth?.n === 22, r.body?.exams?.[0]);

// --- plan: last write wins ---
r = await call("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    plan: { testDate: "2026-10-15", minutesPerDay: 60, weekdays: [1, 2, 3, 4, 5, 6], done: { "2026-09-22.0": true }, updatedAt: iso(10) },
  }),
});
check("plan stored", r.body?.plan?.testDate === "2026-10-15", r.body?.plan);

r = await call("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    plan: { testDate: "2026-11-01", minutesPerDay: 120, weekdays: [1, 3, 5], done: {}, updatedAt: iso(99) },
  }),
});
check("older plan does NOT overwrite newer", r.body?.plan?.testDate === "2026-10-15", r.body?.plan);

r = await call("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    plan: { testDate: "2026-11-01", minutesPerDay: 120, weekdays: [1, 3, 5], done: {}, updatedAt: iso(1) },
  }),
});
check("newer plan does overwrite", r.body?.plan?.testDate === "2026-11-01", r.body?.plan);
check("weekdays round-trip as array", Array.isArray(r.body?.plan?.weekdays) && r.body.plan.weekdays.length === 3, r.body?.plan);

// --- malformed input is dropped, not fatal ---
r = await call("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    attempts: [
      { id: "bad id with spaces", questionId: "F01", correct: 1, answeredAt: iso(5) },
      { id: "ok1", questionId: "F01", correct: 1, answeredAt: "not-a-date" },
      { id: "ok2", questionId: "U01", correct: 1, mode: "nonsense", answeredAt: iso(5) },
    ],
  }),
});
check("malformed attempts skipped, valid one kept", r.status === 200 && r.body?.accepted === 1, r.body?.accepted);
check("unknown mode coerced, not rejected", !!r.body?.hist?.U01, r.body?.hist?.U01);

// --- auth boundaries ---
const saved = cookie;
cookie = "";
r = await call("/api/state");
check("state requires auth", r.status === 401, r.body);
r = await call("/api/sync", { method: "POST", body: JSON.stringify({ attempts: [] }) });
check("sync requires auth", r.status === 401, r.body);
cookie = saved;

// --- login/logout ---
r = await call("/api/logout", { method: "POST" });
check("logout ok", r.status === 200);
cookie = "";
r = await call("/api/login", {
  method: "POST",
  body: JSON.stringify({ email: "her@example.com", password: "wrong-password-here" }),
});
check("wrong password rejected", r.status === 401, r.body);
r = await call("/api/login", {
  method: "POST",
  body: JSON.stringify({ email: "her@example.com", password: "a-good-long-password" }),
});
check("login succeeds", r.status === 200, r.body);
r = await call("/api/state");
check("history survived logout/login", r.body?.hist?.F01?.a === 3, r.body?.hist?.F01);

// --- static site is served ---
const page = await fetch(BASE + "/");
const html = await page.text();
check("index.html served", page.status === 200 && html.includes("<!doctype html>"), page.status);
check("page has charset", /<meta charset="utf-8">/i.test(html));
check("bank scripts referenced", /bank-6\.js/.test(html));
check("sync.js referenced", /sync\.js/.test(html));
const csp = page.headers.get("content-security-policy") || "";
check("CSP present without unsafe-inline scripts", csp.includes("script-src 'self'") && !csp.includes("script-src 'self' 'unsafe-inline'"), csp.slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
