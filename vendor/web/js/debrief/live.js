// Agents at work, shown as moons: each working agent is a small particle orb in her colour and
// shape orbiting Jarvis's core (drawn by the core on the GPU: js/neural/core.js setAgents). It
// blinks when her progress changes; when she speaks or presents, it flies into the core and the
// core becomes her (presence), then flies back out while she still works.
//
// This module tells the core who is working and keeps a small tag beside each moon (her name,
// what she is doing now, how long). Tags move ~12 times a second (transform only), never per
// frame. Without the GPU core (classic orb) the tags sit in a row under it instead.

import { el, persona, duration } from '../util.js';
import { frames } from '../core/frames.js';

const ACTIVE = new Set(['running', 'queued', 'waiting_approval']);
const clean = (text) => String(text || '').replace(/\s+/g, ' ').replace(/^(working|preparing workspace)$/i, 'working on it').trim().slice(0, 64);

export class LiveWork {
  constructor({ core }) {
    this.core = core;
    this.root = el('div', { class: 'moon-tags', 'aria-live': 'off', 'aria-label': 'What the agents are doing' });
    document.getElementById('stage')?.append(this.root);
    this.tags = new Map();
    this.job = frames.add(() => this.place(), { fps: 12, paused: true });
    setInterval(() => this.tick(), 1000);
  }

  /** tasks: Map(id -> task) from the server (task_update). One moon per agent: her latest job. */
  update(tasks) {
    const byAgent = new Map();
    for (const t of tasks.values()) {
      if (!ACTIVE.has(t.status) || !t.owner || t.owner === 'jarvis') continue;
      const had = byAgent.get(t.owner);
      if (!had || String(t.started_at) > String(had.started_at)) byAgent.set(t.owner, t);
    }
    this.core.setAgents?.([...byAgent.values()].map((t) => ({ key: t.owner, ping: `${t.id}:${t.progress || ''}` })));
    for (const [key, tag] of this.tags) if (!byAgent.has(key)) { tag.el.classList.add('out'); setTimeout(() => tag.el.remove(), 500); this.tags.delete(key); }
    for (const [key, t] of byAgent) {
      let tag = this.tags.get(key);
      if (!tag) {
        const who = persona(key);
        const what = el('span', { class: 'mt-what' }); const time = el('small', { class: 'mt-time' });
        tag = { el: el('div', { class: 'moon-tag', style: `--c:${who.color}`, dataset: { ref: `agent:${key}` } },
          el('b', { text: who.name.toUpperCase() }), what, time), what, time, last: '' };
        this.tags.set(key, tag); this.root.append(tag.el);
      }
      const now = clean(t.progress) || clean(t.title) || 'working on it';
      if (now !== tag.last) { tag.last = now; tag.what.textContent = now; tag.what.title = t.title || ''; }
      tag.start = new Date(t.started_at).getTime();
    }
    this.root.classList.toggle('row', !this.core.moonPositions?.());
    if (this.tags.size) this.job.resume(); else this.job.pause();
    this.tick();
  }

  /** Keep each tag beside its moon (outer side of the orbit), hidden while the moon is inside the core. */
  place() {
    const moons = this.core.moonPositions?.();
    if (!moons) return;
    for (const m of moons) {
      const tag = this.tags.get(m.key); if (!tag) continue;
      const right = m.x >= window.innerWidth / 2;
      const x = right ? m.x + m.r * 2.2 : m.x - m.r * 2.2;
      tag.el.style.setProperty('transform', `translate(${Math.round(x)}px, ${Math.round(m.y)}px) translate(${right ? '0' : '-100%'}, -50%)`);
      tag.el.classList.toggle('left', !right);
      tag.el.style.setProperty('opacity', String(Math.max(0, Math.min(1, (m.alpha - 0.25) * 1.6))));
      tag.el.classList.toggle('behind', !m.front);
    }
  }

  tick() { const now = Date.now(); for (const t of this.tags.values()) if (t.start) t.time.textContent = duration((now - t.start) / 1000); }
}
