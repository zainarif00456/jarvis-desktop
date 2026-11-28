'use strict';
const { app, BrowserWindow, WebContentsView, Menu, Tray, globalShortcut, ipcMain, session, shell, safeStorage, Notification, nativeImage, systemPreferences, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store, normalizeBaseUrl } = require('./store');
const { createGateway } = require('./gateway');
const { probe, pair } = require('./server-probe');
const { createOverlay } = require('./overlay');
const { createDevBrowser } = require('./devbrowser');
const { createPaneWindows } = require('./devwindows');
const audio = require('./audio');

const ROOT = path.join(__dirname, '..', '..');
const UI = path.join(ROOT, 'src', 'ui');
const WEB = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(ROOT, 'vendor', 'web');
const MANIFEST = (() => { try { return JSON.parse(fs.readFileSync(app.isPackaged ? path.join(process.resourcesPath, 'manifest.json') : path.join(ROOT, 'vendor', 'manifest.json'), 'utf8')); } catch { return {}; } })();
const OVERLAY_CSS = fs.readFileSync(path.join(__dirname, 'overlay.css'), 'utf8');
const ICON = path.join(ROOT, 'build', 'icon.png');

if (process.env.JARVIS_DESKTOP_USERDATA) app.setPath('userData', process.env.JARVIS_DESKTOP_USERDATA);
app.setName('Jarvis Desktop');
// Wayland: ask the xdg-desktop-portal for global shortcuts (inferred to work on recent compositors; not verified here).
if (process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)) {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
// Software GL for headless / VM runs (set JARVIS_DESKTOP_SWGL=1). Real GPUs are used by default.
if (process.env.JARVIS_DESKTOP_SWGL) { app.commandLine.appendSwitch('use-gl', 'angle'); app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }

let store, gateway, win, appView, overlay, devBrowser, paneWindows, tray, quitting = false, hotkeyState = { registered: false, accelerator: null, error: null }, overlayHotkeyState = { registered: false, accelerator: null, error: null };
let serverStatus = { state: 'unknown' }, callMuted = { muted: false, enabled: false }, healthTimer = null, logStream = null;

function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try { logStream?.write(line + '\n'); } catch { /* ignore */ }
}
const appWc = () => (appView && !appView.webContents.isDestroyed() ? appView.webContents : null);
const onGateway = (wc) => { try { return new URL(wc.getURL()).origin === gateway.url; } catch { return false; } };

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (store && gateway) showWindow(); });

