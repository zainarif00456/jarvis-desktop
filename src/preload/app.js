'use strict';
// Runs in every window. On the Jarvis page (gateway origin): reads the mute button, performs hotkey/tray mute by
// clicking the real #s-mute button, and shows a thin "server unreachable" banner. It never touches page code.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

if (location.protocol === 'file:') {
  // Settings / first-run page: a small explicit API (the page itself is ours, not the server's).
  const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
  contextBridge.exposeInMainWorld('jd', {
    get: () => inv('settings:get'), test: (u) => inv('settings:test', u), save: (p) => inv('settings:save', p),
    pair: (o) => inv('settings:pair', o), forget: (u) => inv('settings:forget', u), openApp: () => inv('settings:open-app'),
    onStatus: (fn) => ipcRenderer.on('desktop:status', (_e, s) => fn(s)),
    audioDevices: () => inv('settings:audio-devices'),
  });
} else {
  // Audio policy for the page (microphone / speaker choice, recovery when Bluetooth devices come and go): see src/preload/audio-shim.js.
  try {
    const src = ipcRenderer.sendSync('desktop:audio-shim');
    if (src) {
      contextBridge.exposeInMainWorld('__jdHost', {
        getConfig: () => ipcRenderer.invoke('desktop:audio-config'),
        log: (m) => ipcRenderer.send('desktop:audio-log', String(m).slice(0, 300)),
        onConfig: (fn) => { ipcRenderer.on('desktop:audio-config-changed', () => fn()); },
      });
      webFrame.executeJavaScript(src);
    }
  } catch { /* the page then uses the system default devices */ }
  // The native browser of Development Mode (src/main/devbrowser/): the Jarvis page asks for it, the shell drives it.
  contextBridge.exposeInMainWorld('jarvisBrowser', {
    version: 1,
    call: (op, args) => ipcRenderer.invoke('jarvis-browser:call', op, args),
    setBounds: (rect) => ipcRenderer.send('jarvis-browser:bounds', rect),
    onEvent: (fn) => { ipcRenderer.on('jarvis-browser:event', (_e, ev) => fn(ev)); },
  });
  // Panes in their own OS windows, and the whole window full screen (src/main/devwindows/): the Jarvis page asks, the shell does it.
  contextBridge.exposeInMainWorld('jarvisDev', {
    version: 1,
    openWindow: (pane, opts) => ipcRenderer.invoke('jarvis-dev:open', pane, opts),
    closeWindow: (pane) => ipcRenderer.invoke('jarvis-dev:close', pane),
    windows: () => ipcRenderer.invoke('jarvis-dev:list'),
    onWindowClosed: (fn) => { ipcRenderer.on('jarvis-dev:window-closed', (_e, pane) => fn(pane)); },
    setFullScreen: (on) => ipcRenderer.send('jarvis-dev:fullscreen', !!on),
    onFullScreen: (fn) => { ipcRenderer.on('jarvis-dev:fullscreen', (_e, on) => fn(!!on)); },
  });
  // Janitor (stuck cards, stale drag frame) and per-display layout of the floating cards: src/preload/overlay-page.js, run inside the page.
  try { const src = ipcRenderer.sendSync('desktop:overlay-page'); if (src) webFrame.executeJavaScript(src); } catch { /* the page then lays itself out */ }
  ipcRenderer.on('desktop:overlay-zones', (_e, z) => {   // the displays, in window coordinates (read by the page script)
    const set = () => document.documentElement.setAttribute('data-jd-zones', JSON.stringify(z));
    if (document.documentElement) set(); else window.addEventListener('DOMContentLoaded', set, { once: true });
  });
  let btn = null, last = '';
  const report = () => {
    btn = document.getElementById('s-mute'); if (!btn) return;
    const s = { muted: btn.getAttribute('aria-pressed') === 'true', enabled: !btn.disabled && btn.offsetParent !== null };
    const k = JSON.stringify(s); if (k !== last) { last = k; ipcRenderer.send('desktop:mute-state', s); }
  };
  ipcRenderer.on('desktop:toggle-mute', () => {
    const b = document.getElementById('s-mute');
    if (!b) return ipcRenderer.send('desktop:mute-result', { done: false, reason: 'no mute button' });
    if (b.disabled || b.offsetParent === null) return ipcRenderer.send('desktop:mute-result', { done: false, reason: 'not in a call' });
    b.click();
    setTimeout(() => { report(); ipcRenderer.send('desktop:mute-result', { done: true, muted: b.getAttribute('aria-pressed') === 'true' }); }, 60);
  });

  let bar = null;
  const showBar = (st) => {
    const bad = st && st.state !== 'ok' && st.state !== 'unknown';
    const warn = st && st.state === 'ok' && st.versionMismatch;
    if (!bad && !warn) { if (bar) bar.style.display = 'none'; return; }
    if (!bar) {
      bar = document.createElement('div');
      Object.assign(bar.style, { position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647', padding: '6px 12px', font: '12px system-ui,sans-serif', textAlign: 'center', color: '#fff', cursor: 'pointer' });
      bar.title = 'Click to open Settings';
      bar.addEventListener('click', () => ipcRenderer.send('desktop:open-settings'));
      document.documentElement.appendChild(bar);
    }
    bar.style.display = 'block';
    bar.style.background = bad ? '#b42318' : '#9a6700';
    bar.textContent = bad ? 'Jarvis server unreachable. Reconnecting automatically. Click to edit the address.'
      : 'Server and desktop UI versions differ. Re-vendor the UI (see README) if something looks off.';
  };
  ipcRenderer.on('desktop:status', (_e, st) => showBar(st));

  // ---- hologram overlay support (see src/main/overlay.js) -------------------------------------------------
  // Tells the shell when the deck has something on it, and while the page floats over other apps, which rectangles are
  // portals (the window takes the mouse only while the cursor is over one). Reads the page, never changes it.
  // Portals and live execution cards are the overlay. The orb/shared-file rail is part of the
  // voice stage and must stay inside the app; in particular #holo is not a portal.
  // (the debrief window is a full-screen frameless host: only its cards count; minimised-window chips are not shown while floating)
  const SOLID = '#hw-layer .hw:not(.minimised):not(.k-debrief), #hw-layer .db-pop, #exec-layer .xc:not(.xc-parked), #exec-layer .xl-ticker:not([hidden]), #briefing-pop:not([hidden]), #approval-pop:not([hidden])';
  const ACTIVE = SOLID;
  let floating = false, active = null, rectKey = '';
  const deckActive = () => !!document.querySelector(ACTIVE);
  const rects = () => {
    const out = [];
    for (const n of document.querySelectorAll(SOLID)) {
      if (n.id === 'holo' && getComputedStyle(n).pointerEvents === 'none') continue;
      const r = n.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const pad = 10;
      const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
      out.push({ x, y, w: Math.min(innerWidth, r.right + pad) - x, h: Math.min(innerHeight, r.bottom + pad) - y });
    }
    return out;
  };
  const pump = () => {
    const a = deckActive();
    if (a !== active) { active = a; ipcRenderer.send('desktop:deck-active', a); }
    if (floating) { const r = rects(); const k = JSON.stringify(r.map((q) => [q.x, q.y, q.w, q.h].map(Math.round))); if (k !== rectKey) { rectKey = k; ipcRenderer.send('desktop:overlay-rects', r); } }
  };
  setInterval(pump, 80);
  ipcRenderer.on('desktop:overlay-mode', (_e, on) => {
    floating = !!on; rectKey = '';
    if (on) document.documentElement.setAttribute('data-jd-overlay', ''); else document.documentElement.removeAttribute('data-jd-overlay');
    pump();
  });
  // A button went down on a portal (the window is taking the mouse): keep taking it until released, even if a drag leaves the portal.
  window.addEventListener('pointerdown', () => { if (floating) ipcRenderer.send('desktop:overlay-pressed', true); }, true);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => { if (floating) ipcRenderer.send('desktop:overlay-pressed', false); }, true);
  // Full screen of a card (the page sets data-jd-full while one is full): the shell makes the window / the display's overlay follow.
  // data-jd-desktop tells the page not to use HTML fullscreen (it would not work over other apps).
  ipcRenderer.on('desktop:escape', () => {   // Esc while a card is full screen over other apps (grabbed by the shell, the overlay has no keyboard focus)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  let fullNow = false;
  const syncFull = () => { const on = document.documentElement.hasAttribute('data-jd-full'); if (on !== fullNow) { fullNow = on; ipcRenderer.send('desktop:full', on); } };
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('data-jd-desktop', '');
    new MutationObserver(syncFull).observe(document.documentElement, { attributes: true, attributeFilter: ['data-jd-full'] });
    report();
    const t = document.getElementById('s-mute');
    if (t) new MutationObserver(report).observe(t, { attributes: true, attributeFilter: ['aria-pressed', 'disabled'] });
    ipcRenderer.invoke('desktop:status').then(showBar).catch(() => {});
  });
}
