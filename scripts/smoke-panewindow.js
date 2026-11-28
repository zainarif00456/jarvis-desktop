'use strict';
// Real-Electron check of Development Mode panes in their own OS windows, against a REAL Jarvis server.
//   terminal 1 (project-jarvis):  python -m tests.support.serve_dev_fixture 900     (prints {base, code, project})
//   terminal 2 (this repo):       JARVIS_FIXTURE='<that json line>' xvfb-run -a npx electron --no-sandbox scripts/smoke-panewindow.js
// (scripts/smoke-panewindow.sh starts both.) The Jarvis page is the vendored web client behind the real gateway; the
// windows come from the real src/main/devwindows; the browser view from the real src/main/devbrowser. The panes are
// asked for by the same sentences the owner says, typed into the page's own command path. Screenshots: SHOTS dir.
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createGateway } = require('../src/main/gateway');
const { pair } = require('../src/main/server-probe');
const { createDevBrowser } = require('../src/main/devbrowser');
const { createPaneWindows } = require('../src/main/devwindows');

const FIX = JSON.parse(process.env.JARVIS_FIXTURE || '{}');
const SHOTS = process.env.SHOTS || '/tmp/panewindow-shots';
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) { const t = Date.now(); for (;;) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(100); } }
const xshot = (file) => { try { execFileSync('import', ['-window', 'root', file], { stdio: 'ignore' }); return true; } catch { return false; } };

const site = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Shop</title><body style="font:28px sans-serif;background:#fff"><h1>Shop admin</h1><p>Orders today: 42</p><button>Refund</button>'); });

