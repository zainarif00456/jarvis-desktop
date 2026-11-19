// What a live work card shows, by result type (server: jarvis/activity/describe.py).
//
//   terminal  a terminal: prompt, the command typed out, output streaming in, exit code
//             (+ the files/folders an `ls`/`find` printed, as icons)
//   entries   files and folders as icons (pictures as their own thumbnails)
//   lines     a file being read, with line numbers
//   write     text being written
//   diff      an edit: removed lines out, added lines in
//   hits      search results
//   media     an image / document being looked at (scan line)
//   web, text plain text
//
// Every item that is a file or folder carries a handle (`h`): clicking it asks the server to act on
// that handle (open on the laptop, browse, ...), never on a path the page makes up.
// Text is revealed progressively (typed), within a fixed time budget, and never in the lite tier.

import { el, fmtBytes } from '../util.js';
import { dataView } from './data.js';
import { webResults, profileCard } from './web.js';

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  dir: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5a1.2 1.2 0 1 0 0-.01',
  video: 'M4 6h12v12H4zM16 10l4-2.5v9L16 14',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15h6M9 18h4',
  code: 'M6 3h8l4 4v14H6zM14 3v4h4M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5',
  archive: 'M5 4h14v4H5zM6 8h12v12H6zM10 12h4',
  link: 'M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1',
};
export const KIND_ICON = {
  shell: 'M4 6l5 5-5 5M11 17h9', read: ICONS.doc, write: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  list: ICONS.dir, search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM20 20l-4.8-4.8', fetch: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18',
  analyze: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', agent: 'M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z',
};
const MAX_TILES = 48;
const TYPE_MS = 900;   // the longest any text takes to type out

export function icon(d, cls = 'xi') {
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path); return svg;
}
export const fileIcon = (kind) => icon(ICONS[kind] || ICONS.file, `xi k-${kind || 'file'}`);
const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const home = (path) => String(path || '').replace(/^\/home\/[^/]+/, '~');

/** Types text into a node within TYPE_MS (whole at once in the lite tier). Returns a promise. */
export function typeOut(node, text, ms = TYPE_MS) {
  text = String(text || '');
  // big text appears at once (the card fades it in): retyping thousands of characters every frame
  // costs layout work and reads as flicker, not life
  if (calm() || text.length < 24 || text.length > 1200) { node.textContent = text; return Promise.resolve(); }
  return new Promise((resolve) => {
    const start = performance.now(); const total = Math.min(ms, 240 + text.length * 2);
    const step = (now) => {
      if (!node.isConnected) { resolve(); return; }
      const k = Math.min(1, (now - start) / total);
      node.textContent = text.slice(0, Math.ceil(text.length * k));
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** A file or folder the owner can act on: click = open on the laptop, ⋯ / long-press = menu. */
function itemButton(item, ctx, children, cls) {
  const node = el('button', { type: 'button', class: cls, title: `${home(item.path)} — click: open on the laptop · right-click: more`, dataset: { h: item.h || '' } }, ...children);
  if (!item.h) { node.disabled = true; return node; }
  node.addEventListener('click', (e) => { e.stopPropagation(); ctx.act(item.h, 'open', node); });
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); ctx.menu(item, e.clientX, e.clientY, node); });
  let press = 0;   // long-press on touch screens opens the same menu
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    press = setTimeout(() => { press = -1; navigator.vibrate?.(12); ctx.menu(item, e.clientX, e.clientY, node); }, 480);
  });
  const cancel = () => { if (press > 0) clearTimeout(press); };
  node.addEventListener('pointerup', (e) => { if (press === -1) { e.preventDefault(); press = 0; } cancel(); });
  node.addEventListener('pointerleave', cancel); node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', (e) => { if (press === -1) { e.stopImmediatePropagation(); press = 0; } }, true);
  return node;
}

function pathLine(result, ctx, label) {
  const item = { path: result.path, h: result.h, kind: result.kind || 'file', name: result.path };
  return el('div', { class: 'xr-path' }, el('span', { class: 'xr-tag', text: label }),
    itemButton(item, ctx, [el('span', { text: home(result.path) })], 'xr-plink'));
}

// ------------------------------------------------------------------------------- renderers

