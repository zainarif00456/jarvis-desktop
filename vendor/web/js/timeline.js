// The conversation view: messages, streaming replies, task cards and command results,
// every one with its time. Built from DOM nodes only.

import { el, persona, fmtTime, fmtFull, dayKey, dayLabel, renderMarkdown, copyText, shareText, duration } from './util.js';

const ACTIVE = new Set(['running', 'queued', 'waiting_approval']);

export class Timeline {
  constructor({ root, scroller, jump, onCancel }) {
    this.root = root; this.scroller = scroller; this.jump = jump; this.onCancel = onCancel;
    this.items = []; this.streams = new Map(); this.cards = new Map(); this.taskItems = new Map();
    this.lastDay = null; this.stick = true;
    scroller.addEventListener('scroll', () => {
      this.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
      if (this.stick) jump.hidden = true;
    });
    jump.addEventListener('click', () => this.toBottom());
  }

  get firstSeq() { const seqs = this.items.map((i) => i.seq).filter((s) => s != null); return seqs.length ? Math.min(...seqs) : null; }

  // ---- bulk (history) ----
  setHistory(items) { this.items = items.slice(); this.renderAll(); this.toBottom(); }
  prepend(older) {
    const before = this.scroller.scrollHeight;
    this.items = [...older, ...this.items]; this.renderAll();
    this.scroller.scrollTop += this.scroller.scrollHeight - before;
  }
  clearView() { this.items = []; this.renderAll(); }
  renderAll() {
    this.root.replaceChildren(); this.cards.clear(); this.taskItems.clear(); this.streams.clear(); this.lastDay = null;
    for (const item of this.items) this.draw(item);
  }

  // ---- live ----
  push(item) { this.items.push(item); const near = this.stick; this.draw(item); this.afterAppend(near); }
  addUser(text, ts = new Date().toISOString()) { this.push({ kind: 'message', role: 'user', name: 'You', text, ts }); }
  agentMessage(d) { this.push({ kind: 'message', role: 'agent', persona: d.persona, name: d.name, text: d.text, final: d.final, task_id: d.task_id, ts: d.ts || new Date().toISOString() }); }
  commandResult(d) { this.push({ kind: 'command', text: d.line, result: d.text, ok: d.ok, ts: d.ts || new Date().toISOString() }); }
  notice(text) { const near = this.stick; this.append(el('div', { class: 'note', text })); this.afterAppend(near); }

  taskUpdate(task) {
    const item = this.taskItems.get(task.id);
    if (item) { Object.assign(item, taskFields(task)); this.cards.get(task.id)?.update(item); return; }
    this.push({ kind: 'task', task_id: task.id, ts: task.started_at, ...taskFields(task) });
  }

