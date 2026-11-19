// Small helpers: DOM building, time formatting, safe markdown, clipboard and sharing.

import { personaOf } from './core/personas.js';

/** Who someone is, for labels: { key, name, color (a CSS value), initial, ... } (see core/personas.js). */
export const persona = (key) => { const p = personaOf(key); return { ...p, color: p.css }; };

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') applyStyle(node, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

// Inline style attributes are blocked by our CSP; the CSS object model is allowed.
function applyStyle(node, text) {
  for (const decl of String(text).split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) node.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtFull = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function dayKey(iso) { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function dayLabel(iso) {
  const d = new Date(iso); const today = new Date(); const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(yest.toISOString())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
export function duration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${pad(Math.floor((seconds % 3600) / 60))}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
  return `${seconds}s`;
}
export const ago = (iso) => duration((Date.now() - new Date(iso).getTime()) / 1000) + ' ago';
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// ---- markdown (builds DOM nodes; never touches innerHTML) -------------------------------------

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length) {
      const nl = part.indexOf('\n');
      const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
      frag.append(codeBlock(code, lang));
    } else if (part.trim()) {
      for (const block of part.split(/\n{2,}/)) if (block.trim()) frag.append(blockNode(block));
    }
  });
  return frag;
}

function codeBlock(code, lang) {
  const copy = el('button', { class: 'mini', type: 'button', text: 'Copy', onclick: async (e) => { e.target.textContent = (await copyText(code)) ? 'Copied' : 'Failed'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); } });
  return el('div', { class: 'code' }, el('div', { class: 'code-bar' }, el('span', { text: lang || 'code' }), copy), el('pre', {}, el('code', { text: code })));
}

function blockNode(block) {
  const lines = block.split('\n');
  if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return el('ul', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*[-*•]\s+/, '')))));
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return el('ol', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*\d+[.)]\s+/, '')))));
  const p = el('p');
  lines.forEach((line, i) => { if (i) p.append(document.createElement('br')); p.append(inline(line)); });
  return p;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>)\]]+)/g;
function inline(text) {
  const frag = document.createDocumentFragment();
  let last = 0; let m;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) frag.append(el('code', { text: tok.slice(1, -1) }));
    else if (m[2]) frag.append(el('strong', { text: tok.slice(2, -2) }));
    else if (m[3]) { const [, label, url] = tok.match(/^\[([^\]]+)\]\((.+)\)$/); frag.append(link(url, label)); }
    else frag.append(link(tok, tok));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
const link = (url, label) => el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: label });

// ---- clipboard and sharing --------------------------------------------------------------------

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const area = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
  area.value = text; document.body.append(area); area.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove(); return ok;
}

export async function shareText(title, text) {
  if (!navigator.share) return false;
  try { await navigator.share({ title, text }); return true; } catch { return false; }
}

export async function shareFile(url, name, mime) {
  if (!navigator.share) return false;
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], name, { type: mime || blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
    await navigator.share({ title: name, text: name });
    return true;
  } catch { return false; }
}
