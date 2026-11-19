'use strict';
// Hologram overlay. The Jarvis web client (the deck, the call, the microphone) lives in ONE web contents.
// While the main window is in front, that page sits inside it as usual. While the main window is minimised, hidden
// to the tray or behind another app AND something is on the deck, the very same page is re-parented into a
// transparent, frameless, always-on-top, non-focusable window that covers the display, so the web client's own
// CSS and code draw the portals over the other applications. Nothing is re-created: same WebSocket, same
// microphone. Overlay CSS keeps the voice stage, including the orb, in the main window. Moving a view between windows does not reload it.
// The window spans ALL displays (one page cannot live in two windows); src/preload/overlay-page.js lays the floating things out per display
// (tool / terminal cards on the primary, presentations / briefings / pictures on a second display when there is one), see src/main/arrange.js.
const { BrowserWindow, screen } = require('electron');

const DISSOLVE_MS = 1100;   // allow closing portal effects to finish before hiding the overlay

// Pure helpers (unit tested): the overlay window covers the union of all displays; zones are the displays in window coordinates,
// the primary first, then the others from largest to smallest.
function unionBounds(displays) {
  const x1 = Math.min(...displays.map((d) => d.bounds.x)), y1 = Math.min(...displays.map((d) => d.bounds.y));
  const x2 = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)), y2 = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function computeZones(displays, primaryId, union) {
  const z = displays.map((d) => ({ id: d.id, x: d.bounds.x - union.x, y: d.bounds.y - union.y, w: d.bounds.width, h: d.bounds.height, primary: d.id === primaryId }));
  return z.sort((a, b) => (b.primary - a.primary) || (b.w * b.h - a.w * a.h));
}

function createOverlay({ getMain, getView, enabled, log, onFloat }) {
  let ov = null, pollTimer = null, capturing = false, pressed = false, floating = false, deckActive = false, suppressed = false, exitTimer = null, evalTimer = null, lastRects = [];
  const mac = process.platform === 'darwin';   // (mac only: the window level / all-workspaces setup below)

  function ensure() {
    if (ov && !ov.isDestroyed()) return ov;
    ov = new BrowserWindow({
      show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
      title: 'Jarvis hologram', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    ov.setAlwaysOnTop(true, 'screen-saver');
    ov.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    ov.setIgnoreMouseEvents(true);   // click-through everywhere until the cursor is over a portal (see poll)
    ov.on('closed', () => { ov = null; floating = false; });
    return ov;
  }
  let fakeDisplays = null;   // dev only (dev-control 'displays'): pretend a second display exists, to test the layout without moving the real screens
  const displays = () => fakeDisplays || screen.getAllDisplays();
  const primaryId = () => (fakeDisplays ? (fakeDisplays.find((d) => d.primary) || fakeDisplays[0]).id : screen.getPrimaryDisplay().id);
  function fit() {
    if (!floating || !ov || ov.isDestroyed()) return;
    const ds = displays(), b = unionBounds(ds);
    ov.setBounds(b);
    const v = getView(); if (v) { v.setBounds({ x: 0, y: 0, width: b.width, height: b.height }); v.webContents.send('desktop:overlay-zones', computeZones(ds, primaryId(), b)); }
  }
  const onDisplays = () => { if (floating) { log('overlay: displays changed', displays().length); fit(); setTimeout(fit, 400); } };   // twice: X11 reports the new geometry in two steps
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, onDisplays);
  // Click-through without clipping the picture: X11 has no input-only shape in Electron (setShape also clips what is drawn, which would
  // cut away the orb and its tendrils), and `forward` only exists on macOS/Windows. So the window ignores the mouse and the main process
  // watches the cursor: over a portal (or while a button pressed on one is still down) the window takes the mouse, otherwise it lets it through.
  function poll() {
    if (!floating || !ov || ov.isDestroyed()) return;
    const b = ov.getBounds(), c = screen.getCursorScreenPoint(), x = c.x - b.x, y = c.y - b.y;
    const inside = pressed || lastRects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (inside !== capturing) { capturing = inside; ov.setIgnoreMouseEvents(!inside); }
  }
  function applyShape(rects) { lastRects = rects; }

  function enter() {
    const main = getMain(), view = getView();
    if (floating || !view || !main || main.isDestroyed()) return;
    ensure();
    try { main.contentView.removeChildView(view); } catch { /* not attached */ }
    ov.contentView.addChildView(view);
    view.setBackgroundColor('#00000000');
    floating = true; fit();
    view.webContents.send('desktop:overlay-mode', true);
    applyShape(lastRects);
    capturing = false; pressed = false; ov.setIgnoreMouseEvents(true);
    clearInterval(pollTimer); pollTimer = setInterval(poll, 33);
    ov.showInactive();                                  // never takes keyboard focus
    ov.setAlwaysOnTop(true, 'screen-saver');
    log('overlay: floating'); onFloat?.(true);
  }
  function leave() {
    clearTimeout(exitTimer); exitTimer = null;
    if (!floating) return;
    const main = getMain(), view = getView();
    floating = false; clearInterval(pollTimer); pollTimer = null;
    if (view && !view.webContents.isDestroyed()) view.webContents.send('desktop:overlay-mode', false);
    if (ov && !ov.isDestroyed()) { try { if (view) ov.contentView.removeChildView(view); } catch { /* gone */ } ov.hide(); }
    if (main && !main.isDestroyed() && view) {
      main.contentView.addChildView(view); view.setBackgroundColor('#010509');
      const [w, h] = main.getContentSize(); view.setBounds({ x: 0, y: 0, width: w, height: h });
    }
    log('overlay: back in the window'); onFloat?.(false);
  }

  function mainInFront() {
    const m = getMain();
    return !!m && !m.isDestroyed() && m.isVisible() && !m.isMinimized() && m.isFocused();
  }
  function evaluate() {
    clearTimeout(evalTimer);
    const want = enabled() && !suppressed && deckActive && !mainInFront();
    if (want) { clearTimeout(exitTimer); exitTimer = null; enter(); return; }
    if (!floating) return;
    // The deck emptied: let closing portal effects finish first. Anything else (window back in front, switched off, hotkey): now.
    if (!deckActive && enabled() && !suppressed && !mainInFront()) { if (!exitTimer) exitTimer = setTimeout(leave, DISSOLVE_MS); } else leave();
  }
  const soon = (ms = 120) => { clearTimeout(evalTimer); evalTimer = setTimeout(evaluate, ms); };

  return {
    evaluate, soon, release: leave,
    get floating() { return floating; },
    get suppressed() { return suppressed; },
    get rects() { return lastRects; },
    get window() { return ov; },
    setDeckActive(on) { deckActive = !!on; soon(60); },
    setRects: applyShape,
    pressed(on) { pressed = !!on; poll(); },
    toggleSuppressed() { suppressed = !suppressed; evaluate(); return suppressed; },
    fit, onDisplays,
    setFakeDisplays(list) { fakeDisplays = list; onDisplays(); },
    destroy() { leave(); if (ov && !ov.isDestroyed()) ov.destroy(); ov = null; },
  };
}
module.exports = { createOverlay, unionBounds, computeZones };
