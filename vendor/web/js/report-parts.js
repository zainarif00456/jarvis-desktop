// The parts of a briefing section beyond pictures: live diagrams and real code.
//
// DiagramView: the server rendered the agent's Mermaid and rebuilt it from an allow-list, tagging every
// node (data-node) and arrow (data-edge-id, data-from, data-to). Here it becomes a stage the camera can
// move over: zoom onto nodes, dim the rest, trace a path hop by hop with a packet travelling along each
// arrow, light what has been reached. Clicking a node selects it (its note and code). The camera is a
// transform on one wrapper (transform-origin 0 0): screen = t + z * base.
//
// CodeView: an excerpt the server cut from the real file, with line numbers, light syntax colouring
// (spans with textContent only: code is never markup) and marked lines that glow and scroll into view.
//
// Same performance rules as the rest of the deck: transforms and opacity, short animations, a packet is
// one small circle moved by requestAnimationFrame only while a trace runs; lite tier = plain cuts.

import { el } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(.65,0,.25,1)';
const HOP_MS = 820;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lite = () => reduced() || document.documentElement.dataset.fx === 'lite';
const BLOCKED = new Set(['script', 'foreignobject', 'style', 'iframe', 'image', 'use', 'a', 'animate', 'set', 'animatetransform', 'animatemotion', 'filter', 'feimage']);

/** The server's SVG, parsed and checked again here (defence in depth): shapes and text only. */
export function importSvg(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (BLOCKED.has(child.nodeName.toLowerCase())) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name.includes('href')) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(root);
  for (const attr of [...root.attributes]) if (attr.name.toLowerCase().startsWith('on') || attr.name === 'style') root.removeAttribute(attr.name);
  const svg = document.importNode(root, true);
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return svg;
}

const settle = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());

export class DiagramView {
  /** diagram: {svg, type, nodes:[{id,label,note,ref,box}], edges:[{id,from,to,label}]} */
  constructor(diagram, { onSelect, onChange } = {}) {
    this.d = diagram; this.onSelect = onSelect; this.onChange = onChange;
    this.frame = el('div', { class: 'dframe' });
    this.el = el('div', { class: 'rp-dia' }, this.frame);
    this.svg = importSvg(diagram.svg);
    this.t = { x: 0, y: 0, z: 1 }; this.anim = null; this.token = 0; this.packets = [];
    this.state = { focus: [], flow: [] };
    if (!this.svg) { this.el.append(el('div', { class: 'dia-err', text: 'This diagram could not be shown.' })); return; }
    this.frame.append(this.svg);
    this.nodeEls = new Map();
    for (const node of this.svg.querySelectorAll('[data-node]')) {
      const id = node.getAttribute('data-node');
      if (!this.nodeEls.has(id)) this.nodeEls.set(id, []);
      this.nodeEls.get(id).push(node);
      node.classList.add('dn');
    }
    this.edgeEls = new Map();
    for (const edge of this.svg.querySelectorAll('[data-edge-id]')) {
      const id = edge.getAttribute('data-edge-id');
      if (!this.edgeEls.has(id)) this.edgeEls.set(id, []);
      this.edgeEls.get(id).push(edge);
    }
    this.edges = (diagram.edges || []).filter((e) => this.edgeEls.has(e.id));
    this.info = new Map((diagram.nodes || []).map((n) => [n.id, n]));
    for (const [id, els] of this.nodeEls) {
      if (this.info.get(id)?.ref) els.forEach((n) => n.classList.add('has-code'));
      els.forEach((n) => n.addEventListener('click', (ev) => { ev.stopPropagation(); this.select(id); }));
    }
    this.el.addEventListener('click', () => this.select(null));
  }

  get ok() { return !!this.svg; }

