// The live work view: everything Jarvis and the agent in front DO in the session, as small live
// screens that come out of the core, play, and melt back into it.
//
// Server: jarvis/activity/feed.py sends `exec_start` (a card begins: who, kind, title) and `exec_end`
// (its structured result). A card forms where there is room around the core (a particle beam carries
// it out), shows the work live (js/exec/render.js), stays a few seconds (longer for big results;
// hovering, touching or clicking anything in it keeps it), then folds back into the core with a
// reverse beam. Results that lead somewhere (a folder browsed, a file opened from a listing) become
// new cards LINKED to the one they came from by a light line; a chain stays while it is used.
//
// Clicks act through handles (`exec_action`): open on the laptop, browse here, show in folder, view
// on this screen, open a terminal there. Each action shows up as its own command card.
//
// Phone: one card at a time in the lower half (above the controls), earlier ones as chips in a strip
// at the top; tapping a chip brings its card back. Levels (rail button, remembered per device):
// full (default) / minimal (one ticker line) / off. Lite tier: cards without beams or typing.
// Performance: transform/opacity only, no backdrop-filter, contained cards, <= MAX_CARDS on screen.

import { el, persona } from '../util.js';
import { windows, isCompact } from '../holowin.js';
import { render, icon, KIND_ICON } from './render.js';
import { ActionMenu } from './menu.js';

