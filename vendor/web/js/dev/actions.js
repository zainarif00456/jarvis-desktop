// The action log pane: what the agents and the owner did in this project (commands run, files changed,
// checkpoints, layout changes), newest first. The server keeps it append-only (devmode/actionlog.py).
import { el } from '../util.js';
import { WHO, getJson } from './api.js';

const FILTERS = [['all', 'All'], ['run', 'Commands'], ['edit', 'Edits'], ['checkpoint', 'Checkpoints']];

export class ActionsPane {
  constructor() {
    this.filter = 'all'; this.timer = 0; this.shown = false;
    this.sum = el('span', { class: 'dv-meta' });
    this.chips = el('span', { class: 'dv-filters' }, ...FILTERS.map(([key, label]) => el('button', { type: 'button', class: `dv-fchip${key === 'all' ? ' on' : ''}`, dataset: { f: key }, text: label, onclick: () => this.setFilter(key) })));
    this.list = el('div', { class: 'dv-feed dv-actlist' }, el('p', { class: 'dv-empty', text: 'Nothing has happened yet in this project.' }));
    this.el = el('div', { class: 'dv-actionspane' }, el('div', { class: 'dv-bar' }, el('b', { text: 'Actions' }), this.sum, this.chips), this.list);
  }

  setFilter(key) {
    this.filter = key;
    for (const b of this.chips.children) b.classList.toggle('on', b.dataset.f === key);
    this.load();
  }

  /** Something happened: reload soon (many events arrive together). */
  touch() { clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 500); }

  async load() {
    let data;
    try { data = await getJson('actions', { count: 120 }); } catch (err) { this.list.replaceChildren(el('p', { class: 'dv-empty', text: err.message })); return; }
    const s = data.summary;
    this.sum.textContent = `${s.total} actions`;
    const rows = [...data.actions].reverse().filter((a) => this.filter === 'all' || a.kind === this.filter);
    if (!rows.length) { this.list.replaceChildren(el('p', { class: 'dv-empty', text: 'No actions of this kind yet.' })); return; }
    this.list.replaceChildren(...rows.map((a) => el('div', { class: `dv-ev k-${a.kind}` },
      el('span', { class: 'who', text: a.actor, style: `color:${WHO[a.actor] || 'var(--ai)'}` }),
      el('span', { class: 'ic', text: new Date(a.at * 1000).toLocaleTimeString() }),
      el('span', { class: 'tx', text: `${a.kind}: ${a.summary}` }))));
  }
}