  startTurn(turnId, kind, voice = false, agent = 'jarvis') {
    if (this.streams.has(turnId)) return;
    const item = { kind: 'message', role: 'assistant', agent, name: persona(agent).name, text: '', ts: new Date().toISOString(), greeting: kind === 'greeting', live: true };
    const near = this.stick;
    this.ensureDay(item.ts);
    const node = this.messageNode(item);
    node.body.classList.add('typing');
    this.append(node.root);
    this.streams.set(turnId, { ...node, text: '', item, voice, shown: '', revealed: false });
    this.items.push(item);
    this.afterAppend(near);
  }
  delta(turnId, text) {
    const s = this.streams.get(turnId) || (this.startTurn(turnId, 'message'), this.streams.get(turnId));
    s.text += text; s.item.text = s.text;
    if (s.voice) return;   // in a call the words appear as they are spoken (see reveal)
    if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; const near = this.stick; s.body.replaceChildren(renderMarkdown(s.text)); this.afterAppend(near); });
  }
  // Voice: show each sentence as it starts being spoken, so the text never runs ahead of the voice.
  reveal(turnId, display) {
    const s = this.streams.get(turnId); if (!s || !s.voice) return;
    s.shown += (s.shown ? ' ' : '') + display; s.revealed = true;
    const near = this.stick; s.body.replaceChildren(renderMarkdown(s.shown)); this.afterAppend(near);
  }
  // The owner talked over Jarvis: whatever was not spoken yet never appears; mark the cut.
  voiceStopped() {
    for (const s of this.streams.values()) {
      if (s.voice && s.revealed && s.text.length > s.shown.length + 2) { s.root.classList.add('interrupted'); s.body.classList.remove('typing'); }
    }
  }
  toolStart(turnId, callId, name, args) {
    const s = this.streams.get(turnId); if (!s) return;
    const text = `→ ${name.replace('_', '.')} ${briefArgs(args)}`;
    const chip = el('span', { class: 'tool wait', title: JSON.stringify(args), text });
    s.tools.append(chip); s.chips = s.chips || new Map(); s.chips.set(callId, chip);
    this.afterAppend(this.stick);
  }
  toolFinish(turnId, d) {
    const chip = this.streams.get(turnId)?.chips?.get(d.call_id); if (!chip) return;
    const cls = d.status === 'done' ? 'ok' : (['running', 'awaiting_approval', 'already_running'].includes(d.status) ? 'wait' : 'bad');
    chip.className = `tool ${cls}`;
    chip.textContent = `${d.ok ? '✓' : '✗'} ${d.name.replace('_', '.')} · ${d.status.replace('_', ' ')}`;
  }
  finishTurn(turnId, d) {
    const s = this.streams.get(turnId) || (this.startTurn(turnId, 'message'), this.streams.get(turnId));
    s.text = d.text; s.item.text = d.text; s.item.live = false;
    if (s.voice) {   // keep revealing sentence by sentence as the voice reaches them
      s.finished = true;
      setTimeout(() => { if (!s.revealed) { s.body.classList.remove('typing'); s.body.replaceChildren(renderMarkdown(d.text || '')); } }, 7000);
    } else { s.body.classList.remove('typing'); s.body.replaceChildren(renderMarkdown(d.text || '')); }
    s.meta.textContent = `${d.model.replace('claude-', '')} · ${d.steps} step${d.steps === 1 ? '' : 's'}${d.cost_usd ? ` · $${d.cost_usd.toFixed(4)}` : ''}`;  // an agent on a subscription has no API cost
    this.afterAppend(this.stick);
  }
  failTurn(turnId, message) {
    const s = turnId ? this.streams.get(turnId) : [...this.streams.values()].pop();
    if (!s) { this.push({ kind: 'message', role: 'assistant', name: 'Jarvis', text: message, failed: true, ts: new Date().toISOString() }); return; }
    s.body.classList.remove('typing'); s.root.classList.add('failed');
    s.body.replaceChildren(renderMarkdown((s.text ? s.text + '\n\n' : '') + `⚠ ${message}`));
  }
  interrupted(turnId) {
    const s = turnId ? this.streams.get(turnId) : [...this.streams.values()].pop();
    if (s) { s.body.classList.remove('typing'); s.root.classList.add('interrupted'); }
  }

  // ---- drawing ----
  draw(item) {
    this.ensureDay(item.ts);
    if (item.kind === 'message') this.append(this.messageNode(item).root);
    else if (item.kind === 'task') this.drawTask(item);
    else if (item.kind === 'command') this.append(this.commandNode(item));
    else if (item.kind === 'note') this.append(el('div', { class: 'note', title: fmtFull(item.ts), text: `${fmtTime(item.ts)} · ${item.text}` }));
    else if (item.kind === 'session') this.append(el('div', { class: 'day session-mark', title: item.reason || '', text: `Session ${item.number} · ${fmtTime(item.ts)}` }));
    else if (item.kind === 'approval') this.append(el('div', { class: 'note', title: fmtFull(item.ts), text: `${fmtTime(item.ts)} · approval ${item.status} — ${item.tool || ''} ${item.what || ''}`.trim() }));
    else if (item.kind === 'file') this.append(el('div', { class: 'note', title: fmtFull(item.ts), text: `${fmtTime(item.ts)} · file shared: ${item.file?.name || ''}` }));
  }
  drawTask(item) {
    const known = this.taskItems.get(item.task_id);
    if (known) { Object.assign(known, taskFields(item), { ts: known.ts }); this.cards.get(item.task_id)?.update(known); return; }
    const merged = { ...item, ...taskFields(item), assigned_at: item.ts, finished_at: finished(item) ? item.ts : null };
    this.taskItems.set(item.task_id, merged);
    const card = this.cardNode(merged);
    this.cards.set(item.task_id, card); this.append(card.root);
  }
  ensureDay(iso) { if (!iso) return; const k = dayKey(iso); if (k !== this.lastDay) { this.lastDay = k; this.append(el('div', { class: 'day', text: dayLabel(iso) })); } }
  append(node) { this.root.append(node); }
  afterAppend(near) { if (near) this.toBottom(); else this.jump.hidden = false; }
  toBottom() { this.scroller.scrollTop = this.scroller.scrollHeight; this.stick = true; this.jump.hidden = true; }

  messageNode(item) {
    const key = item.role === 'agent' ? item.persona : item.role === 'user' ? 'user' : (item.agent || 'jarvis');
    const who = persona(key);
    const body = el('div', { class: 'body' }, item.text ? renderMarkdown(item.text) : null);
    const tools = el('div', { class: 'tools' });
    const meta = el('div', { class: 'meta' });
    if (item.tools?.length) meta.textContent = `used ${item.tools.join(', ')}`;
    const actions = el('div', { class: 'actions' },
      el('button', { class: 'mini', type: 'button', text: 'Copy', onclick: async (e) => flash(e.target, await copyText(item.text || '') ? 'Copied' : 'Failed', 'Copy') }),
      navigator.share ? el('button', { class: 'mini', type: 'button', text: 'Share', onclick: () => shareText(`${who.name} · ${fmtTime(item.ts)}`, item.text || '') }) : null);
    const root = el('div', { class: `msg ${item.role}${item.greeting ? ' greeting' : ''}${item.failed ? ' failed' : ''}${item.interrupted ? ' interrupted' : ''}`, style: `--c:${who.color}` },
      el('div', { class: 'avatar', text: who.initial }),
      el('div', {},
        el('div', { class: 'who' }, el('b', { text: item.name || who.name }), el('time', { datetime: item.ts, title: fmtFull(item.ts), text: fmtTime(item.ts) })),
        body, tools, meta, actions));
    return { root, body, tools, meta };
  }

  commandNode(item) {
    return el('div', { class: 'cmd' },
      el('div', { class: 'line', title: fmtFull(item.ts), text: `${fmtTime(item.ts)}  ${item.text}` }),
      item.result ? el('pre', { text: item.result }) : null);
  }

  cardNode(data) {
    const who = persona(data.owner);
    const status = el('span', { class: 'pill' });
    const title = el('span', { class: 'title' });
    const sub = el('div', { class: 'sub' }); const detail = el('div', { class: 'sub' });
    const cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel', onclick: () => this.onCancel(data.task_id) });
    const root = el('div', { class: 'card', style: `--c:${who.color}`, dataset: { task: data.task_id } },
      el('div', { class: 'row1' }, el('b', { text: who.name, style: `color:${who.color}` }), title, status, cancel), sub, detail);
    const elapsed = el('span', { class: 'elapsed' });
    const update = (d) => {
      title.textContent = d.title || '';
      status.className = `pill ${d.status}`; status.textContent = d.status.replace('_', ' ');
      const active = ACTIVE.has(d.status);
      cancel.hidden = !active;
      const assigned = d.assigned_at || d.ts;
      sub.replaceChildren(`Assigned ${fmtTime(assigned)}`, ' · ');
      if (active) { elapsed.dataset.start = new Date(assigned).getTime(); delete elapsed.dataset.end; elapsed.textContent = duration((Date.now() - new Date(assigned)) / 1000); sub.append(elapsed, d.progress ? ` · ${d.progress}` : ''); }
      else { const end = d.finished_at || d.ts; sub.append(`finished ${fmtTime(end)} (${duration((new Date(end) - new Date(assigned)) / 1000)})`); }
      detail.textContent = d.error && !active ? d.error : (d.summary || '');
      sub.title = fmtFull(assigned);
    };
    update(data);
    return { root, update };
  }
}

const finished = (i) => ['done', 'failed', 'cancelled', 'lost'].includes(i.status) || ['done', 'failed', 'cancelled', 'lost'].includes(i.event);
function taskFields(t) {
  const fields = { owner: t.owner, title: t.title, status: t.status || 'running', progress: t.progress, summary: t.summary, error: t.error, finished_at: t.finished_at ?? (finished(t) ? t.ts : null), assigned_at: t.started_at || t.assigned_at };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
function briefArgs(args) { const v = args?.command ?? args?.path ?? args?.pattern ?? args?.task ?? args?.query ?? ''; return String(v).slice(0, 70); }
function flash(button, text, original) { button.textContent = text; setTimeout(() => (button.textContent = original), 1200); }
