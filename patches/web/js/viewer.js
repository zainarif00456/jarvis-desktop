// DESKTOP PATCH (patches/): the file viewer as HOLOGRAM CARDS. Replaces the original single "viewer" portal
// (one file at a time, film strip, prev/next swiping). Every picture, video, sound, text and document now opens as its OWN
// floating card (the same portal look as the terminals: corner brackets, glow, header with close / full screen / pin / minimise),
// draggable and resizable. Several cards are open side by side and the workspace arranges them without overlap; closing one
// leaves the others. Pictures are drawn whole (object-fit: contain, never cropped); wheel / pinch / double click zoom and drag pans.
// Same public API as the original (open, list, sync, go, zoomTo, state) so deck.js and screen.js keep working.

import { el, persona, fmtBytes, ago, shareFile, copyText } from './util.js';
import { HoloWindow, windows } from './holowin.js';
import { kindOf } from './holo.js';
import { addPin, fitCard } from './cards.js';

const ZOOM_MAX = 8;
const MEDIA_RAIL = 4;   // "all files" opens this many of the newest pictures / videos
const REGIONS = {
  center: [0.5, 0.5], centre: [0.5, 0.5], middle: [0.5, 0.5], top: [0.5, 0.25], bottom: [0.5, 0.75], left: [0.25, 0.5], right: [0.75, 0.5],
  'top-left': [0.25, 0.25], 'top-right': [0.75, 0.25], 'bottom-left': [0.25, 0.75], 'bottom-right': [0.75, 0.75],
};
const url = (f) => `/api/files/${f.id}/download`;
const ext = (name) => (String(name).includes('.') ? String(name).split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
const cardId = (f) => `file-${f.id}`;

const otherNode = (f, kind) => el('div', { class: 'fv-other' }, el('div', { class: 'glyph big', text: kind === 'pdf' ? 'PDF' : ext(f.name) }), el('a', { class: 'pill', href: url(f), target: '_blank', rel: 'noopener', text: kind === 'pdf' ? 'Open in a new tab' : 'Open' }));

// A PDF as a scrolling column of pages (server-drawn, loaded as they near the view).
function documentNode(f, fallback) {
  const box = el('div', { class: 'fv-doc', tabindex: '0', 'aria-label': `${f.name}: document` }, el('div', { class: 'fv-doc-status', text: 'Reading the document…' }));
  fetch(`/api/files/${f.id}/pages`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(({ pages }) => {
    if (!pages) throw new Error('empty');
    const width = Math.min(1600, Math.round(Math.max(640, window.innerWidth * 0.62) * Math.min(window.devicePixelRatio || 1, 2)));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { const img = e.target; img.src = img.dataset.src; io.unobserve(img); }
    }, { root: box, rootMargin: '900px 0px' });
    const nodes = [];
    for (let i = 1; i <= pages; i++) {
      const img = el('img', { class: 'fv-page', alt: `Page ${i} of ${pages}`, decoding: 'async', draggable: 'false', dataset: { src: `/api/files/${f.id}/pages/${i}?width=${width}` } });
      img.addEventListener('load', () => img.classList.add('in'), { once: true });
      io.observe(img);
      nodes.push(el('figure', { class: 'fv-pg' }, img, el('figcaption', { text: `${i} / ${pages}` })));
    }
    box.replaceChildren(...nodes);
  }).catch(() => box.replaceWith(fallback()));
  return box;
}

class FileCard {
  constructor(viewer, file) {
    this.viewer = viewer; this.file = file; this.zoom = 1; this.pan = { x: 0, y: 0 };
    const kind = this.kind = kindOf(file);
    const win = this.win = new HoloWindow({
      id: cardId(file), kind: 'file', title: file.name, width: kind === 'text' || kind === 'pdf' ? 560 : 520, height: kind === 'text' || kind === 'pdf' ? 520 : 400,
      minW: 300, minH: 220, item: { type: 'file', id: file.id, name: file.name, kind }, onClose: () => { this.teardown(); viewer.cards.delete(file.id); },
    });
    win.extra = () => ({ zoom: Math.round(this.zoom * 100) / 100 });
    win.el.dataset.jdWant = '520,400';
    win.setTags(el('span', { class: 'hw-tag', text: kind.toUpperCase() }));
    this.stage = el('div', { class: 'jc-stage', tabindex: '0' });
    this.zoomHud = el('div', { class: 'jc-zoom', hidden: true });
    this.askRow = el('div', { class: 'jc-ask', hidden: true });
    this.foot = el('div', { class: 'jc-foot' });
    win.body.replaceChildren(el('div', { class: `jc jc-${kind}` }, el('div', { class: 'jc-main' }, this.stage, this.zoomHud), this.askRow, this.foot));
    this.fill(); this.renderFoot(); this.bindStage();
    addPin(win);
  }

