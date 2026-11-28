// Development Mode on screen: an IDE in the Jarvis window, laid out like VS Code or Cursor.
//
//   header: mode, project, minimised panes, View menu            (the title bar of the IDE)
//   side dock (files)  |  centre dock (code, changes, explain)  |  right dock (agents, browser, QA)
//   bottom dock (terminal, actions)                              typed command bar under it
//
// Every pane has minimise / maximise / full screen / pop out / close. Docks resize by dragging the splitters
// (or arrow keys on a focused splitter). The LAYOUT lives on the server (devmode/layout.py) and is
// saved per project: voice, the dev.layout tool, the typed bar and the buttons here all ask the same
// `dev_layout` operations, and this file only draws what comes back, opening real OS windows for panes
// that are "window" (windows.js). Phone: one pane at a time with a strip of tabs.
//
// Loaded on the first dev_* message, so a failure here can never break the normal page.
import { el } from '../util.js';
import { PaneHub, ORDER, TITLE, HOME } from './panes.js';
import { paneControls } from './chrome.js';
import { PaneWindows } from './windows.js';

const DOCKS = ['side', 'center', 'right', 'bottom'];
const DEFAULT_SIZES = { side: 250, right: 0.36, bottom: 230 };
const compact = () => window.matchMedia('(max-width: 760px)').matches;
const typing = (t) => !!t?.closest?.('.xterm');   // keys in a terminal belong to the shell (Ctrl+B is tmux's)

export class DevUI {
  constructor({ send, toast, terminals }) {
    this.send = send; this.toast = toast; this.terminals = terminals;
    this.state = { active: false };
    this.layout = null; this.phoneFront = 'code'; this.focused = 'code'; this.termWait = [];
    this.hub = new PaneHub({ send, front: () => this.focused, shown: (name) => this.onScreen(name) });
    this.nodes = this.hub.nodes;
    window.jarvisDev?.onFullScreen?.((on) => { if (this.layout && on !== !!this.layout.window_full) this.act('window_fullscreen', '', '', on); });   // the owner left (or entered) full screen with the window's own key or menu
    this.windows = new PaneWindows({ act: (op, pane) => this.act(op, pane), toast, termId: () => this.termId() });
    this.build();
  }

  /** Ask for a layout change: the same road as a spoken "minimise the browser". */
  act(op, pane = '', other = '', value = null) { this.send({ type: 'dev_layout', op, pane, other, value }); }

