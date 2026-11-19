// Reports as mission briefings, in hologram portals. An agent's report (report.json, pictures
// re-encoded by the server) opens with a boot sequence (secure link, decrypting the dossier while
// the pictures really load, the title decoding itself, blast doors opening) onto an intel board:
// the sections scattered like evidence on a table, joined by the route the briefing will take.
//
// Opening a section: the camera dives into its tile, the picture slides out of the picture rack
// (every picture of the report, filed section by section) and flies onto the stage, where a HUD
// frames it; the words land in the intel panel (heading decodes, numbers count up, the timeline
// draws itself). A section without a picture opens as a data box that unfolds from a line.
// Zooming into a marked spot sends a targeting reticle that locks on before the camera pushes in.
// Leaving a section collapses it like a switched-off projector. Back to the board = the camera
// pulls out of the tile it was in.
//
// Jarvis drives it through js/screen.js (focus, flag, zoom, pop out, linger, close); every change
// is reported back, so "zoom into that" always means what the owner sees. The voice is the clock
// (server cues fire as each sentence starts playing): every transition is short, and anything
// still running when the next command comes is finished or cut, never queued behind.
//
// Performance (voice must never break up): motion is transform/opacity (Web Animations API),
// pictures are pre-sized WebP decoded before they move, text effects run only a few hundred ms,
// and <html data-fx="lite"> (js/perf.js) or reduced motion turn the cinematics into plain cuts.

import { renderData, hasData } from './blocks/data.js';
import { DebriefView } from './debrief/stage.js';
import { showAside } from './debrief/aside.js';
import { el, persona, ago } from './util.js';
import { HoloWindow, windows, isCompact } from './holowin.js';
import { DiagramView, CodeView, importSvg } from './report-parts.js';

const KEN_BURNS_MS = 16000;
const LINGER_S = 8;
const BOOT_MS = { briefing: 3000, open: 2000 };
const PRELOAD_WAIT_MS = 1500;                     // the boot never waits longer than this for pictures
const SVG = 'http://www.w3.org/2000/svg';
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$<>/\\=+';
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const EASE_IN = 'cubic-bezier(.6,0,.8,.2)';
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let rushing = false;   // commands are piling up (cues faster than the transitions): cut, don't animate
const calm = () => rushing || reduced() || document.documentElement.dataset.fx === 'lite';
const pic = (rid, file, size) => `/api/reports/${rid}/media/${file}.${size}.webp`;
const clip = (rid, file) => `/api/reports/${rid}/media/${file}.mp4`;
const MAX_UPSCALE = 3; // a picture is never shown larger than this many times its real pixels
const ROLE_LABEL = { generated: 'AI-GENERATED', logo: 'LOGO', chart: 'CHART', screenshot: 'SCREENSHOT', diagram: 'DIAGRAM', illustration: 'ILLUSTRATION', video: 'VIDEO', photo: 'ANALYSIS' };
const two = (n) => String(n).padStart(2, '0');
const svgRing = () => { const ns = 'http://www.w3.org/2000/svg'; const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 44 44');
  for (const [cls, extra] of [['track', {}], ['arc', { pathLength: '100', 'stroke-dasharray': '0 100' }], ['ticks', { pathLength: '100' }]]) {
    const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', '22'); c.setAttribute('cy', '22'); c.setAttribute('r', cls === 'ticks' ? '15' : '19'); c.setAttribute('class', cls);
    for (const [k, v] of Object.entries(extra)) c.setAttribute(k, v); s.append(c);
  }
  return s; };
const PARTS = { messages: '[data-part="messages"]', person: '[data-part="person"]', checks: '[data-part="checks"]', terminal: '[data-part="terminal"]', chart: '[data-part="chart"]', change: '[data-part="change"]', draft: '[data-part="draft"]', bullets: 'ul', picture: '.rp-stage', media: '.rp-stage', image: '.rp-stage', video: '.rp-stage', diagram: '.rp-stage', stats: '.rp-stats', numbers: '.rp-stats', timeline: '.rp-events', events: '.rp-events', quote: '.rp-quote', sources: '.rp-src', comparison: '.rp-cols', points: 'ul', text: 'p', summary: 'p', table: '.rp-table', matrix: '.rp-table', steps: '.rp-steps', code: '.rp-chips' };
const PART_LABEL = { messages: 'THE THREAD', person: 'SUBJECT', checks: 'DIAGNOSTICS', terminal: 'CONSOLE', chart: 'THE DATA', change: 'WHAT CHANGED', draft: 'DRAFT', table: 'THE GRID', matrix: 'THE GRID', steps: 'STEP BY STEP', code: 'THE CODE', stats: 'KEY FIGURES', numbers: 'KEY FIGURES', timeline: 'SEQUENCE OF EVENTS', events: 'SEQUENCE OF EVENTS', quote: 'ON THE RECORD', sources: 'SOURCES', comparison: 'SIDE BY SIDE', points: 'KEY POINTS', text: 'SUMMARY', summary: 'SUMMARY' };
const TYPE_LABEL = { hero: 'Introducing', agenda: 'Agenda', problem: 'The problem', solution: 'The solution', feature: 'Feature', demo: 'Demo', market: 'Market', roadmap: 'Roadmap', team: 'Team', ask: 'The ask', concept: 'Concept', steps: 'How it works', analogy: 'Think of it as', example: 'Example', glossary: 'Glossary', faq: 'Questions', architecture: 'Architecture', flow: 'Flow', module: 'Module', code: 'Code', data_model: 'Data model', risk: 'Risk', metrics: 'Metrics', recommendation: 'Recommendation', competitor: 'Competitor', matrix: 'Comparison', positioning: 'Positioning', swot: 'SWOT', pricing: 'Pricing', overview: 'Overview', story: 'Story', finding: 'Finding', profile: 'Profile', gallery: 'Gallery', timeline: 'Timeline', stats: 'Numbers', quote: 'Quote', comparison: 'Comparison', takeaways: 'Takeaways', open_questions: 'Open questions', next_steps: 'Next steps', sources: 'Sources', messages: 'Conversation', person: 'Who', checks: 'Diagnosis', terminal: 'Console', chart: 'Data', document: 'Document', draft: 'Draft', list: 'List', changes: 'What changed' };

// ---- small motion helpers ------------------------------------------------------------------
const play = (node, frames, opts) => (calm() || !node?.animate ? null : node.animate(frames, { fill: 'both', ...opts }));
const settle = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());
const wait = (ms) => new Promise((r) => { setTimeout(r, calm() ? 0 : ms); });

function seeded(text) {
  let h = 2166136261;
  for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Text that decodes itself: random glyphs settling left to right into the real words. */
function decode(node, text, ms = 650) {
  cancelAnimationFrame(node.__decode || 0);
  if (calm() || !text) { node.textContent = text; return Promise.resolve(); }
  const t0 = performance.now(); const s = String(text);
  return new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms); const fixed = Math.floor(p * s.length);
      let out = s.slice(0, fixed);
      for (let i = fixed; i < Math.min(s.length, fixed + 14); i++) out += s[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      node.textContent = out;
      if (p < 1) node.__decode = requestAnimationFrame(tick); else { node.textContent = s; resolve(); }
    };
    node.__decode = requestAnimationFrame(tick);
  });
}

/** A number that counts up to its value, keeping what is around it ("$40m", "1,406", "27.2"). */
function countUp(node, value, ms = 900) {
  const s = String(value); const m = s.match(/^(\D*?)(\d[\d,]*\.?\d*)(.*)$/);
  cancelAnimationFrame(node.__count || 0);
  if (!m || calm()) { node.textContent = s; return; }
  const [, pre, num, post] = m; const target = parseFloat(num.replace(/,/g, ''));
  const decimals = (num.split('.')[1] || '').length; const commas = num.includes(',');
  const fmt = (v) => { const t = v.toFixed(decimals); return commas ? Number(t).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : t; };
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / ms); const e = 1 - (1 - p) ** 3;
    node.textContent = p < 1 ? `${pre}${fmt(target * e)}${post}` : s;
    if (p < 1) node.__count = requestAnimationFrame(tick);
  };
  node.__count = requestAnimationFrame(tick);
}

async function decoded(src) {
  const img = new Image(); img.decoding = 'async'; img.src = src;
  try { await img.decode(); } catch { /* shown anyway; the browser decodes on paint */ }
  return img;
}

/** Scroll only `box` (never its ancestors: scrollIntoView also scrolls overflow-hidden parents,
 *  which shifted the whole report sideways) so `node` sits comfortably inside it. */
function reveal(node, box, axis = 'y') {
  if (!node || !box) return;
  const a = node.getBoundingClientRect(); const b = box.getBoundingClientRect();
  if (axis === 'x') {
    const left = box.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
    return;
  }
  if (a.top >= b.top + 8 && a.bottom <= b.bottom - 8) return;
  const top = box.scrollTop + (a.top - b.top) - Math.max(16, (b.height - a.height) / 3);
  box.scrollTo({ top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' });
}

function within(node, root) {        // a node's box in the coordinates of `root` (transforms included)
  const a = node.getBoundingClientRect(); const b = root.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
}

const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); n.append(...kids); return n; };
const corners = (cls) => ['tl', 'tr', 'bl', 'br'].map((c) => el('i', { class: `${cls} ${c}`, 'aria-hidden': 'true' }));

// ---- the targeting reticle (stage overlay, outside the zoomed picture) ------------------------
class Reticle {
  constructor() {
    this.cs = corners('rc');
    this.cross = el('i', { class: 'rx', 'aria-hidden': 'true' });
    this.tag = el('div', { class: 'rt' }, el('b'), el('span'));
    this.el = el('div', { class: 'rp-reticle', 'aria-hidden': 'true' }, ...this.cs, this.cross, this.tag);
  }

