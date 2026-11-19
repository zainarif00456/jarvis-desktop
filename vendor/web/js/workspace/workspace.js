// The workspace: the room the panels live in, with the core as its brain.
//
// - Docking: while any panel is open the core moves to the top centre (js/workspace/dock.js) and
//   stays linked to every panel by a tendril of light; a pulse runs along one whenever Jarvis acts
//   on that panel (`pulse(id)`, called by js/screen.js).
// - Auto layout: panels arrange themselves (mode `orbit` by default; Jarvis or the owner can pick
//   grid / focus / side_by_side / cascade). A panel moved or resized by hand is PINNED: the others
//   flow around it until it closes or a new arrangement is asked for.
// - Drag: to a screen edge or corner = snap to that half/quarter, to the top = fill the area;
//   dropped onto another panel = the two swap places. A ghost frame shows where it will land.
// - Forming: panels form from the core and fold back into it (js/workspace/forming.js).
// Everything goes through HoloWindow (js/holowin.js) and its change events, so `screen_state`
// keeps reporting exactly what is on screen.

import { windows, isCompact } from '../holowin.js';
import { layoutRects, snapZone, MODES } from './layout.js';
import { coreZone } from './dock.js';
import { createForming } from './forming.js';

const MARGIN = { left: 84, right: 24, top: 64, bottom: 104 };    // rail, top bar, voice dock stay clear
const MODE_KEY = 'jarvis.layout';
const REFLOW_ON = new Set(['open', 'close', 'min', 'restore', 'full']);
const SWAP_SHRINK = 0.25;                                          // drop within the middle half of a panel = swap

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export class Workspace {
  /** core: the stage's core (neural/core.js createOrb host) */
  constructor({ core }) {
    this.core = core;
    this.mode = MODES.includes(store.get(MODE_KEY)) ? store.get(MODE_KEY) : 'orbit';
    this.pins = new Set();
    windows.hooks.workspace = this;   // desktop patch: the pin button (js/cards.js)
    this.ghost = document.createElement('div'); this.ghost.className = 'ws-ghost'; this.ghost.hidden = true;
    this.ghost.setAttribute('aria-hidden', 'true');
    for (const c of ['tl', 'tr', 'bl', 'br']) { const i = document.createElement('i'); i.className = `wg ${c}`; this.ghost.append(i); }
    document.getElementById('hw-layer')?.before(this.ghost);
    windows.hooks.effects = createForming(core);
    windows.hooks.core = core;   // the debrief cards form out of the core and melt back into it
    windows.hooks.drag = { move: (w, x, y) => this.dragMove(w, x, y), end: (w, x, y) => this.dragEnd(w, x, y) };
    windows.onChange((win, what) => this.changed(win, what));
    // the ghost frame belongs to a drag in progress: whatever ends the drag (a missed pointerup when the
    // dragged panel closes or loses the pointer, a lost window focus) must also take the frame away
    const drop = () => { this.ghost.hidden = true; };
    for (const ev of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(ev, drop, true);
    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => this.reflow(), 160); });
  }

  /** The visible, arrangeable panels (not minimised, not full screen, not phone sheets). */
  visible() { return windows.all().filter((w) => !w.minimised && !w.full && w.movable !== false && !w.el.classList.contains('sheet')); }

  /** A debrief being walked through on the stage (it parks the core on the left). */
  debriefing() { return windows.all().some((w) => w.kind === 'debrief' && !w.minimised); }

  area() {
    const vw = window.innerWidth; const vh = window.innerHeight;
    let right = MARGIN.right;
    const instruments = document.getElementById('hud-right');
    if (instruments && !instruments.hidden && vw >= 1280) right = Math.max(right, vw - instruments.getBoundingClientRect().left + 14);
    return { x: MARGIN.left, y: MARGIN.top, w: vw - MARGIN.left - right, h: vh - MARGIN.top - MARGIN.bottom };
  }

  changed(win, what) {
    if (what === 'moved') { this.pins.add(win.id); this.links(); return; }
    if (what === 'close') { this.pins.delete(win.id); this.ghost.hidden = true; }
    if (REFLOW_ON.has(what)) this.reflow({ fresh: what === 'open' ? win : null });
    else if (what === 'geo' || what === 'focus') this.links();
  }

  /** Lay out every unpinned panel for the current mode. A just-opened panel jumps straight to its place. */
  reflow({ fresh = null, order = [], main = null } = {}) {
    const open = this.visible();
    const side = this.debriefing();
    const docked = side || this.visible().length > 0 || windows.all().some((w) => !w.minimised && w.full);
    document.body.dataset.docked = side ? 'side' : docked ? '1' : '';
    this.core.dock?.(side ? 'side' : docked);
    if (isCompact() || !open.length) { this.links(); return; }
    let free = open.filter((w) => !this.pins.has(w.id));
    // keep the order panels were opened in, unless Jarvis gave one
    const rank = (w) => { const i = order.indexOf(w.id); return i < 0 ? 100 + Number(w.openedAt || 0) / 1e13 : i; };
    for (const w of free) if (!w.openedAt) w.openedAt = performance.now();
    free.sort((a, b) => rank(a) - rank(b));
    if (main) { const m = free.find((w) => w.id === main); if (m) free = [m, ...free.filter((w) => w !== m)]; }
    const area = this.area();
    const rects = layoutRects(this.mode, free.length, area, coreZone(window.innerWidth, window.innerHeight));
    free.forEach((w, i) => w.moveTo(rects[i], { persist: false, animate: w !== fresh }));
    this.links();
  }

  /** Jarvis (or the owner) asks for an arrangement: it becomes the mode, hand placements are let go. */
  arrange(mode, { main = null, order = [] } = {}) {
    if (!MODES.includes(mode)) throw new Error(`unknown layout ${mode}; use one of ${MODES.join(', ')}`);
    if (isCompact()) throw new Error('a phone shows one portal at a time');
    // an arrangement includes portals filling the screen: they step back into the layout
    for (const w of windows.all()) if (!w.minimised && w.full) w.exitFull();
    const open = this.visible();
    if (!open.length) throw new Error('nothing is open');
    if (main && !open.some((w) => w.id === main)) throw new Error(`nothing called ${main} is open`);
    this.mode = mode; store.set(MODE_KEY, mode); this.pins.clear();
    this.reflow({ main, order });
    (main ? windows.get(main) : open[0])?.focus();
    return `${open.length} arranged as ${mode}`;
  }

  /** Tell the core where each panel is (its tendrils follow them). */
  links() {
    if (!this.core.setLinks) return;
    const linked = [...this.visible(), ...windows.all().filter((w) => w.kind === 'debrief' && !w.minimised)];
    this.core.setLinks(linked.map((w) => ({ id: w.id, rect: w.anchor?.() || w.geo() })));
  }

  /** Jarvis acted on this panel: a pulse runs out to it from the core. */
  pulse(id) { if (id && windows.get(id)) this.core.pulseLink?.(id); }

  // ---- dragging --------------------------------------------------------------------------------
  target(win, x, y) {
    const zone = snapZone(x, y, this.area());
    if (zone) return { kind: 'snap', rect: zone.rect };
    const over = this.visible().find((w) => {
      if (w === win) return false;
      const g = w.geo(); const ix = g.w * SWAP_SHRINK; const iy = g.h * SWAP_SHRINK;
      return x > g.x + ix && x < g.x + g.w - ix && y > g.y + iy && y < g.y + g.h - iy;
    });
    return over ? { kind: 'swap', other: over, rect: over.geo() } : null;
  }

  dragMove(win, x, y) {
    const t = this.target(win, x, y);
    if (!t) { this.ghost.hidden = true; } else {
      const g = this.ghost; g.hidden = false; g.dataset.kind = t.kind;
      g.style.setProperty('transform', `translate(${t.rect.x}px, ${t.rect.y}px)`);
      g.style.setProperty('width', `${t.rect.w}px`); g.style.setProperty('height', `${t.rect.h}px`);
    }
    this.links();
  }

  dragEnd(win, x, y) {
    this.ghost.hidden = true;
    if (x == null) return false;
    const t = this.target(win, x, y);
    if (!t) return false;
    if (t.kind === 'swap') {
      const mine = win.prevGeo || win.geo();
      t.other.moveTo(mine, { persist: false }); win.moveTo(t.rect, { persist: false });
      this.pins.add(win.id); this.pins.add(t.other.id);
    } else {
      win.moveTo(t.rect, { persist: false }); this.pins.add(win.id);
    }
    this.links();
    return true;
  }
}
