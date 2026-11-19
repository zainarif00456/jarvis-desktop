// Data blocks: how a section's data is drawn, shared by briefings (js/report.js Section) and the
// stage debriefs (js/debrief/stage.js). One renderer per kind of data, registered in RENDERERS.
//
//   messages  a conversation (Slack, email): bubbles, replies, quote vs paraphrase, notes
//   person    a dossier: picture under a targeting reticle, name, role, facts
//   checks    a diagnosis as a chain of dials (ok / warn / fail / skip / info)
//   terminal  commands and the output lines that matter, typed in
//   chart     a chart drawn from real numbers (bar, line, area, donut, scatter)
//   change    a document change: what was asked, before -> after
//   draft     a message prepared for the owner (Slack / email)
//
// renderData(block, opts) -> { el, parts: { name: [item elements] }, item(part, i), flag(part) }
// `item` lights one item (the beat's show.part + show.item, voice-clocked); the others dim.
// Everything is text content (never HTML), animated with transform/opacity only, and every item
// carries `data-ref` (part:index) so the pointer can tell Jarvis what the owner is looking at.
// To add a kind of data: write a renderer below, add it to RENDERERS, and add its model class in
// server/jarvis/reports/model.py (Block field) and the agents' guide (workers/base.py SHOW_GUIDE).

import { el } from '../util.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); n.append(...kids.filter(Boolean)); return n; };
const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
// a stable colour per person (hue from the name): the same sender always looks the same
const hue = (name) => { let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export const fmtNumber = (v, unit = '') => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '–';
  const n = Number(v); const abs = Math.abs(n);
  const text = abs >= 10000 ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: abs < 10 ? 2 : abs < 100 ? 1 : 0 }).format(n);
  return unit ? (unit === '%' ? `${text}%` : `${text} ${unit}`) : text;
};

// ---- messages -------------------------------------------------------------------------------
function messages(b) {
  const items = b.messages.map((m, i) => {
    const who = el('div', { class: 'bk-who' }, el('b', { text: m.who }), m.role ? el('span', { text: m.role }) : null,
      m.where ? el('span', { class: 'bk-where', text: m.where }) : null, m.when ? el('time', { text: m.when }) : null,
      el('em', { class: `bk-kind ${m.kind}`, text: m.kind === 'quote' ? 'EXACT' : 'PARAPHRASED', title: m.kind === 'quote' ? 'The exact words, fetched' : 'In the agent\'s words' }));
    return el('div', { class: `bk-msg tone-${m.tone || 'normal'}${m.reply_to != null ? ' reply' : ''}`, dataset: { ref: `messages:${i}` }, style: `--h:${hue(m.who)}; --i:${i}` },
      el('div', { class: 'bk-av', text: initials(m.who), 'aria-hidden': 'true' }),
      el('div', { class: 'bk-bubble' }, who,
        m.reply_to != null ? el('div', { class: 'bk-replyto', text: `↳ to ${b.messages[m.reply_to]?.who || 'earlier'}: ${String(b.messages[m.reply_to]?.text || '').slice(0, 70)}` }) : null,
        el('p', { text: m.text }), m.note ? el('div', { class: 'bk-note', text: m.note }) : null));
  });
  return { el: el('div', { class: 'bk bk-thread rp-part', dataset: { part: 'messages' } }, ...items), parts: { messages: items } };
}

