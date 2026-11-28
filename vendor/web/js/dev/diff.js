// The diff pane: what changed, since the last commit or since any checkpoint, file by file.
import { el } from '../util.js';
import { getJson } from './api.js';

export class DiffPane {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.base = 'head'; this.files = []; this.current = '';
    this.baseSel = el('select', { class: 'dv-outline', 'aria-label': 'Compare with' });
    this.baseSel.addEventListener('change', () => { this.base = this.baseSel.value; this.load(); });
    this.list = el('div', { class: 'dv-dfiles' });
    this.view = el('div', { class: 'dv-dview' }, el('p', { class: 'dv-empty', text: 'No changes yet.' }));
    this.summary = el('span', { class: 'dv-meta' });
    this.el = el('div', { class: 'dv-diffpane' }, el('div', { class: 'dv-bar' }, el('b', { text: 'Changes' }), this.summary, this.baseSel), el('div', { class: 'dv-dsplit' }, this.list, this.view));
  }

  setCheckpoints(points) {
    const keep = this.base;
    this.baseSel.replaceChildren(el('option', { value: 'head', text: 'since the last commit' }), ...[...points].reverse().map((p) => el('option', { value: String(p.seq), text: `since #${p.seq} · ${p.label}` })));
    this.baseSel.value = [...this.baseSel.options].some((o) => o.value === keep) ? keep : 'head';
  }

  async load(select = '') {
    let data;
    try { data = await getJson('diff', { base: this.base }); } catch (err) { this.view.replaceChildren(el('p', { class: 'dv-empty', text: err.message })); return; }
    this.files = data.files;
    const added = this.files.reduce((a, f) => a + f.added, 0), removed = this.files.reduce((a, f) => a + f.removed, 0);
    this.summary.textContent = this.files.length ? `${this.files.length} files · +${added} −${removed}` : 'no changes';
    this.list.replaceChildren(...this.files.map((f) => el('button', { type: 'button', class: `dv-dfile st-${f.status}`, dataset: { path: f.path }, onclick: () => this.select(f.path) },
      el('span', { class: 'dv-name', text: f.path }), el('i', { class: 'dv-counts', text: `+${f.added} −${f.removed}` }))));
    const want = select || this.current;
    if (this.files.length) this.select(this.files.some((f) => f.path === want) ? want : this.files[0].path);
    else this.view.replaceChildren(el('p', { class: 'dv-empty', text: 'No changes.' }));
  }

  select(path) {
    this.current = path;
    for (const b of this.list.children) b.classList.toggle('active', b.dataset.path === path);
    const file = this.files.find((f) => f.path === path);
    if (!file) return;
    if (file.binary) { this.view.replaceChildren(el('p', { class: 'dv-empty', text: 'A binary file changed.' })); return; }
    const parts = [];
    for (const hunk of file.hunks) {
      parts.push(el('div', { class: 'dh', text: `@@ line ${hunk.new} ${hunk.header ? `· ${hunk.header}` : ''}` }));
      for (const line of hunk.lines) {
        const row = el('div', { class: `dl ${line.t === '+' ? 'add' : line.t === '-' ? 'del' : ''}`, dataset: { n: String(line.n) } }, el('span', { class: 'no', text: String(line.n) }), el('span', { class: 'sg', text: line.t === ' ' ? '' : line.t }), el('code', { text: line.text }));
        if (line.t !== '-') row.addEventListener('click', () => this.onOpen(file.path, line.n));
        parts.push(row);
      }
    }
    if (file.truncated) parts.push(el('p', { class: 'dv-empty', text: 'The diff is cut here (too long to show whole).' }));
    this.view.replaceChildren(...parts);
    this.view.scrollTop = 0;
    this.view.querySelector('.dl.add, .dl.del')?.scrollIntoView({ block: 'center' });
  }
}