  /** Fly from the middle of the stage to `box` (stage px), lock on, show the label. */
  async lock(stage, box, label, where) {
    if (calm()) return;
    const W = stage.clientWidth; const H = stage.clientHeight;
    const s = Math.min(W, H) * 0.42;
    const from = { x: W / 2 - s / 2, y: H / 2 - s / 2, w: s, h: s };
    const at = (b, c) => ({ tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] }[c]);
    this.el.classList.remove('locked'); this.el.classList.add('on');
    this.tag.firstChild.textContent = ''; this.tag.lastChild.textContent = '';
    const runs = this.cs.map((c, i) => {
      const k = ['tl', 'tr', 'bl', 'br'][i]; const [x0, y0] = at(from, k); const [x1, y1] = at(box, k);
      return play(c, [
        { transform: `translate(${x0}px, ${y0}px) rotate(90deg) scale(1.6)`, opacity: 0 },
        { transform: `translate(${x0}px, ${y0}px) rotate(0deg) scale(1)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${x1}px, ${y1}px) rotate(0deg) scale(1)`, opacity: 1 },
      ], { duration: 720, easing: EASE });
    });
    const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
    play(this.cross, [{ transform: `translate(${W / 2}px, ${H / 2}px) scale(2)`, opacity: 0 }, { transform: `translate(${cx}px, ${cy}px) scale(1)`, opacity: 1 }], { duration: 720, easing: EASE });
    this.tag.style.setProperty('transform', `translate(${Math.min(box.x, W - 220)}px, ${Math.max(0, box.y - 44)}px)`);
    await settle(runs[0]);
    this.el.classList.add('locked');
    decode(this.tag.firstChild, `TARGET LOCKED // ${String(label || 'AREA').toUpperCase()}`, 420);
    this.tag.lastChild.textContent = where;
  }

  release() {
    const a = play(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    settle(a).then(() => { this.el.classList.remove('on', 'locked'); a?.cancel(); });
  }
}

