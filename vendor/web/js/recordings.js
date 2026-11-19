// Recording indicator: a small dot, shown only while something is being recorded (screen, audio,
// a camera). It stays out of the way (it would be in the screen recording itself): a click opens
// the controls (timer, what it records, pause / resume, room mic on or off, stop); a click outside
// closes them. A saved recording leaves at once (the file is in the deck's files); a failed one shows
// a red dot for a short while. Everything here can also be said; the server is the truth (every
// change comes back as a recording_update).

import { el } from './util.js';

const SOUND = { system: 'system sound', mic: 'room mic', my_voice: 'your voice', jarvis_voice: 'Jarvis', camera: 'sound' };
const KIND = { screen: 'SCREEN', audio: 'AUDIO', camera: 'CAMERA' };
const STATE = { recording: 'REC', paused: 'PAUSED', starting: 'STARTING', stopping: 'STOPPING', saving: 'SAVING', failed: 'FAILED' };
const LIVE = ['recording', 'paused', 'starting', 'stopping'];
const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => { s = Math.max(0, Math.floor(s)); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`; };

export class RecordingChips {
  constructor(toast) {
    this.toast = toast;
    this.items = [];
    this.open = false;
    this.dot = el('button', { type: 'button', class: 'rec-dot', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); this.toggle(); } }, el('i'), el('b', { class: 'rec-count' }));
    this.panel = el('div', { class: 'rec-panel', role: 'dialog', 'aria-label': 'Recordings', onclick: (e) => e.stopPropagation() });
    this.root = el('div', { class: 'rec-dock' }, this.dot, this.panel);
    document.body.append(this.root);
    document.addEventListener('click', () => { if (this.open) this.toggle(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) this.toggle(false); });
    this.timer = setInterval(() => this.tick(), 1000);
  }

  async load() {
    try { const r = await fetch('/api/recordings'); if (r.ok) this.update((await r.json()).recordings); } catch { /* offline: the socket will tell us */ }
  }

  update(list) {
    this.items = (list || []).filter((r) => r.state !== 'saved');
    clearTimeout(this.expire);
    const failed = this.items.filter((r) => r.state === 'failed');
    if (failed.length) this.expire = setTimeout(() => this.update(this.items.filter((r) => r.state !== 'failed')), 20000);
    this.render();
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.root.classList.toggle('open', this.open);
    this.dot.setAttribute('aria-expanded', String(this.open));
    if (this.open) this.render();
  }

  async act(rec, action, body) {
    const r = await fetch(`/api/recordings/${rec.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!r.ok) { let why = 'Could not do that'; try { why = (await r.json()).detail || why; } catch { /* plain error */ } this.toast(why); return; }
    this.update((await r.json()).recordings);
  }

  elapsed(rec) {   // finished stretches + the running one, counted here between updates
    if (rec.state !== 'recording' || !rec.running_since) return rec.captured_s;
    return Math.max(rec.captured_s, rec.done_s + Date.now() / 1000 - rec.running_since);
  }

  render() {
    const shown = this.items.length > 0;
    this.root.classList.toggle('on', shown);
    if (!shown) { this.toggle(false); this.panel.replaceChildren(); return; }
    const top = this.items.find((r) => r.state === 'recording') || this.items[0];
    this.root.dataset.state = top.state;
    this.dot.querySelector('.rec-count').textContent = this.items.length > 1 ? String(this.items.length) : '';
    this.dot.title = this.items.map((r) => `${STATE[r.state] || r.state} ${clock(this.elapsed(r))}: ${r.line}`).join('\n');
    this.dot.setAttribute('aria-label', `${this.items.length} recording${this.items.length > 1 ? 's' : ''}: show controls`);
    if (this.open) this.panel.replaceChildren(...this.items.map((rec) => this.row(rec)));
  }

  row(rec) {
    const sounds = rec.sounds.length ? rec.sounds.map((s) => SOUND[s] || s).join(' + ') : 'no sound';
    const live = LIVE.includes(rec.state);
    const buttons = [];
    if (rec.state === 'recording') buttons.push(el('button', { type: 'button', class: 'rc-b', title: 'Pause', text: '❚❚', onclick: () => this.act(rec, 'pause') }));
    if (rec.state === 'paused') buttons.push(el('button', { type: 'button', class: 'rc-b', title: 'Resume', text: '▶', onclick: () => this.act(rec, 'resume') }));
    if (live && rec.kind !== 'camera') {
      const on = rec.sounds.includes('mic');
      buttons.push(el('button', { type: 'button', class: `rc-b mic${on ? ' on' : ''}`, title: on ? 'Stop recording the room microphone' : 'Also record the room microphone', text: on ? 'MIC ON' : 'MIC OFF', onclick: () => this.act(rec, 'change', on ? { remove: ['mic'] } : { add: ['mic'] }) }));
    }
    if (live) buttons.push(el('button', { type: 'button', class: 'rc-b stop', title: 'Stop and save', text: '■', onclick: () => this.act(rec, 'stop') }));
    return el('div', { class: `rec-chip s-${rec.state}`, title: rec.line, dataset: { id: rec.id } },
      el('b', { class: 'rc-state', text: STATE[rec.state] || rec.state }),
      el('span', { class: 'rc-time', text: clock(this.elapsed(rec)) }),
      el('span', { class: 'rc-what', text: `${KIND[rec.kind] || rec.kind} · ${sounds}` }),
      rec.state === 'failed' && rec.note ? el('span', { class: 'rc-note', text: rec.note }) : null,
      ...buttons);
  }

  tick() {
    if (!this.open) return;
    for (const node of this.panel.querySelectorAll('.rec-chip.s-recording')) {
      const rec = this.items.find((r) => r.id === node.dataset.id);
      if (rec) node.querySelector('.rc-time').textContent = clock(this.elapsed(rec));
    }
  }
}
