// Web search results on a live work card (server: jarvis/web/search.py, tool web.search; an agent's
// own web search is shown the same way). A wide card:
//
//   profile box   the person / thing the engines know (picture, summary, facts, links)
//   pictures      a strip of large thumbnails; a tap opens them big (lightbox, swipe / arrows)
//   results       one card each: site badge, date, title, snippet, thumbnail when the page has one
//
// Every picture comes through the server by handle (/api/web/img/{h}: the page never loads a third
// party URL itself). A tap on a result opens the page on THIS device (a new tab); right-click /
// long-press: open it on the laptop, copy the link.

import { el, copyText } from '../util.js';
import { isCompact } from '../holowin.js';
import { icon } from './render.js';

const img = (h) => `/api/web/img/${h}`;
const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const openHere = (url) => window.open(url, '_blank', 'noopener,noreferrer');

function hue(text) { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function badge(site) {
  const b = el('span', { class: 'xw-badge', text: (site || '?').replace(/^www\./, '')[0]?.toUpperCase() || '?' });
  b.style.setProperty('--h', String(hue(site)));
  return b;
}
function when(iso) {
  if (!iso) return null;
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null;
  const days = (Date.now() - d.getTime()) / 86400000;
  return days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? `${Math.round(days)} days ago` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A picture that fades in when it arrives and quietly leaves if the site refuses it. */
function picture(h, cls, alt = '') {
  const node = el('img', { class: cls, alt, loading: 'lazy', decoding: 'async', src: img(h) });
  node.addEventListener('load', () => node.classList.add('in'), { once: true });
  node.addEventListener('error', () => { const box = node.closest('[data-pic]'); if (box) box.classList.add('gone'); else node.remove(); }, { once: true });
  return node;
}

class LinkMenu {
  constructor() {
    this.node = el('div', { class: 'xm', role: 'menu', hidden: true });
    document.body.append(this.node);
    addEventListener('pointerdown', (e) => { if (!this.node.hidden && !this.node.contains(e.target)) this.close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }
  open(link, x, y, ctx, from) {
    const go = (fn) => () => { this.close(); fn(); };
    this.node.replaceChildren(
      el('div', { class: 'xm-head' }, icon('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18'), el('span', { text: link.url.replace(/^https?:\/\//, '') })),
      el('button', { type: 'button', class: 'xm-row', text: 'Open it here', onclick: go(() => openHere(link.url)) }),
      link.h ? el('button', { type: 'button', class: 'xm-row', text: 'Open it on the laptop', onclick: go(() => ctx.act(link.h, 'open', from)) }) : null,
      el('button', { type: 'button', class: 'xm-row', text: 'Copy the link', onclick: go(() => copyText(link.url)) }),
    );
    this.node.hidden = false;
    this.node.classList.toggle('sheet', isCompact());
    if (!isCompact()) {
      const r = this.node.getBoundingClientRect();
      this.node.style.setProperty('--x', `${Math.round(Math.min(x, innerWidth - r.width - 8))}px`);
      this.node.style.setProperty('--y', `${Math.round(Math.min(y, innerHeight - r.height - 8))}px`);
    }
  }
  close() { this.node.hidden = true; }
}
let menu = null;

/** Click = open here; right-click / long-press = the link menu. */
function linkable(node, link, ctx) {
  node.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); ctx.touch?.(node); openHere(link.url); });
  const show = (x, y) => { menu = menu || new LinkMenu(); menu.open(link, x, y, ctx, node); };
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); show(e.clientX, e.clientY); });
  let press = 0;
  node.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') press = setTimeout(() => { press = -1; navigator.vibrate?.(12); show(e.clientX, e.clientY); }, 480); });
  const cancel = () => { if (press > 0) clearTimeout(press); };
  node.addEventListener('pointerup', cancel); node.addEventListener('pointerleave', cancel); node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', (e) => { if (press === -1) { e.stopImmediatePropagation(); e.preventDefault(); press = 0; } }, true);
  return node;
}

// ------------------------------------------------------------------------------- lightbox

class Lightbox {
  constructor() {
    this.pic = el('img', { class: 'xw-lb-img', alt: '' });
    this.caption = el('div', { class: 'xw-lb-cap' });
    this.prevBtn = el('button', { type: 'button', class: 'xw-lb-nav prev', 'aria-label': 'Previous picture', onclick: (e) => { e.stopPropagation(); this.step(-1); } }, icon('M15 6l-6 6 6 6'));
    this.nextBtn = el('button', { type: 'button', class: 'xw-lb-nav next', 'aria-label': 'Next picture', onclick: (e) => { e.stopPropagation(); this.step(1); } }, icon('M9 6l6 6-6 6'));
    this.actions = el('div', { class: 'xw-lb-act' });
    this.node = el('div', { class: 'xw-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Picture', hidden: true },
      el('div', { class: 'xw-lb-stage' }, this.pic, this.prevBtn, this.nextBtn), this.caption, this.actions);
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.close(); });
    addEventListener('keydown', (e) => {
      if (this.node.hidden) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); } else if (e.key === 'ArrowLeft') this.step(-1); else if (e.key === 'ArrowRight') this.step(1);
    }, true);
    let x0 = null;
    this.node.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
    this.node.addEventListener('pointerup', (e) => { if (x0 !== null && Math.abs(e.clientX - x0) > 50) this.step(e.clientX < x0 ? 1 : -1); x0 = null; });
    document.body.append(this.node);
  }
  open(list, index, ctx) { this.list = list; this.ctx = ctx; this.index = index; this.node.hidden = false; this.show(true); }
  step(d) { if (!this.list) return; this.index = (this.index + d + this.list.length) % this.list.length; this.show(false); }
  show(first) {
    const p = this.list[this.index];
    const token = (this.token || 0) + 1; this.token = token;
    // the thumbnail is already here (instant), the full picture replaces it when it has arrived
    this.pic.classList.remove('in', 'sharp');
    this.pic.onload = () => this.pic.classList.add('in');
    this.pic.onerror = null;
    this.pic.src = img(p.th || p.ih);
    if (!p.ih || p.ih === p.th) this.pic.classList.add('sharp');
    else {
      const full = new Image();
      full.decoding = 'async';
      full.onload = () => { if (this.token === token) { this.pic.src = full.src; this.pic.classList.add('in', 'sharp'); } };
      full.onerror = () => { if (this.token === token) this.pic.classList.add('sharp'); };   // the site refused: the thumbnail stays, clear
      full.src = img(p.ih);
    }
    this.pic.alt = p.title || '';
    this.caption.replaceChildren(el('b', { text: p.title || p.site }), el('span', { text: [p.site, p.size].filter(Boolean).join(' · ') }), el('small', { text: `${this.index + 1} / ${this.list.length}` }));
    this.actions.replaceChildren(
      el('button', { type: 'button', class: 'xw-lb-btn', text: 'Open the page here', onclick: () => openHere(p.page) }),
      p.h ? el('button', { type: 'button', class: 'xw-lb-btn', text: 'Open on the laptop', onclick: () => this.ctx.act(p.h, 'open', null) }) : null,
      el('button', { type: 'button', class: 'xw-lb-btn ghost', text: 'Close', onclick: () => this.close() }),
    );
    const many = this.list.length > 1; this.prevBtn.hidden = !many; this.nextBtn.hidden = !many;
    if (first && !calm()) this.node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }
  close() {
    const done = () => { this.node.hidden = true; this.pic.removeAttribute('src'); };
    if (calm()) { done(); return; }
    this.node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-in' }).finished.then(done, done);
  }
}
let lightbox = null;

