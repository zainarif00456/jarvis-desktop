// Hologram portals: draggable, resizable, minimisable, full-screen windows that carry live video,
// files, tools and reports on the main deck. One look for everything (css/holo.css).
//
// Jarvis drives them too (js/screen.js): every portal has a stable id, says what it holds
// (`item`), and reports every change through `windows.onChange`, so the server always knows what
// is on the screen. Moves made for Jarvis (arrange, maximise) animate with transforms only.

import { el } from './util.js';

const wins = new Map();
const listeners = new Set();
// Set by the workspace (js/workspace/workspace.js): how portals form/leave, and what a drag does.
//   hooks.effects = { open(win), close(win, remove) }
//   hooks.drag = { move(win, x, y), end(win, x, y) -> true when it placed the portal itself }
const hooks = { effects: null, drag: null };
let zTop = 20;
let cascade = 0;
const layer = () => document.getElementById('hw-layer');
const tray = () => document.getElementById('hw-tray');
export const isCompact = () => window.matchMedia('(max-width: 760px)').matches;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const IDLE_MS = 2600;  // full screen: the controls fade after this long without the mouse moving

function saved(id) { try { return JSON.parse(localStorage.getItem(`jarvis.win.${id}`) || 'null'); } catch { return null; } }
function save(id, geo) { try { localStorage.setItem(`jarvis.win.${id}`, JSON.stringify(geo)); } catch { /* storage unavailable */ } }
function changed(win, what) { for (const fn of listeners) { try { fn(win, what); } catch (err) { console.error(err); } } }

const ICON = {
  min: 'M6 15h12',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  close: 'M7 7l10 10M17 7L7 17',
};
const icon = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); return svg;
};
const deco = (cls) => el('i', { class: cls, 'aria-hidden': 'true' });

export class HoloWindow {
  /**
   * @param {object} o  id (unique key), kind, title, width, height, minW, minH, tags (nodes), onClose,
   *                    resizable, full (allow full screen), className, item ({type, id, name}: what it shows),
   *                    persona (the AI it belongs to, e.g. the agent who wrote a report)
   */
  constructor(o) {
    this.id = o.id; this.kind = o.kind || 'panel'; this.onClose = o.onClose; this.onFull = o.onFull;
    this.minW = o.minW || 320; this.minH = o.minH || 220; this.resizable = o.resizable !== false;
    this.maximised = false; this.minimised = false; this.closed = false; this.item = o.item || null;
    this.persona = o.persona || null;
    this.movable = o.movable !== false;   // false: fixed in place (the stage debrief)   // the AI this portal belongs to (presence: its colour while it is in front)
    this.titleEl = el('span', { class: 'hw-title', text: o.title || '' });
    this.tagsEl = el('span', { class: 'hw-tags' }, ...(o.tags || []));
    const button = (cls, label, title, d, fn) => el('button', { type: 'button', class: `hb ${cls}`, 'aria-label': label, title, onclick: fn }, icon(d));
    this.btnMin = button('min', 'Minimise', 'Minimise', ICON.min, () => this.minimise());
    this.btnFull = o.full === false ? null : button('full', 'Full screen', 'Full screen (F)', ICON.full, () => this.toggleFull());
    this.btnClose = button('close', 'Close', 'Close (Esc)', ICON.close, () => this.close());
    this.bar = el('header', { class: 'hw-bar' }, el('i', { class: 'hw-led' }), this.titleEl, this.tagsEl, el('span', { class: 'spacer' }));
    this.body = el('div', { class: 'hw-body' });
    this.grip = this.resizable ? el('i', { class: 'hw-grip', 'aria-hidden': 'true' }) : null;
    const arc = (side) => el('i', { class: `hw-arc ${side}`, 'aria-hidden': 'true' }, el('i'));
    this.el = el('section', { class: `hw k-${this.kind} ${o.className || ''}`, role: 'dialog', 'aria-label': o.title || this.kind, tabindex: '-1', dataset: { kind: this.kind, win: this.id } },
      deco('hw-aura'), deco('hw-plate'), deco('hw-edge'), arc('t'), arc('r'), arc('b'), arc('l'),
      deco('hw-node tl'), deco('hw-node tr'), deco('hw-node bl'), deco('hw-node br'),
      this.bar, el('nav', { class: 'hw-ctl' }, this.btnMin, this.btnFull, this.btnClose), this.body, this.grip,
      el('i', { class: 'hw-sweep', 'aria-hidden': 'true' }, el('i')));
    this.place(o.width || 720, o.height || 480);
    layer().append(this.el);
    this.el.addEventListener('animationend', (e) => { if (e.target === this.el) this.el.classList.remove('opening'); });
    this.el.addEventListener('pointerdown', () => this.focus(), true);
    this.bindDrag(); this.bindResize(); this.bindIdle();
    this.onFsChange = () => this.syncFull();
    document.addEventListener('fullscreenchange', this.onFsChange);
    wins.set(this.id, this); this.focus(); changed(this, 'open');
    // after 'open': the workspace has placed it, so the forming effect aims at its final place
    if (hooks.effects) hooks.effects.open(this); else this.el.classList.add('opening');
  }

