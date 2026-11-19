// Stage debriefs: an agent walks the owner through what she found, on the main stage beside the
// core (not in a portal). Scenes are briefing sections (js/report.js Section), so every voice cue
// a briefing understands works here unchanged (focus, item, diagram, code, row, media, zoom, cite).
//
// Look (css/debrief.css): small holographic POPUPS on the main screen, no window, no frame. The core
// shrinks a little and stays visible (workspace dock 'side'); each scene is one compact card that
// forms out of the core in the free space beside it (right, then left, alternating). When the agent
// moves on, the card just told slides outward and fades to a faint ghost (click it to bring it back),
// the one before it dissolves, and the next card pops in. At the end everything dissolves back into
// the core; no chip is left behind ("show me that again" replays it). A question's answer still
// plays inside its own card (host mode keeps the compact legacy layout: header, scene, stack).
//
// The cards' content is a briefing Section (js/report.js), so every voice cue a briefing understands
// works unchanged (focus, item, diagram, code, row, media, zoom, cite) and the pointer still tells
// Jarvis what "this" is. The layer itself is a HoloWindow (kind 'debrief', frameless and click-through)
// so the screen state, Jarvis's commands and the presence colour (its agent) come for free.

import { el, persona, ago } from '../util.js';
import { HoloWindow, windows } from '../holowin.js';
import { Section } from '../report.js';
import { showAside, closeAside } from './aside.js';

const LINGER_S = 6;
const STACK_MAX = 5;
const two = (n) => String(n).padStart(2, '0');
const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const settle = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());
// will-change only while it moves: a permanent hint keeps a compositor layer (video memory) alive per card
const play = (node, frames, opts) => {
  if (calm() || !node?.animate) return null;
  node.style.setProperty('will-change', 'transform, opacity');
  const a = node.animate(frames, { fill: 'both', easing: 'cubic-bezier(.2,.8,.2,1)', ...opts });
  a.finished.then(() => node.style.removeProperty('will-change'), () => node.style.removeProperty('will-change'));
  return a;
};

export class DebriefView {
  constructor(rid, data, { onClose, host = null } = {}) {
    this.host = host;   // set: an answer playing inside a paused briefing (its question card)
    this.rid = rid; this.info = data.info; this.report = data.report; this.onClose = onClose;
    this.mode = 'overview'; this.focusedId = null; this.section = null; this.seq = 0; this.pops = new Map();
    this.told = [];                                   // scene ids already shown (the stack)
    this.cards = !host;                               // popups on the main screen (host: legacy compact layout)
    this.shown = []; this.current = null;             // cards on screen: { id, section, card, side }
    const r = this.report; const who = persona(this.info.agent || 'friday');
    if (this.cards) { this.initCards(r); return; }
    this.pips = el('div', { class: 'db-pips', 'aria-hidden': 'true' }, ...r.blocks.map((b) => el('i', { class: `tone-${b.tone || 'normal'}`, dataset: { id: b.id } })));
    this.clock = el('span', { class: 'db-clock', text: 'T+00:00' });
    this.head = el('header', { class: 'db-head' },
      el('div', { class: 'db-sigil', 'aria-hidden': 'true' }, el('b', { text: who.initial }), el('i'), el('i')),
      el('div', { class: 'db-title' }, el('small', {}, el('b', { text: 'DEBRIEF' }), ` · ${who.name.toUpperCase()} · ${ago(this.info.created_at)}`), el('h1', { text: r.title })),
      this.pips, this.clock);
    this.scene = el('div', { class: 'db-scene' });
    this.stack = el('aside', { class: 'db-stack', 'aria-label': 'Scenes already shown' });
    this.intel = el('div', { class: 'db-intel', 'aria-live': 'polite' });
    this.linger = el('div', { class: 'db-linger', role: 'status' }, el('b', { text: 'DEBRIEF COMPLETE' }), el('div', { class: 'bar' }, el('i')),
      el('button', { type: 'button', text: 'Keep it up', onclick: () => this.keep() }));
    this.root = el('div', { class: 'db rp', dataset: { mode: 'overview' } }, this.head, el('div', { class: 'db-main' }, this.scene, this.stack), this.intel, this.linger);
    if (host) {
      // inside the briefing's question card: no portal of its own; the briefing's portal reports it
      this.root.classList.add('db-in-aside');
      const card = host.asideEl || showAside(host, { question: 'Follow-up', pending: '' });
      card.classList.add('wide');
      card.querySelector('.ax-pending')?.remove();
      card.querySelector('.ax-slot').replaceChildren(this.root);
      this.win = { el: card, closed: false, close: () => { if (this.win.closed) return; this.win.closed = true; this.teardown(); closeAside(host); }, minimise: () => this.win.close(), restore() {}, focus() {}, flag() {}, setMax() {} };
    } else {
      this.win = new HoloWindow({ id: `report-${rid}`, kind: 'debrief', className: 'stage-debrief', title: `DEBRIEF · ${r.title}`, full: false, resizable: false, movable: false,
        persona: this.info.agent || null, item: { type: 'report', id: rid, name: r.title, kind: 'debrief' }, onClose: () => this.teardown() });
      this.win.extra = () => ({ report: this.state() });
      this.win.anchor = () => (this.section?.el?.isConnected ? this.section.el.getBoundingClientRect() : null);
      this.win.body.replaceChildren(this.root);
    }
    this.root.addEventListener('pointerdown', () => this.keep(), true);
    this.t0 = performance.now();
    this.ticker = setInterval(() => { const s = Math.floor((performance.now() - this.t0) / 1000); this.clock.textContent = `T+${two(Math.floor(s / 60))}:${two(s % 60)}`; }, 1000);
  }

