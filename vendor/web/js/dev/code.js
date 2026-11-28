// The code pane: the file as it is on disk (read-only), line numbers, light colouring, a marked line,
// and "follow": when an agent edits a file the pane goes there and shows the changed line.
import { el } from '../util.js';
import { colour } from '../report-parts.js';
import { getJson } from './api.js';

export class CodePane {
  constructor({ onView }) {
    this.onView = onView;
    this.path = ''; this.follow = true; this.rows = new Map();
    this.title = el('b', { class: 'dv-path', text: 'No file open' });
    this.meta = el('span', { class: 'dv-meta' });
    this.outline = el('select', { class: 'dv-outline', 'aria-label': 'Jump to a function', hidden: true });
    this.outline.addEventListener('change', () => { if (this.outline.value) this.mark(Number(this.outline.value), true); });
    this.followBox = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Follow the agent' });
    this.followBox.addEventListener('change', () => { this.follow = this.followBox.checked; });
    this.code = el('div', { class: 'dv-code', tabindex: '0' }, el('p', { class: 'dv-empty', text: 'Say "open" and a file or function name, or click one in the tree.' }));
    this.el = el('div', { class: 'dv-codepane' },
      el('div', { class: 'dv-bar' }, this.title, this.meta, this.outline, el('label', { class: 'dv-follow', title: 'Go where the agent edits' }, this.followBox, 'follow')),
      this.code);
  }

  async open(path, line = 0) {
    if (path !== this.path) {
      let view;
      try { view = await getJson('file', { path }); } catch (err) { this.error(path, err.message); return false; }
      this.show(view);
    }
    if (line) this.mark(line, true);
    return true;
  }

  show(view) {
    this.path = view.path; this.language = view.language;
    this.title.textContent = view.path;
    this.meta.textContent = view.binary ? 'binary file' : `${view.total} lines · ${view.language}${view.masked ? ' · values hidden' : ''}${view.truncated ? ' · cut' : ''}`;
    this.rows.clear();
    if (view.binary) { this.code.replaceChildren(el('p', { class: 'dv-empty', text: 'A binary file: not shown.' })); this.outline.hidden = true; this.onView?.(view.path, 0); return; }
    const rows = view.lines.map((text, i) => {
      const n = (view.start || 1) + i;
      const row = el('div', { class: 'cl', dataset: { n: String(n) } }, el('span', { class: 'no', text: String(n) }), el('code', {}, ...colour(text, view.language)));
      this.rows.set(n, row);
      return row;
    });
    this.code.replaceChildren(...rows);
    this.code.scrollTop = 0;
    const items = view.outline || [];
    this.outline.hidden = !items.length;
    this.outline.replaceChildren(el('option', { value: '', text: 'Jump to…' }), ...items.map((s) => el('option', { value: String(s.line), text: `${s.name}  ·  ${s.kind}` })));
    this.onView?.(view.path, 0);
  }

  error(path, message) {
    this.path = ''; this.title.textContent = path; this.meta.textContent = '';
    this.code.replaceChildren(el('p', { class: 'dv-empty', text: `Could not open it: ${message}` }));
  }

  /** Light a line and bring it into view. */
  mark(line, scroll = true) {
    for (const row of this.rows.values()) row.classList.remove('hot');
    const row = this.rows.get(line);
    if (!row) return;
    row.classList.add('hot');
    if (scroll) this.code.scrollTo({ top: Math.max(0, row.offsetTop - this.code.clientHeight * 0.3), behavior: 'auto' });
    this.onView?.(this.path, line);
  }

  /** The file changed on disk: show it again, keeping the place. */
  async reload(line = 0) {
    if (!this.path) return;
    const keep = this.code.scrollTop;
    const path = this.path; this.path = '';
    await this.open(path, line);
    if (!line) this.code.scrollTop = keep;
  }
}