// ------------------------------------------------------------------------------- the card

function pictureStrip(pics, ctx, rows) {
  const strip = el('div', { class: 'xw-pics' });
  pics.forEach((p, i) => {
    const tile = el('button', { type: 'button', class: 'xw-pic', title: [p.title, p.site].filter(Boolean).join(' · '), dataset: { pic: '1' }, 'aria-label': p.title || 'Picture' },
      picture(p.th, 'xw-pic-img', p.title), el('span', { class: 'xw-pic-site', text: p.site }));
    tile.addEventListener('click', (e) => { e.stopPropagation(); ctx.touch?.(tile); lightbox = lightbox || new Lightbox(); lightbox.open(pics, i, ctx); });
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); menu = menu || new LinkMenu(); menu.open({ url: p.page, h: p.h }, e.clientX, e.clientY, ctx, tile); });
    rows.push(tile); strip.append(tile);
  });
  return strip;
}

function resultList(results, ctx, rows, compact = false) {
  const list = el('div', { class: `xw-list${compact ? ' compact' : ''}` });
  for (const hit of results) {
    const date = when(hit.published);
    const card = linkable(el('a', { class: 'xw-hit', href: hit.url, rel: 'noopener noreferrer' },
      el('div', { class: 'xw-hbody' },
        el('div', { class: 'xw-hsite' }, badge(hit.site), el('span', { text: hit.site }), date ? el('small', { text: date }) : null),
        el('b', { class: 'xw-htitle', text: hit.title }),
        hit.snippet ? el('p', { class: 'xw-hsnip', text: hit.snippet }) : null),
      hit.th && !compact ? el('div', { class: 'xw-hthumb', dataset: { pic: '1' } }, picture(hit.th, 'xw-hthumb-img')) : null), hit, ctx);
    rows.push(card); list.append(card);
  }
  return list;
}

const section = (label, ...kids) => el('section', { class: 'xp-sec' }, el('h4', { class: 'xp-h', text: label }), ...kids);

