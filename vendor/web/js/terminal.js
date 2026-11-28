// Live terminals on the screen: the owner's own shell, in a hologram window (laptop) or a full
// sheet (phone), typed into by them or by Jarvis (server: jarvis/terminal/, tools terminal.*).
//
// xterm.js is vendored (clients/web/vendor/xterm, loaded on first use). It draws with WebGL, or a 2D
// canvas when WebGL is not available: both keep our strict CSP (the DOM renderer would need inline
// <style>). Output arrives as raw bytes on /ws/terminal/{id}; keystrokes go back as bytes. A dropped
// socket reconnects and the server replays the screen. Closing the window ends the terminal.
//
// Phone: an input line (the phone keyboard is reliable there) plus a key row for what a phone
// keyboard lacks: Esc, Tab, Ctrl (sticky), arrows, ^C ^D ^L, paste, text size.

import { el } from './util.js';
import { HoloWindow, isCompact } from './holowin.js';

const VENDOR = '/vendor/xterm';
let loading = null;

function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = false;
    s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

/** xterm.js and its add-ons, once. */
function loadXterm() {
  if (!loading) {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = `${VENDOR}/xterm.css`; document.head.append(css);
    loading = Promise.all([script(`${VENDOR}/xterm.js`), script(`${VENDOR}/addon-fit.js`), script(`${VENDOR}/addon-webgl.js`), script(`${VENDOR}/addon-canvas.js`)])
      .then(() => window.Terminal);
  }
  return loading;
}

/** The part of a HoloWindow a terminal uses, for a terminal that lives in a pane (Development Mode). */
class DockedWindow {
  constructor(host, { tags, onClose }) {
    this.host = host; this.onCloseCb = onClose; this.closed = false; this.minimised = false;
    this.body = el('div', { class: 'tm-dock' });
    host.replaceChildren(el('div', { class: 'tm-dockbar' }, ...tags), this.body);
  }

  setTitle(text) { this.host.dataset.title = text; }
  restore() {}
  focus() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.host.replaceChildren(el('p', { class: 'dv-empty', text: 'Terminal closed' }));
    this.onCloseCb?.();
  }
}

const enc = new TextEncoder();
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', null], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['^L', '\x0c'], ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'],
];

class TerminalView {
  constructor(info, { toast, onClosed, persona, dock = null }) {
    this.id = info.id; this.info = info; this.toast = toast; this.onClosed = onClosed;
    this.ctrl = false; this.closed = false; this.retry = 0; this.fontSize = isCompact() ? 12 : 13;
    this.screen = el('div', { class: 'tm-screen' });
    this.state = el('span', { class: 'tm-state', text: 'connecting…' });
    this.body = el('div', { class: 'tm' }, this.screen);
    if (isCompact()) this.body.append(this.phoneControls());
    this.win = dock ? new DockedWindow(dock, { tags: [this.state], onClose: () => this.close() }) : new HoloWindow({
      id: `term-${info.id}`, kind: 'terminal', title: `Terminal · ${info.title || info.cwd}`,
      width: Math.min(820, innerWidth - 120), height: Math.min(500, innerHeight - 200), minW: 380, minH: 220,
      tags: [this.state], item: { type: 'terminal', id: info.id, name: info.title || info.cwd },
      persona, onClose: () => this.close(),
    });
    this.win.body.append(this.body);
    this.boot();
  }

