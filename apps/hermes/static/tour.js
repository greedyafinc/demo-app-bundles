// ── First-run orientation tour ──────────────────────────────────────────────
// A lightweight, dependency-free coachmark tour that orients brand-new users to
// the Hermes layout. Inside UnifiedApp the app lands straight in a working chat
// (model pre-seeded, provider wizard skipped), so this is about ORIENTATION, not
// setup. Auto-shows once on a true first run over the empty chat, is skippable at
// any step, and is replayable via the `/tour` slash command.
//
// Loaded last (after boot.js) via <script defer>, so all globals it touches
// (t, api, S, ONBOARDING, showToast, the workspace helpers) already exist. The
// auto-start runs even later, polling until boot settles. Vanilla DOM only —
// no build step, CSP `connect-src 'self'` clean (the only network call is the
// same-origin POST /api/settings that records the "seen" flag).
//
// Persistence is SERVER-authoritative: boot.js seeds window._tutorialSeen from
// /api/settings, and persistSeen() writes it back with a keepalive POST (which
// completes even across a fast reload/unload). No localStorage backstop — that
// would mask an explicit server-side reset and diverge across devices.
(function () {
  'use strict';

  // ── safe accessors for cross-script globals ──────────────────────────────
  function tr(key, fallback) {
    try { var v = t(key); return (v === key && fallback != null) ? fallback : v; }
    catch (_) { return fallback != null ? fallback : key; }
  }
  function getS() { try { return S; } catch (_) { return (window.S || null); } }
  function onboardingActive() { try { return !!(ONBOARDING && ONBOARDING.active); } catch (_) { return false; } }
  function isSeen() { return window._tutorialSeen === true; }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false; // covers display:none cheaply (no getComputedStyle)
    // Only non-zero-rect elements reach getComputedStyle, so hidden fallbacks stay cheap.
    var cs;
    try { cs = getComputedStyle(el); } catch (_) { return true; } // can't introspect (restricted ctx) → assume shown
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false; // laid out but not actually shown
    // fixed-position elements report null offsetParent but are still visible.
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    return true;
  }
  // Resolve a step anchor: a selector string or an ordered list of fallbacks.
  // Returns the first visible match, or null when none can be shown.
  function resolveAnchor(anchor) {
    if (!anchor) return null;
    var sels = Array.isArray(anchor) ? anchor : [anchor];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (isVisible(el)) return el;
    }
    return null;
  }

  // ── step definitions ─────────────────────────────────────────────────────
  // anchor: null = centered welcome (full dim, no spotlight).
  // Step 4 points at whichever workspace affordance is visible; the file panel
  // can't be opened before a session exists, so we never force it open. On a
  // narrow/mobile layout where none is visible, the step is skipped gracefully.
  function buildSteps() {
    return [
      { anchor: null,
        title: tr('tour_step1_title', 'Welcome to Hermes'),
        body:  tr('tour_step1_body', "You're already connected to a live AI agent — no keys, no setup. Just type below to start.") },
      { anchor: ['#composerBox', '#msg'], // the whole rounded input box (textarea + buttons), not just the bare textarea
        title: tr('tour_step2_title', 'Ask anything'),
        body:  tr('tour_step2_body', 'Type your message here and press Enter. Hermes can read files, run tasks, and remember context.') },
      { anchor: '#composerModelChip',
        title: tr('tour_step3_title', 'Choose your model'),
        body:  tr('tour_step3_body', 'Pick which AI model answers you — switch any time, even mid-conversation.') },
      { anchor: ['#btnWorkspacePanelEdgeToggle', '#workspaceFilesTab', '#btnWorkspacePanelToggle'],
        title: tr('tour_step4_title', 'Your workspace'),
        body:  tr('tour_step4_body', 'Hermes can browse, read, and edit your project files. Open the workspace panel here anytime.') },
      { anchor: ['.rail .nav-tab[data-panel="tasks"]', '.sidebar-nav .nav-tab[data-panel="tasks"]'],
        title: tr('tour_step5_title', 'Work that runs itself'),
        body:  tr('tour_step5_body', 'Hermes can run jobs in the background and on a schedule — explore these under Tasks.') },
      { anchor: ['.rail .nav-tab[data-panel="settings"]', '.sidebar-nav .nav-tab[data-panel="settings"]'],
        title: tr('tour_step6_title', 'Make it yours'),
        body:  tr('tour_step6_body', "Themes, models, and more live in Settings. That's it — start chatting!") },
    ];
  }

  // ── tour state ─────────────────────────────────────────────────────────────
  // `gen` is a monotonic generation counter: every showStep()/finish() bumps it so
  // stale queued requestAnimationFrame callbacks from a superseded navigation bail
  // out instead of rendering the wrong step or skipping in the wrong direction.
  var ST = { active: false, idx: 0, gen: 0, steps: [], replay: false,
             overlay: null, highlight: null, bubble: null,
             elTitle: null, elBody: null, elProg: null, elBack: null, elNext: null,
             anchorEl: null, onResize: null, onKey: null, prevFocus: null,
             repoQueued: false, inerted: null };

  // Build the overlay + bubble ONCE; renderBubble() then updates text/visibility in
  // place per step. Button listeners are attached here (once), not rebuilt per step,
  // so navigation doesn't churn DOM or accumulate listeners.
  function buildDom() {
    var overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) finish(true); // click the dimmed area to dismiss
    });

    var highlight = document.createElement('div');
    highlight.className = 'tour-highlight';
    highlight.style.display = 'none';

    var bubble = document.createElement('div');
    bubble.className = 'tour-bubble';
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-modal', 'true');
    bubble.setAttribute('aria-labelledby', 'tourTitle');
    bubble.setAttribute('aria-describedby', 'tourBody');

    var h = document.createElement('h3'); h.id = 'tourTitle';
    var p = document.createElement('p'); p.id = 'tourBody';

    var foot = document.createElement('div'); foot.className = 'tour-foot';
    var prog = document.createElement('span'); prog.className = 'tour-progress';
    var actions = document.createElement('div'); actions.className = 'tour-actions';

    var skip = document.createElement('button');
    skip.type = 'button'; skip.className = 'tour-skip';
    skip.textContent = tr('tour_skip', 'Skip tour');
    skip.addEventListener('click', function () { finish(true); });

    var back = document.createElement('button');
    back.type = 'button'; back.className = 'tour-btn';
    back.textContent = tr('tour_back', 'Back');
    back.addEventListener('click', function () { go(-1); });

    var next = document.createElement('button');
    next.type = 'button'; next.className = 'tour-btn primary'; next.dataset.tourNext = '1';
    next.addEventListener('click', function () { (ST.idx >= ST.steps.length - 1) ? finish(true) : go(1); });

    actions.appendChild(skip); actions.appendChild(back); actions.appendChild(next);
    foot.appendChild(prog); foot.appendChild(actions);
    bubble.appendChild(h); bubble.appendChild(p); bubble.appendChild(foot);
    overlay.appendChild(highlight); overlay.appendChild(bubble);
    document.body.appendChild(overlay);

    ST.overlay = overlay; ST.highlight = highlight; ST.bubble = bubble;
    ST.elTitle = h; ST.elBody = p; ST.elProg = prog; ST.elBack = back; ST.elNext = next;
  }

  function renderBubble(step, i) {
    var isLast = i === ST.steps.length - 1;
    ST.elTitle.textContent = step.title;
    ST.elBody.textContent = step.body;
    ST.elProg.textContent = (i + 1) + ' / ' + ST.steps.length;
    ST.elBack.style.display = i > 0 ? '' : 'none';
    ST.elNext.textContent = isLast ? tr('tour_done', "You're all set") : tr('tour_next', 'Next');
  }

  // Modal semantics: hide everything behind the overlay from the accessibility tree
  // and tab order while the tour is open. `inert` (where supported) blocks both focus
  // and AT; `aria-hidden` is the resilient fallback. The offline banner is left
  // reachable on purpose, and the overlay itself is never hidden. Prior attribute
  // values are recorded so an explicit aria-hidden="false"/inert is restored exactly.
  function setBackgroundInert(on) {
    var body = document.body;
    if (!body) return;
    if (on) {
      ST.inerted = [];
      var kids = body.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el === ST.overlay) continue;
        if (el.id === 'offlineBanner' || (el.classList && el.classList.contains('offline-banner'))) continue;
        var prevAria = el.getAttribute ? el.getAttribute('aria-hidden') : null;
        if (prevAria === 'true') continue; // already hidden by someone else — leave it untouched
        ST.inerted.push({ el: el, prevAria: prevAria, prevInert: !!el.inert });
        try { el.setAttribute('aria-hidden', 'true'); } catch (_) {}
        try { el.inert = true; } catch (_) {}
      }
    } else if (ST.inerted) {
      ST.inerted.forEach(function (rec) {
        try { if (rec.prevAria == null) rec.el.removeAttribute('aria-hidden'); else rec.el.setAttribute('aria-hidden', rec.prevAria); } catch (_) {}
        try { rec.el.inert = rec.prevInert; } catch (_) {}
      });
      ST.inerted = null;
    }
  }

  function positionFor(anchorEl) {
    var b = ST.bubble, hl = ST.highlight, ov = ST.overlay;
    // clientWidth/Height exclude the scrollbar (unlike CSS 100vw / window.innerWidth),
    // so the bubble clamps against the real layout width and never overflows.
    var de = document.documentElement;
    var vw = (de && de.clientWidth) || window.innerWidth;
    var vh = (de && de.clientHeight) || window.innerHeight;
    var M = 12, GAP = 12, PAD = 6;
    // Re-validate at paint time: an anchor visible when the step opened can be hidden
    // by the time a resize/scroll reposition fires.
    var r = null;
    if (anchorEl) { r = anchorEl.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) r = null; }
    var bw = b.offsetWidth, bh = b.offsetHeight;

    if (!r) {
      // Centered welcome (or anchor no longer visible): full-screen dim, no spotlight.
      if (!ov.classList.contains('full')) ov.classList.add('full'); // guard avoids needless repaint
      hl.style.display = 'none';
      b.style.left = Math.max(M, (vw - bw) / 2) + 'px';
      b.style.top = Math.max(M, (vh - bh) / 2) + 'px';
      return;
    }
    if (ov.classList.contains('full')) ov.classList.remove('full');
    hl.style.display = 'block';
    hl.style.left = (r.left - PAD) + 'px';
    hl.style.top = (r.top - PAD) + 'px';
    hl.style.width = (r.width + PAD * 2) + 'px';
    hl.style.height = (r.height + PAD * 2) + 'px';

    // Prefer below the anchor; flip above when it would overflow the viewport.
    var top = r.bottom + GAP;
    if (top + bh > vh - M) {
      var above = r.top - GAP - bh;
      top = above >= M ? above : Math.max(M, Math.min(top, vh - bh - M));
    }
    var left = r.left + r.width / 2 - bw / 2;
    left = Math.max(M, Math.min(left, vw - bw - M));
    b.style.left = left + 'px';
    b.style.top = top + 'px';
  }

  // Coalesce resize/scroll repositioning to one layout pass per frame and re-resolve
  // the current step's anchor in case it moved or disappeared.
  function scheduleReposition() {
    if (!ST.active || ST.repoQueued) return;
    ST.repoQueued = true;
    requestAnimationFrame(function () {
      ST.repoQueued = false;
      if (!ST.active) return;
      try {
        var step = ST.steps[ST.idx];
        ST.anchorEl = step && step.anchor ? resolveAnchor(step.anchor) : null;
        positionFor(ST.anchorEl);
      } catch (_) {}
    });
  }

  function focusPrimary() {
    if (ST.elNext) try { ST.elNext.focus(); } catch (_) {}
  }

  // `dir` (+1 forward / -1 back) is passed per-call, not read from shared state, so
  // rapid opposite navigation can't make a queued callback skip the wrong way.
  function showStep(i, dir) {
    if (!ST.active) return;
    if (i < 0) i = 0;
    if (i >= ST.steps.length) { finish(true); return; }
    ST.idx = i;
    var step = ST.steps[i];
    var gen = ++ST.gen;
    // One frame so layout settles before we measure; the gen guard (not the frame
    // count) rejects callbacks superseded by a newer navigation. Wrapped so a render
    // throw in this async context can't orphan the inert background / listeners.
    requestAnimationFrame(function () {
      if (!ST.active || gen !== ST.gen) return;
      try {
        var el = step.anchor ? resolveAnchor(step.anchor) : null;
        if (step.anchor && !el) {
          // Target isn't on screen (e.g. a hidden nav tab) — skip in our direction.
          var nextI = i + (dir < 0 ? -1 : 1);
          if (nextI < 0 || nextI >= ST.steps.length) { finish(true); return; }
          showStep(nextI, dir);
          return;
        }
        renderBubble(step, i);
        ST.anchorEl = el;
        positionFor(el);
        focusPrimary();
      } catch (e) {
        try { console.warn('[tour] step render failed', e); } catch (_) {}
        finish(false); // tear down cleanly; don't record "seen" on an error
      }
    });
  }

  function go(delta) { showStep(ST.idx + delta, delta < 0 ? -1 : 1); }

  // Detach listeners, lift the inert background, and reset transient flags. Safe to
  // call from finish() OR the start() failure path (idempotent on already-clean state).
  function teardown() {
    if (ST.onResize) { window.removeEventListener('resize', ST.onResize); window.removeEventListener('scroll', ST.onResize, { capture: true }); }
    if (ST.onKey) document.removeEventListener('keydown', ST.onKey, true);
    ST.onResize = ST.onKey = ST.anchorEl = null;
    ST.repoQueued = false;
    try { setBackgroundInert(false); } catch (_) {}
    // Clear both classes (guarded): leaving 'full' behind would flash a full-screen
    // dim at the start of the next replay before positionFor() corrects it.
    if (ST.overlay) try { ST.overlay.classList.remove('active'); ST.overlay.classList.remove('full'); } catch (_) {}
  }

  function start(opts) {
    if (ST.active) return;
    // Don't stack on a higher-priority modal (the provider wizard or an app dialog):
    // two simultaneous focus traps fight over Tab/Escape. Replayable via /tour once
    // the modal closes.
    if (onboardingActive()) return;
    try { var _dlg = document.querySelector('.app-dialog-overlay'); if (_dlg && isVisible(_dlg)) return; } catch (_) {}
    opts = opts || {};
    // Wrap setup so a throw (e.g. appendChild on a missing/restricted document.body)
    // can't leave ST.active stuck true and permanently block future /tour invocations.
    try {
      ST.steps = buildSteps();
      // Build the overlay if it doesn't exist OR was detached from the document
      // (e.g. a body.innerHTML reset orphaned the cached node).
      if (!ST.overlay || !(document.body && document.body.contains(ST.overlay))) buildDom();
      // Capture the element to restore focus to on close — but never the body/html
      // (focus() is a no-op on them) nor a node inside our own overlay.
      var pf = document.activeElement;
      ST.prevFocus = (pf && pf !== document.body && pf !== document.documentElement && !ST.overlay.contains(pf)) ? pf : null;
      ST.replay = !!opts.replay;
      ST.idx = 0;
      ST.active = true; // set only after the DOM is ready, so a build failure leaves it false
      // Populate + place step 0 BEFORE revealing the overlay so the user never sees an
      // empty/mis-placed bubble for a frame (showStep's rAF re-renders idempotently).
      renderBubble(ST.steps[0], 0);
      ST.overlay.classList.add('active');
      positionFor(null); // step 0 is the centered welcome (no anchor)
      setBackgroundInert(true);

      ST.onResize = scheduleReposition;
      window.addEventListener('resize', ST.onResize);
      // capture so scrolls in inner containers also reposition; passive since we never
      // preventDefault (lets the browser keep the scroll thread optimized).
      window.addEventListener('scroll', ST.onResize, { capture: true, passive: true });

      ST.onKey = function (e) {
        if (!ST.active) return;
        // Wrapped so a focus() throw can't escape the listener and orphan it.
        try {
          // preventDefault (not stopPropagation): the tour swallows the key's default
          // action but lets background bubble-phase handlers still run.
          if (e.key === 'Escape') { e.preventDefault(); finish(true); return; }
          if (e.key === 'Tab') {
            // Only VISIBLE buttons are valid focus-cycle boundaries (Back is display:none
            // on step 1), so a wrap target is always actually focusable.
            var f = Array.prototype.filter.call(ST.bubble.querySelectorAll('button'), function (b) { return isVisible(b) && !b.disabled; });
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            // If focus escaped the bubble (e.g. Tab to a page element beneath the
            // overlay), pull it back. stopPropagation keeps focus management local.
            // Pull focus back if it's outside the bubble OR on a now-hidden button
            // (e.g. Back went display:none on a mid-Tab step change).
            if (f.indexOf(document.activeElement) === -1) { e.preventDefault(); e.stopPropagation(); first.focus(); return; }
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); e.stopPropagation(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); e.stopPropagation(); first.focus(); }
          }
        } catch (_) {}
      };
      document.addEventListener('keydown', ST.onKey, true);

      showStep(0, 1);
    } catch (e) {
      // Roll back fully so the feature can be retried rather than wedged.
      ST.active = false;
      teardown();
      try { console.warn('[tour] failed to start', e); } catch (_) {}
    }
  }

  function persistSeen() {
    window._tutorialSeen = true; // synchronous: blocks same-session re-trigger
    try {
      // keepalive lets the POST finish even if the page unloads/reloads right after,
      // so the server (the source of truth) records it without a localStorage backstop.
      // timeoutMs:0 disables api()'s default 30s abort (which would otherwise cancel a
      // slow-but-valid persist); timeoutToast:false keeps this background write silent.
      var p = api('/api/settings', { method: 'POST', body: JSON.stringify({ tutorial_seen: true }), keepalive: true, timeoutMs: 0, timeoutToast: false });
      if (p && typeof p.then === 'function') {
        p.then(null, function (e) { try { console.warn('[tour] could not persist tutorial_seen', e); } catch (_) {} });
      }
    } catch (e) { try { console.warn('[tour] settings POST threw', e); } catch (_) {} }
  }

  function finish(markSeen) {
    if (!ST.active) return; // idempotent: a second call (e.g. double dismiss) is a no-op
    ST.active = false;
    ST.gen++; // invalidate any pending rAF callbacks
    teardown();

    // Restore focus to the composer so the user can immediately start typing.
    var msg = document.getElementById('msg');
    // isVisible() doesn't check `disabled`; the composer is disabled mid-stream, where
    // focus() would be a silent no-op — so fall back to prevFocus in that case.
    var target = (msg && !msg.disabled && isVisible(msg)) ? msg : ST.prevFocus;
    if (target) try { target.focus(); } catch (_) {}
    ST.prevFocus = null;

    // Only the genuine first-run pass records the flag; /tour replay never does.
    if (markSeen && !ST.replay) persistSeen();
    ST.replay = false;
  }

  // ── auto-start on a true first run ───────────────────────────────────────
  // Cheap poll (boolean checks only — no layout reads) until boot settles. Keeps
  // waiting while the standalone provider wizard is up so the tour fires right after
  // it completes. Empty chat is signalled by the absence of a session.
  function initAutoStart() {
    var bootTries = 0, totalTries = 0;
    var timer = setInterval(function () {
      if (++totalTries > 3600) { clearInterval(timer); return; } // absolute ~30 min safety cap
      if (isSeen() || ST.active) { clearInterval(timer); return; }
      var s = getS();
      if (!s || !s._bootReady) {
        // Bound ONLY the wait for boot to settle (a hung /api/settings shouldn't poll forever).
        if (++bootTries > 240) clearInterval(timer); // ~2 min ceiling (cheap ticks)
        return;
      }
      // Boot is ready. Wait out the provider wizard (no per-phase ceiling — it can
      // legitimately stay open a while; the absolute cap above still bounds it) so the
      // tour fires once the user finishes it.
      if (onboardingActive()) return;
      if (s.session) { clearInterval(timer); return; } // a conversation is loaded — no tour
      clearInterval(timer);
      start({});                              // empty chat on a true first run
    }, 500);
  }

  // Public API: `/tour` (and the auto-start) call this.
  window.startTour = function (opts) { start(opts || {}); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAutoStart);
  else initAutoStart();
})();