// ---- person ----------------------------------------------------------------------------------
function person(b, { picture } = {}) {
  const p = b.person;
  const src = p.media != null ? picture?.(p.media) : null;
  const face = el('div', { class: 'bk-face', 'aria-hidden': 'true' },
    src ? el('img', { src, alt: '', decoding: 'async', draggable: 'false' }) : el('b', { text: initials(p.name) }),
    el('i', { class: 'r1' }), el('i', { class: 'r2' }), el('i', { class: 'r3' }), el('i', { class: 'lock', text: 'ID LOCK' }));
  const facts = (p.facts || []).map((f, i) => el('div', { class: 'bk-fact', dataset: { ref: `facts:${i}` }, style: `--i:${i}` }, el('span', { text: f.label }), el('b', { text: f.value })));
  const card = el('div', { class: 'bk bk-person rp-part', dataset: { part: 'person', ref: 'person:0' } }, face,
    el('div', { class: 'bk-dossier' },
      el('div', { class: 'bk-tag', text: 'SUBJECT' }), el('h3', { text: p.name }),
      p.role || p.org ? el('div', { class: 'bk-role', text: [p.role, p.org].filter(Boolean).join(' · ') }) : null,
      p.handle ? el('div', { class: 'bk-handle', text: p.handle }) : null,
      p.relation ? el('div', { class: 'bk-rel' }, el('span', { text: 'RELATION' }), el('b', { text: p.relation })) : null,
      facts.length ? el('div', { class: 'bk-facts' }, ...facts) : null));
  return { el: card, parts: { person: [card], facts } };
}

// ---- dossier ---------------------------------------------------------------------------------
// A company and its people (or one person) as files on a board, like an intelligence dossier: each
// file has the picture / logo under a reticle, headline, facts, a short history and links; lines join
// the files that belong together (founder of, works at). Beats walk the files: {part: 'subjects', item}.
const two = (n) => String(n + 1).padStart(2, '0');
function dossier(b, { picture } = {}) {
  const d = b.dossier;
  const files = d.subjects.map((s, i) => {
    const src = s.media != null ? picture?.(s.media) : null;
    const face = el('div', { class: `bk-face ds-face ${s.kind}`, 'aria-hidden': 'true' },
      src ? el('img', { src, alt: '', decoding: 'async', draggable: 'false' }) : el('b', { text: initials(s.name) }),
      el('i', { class: 'r1' }), el('i', { class: 'r2' }), el('i', { class: 'r3' }), el('i', { class: 'lock', text: s.kind === 'company' ? 'ORG LOCK' : 'ID LOCK' }));
    const facts = (s.facts || []).map((f, k) => el('div', { class: 'bk-fact', style: `--i:${k}` }, el('span', { text: f.label }), el('b', { text: f.value })));
    const history = (s.history || []).length ? el('ol', { class: 'ds-hist' }, ...s.history.map((h, k) => el('li', { style: `--i:${k}` }, el('time', { text: h.when || '' }), el('span', { text: h.text })))) : null;
    const links = (s.links || []).length ? el('div', { class: 'ds-links' }, ...s.links.map((l) => el('a', { class: 'ds-link', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))) : null;
    const card = el('article', { class: `ds-file ${s.kind}${s.confidence === 'low' ? ' unsure' : ''}`, dataset: { ref: `subjects:${i}` }, style: `--i:${i}` },
      el('header', { class: 'ds-top' }, el('span', { class: 'ds-no', text: `FILE ${two(i)}` }), el('span', { class: 'ds-kind', text: s.kind === 'company' ? 'ORGANISATION' : 'PERSON' }),
        s.confidence && s.confidence !== 'high' ? el('span', { class: 'ds-conf', text: s.confidence === 'low' ? 'UNCONFIRMED' : 'LIKELY' }) : null),
      el('div', { class: 'ds-id' }, face, el('div', { class: 'ds-head' },
        el('h3', { text: s.name }),
        s.role || s.org ? el('div', { class: 'bk-role', text: [s.role, s.org].filter(Boolean).join(' · ') }) : null,
        s.location ? el('div', { class: 'ds-loc', text: s.location }) : null,
        s.relation ? el('div', { class: 'bk-rel' }, el('span', { text: 'RELATION' }), el('b', { text: s.relation })) : null)),
      s.summary ? el('p', { class: 'ds-sum', text: s.summary }) : null,
      facts.length ? el('div', { class: 'bk-facts' }, ...facts) : null, history, links);
    return card;
  });
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); lines.setAttribute('class', 'ds-wires'); lines.setAttribute('aria-hidden', 'true');
  const board = el('div', { class: `bk bk-dossier-board rp-part n${files.length}`, dataset: { part: 'subjects' } }, lines, ...files);
  // the lines between files are measured once the board is laid out, and again when it changes size
  const wire = () => {
    const box = board.getBoundingClientRect(); if (!box.width) return;
    lines.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    lines.replaceChildren(...(d.connections || []).flatMap((c) => {
      const a = files[c.a]?.getBoundingClientRect(); const z = files[c.b]?.getBoundingClientRect(); if (!a || !z) return [];
      // edge to edge, through the gap between the two files (a line from centre to centre would hide under them)
      const stacked = a.bottom <= z.top || z.bottom <= a.top;
      const [top, low] = a.top <= z.top ? [a, z] : [z, a]; const [left, right] = a.left <= z.left ? [a, z] : [z, a];
      const x1 = (stacked ? top.left + top.width / 2 : left.right) - box.left; const y1 = (stacked ? top.bottom : left.top + left.height / 2) - box.top;
      const x2 = (stacked ? low.left + low.width / 2 : right.left) - box.left; const y2 = (stacked ? low.top : right.top + right.height / 2) - box.top;
      const ns = 'http://www.w3.org/2000/svg';
      const line = document.createElementNS(ns, 'line'); for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(k, String(Math.round(v)));
      const tag = document.createElementNS(ns, 'text'); tag.setAttribute('x', String(Math.round((x1 + x2) / 2))); tag.setAttribute('y', String(Math.round((y1 + y2) / 2) - 4)); tag.textContent = c.label || '';
      return [line, tag];
    }));
  };
  if (files.length > 1 && (d.connections || []).length) {
    const watch = new ResizeObserver(() => requestAnimationFrame(wire)); watch.observe(board);
    requestAnimationFrame(() => requestAnimationFrame(wire));
  }
  return { el: board, parts: { subjects: files } };
}