// ------------------------------------------------------------------ window
const SETTINGS_URL = () => require('url').pathToFileURL(path.join(UI, 'settings.html')).href;
// Navigation limits for EVERY web contents (main window and any popup): gateway origin or our own settings page only;
// anything else is handed to the system browser (http/https) or dropped. No <webview> ever.
app.on('web-contents-created', (_e, wc) => {
  // The Development Mode browser is a browser: the pages in it may navigate (isolated profile, see devbrowser/index.js).
  if (!devBrowser?.owns(wc)) wc.on('will-navigate', (e, url) => {
    let u; try { u = new URL(url); } catch { e.preventDefault(); return; }
    if (u.origin === gateway?.url) return;
    if (u.protocol === 'file:' && url.split(/[?#]/)[0] === SETTINGS_URL()) return;
    e.preventDefault();
    if (/^https?:$/.test(u.protocol)) shell.openExternal(url);
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
// Settings IPC is only for our own file:// settings page.
const fromSettings = (e) => { try { return e.senderFrame.url.split(/[?#]/)[0] === SETTINGS_URL(); } catch { return false; } };

function createWindow(hidden) {
  const prefs = {
    preload: path.join(ROOT, 'src', 'preload', 'app.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    backgroundThrottling: false,   // a call keeps its timers and audio when the window is hidden to the tray
    spellcheck: false,
  };
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 720, minHeight: 520, show: false, backgroundColor: '#010509', title: 'Jarvis',
    icon: ICON, autoHideMenuBar: true, webPreferences: prefs,   // this web contents shows the settings page
  });
  // The Jarvis client lives in its own view so the overlay can borrow it (js/main/overlay.js): one page, one call, one microphone.
  appView = new WebContentsView({ webPreferences: prefs });
  appView.setBackgroundColor('#010509');
  appView.setVisible(false);
  win.contentView.addChildView(appView);
  const layout = () => { if (!win || win.isDestroyed() || overlay?.floating) return; const [w, h] = win.getContentSize(); appView.setBounds({ x: 0, y: 0, width: w, height: h }); };
  win.on('resize', layout); layout();
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) win.on(ev, () => overlay?.soon(ev === 'blur' ? 250 : 60));
  hookWc(win.webContents); hookWc(appView.webContents);
  win.setAlwaysOnTop(!!store.get('alwaysOnTop'));
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('close', (e) => {
    if (!quitting && store.get('closeToTray') && tray) { e.preventDefault(); win.hide(); }
  });
  win.on('close', () => overlay?.release());   // hand the page back before the window goes
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => appWc()?.send('jarvis-dev:fullscreen', win.isFullScreen()));   // Development Mode keeps its "full screen window" layout flag in step
  win.on('closed', () => { devBrowser?.destroy(); win = null; appView = null; if (!tray || quitting) overlay?.destroy(); });
  buildMenu();
}
function hookWc(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.origin === gateway.url) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#010509', webPreferences: { preload: path.join(ROOT, 'src', 'preload', 'app.js'), sandbox: true, contextIsolation: true } } };
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
    } catch { /* ignore */ }
    return { action: 'deny' };
  });
  if (wc !== win?.webContents) wc.on('dom-ready', () => { wc.insertCSS(OVERLAY_CSS).catch(() => {}); });
  wc.on('render-process-gone', (_e, d) => log('renderer gone', d));
  wc.on('console-message', (e) => { if (process.env.JARVIS_DESKTOP_DEBUG) log('[renderer]', e.message ?? e); });
  wc.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
}
function showWindow() {
  if (!win) createWindow(false);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function loadSettings(reason) {
  const q = new URLSearchParams(); if (reason) q.set('reason', reason);
  if (!win) createWindow(false);
  overlay?.release(); appView?.setVisible(false);
  win.loadFile(path.join(UI, 'settings.html'), { search: q.toString() });
}
async function loadApp() {
  const base = store.get('baseUrl');
  const st = await probe(base, store.getToken());
  setStatus(st);
  if (st.state !== 'ok') { loadSettings(st.state); return; }
  appView.setVisible(true); appView.webContents.loadURL(gateway.url + '/');
}
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Jarvis', submenu: [
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => { showWindow(); loadSettings(); } },
      { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => { if (appWc() && onGateway(appWc()) && appView.getVisible()) appWc().reload(); else loadApp(); } },
      { label: 'Always on top', type: 'checkbox', checked: !!store.get('alwaysOnTop'), click: (mi) => applySettings({ alwaysOnTop: mi.checked }) },
      { label: 'Developer tools', accelerator: 'CommandOrControl+Shift+I', click: () => (appView?.getVisible() ? appWc() : win?.webContents)?.toggleDevTools() },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => quit() },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
}
function quit() { quitting = true; app.quit(); }

// ------------------------------------------------------------------ tray + hotkey
function buildTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }) : img);
  } catch (e) { log('tray unavailable', e.message); tray = null; return; }
  tray.setToolTip('Jarvis Desktop');
  tray.on('click', () => { if (win?.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  const connected = serverStatus.state === 'ok';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win?.isVisible() ? 'Hide Jarvis' : 'Show Jarvis', click: () => { if (win?.isVisible()) win.hide(); else showWindow(); } },
    { label: callMuted.muted ? 'Unmute microphone' : 'Mute microphone', enabled: callMuted.enabled, click: () => toggleMute('tray') },
    { label: 'Always on top', type: 'checkbox', checked: !!store.get('alwaysOnTop'), click: (mi) => applySettings({ alwaysOnTop: mi.checked }) },
    { label: 'Hologram overlay', type: 'checkbox', checked: !!store.get('overlay') && !overlay?.suppressed, click: (mi) => { if (!store.get('overlay')) applySettings({ overlay: true }); else if (mi.checked === !!overlay?.suppressed) overlay.toggleSuppressed(); refreshTray(); } },
    { type: 'separator' },
    { label: connected ? `Server: connected${serverStatus.version ? ' (v' + serverStatus.version + ')' : ''}` : `Server: ${serverStatus.state}`, enabled: false },
    { label: 'Settings…', click: () => { showWindow(); loadSettings(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() },
  ]));
  tray.setToolTip(`Jarvis Desktop${callMuted.enabled ? (callMuted.muted ? ' (muted)' : ' (listening)') : ''}`);
}
function toggleMute(source) {
  const wc = appWc();
  if (!wc || !onGateway(wc)) { log('mute ignored: Jarvis is not open', source); return; }
  log('mute toggle requested', source);
  wc.send('desktop:toggle-mute');
}
function registerOne(accel, fn) {
  const st = { registered: false, accelerator: accel, error: null };
  if (!accel) return st;
  try {
    st.registered = globalShortcut.register(accel, fn);
    if (!st.registered) st.error = 'Could not register (in use by another app, or this desktop does not allow global shortcuts, e.g. Wayland without portal support). The tray menu still works.';
  } catch (e) { st.error = `Invalid shortcut: ${e.message}`; }
  return st;
}
function registerHotkey() {
  globalShortcut.unregisterAll();
  const accel = store.get('hotkey');
  hotkeyState = registerOne(accel, () => { log('hotkey fired', accel); toggleMute('hotkey'); });
  const oa = store.get('overlayHotkey');
  overlayHotkeyState = registerOne(oa === accel ? '' : oa, () => { log('overlay hotkey fired', oa); const hidden = overlay.toggleSuppressed(); log('overlay', hidden ? 'hidden by hotkey' : 'allowed again'); refreshTray(); });
  log('hotkey', hotkeyState, 'overlay hotkey', overlayHotkeyState);
}

