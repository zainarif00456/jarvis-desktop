// Any tool result that is JSON, drawn as a clean data view instead of raw text. The shape is not
// known in advance (Jarvis's tools, the agents' Slack/Gmail/ClickUp/... tools all differ), so the
// view adapts to the value at runtime:
//
//   object            key / value grid (keys made readable: snake_case -> "Snake case");
//                     nested objects fold open/closed (the first level is open)
//   list of objects   a table when the items share their keys, else small stacked cards
//   list of scalars   chips
//   true / false      a yes / no badge          null, "", [] , {}  hidden
//   numbers           sizes (bytes / *_size), money (usd / cost / price), durations (ms / _s),
//                     thousands separators
//   strings           ISO dates as "2 h ago" (exact time on hover), links, long text folded
//   {"$path": ...}    a file or folder on the laptop: clickable like everywhere else (handle)
//   status / ok / error at the top level   pills in the header
//
// Built once, revealed row by row (js/exec/render.js plays it). Never innerHTML: text only.

import { el, fmtBytes } from '../util.js';

const MAX_ROWS = 30;      // table rows / stacked cards shown before "+N more"
const MAX_COLS = 5;
const FOLD_CHARS = 280;   // longer text folds
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const HEAD_KEYS = ['status', 'state', 'ok', 'error', 'decision'];