// ---- checks ----------------------------------------------------------------------------------
const STATUS = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skip: 'SKIP', info: 'INFO' };
function checks(b) {
  const items = b.checks.map((c, i) => {
    const ring = svg('svg', { viewBox: '0 0 64 64', class: 'bk-dial', 'aria-hidden': 'true' },
      svg('circle', { cx: 32, cy: 32, r: 27, class: 'track' }), svg('circle', { cx: 32, cy: 32, r: 27, class: 'arc', pathLength: 100 }),
      svg('circle', { cx: 32, cy: 32, r: 20, class: 'tick', pathLength: 100 }));
    return el('div', { class: `bk-check s-${c.status}`, dataset: { ref: `checks:${i}` }, style: `--i:${i}` },
      el('div', { class: 'bk-dialbox' }, ring, el('b', { text: STATUS[c.status] || c.status.toUpperCase() })),
      el('div', { class: 'bk-ctext' }, el('h4', { text: c.label }), c.value ? el('span', { class: 'bk-val', text: c.value }) : null, c.detail ? el('p', { text: c.detail }) : null));
  });
  return { el: el('div', { class: 'bk bk-checks rp-part', dataset: { part: 'checks' } }, ...items), parts: { checks: items } };
}

// ---- terminal --------------------------------------------------------------------------------
function terminal(b) {
  const t = b.terminal;
  const items = t.lines.map((ln, i) => el('div', { class: `bk-ln t-${ln.tone}`, dataset: { ref: `terminal:${i}` } },
    ln.tone === 'cmd' ? el('span', { class: 'bk-ps', text: '$ ', 'aria-hidden': 'true' }) : null, el('span', { text: ln.text })));
  return { el: el('div', { class: 'bk bk-term rp-part', dataset: { part: 'terminal' } },
    el('div', { class: 'bk-termbar' }, el('i'), el('i'), el('i'), el('span', { text: t.title || 'console' })),
    el('div', { class: 'bk-termbody' }, ...items)), parts: { terminal: items } };
}