// ------------------------------------------------------------------ settings
function applySettings(patch) {
  const prev = store.all();
  store.set(patch);
  if ('alwaysOnTop' in patch) { win?.setAlwaysOnTop(!!patch.alwaysOnTop); buildMenu(); }
  if ('hotkey' in patch || 'overlayHotkey' in patch) registerHotkey();
  if ('overlay' in patch) overlay?.evaluate();
  if ('startOnLogin' in patch) {
    try { setAutostart(!!patch.startOnLogin); } catch (e) { log('login item failed', e.message); }
  }
  refreshTray();
  return prev;
}
// Electron's login-item API does nothing on Linux, so write an XDG autostart entry there.
function setAutostart(on) {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  const f = path.join(os.homedir(), '.config', 'autostart', 'jarvis-desktop.desktop');
  if (!on) { fs.rmSync(f, { force: true }); return; }
  const exe = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=Jarvis Desktop\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
}
function publicSettings() {
  const base = store.get('baseUrl');
  return { ...store.all(), hasToken: store.hasToken(base), tokenBackend: store.backend(), hotkeyState, overlayHotkeyState, status: serverStatus,
    platform: process.platform, sessionType: process.env.XDG_SESSION_TYPE || null, appVersion: app.getVersion(),
    uiManifest: { serverVersion: MANIFEST.serverVersion || null, sourceCommit: MANIFEST.sourceCommit || null, syncedAt: MANIFEST.syncedAt || null } };
}
function setStatus(st) {
  const prevState = serverStatus.state;
  serverStatus = st;
  const mismatch = st.state === 'ok' && st.version && MANIFEST.serverVersion && st.version !== MANIFEST.serverVersion;
  serverStatus.versionMismatch = !!mismatch;
  for (const wc of [win?.webContents, appWc()]) if (wc && !wc.isDestroyed()) wc.send('desktop:status', serverStatus);
  if (prevState !== st.state) { log('server status', st.state, st.detail || ''); refreshTray(); }
}
function startHealthLoop() {
  const tick = async () => {
    if (!store.get('configured')) return;
    setStatus(await probe(store.get('baseUrl'), store.getToken()));
  };
  healthTimer = setInterval(tick, 5000);
}

