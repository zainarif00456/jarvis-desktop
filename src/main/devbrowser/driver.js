'use strict';
// Drives ONE page over the Chrome DevTools Protocol, for Jarvis's Development Mode (server: devmode/browser/).
// Pure logic: `cdp` is { send(method, params) -> Promise, on(event, fn) }, which is exactly what Electron's
// webContents.debugger gives (see index.js), so it is tested here against a fake. Same operations and same
// result shapes as the server's headless backend: open, snapshot, click, type, press, scroll, reload,
// screenshot, settle, console, network, close. The page is read with snapshot.js (refs e1, e2 ...).
const fs = require('fs');
const path = require('path');

const SNAPSHOT_JS = fs.readFileSync(path.join(__dirname, 'snapshot.js'), 'utf8');
const BODY_CHARS = 1500;
const API_TYPES = new Set(['XHR', 'Fetch']);
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }, Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Home: { key: 'Home', code: 'Home', vk: 36 }, End: { key: 'End', code: 'End', vk: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 }, PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The promise, or null after `ms` (the timer is cleared so it never keeps the process alive). */
const orTimeout = (promise, ms) => { let timer; return Promise.race([promise, new Promise((r) => { timer = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(timer)); };

class BrowserError extends Error {}

class Driver {
  constructor(cdp, { startGraceMs = 150, quietMs = 250, onUrl = () => {} } = {}) {
    this.cdp = cdp; this.startGraceMs = startGraceMs; this.quietMs = quietMs; this.onUrl = onUrl;
    this.consoleLines = []; this.netRows = []; this.pending = new Map(); this.bodies = new Set();
    this.lastActivity = Date.now(); this.loaded = null;
  }

  /** Turn the protocol domains on and start collecting evidence. Call once, after attaching. */
  async start() {
    const { cdp } = this;
    cdp.on('Runtime.consoleAPICalled', (p) => this.consoleLines.push(`${levelOf(p.type)}: ${argsText(p.args)}`.slice(0, 320)));
    cdp.on('Runtime.exceptionThrown', (p) => this.consoleLines.push(`error: Uncaught ${(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception').split('\n')[0]}`.slice(0, 320)));
    cdp.on('Log.entryAdded', (p) => { const e = p.entry || {}; if (e.level === 'error' || e.level === 'warning') this.consoleLines.push(`${e.level}: ${e.text}`.slice(0, 320)); });
    cdp.on('Network.requestWillBeSent', (p) => { this.touch(); this.pending.set(p.requestId, { method: p.request.method, url: p.request.url, type: (p.type || '').toString(), status: null, t0: Date.now() }); });
    cdp.on('Network.responseReceived', (p) => { this.touch(); const r = this.pending.get(p.requestId); if (r) { r.status = p.response.status; r.type = (p.type || r.type).toString(); } });
    cdp.on('Network.loadingFinished', (p) => { this.touch(); this.finish(p.requestId); });
    cdp.on('Network.loadingFailed', (p) => { this.touch(); const r = this.pending.get(p.requestId); if (r && !p.canceled) { r.status = 0; r.error = String(p.errorText || 'failed').slice(0, 120); } this.finish(p.requestId, true); });
    cdp.on('Page.loadEventFired', () => { this.loaded?.(); });
    cdp.on('Page.frameNavigated', (p) => { if (!p.frame?.parentId) this.onUrl(p.frame.url); });
    for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await cdp.send(`${domain}.enable`, {});
  }

  touch() { this.lastActivity = Date.now(); }

  finish(id, failed = false) {
    const row = this.pending.get(id);
    if (!row) return;
    this.pending.delete(id);
    row.ms = Date.now() - row.t0; delete row.t0;
    if (!failed && API_TYPES.has(row.type)) {   // the response of an API call, kept short, for the evidence
      const job = this.cdp.send('Network.getResponseBody', { requestId: id }).then((b) => { row.body = String(b.body || '').slice(0, BODY_CHARS); }).catch(() => {}).finally(() => this.bodies.delete(job));
      this.bodies.add(job);
    }
    this.netRows.push(row);
  }

  async evaluate(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new BrowserError(`the page script failed: ${(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0].slice(0, 200)}`);
    return r.result.value;
  }

  // ---- operations ------------------------------------------------------------------------------
  async open({ url }) {
    if (!/^(https?|file|about):/i.test(String(url))) throw new BrowserError('the browser opens web addresses (http, https), local files and about:blank');
    const loaded = new Promise((resolve) => { this.loaded = resolve; });
    const nav = await this.cdp.send('Page.navigate', { url });
    if (nav.errorText) throw new BrowserError(`could not open ${url}: ${nav.errorText}`);
    await orTimeout(loaded, 15000);
    this.loaded = null;
    return null;
  }

  async snapshot() { return this.evaluate(`(${SNAPSHOT_JS})()`); }

  async centre(ref) {
    const box = await this.evaluate(`(() => { const el = document.querySelector('[data-jarvis-ref="${ref}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, rx: r.x, ry: r.y }; })()`);
    if (!box) throw new BrowserError(`there is no element ${ref} on the page now: take a new snapshot`);
    this.highlight(box).catch(() => {});
    return box;
  }

  /** A box on the element being acted on, in the page, for the owner to see (removed again after a moment). */
  async highlight(b) {
    await this.evaluate(`(() => { const d = document.createElement('div'); d.setAttribute('data-jarvis-highlight', ''); const s = d.style; s.position = 'fixed'; s.left = '${Math.round(b.rx)}px'; s.top = '${Math.round(b.ry)}px'; s.width = '${Math.round(b.w)}px'; s.height = '${Math.round(b.h)}px'; s.border = '2px solid #ffb347'; s.borderRadius = '4px'; s.boxShadow = '0 0 0 4px rgba(255,179,71,.25), 0 0 18px #ffb347'; s.pointerEvents = 'none'; s.zIndex = '2147483647'; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 1500); })()`);
  }

  async click({ ref }) {
    const { x, y } = await this.centre(ref);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return null;
  }

  async type({ ref, text, submit }) {
    await this.centre(ref);
    const ok = await this.evaluate(`(() => { const el = document.querySelector('[data-jarvis-ref="${ref}"]'); if (!el) return false; el.focus(); if (el.select) el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; })()`);
    if (!ok) throw new BrowserError(`there is no element ${ref} on the page now: take a new snapshot`);
    if (text === '') await this.press({ key: 'Delete' }); else await this.cdp.send('Input.insertText', { text });
    if (submit) await this.press({ key: 'Enter' });
    return null;
  }

  async press({ key }) {
    const k = KEYS[key] || (key.length === 1 ? { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!k) throw new BrowserError(`I do not know the key ${key}`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return null;
  }

  async scroll({ dy }) {
    const { w, h } = await this.evaluate('({ w: innerWidth, h: innerHeight })');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: dy });
    return null;
  }

  async reload() {
    const loaded = new Promise((resolve) => { this.loaded = resolve; });
    await this.cdp.send('Page.reload', {});
    await orTimeout(loaded, 15000);
    this.loaded = null;
    return null;
  }

  async screenshot() {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    return r.data;   // base64, as the server expects
  }

  /** Quiet = no request in flight and nothing new for quietMs (the page's own "idle" is already true after load). */
  async settle({ timeout_ms: timeout = 1500 } = {}) {
    await sleep(this.startGraceMs);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.pending.size === 0 && Date.now() - this.lastActivity >= this.quietMs) break;
      await sleep(40);
    }
    await Promise.allSettled([...this.bodies]);
    return null;
  }

  async console() { const lines = this.consoleLines; this.consoleLines = []; return lines; }

  async network() {
    await Promise.allSettled([...this.bodies]);
    const rows = this.netRows; this.netRows = [];
    return rows;
  }

  async close() {
    this.consoleLines = []; this.netRows = []; this.pending.clear();
    await this.cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    return null;
  }

  /** One operation by name, as the server sends them (browser_cmd). */
  async call(op, args = {}) {
    const fn = ['open', 'snapshot', 'click', 'type', 'press', 'scroll', 'reload', 'screenshot', 'settle', 'console', 'network', 'close'].includes(op) ? this[op] : null;
    if (!fn) throw new BrowserError(`unknown browser operation ${String(op).slice(0, 30)}`);
    return fn.call(this, args);
  }
}

const levelOf = (type) => ({ warning: 'warning', error: 'error', assert: 'error' }[type] || 'log');
const argsText = (args = []) => args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');

module.exports = { Driver, BrowserError, SNAPSHOT_JS };
