// Holo-deck: shared files as floating holograms under the orb. Swipe, drag, wheel, arrows or the
// buttons rotate the deck; the front hologram autoplays (video) or previews (image, text); tap it
// to open it big. A newly received file materialises in front with a scan-in animation.

import { el, persona, fmtBytes, ago } from './util.js';
import { windows } from './holowin.js';

const MAX_CARDS = 24;
const GAP = 112;            // px between neighbouring holograms (before perspective)
const VISIBLE = 3;          // holograms shown each side of the front one

export const kindOf = (f) => {
  const m = f.mime || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/') || /json|xml|yaml|toml|javascript|x-sh/.test(m)) return 'text';
  if (m === 'application/pdf') return 'pdf';
  return 'file';
};
const ext = (name) => (String(name).includes('.') ? String(name).split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
const url = (f) => `/api/files/${f.id}/download`;

export class HoloDeck {
  constructor({ root, onToast, onOpen }) {
    this.root = root; this.toast = onToast || (() => {}); this.onOpen = onOpen || (() => {});
    this.files = []; this.cards = new Map(); this.pos = 0; this.target = 0; this.raf = 0;
    this.textCache = new Map();
    this.track = root.querySelector('.holo-track');
    this.label = root.querySelector('.holo-label');
    this.count = root.querySelector('.holo-count');
    root.querySelector('.holo-prev').onclick = () => this.go(-1);
    root.querySelector('.holo-next').onclick = () => this.go(1);
    this.bindGestures();
    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.mode !== 'stage' || this.root.hidden || windows.top()) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'ArrowLeft') this.go(-1); else if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'Enter' && this.files.length) this.onOpen(this.files[this.index()]);
    });
  }

  get size() { return this.files.length; }
  index() { return Math.max(0, Math.min(this.files.length - 1, Math.round(this.target))); }

  /** Replace the whole deck (newest first). */
  set(files) {
    this.files = files.slice(0, MAX_CARDS);
    const keep = new Set(this.files.map((f) => f.id));
    for (const [id, node] of this.cards) if (!keep.has(id)) { node.remove(); this.cards.delete(id); }
    for (const f of this.files) if (!this.cards.has(f.id)) this.cards.set(f.id, this.makeCard(f));
    this.pos = this.target = Math.min(this.target, Math.max(0, this.files.length - 1));
    this.root.hidden = !this.files.length;
    this.layout();
  }

  /** A file just arrived: bring it to the front and materialise it. */
  receive(f) {
    this.files = [f, ...this.files.filter((x) => x.id !== f.id)].slice(0, MAX_CARDS);
    const old = this.cards.get(f.id); if (old) { old.remove(); this.cards.delete(f.id); }
    this.set(this.files);
    this.pos = this.target = 0;
    this.layout();
    const node = this.cards.get(f.id);
    node.classList.add('incoming'); node.addEventListener('animationend', () => node.classList.remove('incoming'), { once: true });
    this.root.classList.add('ping'); setTimeout(() => this.root.classList.remove('ping'), 1600);
  }

  go(step) { this.snapTo(this.index() + step); }
  snapTo(i) {
    if (!this.files.length) return;
    this.target = Math.max(0, Math.min(this.files.length - 1, i));
    if (!this.raf) this.raf = requestAnimationFrame(() => this.animate());
  }
  animate() {
    this.raf = 0;
    this.pos += (this.target - this.pos) * 0.22;
    if (Math.abs(this.target - this.pos) < 0.002) this.pos = this.target; else this.raf = requestAnimationFrame(() => this.animate());
    this.layout();
  }

  bindGestures() {
    let drag = null;
    const stage = this.track;
    stage.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, pos: this.pos, moved: false, id: e.pointerId, card: e.target.closest('.holo-card') };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - drag.y)) { drag.moved = true; stage.setPointerCapture(e.pointerId); }
      if (!drag.moved) return;
      const next = drag.pos - dx / GAP;
      this.pos = this.target = Math.max(-0.3, Math.min(this.files.length - 0.7, next));
      this.layout();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (d.moved) { this.snapTo(Math.round(this.pos)); return; }
      if (e.type === 'pointercancel' || !d.card) return;
      const i = this.files.findIndex((f) => this.cards.get(f.id) === d.card);
      if (i === this.index()) this.onOpen(this.files[i]); else if (i >= 0) this.snapTo(i);
    };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault(); const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) < 4) return; const now = performance.now();
      if (now - (this.lastWheel || 0) < 140) return; this.lastWheel = now; this.go(d > 0 ? 1 : -1);
    }, { passive: false });
  }

  layout() {
    const front = this.index();
    this.files.forEach((f, i) => {
      const node = this.cards.get(f.id); const off = i - this.pos; const a = Math.abs(off);
      if (a > VISIBLE + 0.5) { node.hidden = true; return; }
      node.hidden = false;
      const dir = Math.sign(off);
      node.style.setProperty('transform', `translate(-50%, -50%) translateX(${off * GAP}px) translateZ(${-a * 90}px) rotateY(${-dir * Math.min(a, 1.6) * 38}deg) scale(${1 + Math.max(0, 1 - a) * 0.18})`);
      node.style.setProperty('opacity', String(Math.max(0, 1 - a * 0.26)));
      node.style.setProperty('z-index', String(100 - Math.round(a * 10)));
      node.classList.toggle('front', i === front);
      this.media(node, f, i === front);
    });
    const f = this.files[front];
    if (f) {
      const who = persona(f.owner);
      this.label.replaceChildren(el('b', { text: f.name }), el('span', { text: `${who.name} · ${fmtBytes(f.size)} · ${ago(f.created_at)}` }));
      this.label.style.setProperty('--c', who.color);
      this.count.textContent = `${front + 1} / ${this.files.length}`;
    }
  }

  // Front hologram plays / previews; the others stay still and cheap.
  media(node, f, isFront) {
    const v = node.querySelector('video');
    if (v) { if (isFront) v.play().catch(() => {}); else v.pause(); }
    if (isFront && kindOf(f) === 'text' && !node.dataset.loaded) { node.dataset.loaded = '1'; this.loadText(f, node); }
  }
  async loadText(f, node) {
    let text = this.textCache.get(f.id);
    if (text === undefined) {
      const r = await fetch(`/api/files/${f.id}/preview`).catch(() => null);
      text = r && r.ok ? (await r.json()).text.split('\n').slice(0, 9).map((l) => l.slice(0, 34)).join('\n') : '';
      this.textCache.set(f.id, text);
    }
    const pre = node.querySelector('pre'); if (pre && text) pre.textContent = text;
  }

  makeCard(f) {
    const kind = kindOf(f); const who = persona(f.owner);
    let face;
    if (kind === 'image') face = el('img', { src: url(f), alt: f.name, loading: 'lazy', draggable: 'false' });
    else if (kind === 'video') face = el('video', { src: url(f), muted: true, loop: true, playsinline: true, preload: 'metadata', draggable: 'false' });
    else if (kind === 'text') face = el('pre', { text: f.name });
    else face = el('div', { class: 'glyph', text: kind === 'audio' ? '♪' : ext(f.name) });
    if (kind === 'video') face.muted = true;
    const card = el('div', { class: `holo-card k-${kind}`, style: `--c:${who.color}`, role: 'button', tabindex: '-1', 'aria-label': f.name },
      el('div', { class: 'holo-face' }, face, el('i', { class: 'scan' })));
    this.track.append(card);
    return card;
  }
}