/** A quick profile (profile.lookup): who they are, what we already know, where to find them. */
export function profileCard(r, ctx) {
  const rows = [];
  const pics = (r.images || []).filter((p) => p.th);
  const face = el('div', { class: `bk-face ds-face xp-face ${r.kind}`, dataset: { pic: '1' } },
    r.photo_h ? picture(r.photo_h, 'xp-face-img', r.name) : el('b', { text: (r.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() }),
    el('i', { class: 'r1' }), el('i', { class: 'r2' }), el('i', { class: 'r3' }), el('i', { class: 'lock', text: r.kind === 'company' ? 'ORG LOCK' : 'ID LOCK' }));
  const links = (r.links || []).map((l) => linkable(el('a', { class: 'ds-link', href: l.url, text: l.label }), l, ctx));
  const hero = el('div', { class: 'xp-hero' }, face, el('div', { class: 'xp-id' },
    el('div', { class: 'ds-top' }, el('span', { class: 'ds-no', text: r.kind === 'company' ? 'ORGANISATION' : 'PERSON' }), r.ambiguous ? el('span', { class: 'ds-conf', text: 'SEVERAL MATCHES' }) : null),
    el('h3', { class: 'xp-name', text: r.name }),
    r.headline ? el('div', { class: 'bk-role', text: r.headline }) : null,
    r.context ? el('div', { class: 'ds-loc', text: r.context }) : null,
    links.length ? el('div', { class: 'ds-links' }, ...links) : null));
  rows.push(hero);
  const parts = [hero];
  if (r.known?.length) {
    const known = section('ALREADY KNOWN TO US', ...r.known.map((k) => el('div', { class: 'xp-known' }, el('span', { class: 'xp-src', text: k.source }), el('p', { text: k.text }), k.when ? el('small', { text: k.when }) : null)));
    known.classList.add('xp-knownbox'); rows.push(known); parts.push(known);
  }
  if (r.summary) { const sum = el('p', { class: 'ds-sum xp-sum', text: r.summary }); rows.push(sum); parts.push(sum); }
  if (r.ambiguous && r.candidates?.length > 1) {
    const list = r.candidates.map((c, i) => linkable(el('a', { class: 'xp-cand', href: c.url },
      el('span', { class: 'ds-no', text: String(i + 1).padStart(2, '0') }), el('b', { text: c.name }), el('span', { text: c.headline || 'LinkedIn' })), c, ctx));
    const cands = section('WHICH ONE? SEVERAL MATCH', ...list); rows.push(cands); parts.push(cands);
  }
  if (pics.length) parts.push(section('PICTURES', pictureStrip(pics, ctx, rows)));
  if (r.results?.length) parts.push(section('ON THE WEB', resultList(r.results, ctx, rows, true)));
  if (r.news?.length) parts.push(section('IN THE NEWS', resultList(r.news, ctx, rows, true)));
  if (!r.results?.length && !pics.length && !r.known?.length) parts.push(el('p', { class: 'xd-nil', text: 'Nothing public found under that name. More context (company, city) helps.' }));
  const node = el('div', { class: 'xw xp' }, ...parts);
  const play = () => new Promise((resolve) => {
    if (calm()) { resolve(); return; }
    rows.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(1200, 60 + i * 50)); });
    setTimeout(resolve, Math.min(1250, 100 + rows.length * 50));
  });
  return { node, play, size: 8000 };
}

export function webResults(r, ctx) {
  const rows = [];
  const results = r.results || [];
  const pics = (r.images || []).filter((p) => p.th);
  const head = el('div', { class: 'xr-path' },
    el('span', { class: 'xr-tag', text: `${results.length} results${pics.length ? ` · ${pics.length} pictures` : ''}` }),
    el('span', { class: 'xw-q', text: r.query || '' }));
  const parts = [head];

  const box = r.infobox;
  if (box && (box.summary || box.ih)) {
    const profile = el('div', { class: 'xw-profile' },
      box.ih ? el('div', { class: 'xw-face', dataset: { pic: '1' } }, picture(box.ih, 'xw-face-img', box.title)) : null,
      el('div', { class: 'xw-pbody' },
        el('b', { class: 'xw-ptitle', text: box.title }),
        box.summary ? el('p', { class: 'xw-psum', text: box.summary }) : null,
        box.facts?.length ? el('dl', { class: 'xw-facts' }, ...box.facts.flatMap((f) => [el('dt', { text: f.label }), el('dd', { text: f.value })])) : null,
        box.links?.length ? el('div', { class: 'xw-plinks' }, ...box.links.map((l) => linkable(el('a', { class: 'xw-plink', href: l.url, text: l.title || l.url }), l, ctx))) : null));
    rows.push(profile); parts.push(profile);
  }

  if (pics.length) parts.push(pictureStrip(pics, ctx, rows));

  if (results.length) {
    parts.push(resultList(results, ctx, rows));
  } else if (!pics.length) {
    parts.push(el('p', { class: 'xd-nil', text: 'Nothing found.' }));
  }
  if (r.summary) { const sum = el('p', { class: 'xw-summary', text: r.summary }); rows.push(sum); parts.push(sum); }

  const node = el('div', { class: 'xw' }, ...parts);
  const play = () => new Promise((resolve) => {
    if (calm()) { resolve(); return; }
    rows.forEach((row, i) => { row.classList.add('xr-wait'); setTimeout(() => { row.classList.remove('xr-wait'); row.classList.add('xr-pop'); }, Math.min(1100, 40 + i * 45)); });
    setTimeout(resolve, Math.min(1150, 80 + rows.length * 45));
  });
  return { node, play, size: 6000 };   // a search stays a little longer than most cards
}