// ---- chart -----------------------------------------------------------------------------------
function chart(b) {
  const c = b.chart; const W = 640; const H = 300; const pad = { l: 54, r: 18, t: 18, b: 42 };
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: `bk-chart-svg c-${c.type}`, role: 'img', 'aria-label': c.title || 'chart' });
  const items = [];
  const series = c.series || [];
  if (c.type === 'donut') {
    const vals = (series[0]?.values || []).map((v) => Math.max(0, Number(v) || 0)); const total = vals.reduce((a, v) => a + v, 0) || 1;
    let at = 0; const cx = W / 2 - 110; const cy = H / 2; const r = 104;
    vals.forEach((v, i) => {
      const seg = svg('circle', { cx, cy, r, class: `bk-seg s${i % 6}`, pathLength: 100, 'stroke-dasharray': `${(v / total) * 100} 100`, 'stroke-dashoffset': -at });
      seg.dataset.ref = `chart:${i}`; at += (v / total) * 100; items.push(seg); root.append(seg);
    });
    root.append(svg('text', { x: cx, y: cy + 6, class: 'bk-donut-total', 'text-anchor': 'middle' }, document.createTextNode(fmtNumber(vals.reduce((a, v) => a + v, 0), c.unit))));
    (c.labels || []).forEach((label, i) => {
      const y = 46 + i * 26; if (y > H - 10) return;
      root.append(svg('rect', { x: W / 2 + 20, y: y - 11, width: 12, height: 12, rx: 2, class: `bk-key s${i % 6}` }),
        svg('text', { x: W / 2 + 40, y, class: 'bk-axis' }, document.createTextNode(`${label} · ${fmtNumber(vals[i], c.unit)}`)));
    });
    return { el: el('figure', { class: 'bk bk-chart rp-part', dataset: { part: 'chart' } }, c.title ? el('figcaption', { text: c.title }) : null, root), parts: { chart: items } };
  }
  const xs = c.type === 'scatter' ? c.points.map((p) => p.x) : (c.labels || []).map((_, i) => i);
  const ys = c.type === 'scatter' ? c.points.map((p) => p.y) : series.flatMap((s) => s.values.filter((v) => v !== null));
  const lo = Math.min(0, ...ys); const hi = Math.max(...ys, lo + 1);
  const x0 = Math.min(...xs, 0); const x1 = Math.max(...xs, x0 + 1);
  const n = c.type === 'scatter' ? 1 : Math.max(1, (c.labels || []).length);
  const band = (W - pad.l - pad.r) / n;
  const sx = (i) => (c.type === 'scatter' ? pad.l + ((i - x0) / (x1 - x0)) * (W - pad.l - pad.r) : pad.l + band * (i + 0.5));
  const sy = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  for (let g = 0; g <= 4; g++) {      // grid + y labels
    const v = lo + ((hi - lo) * g) / 4; const y = sy(v);
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'bk-grid' }), svg('text', { x: pad.l - 8, y: y + 4, class: 'bk-axis', 'text-anchor': 'end' }, document.createTextNode(fmtNumber(v))));
  }
  if (c.type !== 'scatter') (c.labels || []).forEach((label, i) => { if (n <= 14 || i % Math.ceil(n / 14) === 0) root.append(svg('text', { x: sx(i), y: H - pad.b + 18, class: 'bk-axis', 'text-anchor': 'middle' }, document.createTextNode(String(label).slice(0, 12)))); });
  if (c.type === 'bar') {
    const k = Math.max(1, series.length); const bw = Math.min(46, (band * 0.72) / k);
    (c.labels || []).forEach((_, i) => {
      const g = svg('g', { class: 'bk-bar', style: `--i:${i}` }); g.dataset.ref = `chart:${i}`;
      series.forEach((s, j) => {
        const v = s.values[i]; if (v === null || v === undefined) return;
        const y = sy(Math.max(v, 0)); const h = Math.abs(sy(v) - sy(0)) || 1;
        g.append(svg('rect', { x: sx(i) - (bw * k) / 2 + j * bw + 1, y: v >= 0 ? y : sy(0), width: bw - 2, height: h, rx: 2, class: `s${j % 6}` }));
      });
      g.append(svg('text', { x: sx(i), y: sy(Math.max(...series.map((s) => s.values[i] ?? lo), 0)) - 6, class: 'bk-val', 'text-anchor': 'middle' }, document.createTextNode(fmtNumber(series[0]?.values[i], c.unit))));
      items.push(g); root.append(g);
    });
  } else if (c.type === 'scatter') {
    c.points.forEach((pt, i) => {
      const g = svg('g', { class: 'bk-pt' }, svg('circle', { cx: sx(pt.x), cy: sy(pt.y), r: 5, class: 's0' }), pt.label ? svg('text', { x: sx(pt.x) + 8, y: sy(pt.y) - 6, class: 'bk-val' }, document.createTextNode(pt.label)) : null);
      g.dataset.ref = `chart:${i}`; items.push(g); root.append(g);
    });
  } else {   // line / area
    series.forEach((s, j) => {
      const pts = s.values.map((v, i) => (v === null ? null : [sx(i), sy(v)])).filter(Boolean);
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      if (c.type === 'area') root.append(svg('path', { d: `${d} L${pts.at(-1)[0]},${sy(lo)} L${pts[0][0]},${sy(lo)} Z`, class: `bk-area s${j % 6}` }));
      root.append(svg('path', { d, class: `bk-line s${j % 6}`, pathLength: 100 }));
    });
    (c.labels || []).forEach((_, i) => {
      const v = series[0]?.values[i]; if (v === null || v === undefined) { items.push(svg('g')); return; }
      const g = svg('g', { class: 'bk-pt' }, svg('circle', { cx: sx(i), cy: sy(v), r: 4, class: 's0' }), svg('text', { x: sx(i), y: sy(v) - 10, class: 'bk-val', 'text-anchor': 'middle' }, document.createTextNode(fmtNumber(v, c.unit))));
      g.dataset.ref = `chart:${i}`; items.push(g); root.append(g);
    });
  }
  if (c.y_label) root.append(svg('text', { x: 12, y: pad.t + 4, class: 'bk-axis' }, document.createTextNode(c.y_label)));
  const legend = series.length > 1 ? el('div', { class: 'bk-legend' }, ...series.map((s, j) => el('span', { class: `s${j % 6}`, text: s.name || `Series ${j + 1}` }))) : null;
  return { el: el('figure', { class: 'bk bk-chart rp-part', dataset: { part: 'chart' } }, c.title ? el('figcaption', { text: c.title }) : null, root, legend), parts: { chart: items } };
}

