// DESKTOP PATCH (patches/): shared pieces of the "one hologram card per picture / video / camera" viewer.
//   addPin(win)        a pin button in the card's header; pinned cards stay where the owner put them (workspace pins)
//   fitCard(win, w, h) size a card to a picture's shape (the overlay layout reads data-jd-want)
//   CameraCards        one live card per camera (replaces the single camera wall)
import { el } from './util.js';
import { HoloWindow, windows } from './holowin.js';

const PIN = 'M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v7';
const icon = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); return svg;
};
const ws = () => windows.hooks.workspace;

/** Pin button: pinned = the workspace leaves the card where it is (and the overlay layout does too). */
export function addPin(win) {
  const ctl = win.el.querySelector('.hw-ctl'); if (!ctl) return;
  const b = el('button', { type: 'button', class: 'hb pin', 'aria-label': 'Pin', 'aria-pressed': 'false', title: 'Pin: keep this card where it is' }, icon(PIN));
  const show = () => {
    const on = !!ws()?.pins.has(win.id) || win.el.dataset.jdUser === '1';
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); win.el.classList.toggle('pinned', on);
  };
  b.addEventListener('click', () => {
    const w = ws(); const on = !(w?.pins.has(win.id) || win.el.dataset.jdUser === '1');
    if (on) { w?.pins.add(win.id); win.el.dataset.jdUser = '1'; } else { w?.pins.delete(win.id); delete win.el.dataset.jdUser; w?.reflow(); }
    show();
  });
  ctl.insertBefore(b, ctl.firstChild);
  const off = windows.onChange((x, what) => { if (x === win && (what === 'moved' || what === 'focus')) show(); });
  const prev = win.onClose; win.onClose = () => { off(); prev?.(); };
}

/** Make a card the shape of its picture: fits inside max x max (content area), adds the header and footer. */
export function fitCard(win, cw, ch, { max = [760, 560], chrome = [0, 84], min = [300, 220] } = {}) {
  if (!cw || !ch) return;
  const k = Math.min(1, max[0] / cw, max[1] / ch);
  const w = Math.max(min[0], Math.round(cw * k) + chrome[0]); const h = Math.max(min[1], Math.round(ch * k) + chrome[1]);
  win.el.dataset.jdWant = `${w},${h}`;
  if (win.maximised || win.minimised || win.el.classList.contains('sheet') || windows.hooks.workspace?.pins.has(win.id)) return;
  windows.hooks.workspace?.reflow();
}

export class CameraCards {
  constructor(deck, MainView) { this.deck = deck; this.MainView = MainView; this.cards = new Map(); }
  id(camId) { return `camera-${camId}`; }
  open(camId, focus) {
    const cam = this.deck.byId(camId); if (!cam) return null;
    const existing = this.cards.get(camId);
    if (existing && !existing.win.closed) { existing.win.restore(); if (focus) existing.win.focus(); return existing.win; }
    const win = new HoloWindow({ id: this.id(camId), kind: 'camera', title: cam.name.toUpperCase(), width: 560, height: 400, minW: 320, minH: 240, item: { type: 'camera', id: camId, name: cam.name }, onClose: () => { rec.view.destroy(); this.cards.delete(camId); } });
    win.setTags(el('span', { class: 'hw-tag', text: 'LIVE FEED' }));
    win.el.dataset.jdWant = '560,400';
    const view = new this.MainView(this.deck, cam);
    const rec = { win, view }; this.cards.set(camId, rec);
    win.body.replaceChildren(el('div', { class: 'jc-cam' }, view.root));
    addPin(win); view.start();
    return win;
  }
  /** The camera list changed: drop cards of removed cameras, refresh the rest. */
  sync() {
    for (const [id, rec] of [...this.cards]) {
      if (rec.win.closed) { this.cards.delete(id); continue; }
      const cam = this.deck.byId(id);
      if (!cam) { rec.win.close(); continue; }
      rec.view.refresh(); rec.win.setTitle(cam.name.toUpperCase());
    }
  }
  toggleFull(camId) { const r = this.cards.get(camId); if (r) r.win.toggleFull(); }
  closeAll() { for (const r of [...this.cards.values()]) r.win.close(); }
}