  fill() {
    const f = this.file; const kind = this.kind; let node;
    if (kind === 'image') {
      node = el('img', { class: 'jc-img', src: url(f), alt: f.name, draggable: 'false' });
      node.addEventListener('load', () => fitCard(this.win, node.naturalWidth, node.naturalHeight), { once: true });
      node.addEventListener('error', () => node.replaceWith(el('div', { class: 'fv-other' }, el('div', { class: 'glyph big', text: ext(f.name) }), el('p', { text: 'Could not load this image.' }))));
    } else if (kind === 'video') {
      node = el('video', { class: 'jc-video', src: url(f), controls: true, loop: true, playsinline: true, preload: 'auto' });
      node.addEventListener('loadedmetadata', () => fitCard(this.win, node.videoWidth, node.videoHeight), { once: true });
      // every video card plays on its own; sound only for the first one that starts, so several do not talk over each other
      node.muted = [...document.querySelectorAll('.jc-video')].some((v) => v !== node && !v.paused && !v.muted);
      node.play().catch(() => { node.muted = true; node.play().catch(() => {}); });
    } else if (kind === 'audio') node = el('div', { class: 'fv-audio' }, el('div', { class: 'glyph big', text: '♪' }), el('audio', { src: url(f), controls: true, autoplay: true }));
    else if (kind === 'text') { node = el('pre', { class: 'fv-text', text: 'Loading…' }); fetch(`/api/files/${f.id}/preview`).then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => { node.textContent = d.text; }).catch(() => { node.textContent = 'No preview for this file.'; }); }
    else if (kind === 'pdf') node = documentNode(f, () => otherNode(f, kind));
    else node = otherNode(f, kind);
    this.stage.replaceChildren(node);
    this.node = node;
  }

  renderFoot() {
    const f = this.file; const who = persona(f.owner); const kind = this.kind; const v = this.viewer;
    const meta = el('div', { class: 'fv-meta' }, el('b', { text: f.name }), el('span', { text: `${f.description && !['friday', 'edith', 'veronica', 'karen'].includes(f.owner) ? f.description : who.name} · ${fmtBytes(f.size)} · ${ago(f.created_at)}` }));
    const buttons = [
      el('a', { class: 'fv-b', href: url(f), download: f.name }, 'Save'),
      kind === 'text' ? el('button', { type: 'button', class: 'fv-b', text: 'Copy', onclick: async () => { const r = await fetch(`/api/files/${f.id}/preview`); const ok = r.ok && (await copyText((await r.json()).text)); v.actions.toast(ok ? `Copied ${f.name}` : 'Could not copy'); } }) : null,
      navigator.share ? el('button', { type: 'button', class: 'fv-b', text: 'Share', onclick: async () => { if (!(await shareFile(url(f), f.name, f.mime))) v.actions.toast('Sharing is not available here'); } }) : null,
      ['image', 'video', 'audio', 'text', 'pdf'].includes(kind) ? el('button', { type: 'button', class: 'fv-b hot', text: 'Ask…', onclick: () => this.toggleAsk() }) : null,
      el('button', { type: 'button', class: 'fv-b', text: 'Remove', title: 'Hide from the deck (kept on disk)', onclick: () => v.actions.remove(f) }),
    ].filter(Boolean);
    this.foot.replaceChildren(meta, el('div', { class: 'fv-actions' }, ...buttons));
  }

  toggleAsk() {
    if (!this.askRow.hidden) { this.askRow.hidden = true; return; }
    const agent = el('select', { 'aria-label': 'Agent' }, el('option', { value: 'Friday', text: 'Friday' }), el('option', { value: 'Veronica', text: 'Veronica' }), el('option', { value: 'EDITH', text: 'EDITH' }));
    const q = el('input', { type: 'text', maxlength: '300', placeholder: this.kind === 'image' ? 'What is in this picture?' : 'What do you want to know?', 'aria-label': 'Question' });
    const send = () => { this.viewer.actions.ask(this.file, agent.value, q.value.trim() || 'Describe what this is.'); this.askRow.hidden = true; };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    this.askRow.replaceChildren(agent, q, el('button', { type: 'button', class: 'fv-b hot', text: 'Send', onclick: send }));
    this.askRow.hidden = false; q.focus();
  }

  teardown() { this.stage.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load?.(); }); }

  // ---- zoom (pictures)
  get img() { return this.stage.querySelector('.jc-img'); }
  applyZoom() {
    const img = this.img; if (!img) return;
    img.style.setProperty('transform', `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`);
    img.classList.toggle('zoomed', this.zoom > 1);
    this.zoomHud.hidden = this.zoom === 1; this.zoomHud.textContent = `${Math.round(this.zoom * 100)}%`;
    windows.changed(this.win, 'zoom');
  }
  setZoom(z) { this.zoom = Math.max(1, Math.min(ZOOM_MAX, z)); if (this.zoom === 1) this.pan = { x: 0, y: 0 }; this.applyZoom(); }
  zoomTo(level, region) {
    const img = this.img; if (!img) throw new Error('the file on screen is not a picture');
    let z = level === 'in' ? Math.max(this.zoom * 1.6, region ? 2.2 : 1.6) : level === 'out' ? this.zoom / 1.6 : level === 'reset' ? 1 : Number(level);
    if (!Number.isFinite(z)) throw new Error(`cannot zoom to ${level}`);
    z = Math.max(1, Math.min(ZOOM_MAX, z));
    let point = null;
    if (region) {
      point = typeof region === 'string' ? REGIONS[region.toLowerCase().replace(/[\s_]+/g, '-')] : [Number(region.x), Number(region.y)];
      if (!point || !point.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error(`unknown part of the picture: ${JSON.stringify(region)}`);
    }
    if (point && z > 1) { this.pan = { x: -(point[0] - 0.5) * img.offsetWidth * z, y: -(point[1] - 0.5) * img.offsetHeight * z }; }
    else if (z === 1) this.pan = { x: 0, y: 0 };
    else this.pan = { x: this.pan.x * (z / this.zoom), y: this.pan.y * (z / this.zoom) };
    img.classList.add('glide'); clearTimeout(this.glideTimer); this.glideTimer = setTimeout(() => img.classList.remove('glide'), 650);
    this.zoom = z; this.applyZoom();
    return `${Math.round(z * 100)}%`;
  }

  bindStage() {
    const stage = this.stage; let drag = null; const pts = new Map(); let base = 0; let startZoom = 1;
    stage.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, e);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; base = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); startZoom = this.zoom; }
      if (!this.img || this.zoom <= 1 || e.target.closest('a,button,input,video')) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y }; stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e);
      if (pts.size === 2 && base) { const [a, b] = [...pts.values()]; this.setZoom(startZoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / base); return; }
      if (drag && e.pointerId === drag.id) { this.pan = { x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y }; this.applyZoom(); }
    });
    const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) base = 0; if (drag && e.pointerId === drag.id) drag = null; };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => { if (!this.img) return; e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
    stage.addEventListener('dblclick', (e) => { if (e.target.closest('.jc-img')) this.setZoom(this.zoom > 1 ? 1 : 2.5); });
  }
}