ipcMain.handle('settings:get', (e) => (fromSettings(e) ? publicSettings() : null));
ipcMain.handle('settings:test', async (e, url) => {
  if (!fromSettings(e)) return { state: 'invalid', detail: 'forbidden' };
  try { const base = normalizeBaseUrl(url); return { base, ...(await probe(base, store.getToken(base))) }; }
  catch (e) { return { state: 'invalid', detail: e.message }; }
});
ipcMain.handle('settings:save', (e, patch) => {
  if (!fromSettings(e)) return { ok: false, error: 'forbidden' };
  const clean = {};
  try {
    if ('baseUrl' in patch) clean.baseUrl = normalizeBaseUrl(patch.baseUrl);
    for (const k of ['alwaysOnTop', 'startOnLogin', 'closeToTray', 'notifications', 'overlay']) if (k in patch) clean[k] = !!patch[k];
    if ('hotkey' in patch) clean.hotkey = String(patch.hotkey || '').trim();
    if ('overlayHotkey' in patch) clean.overlayHotkey = String(patch.overlayHotkey || '').trim();
    for (const k of ['audioInput', 'audioOutput']) if (k in patch) clean[k] = audio.cleanChoice(patch[k]);
    clean.configured = true;
  } catch (e) { return { ok: false, error: e.message }; }
  applySettings(clean);
  if ('audioInput' in clean || 'audioOutput' in clean) appWc()?.send('desktop:audio-config-changed');
  return { ok: true, settings: publicSettings() };
});
ipcMain.handle('settings:pair', async (e, { baseUrl, code, name }) => {
  if (!fromSettings(e)) return { ok: false, error: 'forbidden' };
  let base; try { base = normalizeBaseUrl(baseUrl); } catch (e) { return { ok: false, error: e.message }; }
  const r = await pair(base, code, name || `Jarvis Desktop (${os.hostname()})`);
  if (r.ok) {
    store.setToken(r.token, base); log('paired with', base);
    if (base !== store.get('baseUrl')) applySettings({ baseUrl: base, configured: true });   // never stay paired to X while the saved address is Y
    return { ok: true };
  }
  return r;
});
ipcMain.handle('settings:forget', (e, baseUrl) => { if (!fromSettings(e)) return null; try { store.clearToken(normalizeBaseUrl(baseUrl || store.get('baseUrl'))); } catch { store.clearToken(); } log('device token forgotten'); return publicSettings(); });
ipcMain.handle('settings:open-app', async (e) => { if (!fromSettings(e)) return { state: 'forbidden' }; await loadApp(); return { state: serverStatus.state }; });
ipcMain.on('desktop:mute-state', (e, s) => {
  if (!onGateway(e.sender)) return;
  callMuted = { muted: !!s.muted, enabled: !!s.enabled }; refreshTray();
});
ipcMain.on('desktop:mute-result', (_e, r) => {
  log('mute result', r);
  if (r.done && store.get('notifications') && Notification.isSupported() && !win?.isFocused()) new Notification({ title: 'Jarvis', body: r.muted ? 'Microphone muted' : 'Microphone live', silent: true }).show();
});
// ---- audio: policy for the page's microphone / speaker (src/preload/audio-shim.js)
const AUDIO_SHIM = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'audio-shim.js'), 'utf8');
ipcMain.on('desktop:audio-shim', (e) => { e.returnValue = onGateway(e.sender) ? AUDIO_SHIM : ''; });
// ---- overlay page script: janitor + per-display layout (src/main/arrange.js + src/preload/overlay-page.js), run inside the page
const OVERLAY_PAGE = fs.readFileSync(path.join(ROOT, 'src', 'main', 'arrange.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src', 'preload', 'overlay-page.js'), 'utf8');
ipcMain.on('desktop:overlay-page', (e) => { e.returnValue = onGateway(e.sender) ? OVERLAY_PAGE : ''; });
ipcMain.handle('desktop:audio-config', async (e) => {
  if (!onGateway(e.sender)) return null;
  const d = await audio.listDevices();
  return { input: store.get('audioInput'), output: store.get('audioOutput'), bt: [...d.sinks, ...d.sources].filter((x) => x.bluetooth).map((x) => x.label) };
});
ipcMain.on('desktop:audio-log', (e, m) => { if (onGateway(e.sender)) log('[audio]', String(m).slice(0, 300)); });
ipcMain.handle('settings:audio-devices', async (e) => (fromSettings(e) ? audio.listDevices() : null));
ipcMain.on('desktop:deck-active', (e, on) => { if (onGateway(e.sender)) overlay?.setDeckActive(on); });
ipcMain.on('desktop:overlay-rects', (e, rects) => {
  if (!onGateway(e.sender) || !Array.isArray(rects)) return;
  overlay?.setRects(rects.slice(0, 64).filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite)));
});
// A card went full screen / came back (js/holowin.js sets data-jd-full). In the window: the window itself goes full screen and returns to what it was.
// Over other apps: the overlay page makes the card fill its display (src/preload/overlay-page.js); the overlay never takes keyboard focus, so while a
// card is full there, Esc is grabbed globally (and handed to the page) and released the moment the card is not full any more.
let fullByUs = false, fullNow = false, escapeGrabbed = false;
function escapeGrab(on) {
  if (on === escapeGrabbed) return;
  if (on) escapeGrabbed = globalShortcut.register('Escape', () => appWc()?.send('desktop:escape'));
  else { try { globalShortcut.unregister('Escape'); } catch { /* gone */ } escapeGrabbed = false; }
}
ipcMain.on('desktop:full', (e, on) => {
  if (!onGateway(e.sender)) return;
  fullNow = !!on; log('card full screen', fullNow, overlay?.floating ? '(overlay)' : '(window)');
  escapeGrab(fullNow && !!overlay?.floating);
  if (overlay?.floating || !win || win.isDestroyed()) return;
  if (fullNow && !win.isFullScreen()) { fullByUs = true; win.setFullScreen(true); } else if (!fullNow && fullByUs) { fullByUs = false; win.setFullScreen(false); }
});
ipcMain.on('desktop:overlay-pressed', (e, on) => { if (onGateway(e.sender)) overlay?.pressed(!!on); });
ipcMain.on('desktop:open-settings', (e) => { if (onGateway(e.sender)) loadSettings(); });
ipcMain.handle('desktop:status', () => serverStatus);

