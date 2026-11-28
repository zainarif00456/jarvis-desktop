// One Development Mode pane in its own OS window (opened by windows.js, see dev-window.html?pane=...).
// It is not a Jarvis screen: no voice, no call. It listens on /ws/dev for the same dev_* events as the
// IDE, shows the one pane at full size, and asks the server (dev_layout) to put it back when the owner
// wants it docked again. The window closes by itself when the layout no longer says "window" for it.
import { el } from '../util.js';
import { PaneHub, TITLE, ORDER } from './panes.js';
import { Terminals } from '../terminal.js';

const params = new URLSearchParams(location.search);
const pane = ORDER.includes(params.get('pane')) ? params.get('pane') : 'code';
let ws = null; let attempt = 0; let closing = 0; let project = '';

const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
const toast = (text) => { bar.title = text; status.textContent = text; };
const hub = new PaneHub({ send, front: () => pane });
const node = hub.nodes[pane];
const status = el('span', { class: 'dv-meta', text: 'connecting…' });
const crumb = el('span', { class: 'dv-proj' });
const full = el('button', { type: 'button', class: 'dv-btn', text: 'Full screen', onclick: () => toggleFull() });
const bar = el('header', { class: 'dv-solobar' },
  el('span', { class: 'dv-dot' }), el('b', { class: 'dv-mode', text: TITLE[pane].toUpperCase() }), crumb, status, el('span', { class: 'dv-spacer' }),
  full, el('button', { type: 'button', class: 'dv-btn', text: 'Dock back', title: 'Put this pane back in the main window', onclick: () => send({ type: 'dev_layout', op: 'dock', pane }) }));
const root = el('section', { class: 'dev dev-solo', 'aria-label': `${TITLE[pane]} window` }, bar, el('div', { class: 'dv-slot dv-solobody' }, node));
document.body.classList.add('dev-on');
document.body.append(root);
document.title = `Jarvis · ${TITLE[pane]}`;

function toggleFull() {
  if (window.jarvisDev?.toggleFullScreen) { window.jarvisDev.toggleFullScreen(); return; }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
}
window.addEventListener('keydown', (e) => { if (e.key === 'F11') { e.preventDefault(); toggleFull(); } });

if (pane === 'terminal') {
  const terminals = new Terminals({ send, toast });
  terminals.dockNext(hub.termHost);
  const term = params.get('term');
  if (term) terminals.open({ id: term, title: 'project', cwd: '' });
}

function mine(dev) {
  const st = dev?.session?.layout?.panes?.[pane]?.state;
  return !!dev?.active && st === 'window';
}

/** The layout no longer wants this pane in a window (docked or closed by voice or a click): close. */
function check(dev) {
  clearTimeout(closing);
  if (mine(dev)) return;
  closing = setTimeout(() => { if (window.jarvisDev?.closeSelf) window.jarvisDev.closeSelf(); else window.close(); }, 600);
}

let latest = null;
function handle(m) {
  if (m.type === 'dev_state') {
    latest = m.dev;
    project = m.dev?.session?.project || '';
    crumb.textContent = project; status.textContent = m.dev?.active ? '' : 'Development Mode is off';
    hub.state(m.dev).catch(() => {});
    hub.browser.setVisible(true);
    check(m.dev);
  } else if (m.type === 'dev_layout') {
    if (latest?.session) { latest = { ...latest, session: { ...latest.session, layout: m.layout } }; check(latest); }
  } else hub.handle(m);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/dev`);
  ws = sock;
  sock.onopen = () => { attempt = 0; status.textContent = ''; };
  sock.onmessage = (event) => {
    let m; try { m = JSON.parse(event.data); } catch { return; }
    try { handle(m); } catch (err) { console.error('pane message failed', m.type, err); }
  };
  sock.onclose = (event) => {
    if (ws !== sock) return;
    if (event.code === 4401 || event.code === 4403) { status.textContent = 'Not paired: open Jarvis first, then pop this pane out again.'; return; }
    status.textContent = 'reconnecting…';
    attempt += 1;
    setTimeout(connect, Math.min(5000, 300 * 2 ** Math.min(attempt, 4)));
  };
}
setInterval(() => send({ type: 'ping' }), 20000);
connect();