  /** The first appearance: nodes come in one after another, arrows draw themselves. */
  drawIn() {
    if (!this.svg || lite()) return;
    const nodes = [...this.nodeEls.values()].map((els) => els[0]);
    nodes.forEach((n, i) => n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 120 + Math.min(i, 24) * 55, easing: 'ease-out', fill: 'backwards' }));
    for (const path of this.svg.querySelectorAll('path[data-edge-id], line[data-edge-id]')) {
      path.setAttribute('pathLength', '1');
      path.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 700, delay: 300 + Math.min(nodes.length, 24) * 40, easing: 'ease-out', fill: 'backwards' })
        .finished.then(() => path.removeAttribute('pathLength'), () => path.removeAttribute('pathLength'));
    }
  }

  // ---- the camera ---------------------------------------------------------------------------
  stageSize() { return { W: this.el.clientWidth, H: this.el.clientHeight }; }

  /** The scale an ancestor (the section's entrance animation) puts on the stage, so measurements stay in stage pixels. */
  hostScale(host) {
    const f = (v) => (Number.isFinite(v) && v > 0 ? v : 1);
    return { sx: f(host.width / this.el.clientWidth), sy: f(host.height / this.el.clientHeight) };
  }

  /** A node's box in base coordinates (the diagram as fitted, before the camera moves). */
  baseRect(id) {
    const els = this.nodeEls.get(id); if (!els) return null;
    const host = this.el.getBoundingClientRect(); const { sx, sy } = this.hostScale(host);
    let r = null;
    for (const n of els) {
      const b = n.getBoundingClientRect(); if (!b.width && !b.height) continue;
      const x0 = (b.left - host.left) / sx / this.t.z - this.t.x / this.t.z; const y0 = (b.top - host.top) / sy / this.t.z - this.t.y / this.t.z;
      const x1 = x0 + b.width / sx / this.t.z; const y1 = y0 + b.height / sy / this.t.z;
      r = r ? { x0: Math.min(r.x0, x0), y0: Math.min(r.y0, y0), x1: Math.max(r.x1, x1), y1: Math.max(r.y1, y1) } : { x0, y0, x1, y1 };
    }
    return r;
  }

  move(to, animate = true) {
    const from = `translate(${this.t.x}px, ${this.t.y}px) scale(${this.t.z})`;
    const target = `translate(${to.x}px, ${to.y}px) scale(${to.z})`;
    this.t = to; this.anim?.cancel(); this.anim = null;   // a cancelled animation's `finished` never settles
    this.frame.style.setProperty('transform', target);
    if (animate && !lite()) this.anim = this.frame.animate([{ transform: from }, { transform: target }], { duration: 850, easing: EASE });
    return settle(this.anim);
  }

  /** Bring these nodes to the middle, as large as fits (never more than 3.2x). */
  frameOn(ids, animate = true) {
    const rects = ids.map((id) => this.baseRect(id)).filter(Boolean);
    if (!rects.length) return this.move({ x: 0, y: 0, z: 1 }, animate);
    const r = rects.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const { W, H } = this.stageSize();
    const w = Math.max(r.x1 - r.x0, 40); const h = Math.max(r.y1 - r.y0, 30);
    const z = Math.max(1, Math.min(ids.length > 1 ? 3 : 2.2, (W * 0.62) / w, (H * 0.62) / h));
    const cx = (r.x0 + r.x1) / 2; const cy = (r.y0 + r.y1) / 2;
    return this.move({ x: W / 2 - cx * z, y: H / 2 - cy * z, z }, animate);
  }

  // ---- what is lit --------------------------------------------------------------------------
  clear() {
    this.token += 1;
    for (const p of this.packets) p.remove();
    this.packets = [];
    if (!this.svg) return;
    this.svg.classList.remove('dim');
    this.svg.querySelectorAll('.on, .live, .lit, .reach').forEach((n) => n.classList.remove('on', 'live', 'lit', 'reach'));
  }

  light(ids) {
    for (const id of ids) (this.nodeEls.get(id) || []).forEach((n) => n.classList.add('on'));
    const set = new Set(ids);
    for (const e of this.edges) if (set.has(e.from) && set.has(e.to)) (this.edgeEls.get(e.id) || []).forEach((n) => n.classList.add('on'));
  }

  /** Zoom onto nodes and dim everything else. */
  async focus(ids) {
    if (!this.svg) throw new Error('the diagram is not shown');
    const known = ids.filter((id) => this.nodeEls.has(id));
    if (ids.length && !known.length) throw new Error(`the diagram has no ${ids.join(', ')}`);
    this.clear(); this.state = { focus: known, flow: [] };
    if (known.length) { this.svg.classList.add('dim'); this.light(known); }
    this.onChange?.();
    await this.frameOn(known);
    return known.length ? `zoomed onto ${known.join(', ')}` : 'whole diagram';
  }

  overview() { return this.focus([]); }

  edgeBetween(a, b) {
    const forward = this.edges.find((e) => e.from === a && e.to === b);
    if (forward) return { edge: forward, reverse: false };
    const back = this.edges.find((e) => e.from === b && e.to === a);
    return back ? { edge: back, reverse: true } : null;
  }

  /** Trace a path: the camera takes in the whole path, then each hop lights up in turn with a packet
   *  running along its arrow; nodes stay lit once reached. Returns at once (the hops keep going). */
  async trace(ids) {
    if (!this.svg) throw new Error('the diagram is not shown');
    const path = ids.filter((id) => this.nodeEls.has(id));
    if (path.length < 2) throw new Error('a trace needs two parts of the diagram that exist');
    this.clear(); this.state = { focus: [], flow: path };
    const token = this.token;
    this.svg.classList.add('dim');
    (this.nodeEls.get(path[0]) || []).forEach((n) => n.classList.add('on', 'reach'));
    this.onChange?.();
    await this.frameOn(path);
    const gaps = [];
    for (let i = 0; i < path.length - 1; i++) {
      if (token !== this.token) return 'interrupted';
      const hop = this.edgeBetween(path[i], path[i + 1]);
      if (hop) {
        const els = this.edgeEls.get(hop.edge.id) || [];
        els.forEach((n) => n.classList.add('on', 'live'));
        await this.packet(els, hop.reverse, token);
        els.forEach((n) => n.classList.remove('live'));
        els.forEach((n) => n.classList.add('lit'));
      } else {
        gaps.push(`${path[i]} -> ${path[i + 1]}`);
        await new Promise((r) => { setTimeout(r, lite() ? 0 : 300); });
      }
      if (token !== this.token) return 'interrupted';
      (this.nodeEls.get(path[i + 1]) || []).forEach((n) => n.classList.add('on', 'reach'));
    }
    return gaps.length ? `traced (no arrow for ${gaps.join(', ')})` : `traced ${path.join(' > ')}`;
  }

  /** A small light travelling along an arrow (path or line), in that arrow's own coordinates. */
  packet(els, reverse, token) {
    const shape = els.find((n) => n.tagName === 'path' || n.tagName === 'line');
    if (!shape || lite()) return new Promise((r) => { setTimeout(r, lite() ? 0 : 260); });
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '5'); dot.setAttribute('class', 'packet');
    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('r', '11'); halo.setAttribute('class', 'packet-halo');
    shape.parentNode.append(halo, dot); this.packets.push(dot, halo);
    let point;
    if (shape.tagName === 'line') {
      const n = (k) => parseFloat(shape.getAttribute(k)) || 0;
      const [x1, y1, x2, y2] = [n('x1'), n('y1'), n('x2'), n('y2')];
      point = (t) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
    } else {
      const len = shape.getTotalLength();
      point = (t) => shape.getPointAtLength(len * t);
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now) => {
        if (token !== this.token) { dot.remove(); halo.remove(); resolve(); return; }
        const p = Math.min(1, (now - t0) / HOP_MS); const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        const at = point(reverse ? 1 - e : e);
        for (const c of [dot, halo]) { c.setAttribute('cx', at.x.toFixed(1)); c.setAttribute('cy', at.y.toFixed(1)); }
        if (p < 1) requestAnimationFrame(step); else { dot.remove(); halo.remove(); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  select(id) {
    this.svg?.querySelectorAll('.picked').forEach((n) => n.classList.remove('picked'));
    if (id) (this.nodeEls.get(id) || []).forEach((n) => n.classList.add('picked'));
    this.onSelect?.(id ? (this.info.get(id) || { id, label: id }) : null);
  }

  /** The box of one node in stage pixels (for the reticle). */
  stageRect(id) {
    const els = this.nodeEls.get(id); if (!els?.length) return null;
    const host = this.el.getBoundingClientRect(); const b = els[0].getBoundingClientRect(); const { sx, sy } = this.hostScale(host);
    return { x: (b.left - host.left) / sx, y: (b.top - host.top) / sy, w: b.width / sx, h: b.height / sy };
  }

  destroy() { this.token += 1; this.anim?.cancel(); for (const p of this.packets) p.remove(); }
}

// ---- code ------------------------------------------------------------------------------------
const KEYWORDS = new Set(('def class return if elif else for while in not and or is None True False import from as with try except finally raise ' +
  'async await yield lambda pass break continue global nonlocal assert del function const let var new this typeof instanceof ' +
  'export default extends super static get set switch case throw catch do void null undefined true false interface type enum ' +
  'public private protected readonly implements package fn pub impl struct mut match use mod crate trait where loop go func defer ' +
  'chan select map range var struct self Self').split(' '));
const TOKEN = /(#.*$|\/\/.*$|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_.]*\b|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b|@[A-Za-z_][\w.]*)/g;

function colour(line, language) {
  const out = []; let last = 0;
  const hashComment = ['python', 'shell', 'ruby', 'yaml', 'toml'].includes(language);
  for (const m of line.matchAll(TOKEN)) {
    const t = m[0];
    if (m.index > last) out.push(document.createTextNode(line.slice(last, m.index)));
    let cls = '';
    if (t.startsWith('#')) cls = hashComment ? 'c' : '';
    else if (t.startsWith('//') || t.startsWith('/*')) cls = 'c';
    else if (/^["'`]/.test(t)) cls = 's';
    else if (/^\d/.test(t)) cls = 'n';
    else if (t.startsWith('@')) cls = 'd';
    else if (KEYWORDS.has(t)) cls = 'k';
    else if (line.slice(m.index + t.length).trimStart().startsWith('(')) cls = 'f';
    out.push(cls ? el('span', { class: cls, text: t }) : document.createTextNode(t));
    last = m.index + t.length;
    if (cls === 'c' && (t.startsWith('#') || t.startsWith('//'))) { last = line.length; break; }
  }
  if (last < line.length) out.push(document.createTextNode(line.slice(last)));
  return out;
}

export class CodeView {
  /** excerpt: {path, start, end, total, language, text, marks, title, note} */
  constructor(excerpt, { big = false } = {}) {
    this.x = excerpt;
    this.rows = String(excerpt.text || '').split('\n').map((line, i) => el('div', { class: 'cl', dataset: { n: String(excerpt.start + i) } },
      el('span', { class: 'no', text: String(excerpt.start + i) }), el('code', {}, ...colour(line, excerpt.language))));
    this.body = el('div', { class: 'cb' }, ...this.rows);
    this.el = el('div', { class: `rp-codeview${big ? ' big' : ''}` },
      el('div', { class: 'ch' }, el('b', { text: excerpt.path }), el('span', { text: `L${excerpt.start}–${excerpt.end}${excerpt.total ? ` of ${excerpt.total}` : ''} · ${excerpt.language}` })),
      excerpt.title || excerpt.note ? el('div', { class: 'cn' }, excerpt.title ? el('b', { text: excerpt.title }) : null, excerpt.note ? el('span', { text: excerpt.note }) : null) : null,
      this.body);
    if (excerpt.marks?.length) this.mark(excerpt.marks, false);
  }

  /** Light these line ranges ([[a, b], ...] in file line numbers) and bring the first into view. */
  mark(ranges, scroll = true) {
    const inRange = (n) => ranges.some(([a, b]) => n >= a && n <= (b ?? a));
    let first = null;
    for (const row of this.rows) {
      const hot = inRange(Number(row.dataset.n));
      row.classList.toggle('hot', hot);
      if (hot && !first) first = row;
    }
    this.el.classList.toggle('marked', !!first);
    if (first && scroll) {
      const target = first.offsetTop - this.body.clientHeight * 0.3;
      this.body.scrollTo({ top: Math.max(0, target), behavior: lite() ? 'auto' : 'smooth' });
    }
    if (first && !lite()) {
      for (const row of this.rows) if (row.classList.contains('hot')) row.animate([{ transform: 'translateX(-8px)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'ease-out' });
    }
    return first ? `lines ${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')}` : 'no such lines in this excerpt';
  }
}