const MAX_CARDS = 4;          // on the laptop; the phone shows one (+ chips)
const MAX_CHIPS = 8;
const LINGER_MS = 4200;       // after the result played
const LINGER_PER_KB = 900;    // bigger results stay longer...
const LINGER_MAX_MS = 11000;  // ...up to this
const CHAIN_IDLE_MS = 9000;   // a chain the owner is clicking through stays this long after the last click
const LEVELS = ['full', 'minimal', 'off'];
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function readLevel() { try { return LEVELS.includes(localStorage.getItem('jarvis.exec.level')) ? localStorage.getItem('jarvis.exec.level') : 'full'; } catch { return 'full'; } }
function saveLevel(v) { try { localStorage.setItem('jarvis.exec.level', v); } catch { /* storage unavailable */ } }
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export class ExecLayer {
  /** @param o core (orb host: point(), beam()), send(msg), toast(text), openFile(file) */
  constructor({ core, send, toast, openFile }) {
    this.core = core; this.send = send; this.toast = toast; this.openFile = openFile;
    this.level = readLevel();
    this.cards = new Map();   // id -> card
    this.order = [];          // ids on screen, oldest first
    this.reqs = new Map();    // pending action request id -> the node that asked
    this.root = el('div', { class: 'xl', id: 'exec-layer', 'aria-live': 'polite', 'aria-label': 'Live work' });
    this.links = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.links.setAttribute('class', 'xl-links'); this.links.setAttribute('aria-hidden', 'true');
    this.chips = el('div', { class: 'xl-chips', 'aria-label': 'Earlier work' });
    this.ticker = el('div', { class: 'xl-ticker', role: 'status', hidden: true });
    this.root.append(this.links, this.chips, this.ticker);
    document.body.append(this.root);
    this.menu = new ActionMenu({ act: (h, a, n) => this.act(h, a, n) });
    this.ctx = {
      act: (h, a, n) => this.act(h, a, n), menu: (item, x, y, n) => this.menu.open(item, x, y, n),
      touch: (n) => { const c = n?.closest?.('.xc'); if (c) this.touchChain(this.cards.get(c.dataset.id)); },
    };
    this.root.dataset.level = this.level;
    addEventListener('resize', () => this.relayout());
    this.loop = 0;
  }

  // ---------------------------------------------------------------------------- level

  cycleLevel() {
    this.level = LEVELS[(LEVELS.indexOf(this.level) + 1) % LEVELS.length];
    saveLevel(this.level); this.root.dataset.level = this.level;
    if (this.level !== 'full') for (const id of [...this.order]) this.dissolve(this.cards.get(id), true);
    return this.level;
  }

  // ---------------------------------------------------------------------------- server messages

  start(m) {
    if (this.level === 'off') return;
    if (this.level === 'minimal') { this.tick(m, null); return; }
    const who = m.who || 'jarvis';
    const p = who === 'owner' ? { name: 'You', css: 'var(--you)' } : persona(who);
    const timer = el('span', { class: 'xc-time', text: '' });
    const title = el('span', { class: 'xc-title', text: m.title || m.kind });
    const pin = el('button', { type: 'button', class: 'xc-btn', title: 'Keep it on screen', 'aria-label': 'Pin', 'aria-pressed': 'false' }, icon('M9 4h6l-1 6 3 3H7l3-3zM12 13v7'));
    const close = el('button', { type: 'button', class: 'xc-btn', title: 'Dismiss', 'aria-label': 'Dismiss' }, icon('M7 7l10 10M17 7L7 17'));
    const body = el('div', { class: 'xc-body' });
    const node = el('section', { class: `xc k-${m.kind} running`, dataset: { id: m.id, who }, 'aria-label': `${p.name}: ${m.title || m.kind}` },
      el('i', { class: 'xc-edge', 'aria-hidden': 'true' }), el('i', { class: 'xc-scanline', 'aria-hidden': 'true' }),
      el('header', { class: 'xc-head' }, el('span', { class: 'xc-who', title: p.name }, icon(KIND_ICON[m.kind] || KIND_ICON.tool)), el('b', { class: 'xc-name', text: p.name }), title, el('span', { class: 'spacer' }), timer, pin, close),
      body);
    node.style.setProperty('--who', p.css || p.color);
    const parent = m.parent ? this.cards.get(m.parent) : null;
    if (m.detail?.wide) node.classList.add('xc-wide');
    const card = { id: m.id, node, body, timer, title: m.title, wide: !!m.detail?.wide, kind: m.kind, who, parent: parent?.id || null, children: new Set(), started: performance.now(), done: false, pinned: false, hold: 0, linger: 0, root: parent ? parent.root : m.id, chip: null };
    if (parent) parent.children.add(card.id);
    pin.addEventListener('click', (e) => { e.stopPropagation(); card.pinned = !card.pinned; pin.setAttribute('aria-pressed', String(card.pinned)); node.classList.toggle('pinned', card.pinned); if (!card.pinned) this.schedule(card); });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.dissolve(card, true); });
    node.addEventListener('pointerenter', () => this.hold(card, true));
    node.addEventListener('pointerleave', () => this.hold(card, false));
    node.addEventListener('pointerdown', () => this.touchChain(card));
    this.cards.set(card.id, card); this.order.push(card.id);
    this.root.append(node);
    this.make_room();
    this.place(card);
    this.appear(card);
    this.tickTimers();
    this.tick(m, card);
  }

  async end(m) {
    const card = this.cards.get(m.id);
    if (this.level === 'minimal') { this.tickEnd(m); return; }
    if (!card) return;
    card.done = true; card.ok = m.ok;
    card.node.classList.remove('running'); card.node.classList.add(m.ok ? 'ok' : 'failed');
    card.timer.textContent = fmtMs(m.ms ?? performance.now() - card.started);
    const view = render(m.result, this.ctx);
    card.body.replaceChildren(view.node);
    if (!calm()) view.node.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
    this.settle(card);
    try { await view.play(); } catch { /* the card went away while it played */ }
    if (!card.node.isConnected) return;
    this.drawLinks();
    card.linger = Math.min(LINGER_MAX_MS, LINGER_MS + (view.size / 1024) * LINGER_PER_KB + (m.ok ? 0 : 3000));
    this.schedule(card);
  }

  actionResult(m) {
    const node = this.reqs.get(m.req); this.reqs.delete(m.req);
    node?.classList.remove('xr-busy');
    if (!m.ok) { this.toast(m.error || 'That did not work.'); node?.classList.add('xr-shake'); setTimeout(() => node?.classList.remove('xr-shake'), 500); return; }
    if (m.file) this.openFile(m.file);
    if (m.action === 'open' || m.action === 'reveal') this.toast(m.action === 'open' ? 'Opened on the laptop' : 'Shown on the laptop');
  }

  // ---------------------------------------------------------------------------- owner's clicks

  act(handle, action, node) {
    const req = Math.random().toString(36).slice(2, 10);
    this.reqs.set(req, node || null);
    node?.classList.add('xr-busy');
    const card = node?.closest?.('.xc'); if (card) this.touchChain(this.cards.get(card.dataset.id));
    if (!this.send({ type: 'exec_action', handle, action, req })) node?.classList.remove('xr-busy');
  }

  touchChain(card) {
    if (!card) return;
    const until = performance.now() + CHAIN_IDLE_MS;
    for (const c of this.cards.values()) if (c.root === card.root) { c.chainUntil = until; if (c.done && !c.pinned) this.schedule(c); }
  }

  hold(card, on) {
    card.hovered = on;
    if (!on && card.done) this.schedule(card);
    if (on) clearTimeout(card.hold);
  }

  schedule(card) {
    clearTimeout(card.hold);
    if (card.pinned || card.hovered || !card.done) return;
    const chain = Math.max(0, (card.chainUntil || 0) - performance.now());
    card.hold = setTimeout(() => this.maybeDissolve(card), Math.max(card.linger || LINGER_MS, chain));
  }

  maybeDissolve(card) {
    if (!this.cards.has(card.id) || card.pinned || card.hovered) return;
    const live = [...card.children].map((id) => this.cards.get(id)).filter(Boolean);
    if (live.some((c) => !c.done || c.pinned || c.hovered)) { card.hold = setTimeout(() => this.maybeDissolve(card), 1500); return; }
    for (const child of live) this.dissolve(child);
    this.dissolve(card);
  }

  // ---------------------------------------------------------------------------- placement

  make_room() {
    const limit = isCompact() ? 1 : MAX_CARDS;
    while (this.order.length > limit) {
      // the oldest finished, unpinned card goes first; on the phone it becomes a chip
      const id = this.order.find((i) => { const c = this.cards.get(i); return c && c.done && !c.pinned; }) || this.order[0];
      const card = this.cards.get(id);
      if (isCompact()) this.toChip(card); else this.dissolve(card);
      if (this.order.includes(id)) this.order.splice(this.order.indexOf(id), 1);
    }
  }

  place(card, again = false) {
    const node = card.node;
    if (isCompact()) { node.classList.add('xc-phone'); return; }
    const vw = innerWidth; const vh = innerHeight;
    const w = card.wide ? Math.min(640, Math.max(440, vw * 0.4)) : Math.min(400, Math.max(300, vw * 0.27));
    const h = again ? Math.min(node.offsetHeight || 220, vh * 0.56) : 150;
    const core = this.core.point();
    const area = { x: 84, y: 66, w: vw - 84 - (vw > 900 ? 290 : 16), h: vh - 66 - 150 };
    const busy = [
      ...windows.all().filter((win) => !win.minimised && win.kind !== 'debrief').map((win) => win.geo()),
      ...[...this.cards.values()].filter((c) => c !== card && c.rect).map((c) => c.rect),
      { x: core.x - core.r * 1.15, y: core.y - core.r * 1.15, w: core.r * 2.3, h: core.r * 2.3 },
    ];
    const parent = card.parent ? this.cards.get(card.parent) : null;
    const gap = 18;
    const spots = [];
    if (parent?.rect) {
      const p = parent.rect;
      spots.push({ x: p.x + p.w + gap, y: p.y + 24 }, { x: p.x - w - gap, y: p.y + 24 }, { x: p.x, y: p.y + p.h + gap }, { x: p.x + 40, y: p.y - h - gap });
    }
    const off = core.r * 1.25 + gap;
    spots.push(
      { x: core.x + off, y: core.y - h - 8 }, { x: core.x + off, y: core.y + 8 },
      { x: core.x - off - w, y: core.y - h - 8 }, { x: core.x - off - w, y: core.y + 8 },
      { x: core.x + off + w + gap, y: core.y - h / 2 }, { x: core.x - off - 2 * w - gap, y: core.y - h / 2 },
      { x: core.x - w / 2, y: core.y + core.r * 1.3 },
    );
    let best = null; let bestCost = Infinity;
    for (const s of spots) {
      const r = { x: Math.max(area.x, Math.min(s.x, area.x + area.w - w)), y: Math.max(area.y, Math.min(s.y, area.y + area.h - h)), w, h };
      const cost = busy.reduce((sum, b) => sum + overlap(r, b), 0) + Math.hypot(r.x - s.x, r.y - s.y) * 4;
      if (cost < bestCost) { bestCost = cost; best = r; }
      if (cost === 0) break;
    }
    card.rect = best;
    node.style.setProperty('--x', `${Math.round(best.x)}px`); node.style.setProperty('--y', `${Math.round(best.y)}px`); node.style.setProperty('--w', `${Math.round(w)}px`);
    if (again) requestAnimationFrame(() => { if (card.rect) card.rect.h = node.offsetHeight; this.drawLinks(); });
  }

  /** The card grew (its result arrived): it stays where it is; only if it now runs off the
   *  bottom of the screen does it glide up just enough (a transform, never a jump). */
  settle(card) {
    if (isCompact() || !card.rect) return;
    requestAnimationFrame(() => {
      const node = card.node;
      const h = node.offsetHeight; const bottom = innerHeight - 150;
      card.rect.h = h;
      const y = Math.max(66, Math.min(card.rect.y, bottom - h));
      if (Math.abs(y - card.rect.y) > 1) {
        const dy = card.rect.y - y;
        card.rect.y = y;
        node.style.setProperty('--y', `${Math.round(y)}px`);
        if (!calm()) node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
      }
      this.drawLinks();
    });
  }

  relayout() {
    for (const id of this.order) { const c = this.cards.get(id); if (c) this.place(c, true); }
    this.drawLinks();
  }

  /** Light lines between linked cards, each with a travelling dot. */
  drawLinks() {
    const ns = 'http://www.w3.org/2000/svg';
    this.links.replaceChildren();
    if (isCompact()) return;
    for (const card of this.cards.values()) {
      const parent = card.parent && this.cards.get(card.parent);
      if (!parent?.rect || !card.rect || !card.node.isConnected || !parent.node.isConnected) continue;
      const a = parent.rect; const b = card.rect;
      const ax = b.x > a.x + a.w ? a.x + a.w : b.x + b.w < a.x ? a.x : a.x + a.w / 2;
      const ay = b.x > a.x + a.w || b.x + b.w < a.x ? a.y + 34 : a.y + a.h;
      const bx = b.x > a.x + a.w ? b.x : b.x + b.w < a.x ? b.x + b.w : b.x + b.w / 2;
      const by = b.x > a.x + a.w || b.x + b.w < a.x ? b.y + 34 : b.y;
      const d = `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${by} ${bx},${by}`;
      const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); path.setAttribute('class', 'xl-link');
      path.style.setProperty('--who', card.node.style.getPropertyValue('--who'));
      const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('r', '3'); dot.setAttribute('class', 'xl-dot');
      dot.style.setProperty('offset-path', `path("${d}")`);
      this.links.append(path, dot);
    }
  }

  // ---------------------------------------------------------------------------- forming / melting

  appear(card) {
    const node = card.node;
    if (calm()) { node.classList.add('xc-in'); return; }
    const core = this.core.point();
    const r = node.getBoundingClientRect();
    if (!isCompact()) this.core.beam?.({ x: r.x, y: r.y, w: r.width, h: Math.max(r.height, 120) }, 1);
    // a short way out from the core's side: direction only, a few dozen pixels, never a long flight
    const dx = core.x - (r.x + r.width / 2); const dy = core.y - (r.y + r.height / 2);
    const len = Math.hypot(dx, dy) || 1; const k = isCompact() ? 0 : 36 / len;
    node.style.setProperty('will-change', 'transform, opacity');
    node.animate([
      { transform: `translate(${dx * k}px, ${isCompact() ? 18 : dy * k}px) scale(.94)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)', delay: isCompact() ? 0 : 120 })
      .finished.then(() => { node.style.removeProperty('will-change'); node.classList.add('xc-in'); }, () => {});
    node.style.setProperty('opacity', '0');   // hidden during the delay (the beam is on its way)
    setTimeout(() => node.style.removeProperty('opacity'), isCompact() ? 0 : 120);
  }

  dissolve(card, quick = false) {
    if (!card || card.gone) return;
    card.gone = true; clearTimeout(card.hold);
    this.cards.delete(card.id);
    const at = this.order.indexOf(card.id); if (at >= 0) this.order.splice(at, 1);
    for (const child of card.children) this.dissolve(this.cards.get(child), quick);
    card.chip?.remove();
    const node = card.node;
    const done = () => { node.remove(); this.drawLinks(); };
    if (calm() || !node.isConnected) { done(); return; }
    const r = node.getBoundingClientRect();
    const core = this.core.point();
    const dx = core.x - (r.x + r.width / 2); const dy = core.y - (r.y + r.height / 2);
    node.style.setProperty('pointer-events', 'none'); node.style.setProperty('will-change', 'transform, opacity');
    const len = Math.hypot(dx, dy) || 1; const k = isCompact() ? 0 : 44 / len;
    const a = node.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx * k}px, ${isCompact() ? 14 : dy * k}px) scale(.92)`, opacity: 0 },
    ], { duration: quick ? 260 : 420, easing: 'cubic-bezier(.4, 0, .9, .4)', fill: 'forwards' });
    if (!isCompact()) setTimeout(() => this.core.beam?.({ x: r.x, y: r.y, w: r.width, h: r.height }, -1), quick ? 40 : 160);
    a.finished.then(done, done);
    setTimeout(done, 1000);
  }

  // ---------------------------------------------------------------------------- phone chips

  toChip(card) {
    if (!card || card.chip) return;
    card.node.classList.add('xc-parked');
    const chip = el('button', { type: 'button', class: `xl-chip ${card.done ? (card.ok === false ? 'failed' : 'ok') : 'running'}`, title: card.title },
      icon(KIND_ICON[card.kind] || KIND_ICON.tool), el('span', { text: card.title }));
    chip.style.setProperty('--who', card.node.style.getPropertyValue('--who'));
    chip.addEventListener('click', () => this.unpark(card));
    card.chip = chip;
    this.chips.prepend(chip);
    while (this.chips.children.length > MAX_CHIPS) {
      const last = this.chips.lastElementChild; const id = [...this.cards.values()].find((c) => c.chip === last);
      if (id) this.dissolve(id, true); else last.remove();
    }
    clearTimeout(card.hold);
    card.hold = setTimeout(() => this.dissolve(card, true), 60000);   // a parked card leaves after a minute
  }

  unpark(card) {
    for (const id of [...this.order]) { const c = this.cards.get(id); if (c && c !== card) { this.toChip(c); this.order.splice(this.order.indexOf(id), 1); } }
    card.chip?.remove(); card.chip = null;
    card.node.classList.remove('xc-parked');
    if (!this.order.includes(card.id)) this.order.push(card.id);
    this.touchChain(card); this.schedule(card);
  }

  // ---------------------------------------------------------------------------- ticker (minimal)

  tick(m, card) {
    if (this.level !== 'minimal' && !(isCompact() && card === null)) return;
    const p = m.who === 'owner' ? { name: 'You' } : persona(m.who || 'jarvis');
    this.ticker.hidden = false;
    this.ticker.replaceChildren(el('i', { class: 'xl-pulse' }), el('b', { text: p.name }), el('span', { text: m.title || m.kind }));
    clearTimeout(this.tickTimer); this.tickTimer = setTimeout(() => { this.ticker.hidden = true; }, 6000);
  }

  tickEnd(m) {
    if (this.ticker.hidden) return;
    this.ticker.classList.toggle('bad', !m.ok);
    clearTimeout(this.tickTimer); this.tickTimer = setTimeout(() => { this.ticker.hidden = true; this.ticker.classList.remove('bad'); }, 2500);
  }

  tickTimers() {
    if (this.loop) return;
    const step = () => {
      let any = false;
      for (const card of this.cards.values()) if (!card.done) { any = true; card.timer.textContent = fmtMs(performance.now() - card.started); }
      this.loop = any ? setTimeout(step, 200) : 0;
    };
    this.loop = setTimeout(step, 200);
  }

  /** For tests and diagnosis. */
  state() { return [...this.cards.values()].map((c) => ({ id: c.id, kind: c.kind, who: c.who, done: c.done, parent: c.parent, parked: !!c.chip })); }
}

function fmtMs(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`; }
