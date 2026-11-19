// Who answers the call: Jarvis by default, or Friday / Veronica / EDITH in front of him.
//
// One component, mounted wherever it is needed (the stage header, the console header). It shows the
// four, marks who is in front with that AI's own colour, says why one cannot be picked (not signed
// in, not installed) and sends the choice to the server. The server decides: it is stored there, so
// the choice survives reloads, and it stays until the owner changes it. Picking by voice ("switch to
// Friday") arrives here the same way, as an `agents` message.

import { el } from './util.js';
import { personaOf } from './core/personas.js';
import { presence } from './core/presence.js';

const ORDER = ['jarvis', 'friday', 'veronica', 'edith'];

export class AgentDock {
  /** @param {{send: (m: object) => boolean, toast: (t: string) => void}} io */
  constructor(io) {
    this.io = io;
    this.mounts = new Set();
    this.status = { enabled: true, active: 'jarvis', agents: [] };
    this.pending = null;       // the chip clicked and not yet confirmed by the server
    this.listeners = new Set();
  }

  get active() { return this.status.active || 'jarvis'; }

  /** Show the selector inside `container` (any number of containers). */
  mount(container) {
    if (!container) return;
    container.classList.add('agent-dock');
    container.setAttribute('role', 'radiogroup');
    container.setAttribute('aria-label', 'Who answers the call');
    container.addEventListener('keydown', (e) => this.key(e, container));
    this.mounts.add(container);
    this.render();
  }

  /** The server's view: {enabled, active, agents: [{key, name, available, detail, warm, model}]}. */
  set(status) {
    if (!status) return;
    const before = this.active;
    this.status = status;
    this.pending = null;
    presence.claim('active', this.active === 'jarvis' ? null : this.active);   // the app takes her colour
    document.body.dataset.holder = this.active;
    this.render();
    if (before !== this.active) for (const fn of this.listeners) fn(this.active, before);
  }

  /** fn(active, previous) when the agent in front changes. */
  watch(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  pick(key) {
    if (key === this.active || this.pending) return;
    const row = this.status.agents.find((a) => a.key === key);
    if (row && !row.available) { this.io.toast(`${row.name} isn't available: ${row.detail}`); return; }
    this.pending = key;
    if (!this.io.send({ type: 'agent_select', agent: key })) this.pending = null;
    this.render();
    setTimeout(() => { if (this.pending === key) { this.pending = null; this.render(); } }, 20000);   // an agent can take a while to start
  }

  key(e, container) {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    const chips = [...container.querySelectorAll('.ad-chip:not([disabled])')];
    const at = chips.indexOf(document.activeElement);
    const next = chips[(at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : chips.length - 1)) % chips.length];
    next?.focus(); e.preventDefault();
  }

  rows() {
    const byKey = new Map((this.status.agents || []).map((a) => [a.key, a]));
    return ORDER.map((k) => byKey.get(k) || { key: k, name: personaOf(k).name, available: k === 'jarvis', detail: 'checking…', warm: false });
  }

  render() {
    const enabled = this.status.enabled !== false;
    for (const box of this.mounts) {
      box.hidden = !enabled;
      box.replaceChildren(...this.rows().map((row) => this.chip(row)));
    }
  }

  chip(row) {
    const p = personaOf(row.key);
    const on = row.key === this.active;
    const busy = this.pending === row.key;
    const off = !row.available && !on;
    const chip = el('button', {
      type: 'button', class: `ad-chip${on ? ' on' : ''}${busy ? ' pending' : ''}${off ? ' off' : ''}${row.warm && !on ? ' warm' : ''}`,
      role: 'radio', 'aria-checked': String(on), 'data-ai-key': row.key,
      title: off ? `${row.name}: ${row.detail}` : on ? `${row.name} is answering` : `Put ${row.name} in front (or say "switch to ${row.name}")`,
      style: `--c:${p.css}`, onclick: () => this.pick(row.key),
    }, el('i', { class: 'ad-dot' }), el('span', { class: 'ad-name', text: row.name }));
    if (off) chip.setAttribute('aria-disabled', 'true');
    return chip;
  }
}
