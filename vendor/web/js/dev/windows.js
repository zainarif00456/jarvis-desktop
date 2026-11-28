// Panes in their own OS windows. The server's layout says which panes are `window`; this opens and closes
// the real windows to match (the desktop app's shell via window.jarvisDev, a normal browser via window.open)
// and tells the server when the owner closes one with its own close button, so the pane comes back.
import { TITLE } from './panes.js';

const SIZE = 'popup=yes,width=1100,height=760';
const shell = () => (window.jarvisDev && typeof window.jarvisDev.openWindow === 'function' ? window.jarvisDev : null);

export class PaneWindows {
  /** `act(op, pane)` asks the server for a layout change; `termId()` resolves the terminal's id (or ''). */
  constructor({ act, toast, termId }) {
    this.act = act; this.toast = toast; this.termId = termId;
    this.live = new Set(); this.web = new Map(); this.timer = 0; this.ready = false;
    shell()?.onWindowClosed((pane) => { this.live.delete(pane); this.act('dock', pane); });
    shell()?.windows().then((open) => { for (const p of open) this.live.add(p); this.ready = true; this.sync(this.layout); }, () => { this.ready = true; });
    if (!shell()) this.ready = true;
  }

  /** Whether a pane can have a window here (a phone cannot). */
  static supported() { return !!shell() || !window.matchMedia('(max-width: 760px)').matches; }

  has(pane) { return this.live.has(pane) || (this.web.get(pane) && !this.web.get(pane).closed); }

  /** Open now. A normal browser only allows this inside a click; the desktop app always can. */
  async open(pane) {
    if (this.has(pane)) { this.focus(pane); return true; }
    const term = pane === 'terminal' ? await this.termId() : '';
    if (shell()) {
      try { await shell().openWindow(pane, term ? { term } : {}); this.live.add(pane); return true; } catch { return false; }
    }
    const query = new URLSearchParams({ pane, ...(term ? { term } : {}) });
    const win = window.open(`/dev-window.html?${query}`, `jarvis-dev-${pane}`, SIZE);
    if (!win) return false;
    this.web.set(pane, win);
    this.watch();
    return true;
  }

  focus(pane) { if (shell()) shell().openWindow(pane, {}); else this.web.get(pane)?.focus(); }

  close(pane) {
    if (this.live.delete(pane)) shell().closeWindow(pane);
    const win = this.web.get(pane);
    if (win) { this.web.delete(pane); if (!win.closed) win.close(); }
  }

  /** A normal browser gives no event when its popup closes: look once a second. */
  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [pane, win] of this.web) if (win.closed) { this.web.delete(pane); this.act('dock', pane); }
      if (!this.web.size) { clearInterval(this.timer); this.timer = 0; }
    }, 1000);
  }

  /** Make the real windows match the layout. */
  async sync(layout) {
    this.layout = layout;
    if (!layout || !this.ready) return;
    for (const pane of Object.keys(layout.panes)) {
      const want = layout.panes[pane].state === 'window' && PaneWindows.supported();
      if (want && !this.has(pane) && !this.opening?.has(pane)) {
        (this.opening ||= new Set()).add(pane);
        const ok = await this.open(pane);
        this.opening.delete(pane);
        if (!ok) { this.toast(`${TITLE[pane]} could not open its own window here: it stays in the main window. Use its pop-out button.`); this.act('dock', pane); }
      } else if (!want && this.has(pane)) this.close(pane);
    }
  }
}
