// The surrounding instrument panels: clock, team, operations, cameras, transfers.

import { el, persona, duration, fmtBytes } from './util.js';
import { fmtLeft } from './schedules.js';

const $ = (id) => document.getElementById(id);
const ACTIVE = new Set(['running', 'queued', 'waiting_approval']);

export class Hud {
  constructor({ onOpenCamera }) { this.onOpenCamera = onOpenCamera; this.tickTimer = setInterval(() => this.clock(), 1000); this.clock(); }

  clock() {
    const now = new Date();
    for (const n of document.querySelectorAll('#w-sched .cd[data-at]')) n.textContent = fmtLeft(Math.round((new Date(n.dataset.at).getTime() - now.getTime()) / 1000));
    $('hud-clock').textContent = now.toLocaleTimeString([], { hour12: false });
    $('hud-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  }

  setSpend(s) { $('hud-spend').textContent = `$${s.spent_usd.toFixed(2)} / $${s.budget_usd.toFixed(0)}`; }

  team(team, tasks) {
    const body = $('w-team').querySelector('.wb');
    const running = [...tasks.values()].filter((t) => ACTIVE.has(t.status));
    const rows = (team || []).map((m) => {
      const who = persona(m.key); const job = running.find((t) => t.owner === m.key);
      const state = m.checking ? 'checking' : m.busy || job ? 'busy' : m.available ? 'ready' : 'down';
      return el('div', { class: `trow ${state}`, style: `--c:${who.color}`, title: m.detail || '' },
        el('i', { class: 'tdot' }), el('b', { text: m.name }),
        el('span', { class: 'tstate', text: state === 'busy' ? (job ? job.title.slice(0, 28) : 'working') : state === 'ready' ? 'ready' : state === 'checking' ? 'checking' : 'not ready' }));
    });
    body.replaceChildren(...rows);
  }

  tasks(tasks, approvals) {
    const body = $('w-tasks').querySelector('.wb');
    const running = [...tasks.values()].filter((t) => ACTIVE.has(t.status)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const nodes = running.slice(0, 5).map((t) => {
      const who = persona(t.owner);
      return el('div', { class: 'op', style: `--c:${who.color}` },
        el('div', { class: 'opt' }, el('b', { text: who.name }), el('span', { text: t.title.slice(0, 40) })),
        el('div', { class: 'opbar' }, el('i')),
        el('small', { class: 'elapsed', dataset: { start: new Date(t.started_at).getTime() } }));
    });
    if (approvals.size) nodes.unshift(el('div', { class: 'op warn' }, el('b', { text: `${approvals.size} awaiting your approval` })));
    if (running.length > 5) nodes.push(el('small', { class: 'more', text: `+${running.length - 5} more` }));
    body.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'idle', text: 'All quiet.' })]));
  }

  cameras(list) {
    const box = $('w-cams'); box.hidden = !list.length;
    const live = list.filter((c) => c.state === 'live').length;
    box.querySelector('h5').textContent = `Cameras · ${list.length}`;
    box.querySelector('.wb').replaceChildren(...list.slice(0, 6).map((c) => el('button', { type: 'button', class: `crow ${c.state || 'idle'}${c.recording ? ' rec' : ''}`, title: c.address, onclick: () => this.onOpenCamera(c.id) },
      el('i', { class: 'cdot' }), el('b', { text: c.name }), el('span', { text: c.recording ? 'REC' : c.state === 'live' ? 'LIVE' : c.kind }))));
    const n = $('rb-cams-n'); n.hidden = !live && !list.some((c) => c.recording); n.textContent = list.some((c) => c.recording) ? '●' : String(live);
  }

  schedule(s, open) {
    const body = $('w-sched').querySelector('.wb');
    const upcoming = (s.items || []).filter((i) => i.status === 'active' && i.next_run_at).slice(0, 3);
    const rows = upcoming.map((i) => el('button', { type: 'button', class: `srow ${i.priority}`, title: `${i.title} — ${i.trigger_text}`, onclick: open },
      el('i', { class: 'sdot' }), el('b', { text: i.title.slice(0, 26) }), el('span', { class: 'cd', dataset: { at: i.next_run_at }, text: fmtLeft(i.seconds_until) })));
    const waiting = (s.waiting || []).length;
    if (waiting) rows.unshift(el('button', { type: 'button', class: 'srow warn', onclick: open }, el('i', { class: 'sdot' }), el('b', { text: `${waiting} to brief you` }), el('span', { text: 'waiting' })));
    body.replaceChildren(...(rows.length ? rows : [el('div', { class: 'idle', text: 'Nothing scheduled.' })]));
    $('w-sched').classList.toggle('offline', s.scheduler && s.scheduler.ok === false);
  }

  transfers(map) {
    const box = $('w-xfer'); box.hidden = !map.size;
    box.querySelector('.wb').replaceChildren(...[...map.values()].map((t) => el('div', { class: `xf ${t.state || ''}` },
      el('div', { class: 'xft' }, el('b', { text: t.name.slice(0, 26) }), el('small', { text: t.state === 'failed' ? 'failed' : t.state === 'done' ? 'saved' : `${Math.round(t.done * 100)}% of ${fmtBytes(t.size)}` })),
      el('div', { class: 'opbar' }, el('i', { style: `width:${Math.round(t.done * 100)}%` })))));
  }

  files(count, unseen) { const n = $('rb-files-n'); n.hidden = !unseen; n.textContent = String(unseen); $('rb-files').title = `${count} file${count === 1 ? '' : 's'}`; }

  memo(recording, seconds) {
    const b = $('rb-memo'); b.classList.toggle('recording', recording);
    b.querySelector('.tip').textContent = recording ? `Stop and send (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})` : 'Voice memo';
  }
}
export { duration };