export const human = (key) => {
  const words = String(key).replace(/^\$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
};
const empty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPath = (v) => isObj(v) && typeof v.$path === 'string';
const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || isPath(v);

function ago(date) {
  const s = (Date.now() - date.getTime()) / 1000;
  const a = Math.abs(s); const sign = s < 0 ? 'in ' : '';
  const t = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : a < 86400 * 45 ? `${Math.round(a / 86400)} d` : null;
  if (!t) return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return s < 0 ? `${sign}${t}` : `${t} ago`;
}

function number(key, n) {
  const k = String(key).toLowerCase();
  if (/(^|_)(bytes|size)($|_)|_bytes$|size_bytes/.test(k) && n >= 0) return fmtBytes(n);
  if (/(usd|cost|price|amount|spend)/.test(k)) return `$${n.toFixed(n < 1 ? 4 : 2)}`;
  if (/(^|_)ms$|_ms$|latency|duration_ms/.test(k)) return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
  if (/(^|_)(s|secs|seconds)$|duration_s/.test(k)) return n < 90 ? `${n.toFixed(n < 10 ? 1 : 0)} s` : `${Math.round(n / 60)} min`;
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** One value, small (inside a grid cell or table cell). */
function leaf(key, v, ctx) {
  if (isPath(v)) return ctx.pathButton(v);
  if (typeof v === 'boolean') return el('span', { class: `xd-bool ${v ? 'yes' : 'no'}`, text: v ? 'yes' : 'no' });
  if (typeof v === 'number') return el('span', { class: 'xd-num', text: number(key, v) });
  if (v === null || v === undefined) return el('span', { class: 'xd-nil', text: '—' });
  if (isObj(v) && typeof v.$more === 'number') return el('span', { class: 'xd-nil', text: `+${v.$more} more` });
  const s = String(v);
  if (ISO.test(s)) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return el('time', { class: 'xd-date', datetime: s, title: d.toLocaleString(), text: ago(d) }); }
  if (URL_RE.test(s)) return el('a', { class: 'xd-link', href: s, target: '_blank', rel: 'noopener noreferrer', text: s.replace(/^https?:\/\//, '').slice(0, 80) });
  if (s.length > FOLD_CHARS || s.includes('\n')) {
    const body = el('span', { class: 'xd-long', text: s });
    if (s.length <= FOLD_CHARS && s.split('\n').length <= 4) return body;
    body.classList.add('folded');
    const more = el('button', { type: 'button', class: 'xd-more', text: 'more' });
    more.addEventListener('click', (e) => { e.stopPropagation(); const f = body.classList.toggle('folded'); more.textContent = f ? 'more' : 'less'; ctx.touch?.(more); });
    return el('span', { class: 'xd-longbox' }, body, more);
  }
  return el('span', { class: 'xd-str', text: s });
}

/** A list of objects that share their keys: a table. */
function table(items, ctx) {
  const counts = new Map();
  for (const it of items) for (const [k, v] of Object.entries(it)) if (scalar(v) && !empty(v)) counts.set(k, (counts.get(k) || 0) + 1);
  const cols = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COLS).map(([k]) => k);
  if (cols.length < 1) return null;
  const head = el('tr', {}, ...cols.map((c) => el('th', { text: human(c) })));
  const rows = items.slice(0, MAX_ROWS).map((it) => el('tr', { class: 'xd-row' }, ...cols.map((c) => el('td', {}, empty(it[c]) ? '' : leaf(c, it[c], ctx)))));
  const more = items.length > MAX_ROWS ? el('div', { class: 'xd-nil', text: `+${items.length - MAX_ROWS} more` }) : null;
  return el('div', { class: 'xd-tablebox' }, el('table', { class: 'xd-table' }, el('thead', {}, head), el('tbody', {}, ...rows)), more);
}

function sharesKeys(items) {
  if (items.length < 2 || !items.every(isObj)) return false;
  const first = new Set(Object.keys(items[0]));
  const common = items.every((it) => Object.keys(it).filter((k) => first.has(k)).length >= Math.min(2, first.size));
  const flat = items.every((it) => Object.values(it).filter((v) => !scalar(v)).length <= 2);
  return common && flat;
}

/** Any value, full size. */
function block(key, v, ctx, depth) {
  if (Array.isArray(v)) {
    const items = v.filter((x) => !empty(x));
    if (!items.length) return null;
    if (items.every((x) => scalar(x) || (isObj(x) && typeof x.$more === 'number'))) {
      return el('div', { class: 'xd-chips' }, ...items.slice(0, 40).map((x) => el('span', { class: 'xd-chip' }, leaf(key, x, ctx))));
    }
    if (sharesKeys(items)) { const t = table(items, ctx); if (t) return t; }
    return el('div', { class: 'xd-stack' }, ...items.slice(0, MAX_ROWS).map((x, i) => (isObj(x)
      ? el('div', { class: 'xd-item xd-row' }, grid(x, ctx, depth + 1, `${i + 1}`))
      : el('div', { class: 'xd-item xd-row' }, block(key, x, ctx, depth + 1) || el('span', { class: 'xd-nil', text: '—' })))));
  }
  if (isObj(v) && !isPath(v) && typeof v.$more !== 'number') return grid(v, ctx, depth);
  return leaf(key, v, ctx);
}

/** An object: key / value rows; nested values fold. */
function grid(obj, ctx, depth, label = null) {
  const box = el('div', { class: 'xd-grid' });
  if (label) box.append(el('div', { class: 'xd-index', text: label }));
  for (const [k, v] of Object.entries(obj)) {
    if (empty(v) || (depth === 0 && HEAD_KEYS.includes(k) && scalar(v))) continue;
    const nested = !scalar(v) && !(isObj(v) && typeof v.$more === 'number');
    if (!nested) { box.append(el('div', { class: 'xd-kv xd-row' }, el('span', { class: 'xd-k', text: human(k) }), el('span', { class: 'xd-v' }, leaf(k, v, ctx)))); continue; }
    const inner = block(k, v, ctx, depth + 1);
    if (!inner) continue;
    const size = Array.isArray(v) ? `${v.length}` : `${Object.keys(v).length}`;
    const fold = el('details', { class: 'xd-fold xd-row', open: depth < 1 || undefined },
      el('summary', {}, el('span', { class: 'xd-k', text: human(k) }), el('small', { text: Array.isArray(v) ? `${size} items` : `${size} fields` })), inner);
    fold.addEventListener('toggle', () => ctx.touch?.(fold));
    box.append(fold);
  }
  return box;
}

/** { node } for a data result. */
export function dataView(value, ctx) {
  const pills = [];
  if (isObj(value)) {
    for (const k of HEAD_KEYS) {
      const v = value[k];
      if (empty(v) || !scalar(v) || isPath(v)) continue;
      const bad = k === 'error' || v === false || /fail|error|denied|blocked|timeout/i.test(String(v));
      const good = v === true || /^(ok|done|success|allowed|completed|sent|saved)$/i.test(String(v));
      pills.push(el('span', { class: `xd-pill ${bad ? 'bad' : good ? 'good' : ''}`, title: human(k), text: k === 'ok' ? (v ? 'ok' : 'failed') : String(v) }));
    }
  }
  const body = block('', value, ctx, 0) || el('span', { class: 'xd-nil', text: 'nothing returned' });
  return el('div', { class: 'xd' }, pills.length ? el('div', { class: 'xd-pills' }, ...pills) : null, body);
}
