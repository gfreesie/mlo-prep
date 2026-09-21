/* Offline-first sync for the self-hosted build.
 *
 * localStorage stays the working copy, so the app behaves identically with no
 * network. Every answer is also appended to a local outbox; the outbox is
 * flushed to the server when it can be reached. Attempts carry a client-made
 * id, so re-sending is harmless - the server dedupes on primary key.
 *
 * The server derives mastery by replaying the attempt log, so after a flush its
 * history is authoritative and replaces the local copy. That is what makes two
 * devices converge instead of fighting.
 *
 * This file is only included in the self-hosted build. The published artifact
 * has no server to talk to and runs purely on localStorage.
 */
(function () {
  "use strict";

  var OUTBOX = "udesk.outbox.v1";
  var FLUSH_MS = 8000;
  var state = { user: null, signupOpen: false, status: "offline", pending: 0 };
  var flushTimer = null;
  var inFlight = false;

  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function readOutbox() {
    try {
      var o = JSON.parse(localStorage.getItem(OUTBOX));
      if (o && Array.isArray(o.attempts)) return o;
    } catch (e) {}
    return { attempts: [], exams: [] };
  }
  function writeOutbox(o) {
    try {
      localStorage.setItem(OUTBOX, JSON.stringify(o));
    } catch (e) {}
    state.pending = o.attempts.length + o.exams.length;
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, opts))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) throw Object.assign(new Error(body.error || "Request failed"), { status: r.status, body: body });
          return body;
        });
      });
  }
  function setStatus(s) {
    state.status = s;
    if (window.UDESK && window.UDESK.onSyncChange) window.UDESK.onSyncChange(state);
  }

  /* ---- merging server state into the local store ---- */
  function applyServerState(srv) {
    if (!window.UDESK) return;
    var local = window.UDESK.getState();

    // history: the server replayed every attempt, so it wins outright
    local.hist = srv.hist || {};

    // exams: union by id, ordered by time
    var seen = {};
    var merged = [];
    (srv.exams || []).forEach(function (e) {
      if (seen[e.id]) return;
      seen[e.id] = 1;
      merged.push({ id: e.id, date: new Date(e.takenAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), score: e.score, answered: e.answered, takenAt: e.takenAt });
    });
    local.exams = merged;

    // plan: newest updatedAt wins
    if (srv.plan) {
      var lp = local.plan;
      if (!lp || !lp.updatedAt || srv.plan.updatedAt > lp.updatedAt) {
        local.plan = {
          testDate: srv.plan.testDate,
          minutesPerDay: srv.plan.minutesPerDay,
          weekdays: srv.plan.weekdays,
          done: srv.plan.done || {},
          updatedAt: srv.plan.updatedAt,
        };
      }
    }
    window.UDESK.setState(local);
  }

  /* ---- flushing ---- */
  function flush(force) {
    if (inFlight || !state.user) return Promise.resolve();
    var out = readOutbox();
    var localPlan = window.UDESK ? window.UDESK.getState().plan : null;
    if (!force && !out.attempts.length && !out.exams.length) return Promise.resolve();

    inFlight = true;
    setStatus("syncing");
    var payload = {
      attempts: out.attempts.slice(0, 2000),
      exams: out.exams.slice(0, 100),
      plan: localPlan && localPlan.updatedAt ? localPlan : null,
    };
    return api("/api/sync", { method: "POST", body: JSON.stringify(payload) })
      .then(function (srv) {
        // drop exactly what we sent; anything queued meanwhile survives
        var sentA = {}, sentE = {};
        payload.attempts.forEach(function (a) { sentA[a.id] = 1; });
        payload.exams.forEach(function (e) { sentE[e.id] = 1; });
        var fresh = readOutbox();
        fresh.attempts = fresh.attempts.filter(function (a) { return !sentA[a.id]; });
        fresh.exams = fresh.exams.filter(function (e) { return !sentE[e.id]; });
        writeOutbox(fresh);
        applyServerState(srv);
        setStatus("synced");
      })
      .catch(function (err) {
        if (err.status === 401) {
          state.user = null;
          setStatus("signed-out");
        } else {
          setStatus("offline");
        }
      })
      .finally(function () { inFlight = false; });
  }
  function schedule() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(false); }, 1200);
  }

  /* ---- public surface used by the app ---- */
  window.SYNC = {
    state: function () { return state; },

    attempt: function (questionId, correct, mode) {
      var o = readOutbox();
      o.attempts.push({ id: uid(), questionId: questionId, correct: correct ? 1 : 0, mode: mode || "drill", answeredAt: new Date().toISOString() });
      if (o.attempts.length > 5000) o.attempts = o.attempts.slice(-5000);
      writeOutbox(o);
      if (state.user) schedule();
    },

    exam: function (result) {
      var o = readOutbox();
      o.exams.push({ id: uid(), score: result.score, raw: result.raw, answered: result.answered, byDomain: result.byDomain, takenAt: new Date().toISOString() });
      writeOutbox(o);
      if (state.user) schedule();
    },

    touch: function () { if (state.user) schedule(); },
    flushNow: function () { return flush(true); },

    signup: function (email, password) {
      return api("/api/signup", { method: "POST", body: JSON.stringify({ email: email, password: password }) })
        .then(function (r) { state.user = r.user; state.signupOpen = false; setStatus("syncing"); return flush(true); });
    },
    login: function (email, password) {
      return api("/api/login", { method: "POST", body: JSON.stringify({ email: email, password: password }) })
        .then(function (r) { state.user = r.user; setStatus("syncing"); return flush(true); });
    },
    logout: function () {
      return api("/api/logout", { method: "POST" }).finally(function () {
        state.user = null;
        setStatus("signed-out");
        if (window.UDESK) window.UDESK.rerender();
      });
    },

    init: function () {
      state.pending = readOutbox().attempts.length + readOutbox().exams.length;
      return api("/api/me", { method: "GET" })
        .then(function (r) {
          state.user = r.user;
          state.signupOpen = r.signupOpen;
          if (r.user) { setStatus("syncing"); return flush(true); }
          setStatus("signed-out");
        })
        .catch(function () { setStatus("offline"); });
    },
  };

  window.addEventListener("online", function () { flush(false); });
  setInterval(function () { flush(false); }, FLUSH_MS * 4);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") flush(false);
  });
})();