  // ---- building ---------------------------------------------------------------------------------
  build() {
    this.head = el('header', { class: 'dv-head' });
    this.taskbar = el('span', { class: 'dv-taskbar', 'aria-label': 'Minimised panes' });
    this.menu = el('div', { class: 'dv-menu', role: 'menu', hidden: true });
    this.strip = el('nav', { class: 'dv-strip', 'aria-label': 'Panes' });
    this.docks = {};
    for (const name of DOCKS) {
      const tabs = el('nav', { class: 'dv-tabs', 'aria-label': `${name} panes` });
      const body = el('div', { class: 'dv-dbody' });
      const root = el('section', { class: `dv-slot dv-${name}`, dataset: { dock: name }, 'aria-label': `${name} dock` }, tabs, body);
      root.addEventListener('pointerdown', () => { this.focused = this.frontOf(name) || this.focused; }, true);
      root.addEventListener('focusin', () => { this.focused = this.frontOf(name) || this.focused; });
      this.docks[name] = { root, tabs, body };
    }
    for (const pane of ORDER) this.docks[HOME[pane]].body.append(this.hub.nodes[pane]);
    this.gutters = { side: this.gutter('side'), right: this.gutter('right'), bottom: this.gutter('bottom') };
    this.top = el('div', { class: 'dv-top' }, this.docks.center.root, this.gutters.right, this.docks.right.root);
    this.main = el('div', { class: 'dv-main' }, this.top, this.gutters.bottom, this.docks.bottom.root);
    this.work = el('div', { class: 'dv-work' }, this.docks.side.root, this.gutters.side, this.main);
    const input = el('input', { class: 'dv-cmdline', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Type what you would say: open the auth middleware · run the tests · minimise the browser · put the code on the left and the browser on the right', 'aria-label': 'Command' });
    this.cmd = el('form', { class: 'dv-cmd', onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { this.send({ type: 'user_message', text: t }); input.value = ''; } } }, input);
    this.root = el('section', { id: 'dev-ide', class: 'dev', hidden: true, 'aria-label': 'Development Mode' }, this.head, this.strip, this.work, this.cmd);
    document.body.append(this.root);
    window.matchMedia('(max-width: 760px)').addEventListener('change', () => this.render());
    window.addEventListener('keydown', (e) => this.key(e), true);
    document.addEventListener('pointerdown', (e) => { if (!this.menu.hidden && !e.target.closest('.dv-menu, .dv-viewbtn')) this.menu.hidden = true; });
  }

  /** A splitter between two docks: drag it, or focus it and use the arrow keys; double click resets. */
  gutter(which) {
    const g = el('div', { class: `dv-gutter dv-g-${which}`, role: 'separator', tabindex: '0', 'aria-orientation': which === 'bottom' ? 'horizontal' : 'vertical', 'aria-label': `Resize the ${which === 'side' ? 'file tree' : which === 'right' ? 'right' : 'bottom'} panel`, dataset: { g: which } });
    g.addEventListener('pointerdown', (e) => this.drag(e, g, which));
    g.addEventListener('dblclick', () => { this.setSize(which, DEFAULT_SIZES[which]); this.commit(); });
    g.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 20; const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const grows = which === 'side' ? dir : -dir;   // the right and bottom docks grow toward the splitter
      const sizes = this.layout.sizes;
      this.setSize(which, which === 'right' ? sizes.right + (grows * step) / Math.max(400, this.top.clientWidth) : sizes[which] + grows * step);
      this.commit();
    });
    return g;
  }

  drag(e, g, which) {
    if (e.button !== 0) return;
    e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
    this.root.classList.add('dragging');   // iframes and the native browser must not eat the pointer
    this.hub.browser.setVisible(false);
    const move = (ev) => {
      const w = this.work.getBoundingClientRect(); const t = this.top.getBoundingClientRect();
      if (which === 'side') this.setSize('side', ev.clientX - w.left);
      else if (which === 'right') this.setSize('right', (t.right - ev.clientX) / t.width);
      else this.setSize('bottom', w.bottom - ev.clientY);
    };
    const up = () => {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      g.classList.remove('drag'); this.root.classList.remove('dragging');
      this.commit(); this.reveal();
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  }

  setSize(which, value) {
    const limits = { side: [140, Math.max(200, innerWidth * 0.5)], bottom: [80, Math.max(120, innerHeight * 0.7)], right: [0.15, 0.85] }[which];
    const v = Math.max(limits[0], Math.min(limits[1], value));
    this.layout.sizes[which] = v;
    this.paintSizes();
  }

  paintSizes() {
    const s = this.layout.sizes; const set = (k, v) => this.root.style.setProperty(k, v);
    set('--side-w', `${Math.round(s.side)}px`); set('--bottom-h', `${Math.round(s.bottom)}px`); set('--right-f', String(s.right));
  }

  /** Save the sizes (the server keeps them with the project). */
  commit() { clearTimeout(this.sizeTimer); this.sizeTimer = setTimeout(() => this.act('sizes', '', '', { ...this.layout.sizes }), 250); }

  // ---- state ------------------------------------------------------------------------------------
  async apply(dev) {
    const was = this.state.active;
    this.state = dev;
    this.root.hidden = !dev.active;
    document.body.classList.toggle('dev-on', !!dev.active);
    if (!dev.active) {
      this.hub.browser.setVisible(false); this.windows.sync({ panes: {} }); this.setWindowFull(false);
      document.body.classList.remove('dev-full');
      if (was) this.endTerminal();
      return;
    }
    const s = dev.session;
    if (s.layout) this.layout = s.layout;
    this.layout ||= { panes: {}, front: {}, sizes: { ...DEFAULT_SIZES }, side_open: true, max: '', full: '', window_full: false };
    const checkpoints = dev.checkpoints.length;
    this.title = [
      el('span', { class: 'dv-dot', title: 'Development Mode' }), el('b', { class: 'dv-mode', text: 'DEV MODE' }),
      el('span', { class: 'dv-proj', text: s.project }), el('span', { class: 'dv-branch', text: s.branch || '' }),
      el('span', { class: 'dv-chip', text: `${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}`, title: 'Undo points: "undo that"' }),
      s.handed_over ? el('span', { class: 'dv-chip warn', text: 'you are editing' }) : null,
      dev.browser?.native ? el('span', { class: 'dv-chip', text: 'desktop browser' }) : null].filter(Boolean);
    await this.hub.state(dev);
    this.render();
    if (!was) this.phoneFront = s.pane || 'code';
  }

  setLayout(layout, op, pane) {
    this.layout = layout;
    if (op === 'show' && pane) this.phoneFront = pane;
    this.render();
  }

  // ---- drawing the layout -----------------------------------------------------------------------
  /** A pane's state as drawn here: a "window" pane stays in the dock where windows cannot open (a phone). */
  stateOf(pane) {
    const st = this.layout.panes[pane]?.state || 'closed';
    return st === 'window' && !PaneWindows.supported() ? 'docked' : st;
  }

  members(dock) { return ORDER.filter((p) => this.layout.panes[p]?.dock === dock && this.stateOf(p) === 'docked'); }

  frontOf(dock) {
    const here = this.members(dock); const f = this.layout.front[dock];
    return here.includes(f) ? f : here[0] || '';
  }

  /** Is this pane drawn on screen right now (not hidden behind a tab, a maximised pane or a minimise)? */
  onScreen(pane) {
    if (!this.layout || this.root.hidden) return false;
    if (compact()) return pane === this.phoneFront && this.stateOf(pane) !== 'closed';
    if (this.stateOf(pane) !== 'docked') return false;
    const solo = this.layout.full || this.layout.max;
    if (solo && solo !== pane) return false;
    const dock = this.layout.panes[pane].dock;
    return this.frontOf(dock) === pane && !(dock === 'side' && !this.layout.side_open);
  }

  render() {
    const L = this.layout; if (!L || !L.panes.code) return;
    const phone = compact();
    const solo = L.full || L.max;
    this.root.dataset.compact = phone ? '1' : '';
    this.root.classList.toggle('is-full', !!L.full && !phone);
    if (!phone && solo) this.root.dataset.max = solo; else delete this.root.dataset.max;
    document.body.classList.toggle('dev-full', !!L.full && !phone);
    this.paintSizes();
    this.setWindowFull(!!L.window_full);

    for (const pane of ORDER) {   // a pane whose dock changed (put the browser on the left) moves with it
      const body = this.docks[L.panes[pane].dock].body;
      if (this.nodes[pane].parentElement !== body) body.append(this.nodes[pane]);
    }
    for (const name of DOCKS) {
      const dock = this.docks[name]; const members = this.members(name);
      const front = this.visibleFront(name);
      dock.root.hidden = phone ? !front : !members.length || (name === 'side' && !L.side_open) || !!(solo && !members.includes(solo));
      dock.root.classList.toggle('dv-maxed', !phone && !!solo && members.includes(solo));
      for (const pane of ORDER) if (this.nodes[pane].parentElement === dock.body) this.nodes[pane].hidden = pane !== front;
      this.tabs(dock, members, front, phone);
    }
    const shown = (n) => !this.docks[n].root.hidden;
    this.gutters.side.hidden = phone || !!solo || !shown('side') || !(shown('center') || shown('right'));
    this.gutters.right.hidden = phone || !!solo || !(shown('center') && shown('right'));
    this.gutters.bottom.hidden = phone || !!solo || !shown('bottom') || !(shown('center') || shown('right'));

    this.head.replaceChildren(...this.title || [], el('span', { class: 'dv-spacer' }), this.taskbarFor(), this.viewButton(),
      el('button', { type: 'button', class: 'dv-btn', text: 'Leave', onclick: () => this.send({ type: 'user_message', text: 'leave development mode' }) }));
    this.strip.replaceChildren(...ORDER.filter((n) => this.stateOf(n) !== 'closed').map((n) => el('button', { type: 'button', class: `dv-tab${n === this.phoneFront ? ' on' : ''}`, text: TITLE[n], onclick: () => this.pickPhone(n) })));

    this.hub.browser.setVisible(this.onScreen('browser'));
    this.hub.diff.visible = this.onScreen('diff');
    if (this.onScreen('terminal') || (this.stateOf('terminal') === 'window')) this.ensureTerminal();
    this.windows.sync(L);
  }

  /** The pane shown in a dock, honouring a maximised or full-screen pane. */
  visibleFront(name) {
    const solo = this.layout.full || this.layout.max;
    const members = this.members(name);
    if (compact()) return members.includes(this.phoneFront) ? this.phoneFront : '';
    return solo && members.includes(solo) ? solo : this.frontOf(name);
  }

  tabs(dock, members, front, phone) {
    if (phone) { dock.tabs.replaceChildren(); return; }
    const solo = this.layout.full || this.layout.max;
    const buttons = members.map((p) => el('button', { type: 'button', class: `dv-tab${p === front ? ' on' : ''}`, text: TITLE[p], onclick: () => this.act('show', p) }));
    dock.tabs.replaceChildren(...(solo ? buttons.filter((_b, i) => members[i] === front) : buttons), el('span', { class: 'dv-spacer' }),
      front ? paneControls(front, this.layout, (op, pane) => this.control(op, pane), { canPop: PaneWindows.supported() }) : null);
  }

  /** A control button: pop out needs the click itself (a normal browser blocks windows opened later). */
  control(op, pane) {
    if (op === 'popout' && !window.jarvisDev) { this.windows.open(pane).then((ok) => { if (ok) this.act('popout', pane); else this.toast('Your browser blocked the window. Allow pop-ups for Jarvis.'); }); return; }
    this.act(op, pane);
  }

  taskbarFor() {
    const chips = ORDER.filter((p) => ['minimised', 'window'].includes(this.stateOf(p))).map((p) => {
      const win = this.stateOf(p) === 'window';
      return el('button', { type: 'button', class: `dv-minchip${win ? ' win' : ''}`, text: `${TITLE[p]}${win ? ' ↗' : ''}`, title: win ? `${TITLE[p]} is in its own window: click to bring it back` : `Restore ${TITLE[p].toLowerCase()}`, onclick: () => this.act(win ? 'dock' : 'restore', p) });
    });
    return el('span', { class: 'dv-taskbar', 'aria-label': 'Minimised panes' }, ...chips);
  }

  viewButton() {
    const L = this.layout;
    this.menu.replaceChildren(
      ...ORDER.map((p) => {
        const st = this.stateOf(p);
        return el('button', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': st === 'closed' ? 'false' : 'true', class: 'dv-mi', onclick: () => { this.menu.hidden = true; this.act(st === 'closed' ? 'show' : st === 'docked' ? 'close' : 'show', p); } },
          el('i', { text: st === 'closed' ? '' : '✓' }), el('span', { text: TITLE[p] }), el('em', { text: st === 'window' ? 'window' : st === 'minimised' ? 'minimised' : '' }));
      }),
      el('hr'),
      el('button', { type: 'button', class: 'dv-mi', role: 'menuitem', onclick: () => { this.menu.hidden = true; this.act('sidebar'); } }, el('i', { text: L.side_open ? '✓' : '' }), el('span', { text: 'Side panel' }), el('em', { text: 'Ctrl+B' })),
      el('button', { type: 'button', class: 'dv-mi', role: 'menuitem', onclick: () => { this.menu.hidden = true; this.act('window_fullscreen'); } }, el('i', { text: L.window_full ? '✓' : '' }), el('span', { text: 'Full screen window' }), el('em', { text: 'F11' })),
      el('button', { type: 'button', class: 'dv-mi', role: 'menuitem', onclick: () => { this.menu.hidden = true; this.act('reset'); } }, el('i'), el('span', { text: 'Reset layout' }), el('em', { text: 'Ctrl+Alt+0' })));
    const button = el('button', { type: 'button', class: 'dv-btn dv-viewbtn', text: 'View ▾', 'aria-haspopup': 'menu', onclick: () => { this.menu.hidden = !this.menu.hidden; } });
    return el('span', { class: 'dv-viewwrap' }, button, this.menu);
  }

  pickPhone(name) { this.phoneFront = name; this.render(); this.send({ type: 'dev_ui', pane: name }); }

  // ---- keyboard ---------------------------------------------------------------------------------
  key(e) {
    if (this.root.hidden || !this.layout) return;
    if (typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    const pane = this.focused;
    if (e.key === 'Escape' && (this.layout.full || this.layout.max) && !e.target.closest?.('input, textarea, select')) { this.act('unfull'); e.preventDefault(); }
    else if (mod && !e.shiftKey && !e.altKey && k === 'b') { this.act('sidebar'); e.preventDefault(); }
    else if (mod && !e.shiftKey && !e.altKey && k === 'j') { const front = this.frontOf('bottom'); this.act(front ? 'minimise' : 'restore', front || 'terminal'); e.preventDefault(); }
    else if (mod && e.shiftKey && k === 'm') { this.act(this.layout.max === pane ? 'restore' : 'maximise', pane); e.preventDefault(); }
    else if (mod && e.shiftKey && k === 'f') { this.act(this.layout.full === pane ? 'unfull' : 'fullscreen', pane); e.preventDefault(); }
    else if (mod && e.shiftKey && k === 'p') { this.control('popout', pane); e.preventDefault(); }
    else if (mod && e.altKey && k === '0') { this.act('reset'); e.preventDefault(); }
    else if (e.key === 'F11') { this.act('window_fullscreen'); e.preventDefault(); }
  }

  /** The whole Jarvis window full screen: the desktop shell does it for real, a browser asks nicely. */
  setWindowFull(on) {
    if (this.windowFull === on || (this.windowFull === undefined && !on)) { this.windowFull = on; return; }   // never undo a full screen the owner chose before the mode started
    this.windowFull = on;
    if (window.jarvisDev?.setFullScreen) { window.jarvisDev.setFullScreen(on); return; }
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  reveal() { this.render(); }

  // ---- messages ---------------------------------------------------------------------------------
  handle(m) {
    switch (m.type) {
      case 'dev_state': return this.apply(m.dev);
      case 'dev_layout': return this.setLayout(m.layout, m.op, m.pane);
      case 'dev_pane': return undefined;   // older servers: the layout message says it all
      default: return this.hub.handle(m);
    }
  }

  // ---- the terminal -----------------------------------------------------------------------------
  /** The terminal holds a shell in the project folder, started the first time it is needed. */
  ensureTerminal() {
    if (this.termStarted || !this.terminals) return;
    this.termStarted = true;
    this.terminals.dockNext(this.hub.termHost, (view) => { this.termView = view; for (const done of this.termWait.splice(0)) done(view.id); });
    this.terminals.launch(this.state.session?.path || null);
  }

  /** The terminal's id, once it exists (a pop-out window attaches to the same shell). */
  termId() {
    this.ensureTerminal();
    return new Promise((resolve) => { if (this.termView) resolve(this.termView.id); else this.termWait.push(resolve); });
  }

  /** Development Mode ended: its terminal goes with it. */
  endTerminal() {
    this.termView?.close();
    this.termView = null; this.termStarted = false;
    this.hub.termHost.replaceChildren(el('p', { class: 'dv-empty', text: 'Terminal' }));
  }
}