  /** Popup mode: a frameless layer holding two free-space columns (left and right of the core). */
  initCards(r) {
    this.slots = { l: el('div', { class: 'db-slot l' }), r: el('div', { class: 'db-slot r' }) };
    this.root = el('div', { class: 'db db-cards rp', dataset: { mode: 'overview' } }, this.slots.l, this.slots.r);
    this.win = new HoloWindow({ id: `report-${this.rid}`, kind: 'debrief', className: 'stage-debrief', title: `DEBRIEF · ${r.title}`, full: false, resizable: false, movable: false,
      persona: this.info.agent || null, item: { type: 'report', id: this.rid, name: r.title, kind: 'debrief' }, onClose: () => this.teardown() });
    this.win.extra = () => ({ report: this.state() });
    this.win.anchor = () => (this.current?.card?.isConnected ? this.current.card.getBoundingClientRect() : null);
    this.win.body.replaceChildren(this.root);
    this.root.addEventListener('pointerdown', () => this.keep(), true);
    this.onResize = () => { clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.placeLink(), 120); };
    window.addEventListener('resize', this.onResize);
  }

  block(id) { return this.report.blocks.find((b) => b.id === id); }
  n(id) { return this.report.blocks.findIndex((b) => b.id === id) + 1; }
  changed() { windows.changed(this.host ? this.host.win : this.win, 'item'); }
  aside(opts) { this.keep(); showAside(this, opts); return opts.pending ? 'waiting for the agent' : 'answer shown'; }
  briefing() { this.keep(); }

  /** Commands run one at a time, in order (the voice cues them; a pile-up cuts instead of animating). */
  queue(fn) {
    this.waiting = (this.waiting || 0) + 1;
    const run = async () => { this.waiting -= 1; this.rush = this.waiting > 0; try { return await fn(); } finally { this.rush = false; } };
    const p = (this.chain || Promise.resolve()).then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  focus(id) { return this.queue(() => this._focus(id)); }
  overview() { return this.queue(() => this._overview()); }
  step(by) { const ids = this.report.blocks.map((b) => b.id); const at = ids.indexOf(this.focusedId); return this.focus(ids[Math.max(0, Math.min(ids.length - 1, at + by))]); }
  flag(id, part) { return this.queue(async () => (await this.inSection(id)).flag(part)); }
  zoom(id, opts) { return this.queue(async () => (await this.inSection(id)).zoom(opts)); }
  diagram(id, opts) { return this.queue(async () => (await this.inSection(id)).diagram(opts)); }
  code(id, opts) { return this.queue(async () => (await this.inSection(id)).openCode(opts)); }
  row(id, i) { return this.queue(async () => (await this.inSection(id)).row(i)); }
  build(id, i) { return this.queue(async () => (await this.inSection(id)).build(i)); }
  media(id, opts) { return this.queue(async () => (await this.inSection(id)).media(opts)); }
  item(id, part, i) { return this.queue(async () => (await this.inSection(id)).item(part, i)); }
  cite(id, sources) { return this.queue(async () => (await this.inSection(id)).cite(sources)); }
  pop() { throw new Error('a debrief stays on the stage; ask for the briefing view instead'); }
  showChanges() { return 'nothing changed'; }

  async inSection(id) {
    if (id && id !== this.focusedId) await this._focus(id);
    if (!this.section) throw new Error('no scene is showing yet');
    return this.section;
  }

  async _focus(id) {
    const b = this.block(id); if (!b) throw new Error(`there is no scene ${id}`);
    if (id === this.focusedId && this.section) return b.heading;
    const seq = ++this.seq;
    const old = this.section; const oldId = this.focusedId;
    this.mode = 'focus'; this.focusedId = id; this.root.dataset.mode = 'focus';
    const section = new Section(this.rid, b, this.n(id), this.report.blocks.length, { terms: this.report.terms, progressive: this.cards });
    section.onChange = () => { if (this.section === section) this.changed(); };
    this.section = section;
    if (this.cards) return this.popCard(b, section, id, seq);
    if (old) await this.tell(old, oldId);       // the scene just told slides up into the stack
    if (seq !== this.seq) { section.destroy(); return b.heading; }
    this.scene.replaceChildren(section.el);
    this.pips.querySelectorAll('i').forEach((pip) => { pip.classList.toggle('on', pip.dataset.id === id); if (this.told.includes(pip.dataset.id)) pip.classList.add('done'); });
    this.setIntel(b);
    this.changed();
    await section.enter({});
    return b.heading;
  }

  // ---- popup cards -----------------------------------------------------------------------------
  compact() { return window.innerWidth < 900; }
  beam(rect, dir) { windows.hooks.core?.beam?.(rect, dir, dir > 0 ? 560 : 420); }

  /** A new card forms beside the core; the one before it becomes a ghost, older ones dissolve. */
  async popCard(b, section, id, seq) {
    if (!this.told.includes(id)) this.told.push(id);
    const prev = this.current;
    this.unlink();
    for (const e of [...this.shown]) if (e !== prev || this.compact()) this.dissolve(e, { beam: false });   // older ghosts and any card of this same scene go
    if (prev && !this.compact()) this.ghost(prev);
    const side = this.compact() ? 'r' : prev ? (prev.side === 'r' ? 'l' : 'r') : 'r';
    const entry = { id, section, side, card: null };
    entry.card = el('div', { class: `db-pop tone-${b.tone || 'normal'}`, dataset: { id, side, mode: section.mode, ref: `scene:${id}` }, onclick: () => { if (this.current !== entry) this.focus(id); } },
      ...['tl', 'tr', 'bl', 'br'].map((c) => el('i', { class: `dp-c ${c}`, 'aria-hidden': 'true' })),
      el('button', { type: 'button', class: 'dp-x', 'aria-label': 'Close', title: 'Close', text: '×', onclick: (e) => { e.stopPropagation(); this.win.close(); } }),
      section.el);
    this.shown.push(entry); this.current = entry;
    this.slots[side].append(entry.card);
    this.changed();
    this.connect(prev, entry);
    const rect = entry.card.getBoundingClientRect(); this.beam({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, 1);
    const dx = side === 'r' ? -56 : 56;
    play(entry.card, [{ opacity: 0, transform: `translateX(${dx}px) scale(.9)` }, { opacity: 1, transform: 'none' }], { duration: 460, delay: 120 });
    this.root.dataset.mode = 'focus';
    if (seq !== this.seq) return b.heading;
    await section.enter({});
    return b.heading;
  }

  /** The card just told: slides outward and fades to a faint ghost (click it to bring it back). */
  ghost(entry) {
    entry.section.data?.revealAll?.();   // a told card is complete (every message, every check)
    entry.card.classList.add('is-ghost');
    const dx = entry.side === 'r' ? 34 : -34;
    play(entry.card, [{ opacity: 1, transform: 'none' }, { opacity: 0.2, transform: `translateX(${dx}px) scale(.94)` }], { duration: 480 });
    if (calm()) { entry.card.style.setProperty('opacity', '.2'); }
  }

  /** Two cards that the agent linked ("this impacts that") are joined by a light line while both are up. */
  connect(a, b) {
    if (!a || !b || this.compact()) return;
    const link = this.block(b.id)?.links?.find((l) => l.to === a.id) || this.block(a.id)?.links?.find((l) => l.to === b.id);
    if (!link) return;
    const line = el('div', { class: 'db-link', 'aria-hidden': 'true' }, el('i', { class: 'dl-line' }), el('i', { class: 'dl-dot' }), link.label ? el('b', { class: 'dl-label', text: link.label }) : null);
    this.root.append(line); this.link = { line, a, b };
    // wait a frame so both cards are laid out, then draw: line grows from the older card to the new one
    requestAnimationFrame(() => { if (this.link?.line !== line) return; this.placeLink(true); });
  }

  placeLink(animate = false) {
    const k = this.link; if (!k || !k.a.card.isConnected || !k.b.card.isConnected) return;
    const ra = k.a.card.getBoundingClientRect(); const rb = k.b.card.getBoundingClientRect();
    const aLeft = ra.left < rb.left;                               // which one is on the left
    const x1 = aLeft ? ra.right : ra.left; const x2 = aLeft ? rb.left : rb.right;
    const y1 = ra.top + 30; const y2 = rb.top + 30;                // anchored at each card's heading: stays put while the card grows
    const len = Math.hypot(x2 - x1, y2 - y1); const ang = Math.atan2(y2 - y1, x2 - x1);
    const { line } = k; line.style.setProperty('--len', `${len}px`);
    line.style.setProperty('transform', `translate(${x1}px, ${y1}px) rotate(${ang}rad)`);
    const draw = line.querySelector('.dl-line'); const dot = line.querySelector('.dl-dot');
    if (animate) {
      play(draw, [{ transform: 'scaleX(0)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 520, delay: 380 });
      play(dot, [{ transform: 'translateX(0)', opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { transform: `translateX(${len}px)`, opacity: 0 }], { duration: 900, delay: 380, easing: 'cubic-bezier(.5,0,.4,1)' });
      play(line.querySelector('.dl-label'), [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 760 });
    }
  }

  unlink() {
    const k = this.link; if (!k) return; this.link = null;
    const gone = () => k.line.remove();
    const a = play(k.line, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 });
    if (a) a.finished.then(gone, gone); else gone();
  }

  /** A card leaves: it melts back toward the core and is removed. */
  dissolve(entry, { beam = true } = {}) {
    if (entry.gone) return; entry.gone = true;
    if (this.link && (this.link.a === entry || this.link.b === entry)) this.unlink();
    this.shown = this.shown.filter((e) => e !== entry); if (this.current === entry) this.current = null;
    const done = () => { entry.section.destroy(); entry.card.remove(); };
    if (beam && entry.card.isConnected) { const r = entry.card.getBoundingClientRect(); this.beam({ x: r.left, y: r.top, w: r.width, h: r.height }, -1); }
    const dx = entry.side === 'r' ? -44 : 44;
    const a = play(entry.card, [{ opacity: entry.card.classList.contains('is-ghost') ? 0.2 : 1, transform: entry.card.classList.contains('is-ghost') ? `translateX(${-dx * 0.77}px) scale(.94)` : 'none' }, { opacity: 0, transform: `translateX(${dx}px) scale(.9)` }], { duration: 340 });
    entry.card.style.setProperty('pointer-events', 'none');
    if (a) a.finished.then(done, done); else done();
  }

  /** Move a told scene into the stack: it shrinks up and to the right, then becomes a card. */
  async tell(section, id) {
    const b = this.block(id);
    if (!this.told.includes(id)) this.told.push(id);
    const card = el('button', { type: 'button', class: `db-card tone-${b.tone || 'normal'}`, title: b.heading, dataset: { id, ref: `scene:${id}` }, onclick: () => this.focus(id) },
      el('b', { text: two(this.n(id)) }), el('span', { text: b.heading }));
    if (!this.rush && !calm()) {
      const from = section.el.getBoundingClientRect(); this.stack.prepend(card); const to = card.getBoundingClientRect();
      const sx = to.width / Math.max(1, from.width); const sy = to.height / Math.max(1, from.height);
      card.style.setProperty('opacity', '0');
      await settle(play(section.el, [{ transform: 'none', opacity: 1 }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`, opacity: 0.15 }], { duration: 480, easing: 'cubic-bezier(.6,0,.3,1)' }));
      card.style.removeProperty('opacity'); play(card, [{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
    } else this.stack.prepend(card);
    for (const extra of [...this.stack.children].slice(STACK_MAX)) extra.remove();
    section.destroy(); section.el.remove();
  }

  setIntel(b) {
    if (this.cards) return;
    const line = b.short || String(b.body || '').split(/(?<=[.!?])\s/)[0] || '';
    this.intel.replaceChildren(el('span', { class: 'db-k', text: `${two(this.n(b.id))} / ${two(this.report.blocks.length)}` }), el('p', { text: line }));
    this.intel.classList.toggle('empty', !line);
    play(this.intel, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 240 });
  }

  async _overview() {
    // a debrief's overview is the last scene staying up with the stack beside it
    this.root.dataset.mode = 'overview'; this.mode = 'overview'; this.changed();
    return 'overview';
  }

  keep() {
    if (!this.lingering) return false;
    this.lingering = false; clearTimeout(this.lingerTimer); this.lingerAnim?.cancel();
    this.root.classList.remove('lingering'); this.changed();
    return true;
  }

  /** After the walk-through: a short countdown, then fold into a chip in the tray. */
  lingerThenClose(seconds = LINGER_S) {
    if (this.closed) return;
    this.lingering = true; this.root.classList.add('lingering'); this.changed();
    if (this.cards) {   // popups: stay a moment, then everything dissolves back into the core (nothing left behind)
      clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(() => { this.lingering = false; this.win.close(); }, Math.min(seconds, 4) * 1000);
      return;
    }
    this.lingerAnim?.cancel();
    this.lingerAnim = this.linger.querySelector('.bar i').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: seconds * 1000, easing: 'linear', fill: 'forwards' });
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => { this.lingering = false; this.root.classList.remove('lingering'); this.win.minimise(); }, seconds * 1000);
  }

  closeAll() { this.win.close(); }

  teardown() {
    this.closed = true; this.seq++; clearTimeout(this.lingerTimer); clearInterval(this.ticker);
    if (this.cards) {
      window.removeEventListener('resize', this.onResize); clearTimeout(this.resizeTimer);
      for (const e of [...this.shown]) this.dissolve(e, { beam: e === this.current });
      this.unlink(); this.section = null; this.onClose?.(); return;
    }
    this.section?.destroy();
    this.onClose?.();
  }

  state() {
    return {
      id: this.rid, title: this.report.title, kind: 'debrief', mode: this.mode, focused: this.focusedId, lingering: !!this.lingering, popped: [],
      told: [...this.told],
      blocks: this.report.blocks.map((b, i) => ({
        id: b.id, n: i + 1, heading: b.heading, type: b.type, tone: b.tone || 'normal',
        messages: (b.messages || []).map((m) => `${m.who}: ${String(m.text).slice(0, 60)}`),
        checks: (b.checks || []).map((c) => `${c.label} ${c.status}`),
        nodes: b.diagram?.svg ? (b.diagram.nodes || []).slice(0, 40).map((nd) => ({ id: nd.id, label: nd.label || nd.id })) : [],
        rows: (b.table?.rows || []).map((r) => r.label),
      })),
      view: this.section ? this.section.viewState() : null,
    };
  }
}
