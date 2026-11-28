'use strict';
// Real-Electron check of the Development Mode browser (run under a display: xvfb-run -a npx electron scripts/smoke-devbrowser.js).
// A stand-in Jarvis page (with the real src/preload/app.js) drives a WebContentsView through window.jarvisBrowser against a
// local todo app, exactly as the server does over the socket: open, snapshot, type, click, evidence, reload, isolation.
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createDevBrowser } = require('../src/main/devbrowser');

const tasks = [];
const PAGE = `<!doctype html><title>Tasks</title><h1>My tasks</h1>
<label for="t">New task</label><input id="t" placeholder="What needs doing?">
<button id="add" onclick="add()">Add task</button><button id="boom" onclick="console.error('exploded on purpose')">Explode</button>
<a href="/other">Other page</a><ul id="list"></ul>
<script>document.cookie='seen=1; path=/'; localStorage.setItem('mark','dev-browser');
async function load(){const r=await fetch('/api/tasks');const d=await r.json();document.getElementById('list').innerHTML=d.map(t=>'<li>'+t+'</li>').join('')}
async function add(){await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:document.getElementById('t').value})});await load()}
load()</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/api/tasks' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(tasks)); }
  if (req.url === '/api/tasks' && req.method === 'POST') { let b = ''; req.on('data', (c) => (b += c)); return req.on('end', () => { tasks.push(JSON.parse(b).task); res.writeHead(201); res.end('{}'); }); }
  if (req.url === '/host.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>host</title><body>Jarvis page</body>'); }
  if (req.url === '/other') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Other</title><h1>Navigated</h1>'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
});

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); if (!ok) failed += 1; };
const ref = (snap, role, name) => (snap.elements.find((e) => e.role === role && e.name === name) || {}).ref;

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  ipcMain.on('desktop:audio-shim', (e) => { e.returnValue = ''; });
  ipcMain.on('desktop:overlay-page', (e) => { e.returnValue = ''; });
  const win = new BrowserWindow({ width: 1200, height: 800, show: true });
  const page = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'app.js'), contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(page); page.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  const dev = createDevBrowser({ getWindow: () => win, getAppWc: () => page.webContents });
  await page.webContents.loadURL(`${base}/host.html`);
  const jb = (op, args) => page.webContents.executeJavaScript(`window.jarvisBrowser.call(${JSON.stringify(op)}, ${JSON.stringify(args || {})})`);
  try {
    check('the page has the bridge', await page.webContents.executeJavaScript('typeof window.jarvisBrowser.call') === 'function');
    page.webContents.executeJavaScript('window.jarvisBrowser.setBounds({ x: 300, y: 60, width: 800, height: 600 })');
    await jb('open', { url: `${base}/app` });
    await jb('settle', { timeout_ms: 1500 });
    const snap = await jb('snapshot');
    check('snapshot reads title, text and elements with refs', snap.title === 'Tasks' && /My tasks/.test(snap.text) && !!ref(snap, 'textbox', 'New task') && !!ref(snap, 'button', 'Add task'), JSON.stringify(snap).slice(0, 300));
    check('the view has a real viewport (placed by setBounds)', snap.viewport[0] === 800 && snap.viewport[1] === 600, String(snap.viewport));
    await jb('console'); await jb('network');
    await jb('type', { ref: ref(snap, 'textbox', 'New task'), text: 'Buy oat milk', submit: false });
    await jb('click', { ref: ref(snap, 'button', 'Add task') });
    await jb('settle', { timeout_ms: 1500 });
    const net = await jb('network');
    check('the click made a POST /api/tasks that returned 201, with the response recorded', net.some((r) => r.method === 'POST' && r.url.endsWith('/api/tasks') && r.status === 201) && net.some((r) => r.method === 'GET' && r.body === '["Buy oat milk"]'), JSON.stringify(net));
    const after = await jb('snapshot');
    check('the page shows the new task', /Buy oat milk/.test(after.text), after.text);
    await jb('click', { ref: ref(after, 'button', 'Explode') });
    const lines = await jb('console');
    check('console errors are captured', lines.some((l) => l.startsWith('error') && /exploded on purpose/.test(l)), JSON.stringify(lines));
    const png = Buffer.from(await jb('screenshot'), 'base64');
    check('a real PNG screenshot', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.length > 2000, `${png.length} bytes`);
    fs.writeFileSync('/tmp/devbrowser-smoke.png', png);
    await jb('reload'); await jb('settle', { timeout_ms: 1500 });
    const reloaded = await jb('snapshot');
    check('after a reload the saved task is still there (persistence evidence)', /Buy oat milk/.test(reloaded.text), reloaded.text);
    await jb('click', { ref: ref(reloaded, 'link', 'Other page') });
    await jb('settle', { timeout_ms: 1500 });
    const other = await jb('snapshot');
    check('a link navigates inside the view (page-initiated navigation is allowed)', other.title === 'Other' && /Navigated/.test(other.text), other.title);
    const stale = await jb('click', { ref: 'e99' }).then(() => 'no error', (e) => e.message);
    check('a stale ref is a plain error', /no element e99/.test(stale), stale);
    const bad = await jb('open', { url: 'javascript:alert(1)' }).then(() => 'no error', (e) => e.message);
    check('script urls are refused', /web addresses/.test(bad), bad);
    const hostCookie = await page.webContents.executeJavaScript('document.cookie + "|" + localStorage.getItem("mark")');
    check('the owner\'s page shares nothing with the browser view (separate in-memory profile)', hostCookie === '|null', hostCookie);
    const devCookies = await session.fromPartition('devbrowser').cookies.get({});
    check('the browser view kept its own cookie in memory only', devCookies.some((c) => c.name === 'seen') && !session.fromPartition('devbrowser').isPersistent(), JSON.stringify(devCookies.map((c) => c.name)));
    // another web contents (not the Jarvis page) cannot use the bridge
    const intruder = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'app.js'), sandbox: true } });
    await intruder.loadURL(`${base}/host.html`);
    const denied = await intruder.webContents.executeJavaScript('window.jarvisBrowser.call("snapshot", {}).then(() => "allowed", (e) => e.message)');
    check('only the Jarvis page may drive the browser', /not allowed/.test(denied), denied);
    await jb('close');
    const blank = await jb('snapshot');
    check('close leaves a blank page', blank.url === 'about:blank', blank.url);
    await new Promise((r) => setTimeout(r, 300));
    const { x, y, width } = win.getContentBounds();
    console.log(`window ${width}x${win.getContentBounds().height} at ${x},${y}`);
    const shot = await win.webContents.capturePage().catch(() => null);
    if (shot) fs.writeFileSync('/tmp/devbrowser-window.png', shot.toPNG());
  } catch (err) {
    console.log('FAIL  unexpected error', err && err.stack || err); failed += 1;
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  server.close(); dev.destroy(); app.exit(failed ? 1 : 0);
});