export class FileViewer {
  /** `files()` returns the live list (newest first); `actions` = {toast, remove(f), ask(f, agent, q)} */
  constructor({ files, actions }) {
    this.files = files; this.actions = actions; this.cards = new Map();
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get list() { return this.files(); }

  /** Open one file as its own card (or bring its card forward). With no file: the newest pictures / videos, side by side. */
  open(file) {
    if (!file) {
      const list = this.list; if (!list.length) { this.actions.toast('No files yet.'); return null; }
      const media = list.filter((f) => ['image', 'video'].includes(kindOf(f))).slice(0, MEDIA_RAIL);
      const pick = (media.length ? media : list.slice(0, 1)).slice().reverse();
      let last = null; for (const f of pick) last = this.open(f); return last;
    }
    let card = this.cards.get(file.id);
    if (card && !card.win.closed) { card.win.restore(); card.win.focus(); return card.win; }
    card = new FileCard(this, file); this.cards.set(file.id, card);
    return card.win;
  }

  /** The file list changed: cards of files that are gone (removed / hidden) close; the others stay. */
  sync() {
    const ids = new Set(this.list.map((f) => f.id));
    for (const [id, c] of [...this.cards]) if (c.win.closed) this.cards.delete(id); else if (!ids.has(id)) c.win.close();
  }

  top() { const w = windows.top(); return w && w.id.startsWith('file-') ? this.cards.get(w.id.slice(5)) : [...this.cards.values()].pop(); }
  cardOf(winId) { return winId && winId !== 'viewer' ? this.cards.get(String(winId).replace(/^file-/, '')) : this.top(); }

  /** What Jarvis needs to know about the file in front. */
  state() {
    const c = this.top(); const f = c?.file;
    return { item: f ? { type: 'file', id: f.id, name: f.name, kind: kindOf(f) } : null, zoom: c ? Math.round(c.zoom * 100) / 100 : 1, count: this.cards.size };
  }

  /** "next" / "previous": open the neighbouring file as one more card (no gallery to swipe). */
  go(step, winId) {
    const c = this.cardOf(winId); const list = this.list; if (!c || !list.length) return null;
    const at = list.findIndex((f) => f.id === c.file.id);
    const nf = list[Math.max(0, Math.min(list.length - 1, at + step))];
    if (!nf || nf.id === c.file.id) return null;
    this.open(nf); return nf;
  }

  zoomTo(level, region, winId) {
    const c = this.cardOf(winId); if (!c) throw new Error('no picture is open');
    c.win.restore(); c.win.focus();
    return c.zoomTo(level, region);
  }

  onKey(e) {
    const top = windows.top(); if (!top || !top.id.startsWith('file-') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const c = this.cards.get(top.id.slice(5)); if (!c) return;
    if (e.key === '+' || e.key === '=') c.setZoom(c.zoom * 1.3); else if (e.key === '-') c.setZoom(c.zoom / 1.3); else if (e.key === '0') c.setZoom(1);
  }
}