function terminal(r, ctx) {
  const cmd = el('span', { class: 'xt-cmd' });
  const out = el('pre', { class: 'xt-out' });
  const err = el('pre', { class: 'xt-err' });
  const code = r.exit === null || r.exit === undefined ? (r.note ? r.note.replace('_', ' ') : '') : `exit ${r.exit}`;
  const badge = el('span', { class: `xt-exit ${r.exit === 0 ? 'ok' : r.exit === null || r.exit === undefined ? '' : 'bad'}`, text: code });
  const node = el('div', { class: 'xr-term' },
    el('div', { class: 'xt-line' }, el('span', { class: 'xt-ps', text: `${home(r.cwd) || '~'} $` }), cmd, el('i', { class: 'xt-caret' })),
    out, err, el('div', { class: 'xt-foot' }, badge));
  const data = r.data !== undefined ? dataResult({ data: r.data }, ctx) : null;
  if (data) {   // JSON on stdout: drawn as data; the raw text stays one click away
    const raw = el('button', { type: 'button', class: 'xd-more xt-raw', text: 'raw output' });
    raw.addEventListener('click', (e) => { e.stopPropagation(); out.hidden = !out.hidden; raw.textContent = out.hidden ? 'raw output' : 'hide raw'; ctx.touch?.(raw); });
    node.append(data.node, raw);
  }
  const entries = r.entries?.type === 'tree' ? treeView(r.entries, ctx, true)
    : r.entries && r.entries.items?.length ? entriesView(r.entries, ctx, true) : null;
  if (entries) node.append(entries.node);
  const play = async () => {
    await typeOut(cmd, r.command, 420);
    node.classList.add('ran');
    if (entries) { out.hidden = true; await entries.play(); } else if (data) { out.hidden = true; out.textContent = r.stdout || ''; await data.play(); } else await typeOut(out, (r.stdout || '').replace(/\n+$/, ''));
    if (r.stderr) await typeOut(err, r.stderr.replace(/\n+$/, ''), 400); else err.hidden = true;
  };
  return { node, play, size: (r.stdout || '').length };
}

function entriesView(r, ctx, inTerminal = false) {
  const items = r.items || [];
  const grid = el('div', { class: 'xr-grid' });
  const shown = items.slice(0, MAX_TILES);
  for (const item of shown) {
    const thumb = item.kind === 'image' && item.h ? el('img', { class: 'xr-thumb', alt: '', loading: 'lazy', decoding: 'async', src: `/api/exec/thumb/${item.h}` }) : null;
    if (thumb) thumb.addEventListener('error', () => thumb.replaceWith(fileIcon('image')), { once: true });
    const tile = itemButton(item, ctx, [thumb || fileIcon(item.kind), el('span', { class: 'xr-name', text: item.name }),
      item.size != null && item.kind !== 'dir' ? el('small', { text: fmtBytes(item.size) }) : null], `xr-tile k-${item.kind}`);
    const wrap = el('div', { class: 'xr-cell' }, tile);
    if (item.kind === 'dir' && item.h) {   // look inside, right here: a new card linked to this one
      wrap.append(el('button', { type: 'button', class: 'xr-dive', title: 'Browse it here', 'aria-label': `Browse ${item.name}`,
        onclick: (e) => { e.stopPropagation(); ctx.act(item.h, 'browse', tile); } }, icon('M9 6l6 6-6 6')));
    }
    grid.append(wrap);
  }
  const rest = (items.length - shown.length) + (r.more || 0);
  if (rest > 0) {
    grid.append(r.base_h
      ? el('button', { type: 'button', class: 'xr-more', text: `+${rest} more`, onclick: (e) => { e.stopPropagation(); ctx.act(r.base_h, 'open', e.currentTarget); } })
      : el('span', { class: 'xr-more', text: `+${rest} more` }));
  }
  const head = !inTerminal && r.base ? el('div', { class: 'xr-path' }, el('span', { class: 'xr-tag', text: `${items.length + (r.more || 0)} items` }),
    itemButton({ path: r.base, h: r.base_h, kind: 'dir' }, ctx, [el('span', { text: home(r.base) })], 'xr-plink')) : null;
  const node = el('div', { class: 'xr-entries' }, head, grid);
  const play = () => new Promise((resolve) => {
    const cells = [...grid.children];
    if (calm()) { resolve(); return; }
    cells.forEach((c, i) => { c.classList.add('xr-wait'); setTimeout(() => { c.classList.remove('xr-wait'); c.classList.add('xr-pop'); }, Math.min(900, 40 + i * 28)); });
    setTimeout(resolve, Math.min(950, 60 + cells.length * 28));
  });
  return { node, play, size: items.length * 40 };
}