  place(w, h) {
    const vw = window.innerWidth; const vh = window.innerHeight;
    if (isCompact()) { this.el.classList.add('sheet'); return; }
    if (!this.movable) return;   // placed by its own CSS
    const geo = saved(this.id);
    const width = clamp(geo?.w || w, this.minW, vw - 24); const height = clamp(geo?.h || h, this.minH, vh - 24);
    const off = (cascade++ % 6) * 26;
    const left = clamp(geo?.x ?? (vw - width) / 2 + off - 52, 8, Math.max(8, vw - width - 8));
    const top = clamp(geo?.y ?? (vh - height) / 2 + off - 52, 16, Math.max(16, vh - height - 8));
    this.setGeo({ x: left, y: top, w: width, h: height });
  }
  setGeo({ x, y, w, h }) {
    const s = this.el.style;
    s.setProperty('left', `${x}px`); s.setProperty('top', `${y}px`); s.setProperty('width', `${w}px`); s.setProperty('height', `${h}px`);
  }
  geo() { const r = this.el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }

  /** Move/resize with a FLIP animation: the layout changes once, the motion is a transform. */
  moveTo(target, { persist = true, duration = 420, animate = true } = {}) {
    if (this.closed || this.el.classList.contains('sheet')) return;
    if (this.maximised) this.setMax(false, { animate: false });
    const from = this.geo();
    this.setGeo(target);
    if (persist) save(this.id, target);
    if (animate && !reduced() && from.w && from.h) {
      const sx = from.w / target.w; const sy = from.h / target.h;
      this.el.animate([
        { transformOrigin: '0 0', transform: `translate(${from.x - target.x}px, ${from.y - target.y}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    this.el.dispatchEvent(new CustomEvent('hw-resize'));
    changed(this, 'geo');
  }

  focus() {
    if (this.closed) return;
    const was = this.el.classList.contains('active');
    this.el.style.setProperty('z-index', String(++zTop));
    for (const w of wins.values()) w.el.classList.toggle('active', w === this);
    if (!was) changed(this, 'focus');
  }
  /** Jarvis points at this portal ("this one"): the halo pulses. */
  flag() {
    if (this.closed) return;
    this.el.classList.remove('flag'); void this.el.offsetWidth; this.el.classList.add('flag');
    clearTimeout(this.flagTimer); this.flagTimer = setTimeout(() => this.el.classList.remove('flag'), 2300);
  }
  setTitle(text) { this.titleEl.textContent = text; this.el.setAttribute('aria-label', text); changed(this, 'title'); }
  setTags(...nodes) { this.tagsEl.replaceChildren(...nodes.filter(Boolean)); }
  setItem(item) { this.item = item; changed(this, 'item'); }

  bindDrag() {
    let drag = null;
    this.bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || this.maximised || !this.movable || this.el.classList.contains('sheet') || e.button > 0) return;
      const r = this.geo(); this.prevGeo = r; drag = { id: e.pointerId, dx: e.clientX - r.x, dy: e.clientY - r.y };
      this.bar.setPointerCapture(e.pointerId); this.el.classList.add('dragging');
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = this.geo();
      this.setGeo({ x: clamp(e.clientX - drag.dx, 60 - r.w, window.innerWidth - 60), y: clamp(e.clientY - drag.dy, 0, window.innerHeight - 40), w: r.w, h: r.h });
      hooks.drag?.move(this, e.clientX, e.clientY);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; this.el.classList.remove('dragging');
      if (e.type === 'pointerup' && hooks.drag?.end(this, e.clientX, e.clientY)) return;
      hooks.drag?.end(this, null, null);
      save(this.id, this.geo()); changed(this, 'moved');   // placed by hand: the workspace leaves it there
    };
    this.bar.addEventListener('pointerup', end); this.bar.addEventListener('pointercancel', end);
    this.bar.addEventListener('lostpointercapture', end);   // capture lost without a pointerup: still finish the drag
    this.bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && this.btnFull) this.toggleFull(); });
  }
  bindResize() {
    if (!this.grip) return;
    let rs = null;
    this.grip.addEventListener('pointerdown', (e) => {
      if (this.maximised) return; const r = this.geo();
      rs = { id: e.pointerId, x: e.clientX, y: e.clientY, w: r.w, h: r.h, l: r.x, t: r.y };
      this.grip.setPointerCapture(e.pointerId); this.el.classList.add('dragging'); e.preventDefault();
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      this.setGeo({ x: rs.l, y: rs.t, w: clamp(rs.w + e.clientX - rs.x, this.minW, window.innerWidth - rs.l), h: clamp(rs.h + e.clientY - rs.y, this.minH, window.innerHeight - rs.t) });
      this.el.dispatchEvent(new CustomEvent('hw-resize'));
    });
    const end = (e) => { if (!rs || e.pointerId !== rs.id) return; rs = null; this.el.classList.remove('dragging'); save(this.id, this.geo()); changed(this, 'moved'); };
    this.grip.addEventListener('pointerup', end); this.grip.addEventListener('pointercancel', end);
  }
  // Full screen: the controls and title fade away while the mouse rests, and come back on a move.
  bindIdle() {
    const wake = () => {
      if (!this.el.classList.contains('is-full')) return;
      this.el.classList.remove('idle'); clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.el.classList.add('idle'), IDLE_MS);
    };
    this.el.addEventListener('pointermove', wake, { passive: true });
    this.el.addEventListener('pointerdown', wake, { passive: true });
    this.wake = wake;
  }

  // Real browser full screen when allowed (needs a click or key press), otherwise the portal fills
  // the page. Jarvis's commands come without a click, so they use the page-filling mode.
  async toggleFull() {
    if (document.fullscreenElement === this.el) { await document.exitFullscreen().catch(() => {}); return; }
    if (this.maximised) { this.setMax(false); return; }
    this.focus();
    if (!document.documentElement.hasAttribute('data-jd-desktop') && this.el.requestFullscreen && navigator.userActivation?.isActive !== false) {   // desktop: the shell fills the display itself (no HTML fullscreen)
      try { await this.el.requestFullscreen(); return; } catch { /* fall back below */ }
    }
    this.setMax(true);
  }
  setMax(on, { animate = true } = {}) {
    if (this.maximised === on) return;
    const from = this.geo();
    this.maximised = on; this.el.classList.toggle('max', on); this.syncFull();
    if (animate && !reduced() && !this.el.classList.contains('sheet')) {
      const to = this.geo();
      this.el.animate([
        { transformOrigin: '0 0', transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }
  exitFull() {
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    if (this.maximised) this.setMax(false);
  }
  get full() { return document.fullscreenElement === this.el || this.maximised; }
  syncFull() {
    const full = this.full;
    this.el.classList.toggle('is-full', full);
    if (!full) { this.el.classList.remove('idle'); clearTimeout(this.idleTimer); } else this.wake?.();
    if (this.btnFull) { this.btnFull.replaceChildren(icon(full ? ICON.exit : ICON.full)); this.btnFull.title = full ? 'Leave full screen (F)' : 'Full screen (F)'; this.btnFull.setAttribute('aria-label', full ? 'Leave full screen' : 'Full screen'); }
    if (this.onFull) this.onFull(full);
    document.documentElement.toggleAttribute('data-jd-full', [...wins.values()].some((w) => w.full));   // the shell watches this (overlay / window full screen)
    this.el.dispatchEvent(new CustomEvent('hw-resize'));
    changed(this, 'full');
  }

  minimise() {
    if (this.minimised || this.closed) return;
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    this.minimised = true; this.el.classList.add('minimised');
    this.chip = el('button', { type: 'button', class: 'hw-chip', onclick: () => this.restore() }, el('i', { class: 'hw-led' }), this.titleEl.textContent);
    tray().append(this.chip);
    changed(this, 'min');
  }
  restore() {
    if (!this.minimised) return;
    this.minimised = false; this.el.classList.remove('minimised'); this.chip?.remove(); this.chip = null; this.focus();
    changed(this, 'restore');
  }

  close() {
    if (this.closed) return;
    this.closed = true; wins.delete(this.id); document.documentElement.toggleAttribute('data-jd-full', [...wins.values()].some((w) => w.full));
    document.removeEventListener('fullscreenchange', this.onFsChange);
    clearTimeout(this.idleTimer); clearTimeout(this.flagTimer);
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    this.chip?.remove();
    if (this.onClose) { try { this.onClose(); } catch (err) { console.error(err); } }
    changed(this, 'close');
    let gone = false;
    const remove = () => { if (!gone) { gone = true; this.el.remove(); } };
    this.el.classList.remove('opening', 'forming');
    if (reduced()) remove();
    else if (hooks.effects) hooks.effects.close(this, remove);
    else { this.el.classList.add('closing'); this.el.addEventListener('animationend', remove, { once: true }); setTimeout(remove, 500); }
  }
}

export const windows = {
  get: (id) => wins.get(id),
  all: () => [...wins.values()],
  closeAll: () => { for (const w of [...wins.values()]) w.close(); },
  top() { return [...wins.values()].filter((w) => !w.minimised).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0]; },
  /** fn(win, what) on open | close | focus | geo | moved (by hand) | full | min | restore | title | item */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  changed,
  hooks,
};

// Esc closes the topmost window (before anything else reacts); F toggles its full screen.
document.addEventListener('keydown', (e) => {
  const top = windows.top();
  if (!top || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape' && !typing && document.fullscreenElement == null) { e.stopImmediatePropagation(); if (top.maximised) top.setMax(false); else top.close(); }
  else if (e.key.toLowerCase() === 'f' && !typing && top.btnFull) { e.preventDefault(); top.toggleFull(); }
}, true);