/** One section opened up: picture stage (with HUD) + intel panel, or one data box without a picture. */
// Words from the report's glossary (`terms`) get a pop-over with their meaning where they appear.
function termify(text, terms) {
  if (!terms?.length) return [text];
  const found = terms.filter((t) => t.term && text.toLowerCase().includes(t.term.toLowerCase()));
  if (!found.length) return [text];
  const re = new RegExp(`(${found.map((t) => t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
  return text.split(re).filter((part) => part !== '').map((part) => {
    const t = found.find((x) => x.term.toLowerCase() === part.toLowerCase());
    return t ? el('abbr', { class: 'rp-term', title: t.meaning, dataset: { meaning: t.meaning }, tabindex: '0' }, part) : part;
  });
}

export class Section {
  constructor(rid, block, n, total, { terms = [], progressive = false } = {}) {
    this.terms = terms;
    this.rid = rid; this.block = block; this.n = n; this.total = total; this.mediaIndex = 0; this.anim = null; this.zoomed = null; this.seq = 0;
    this.frame = el('div', { class: 'frame' }); this.box = el('div', { class: 'pbox' });
    this.box.style.setProperty('position', 'absolute');
    this.frame.append(this.box);
    this.reticle = new Reticle();
    this.readout = el('span', { class: 'ro', text: 'X 0.50 · Y 0.50 · 1.00×' });
    this.imgLabel = el('span', { class: 'il' });
    this.hud = el('div', { class: 'rp-shud', 'aria-hidden': 'true' }, ...corners('sc'), el('i', { class: 'xh' }), el('i', { class: 'grid' }),
      el('div', { class: 'lbl tl' }, this.imgLabel), el('div', { class: 'lbl tr' }, el('i', { class: 'rp-dot' }), 'ANALYSIS'), el('div', { class: 'lbl bl' }, this.readout),
      el('i', { class: 'scan' }, el('i')));
    this.roleLabel = el('span', { text: 'ANALYSIS' });
    this.hud.querySelector('.lbl.tr').replaceChildren(el('i', { class: 'rp-dot' }), this.roleLabel);
    const media = block.media?.length > 0;
    const diagram = block.diagram?.svg ? block.diagram : null;
    // data blocks (js/blocks/data.js): the stage itself when nothing else is, else in the text panel
    this.data = hasData(block) ? renderData(block, { progressive, picture: (i) => (block.media?.[i] ? pic(rid, block.media[i].file, 'm') : null) }) : null;
    this.mode = diagram ? 'diagram' : media && !block.person ? 'media' : block.code?.length ? 'code' : this.data ? 'data' : 'box';
    this.view = { code: null, row: null, step: null, playing: false, zoom: null };
    this.onChange = null;
    let content = this.frame;
    if (this.mode === 'diagram') {
      this.dia = new DiagramView(diagram, { onSelect: (node) => this.showNode(node), onChange: () => this.changed() });
      content = this.dia.el;
      this.imgLabel.textContent = `SCHEMATIC · ${String(diagram.type || 'diagram').replace(/-v2$/, '').toUpperCase()} · ${(diagram.nodes || []).length} NODES`;
      this.roleLabel.textContent = 'LIVE';
    } else if (this.mode === 'code') {
      this.codeMain = new CodeView(block.code[0], { big: true });
      content = this.codeMain.el; this.view.code = 0;
      this.imgLabel.textContent = `SOURCE · ${block.code[0].path}`;
      this.roleLabel.textContent = 'VERIFIED CODE';
    } else if (this.mode === 'data') {
      content = el('div', { class: 'rp-dataview' }, this.data.el);
      this.imgLabel.textContent = (PART_LABEL[Object.keys(this.data.parts)[0]] || 'DATA');
      this.roleLabel.textContent = block.tone === 'alert' ? 'ALERT' : block.tone === 'good' ? 'CLEAR' : 'LIVE';
    }
    this.stage = el('div', { class: `rp-stage rp-part mode-${this.mode}` }, content, this.hud, this.reticle.el);
    this.text = el('div', { class: 'rp-text' });
    this.drawer = el('aside', { class: 'rp-drawer', 'aria-live': 'polite' });
    this.el = el('div', { class: `rp-focus${this.mode === 'box' ? ' noimg' : ''} tone-${block.tone || 'normal'}`, dataset: { type: block.type || '', mode: this.mode, section: block.id } }, this.mode !== 'box' ? this.stage : null, this.text, this.drawer);
    this.renderText();
    this.ro = new ResizeObserver(() => this.layout()); this.ro.observe(this.stage);
  }

  changed() { this.onChange?.(); }

  /** What this section is doing now (reported with the screen state). */
  viewState() {
    return { focus: this.dia?.state.focus || [], flow: this.dia?.state.flow || [], code: this.view.code, row: this.view.row,
      step: this.view.step, media: this.mode === 'media' ? this.mediaIndex : null, playing: !!this.view.playing, zoom: this.view.zoom, item: this.view.item || null };
  }

  renderText() {
    const b = this.block; const nodes = [];
    this.kicker = el('div', { class: 'k' }, el('b', { text: two(this.n) }), el('span', { text: ` / ${two(this.total)} · ${b.kicker || TYPE_LABEL[b.type] || b.type}` }));
    this.h2 = el('h2', { text: b.heading });
    nodes.push(this.kicker, this.h2);
    if (b.confidence) nodes.push(el('span', { class: `conf ${b.confidence}`, text: `${b.confidence} confidence` }));
    const terms = this.terms || [];
    for (const para of String(b.body || '').split(/\n{2,}/).map((t) => t.trim()).filter(Boolean)) nodes.push(el('p', { class: 'rp-part' }, ...termify(para, terms)));
    if (b.bullets?.length) nodes.push(el('ul', { class: 'rp-part' }, ...b.bullets.map((t, i) => el('li', { dataset: { ref: `bullets:${i}` } }, ...termify(t, terms)))));
    if (b.stats?.length) nodes.push(el('div', { class: 'rp-stats rp-part' }, ...b.stats.map((s) => el('div', { class: 'rp-stat' }, el('b', { text: s.value, dataset: { v: s.value } }), el('span', { text: s.label }), s.note ? el('small', { text: s.note }) : null))));
    if (b.events?.length) nodes.push(el('div', { class: 'rp-events rp-part' }, el('i', { class: 'line', 'aria-hidden': 'true' }), ...b.events.map((e) => el('div', { class: 'rp-ev' }, el('b', { text: e.when }), el('p', { text: e.text })))));
    if (b.quote) nodes.push(el('blockquote', { class: 'rp-quote rp-part' }, b.quote.text, b.quote.by ? el('cite', { text: `— ${b.quote.by}` }) : null));
    if (b.steps?.length) {
      this.stepEls = b.steps.map((st, i) => el('li', { class: 'rp-step' }, el('b', { text: two(i + 1) }), el('div', {}, el('h4', { text: st.title }), st.text ? el('p', { text: st.text }) : null)));
      nodes.push(el('ol', { class: 'rp-steps rp-part' }, ...this.stepEls));
    }
    if (b.table?.rows?.length) {
      const cols = b.table.columns || [];
      this.rowEls = b.table.rows.map((r) => el('tr', {}, el('th', { scope: 'row', text: r.label }), ...r.cells.map((c) => el('td', { text: c, dataset: { v: c.toLowerCase() } }))));
      nodes.push(el('div', { class: 'rp-table rp-part' }, el('table', {},
        cols.length ? el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { scope: 'col', text: c })))) : null,
        el('tbody', {}, ...this.rowEls))));
    }
    if (b.code?.length && (this.mode !== 'code' || b.code.length > 1)) {
      nodes.push(el('div', { class: 'rp-chips rp-part' }, el('div', { class: 'k', text: 'Code' }), ...b.code.map((c, i) => el('button', { type: 'button', class: 'rp-chip', onclick: () => this.openCode({ index: i }) },
        el('b', { text: '</>' }), el('span', { text: `${c.path}:${c.start}-${c.end}` }), c.title ? el('small', { text: c.title }) : null))));
    }
    if (this.mode === 'diagram' && (b.diagram.nodes || []).some((nd) => nd.note || nd.ref)) {
      nodes.push(el('div', { class: 'rp-legend rp-part' }, el('div', { class: 'k', text: 'Explore: click a part of the diagram' })));
    }
    if (this.data && this.mode !== 'data') nodes.push(this.data.el);
    if (b.columns?.length) nodes.push(el('div', { class: 'rp-cols rp-part' }, ...b.columns.map((c) => el('div', { class: 'rp-col' }, el('h4', { text: c.title }), el('ul', {}, ...c.points.map((p) => el('li', { text: p })))))));
    if (b.sources?.length) {
      nodes.push(el('div', { class: 'rp-src rp-part' }, el('div', { class: 'k', text: 'Sources' }), ...b.sources.map((s) => {
        const safe = /^https?:\/\//i.test(s.url || '') ? s.url : null;
        const label = `${s.outlet ? `${s.outlet}: ` : ''}${s.title}`;
        return el('div', {}, safe ? el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: label }) : el('b', { text: label }), s.published ? el('span', { text: ` · ${s.published}` }) : null);
      })));
    }
    const kids = nodes.map((n, i) => { n.style?.setProperty('--i', String(i)); return n; });
    if (this.mode === 'box') {   // the data box: frame corners, a ghost number, the content
      this.text.classList.add('rp-box');
      this.text.replaceChildren(el('div', { class: 'ghost', 'aria-hidden': 'true', text: two(this.n) }), ...corners('bc'), el('i', { class: 'bscan', 'aria-hidden': 'true' }, el('i')), ...kids);
    } else this.text.replaceChildren(...kids);
    // a data scene with nothing to read beside it: the data takes the whole stage, heading on top
    this.el.classList.toggle('lean', this.mode === 'data' && nodes.length <= 3 && !b.body && !b.bullets?.length);
  }

  /** Show picture i (decoded first), with its highlight brackets and a slow drift to its focus. */
  async showMedia(i = 0, { drift = true } = {}) {
    const media = this.block.media || []; if (!media.length) return;
    this.mediaIndex = Math.max(0, Math.min(media.length - 1, i));
    const m = media[this.mediaIndex];
    this.video?.pause(); this.video = null; this.view.playing = false;
    let shown;
    if (m.role === 'video') {
      shown = await this.loadVideo(m);
    } else {
      shown = await decoded(pic(this.rid, m.file, window.innerWidth > 1500 ? 'l' : 'm'));
      shown.alt = m.alt || m.caption || ''; shown.draggable = false;
    }
    this.box.classList.toggle('rp-logo', m.role === 'logo'); // never bare 'logo': app.css owns it
    this.roleLabel.textContent = ROLE_LABEL[m.role] || 'ANALYSIS';
    this.stage.classList.toggle('generated', m.role === 'generated');
    this.box.replaceChildren(shown, ...this.marks(this.mediaIndex));
    this.stage.querySelector('.rp-cap')?.remove();
    if (m.caption || m.credit) this.stage.append(el('div', { class: 'rp-cap' }, el('b', { text: 'CAPTION' }), m.caption || '', m.credit ? el('small', { text: `SOURCE · ${m.credit}` }) : null));
    this.stage.querySelector('.thumbs')?.remove();
    if (media.length > 1) this.stage.append(el('div', { class: 'thumbs' }, ...media.map((mm, j) => { const t = el('button', { type: 'button', class: j === this.mediaIndex ? 'on' : '', 'aria-label': `Picture ${j + 1}`, onclick: () => this.showMedia(j) }); t.style.setProperty('background-image', `url("${pic(this.rid, mm.file, 't')}")`); return t; })));
    this.imgLabel.textContent = `${m.role === 'video' ? 'CLIP' : 'IMG'} ${two(this.mediaIndex + 1)}/${two(media.length)} · SEC ${two(this.n)}`;
    this.layout(); this.zoomed = null; this.view.zoom = null; this.setReadout(m.focus ? { x: 0.5, y: 0.5 } : null, 1);
    if (m.role === 'video') { if (!reduced()) this.play(); } else if (drift) this.drift(m.focus);
    this.changed();
  }

  /** A clip (silent, looped): ready once its first frame is decoded, or after 2.5 s anyway. */
  loadVideo(m) {
    const v = el('video', { muted: true, playsinline: true, loop: true, preload: 'auto', poster: pic(this.rid, m.file, 'm'), 'aria-label': m.alt || m.caption || 'video' });
    v.muted = true; v.defaultMuted = true; v.disablePictureInPicture = true;
    v.src = clip(this.rid, m.file);
    this.video = v;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(done, 2500);
      v.addEventListener('loadeddata', done, { once: true });
      v.addEventListener('error', done, { once: true });
    });
  }

  play() {
    if (!this.video) throw new Error('there is no video on screen');
    this.video.play().then(() => { this.view.playing = true; this.changed(); }, () => { this.view.playing = false; this.changed(); });
    this.view.playing = true;
    return 'playing';
  }

  pause() { if (this.video) { this.video.pause(); this.view.playing = false; this.changed(); } return 'paused'; }

  /** Switch picture / clip, or play / pause the one shown. */
  async media({ index = null, play = false, pause = false } = {}) {
    if (!this.block.media?.length) throw new Error('this section has no pictures or videos');
    if (this.mode !== 'media') throw new Error('this section shows a diagram or code, not pictures');
    if (index !== null && index !== undefined && index !== this.mediaIndex) await this.showMedia(index);
    if (pause) return this.pause();
    if (play) return this.play();
    return `picture ${this.mediaIndex + 1}`;
  }

  marks(mi) {
    return (this.block.highlights || []).filter((h) => h.media === mi).map((h) => {
      const mark = el('i', { class: 'rp-mark', dataset: { label: (h.label || '').toLowerCase() } }, ...corners('mc'), h.label ? el('span', { text: h.label }) : null);
      for (const [k, v] of [['left', h.box.x], ['top', h.box.y], ['width', h.box.w], ['height', h.box.h]]) mark.style.setProperty(k, `${v * 100}%`);
      return mark;
    });
  }

  // the picture box = where object-fit: contain puts the picture (brackets are % of this box)
  layout() {
    if (this.mode !== 'media') return;
    const m = this.block.media?.[this.mediaIndex]; if (!m) return;
    const logo = m.role === 'logo';
    const W = this.stage.clientWidth * (logo ? 0.5 : 1); const H = this.stage.clientHeight * (logo ? 0.5 : 1); if (!W || !H) return;
    const offX = logo ? this.stage.clientWidth * 0.25 : 0; const offY = logo ? this.stage.clientHeight * 0.25 : 0;
    const ar = m.width && m.height ? m.width / m.height : 16 / 9;
    let w = W; let h = W / ar; if (h > H) { h = H; w = H * ar; }
    // never stretch a small picture into a blur (2026-11-02: 48 px site icons filled half the
    // stage): at most MAX_UPSCALE x its real size; a logo's plate also holds a 10% margin
    const most = m.width ? (m.width * MAX_UPSCALE) / (logo ? 0.8 : 1) : Infinity;
    if (w > most) { h *= most / w; w = most; }
    for (const [k, v] of [['left', offX + (W - w) / 2], ['top', offY + (H - h) / 2], ['width', w], ['height', h]]) this.box.style.setProperty(k, `${v}px`);
    if (this.zoomed) this.applyZoom(this.zoomed, false);
  }

  /** Where the picture sits right now, in the section's coordinates (for the flight in). */
  pictureRect(root) { return within(this.box, root); }

  // ---- entering and leaving ---------------------------------------------------------------
  /** Open up: the picture flies in from `from` (a rect in `root` px: rack slot or board tile). */
  async enter({ from = null, root = null } = {}) {
    const seq = ++this.seq;
    this.el.classList.add('in');
    if (this.mode === 'diagram' || this.mode === 'code' || this.mode === 'data') {
      play(this.stage, [{ transform: 'scale(1, .004)', opacity: 0.2 }, { transform: 'scale(1, .004)', opacity: 1, offset: 0.25 }, { transform: 'none', opacity: 1 }], { duration: 560, easing: EASE });
      this.stage.classList.add('live');
      if (this.dia) setTimeout(() => { if (seq === this.seq) this.dia.drawIn(); }, calm() ? 0 : 260);
      if (this.codeMain && this.block.code[0].marks?.length) setTimeout(() => this.codeMain.mark(this.block.code[0].marks), calm() ? 0 : 700);
    } else if (this.mode === 'media') {
      await this.showMedia(0, { drift: false });
      if (seq !== this.seq) return;
      const flight = from && root && !calm() ? this.fly(from, root) : null;
      play(this.stage, [{ transform: 'scale(1, .004)', opacity: 0.2 }, { transform: 'scale(1, .004)', opacity: 1, offset: 0.25 }, { transform: 'none', opacity: 1 }], { duration: flight ? 380 : 520, delay: flight ? 300 : 0, easing: EASE });
      this.stage.classList.add('live');
      await flight;
      if (this.block.media[this.mediaIndex]?.role !== 'video') this.drift(this.block.media[this.mediaIndex].focus);
    } else {
      play(this.text, [{ transform: 'scale(.02, .006)', opacity: 0 }, { transform: 'scale(1, .006)', opacity: 1, offset: 0.45 }, { transform: 'none', opacity: 1 }], { duration: 620, easing: EASE });
    }
    decode(this.h2, this.block.heading, 600);
    for (const b of this.text.querySelectorAll('.rp-stat b')) countUp(b, b.dataset.v, 1000);
  }

  /** The picture as a separate image flying from the rack/tile to its place on the stage. */
  async fly(from, root) {
    const img = this.box.querySelector('img'); if (!img) return;
    const to = this.pictureRect(root); if (!to.w || !to.h) return;
    const ghost = el('img', { class: 'rp-flight', src: img.currentSrc || img.src, alt: '' });
    for (const [k, v] of [['left', `${to.x}px`], ['top', `${to.y}px`], ['width', `${to.w}px`], ['height', `${to.h}px`]]) ghost.style.setProperty(k, v);
    root.append(ghost);
    const sx = from.w / to.w; const sy = from.h / to.h;
    const a = play(ghost, [
      { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${sx}, ${sy})`, opacity: 0.9 },
      { transform: `translate(${(from.x - to.x) * 0.35}px, ${(from.y - to.y) * 0.35 - 20}px) scale(${(sx + 1) / 2 * 1.04}, ${(sy + 1) / 2 * 1.04})`, opacity: 1, offset: 0.55 },
      { transform: 'none', opacity: 1 },
    ], { duration: 640, easing: EASE });
    this.frame.style.setProperty('opacity', '0');
    await settle(a);
    this.frame.style.removeProperty('opacity');
    settle(play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })).then(() => ghost.remove());
  }

  /** Switch off like a projector: the content goes, the picture collapses to a line, then a dot. */
  async leave() {
    this.seq++; this.el.classList.add('leaving'); this.reticle.el.classList.remove('on');
    this.video?.pause(); this.dia?.destroy();
    const runs = [];
    if (this.mode !== 'box') {
      runs.push(play(this.stage, [{ transform: 'none', opacity: 1 }, { transform: 'scale(1, .004)', opacity: 1, offset: 0.6 }, { transform: 'scale(0, .004)', opacity: 0 }], { duration: 340, easing: EASE_IN }));
      runs.push(play(this.text, [{ transform: 'none', opacity: 1 }, { transform: 'translateX(40px)', opacity: 0 }], { duration: 240, easing: EASE_IN }));
    } else {
      runs.push(play(this.text, [{ transform: 'none', opacity: 1 }, { transform: 'scale(1, .006)', opacity: 1, offset: 0.55 }, { transform: 'scale(0, .006)', opacity: 0 }], { duration: 340, easing: EASE_IN }));
    }
    await Promise.all(runs.map(settle));
  }

  // ---- the camera on the picture ----------------------------------------------------------
  drift(focus) {
    this.anim?.cancel(); if (calm()) return;
    const t = this.transformFor(focus || { x: 0.35, y: 0.3, w: 0.3, h: 0.4 }, 1.12);
    this.anim = this.frame.animate([{ transform: 'none' }, { transform: t }], { duration: KEN_BURNS_MS, easing: 'ease-in-out', fill: 'forwards' });
  }

  // a transform that brings the centre of `box` (fractions of the picture) to the centre, at zoom z
  transformFor(box, z) {
    const W = this.stage.clientWidth; const H = this.stage.clientHeight;
    const bl = parseFloat(this.box.style.left) || 0; const bt = parseFloat(this.box.style.top) || 0;
    const bw = parseFloat(this.box.style.width) || W; const bh = parseFloat(this.box.style.height) || H;
    const cx = bl + (box.x + box.w / 2) * bw; const cy = bt + (box.y + box.h / 2) * bh;
    return `translate(${(W / 2 - cx) * z}px, ${(H / 2 - cy) * z}px) scale(${z})`;
  }

  setReadout(c, z) {
    const p = c || { x: 0.5, y: 0.5 };
    this.readout.textContent = `X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} · ${z.toFixed(2)}×`;
  }

  /** Zoom into a highlight (by label), a region name, or reset. Returns what it did. */
  zoom({ label, region, level } = {}) {
    if (this.mode === 'diagram') {   // a diagram: "zoom into X" = focus that node, reset = whole diagram
      if (level === 'reset' || level === 1 || !label) { this.dia.overview(); return 'whole diagram'; }
      const hit = [...this.dia.nodeEls.keys()].find((id) => id.toLowerCase() === String(label).toLowerCase() || (this.dia.info.get(id)?.label || '').toLowerCase().includes(String(label).toLowerCase()));
      if (!hit) throw new Error(`the diagram has nothing called ${label}`);
      this.diagram({ focus: [hit] }); return hit;
    }
    if (this.mode !== 'media') { if (level === 'reset') return 'no picture'; throw new Error('this section has no picture'); }
    const m = this.block.media[this.mediaIndex];
    let box = null; let mark = null;
    if (label) {
      const h = (this.block.highlights || []).find((x) => x.media === this.mediaIndex && x.label.toLowerCase().includes(String(label).toLowerCase()));
      if (!h) throw new Error(`no highlight called ${label} on this picture`);
      box = h.box; mark = h.label;
    } else if (region) {
      const R = { center: [0.25, 0.25], top: [0.25, 0], bottom: [0.25, 0.5], left: [0, 0.25], right: [0.5, 0.25], 'top-left': [0, 0], 'top-right': [0.5, 0], 'bottom-left': [0, 0.5], 'bottom-right': [0.5, 0.5] }[String(region).toLowerCase().replace(/[\s_]+/g, '-')];
      if (!R) throw new Error(`unknown part of the picture: ${region}`);
      box = { x: R[0], y: R[1], w: 0.5, h: 0.5 };
    } else if (level === 'reset' || level === 1) {
      this.seq++; this.zoomed = null; this.anim?.cancel(); this.reticle.release(); this.frame.style.removeProperty('--z');
      for (const mk of this.box.querySelectorAll('.rp-mark')) mk.classList.remove('on');
      this.anim = this.frame.animate([{ transform: getComputedStyle(this.frame).transform }, { transform: 'none' }], { duration: calm() ? 0 : 650, easing: EASE, fill: 'forwards' });
      this.setReadout(null, 1); this.view.zoom = null; this.changed();
      return 'reset';
    } else box = m.focus || { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    // the spot fills about 70% of the stage (portrait pictures in a wide stage zoom in properly)
    const bw = parseFloat(this.box.style.width) || this.stage.clientWidth; const bh = parseFloat(this.box.style.height) || this.stage.clientHeight;
    const fit = Math.min((this.stage.clientWidth * 0.7) / (box.w * bw), (this.stage.clientHeight * 0.7) / (box.h * bh));
    const z = Math.max(1.3, Math.min(4, Number(level) > 1 ? Number(level) : fit));
    for (const mk of this.box.querySelectorAll('.rp-mark')) mk.classList.toggle('on', !!label && mk.dataset.label.includes(String(label).toLowerCase()));
    this.view.zoom = mark || region || 'focus'; this.changed();
    this.lockAndZoom(box, z, mark);
    return `${Math.round(z * 100)}%`;
  }

  /** The reticle flies to the spot and locks, then the camera pushes in. */
  async lockAndZoom(box, z, label) {
    const seq = ++this.seq;
    const frozen = getComputedStyle(this.frame).transform;    // stop the drift where it is
    this.anim?.cancel(); this.frame.style.setProperty('transform', frozen);
    const spot = el('i', { class: 'rp-spot' });                // where the spot is on screen right now
    for (const [k, v] of [['left', box.x], ['top', box.y], ['width', box.w], ['height', box.h]]) spot.style.setProperty(k, `${v * 100}%`);
    this.box.append(spot); const at = within(spot, this.stage); spot.remove();
    const where = `X ${(box.x + box.w / 2).toFixed(2)} · Y ${(box.y + box.h / 2).toFixed(2)} · ${z.toFixed(2)}×`;
    await this.reticle.lock(this.stage, at, label || 'AREA', where);
    if (seq !== this.seq) return;
    this.reticle.release();   // the brackets on the picture take over as the camera pushes in
    this.frame.style.removeProperty('transform');
    this.zoomed = { box, z }; this.applyZoom(this.zoomed, true, frozen);
    this.setReadout({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, z);
  }

  applyZoom({ box, z }, animate, from = null) {
    this.anim?.cancel();
    this.frame.style.setProperty('--z', String(z));   // labels on the picture keep their size
    const to = this.transformFor(box, z);
    if (!animate || calm()) { this.frame.style.setProperty('transform', to); return; }
    this.frame.style.removeProperty('transform');
    this.anim = this.frame.animate([{ transform: from || getComputedStyle(this.frame).transform }, { transform: to }], { duration: 900, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' });
  }

  /** Point at a part of the section: picture, stats, timeline, quote, sources, points, text. */
  /** Light one item of a part (a message, a check, a log line, a bar, a bullet...): voice-clocked. */
  item(part, i) {
    let node = this.data?.item(part, i) || null;
    if (!node) {
      const sel = { bullets: 'ul > li', stats: '.rp-stat', timeline: '.rp-ev', sources: '.rp-src > div:not(.k)' }[part];
      const list = sel ? [...this.text.querySelectorAll(sel)] : [];
      node = list[i] || null;
      if (!node) throw new Error(`this section has no item ${i + 1} in ${part}`);
      for (const n of list) n.classList.remove('hot');
      node.classList.add('hot');
      if (part === 'stats') { const b = node.querySelector('b'); if (b) countUp(b, b.dataset.v, 700); }
    }
    reveal(node, node.closest('.rp-text, .rp-dataview') || this.text);
    this.view.item = { part, i }; this.changed();
    return part;
  }

  /** The sources behind the sentence being said light up. */
  cite(indices = []) {
    const rows = [...this.text.querySelectorAll('.rp-src > div:not(.k)')];
    rows.forEach((r, i) => r.classList.toggle('cited', indices.includes(i)));
    const box = this.text.querySelector('.rp-src');
    if (box && indices.length) { box.classList.add('citing'); reveal(rows[indices[0]] || box, this.text); }
    return `${indices.length} source(s)`;
  }

  flag(part) {
    this.data?.revealAll?.();   // pointing at a part shows all of it
    if (!part) { this.el.classList.remove('in'); void this.el.offsetWidth; this.el.classList.add('in'); return 'section'; }
    if (['picture', 'media', 'image'].includes(part)) for (const mark of this.box.querySelectorAll('.rp-mark')) mark.classList.add('on');
    const target = PARTS[part] ? this.el.querySelector(PARTS[part]) : null;
    if (!target) throw new Error(`this section has no ${part}`);
    target.classList.remove('flag'); void target.offsetWidth; target.classList.add('flag');
    reveal(target, this.text);
    if (target !== this.stage) this.lockOn(target, PART_LABEL[part] || String(part).toUpperCase());
    if (target.matches('.rp-stats')) for (const b of target.querySelectorAll('.rp-stat b')) countUp(b, b.dataset.v, 900);
    if (target.matches('.rp-events')) target.querySelectorAll('.rp-ev').forEach((ev, i) => { ev.classList.remove('hot'); setTimeout(() => ev.classList.add('hot'), calm() ? 0 : 160 + i * 220); });
    return part;
  }

  // ---- diagrams, code, tables, steps -----------------------------------------------------------
  /** Zoom onto nodes (the reticle locks on first), trace a path, or show the whole diagram. */
  async diagram({ focus = [], flow = [], overview = false } = {}) {
    if (!this.dia?.ok) throw new Error('this section has no diagram on screen');
    this.drawer.classList.remove('open');
    if (flow?.length) {   // the hops keep running after the answer: the next command interrupts them
      this.dia.trace(flow).catch(() => {});
      this.changed();
      return `tracing ${flow.join(' > ')}`;
    }
    if (overview || !focus?.length) { await this.dia.overview(); return 'whole diagram'; }
    if (focus.length === 1 && !calm()) {
      const at = this.dia.stageRect(focus[0]);
      if (at && at.w > 0) {
        const info = this.dia.info.get(focus[0]);
        await this.reticle.lock(this.stage, at, info?.label || focus[0], `NODE ${focus[0].toUpperCase()}`);
        this.reticle.release();
      }
    }
    const said = await this.dia.focus(focus);
    if (focus.length === 1) { const node = this.dia.info.get(focus[0]); if (node?.note || node?.ref) this.showNode(node, { quiet: true }); }
    return said;
  }

  /** A node picked (by a click, or Jarvis): its note and the code behind it, in the drawer. */
  showNode(node, { quiet = false } = {}) {
    if (!node) { this.drawer.classList.remove('open'); return; }
    const kids = [el('div', { class: 'dh' }, el('b', { text: node.label || node.id }), el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×', onclick: () => this.drawer.classList.remove('open') })),
      el('div', { class: 'k', text: `NODE · ${node.id}` })];
    if (node.note) kids.push(el('p', { text: node.note }));
    if (node.ref) kids.push(new CodeView(node.ref).el);
    else if (!quiet) kids.push(el('p', { class: 'mute', text: 'No code was linked to this part.' }));
    this.drawer.replaceChildren(...kids);
    this.drawer.classList.add('open');
    if (!quiet) this.changed();
  }

  /** Open a code excerpt (by index, or the code behind a node) and point at lines. */
  openCode({ index = null, node = null, lines = [] } = {}) {
    let excerpt = null;
    if (node) {
      const info = this.dia?.info.get(node);
      if (!info?.ref) throw new Error(`no code was linked to ${node}`);
      excerpt = { ...info.ref, title: info.label };
      this.dia.focus([node]);
    } else {
      excerpt = this.block.code?.[index ?? 0];
      if (!excerpt) throw new Error('this section has no such code excerpt');
    }
    const ranges = lines?.length ? [[lines[0], lines[1] ?? lines[0]]] : (excerpt.marks || []);
    if (this.mode === 'code' && !node) {   // the code is the stage: swap the excerpt in place
      if (this.view.code !== index) {
        this.codeMain = new CodeView(excerpt, { big: true });
        this.stage.firstChild.replaceWith(this.codeMain.el);
        this.imgLabel.textContent = `SOURCE · ${excerpt.path}`;
      }
      this.view.code = index ?? 0; this.changed();
      return this.codeMain.mark(ranges);
    }
    const view = new CodeView(excerpt);
    this.drawer.replaceChildren(el('div', { class: 'dh' }, el('b', { text: excerpt.title || excerpt.path }), el('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×', onclick: () => { this.drawer.classList.remove('open'); this.view.code = null; this.changed(); } })), view.el);
    this.drawer.classList.add('open');
    this.view.code = node ? null : (index ?? 0); this.changed();
    return ranges.length ? view.mark(ranges) : `${excerpt.path}:${excerpt.start}-${excerpt.end}`;
  }

  /** Light one row of the table (the others dim), brackets around it. */
  row(i) {
    const row = this.rowEls?.[i]; if (!row) throw new Error('this section has no such table row');
    this.rowEls.forEach((r) => r.classList.toggle('hot', r === row));
    this.rowEls[0].closest('.rp-table').classList.add('focus');
    reveal(row, this.text);
    this.lockOn(row.closest('.rp-table'), row.firstChild.textContent.toUpperCase());
    this.view.row = i; this.changed();
    return row.firstChild.textContent;
  }

  /** Reveal the steps up to i (the current one lit, the next ones still to come). */
  build(i) {
    if (!this.stepEls?.[i]) throw new Error('this section has no such step');
    this.stepEls.forEach((st, j) => { st.classList.toggle('done', j < i); st.classList.toggle('now', j === i); st.classList.toggle('later', j > i); });
    this.stepEls[0].parentNode.classList.add('building');
    reveal(this.stepEls[i], this.text);
    this.view.step = i; this.changed();
    return this.block.steps[i].title;
  }

  /** Brackets that snap around a part of the intel panel, with what it is. */
  lockOn(target, label) {
    this.text.querySelector('.rp-lock')?.remove();
    const lock = el('div', { class: 'rp-lock', 'aria-hidden': 'true' }, ...corners('lc'), el('span', { text: `◆ ${label}` }));
    for (const [k, v] of [['left', target.offsetLeft - 8], ['top', target.offsetTop - 8], ['width', target.offsetWidth + 16], ['height', target.offsetHeight + 16]]) lock.style.setProperty(k, `${v}px`);
    this.text.append(lock);
    setTimeout(() => lock.remove(), 3200);
  }

  destroy() { this.seq++; this.ro.disconnect(); this.anim?.cancel(); this.video?.pause(); this.dia?.destroy(); }
}

// ---- the boot sequence: the dossier loading like a mission ---------------------------------------
class Boot {
  constructor(view, { briefing }) {
    const r = view.report; const who = persona(view.info.agent || 'friday');
    this.view = view; this.fast = false; this.briefing = briefing;
    this.skipped = new Promise((r) => { this.onSkip = r; });
    this.lines = el('div', { class: 'term' });
    this.bar = el('i'); this.pct = el('span', { class: 'pct', text: '00%' });
    this.title = el('h1', { class: 'bt' }); this.sub = el('div', { class: 'bs', text: r.subtitle || '' });
    this.card = el('div', { class: 'bcard' }, el('div', { class: 'cls', text: r.tag || `${r.kind} report` }), el('div', { class: 'bop', text: briefing ? 'MISSION BRIEFING' : 'INTEL DOSSIER' }), this.title, this.sub,
      el('div', { class: 'by' }, 'BRIEFING OFFICER ', el('b', { text: who.name.toUpperCase() })));
    const ring = svg('svg', { viewBox: '0 0 200 200', class: 'ring' },
      svg('circle', { cx: 100, cy: 100, r: 92, class: 'r1' }), svg('circle', { cx: 100, cy: 100, r: 78, class: 'r2' }), svg('circle', { cx: 100, cy: 100, r: 64, class: 'r3' }),
      svg('path', { d: 'M100 2v18M100 180v18M2 100h18M180 100h18', class: 'ticks' }));
    this.emblem = el('div', { class: 'emblem' }, ring, el('b', { text: who.initial || who.name[0] }));
    this.emblem.style.setProperty('--who', who.color || 'var(--hud)');
    this.doors = [el('i', { class: 'door t' }), el('i', { class: 'door b' })];
    this.el = el('div', { class: 'rp-boot', role: 'status', 'aria-label': 'Loading the report', onclick: () => this.skip() },
      el('i', { class: 'grid', 'aria-hidden': 'true' }), ...this.doors,
      el('div', { class: 'mid' }, this.emblem, el('div', { class: 'col' }, this.lines, el('div', { class: 'prog' }, el('div', { class: 'bar' }, this.bar), this.pct))),
      this.card);
  }

  skip() { this.fast = true; this.onSkip(); }
  /** Anything the boot waits for ends the moment it is skipped. */
  hold(p) { return this.fast ? Promise.resolve() : Promise.race([p, this.skipped]); }
  wait(ms) { return this.hold(wait(ms)); }

  async line(text, ok = 'OK') {
    const row = el('div', { class: 'ln' }, el('span', { class: 'p', text: '›' }), el('span', { class: 't' }), el('span', { class: 'ok' }));
    this.lines.append(row);
    while (this.lines.children.length > 5) this.lines.firstChild.remove();
    if (this.fast) { row.children[1].textContent = text; row.children[2].textContent = ok; return; }
    await this.hold(decode(row.children[1], text, 260));
    await this.wait(90); row.children[1].textContent = text; row.children[2].textContent = ok;
  }

  progress(p) {
    this.bar.style.setProperty('transform', `scaleX(${Math.max(0.02, Math.min(1, p))})`);
    this.pct.textContent = `${two(Math.round(Math.min(1, p) * 99))}%`;
  }

  /** The whole sequence; resolves when the doors are open. Fast-forwards on `skip()`. */
  async run(preload) {
    const v = this.view; const r = v.report; const t0 = performance.now();
    const budget = this.briefing ? BOOT_MS.briefing : BOOT_MS.open;
    if (calm()) this.fast = true;
    this.view.root.classList.add('booting');
    play(this.emblem, [{ transform: 'scale(.6) rotate(-40deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 520, easing: EASE });
    await this.line('ESTABLISHING SECURE LINK');
    await this.line(`DOSSIER ${v.rid.slice(0, 8).toUpperCase()} · DECRYPTING`, '…');
    let loaded = 0; const total = Math.max(1, preload.length);
    this.progress(0.05);
    const all = Promise.all(preload.map((p) => p.then(() => { loaded += 1; this.progress(0.1 + 0.85 * (loaded / total)); })));
    await this.hold(Promise.race([all, wait(PRELOAD_WAIT_MS)]));
    this.lines.lastChild.lastChild.textContent = 'OK';
    this.progress(1);
    await this.line(`ASSETS ${two(v.pictures.length)} · SECTIONS ${two(r.blocks.length)}`, 'VERIFIED');
    await this.line(`SOURCE ${persona(v.info.agent || 'friday').name.toUpperCase()} // ${String(r.kind || 'report').toUpperCase()}`, this.briefing ? 'LIVE' : 'READY');
    // the title card
    this.el.classList.add('titled');
    play(this.card, [{ transform: 'translateY(16px) scale(.98)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: EASE });
    play(this.card.firstChild, [{ transform: 'scale(1.8) rotate(-6deg)', opacity: 0 }, { transform: 'scale(1) rotate(-2deg)', opacity: 1 }], { duration: 300, delay: 120, easing: 'cubic-bezier(.3,1.6,.6,1)' });
    await this.hold(decode(this.title, r.title, 750));
    const left = budget - (performance.now() - t0);
    await this.wait(Math.max(250, Math.min(700, left)));
    // blast doors open onto the board
    this.el.classList.add('open');
    const [top, bottom] = this.doors;
    const fade = play(this.el, [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: this.fast ? 180 : 620, easing: 'linear' });
    play(top, [{ transform: 'none' }, { transform: 'translateY(-101%)' }], { duration: this.fast ? 180 : 560, easing: EASE_IN });
    play(bottom, [{ transform: 'none' }, { transform: 'translateY(101%)' }], { duration: this.fast ? 180 : 560, easing: EASE_IN });
    this.view.root.classList.remove('booting');
    this.view.board.reveal(this.fast);
    await settle(fade);
    this.el.remove();
  }
}

// ---- the intel board: sections scattered like evidence, the briefing's route through them ------
class Board {
  constructor(view) {
    this.view = view; this.cam = null; this.at = null;
    this.plane = el('div', { class: 'plane' });
    this.route = svg('svg', { class: 'route', 'aria-hidden': 'true' }, svg('polyline', { class: 'path' }), svg('polyline', { class: 'run' }));
    this.reticle = el('div', { class: 'brt', 'aria-hidden': 'true' }, ...corners('rc'), el('span'));
    this.el = el('div', { class: 'rp-wall' }, this.plane);
    this.plane.append(this.route);
    this.cards = view.report.blocks.map((b, i) => this.card(b, i));
    this.plane.append(...this.cards, this.reticle);
    this.ro = new ResizeObserver(() => this.layout()); this.ro.observe(this.el);
  }

  card(b, i) {
    const m = b.media?.[0]; const v = this.view;
    const p = el('div', { class: `pic${m ? '' : ' none'}` }, ...corners('tc'));
    if (m) p.style.setProperty('background-image', `url("${pic(v.rid, m.file, 't')}")`);
    else if (b.diagram?.svg) {   // a diagram: a live miniature of it
      const mini = importSvg(b.diagram.svg);
      p.classList.remove('none'); p.classList.add('dia');
      if (mini) p.append(mini);
    } else {   // no picture: what kind of intel it is, at a glance
      const what = b.code?.length ? `</> ${b.code.length} FILE${b.code.length > 1 ? 'S' : ''}` : b.table?.rows?.length ? `GRID ${b.table.rows.length}×${(b.table.columns || []).length || 1}`
        : b.steps?.length ? `${b.steps.length} STEPS` : b.stats?.length ? b.stats[0].value : b.events?.length ? `${b.events.length} EVENTS`
          : b.bullets?.length ? `${b.bullets.length} POINTS` : b.quote ? 'QUOTE' : (TYPE_LABEL[b.type] || 'BRIEF').toUpperCase();
      p.append(el('i', { class: 'rp-bars', 'aria-hidden': 'true' }), el('b', { text: what }));
    }
    if (m?.role === 'video') p.append(el('i', { class: 'vid', 'aria-hidden': 'true', text: '▶' }));
    if (m?.role === 'generated') p.append(el('i', { class: 'gen', text: 'AI' }));
    const card = el('button', { type: 'button', class: `rp-card${m || b.diagram?.svg ? ' has-pic' : ''}`, dataset: { block: b.id }, onclick: () => v.focus(b.id) },
      el('span', { class: 'n', text: two(i + 1) }), p,
      el('div', { class: 'txt' }, el('span', { class: 'k', text: b.kicker || TYPE_LABEL[b.type] || b.type }), el('h3', { text: b.heading }), b.body ? el('p', { text: b.body }) : null),
      el('i', { class: 'pin', 'aria-hidden': 'true' }));
    return card;
  }

  /** Jittered grid: every section has its own cell, nudged and tilted (the same way every time). */
  layout() {
    const W = this.el.clientWidth; const H = this.el.clientHeight; if (!W || !H) return;
    this.W = W; this.H = H;
    if (isCompact()) { this.el.classList.add('list'); return; }
    this.el.classList.remove('list');
    const n = this.cards.length; const rand = seeded(this.view.rid);
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (W / H) * 0.9)))); const rows = Math.ceil(n / cols);
    const padX = 28; const padY = 26; const cw = (W - padX * 2) / cols; const ch = (H - padY * 2) / rows;
    const centres = [];
    this.cards.forEach((card, i) => {
      const r = Math.floor(i / cols); const inRow = r === rows - 1 ? n - r * cols : cols;
      const c = r % 2 ? inRow - 1 - (i % cols) : i % cols;          // snake: the route reads like a path
      const shift = (cols - inRow) * cw / 2;
      const big = card.classList.contains('has-pic');
      const w = Math.min(cw * (big ? 0.84 : 0.74), big ? 340 : 280); const h = Math.min(ch * (big ? 0.84 : 0.7), big ? 300 : 210);
      const x = padX + shift + c * cw + (cw - w) / 2 + (rand() - 0.5) * cw * 0.12;
      const y = padY + r * ch + (ch - h) / 2 + (rand() - 0.5) * ch * 0.14;
      const rot = (rand() - 0.5) * 7;
      for (const [k, v] of [['left', x], ['top', y], ['width', w], ['height', h]]) card.style.setProperty(k, `${v}px`);
      card.style.setProperty('rotate', `${rot.toFixed(2)}deg`);
      card.style.setProperty('--fx', `${((rand() - 0.5) * 260).toFixed(0)}px`); card.style.setProperty('--fy', `${((rand() - 0.5) * 200).toFixed(0)}px`);
      card.style.setProperty('--fr', `${((rand() - 0.5) * 40).toFixed(0)}deg`);
      centres.push([x + w / 2, y + h / 2]);
    });
    this.route.setAttribute('viewBox', `0 0 ${W} ${H}`); this.route.setAttribute('width', W); this.route.setAttribute('height', H);
    const pts = centres.map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`).join(' ');
    for (const line of this.route.children) line.setAttribute('points', pts);
    if (this.at) this.look(this.at, this.atZoom, false);
  }

  /** After the boot: tiles fly in from scattered positions, the route draws itself. */
  reveal(fast) {
    this.layout();
    this.cards.forEach((c, i) => { c.style.setProperty('animation-delay', `${fast ? 0 : 60 + i * 55}ms`); c.classList.remove('in'); void c.offsetWidth; c.classList.add('in'); });
    const run = this.route.querySelector('.run');
    if (!calm() && run.getTotalLength) {
      const len = run.getTotalLength(); run.style.setProperty('stroke-dasharray', `${len}`);
      play(run, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: fast ? 200 : 1400, delay: fast ? 0 : 300, easing: 'ease-out' });
    }
  }

  tile(id) { return this.cards.find((c) => c.dataset.block === id); }

  /** Point the camera at a tile (zoom z), or back at the whole board (null). */
  look(card, z = 1.8, animate = true) {
    const W = this.W || this.el.clientWidth; const H = this.H || this.el.clientHeight;
    let to = 'none';
    if (card) {
      const cx = card.offsetLeft + card.offsetWidth / 2; const cy = card.offsetTop + card.offsetHeight / 2;
      to = `translate(${W / 2 - cx * z}px, ${H / 2 - cy * z}px) scale(${z})`;
    }
    this.at = card; this.atZoom = z;
    const from = getComputedStyle(this.plane).transform;
    this.cam?.cancel(); this.cam = null;   // never wait on a cancelled animation: its `finished` never settles
    this.plane.style.setProperty('transform', to);
    if (animate && !calm()) this.cam = this.plane.animate([{ transform: from === 'none' ? 'none' : from }, { transform: to }], { duration: card ? 640 : 720, easing: 'cubic-bezier(.65,0,.25,1)' });
    for (const c of this.cards) c.classList.toggle('focus', c === card);
    return this.cam ? settle(this.cam) : Promise.resolve();
  }

  /** Lock the board reticle onto a tile. */
  lock(card, label) {
    if (!card) return;
    const r = this.reticle; r.lastChild.textContent = label;
    for (const [k, v] of [['left', card.offsetLeft], ['top', card.offsetTop], ['width', card.offsetWidth], ['height', card.offsetHeight]]) r.style.setProperty(k, `${v}px`);
    r.classList.remove('on'); void r.offsetWidth; r.classList.add('on');
  }

  destroy() { this.ro.disconnect(); this.cam?.cancel(); }
}

// ---- the picture rack: every picture of the report, filed section by section --------------------
class Rack {
  constructor(view) {
    this.view = view; this.slots = [];
    this.rail = el('div', { class: 'rail' });
    view.report.blocks.forEach((b, i) => (b.media || []).forEach((m, j) => {
      const s = el('button', { type: 'button', class: `slot${m.role === 'video' ? ' video' : ''}`, title: b.heading, dataset: { block: b.id, media: String(j) }, onclick: () => view.focus(b.id) }, el('span', { text: two(i + 1) }));
      s.style.setProperty('background-image', `url("${pic(view.rid, m.file, 't')}")`);
      this.slots.push(s);
    }));
    this.rail.append(...this.slots);
    this.el = el('div', { class: 'rp-rack', 'aria-label': 'Pictures' }, el('div', { class: 'rk-cap', text: `ASSETS ${two(this.slots.length)}` }), el('div', { class: 'well' }, this.rail));
    if (!this.slots.length) this.el.classList.add('is-empty');
  }

  /** Pull the section's picture out of the rack; returns its rect (in `root` px) for the flight. */
  select(id, root) {
    const mine = this.slots.filter((s) => s.dataset.block === id);
    for (const s of this.slots) { s.classList.toggle('sel', mine.includes(s)); s.classList.toggle('dim', mine.length > 0 && !mine.includes(s)); }
    if (!mine.length || !this.el.offsetParent) return null;
    const well = this.rail.parentElement; const first = mine[0];
    const ty = Math.max(Math.min(0, well.clientHeight / 2 - (first.offsetTop + first.offsetHeight / 2)), Math.min(0, well.clientHeight - this.rail.scrollHeight));
    const from = getComputedStyle(this.rail).transform;
    this.rail.style.setProperty('transform', `translateY(${ty}px)`);
    play(this.rail, [{ transform: from === 'none' ? 'none' : from }, { transform: `translateY(${ty}px)` }], { duration: 380, easing: EASE, fill: 'none' });
    const r = within(first, root); const cur = new DOMMatrixReadOnly(from === 'none' ? undefined : from);
    return { x: r.x + 14, y: r.y + (ty - cur.m42), w: r.w, h: r.h };
  }

  clear() { for (const s of this.slots) s.classList.remove('sel', 'dim'); }
}

export class ReportView {
  constructor(rid, data, { onClose, briefing = false } = {}) {
    this.rid = rid; this.info = data.info; this.report = data.report; this.onClose = onClose;
    this.mode = 'overview'; this.focusedId = null; this.section = null; this.pops = new Map(); this.seq = 0;
    this.pictures = this.report.blocks.flatMap((b) => b.media || []);
    const r = this.report; const who = persona(this.info.agent || 'friday');
    this.root = el('div', { class: 'rp', dataset: { mode: 'overview' } });
    this.clock = el('span', { class: 'clk', text: 'T+00:00' });
    this.status = el('span', { class: 'st' }, el('i', { class: 'rp-dot' }), el('b', { text: briefing ? 'BRIEFING' : 'DOSSIER' }));
    this.ring = el('div', { class: 'rp-ring', 'aria-hidden': 'true' }, svgRing(), el('b', { text: '00' }), el('small', { text: `/ ${two(r.blocks.length)}` }));
    this.sigil = el('div', { class: 'rp-sigil', 'aria-hidden': 'true', style: `--c:${who.color}` }, el('b', { text: who.initial }), el('i'), el('i'));
    this.head = el('header', { class: 'rp-head' }, this.sigil, this.ring,
      el('div', { class: 'rp-strip' }, el('span', { class: 'tag', text: r.tag || `${r.kind} report` }), el('span', { class: 'kind', text: r.kind }), el('span', { text: `${r.blocks.length} sections` }), el('span', { class: 'sp' }), this.status, this.clock),
      el('h1', { class: 'rp-title', text: r.title }), r.subtitle ? el('div', { class: 'rp-sub', text: r.subtitle }) : null,
      el('div', { class: 'rp-meta' }, el('span', {}, 'By ', el('b', { text: who.name })), el('span', { text: ago(this.info.created_at) }), this.info.pictures ? el('span', { text: `${this.info.pictures} pictures` }) : null, r.confidence ? el('span', {}, 'Confidence ', el('b', { text: r.confidence })) : null));
    this.board = new Board(this);
    this.wall = this.board.el;
    this.rack = new Rack(this);
    this.theater = el('div', { class: 'rp-theater' });
    this.main = el('div', { class: 'rp-main' }, this.wall, this.rack.el, this.theater);
    this.index = el('nav', { class: 'rp-index', 'aria-label': 'Sections' });
    this.linger = el('div', { class: 'rp-linger', role: 'status' }, el('b', { text: 'BRIEFING COMPLETE' }), el('span', { text: 'Closing' }), el('div', { class: 'bar' }, el('i')), el('button', { type: 'button', text: 'Keep open', onclick: () => this.keep() }));
    this.root.append(...corners('fc'), this.head, this.main, this.index, this.linger);
    this.win = new HoloWindow({ id: `report-${rid}`, kind: 'report', title: `REPORT · ${r.title}`, width: 1200, height: 760, minW: 420, minH: 360, item: { type: 'report', id: rid, name: r.title, kind: r.kind }, persona: this.info.agent || null, onClose: () => this.teardown() });
    this.win.extra = () => ({ report: this.state() });
    this.win.body.replaceChildren(this.root);
    this.root.addEventListener('pointerdown', () => this.keep(), true);
    this.root.addEventListener('keydown', () => this.keep(), true);
    this.renderIndex();
    this.t0 = performance.now();
    this.ticker = setInterval(() => { const s = Math.floor((performance.now() - this.t0) / 1000); this.clock.textContent = `T+${two(Math.floor(s / 60))}:${two(s % 60)}`; }, 1000);
    this.startBoot(briefing);
  }

  /** The loading sequence; the first command from Jarvis (or a click) fast-forwards it. */
  startBoot(briefing) {
    const preload = [...this.pictures.map((m) => decoded(pic(this.rid, m.file, 't'))),
      ...(this.report.blocks.find((b) => b.media?.length)?.media || []).slice(0, 1).map((m) => decoded(pic(this.rid, m.file, window.innerWidth > 1500 ? 'l' : 'm')))];
    this.boot = new Boot(this, { briefing });
    this.root.append(this.boot.el);
    this.booted = this.boot.run(preload).catch(() => { this.boot.el.remove(); this.root.classList.remove('booting'); });
  }

  async ready() { if (this.boot?.el.isConnected) { this.boot.skip(); await this.booted; } }

  /** Asked to brief a report that is already open: a short "briefing starts" sweep. */
  briefing() {
    this.status.lastChild.textContent = 'BRIEFING';
    this.root.classList.remove('brief-start'); void this.root.offsetWidth; this.root.classList.add('brief-start');
  }

  block(id) { return this.report.blocks.find((b) => b.id === id); }
  n(id) { return this.report.blocks.findIndex((b) => b.id === id) + 1; }

  renderIndex() {
    const at = this.focusedId ? this.n(this.focusedId) : 0;
    if (this.ring) {   // chapter ring: how far through the briefing (sections), radial
      this.ring.querySelector('.arc')?.setAttribute('stroke-dasharray', `${(at / Math.max(1, this.report.blocks.length)) * 100} 100`);
      this.ring.querySelector('b').textContent = two(at);
    }
    const ov = el('button', { type: 'button', class: `ov${this.mode === 'overview' ? ' on' : ''}`, text: 'ALL', onclick: () => this.overview() });
    this.index.replaceChildren(ov, ...this.report.blocks.map((b, i) => el('button', { type: 'button', class: `${b.id === this.focusedId && this.mode === 'focus' ? 'on' : ''}${i + 1 < at ? ' done' : ''}`, title: b.heading, onclick: () => this.focus(b.id) }, el('b', { text: two(i + 1) }), el('span', { text: b.heading }))));
    reveal(this.index.querySelector('.on'), this.index, 'x');
  }

  /** Commands run one at a time, in order: every section the voice reaches is shown, none is
   *  skipped. When more are waiting, this one cuts instead of animating so the screen catches up. */
  queue(fn) {
    this.waiting = (this.waiting || 0) + 1;
    const run = async () => {
      this.waiting -= 1; rushing = this.waiting > 0;
      try { return await fn(); } finally { rushing = false; }
    };
    const p = (this.chain || Promise.resolve()).then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  focus(id) { return this.queue(() => this._focus(id)); }
  diagram(id, opts) { return this.queue(async () => (await this.inSection(id)).diagram(opts)); }
  code(id, opts) { return this.queue(async () => (await this.inSection(id)).openCode(opts)); }
  row(id, i) { return this.queue(async () => (await this.inSection(id)).row(i)); }
  build(id, i) { return this.queue(async () => (await this.inSection(id)).build(i)); }
  media(id, opts) { return this.queue(async () => (await this.inSection(id)).media(opts)); }
  item(id, part, i) { return this.queue(async () => (await this.inSection(id)).item(part, i)); }
  cite(id, sources) { return this.queue(async () => (await this.inSection(id)).cite(sources)); }

  /** The section a command is for, opened first if another one is showing. */
  async inSection(id) {
    if (id && (id !== this.focusedId || this.mode !== 'focus')) await this._focus(id);
    if (!this.section) throw new Error('open a section first');
    return this.section;
  }
  overview() { return this.queue(() => this._overview()); }
  flag(id, part) { return this.queue(() => this._flag(id, part)); }
  zoom(id, opts) { return this.queue(() => this._zoom(id, opts)); }

  async _focus(id) {
    const b = this.block(id); if (!b) throw new Error(`there is no section ${id}`);
    const seq = ++this.seq;
    await this.ready();
    const fromBoard = this.mode === 'overview';
    const old = this.section; this.section = null;
    this.mode = 'focus'; this.focusedId = id; this.root.dataset.mode = 'focus';
    this.renderIndex(); this.changed();
    const section = new Section(this.rid, b, this.n(id), this.report.blocks.length, { terms: this.report.terms });
    section.onChange = () => { if (this.section === section) this.changed(); };
    this.section = section;
    // leaving: the old section switches off, or the camera dives into the tile on the board
    if (old) { await old.leave(); old.destroy(); old.el.remove(); } else if (fromBoard && !calm() && !isCompact()) {
      this.root.dataset.mode = 'dive';
      await this.board.look(this.board.tile(id), 2.4);
    }
    if (seq !== this.seq) { section.destroy(); return b.heading; }
    this.root.dataset.mode = 'focus';
    const tile = this.board.tile(id);
    this.theater.replaceChildren(section.el);
    const slot = this.rack.select(id, this.root);
    const from = (fromBoard && tile && !isCompact() && b.media?.length ? within(tile.querySelector('.pic'), this.root) : null) || slot;
    await section.enter({ from, root: this.root });
    this.prefetch(id);
    return b.heading;
  }

  prefetch(id) {        // the next section's picture is decoded before it is needed
    const i = this.report.blocks.findIndex((b) => b.id === id);
    const next = this.report.blocks.slice(i + 1).find((b) => b.media?.length);
    if (next) decoded(pic(this.rid, next.media[0].file, window.innerWidth > 1500 ? 'l' : 'm'));
  }

  async _overview() {
    const seq = ++this.seq;
    if (this.boot?.el.isConnected) { this.renderIndex(); return 'overview'; }   // the boot ends on the board anyway
    const old = this.section; const was = this.focusedId; this.section = null;
    this.mode = 'overview'; this.focusedId = null;
    this.renderIndex(); this.changed();
    if (old) { await old.leave(); old.destroy(); old.el.remove(); }
    if (seq !== this.seq) return 'overview';
    this.rack.clear();
    const tile = was ? this.board.tile(was) : null;
    if (tile && !calm() && !isCompact()) { this.board.look(tile, 2.4, false); this.root.dataset.mode = 'overview'; await this.board.look(null); } else { this.root.dataset.mode = 'overview'; this.board.look(null, 1, false); }
    return 'overview';
  }

  step(by) {
    const ids = this.report.blocks.map((b) => b.id);
    const at = this.focusedId ? ids.indexOf(this.focusedId) : -1;
    const next = Math.max(0, Math.min(ids.length - 1, at + by));
    return this.focus(ids[next]);   // queued like any command
  }

  /** Point at a section card on the board (the camera moves in on it) or at a part of the open section. */
  async _flag(id, part) {
    await this.ready();
    if (this.mode === 'focus' && (!id || id === this.focusedId)) return this.section.flag(part);
    const card = this.board.tile(id);
    if (!card) throw new Error(`there is no section ${id}`);
    if (this.mode === 'focus') await this._overview();
    card.classList.remove('flag'); void card.offsetWidth; card.classList.add('flag');
    if (!isCompact()) { this.board.look(card, 1.7); this.board.lock(card, `SECTION ${two(this.n(id))}`); } else reveal(card, this.wall);
    return this.block(id).heading;
  }

  async _zoom(id, opts) {
    if (id && id !== this.focusedId) await this._focus(id);
    if (!this.section) throw new Error('open a section first');
    return this.section.zoom(opts);
  }

  /** Pop a section out into its own portal (to put it side by side with others). */
  async pop(id) {
    const b = this.block(id); if (!b) throw new Error(`there is no section ${id}`);
    const key = `report-${this.rid}-${id}`;
    const old = windows.get(key); if (old) { old.restore(); old.focus(); old.flag(); return b.heading; }
    const section = new Section(this.rid, b, this.n(id), this.report.blocks.length, { terms: this.report.terms });
    const win = new HoloWindow({ id: key, kind: 'report-section', title: `${two(this.n(id))} · ${b.heading}`, width: 860, height: 560, minW: 360, minH: 300, item: { type: 'report-section', id: this.rid, name: b.heading, kind: b.type }, onClose: () => { section.destroy(); this.pops.delete(id); this.changed(); } });
    win.extra = () => ({ report: { id: this.rid, title: this.report.title, section: id } });
    win.body.replaceChildren(el('div', { class: 'rp', dataset: { mode: 'focus' } }, el('div', { class: 'rp-main' }, el('div', { class: 'rp-theater solo' }, section.el))));
    this.pops.set(id, { win, section });
    await section.enter();
    return b.heading;
  }

  /** A question asked during the briefing, answered on this screen (report.ask). */
  aside(opts) { this.keep(); showAside(this, opts); return opts.pending ? 'waiting for the agent' : 'answer shown'; }

  /** A new version of an earlier report: what changed since, on a plate over the board. */
  showChanges() {
    const list = this.report.changes || [];
    if (!list.length) return 'nothing changed';
    this.changesEl?.remove();
    this.changesEl = el('div', { class: 'rp-changes', role: 'status' }, el('b', { text: 'SINCE THE LAST VERSION' }), el('ul', {}, ...list.map((c) => el('li', { text: c }))));
    this.root.append(this.changesEl);
    clearTimeout(this.changesTimer); this.changesTimer = setTimeout(() => this.changesEl?.classList.add('out'), 9000);
    return `${list.length} changes`;
  }

  /** After a briefing: count down, then close everything that belongs to this report. */
  lingerThenClose(seconds = LINGER_S) {
    if (this.closed) return;
    this.lingering = true; this.root.classList.add('lingering'); this.changed();
    this.status.lastChild.textContent = 'COMPLETE';
    const bar = this.linger.querySelector('.bar i');
    this.lingerAnim?.cancel();
    this.lingerAnim = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: seconds * 1000, easing: 'linear', fill: 'forwards' });
    clearTimeout(this.lingerTimer); this.lingerTimer = setTimeout(() => this.closeAll(), seconds * 1000);
  }

  /** The owner spoke, touched or asked for something: stay open. */
  keep() {
    if (this.boot?.el.isConnected) this.boot.skip();
    if (!this.lingering) return false;
    this.lingering = false; clearTimeout(this.lingerTimer); this.lingerAnim?.cancel();
    this.root.classList.remove('lingering'); this.changed();
    return true;
  }

  closeAll() { for (const { win } of this.pops.values()) win.close(); this.win.close(); }

  teardown() {
    this.closed = true; this.seq++; clearTimeout(this.lingerTimer); clearInterval(this.ticker);
    this.boot?.skip(); this.section?.destroy(); this.board.destroy();
    for (const { win } of [...this.pops.values()]) win.close();
    if (this.onClose) this.onClose();
  }

  changed() { windows.changed(this.win, 'item'); }

  state() {
    return {
      id: this.rid, title: this.report.title, kind: this.report.kind, mode: this.mode, focused: this.focusedId,
      lingering: !!this.lingering, popped: [...this.pops.keys()],
      blocks: this.report.blocks.map((b, i) => ({
        id: b.id, n: i + 1, heading: b.heading, type: b.type,
        pictures: (b.media || []).filter((m) => m.role !== 'video').length, videos: (b.media || []).filter((m) => m.role === 'video').length,
        highlights: (b.highlights || []).map((h) => h.label).filter(Boolean),
        diagram: b.diagram?.svg ? String(b.diagram.type || 'diagram').slice(0, 40) : null,
        nodes: b.diagram?.svg ? (b.diagram.nodes || []).slice(0, 80).map((nd) => ({ id: nd.id, label: nd.label || nd.id, code: !!nd.ref })) : [],
        edges: b.diagram?.svg ? (b.diagram.edges || []).slice(0, 120).map((e) => `${e.from}>${e.to}`) : [],
        code: (b.code || []).map((c) => `${c.path}:${c.start}-${c.end}`),
        rows: (b.table?.rows || []).map((r) => r.label), steps: (b.steps || []).map((st) => st.title),
      })),
      view: this.section && this.mode === 'focus' ? this.section.viewState() : null,
    };
  }
}

/** All open reports (one portal each). */
export class ReportDeck {
  constructor({ toast, showStage }) { this.toast = toast; this.showStage = showStage; this.views = new Map(); }

  async open(rid, { section, full = true, briefing = false, asideOf = null } = {}) {
    this.showStage();
    let view = this.views.get(rid);
    if (!view || view.closed) {
      const r = await fetch(`/api/reports/${encodeURIComponent(rid)}`);
      if (!r.ok) throw new Error(r.status === 404 ? 'that report does not exist' : `the report could not be loaded (${r.status})`);
      const data = await r.json();
      const host = asideOf ? this.views.get(asideOf) : null;
      // an answer to a question asked during a briefing plays inside that briefing; a debrief is
      // walked on the stage beside the core; anything else is a briefing portal
      view = host && !host.closed
        ? new DebriefView(rid, data, { host, onClose: () => this.views.delete(rid) })
        : data.report.kind === 'debrief'
        ? new DebriefView(rid, data, { onClose: () => this.views.delete(rid) })
        : new ReportView(rid, data, { onClose: () => this.views.delete(rid), briefing });
      this.views.set(rid, view);
      if (full && !(view instanceof DebriefView)) view.win.setMax(true);
    } else {
      view.win.restore(); view.win.focus();
      if (briefing) view.briefing();
    }
    if (section) await view.focus(section);
    return view.report.title;
  }

  get(rid) { const v = this.views.get(rid); if (!v || v.closed) throw new Error('that report is not open'); return v; }

  /** The owner started talking: no report closes under them. */
  keepAll() { for (const v of this.views.values()) v.keep(); }
}