// ------------------------------------------------------------------ boot
app.whenReady().then(async () => {
  try { fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true }); logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'logs', 'main.log'), { flags: 'a' }); } catch { /* console only */ }
  store = new Store(app.getPath('userData'), safeStorage);
  log(`Jarvis Desktop ${app.getVersion()} electron ${process.versions.electron} ${process.platform} session=${process.env.XDG_SESSION_TYPE || '-'} token-store=${store.backend()}`);

  gateway = createGateway({
    webRoot: WEB, version: app.getVersion(), deviceName: `Jarvis Desktop (${os.hostname()})`, log,
    getTarget: () => store.get('baseUrl'), getToken: () => store.getToken(),
    setToken: (t) => store.setToken(t), clearToken: () => store.clearToken(),
  });
  await gateway.listen(store.get('gatewayPort') || 0);
  if (store.get('gatewayPort') !== gateway.port) store.set({ gatewayPort: gateway.port });
  log('gateway on', gateway.url, 'serving', WEB);

  // Only the gateway origin is trusted with the microphone / notifications / fullscreen. The shared secret header
  // is added here so only this app's own windows can use the gateway (other local programs get 403).
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders({ urls: [`${gateway.url}/*`, `ws://127.0.0.1:${gateway.port}/*`] }, (d, cb) => {
    d.requestHeaders[gateway.SECRET_HEADER] = gateway.secret; cb({ requestHeaders: d.requestHeaders });
  });
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'mediaKeySystem']);
  const trusted = (wc, origin) => { try { return new URL(origin || wc.getURL()).origin === gateway.url; } catch { return false; } };
  const ok = (wc, perm, origin) => allowed.has(perm) && trusted(wc, origin) && !(perm === 'fullscreen' && overlay?.floating);   // a portal fills the overlay page instead of taking over the display
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(ok(wc, perm, details?.requestingUrl)));
  ses.setPermissionCheckHandler((wc, perm, origin) => ok(wc, perm, origin));

  if (process.platform === 'darwin') {
    try { log('mic access (mac):', await systemPreferences.askForMediaAccess('microphone')); } catch (e) { log('mic prompt failed', e.message); }
  }
  const hidden = process.argv.includes('--hidden');
  overlay = createOverlay({ getMain: () => win, getView: () => appView, enabled: () => !!store.get('overlay'), log, onFloat: (on) => { escapeGrab(on && fullNow); devBrowser?.refresh(); } });
  paneWindows = createPaneWindows({ getBase: () => gateway.url, getAppWc: appWc, getMain: () => win, preload: path.join(ROOT, 'src', 'preload', 'pane.js'), icon: ICON, dir: app.getPath('userData'), onGone: (w) => devBrowser?.released(w), log });
  devBrowser = createDevBrowser({ getWindow: () => win, getAppWc: appWc, getPaneHosts: () => paneWindows.hosts(), isFloating: () => !!overlay?.floating, log });
  createWindow(hidden);
  buildTray();
  registerHotkey();
  startHealthLoop();
  if (store.get('configured')) await loadApp(); else loadSettings('first-run');
  if (process.env.JARVIS_DESKTOP_DEV) require('./dev-control').start({ dir: app.getPath('userData'), log, state: () => ({ floating: overlay.floating, suppressed: overlay.suppressed, rects: overlay.rects, mainVisible: !!win?.isVisible(), mainMinimized: !!win?.isMinimized(), mainFocused: !!win?.isFocused(), overlayBounds: overlay.window?.getBounds() || null, overlayVisible: !!overlay.window?.isVisible() }), main: (a) => { if (!win) return; if (a === 'minimize') win.minimize(); else if (a === 'hide') win.hide(); else if (a === 'show') showWindow(); else if (a === 'settings') { showWindow(); loadSettings(); } }, hotkey: () => overlay.toggleSuppressed(), displays: (list) => overlay.setFakeDisplays(list && list.map((d) => ({ id: d.id, primary: !!d.primary, bounds: { x: d.x, y: d.y, width: d.width, height: d.height } }))), capture: async (f) => { const img = await appWc().capturePage(); fs.writeFileSync(f, img.toPNG()); return f; }, evalIn: (code, target) => (target === 'settings' ? win?.webContents : appWc())?.executeJavaScript(code) });
  if (process.env.JARVIS_DESKTOP_AUTOQUIT_MS) setTimeout(quit, Number(process.env.JARVIS_DESKTOP_AUTOQUIT_MS));
});
app.on('before-quit', () => { quitting = true; paneWindows?.closeAll(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); clearInterval(healthTimer); gateway?.close(); });
app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });
app.on('activate', () => showWindow());
