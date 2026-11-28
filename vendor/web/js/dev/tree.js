// The file tree: folders open lazily (big repos stay quick), changed files carry a marker.
import { el } from '../util.js';
import { getJson } from './api.js';

const MARK = { M: 'edited', A: 'new', D: 'removed', '?': 'new' };

export class TreePane {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.open = new Set(['']);
    this.cache = new Map();
    this.active = '';
    this.body = el('div', { class: 'dv-tree', role: 'tree', 'aria-label': 'Project files' });
    this.el = this.body;
  }

  async load() {
    this.cache.clear();
    await this.fetch('');
    for (const path of [...this.open].filter(Boolean)) await this.fetch(path).catch(() => this.open.delete(path));
    this.draw();
  }

  async fetch(path) {
    const data = await getJson('tree', { path });
    this.cache.set(path, data.entries);
    return data;
  }

  /** Files changed on disk: reload the folders that are showing (cheap: one level each). */
  async refresh() {
    try { await this.load(); } catch { /* the pane shows what it had */ }
  }

  draw() {
    const root = el('ul', { class: 'dv-ul' });
    this.append(root, '');
    this.body.replaceChildren(root);
  }

  append(list, path) {
    for (const entry of this.cache.get(path) || []) {
      const opened = entry.dir && this.open.has(entry.path);
      const row = el('div', { class: `dv-row${entry.path === this.active ? ' active' : ''}${entry.git ? ` ch-${entry.git === '?' ? 'A' : entry.git}` : ''}`, role: 'treeitem', tabindex: '0', 'aria-expanded': entry.dir ? String(opened) : null, title: entry.path },
        el('span', { class: 'dv-caret', text: entry.dir ? (opened ? '▾' : '▸') : '' }),
        el('span', { class: 'dv-name', text: entry.name }),
        entry.git ? el('i', { class: 'dv-mark', text: entry.git === '?' ? 'N' : entry.git, title: MARK[entry.git] || '' }) : null);
      const go = () => { if (entry.dir) this.toggle(entry.path); else this.onOpen(entry.path, 0); };
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      const item = el('li', {}, row);
      if (opened && this.cache.has(entry.path)) { const sub = el('ul', { class: 'dv-ul' }); this.append(sub, entry.path); item.append(sub); }
      list.append(item);
    }
  }

  async toggle(path) {
    if (this.open.has(path)) this.open.delete(path);
    else { this.open.add(path); if (!this.cache.has(path)) await this.fetch(path).catch(() => this.open.delete(path)); }
    this.draw();
  }

  /** Mark the open file and make sure its folders are open (so it can be seen in the tree). */
  async reveal(path) {
    this.active = path;
    const parts = path.split('/'); let at = '';
    for (const part of parts.slice(0, -1)) {
      at = at ? `${at}/${part}` : part;
      this.open.add(at);
      if (!this.cache.has(at)) await this.fetch(at).catch(() => {});
    }
    this.draw();
    this.body.querySelector('.dv-row.active')?.scrollIntoView({ block: 'nearest' });
  }
}