app.whenReady().then(async () => {
  if (!FIX.base) { console.log('FAIL  JARVIS_FIXTURE is not set (see the header of this file)'); app.exit(1); return; }
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const paired = await pair(FIX.base, FIX.code, 'Jarvis Desktop smoke');
  if (!paired.ok) { console.log(`FAIL  pairing: ${paired.error} (the code works once: restart the fixture)`); app.exit(1); return; }
  const token = paired.token;
  const gateway = createGateway({ webRoot: path.join(__dirname, '..', 'vendor', 'web'), version: '0', deviceName: 'smoke', getTarget: () => FIX.base, getToken: () => token, setToken() {}, clearToken() {} });
  await gateway.listen(0);
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${gateway.url}/*`, `ws://127.0.0.1:${gateway.port}/*`] }, (d, cb) => { d.requestHeaders[gateway.SECRET_HEADER] = gateway.secret; cb({ requestHeaders: d.requestHeaders }); });   // as main.js does: only this app's windows may use the gateway
  for (const ch of ['desktop:audio-shim', 'desktop:overlay-page']) ipcMain.on(ch, (e) => { e.returnValue = ''; });
  ipcMain.handle('desktop:status', () => ({ state: 'ok' }));
  const prefs = { preload: path.join(__dirname, '..', 'src', 'preload', 'app.js'), contextIsolation: true, sandbox: true };
  const win = new BrowserWindow({ width: 1360, height: 860, x: 0, y: 0, show: true, title: 'Jarvis' });
  const appView = new WebContentsView({ webPreferences: prefs });
  win.contentView.addChildView(appView); appView.setBounds({ x: 0, y: 0, width: 1360, height: 860 });
  const appWc = () => appView.webContents;
  let dev = null;
  const panes = createPaneWindows({ getBase: () => gateway.url, getAppWc: appWc, getMain: () => win, preload: path.join(__dirname, '..', 'src', 'preload', 'pane.js'), icon: undefined, dir: fs.mkdtempSync('/tmp/jd-smoke-'), onGone: (w) => dev?.released(w) });
  dev = createDevBrowser({ getWindow: () => win, getAppWc: appWc, getPaneHosts: () => panes.hosts() });
  const page = (code) => appWc().executeJavaScript(code);
  const say = (text) => page(`window.__jarvis.dev().send({ type: 'user_message', text: ${JSON.stringify(text)} })`);
  const pane = (name) => panes.windowFor(name);
  const paneJs = (name, code) => pane(name).webContents.executeJavaScript(code);
  if (process.env.SMOKE_DEBUG) appWc().on('console-message', (_e, lvl, msg) => console.log('[page]', lvl, msg));
  try {
    await appWc().loadURL(`${gateway.url}/`);
    await until(() => page(`document.querySelector('#dev-ide') && !document.querySelector('#dev-ide').hidden`), 'the IDE in the main window');
    check('the IDE shows in the main window with all four docks', await page(`['side','center','right','bottom'].every((d) => document.querySelector('.dv-slot.dv-' + d) && !document.querySelector('.dv-slot.dv-' + d).hidden)`));
    await sleep(1500);
    await win.webContents.capturePage().catch(() => null);
    fs.writeFileSync(path.join(SHOTS, 'main-before.png'), (await appWc().capturePage()).toPNG());

    // 1. the terminal, by the owner's own words
    await say('pop the terminal out into its own window');
    await until(() => pane('terminal') && pane('terminal').isVisible(), 'the terminal window');
    const t = pane('terminal');
    check('a separate OS window exists for the terminal', BrowserWindow.getAllWindows().length === 2 && t !== win && t.getTitle().includes('Terminal'), t.getTitle());
    check('it has its own title bar controls: movable, resizable, minimisable, maximisable, closable', t.isMovable() && t.isResizable() && t.isMinimizable() && t.isMaximizable() && t.isClosable());
    check('it loads the pane page from the gateway', t.webContents.getURL().includes('/dev-window.html?pane=terminal&term='), t.webContents.getURL());
    await until(() => paneJs('terminal', `!!document.querySelector('.xterm')`), 'the terminal drawn in its window');
    check('the IDE shows a chip instead of the terminal, and the bottom dock is gone', await page(`[...document.querySelectorAll('.dv-minchip.win')].some((c) => c.textContent.startsWith('Terminal')) && document.querySelector('.dv-slot.dv-bottom').hidden`));
    t.setBounds({ x: 120, y: 90, width: 900, height: 520 });
    await sleep(900);
    xshot(path.join(SHOTS, 'screen-terminal-window.png'));
    fs.writeFileSync(path.join(SHOTS, 'pane-terminal.png'), (await t.webContents.capturePage()).toPNG());
    if (process.env.SMOKE_WM) {   // needs a window manager (the screen is virtual)
      t.maximize(); await sleep(600); check('the window can be maximised', t.isMaximized()); t.unmaximize(); await sleep(400);
      t.minimize(); await sleep(600); check('the window can be minimised', t.isMinimized()); t.restore(); await sleep(500);
    } else console.log('SKIP  maximise / minimise (no window manager on this display)');

    // 2. the file tree: a click in the window opens the file in the IDE's code pane
    await say('open the file tree in its own window');
    await until(() => pane('tree') && pane('tree').isVisible(), 'the file tree window');
    await until(() => paneJs('tree', `document.querySelectorAll('.dv-row').length > 0`), 'the tree loaded');
    await paneJs('tree', `[...document.querySelectorAll('.dv-row')].find((r) => r.textContent.includes('app')).click()`);
    await until(() => paneJs('tree', `[...document.querySelectorAll('.dv-row')].some((r) => r.textContent.includes('main.py'))`), 'a folder opened');
    await paneJs('tree', `[...document.querySelectorAll('.dv-row')].find((r) => r.textContent.includes('main.py')).click()`);
    check('a file clicked in the tree window opens in the main window\'s code pane', !!await until(() => page(`document.querySelector('.dv-path') && document.querySelector('.dv-path').textContent === 'app/main.py'`), 'main.py in the code pane'));

    // 3. the browser: its own window, the real page at full size inside it
    await say('pop the browser out into its own window');
    await until(() => pane('browser') && pane('browser').isVisible(), 'the browser window');
    pane('browser').setBounds({ x: 200, y: 60, width: 1000, height: 700 });
    await sleep(500);
    await page(`window.jarvisBrowser.call('open', { url: 'http://127.0.0.1:${site.address().port}/' })`);
    await page(`window.jarvisBrowser.call('settle', { timeout_ms: 1500 })`);
    await paneJs('browser', `window.dispatchEvent(new Event('resize'))`);
    await sleep(1200);
    const view = dev.debug();
    check('the native browser view moved into the browser window', view.owner === pane('browser') && !!view.rect, JSON.stringify({ owner: view.owner === win ? 'main' : view.owner === pane('browser') ? 'pane' : 'other', rect: view.rect }));
    const snap = await page(`window.jarvisBrowser.call('snapshot')`);
    check('the page in it is the real page', snap.title === 'Shop' && /Orders today: 42/.test(snap.text), JSON.stringify(snap).slice(0, 160));
    xshot(path.join(SHOTS, 'screen-browser-window.png'));
    const big = view.rect;
    check('the browser view is big (the pane is the whole window)', big && big.width > 900 && big.height > 500, JSON.stringify(big));

    // 4. docking back by voice closes the windows; the IDE has the panes again
    await say('dock the browser back');
    await until(() => !pane('browser'), 'the browser window closing');
    await say('restore everything');
    await until(() => !pane('terminal') && !pane('tree'), 'every window closing');
    check('every window closed and the main window is the only one left', BrowserWindow.getAllWindows().length === 1);
    check('the native view is back in the main window', dev.debug().owner === win);
    check('the IDE is back to four docks', await until(() => page(`['side','center','right','bottom'].every((d) => !document.querySelector('.dv-slot.dv-' + d).hidden)`), 'four docks', 5000));

    // 5. the window's own close button puts the pane back
    await say('pop the terminal out into its own window');
    await until(() => pane('terminal') && pane('terminal').isVisible(), 'the terminal window again');
    pane('terminal').close();
    await until(() => page(`!document.querySelector('.dv-slot.dv-bottom').hidden`), 'the terminal docked after its window was closed by the owner');
    check('closing the window with its own close button docks the pane again', true);

    // 6. the whole Jarvis window full screen, by voice
    await say('make Jarvis full screen');
    await until(() => win.isFullScreen(), 'the window going full screen');
    check('the whole window goes full screen by voice', win.isFullScreen());
    await say('exit full screen');
    await until(() => !win.isFullScreen(), 'leaving full screen');
    check('and comes back', !win.isFullScreen());
  } catch (err) {
    if (process.env.SMOKE_DEBUG) console.log('[diag]', appWc().getURL(), await page(`JSON.stringify({ conn: document.querySelector('#s-conn')?.className, pair: !document.querySelector('#pair')?.hidden, dev: typeof window.__jarvis?.dev, hidden: document.querySelector('#dev-ide')?.hidden })`).catch((e) => String(e)));
    console.log('FAIL  unexpected error', (err && err.stack) || err); failed += 1; }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  site.close(); panes.closeAll(); app.exit(failed ? 1 : 0);
});
