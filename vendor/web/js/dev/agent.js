// The live view of the agents: every read, edit and command as it happens, who did it, and the jobs.
import { el } from '../util.js';
import { WHO, getJson } from './api.js';

const ICON = { edit: '✎', read: '◧', run: '▸', search: '⌕', other: '·' };
const MAX_ROWS = 200;

export class AgentPane {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.jobs = el('div', { class: 'dv-jobs' });
    this.notes = el('div', { class: 'dv-notes' });
    this.feed = el('div', { class: 'dv-feed', 'aria-live': 'off' }, el('p', { class: 'dv-empty', text: 'Nothing yet. When an agent works, every step shows here.' }));
    this.logBtn = el('button', { type: 'button', class: 'dv-btn', text: 'Action log', onclick: () => this.showLog() });
    this.el = el('div', { class: 'dv-agentpane' }, el('div', { class: 'dv-bar' }, el('b', { text: 'Agents' }), this.logBtn), this.notes, this.jobs, this.feed);
  }

  event(m) {
    if (this.feed.querySelector('.dv-empty')) this.feed.replaceChildren();
    const row = el('div', { class: `dv-ev k-${m.kind}${m.mutating ? ' mut' : ''}${m.lane ? ' lane' : ''}` },
      el('span', { class: 'who', text: m.who, style: `color:${WHO[m.who] || 'var(--ai)'}` }),
      el('span', { class: 'ic', text: ICON[m.kind] || '·' }), el('span', { class: 'tx', text: m.summary }));
    if (m.path && !m.lane) { row.classList.add('click'); row.addEventListener('click', () => this.onOpen(m.path, m.line || 0)); }
    if (m.lane) row.append(el('i', { class: 'lane-tag', text: 'own worktree' }));
    this.feed.prepend(row);
    while (this.feed.children.length > MAX_ROWS) this.feed.lastChild.remove();
  }

  state(dev) {
    const jobs = dev.jobs || [];
    this.jobs.replaceChildren(...jobs.map((j) => el('div', { class: `dv-job st-${String(j.status).replace(/\W/g, '')}` },
      el('span', { class: 'who', text: j.owner, style: `color:${WHO[j.owner] || 'var(--ai)'}` }), el('span', { class: 'tx', text: j.title }), el('i', { text: `${String(j.status).replace('TaskStatus.', '').toLowerCase()} · ${j.elapsed_s}s` }))));
    const overlaps = Object.entries(dev.overlaps || {});
    this.notes.replaceChildren(...overlaps.map(([path, who]) => el('div', { class: 'dv-warn', text: `${who.join(' and ')} both touched ${path}` })));
  }

  async showLog() {
    let data;
    try { data = await getJson('actions', { count: 60 }); } catch (err) { this.feed.prepend(el('p', { class: 'dv-empty', text: err.message })); return; }
    const s = data.summary;
    this.feed.replaceChildren(el('div', { class: 'dv-logsum', text: `${s.total} actions · ${Object.entries(s.by_actor).map(([a, n]) => `${a} ${n}`).join(' · ')}` }),
      ...[...data.actions].reverse().map((a) => el('div', { class: `dv-ev k-${a.kind}` }, el('span', { class: 'who', text: a.actor, style: `color:${WHO[a.actor] || 'var(--ai)'}` }), el('span', { class: 'ic', text: new Date(a.at * 1000).toLocaleTimeString() }), el('span', { class: 'tx', text: `${a.kind}: ${a.summary}` }))));
  }
}