// A folder tree, like a file explorer: folders first, nested, open/close with the chevron; a folder
// deeper than what was read opens as a new linked card. Pictures show as small thumbnails.
function treeView(r, ctx, inTerminal = false) {
  const rows = [];
  const branch = (nodes, more, level) => {
    const list = el('ul', { class: 'xt-tree', role: level ? 'group' : 'tree' });
    for (const n of nodes || []) {
      const dir = n.kind === 'dir';
      const kids = Array.isArray(n.children);
      const thumb = n.kind === 'image' && n.h ? el('img', { class: 'xt-thumb', alt: '', loading: 'lazy', decoding: 'async', src: `/api/exec/thumb/${n.h}` }) : null;
      if (thumb) thumb.addEventListener('error', () => thumb.replaceWith(fileIcon('image')), { once: true });
      const name = itemButton(n, ctx, [thumb || fileIcon(n.kind), el('span', { class: 'xt-name', text: n.name }),
        n.size != null && !dir ? el('small', { text: fmtBytes(n.size) }) : null,
        dir && kids ? el('small', { text: `${n.children.length + (n.more || 0)}` }) : null], `xt-node k-${n.kind}`);
      const toggle = dir ? el('button', { type: 'button', class: 'xt-tog', 'aria-label': `Open ${n.name}`, 'aria-expanded': kids && level === 0 ? 'true' : 'false' }, icon('M9 6l6 6-6 6')) : el('i', { class: 'xt-tog-sp' });
      const item = el('li', { role: 'treeitem' }, el('div', { class: 'xt-row' }, toggle, name));
      if (dir && kids && n.children.length) {
        const sub = branch(n.children, n.more, level + 1);
        sub.hidden = level > 0;   // the top level's folders open; deeper ones on a click
        item.append(sub);
        toggle.addEventListener('click', (e) => { e.stopPropagation(); sub.hidden = !sub.hidden; toggle.setAttribute('aria-expanded', String(!sub.hidden)); ctx.touch?.(toggle); });
      } else if (dir && n.h) {   // not read yet: look inside on a linked card
        toggle.addEventListener('click', (e) => { e.stopPropagation(); ctx.act(n.h, 'browse', name); });
      }
      rows.push(item);
      list.append(item);
    }
    if (more) list.append(el('li', { class: 'xt-more', text: `+${more} more` }));
    return list;
  };
  const root = branch(r.nodes, r.more, 0);
  const head = el('div', { class: 'xr-path' }, el('span', { class: 'xr-tag', text: `${r.dirs} folders · ${r.files} files` }),
    inTerminal ? null : itemButton({ path: r.base, h: r.base_h, kind: 'dir' }, ctx, [el('span', { text: home(r.base) })], 'xr-plink'));
  const node = el('div', { class: 'xr-treebox' }, head, root, r.truncated ? el('small', { class: 'xr-note', text: 'large folder: showing the first part' }) : null);
  const play = () => new Promise((resolve) => {
    const shown = rows.filter((row) => !row.closest('[hidden]'));
    if (calm()) { resolve(); return; }
    shown.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(900, 30 + i * 18)); });
    setTimeout(resolve, Math.min(950, 60 + shown.length * 18));
  });
  return { node, play, size: rows.length * 50 };
}

function lines(r, ctx) {
  const code = el('pre', { class: 'xr-code' });
  const start = r.start || 1;
  const text = r.text || '';
  const rows = text.split('\n');
  const gutter = el('pre', { class: 'xr-gutter', 'aria-hidden': 'true', text: rows.map((_, i) => start + i).join('\n') });
  const node = el('div', { class: 'xr-file' }, pathLine(r, ctx, 'read'), el('div', { class: 'xr-codebox' }, gutter, code), r.more ? el('small', { class: 'xr-note', text: 'more below…' }) : null);
  return { node, play: () => typeOut(code, text), size: text.length };
}

function write(r, ctx) {
  const code = el('pre', { class: 'xr-code xr-writing' });
  const node = el('div', { class: 'xr-file' }, pathLine(r, ctx, 'write'), el('div', { class: 'xr-codebox' }, code));
  return { node, play: async () => { await typeOut(code, r.text, 1200); code.classList.remove('xr-writing'); }, size: (r.text || '').length };
}

