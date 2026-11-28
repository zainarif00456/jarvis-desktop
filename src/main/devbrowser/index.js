'use strict';
// The native browser of Development Mode: a WebContentsView laid over the IDE's browser pane, driven over the
// Chrome DevTools Protocol (webContents.debugger) by driver.js. Jarvis (the server) sends `browser_cmd` to the page,
// the page calls window.jarvisBrowser.call (src/preload/app.js), and the answer goes back the same way.
//
//  * An isolated, in-memory profile (partition without "persist:"): none of the owner's cookies or logins.
//  * No permissions, no downloads; popups open in the same view; page-initiated navigation is allowed (it is a browser).
//  * Only the Jarvis page may drive it, and only a page that is Jarvis's (the main page, or a pane window of the browser)
//    may place it; the view is created on first use. It follows whichever of those pages shows the browser pane: in
//    the main window, or in the browser's own OS window (see src/main/devwindows).
const { WebContentsView, session, ipcMain } = require('electron');
const { Driver, BrowserError } = require('./driver');

const PARTITION = 'devbrowser';
const OFFSCREEN = { x: -4000, y: 0, width: 1280, height: 800 };   // no pane on screen: keep rendering, out of sight
const CALL_TIMEOUT_MS = 30000;

function createDevBrowser({ getWindow, getAppWc, getPaneHosts = () => [], isFloating = () => false, log = () => {} }) {
  let view = null; let driver = null; let rect = null;
  let host = null;   // { win, wc }: the page that shows the browser pane now (null: nowhere, the view waits off screen)

  const sess = () => session.fromPartition(PARTITION);
  const owns = (wc) => { try { return wc.session === sess(); } catch { return false; } };
  const alive = () => view && !view.webContents.isDestroyed();

  const hostWindow = () => (host && !host.win.isDestroyed() ? host.win : getWindow());

  /** Move the view under another window (the pane went to its own window, or came back). */
  function adopt(win) {
    if (!alive() || !win || win.isDestroyed() || view.owner === win) return;
    try { view.owner?.contentView.removeChildView(view); } catch { /* the old window is gone */ }
    win.contentView.addChildView(view);
    view.owner = win;
  }

  function place() {
    if (!alive()) return;
    adopt(hostWindow());
    const page = host && !host.wc.isDestroyed() ? host.wc : getAppWc();
    const z = page && !page.isDestroyed() ? page.getZoomFactor() : 1;
    const shown = rect && (host ? host.wc !== getAppWc() || !isFloating() : !isFloating());
    view.setBounds(shown ? { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.max(1, Math.round(rect.width * z)), height: Math.max(1, Math.round(rect.height * z)) } : OFFSCREEN);
  }

  function dispatcher(wc) {
    const listeners = {};
    wc.debugger.on('message', (_e, method, params) => { for (const fn of listeners[method] || []) fn(params); });
    wc.debugger.on('detach', (_e, reason) => { log('dev browser debugger detached', reason); driver = null; });
    return {
      send: (method, params) => wc.debugger.sendCommand(method, params),
      on: (event, fn) => { (listeners[event] ||= []).push(fn); },
    };
  }

  async function ensure() {
    if (alive() && driver) return driver;
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new BrowserError('the Jarvis window is not open');
    if (!alive()) {
      const ses = sess();
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      ses.on('will-download', (e) => e.preventDefault());
      view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false } });
      view.setBackgroundColor('#ffffff');
      view.webContents.setWindowOpenHandler(({ url }) => { view.webContents.loadURL(url).catch(() => {}); return { action: 'deny' }; });
      adopt(hostWindow() || win);
      place();
      await view.webContents.loadURL('about:blank');   // a fresh view has no renderer yet, and Page.enable would wait for one forever
    }
    const wc = view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    driver = new Driver(dispatcher(wc), { onUrl: (url) => { for (const page of [getAppWc(), ...getPaneHosts().map((h) => h.wc)]) if (page && !page.isDestroyed()) page.send('jarvis-browser:event', { url }); } });
    await driver.start();
    return driver;
  }

  async function call(op, args) {
    const d = await ensure();
    return Promise.race([
      d.call(op, args || {}),
      new Promise((_r, reject) => setTimeout(() => reject(new BrowserError(`the desktop browser did not finish ${op} in time (is the window minimised?)`)), CALL_TIMEOUT_MS).unref()),
    ]);
  }

  const fromPage = (e) => { const app = getAppWc(); return !!app && e.sender === app && e.senderFrame === app.mainFrame; };
  /** The main page or one of the pane windows (the latter only to place the view, never to drive it). */
  const hostOf = (e) => {
    if (fromPage(e)) return { win: getWindow(), wc: e.sender };
    const found = getPaneHosts().find((h) => h.wc === e.sender && e.senderFrame === h.wc.mainFrame);
    return found ? { win: found.win, wc: found.wc } : null;
  };

  ipcMain.handle('jarvis-browser:call', async (e, op, args) => {
    if (!fromPage(e)) throw new Error('not allowed');
    try { return (await call(String(op), args && typeof args === 'object' ? args : {})) ?? null; } catch (err) { throw new Error(String(err.message || err).slice(0, 500)); }
  });
  ipcMain.on('jarvis-browser:bounds', (e, r) => {
    const from = hostOf(e);
    if (!from) return;
    const next = r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    if (next) { host = from; rect = next; } else if (host && host.wc === from.wc) { rect = null; }   // a page that hides its pane must not hide the view another page is showing
    place();
  });

  return {
    owns,
    /** For the smoke test: where the view is and how big. */
    debug: () => ({ owner: view?.owner || null, rect: view && alive() ? view.getBounds() : null }),
    refresh: place,   // the overlay opened or closed
    /** A pane window closed: if it was showing the view, the view goes back to waiting off screen in the main window. */
    released(win) { if (host && host.win === win) { host = null; rect = null; place(); } },
    call,
    destroy() { if (alive()) { try { (view.owner || getWindow())?.contentView.removeChildView(view); } catch { /* window gone */ } view.webContents.close(); } view = null; driver = null; host = null; },
  };
}

module.exports = { createDevBrowser, PARTITION };
