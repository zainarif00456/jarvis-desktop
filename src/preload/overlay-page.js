// Runs in the Jarvis page itself (injected by src/preload/app.js with webFrame.executeJavaScript, after src/main/arrange.js).
// It adds the desktop behaviour the web client does not have, WITHOUT editing the web client (vendor/web stays byte for byte):
//
//  1. Janitor: a card whose command was interrupted / cancelled / never reported back must not stay "working" for ever; a
//     drag-ghost frame or pointer outline (the "static square") left behind by a lost pointer-up must not stay on screen; a panel stuck in its "forming" effect is finished.
//  2. Layout: while the page floats over other apps (html[data-jd-overlay]), every floating thing gets its own place on the
//     displays (src/main/arrange.js): tool / terminal cards and terminals on the primary display, presentations, briefings,
//     pictures and files on a second display when there is one. Nothing overlaps; leaving the overlay restores the page's own positions.
//
// DOM and WebSocket reads only. Nothing here talks to the server.
(function () {
  if (window.__jdOverlayPage) return;
  window.__jdOverlayPage = true;
  const doc = document;
  const RUN_MAX_MS = 180000;      // a card still "working" after this long is dismissed (the command was lost: interrupted, cancelled, server restarted)
  const DONE_NUDGE_MS = 25000;    // a finished card that is still on screen after this long gets its (possibly lost) pointer-leave
  const FORMING_MAX_MS = 3500;
  const GHOST_MS = 700;
  const ENDS = new Set(['turn_interrupted', 'turn_failed', 'session_reset']);   // after these, no running card can still be running

  // ---- 1a. what the server says: sniff the session socket (read only) --------------------------------------
  const NativeWS = window.WebSocket;
  let closeTimer = 0, endTimer = 0;
  const dismiss = (card) => { const b = card.querySelector('.xc-btn[aria-label="Dismiss"]'); if (b) b.click(); else card.remove(); };
  const dismissRunning = () => { for (const c of doc.querySelectorAll('#exec-layer .xc.running:not(.pinned)')) dismiss(c); };
  try {
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args) {
        const ws = new target(...args);
        try {
          if (!String(args[0]).includes('/ws/session')) return ws;
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return;
            const m = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/.exec(ev.data.slice(0, 120));
            if (m && ENDS.has(m[1])) { clearTimeout(endTimer); endTimer = setTimeout(dismissRunning, 900); }
          });
          ws.addEventListener('close', () => { clearTimeout(closeTimer); closeTimer = setTimeout(dismissRunning, 4000); });   // the server will never finish them now
        } catch { /* sniffing is optional */ }
        return ws;
      },
    });
  } catch { /* keep the native socket */ }

  // ---- 1b. janitor -----------------------------------------------------------------------------------------
  let buttons = 0, lastDown = 0;
  const track = (e) => { buttons = e.buttons; if (e.type === 'pointerdown') lastDown = Date.now(); };
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) window.addEventListener(t, track, true);
  const born = new WeakMap();
  const janitor = () => {
    const now = Date.now();
    for (const n of doc.querySelectorAll('#exec-layer .xc')) {
      let rec = born.get(n); if (!rec) { rec = { t: now, done: 0, nudged: false }; born.set(n, rec); }
      if (n.classList.contains('xc-parked') || n.classList.contains('pinned') || n.matches(':hover')) continue;
      if (n.classList.contains('running')) { if (now - rec.t > RUN_MAX_MS) dismiss(n); continue; }
      if (!rec.done) rec.done = now;
      if (!rec.nudged && now - rec.done > DONE_NUDGE_MS) { rec.nudged = true; n.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })); }   // un-sticks a "hovered" flag lost while the page moved between windows
    }
    const rt = doc.querySelector('.pt-reticle.on');   // the outline Jarvis draws around "this": left behind when the thing it framed was closed
    if (rt && !doc.querySelector('#hw-layer .hw:not(.minimised), .db-pop, #exec-layer .xc')) rt.classList.remove('on', 'lock');
    const g = doc.querySelector('.ws-ghost');
    if (g && !g.hidden && buttons === 0 && now - lastDown > GHOST_MS) g.hidden = true;
    for (const w of doc.querySelectorAll('.hw.forming')) {
      let rec = born.get(w); if (!rec) { rec = { t: now }; born.set(w, rec); }
      if (now - rec.t > FORMING_MAX_MS) { try { for (const a of w.getAnimations({ subtree: true })) a.finish(); } catch { /* none */ } w.classList.remove('forming'); w.querySelectorAll(':scope > .hw-form-scan').forEach((s) => s.remove()); }
    }
  };
  setInterval(janitor, 1000);

  // ---- 2. layout while floating ----------------------------------------------------------------------------
  const root = () => doc.documentElement;
  const touched = new Set(), saved = new WeakMap(), desired = new WeakMap(), ids = new WeakMap();
  let nextId = 1, wasOn = false;
  const idOf = (n) => { let i = ids.get(n); if (!i) { i = `n${nextId++}`; ids.set(n, i); } return i; };
  const put = (n, props) => {
    let o = saved.get(n); if (!o) { o = {}; saved.set(n, o); }
    let same = touched.has(n);
    for (const [p, v] of Object.entries(props)) {
      const pr = n.style.getPropertyPriority(p), cur = n.style.getPropertyValue(p);
      if (pr !== 'important') { o[p] = [cur, pr]; same = false; }   // the page (re)wrote it: that is its own value now, keep it for later
      else if (cur !== v) same = false;
    }
    if (same) return;
    for (const [p, v] of Object.entries(props)) n.style.setProperty(p, v, 'important');
    touched.add(n);
  };
  const restore = () => {
    for (const n of touched) {
      const o = saved.get(n); if (!o) continue;
      for (const [p, [v, pr]] of Object.entries(o)) { if (v) n.style.setProperty(p, v, pr); else n.style.removeProperty(p); }
    }
    touched.clear();
    window.dispatchEvent(new Event('resize'));   // the page re-places its own windows for the main window
  };
  doc.addEventListener('pointerdown', (e) => {   // a panel the owner grabs stays where they put it
    const w = e.target.closest && e.target.closest('.hw');
    if (w && root().hasAttribute('data-jd-overlay') && e.target.closest('.hw-bar, .hw-grip')) w.dataset.jdUser = '1';
  }, true);

  const readZones = () => { try { const z = JSON.parse(root().getAttribute('data-jd-zones') || 'null'); return Array.isArray(z) && z.length ? z : null; } catch { return null; } };
  const px = (v) => `${Math.round(v)}px`;
  const natural = (n) => {   // a card that knows its own shape (picture / video / camera card: data-jd-want="w,h") says so
    const want = (n.dataset.jdWant || '').split(',').map(Number);
    if (want.length === 2 && want.every((v) => v > 0)) return { w: want[0], h: want[1] };
    let d = desired.get(n); if (!d) { d = { w: n.offsetWidth || 480, h: n.offsetHeight || 320 }; desired.set(n, d); } return d;
  };
  // Full screen (a card's maximise / full button, or Jarvis's full_screen): the card fills the DISPLAY it was on (not the union of all displays), and gives its place back afterwards.
  const fullOn = new WeakMap();
  const unput = (n) => {
    const o = saved.get(n); if (!o) return;
    for (const [p, [v, pr]] of Object.entries(o)) { if (v) n.style.setProperty(p, v, pr); else n.style.removeProperty(p); }
    touched.delete(n);
  };
  const placeFull = (zones) => {
    for (const n of doc.querySelectorAll('#hw-layer .hw.max, #hw-layer .hw.is-full')) {
      let z = fullOn.get(n);
      if (!z) {
        const cx = (parseFloat(n.style.left) || 0) + (parseFloat(n.style.width) || 0) / 2, cy = (parseFloat(n.style.top) || 0) + (parseFloat(n.style.height) || 0) / 2;
        z = zones.find((q) => cx >= q.x && cx < q.x + q.w && cy >= q.y && cy < q.y + q.h) || zones[0]; fullOn.set(n, z);
      }
      put(n, { left: px(z.x), top: px(z.y), width: px(z.w), height: px(z.h), right: 'auto', bottom: 'auto' });
    }
    for (const n of [...touched]) if (fullOn.has(n) && !n.matches('.max, .is-full')) { fullOn.delete(n); unput(n); n.dispatchEvent(new CustomEvent('hw-resize')); }
  };

  function tick() {
    const on = !!root() && root().hasAttribute('data-jd-overlay');
    if (!on) { if (wasOn) { wasOn = false; restore(); } return; }
    wasOn = true;
    const zones = readZones() || [{ x: 0, y: 0, w: innerWidth, h: innerHeight, primary: true }];
    const items = [], apply = new Map();
    for (const n of doc.querySelectorAll('#exec-layer .xc:not(.xc-parked)')) {
      const id = idOf(n); items.push({ id, kind: 'card', w: n.offsetWidth || 360, h: n.offsetHeight || 120 });
      apply.set(id, (r) => put(n, { left: px(r.x), top: px(r.y) }));
    }
    for (const n of doc.querySelectorAll('#hw-layer .hw:not(.minimised):not(.k-debrief):not(.sheet):not(.max):not(.is-full)')) {
      if (n.dataset.jdUser) continue;
      const id = idOf(n), d = natural(n), term = n.classList.contains('k-terminal');
      items.push({ id, kind: 'portal', w: d.w, h: d.h, minW: 320, minH: 200, shrink: true, prefer: term ? 'primary' : 'secondary' });
      apply.set(id, (r) => put(n, { left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }));
    }
    for (const n of doc.querySelectorAll('.db-slot')) {   // the briefing / debrief / presentation card columns
      const pops = [...n.querySelectorAll(':scope > .db-pop')]; if (!pops.length) continue;
      const w = Math.max(...pops.map((p) => parseFloat(getComputedStyle(p).getPropertyValue('--w')) || 440), 300);
      const h = pops.reduce((s, p) => s + p.offsetHeight, 0) + 14 * (pops.length - 1);
      const id = idOf(n); items.push({ id, kind: 'portal', w, h: Math.max(h, 80), prefer: 'secondary' });
      apply.set(id, (r) => put(n, { left: px(r.x), top: px(r.y), width: px(w), height: px(Math.min(Math.max(h, 80), r.h)), right: 'auto', bottom: 'auto', 'padding-top': '0px' }));
    }
    for (const [sel, prefer] of [['#approval-pop', 'primary'], ['#briefing-pop', 'secondary']]) {
      const n = doc.querySelector(sel); if (!n || n.hidden) continue;
      const id = idOf(n); items.push({ id, kind: 'portal', w: n.offsetWidth || 460, h: n.offsetHeight || 200, prefer });
      apply.set(id, (r) => put(n, { left: px(r.x), top: px(r.y), right: 'auto', bottom: 'auto', transform: 'none' }));
    }
    placeFull(zones);
    const { rects } = window.JDArrange.arrange(zones, items);
    for (const [id, r] of Object.entries(rects)) { const f = apply.get(id); if (f) f(r); }
    for (const n of [...touched]) if (!n.isConnected) touched.delete(n);
  }
  setInterval(tick, 100);
  const watchFull = () => new MutationObserver(() => setTimeout(tick, 0)).observe(root(), { attributes: true, attributeFilter: ['data-jd-full'] });   // a card went full screen: place it now
  if (root()) watchFull(); else doc.addEventListener('DOMContentLoaded', watchFull, { once: true });
  window.addEventListener('resize', () => setTimeout(tick, 30));
})();