function diff(r, ctx) {
  const box = el('div', { class: 'xr-diff' });
  for (const hunk of r.hunks || []) {
    const h = el('div', { class: 'xd-hunk' });
    for (const line of hunk.del || []) h.append(el('div', { class: 'xd-del', text: line || ' ' }));
    for (const line of hunk.add || []) h.append(el('div', { class: 'xd-add', text: line || ' ' }));
    box.append(h);
  }
  const files = (r.files || []).length > 1 ? el('small', { class: 'xr-note', text: `${r.files.length} files changed` }) : null;
  const node = el('div', { class: 'xr-file' }, pathLine(r, ctx, 'edit'), box, files);
  const play = () => new Promise((resolve) => {
    if (calm()) { resolve(); return; }
    const rows = [...box.querySelectorAll('.xd-del, .xd-add')];
    rows.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(800, i * 22)); });
    setTimeout(resolve, Math.min(850, rows.length * 22 + 60));
  });
  return { node, play, size: box.textContent.length };
}

function hits(r, ctx) {
  const list = el('div', { class: 'xr-hits' });
  for (const hit of (r.items || []).slice(0, 40)) {
    list.append(itemButton({ ...hit, kind: 'file' }, ctx, [
      el('span', { class: 'xh-path', text: home(hit.path) + (hit.line ? `:${hit.line}` : '') }),
      hit.text ? el('span', { class: 'xh-text', text: hit.text }) : null,
    ], 'xr-hit'));
  }
  const more = (r.items || []).length > 40 || r.more ? el('small', { class: 'xr-note', text: 'more matches…' }) : null;
  const node = el('div', { class: 'xr-entries' }, list, more);
  return { node, play: () => entriesPop(list), size: (r.items || []).length * 60 };
}

function entriesPop(list) {
  if (calm()) return Promise.resolve();
  const rows = [...list.children];
  rows.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(700, i * 30)); });
  return new Promise((resolve) => setTimeout(resolve, Math.min(750, rows.length * 30 + 60)));
}

function media(r, ctx) {
  const pic = r.h ? el('img', { class: 'xr-media-img', alt: r.name || '', decoding: 'async', src: `/api/exec/thumb/${r.h}` }) : fileIcon('doc');
  if (pic.tagName === 'IMG') pic.addEventListener('error', () => pic.replaceWith(fileIcon('doc')), { once: true });
  const frame = itemButton({ path: r.path, h: r.h, kind: 'image', name: r.name }, ctx, [pic, el('i', { class: 'xr-scan', 'aria-hidden': 'true' }),
    el('i', { class: 'xr-box b1' }), el('i', { class: 'xr-box b2' })], 'xr-media');
  const node = el('div', { class: 'xr-file' }, pathLine(r, ctx, 'look'), frame, r.note ? el('small', { class: 'xr-note', text: r.note }) : null);
  return { node, play: () => new Promise((resolve) => setTimeout(resolve, calm() ? 0 : 1300)), size: 400 };
}

function text(r) {
  const pre = el('pre', { class: 'xr-text' });
  const head = r.url ? el('div', { class: 'xr-path' }, el('span', { class: 'xr-tag', text: 'web' }), el('span', { class: 'xr-url', text: r.url })) : null;
  return { node: el('div', {}, head, pre), play: () => typeOut(pre, r.text), size: (r.text || '').length };
}

function dataResult(r, ctx) {
  const local = { ...ctx, pathButton: (v) => itemButton({ path: v.$path, h: v.h, kind: v.kind, name: v.$path }, ctx, [fileIcon(v.kind), el('span', { text: home(v.$path) })], 'xd-path') };
  const node = dataView(r.data, local);
  const play = () => new Promise((resolve) => {
    if (calm()) { resolve(); return; }
    const rows = [...node.querySelectorAll('.xd-row')].filter((row) => !row.closest('details:not([open])')).slice(0, 60);
    rows.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(700, 20 + i * 16)); });
    setTimeout(resolve, Math.min(760, 60 + rows.length * 16));
  });
  return { node, play, size: Math.min(6000, JSON.stringify(r.data).length) };
}

const RENDERERS = { terminal, entries: (r, ctx) => entriesView(r, ctx), tree: (r, ctx) => treeView(r, ctx), data: dataResult, web_results: webResults, profile: profileCard, lines, write, diff, hits, media, web: text, text };

/** { node, play(): Promise, size } for a result. */
export function render(result, ctx) {
  const fn = RENDERERS[result?.type] || text;
  try { return fn(result || {}, ctx); } catch (err) { console.error(err); return text({ text: String(result?.text || '') }); }
}
