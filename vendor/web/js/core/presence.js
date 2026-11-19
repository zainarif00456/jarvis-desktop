// Presence: which AI is in front right now. It colours the whole app (`<html data-ai>`, read by
// css/theme.css) and reshapes the neural core (listeners get the persona entry).
//
// Several things can claim the stage, strongest first:
//   voice   an agent's voice is playing (tts_start.speaker, timed by the server to when it is heard)
//   window  the portal in front belongs to that agent (her briefing, her live feed...)
//   active  the owner put her in front of the call (js/agents.js): her colour until he changes it
// Nothing claiming -> Jarvis. A claim that ends is let go after a short pause, so the colour does
// not flicker between two sentences of the same agent.

import { aiKey, personaOf, DEFAULT_AI } from './personas.js';

const RELEASE_MS = { voice: 1400, window: 300, active: 0 };
const ORDER = ['voice', 'window', 'active'];

class Presence {
  constructor() {
    this.claims = new Map();          // source -> ai key
    this.timers = new Map();          // source -> pending release
    this.listeners = new Set();
    this.current = DEFAULT_AI;
    this.apply();
  }

  /** Who is present now: the persona entry from core/personas.js. */
  get persona() { return personaOf(this.current); }

  /** `source` says `key` is in front (null/undefined = that source lets go, after a short pause). */
  claim(source, key) {
    clearTimeout(this.timers.get(source)); this.timers.delete(source);
    if (key) { this.claims.set(source, aiKey(key)); this.apply(); return; }
    if (!this.claims.has(source)) return;
    this.timers.set(source, setTimeout(() => { this.timers.delete(source); this.claims.delete(source); this.apply(); }, RELEASE_MS[source] ?? 500));
  }

  /** Let go at once (call ended, connection lost). */
  clear(source) { clearTimeout(this.timers.get(source)); this.timers.delete(source); if (this.claims.delete(source)) this.apply(); }

  apply() {
    const winner = ORDER.map((s) => this.claims.get(s)).find(Boolean) || DEFAULT_AI;
    if (winner === this.current && document.documentElement.dataset.ai === winner) return;
    this.current = winner;
    document.documentElement.dataset.ai = winner;
    for (const fn of this.listeners) { try { fn(this.persona); } catch (err) { console.error(err); } }
  }

  /** fn(persona) whenever the present AI changes; called once right away. Returns an unsubscribe. */
  watch(fn) { this.listeners.add(fn); fn(this.persona); return () => this.listeners.delete(fn); }
}

export const presence = new Presence();