// ---- document change ---------------------------------------------------------------------------
function change(b) {
  const c = b.change;
  return { el: el('div', { class: 'bk bk-change rp-part', dataset: { part: 'change', ref: 'change:0' } },
    el('div', { class: 'bk-doc' }, el('b', { text: c.document }), c.section ? el('span', { text: ` · ${c.section}` }) : null),
    c.asked ? el('blockquote', { class: 'bk-asked' }, el('span', { class: 'bk-tag', text: c.asked_by ? `ASKED BY ${c.asked_by.toUpperCase()}` : 'ASKED' }), el('p', { text: c.asked })) : null,
    el('div', { class: 'bk-diff' },
      el('div', { class: 'bk-before' }, el('span', { class: 'bk-tag', text: 'BEFORE' }), ...(c.before || []).map((t) => el('p', { text: t }))),
      el('i', { class: 'bk-arrow', 'aria-hidden': 'true' }),
      el('div', { class: 'bk-after' }, el('span', { class: 'bk-tag', text: 'AFTER' }), ...(c.after || []).map((t) => el('p', { text: t })))),
    c.note ? el('div', { class: 'bk-note', text: c.note }) : null), parts: { change: [] } };
}

// ---- draft -------------------------------------------------------------------------------------
function draft(b) {
  const d = b.draft;
  return { el: el('div', { class: `bk bk-draft rp-part ch-${d.channel}`, dataset: { part: 'draft', ref: 'draft:0' } },
    el('div', { class: 'bk-draftbar' }, el('b', { text: d.channel === 'email' ? 'EMAIL' : d.channel === 'slack' ? 'SLACK' : 'MESSAGE' }), el('span', { class: `bk-status ${d.status}`, text: d.status.toUpperCase() })),
    el('div', { class: 'bk-to' }, el('span', { text: 'To' }), el('b', { text: d.to })),
    d.subject ? el('div', { class: 'bk-to' }, el('span', { text: 'Subject' }), el('b', { text: d.subject })) : null,
    el('pre', { class: 'bk-body', text: d.body })), parts: { draft: [] } };
}

