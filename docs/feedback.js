/* Feedback popout.
 *
 * Delivery is isolated to ENDPOINT below - swap that one string to change where
 * notes go. Notes are queued in localStorage first and flushed on send, so
 * nothing is lost if she is offline, or if the endpoint has not been configured
 * yet: the queue drains on her next visit once it has been.
 */
(function () {
  "use strict";

  /* ---- configure: paste your Formspree endpoint here ---- */
  var ENDPOINT = "";           // e.g. "https://formspree.io/f/xabcdefg"
  /* ------------------------------------------------------- */

  var KEY = "udesk.feedback.v1";
  var MAX = 2000;
  var open = false;
  var sending = false;
  var result = null;           // 'sent' | 'queued' | 'error'
  var draft = "";
  var root, panel, btn;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function readQueue() {
    try {
      var q = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(q)) return q;
    } catch (e) {}
    return [];
  }
  function writeQueue(q) {
    try { localStorage.setItem(KEY, JSON.stringify(q.slice(-50))); } catch (e) {}
  }

  /* What she was looking at, so a note like "this one looks wrong" is actionable
     without a round trip. Disclosed in the panel copy - not collected quietly. */
  function context() {
    var c = { screen: "unknown" };
    try {
      if (window.UDESK && window.UDESK.context) c = window.UDESK.context();
    } catch (e) {}
    return {
      screen: c.screen || "unknown",
      projected: c.projected == null ? "not measured yet" : c.projected + "/115",
      weakest: c.weakest || "not measured yet",
      answered: c.answered == null ? 0 : c.answered,
      viewport: window.innerWidth + "x" + window.innerHeight,
      agent: navigator.userAgent,
      page: location.href,
      at: new Date().toISOString(),
    };
  }

  function flush() {
    if (!ENDPOINT) return Promise.resolve(false);
    var q = readQueue();
    if (!q.length) return Promise.resolve(true);

    return q.reduce(function (chain, note) {
      return chain.then(function (okSoFar) {
        if (!okSoFar) return false;
        return fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            message: note.message,
            _subject: "Underwriting Desk feedback - " + note.ctx.screen,
            screen: note.ctx.screen,
            projected_score: note.ctx.projected,
            weakest_domain: note.ctx.weakest,
            questions_answered: note.ctx.answered,
            viewport: note.ctx.viewport,
            browser: note.ctx.agent,
            page: note.ctx.page,
            written_at: note.ctx.at,
          }),
        }).then(function (r) {
          if (!r.ok) return false;
          var rest = readQueue().filter(function (n) { return n.id !== note.id; });
          writeQueue(rest);
          return true;
        }).catch(function () { return false; });
      });
    }, Promise.resolve(true));
  }

  function submit() {
    var text = (panel.querySelector(".fb-text").value || "").trim();
    if (!text || sending) return;
    sending = true;
    result = null;
    paint();

    var q = readQueue();
    q.push({ id: uid(), message: text.slice(0, MAX), ctx: context() });
    writeQueue(q);

    flush().then(function (ok) {
      sending = false;
      draft = "";
      result = ok && ENDPOINT ? "sent" : "queued";
      paint();
      setTimeout(function () {
        if (result) { open = false; result = null; paint(); }
      }, 2600);
    });
  }

  /* ---- rendering ---- */
  function paint() {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    panel.hidden = !open;
    if (!open) return;

    if (result) {
      panel.innerHTML =
        '<div class="fb-done">' +
        '<div class="fb-tick" aria-hidden="true"></div>' +
        "<p>" +
        (result === "sent"
          ? "Sent. Thank you \u2014 that genuinely helps."
          : "Saved. It will go out as soon as there is a connection.") +
        "</p></div>";
      return;
    }

    panel.innerHTML =
      '<p class="eyebrow">Feedback</p>' +
      '<h3 class="fb-title">Send a note</h3>' +
      '<p class="fb-lede">Found a question that looks wrong, or something that will not work? ' +
      "This goes straight to whoever built it. Which screen you are on and how you are scoring " +
      "go along with it, so there is no need to explain where you were.</p>" +
      '<textarea class="fb-text" rows="4" maxlength="' + MAX + '" ' +
      'placeholder="What happened, or what looks off?"></textarea>' +
      '<div class="fb-row">' +
      '<span class="fb-count"></span>' +
      '<button class="btn fb-send" type="button">Send</button>' +
      "</div>";

    var ta = panel.querySelector(".fb-text");
    var count = panel.querySelector(".fb-count");
    var send = panel.querySelector(".fb-send");
    ta.value = draft;

    function sync() {
      draft = ta.value;
      var n = ta.value.trim().length;
      count.textContent = n ? n + " / " + MAX : "";
      send.disabled = !n || sending;
      send.textContent = sending ? "Sending\u2026" : "Send";
    }
    ta.addEventListener("input", sync);
    ta.addEventListener("keydown", function (e) {
      // the app binds 1-4 and Enter globally; keep those out of the textarea
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
    });
    send.addEventListener("click", submit);
    sync();
    ta.focus();
  }

  function toggle(next) {
    open = next === undefined ? !open : next;
    if (open) result = null;
    paint();
  }

  function mount() {
    root = document.createElement("div");
    root.className = "fb-root";

    btn = document.createElement("button");
    btn.className = "fb-btn";
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "Feedback";
    btn.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });

    panel = document.createElement("div");
    panel.className = "fb-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Send feedback");
    panel.hidden = true;
    panel.addEventListener("click", function (e) { e.stopPropagation(); });

    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    document.addEventListener("click", function () { if (open) toggle(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) { toggle(false); btn.focus(); }
    });

    // drain anything left over from a previous visit
    flush();
    window.addEventListener("online", flush);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