  async boot() {
    let Terminal;
    try { Terminal = await loadXterm(); } catch (err) { this.state.textContent = 'could not load the terminal'; this.toast(String(err.message || err)); return; }
    const css = getComputedStyle(document.documentElement);
    const ai = css.getPropertyValue('--ai').trim() || '#4cc9f0';
    this.term = new Terminal({
      fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace', fontSize: this.fontSize,
      cursorBlink: true, allowProposedApi: false, scrollback: 5000, convertEol: false, macOptionIsMeta: true,
      theme: { background: '#02070c', foreground: '#d7e6f0', cursor: ai, cursorAccent: '#02070c', selectionBackground: `${ai}55` },
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.screen);
    try { this.term.loadAddon(new window.WebglAddon.WebglAddon()); } catch { try { this.term.loadAddon(new window.CanvasAddon.CanvasAddon()); } catch { /* DOM renderer: plain but works */ } }
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.sendRaw(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255)));
    this.resizer = new ResizeObserver(() => this.refit());
    this.resizer.observe(this.screen);
    this.connect();
    if (!isCompact()) this.term.focus();
  }

  connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${this.id}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let fresh = true;
    ws.onopen = () => { this.retry = 0; this.state.textContent = 'live'; this.state.className = 'tm-state live'; this.refit(true); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try { const m = JSON.parse(e.data); if (m.type === 'info') this.setInfo(m.terminal); } catch { /* not ours */ }
        return;
      }
      if (fresh) { this.term.reset(); fresh = false; }   // a reconnect replays the whole screen
      this.term.write(new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      if (this.closed) return;
      if (e.code === 4404) { this.ended(); return; }
      this.state.textContent = 'reconnecting…'; this.state.className = 'tm-state';
      setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** this.retry++));
    };
  }

  setInfo(info) {
    this.info = info;
    this.win.setTitle(`Terminal · ${info.title || info.cwd}`);
  }

  input(data) {
    if (this.ctrl && data.length === 1) {   // sticky Ctrl from the phone key row
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      this.setCtrl(false);
    }
    this.sendRaw(enc.encode(data));
  }

  sendRaw(bytes) { if (this.ws?.readyState === 1) this.ws.send(bytes); }

  refit(force = false) {
    if (!this.fit || !this.screen.offsetWidth) return;
    try { this.fit.fit(); } catch { return; }
    const { cols, rows } = this.term;
    if (force || cols !== this.cols || rows !== this.rows) {
      this.cols = cols; this.rows = rows;
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  phoneControls() {
    const line = el('input', { class: 'tm-line', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Type a command…', 'aria-label': 'Command' });
    const send = () => { this.input(`${line.value}\r`); line.value = ''; };
    line.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    this.ctrlBtn = null;
    const keys = el('div', { class: 'tm-keys', role: 'toolbar', 'aria-label': 'Special keys' }, ...KEYS.map(([label, seq]) => {
      const b = el('button', { type: 'button', class: 'tm-key', text: label });
      if (seq === null) { this.ctrlBtn = b; b.addEventListener('click', () => this.setCtrl(!this.ctrl)); }
      else b.addEventListener('click', () => { navigator.vibrate?.(6); this.input(seq); });
      return b;
    }),
    el('button', { type: 'button', class: 'tm-key', text: 'Paste', onclick: async () => { try { this.input(await navigator.clipboard.readText()); } catch { this.toast('Clipboard not available'); } } }),
    el('button', { type: 'button', class: 'tm-key', text: 'A−', onclick: () => this.zoom(-1) }),
    el('button', { type: 'button', class: 'tm-key', text: 'A+', onclick: () => this.zoom(1) }));
    return el('div', { class: 'tm-phone' }, keys, el('div', { class: 'tm-inrow' }, line, el('button', { type: 'button', class: 'tm-send', text: 'Run', onclick: send })));
  }

  setCtrl(on) { this.ctrl = on; this.ctrlBtn?.classList.toggle('on', on); }

  zoom(d) { this.fontSize = Math.max(8, Math.min(22, this.fontSize + d)); if (this.term) { this.term.options.fontSize = this.fontSize; this.refit(true); } }

  focus() {
    if (this.win.minimised) this.win.restore();
    this.win.focus();
    if (!isCompact()) this.term?.focus();
  }

  ended() {
    this.state.textContent = 'closed'; this.state.className = 'tm-state';
    this.closed = true; this.ws?.close();
  }

  close() {
    if (!this.closed) this.onClosed(this.id, true);
    this.closed = true;
    this.resizer?.disconnect(); this.ws?.close(); this.term?.dispose();
  }
}

/** Every terminal window on this page, following the server's terminal_opened / _focus / _closed. */
export class Terminals {
  constructor({ send, toast }) {
    this.send = send; this.toast = toast;
    this.views = new Map();
    this.dock = null;
  }

  /** The next terminal that opens goes into this element (a pane) instead of a floating window. */
  dockNext(host, onDocked) { this.dock = { host, onDocked }; }

  open(info, persona = null) {
    const have = this.views.get(info.id);
    if (have) { have.focus(); return have; }
    const dock = this.dock; this.dock = null;
    const view = new TerminalView(info, { toast: this.toast, persona, dock: dock?.host || null, onClosed: (id, byOwner) => this.closed(id, byOwner) });
    this.views.set(info.id, view);
    dock?.onDocked?.(view);
    return view;
  }

  /** The page (re)connected: show every terminal the server has open. */
  sync(list) {
    const live = new Set((list || []).map((t) => t.id));
    for (const [id, view] of this.views) if (!live.has(id)) { view.ended(); }
    for (const info of list || []) if (!this.views.has(info.id)) this.open(info);
  }

  focus(id) { this.views.get(id)?.focus(); }

  gone(id) {
    const view = this.views.get(id);
    if (!view) return;
    view.ended(); this.views.delete(id);
    setTimeout(() => { if (!view.win.closed) view.win.close(); }, 1500);
  }

  closed(id, byOwner) {
    this.views.delete(id);
    if (byOwner) this.send({ type: 'terminal_close', id });
  }

  launch(cwd = null) { this.send({ type: 'terminal_open', cwd }); }
}