const RENDERERS = { messages: [(b) => b.messages?.length, messages], person: [(b) => b.person, person], dossier: [(b) => b.dossier?.subjects?.length, dossier], checks: [(b) => b.checks?.length, checks],
  terminal: [(b) => b.terminal?.lines?.length, terminal], chart: [(b) => b.chart && ((b.chart.labels || []).length || (b.chart.points || []).length), chart],
  change: [(b) => b.change, change], draft: [(b) => b.draft, draft] };

/** Does this block carry any data block? */
export const hasData = (b) => Object.values(RENDERERS).some(([has]) => has(b));

/** Draw every data block of `b`. opts.picture(i) -> URL of the block's picture i (for the person). */
export function renderData(b, opts = {}) {
  const made = Object.values(RENDERERS).filter(([has]) => has(b)).map(([, draw]) => draw(b, opts));
  const parts = {}; for (const m of made) Object.assign(parts, m.parts);
  const root = el('div', { class: `bk-set n${made.length}` }, ...made.map((m) => m.el));
  let lit = null;
  // popup cards: a conversation or a chain of checks builds up as it is told (item 0 is there from the start;
  // the rest pop in when their sentence starts). revealAll() is the safety net: nothing stays hidden.
  const waiting = new Set();
  if (opts.progressive) for (const part of ['messages', 'checks']) for (const n of (parts[part] || []).slice(1)) { n.classList.add('bk-wait'); waiting.add(n); }
  const reveal = (n) => { if (!waiting.delete(n)) return; n.classList.remove('bk-wait'); if (!calm()) n.classList.add('bk-pop'); };
  return {
    el: root, parts,
    revealAll() { for (const n of [...waiting]) reveal(n); },
    /** Light item i of a part (the others dim); returns the element, or null when there is none. */
    item(part, i) {
      const list = parts[part]; const node = list?.[i]; if (!node) return null;
      for (let k = 0; k <= i; k++) reveal(list[k]);
      for (const n of list) n.classList?.remove('hot');
      root.querySelector(`[data-part="${part}"]`)?.classList.add('walking');
      node.classList.add('hot', 'seen');
      for (let k = 0; k <= i; k++) list[k].classList?.add('seen');   // a terminal / thread builds up to here
      lit = node;
      // scroll only the list that holds it (scrollIntoView would also scroll the clipped stage sideways)
      const box = node.closest?.('.bk-thread, .bk-termbody, .bk-checks');
      if (box && box.scrollHeight > box.clientHeight) box.scrollTo({ top: Math.max(0, node.offsetTop - box.clientHeight / 3), behavior: calm() ? 'auto' : 'smooth' });
      return node;
    },
    current: () => lit,
  };
}
