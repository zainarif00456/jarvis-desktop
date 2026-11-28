'use strict';
// The Electron side of pop-out panes: a real BrowserWindow (own title bar, minimise, maximise, close, resize,
// move) per pane, loading the web client's dev-window.html through the gateway. Logic: ./logic.js.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen, shell, ipcMain } = require('electron');
const { PaneWindows } = require('./logic');

function createPaneWindows({ getBase, getAppWc, getMain, preload, icon, dir, onGone = () => {}, log = () => {} }) {
  const file = path.join(dir, 'pane-windows.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  let timer = null;
  const persist = (all) => { clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(all)); } catch { /* not worth stopping for */ } }, 400); };
  const byWindow = new Map();   // BrowserWindow -> pane

  const logic = new PaneWindows({
    base: getBase,
    saved,
    areas: () => screen.getAllDisplays().map((d) => d.workArea),
    onSaved: persist,
    onClosed: (pane) => { const wc = getAppWc(); if (wc && !wc.isDestroyed()) wc.send('jarvis-dev:window-closed', pane); },
    create(spec, handlers) {
      const win = new BrowserWindow({
        ...spec.bounds, minWidth: spec.min.width, minHeight: spec.min.height, title: spec.title, show: false, backgroundColor: '#010509',
        icon, autoHideMenuBar: true,
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false },
      });
      byWindow.set(win, spec.pane);
      const wc = win.webContents;
      wc.setWindowOpenHandler(({ url }) => { try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ignore */ } return { action: 'deny' }; });
      wc.on('did-fail-load', (_e, code, desc, url) => log('pane window did-fail-load', spec.pane, code, desc, url));
      let t = null;
      const bounds = () => { clearTimeout(t); t = setTimeout(() => { if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) handlers.onBounds(win.getBounds()); }, 300); };
      win.on('resize', bounds); win.on('move', bounds);
      win.on('closed', () => { clearTimeout(t); byWindow.delete(win); onGone(win); handlers.onClosed(); });
      win.once('ready-to-show', () => win.show());
      win.loadURL(spec.url);
      return {
        win,
        focus() { if (win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); },
        close() { if (!win.isDestroyed()) win.close(); },
      };
    },
  });

  /** Only the Jarvis page itself (not a pane window, not the pages inside the browser view) may ask for windows. */
  const fromJarvisPage = (e) => { const wc = getAppWc(); return !!wc && e.sender === wc && e.senderFrame === wc.mainFrame; };
  const paneOf = (wc) => { for (const [win, pane] of byWindow) if (!win.isDestroyed() && win.webContents === wc) return pane; return null; };

  ipcMain.handle('jarvis-dev:open', (e, pane, opts) => { if (!fromJarvisPage(e)) throw new Error('not allowed'); return logic.open(String(pane), opts && typeof opts === 'object' ? opts : {}); });
  ipcMain.handle('jarvis-dev:close', (e, pane) => { if (!fromJarvisPage(e)) throw new Error('not allowed'); return logic.close(String(pane)); });
  ipcMain.handle('jarvis-dev:list', (e) => { if (!fromJarvisPage(e)) throw new Error('not allowed'); return logic.list(); });
  ipcMain.on('jarvis-dev:fullscreen', (e, on) => { if (fromJarvisPage(e)) { const w = getMain(); if (w && !w.isDestroyed() && w.isFullScreen() !== !!on) w.setFullScreen(!!on); } });
  // a pane window's own two buttons: close itself (the layout said it is docked again) and full screen
  ipcMain.on('jarvis-dev:self', (e, what) => {
    const pane = paneOf(e.sender); if (!pane) return;
    const win = BrowserWindow.fromWebContents(e.sender); if (!win) return;
    if (what === 'close') logic.close(pane); else if (what === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  });

  return {
    open: (pane, opts) => logic.open(pane, opts),
    list: () => logic.list(),
    closeAll: () => logic.closeAll(),
    hosts: () => [...byWindow.keys()].filter((w) => !w.isDestroyed()).map((w) => ({ win: w, wc: w.webContents, pane: byWindow.get(w) })),
    windowFor: (pane) => { for (const [win, p] of byWindow) if (p === pane && !win.isDestroyed()) return win; return null; },
  };
}

module.exports = { createPaneWindows };
