// Scheduled work: a mission board of upcoming and running items, a 24-hour timeline, and an editor
// for the time and the description. Used in a hologram window on the deck and in the admin panel.

import { el, duration } from './util.js';

const PRIORITY = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };
const MODE = { remind: 'REMIND', do: 'TASK', agent: 'AGENT' };
const MODE_HELP = { remind: 'Jarvis tells you', do: 'Jarvis does it himself with his tools', agent: 'An agent does it' };
const HOURS = 24;

export const fmtLeft = (s) => {
  if (s === null || s === undefined) return '—';
  if (s <= 0) return 'now';
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  return duration(s).replace('m', 'm ').trim();
};

function zoned(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const clock = (iso, tz) => new Date(iso).toLocaleTimeString([], { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'That did not work.');
  return data;
}

export class ScheduleBoard {
  /** `state()` returns {items, scheduler, waiting}; `toast(text)`; `compact` for the admin panel. */
  constructor({ state, toast, compact = false, onChange = () => {} }) {
    this.state = state; this.toast = toast; this.compact = compact; this.onChange = onChange;
    this.tab = 'upcoming'; this.editing = null; this.root = el('div', { class: `sb${compact ? ' compact' : ''}` });
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  destroy() { clearInterval(this.tickTimer); }
  get tz() { return this.state().scheduler?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone; }

  // ---- drawing
  render() {
    const s = this.state(); const items = s.items || [];
    if (this.editing) { this.root.replaceChildren(this.editor(this.editing === 'new' ? null : items.find((i) => i.id === this.editing))); return this.root; }
    const upcoming = items.filter((i) => i.status === 'active');
    const paused = items.filter((i) => i.status === 'paused');
    const finished = items.filter((i) => ['done', 'cancelled'].includes(i.status));
    const shown = { upcoming, paused, finished }[this.tab];
    const tabs = el('div', { class: 'sb-tabs', role: 'tablist' }, ...[['upcoming', `Upcoming ${upcoming.length}`], ['paused', `Paused ${paused.length}`], ['finished', `Finished ${finished.length}`]].map(([k, label]) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(this.tab === k), text: label, onclick: () => { this.tab = k; this.render(); } })));
    const head = el('div', { class: 'sb-head' }, tabs, el('span', { class: 'spacer' }),
      this.health(s), el('button', { type: 'button', class: 'sb-b hot', text: '+ New', onclick: () => { this.editing = 'new'; this.render(); } }));
    const waiting = (s.waiting || []).length
      ? el('div', { class: 'sb-waiting' }, el('b', { text: `${s.waiting.length} waiting to brief you` }), ...s.waiting.slice(0, 3).map((w) => el('span', { class: `pri ${w.priority}`, text: w.title })))
      : null;
    const list = el('div', { class: 'sb-list' }, ...(shown.length ? shown.map((i) => this.card(i)) : [el('div', { class: 'sb-empty', text: this.tab === 'upcoming' ? 'Nothing scheduled. Tell Jarvis “remind me at six”, or press New.' : 'Nothing here.' })]));
    this.root.replaceChildren(...[head, this.tab === 'upcoming' ? this.timeline(upcoming) : null, waiting, list].filter(Boolean));
    this.tick();
    return this.root;
  }

  health(s) {
    const ok = s.scheduler?.ok;
    return el('span', { class: `sb-health ${ok ? 'ok' : 'bad'}`, title: ok ? `Scheduler ticking (${s.scheduler.age_s}s ago)` : 'The background worker is not running; Jarvis checks every minute while the server is up. Start it with ./start.sh.' },
      el('i'), ok ? 'SCHEDULER OK' : 'WORKER OFFLINE', s.scheduler && !s.scheduler.ntfy ? el('small', { text: ' · no phone alerts' }) : null);
  }

  timeline(items) {
    const now = Date.now(); const span = HOURS * 3600 * 1000;
    const ticks = Array.from({ length: 9 }, (_, i) => { const t = new Date(now + (i * 3) * 3600 * 1000); return el('span', { class: 'tl-tick', dataset: { x: String((i * 3) / HOURS * 100) }, text: i === 0 ? 'NOW' : t.toLocaleTimeString([], { timeZone: this.tz, hour: '2-digit', hour12: false }) }); });
    const marks = [];
    for (const i of items) {
      if (!i.next_run_at) continue; const at = new Date(i.next_run_at).getTime() - now;
      if (at < -60000 || at > span) continue;
      marks.push(el('button', { type: 'button', class: `tl-mark ${i.priority}`, title: `${i.title} · ${i.next_text}`, dataset: { x: String(Math.max(0, at) / span * 100) }, 'aria-label': `${i.title} ${i.next_text}`, onclick: () => this.root.querySelector(`[data-id="${i.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }));
    }
    const bar = el('div', { class: 'tl-bar' }, el('i', { class: 'tl-now' }), ...marks);
    const strip = el('div', { class: 'sb-tl', 'aria-label': 'Next 24 hours' }, el('div', { class: 'tl-ticks' }, ...ticks), bar, el('small', { class: 'tl-caption', text: marks.length ? `${marks.length} in the next 24 hours` : 'Nothing in the next 24 hours' }));
    for (const n of strip.querySelectorAll('[data-x]')) n.style.setProperty('left', `${n.dataset.x}%`);
    return strip;
  }

  card(i) {
    const hot = i.seconds_until !== null && i.seconds_until <= 300 && i.status === 'active';
    const meta = [i.watch_for ? 'WATCH' : null, `${MODE[i.mode]}${i.mode === 'agent' && i.agent ? ` · ${i.agent.toUpperCase()}` : ''}`, i.trigger_text, i.run_count ? `${i.run_count} run${i.run_count === 1 ? '' : 's'}${i.max_runs ? ` of ${i.max_runs}` : ''}` : null, i.report !== 'always' ? (i.report === 'on_problem' ? 'only on trouble' : 'only on change') : null].filter(Boolean).join('  ·  ');
    const left = i.status === 'active' ? el('div', { class: 'sb-count' }, el('b', { class: 'cd', dataset: { at: i.next_run_at || '' }, text: fmtLeft(i.seconds_until) }), el('small', { text: i.next_text || '' })) : el('div', { class: 'sb-count dim' }, el('b', { text: i.status.toUpperCase() }));
    const bar = i.status === 'active' && i.next_run_at ? el('div', { class: 'sb-prog' }, el('i', { dataset: { from: i.last_run_at || i.created_at, to: i.next_run_at } })) : null;
    const buttons = [];
    if (i.status === 'active') buttons.push(this.btn('Run now', () => this.act(i, 'run')), this.btn('Pause', () => this.act(i, 'pause')));
    if (i.status === 'paused') buttons.push(this.btn('Resume', () => this.act(i, 'resume')));
    if (['done', 'cancelled'].includes(i.status)) buttons.push(this.btn('Run again', () => this.act(i, 'snooze', '?minutes=1')));
    buttons.push(this.btn('Edit', () => { this.editing = i.id; this.render(); }));
    if (i.status !== 'cancelled' && i.status !== 'done') buttons.push(this.btn('Cancel', () => { if (confirm(`Cancel “${i.title}”?`)) this.act(i, 'cancel'); }, 'danger'));
    else buttons.push(this.btn('Delete', () => { if (confirm(`Delete “${i.title}” and its history?`)) this.remove(i); }, 'danger'));
    return el('article', { class: `sb-card ${i.priority}${hot ? ' hot' : ''}`, dataset: { id: i.id } },
      el('div', { class: 'sb-main' }, el('div', { class: 'sb-title' }, el('span', { class: `pri ${i.priority}`, text: PRIORITY[i.priority] }), el('b', { text: i.title })),
        el('div', { class: 'sb-desc', text: i.description }),
        i.watch_for ? el('div', { class: 'sb-desc', text: `Watching for: ${i.watch_for}` }) : null,
        el('div', { class: 'sb-meta', text: meta }),
        i.failures ? el('div', { class: 'sb-warn', text: `${i.failures} failed in a row` }) : null),
      left, bar, el('div', { class: 'sb-btns' }, ...buttons));
  }
  btn(text, onclick, cls = '') { return el('button', { type: 'button', class: `sb-b ${cls}`, text, onclick }); }

  async act(i, action, query = '') {
    try { await api('POST', `/api/schedules/${i.id}/${action}${query}`); if (action === 'run') this.toast(`Running “${i.title}” now`); this.onChange(); }
    catch (err) { this.toast(err.message); }
  }
  async remove(i) { try { await api('DELETE', `/api/schedules/${i.id}`); this.onChange(); } catch (err) { this.toast(err.message); } }

  // ---- live countdowns
  tick() {
    const now = Date.now();
    for (const n of this.root.querySelectorAll('.cd[data-at]')) { if (n.dataset.at) n.textContent = fmtLeft(Math.round((new Date(n.dataset.at).getTime() - now) / 1000)); }
    for (const bar of this.root.querySelectorAll('.sb-prog i')) {
      const from = new Date(bar.dataset.from).getTime(); const to = new Date(bar.dataset.to).getTime();
      bar.style.setProperty('width', `${Math.max(2, Math.min(100, ((now - from) / Math.max(1, to - from)) * 100))}%`);
    }
    for (const card of this.root.querySelectorAll('.sb-card')) {
      const cd = card.querySelector('.cd'); if (cd && cd.dataset.at) card.classList.toggle('hot', new Date(cd.dataset.at).getTime() - now <= 300000);
    }
  }

  // ---- the editor: time and description
  editor(item) {
    const tz = this.tz; const fresh = !item; const t = item?.trigger || { kind: 'in', seconds: 300 };
    const f = (label, node, hint) => el('label', { class: 'se-f' }, el('span', { text: label }), node, hint ? el('small', { text: hint }) : null);
    const title = el('input', { type: 'text', maxlength: '120', value: item?.title || '', placeholder: 'Wedding reminder', 'aria-label': 'Title' });
    const desc = el('textarea', { rows: '4', maxlength: '2000', placeholder: 'What should happen? For a task, write it as an instruction.', 'aria-label': 'Description' }); desc.value = item?.description || '';
    const select = (opts, value, label) => { const s = el('select', { 'aria-label': label }, ...opts.map(([v, text]) => el('option', { value: v, text, selected: v === value }))); return s; };
    const mode = select([['remind', 'Remind me'], ['do', 'Do it yourself (Jarvis, with tools)'], ['agent', 'Give it to an agent']], item?.mode || 'remind', 'What happens');
    const agent = select([['friday', 'Friday'], ['veronica', 'Veronica'], ['edith', 'EDITH'], ['karen', 'Karen']], item?.agent || 'friday', 'Agent');
    const priority = select(Object.entries(PRIORITY).map(([k, v]) => [k, v]), item?.priority || 'normal', 'Priority');
    const report = select([['always', 'Always tell me'], ['on_change', 'Only when it changes'], ['on_problem', 'Only if something is wrong']], item?.report || 'always', 'When to report');
    const kind = select([['once', 'Once, at a time'], ['in', 'Once, after a delay'], ['every', 'Repeat every…'], ['cron', 'Repeat on a rule']], t.kind, 'Timing');
    const at = el('input', { type: 'datetime-local', 'aria-label': 'Date and time', value: item?.next_run_at && t.kind === 'once' ? zoned(new Date(item.next_run_at), tz) : zoned(new Date(Date.now() + 3600000), tz) });
    const minutes = el('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Minutes', value: String(Math.max(1, Math.round((t.seconds || 300) / 60))) });
    const unit = select([['1', 'minutes'], ['60', 'hours'], ['1440', 'days']], t.seconds && t.seconds % 86400 === 0 ? '1440' : t.seconds && t.seconds % 3600 === 0 ? '60' : '1', 'Unit');
    if (t.seconds && t.seconds % 86400 === 0) minutes.value = String(t.seconds / 86400); else if (t.seconds && t.seconds % 3600 === 0) minutes.value = String(t.seconds / 3600);
    const until = el('input', { type: 'datetime-local', 'aria-label': 'Until', value: t.until ? zoned(new Date(t.until), tz) : '' });
    const cron = el('input', { type: 'text', value: t.cron || '', placeholder: '0 8 * * 1-5', spellcheck: 'false', 'aria-label': 'Repeat rule' });
    const next = el('input', { type: 'datetime-local', 'aria-label': 'Next run', value: item?.next_run_at ? zoned(new Date(item.next_run_at), tz) : '' });
    const maxRuns = el('input', { type: 'number', min: '1', placeholder: 'no limit', value: item?.max_runs ? String(item.max_runs) : '', 'aria-label': 'Stop after this many runs' });
    const preview = el('div', { class: 'se-preview', 'aria-live': 'polite' });
    const err = el('div', { class: 'se-err', role: 'alert' });
    const rows = { once: [f('When', at)], in: [f('Run after', el('div', { class: 'se-pair' }, minutes, unit))], every: [f('Every', el('div', { class: 'se-pair' }, minutes, unit)), f('Until (optional)', until)], cron: [f('Rule (minute hour day month weekday)', cron, 'e.g. 0 8 * * 1-5 = 08:00 on weekdays')] };
    const timing = el('div', { class: 'se-timing' });
    const agentRow = f('Which agent', agent);
    const when = () => {
      const k = kind.value;
      if (k === 'once') return { kind: k, at: at.value };
      if (k === 'in') return { kind: k, in_minutes: Number(minutes.value) * Number(unit.value) };
      if (k === 'every') return { kind: k, every_minutes: Number(minutes.value) * Number(unit.value), until: until.value || null };
      return { kind: k, cron: cron.value.trim() };
    };
    let timer = 0;
    const refresh = () => {
      timing.replaceChildren(...rows[kind.value]); agentRow.hidden = mode.value !== 'agent';
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { const p = await api('POST', '/api/schedules/preview', when()); preview.className = 'se-preview'; preview.textContent = `${p.text}. Next: ${p.next.map((n) => n.text).join(', ')}`; }
        catch (e) { preview.className = 'se-preview bad'; preview.textContent = e.message; }
      }, 250);
    };
    for (const n of [kind, mode, at, minutes, unit, until, cron]) n.addEventListener('input', refresh);
    const save = async () => {
      err.textContent = '';
      const body = { title: title.value.trim(), description: desc.value.trim(), mode: mode.value, agent: mode.value === 'agent' ? agent.value : null, priority: priority.value, report: report.value, max_runs: maxRuns.value ? Number(maxRuns.value) : null };
      try {
        if (fresh) await api('POST', '/api/schedules', { ...body, when: when() });
        else {
          const patch = { ...body };
          const changed = kind.value !== t.kind || JSON.stringify(when()) !== JSON.stringify(this.whenOf(item));
          if (changed) patch.when = when();
          if (next.value && next.value !== zoned(new Date(item.next_run_at), tz)) patch.next_at = next.value;
          await api('PATCH', `/api/schedules/${item.id}`, patch);
        }
        this.editing = null; this.toast('Saved'); this.render(); this.onChange();
      } catch (e) { err.textContent = e.message; }
    };
    refresh();
    return el('form', { class: 'se', onsubmit: (e) => { e.preventDefault(); save(); } },
      el('h4', { text: fresh ? 'New schedule' : 'Edit schedule' }),
      f('Title', title), f('Description', desc, 'This is exactly what Jarvis carries out or reads out at the time.'),
      el('div', { class: 'se-grid' }, f('What happens', mode, MODE_HELP[mode.value]), agentRow, f('Priority', priority), f('Tell me', report)),
      f('Timing', kind), timing,
      !fresh && item.status === 'active' ? f('Next run (change just this one)', next) : null,
      f('Stop after (optional)', maxRuns),
      preview, err,
      el('div', { class: 'se-actions' }, el('button', { type: 'button', class: 'sb-b', text: 'Back', onclick: () => { this.editing = null; this.render(); } }), el('span', { class: 'spacer' }), el('button', { type: 'submit', class: 'sb-b hot', text: fresh ? 'Create' : 'Save' })));
  }

  whenOf(item) {
    const t = item.trigger;
    if (t.kind === 'once') return { kind: 'once', at: zoned(new Date(item.next_run_at || t.at), this.tz) };
    if (t.kind === 'in') return { kind: 'in', in_minutes: Math.round(t.seconds / 60) };
    if (t.kind === 'every') return { kind: 'every', every_minutes: Math.round(t.seconds / 60), until: t.until ? zoned(new Date(t.until), this.tz) : null };
    return { kind: 'cron', cron: t.cron };
  }
}

export { clock };
