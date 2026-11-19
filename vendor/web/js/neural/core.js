// The neural core: Jarvis's brain on the stage. A living particle sphere with neurons, synapses
// and signals; it shows what he is doing and who is in front.
//
//   idle       slow breathing, a few signals
//   listening  ripples run over the surface with the owner's voice
//   thinking   signals race along the synapses, the core spins faster
//   speaking   it blinks with the voice: the core flashes on loud syllables and a wave of light
//              leaves it on each one
//   muted / offline   dim and quiet
// The present AI (core/presence.js) sets its colour and the shape of its inner layers.
//
// Same interface as the classic orb (js/orb.js), which stays as the fallback:
//   set(state, muted)  setMaxFps(fps)  setCovered(bool)  lift(up)  + setTier(tier)  setPersona(p)
// and the workspace's hooks: dock(on), beam(rect, dir), setLinks([{id, rect}]), pulseLink(id)
// and the agents at work: setAgents([{key, ping}]) -> moons orbiting the core; moonPositions()
// `createOrb` picks the neural core when the GPU allows it and falls back to the classic orb
// (which itself falls back to a 2D painter). `?orb=classic` forces the old one.

import { NeuralRenderer } from './renderer.js';
import { frames } from '../core/frames.js';
import { Orb } from '../orb.js';
import { personaOf } from '../core/personas.js';
import { CENTRE, DOCKED, SIDE, coreRadius } from '../workspace/dock.js';

const TAU = Math.PI * 2;
const MORPH_S = 1.6;              // seconds for the core to change shape when another AI steps in
const COLOR_RATE = 3.2;           // colour blend speed (per second, exponential)
const TIME_WRAP = 2000;           // shader time wraps (keeps float precision on long sessions)
const RINGS = [
  { tilt: 0.0, turn: 1.0, scale: 1.36, width: 1.1, alpha: 0.55 },
  { tilt: 1.15, turn: -0.7, scale: 1.56, width: 0.9, alpha: 0.38 },
  { tilt: -0.75, turn: 0.45, scale: 1.76, width: 0.8, alpha: 0.3 },
];
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

// rotation matrices into reused Float32Arrays (column-major, as WebGL wants)
function rotYX(out, ay, ax) {
  const cy = Math.cos(ay); const sy = Math.sin(ay); const cx = Math.cos(ax); const sx = Math.sin(ax);
  // R = Rx(ax) * Ry(ay)
  out[0] = cy; out[1] = sx * sy; out[2] = -cx * sy;
  out[3] = 0; out[4] = cx; out[5] = sx;
  out[6] = sy; out[7] = -sx * cy; out[8] = cx * cy;
  return out;
}
function rotZX(out, tilt, turn) {    // a ring: tilted about x, turning about its own axis
  const ct = Math.cos(tilt); const st = Math.sin(tilt); const cr = Math.cos(turn); const sr = Math.sin(turn);
  // R = Rx(tilt) * Ry(turn)
  out[0] = cr; out[1] = st * sr; out[2] = -ct * sr;
  out[3] = 0; out[4] = ct; out[5] = st;
  out[6] = sr; out[7] = -st * cr; out[8] = ct * cr;
  return out;
}

export class NeuralCore {
  /** Returns null when the GPU path is not available (the caller uses the classic orb). */
  static create(canvas, opts = {}) {
    const core = new NeuralCore(canvas, opts);
    return core.renderer ? core : null;
  }

  constructor(canvas, { micLevel, outLevel, tier = 'standard', onDead } = {}) {
    this.canvas = canvas; this.onDead = onDead;
    const allowSoftware = new URLSearchParams(location.search).get('orb') === 'neural';
    this.renderer = NeuralRenderer.create(canvas, { tier, allowSoftware, onLost: () => this.die() });
    if (!this.renderer) return;
    this.micLevel = micLevel || (() => 0); this.outLevel = outLevel || (() => 0);
    this.state = 'offline'; this.muted = false; this.covered = false;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.t = 0; this.spin = 0; this.energy = 0; this.activity = 0; this.listen = 0; this.blink = 0;
    this.lastOut = 0; this.waveT = -10; this.cy = CENTRE.cy; this.cyGoal = CENTRE.cy;
    this.docked = 0; this.dockGoal = 0; this.side = 0; this.sideGoal = 0;
    this.moons = new Map();   // agent key -> her moon (js/debrief/live.js says who is working)
    this.beams = []; this.links = new Map(); this.flow = 0;
    const jarvis = personaOf('jarvis');
    this.color = Float32Array.from(jarvis.rgb); this.color2 = Float32Array.from(jarvis.rgb2);
    this.goal = jarvis; this.sigA = 0; this.sigB = 0; this.morph = 1;
    // what the renderer is handed each frame (reused: nothing allocated per frame)
    this.p = { rot: new Float32Array(9), color: this.color, color2: this.color2, links: true,
      rings: RINGS.map((r) => ({ ...r, m: new Float32Array(9) })) };
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    this.resize();
    this.job = frames.add((now, dt) => this.frame(dt), { fps: 60 });
  }

  // ---- the orb interface ----------------------------------------------------------------------
  set(state, muted = false) { this.state = state; this.muted = muted; }
  setMaxFps(fps) { this.fps = fps; this.job?.setFps(this.idleCap(fps)); }
  setCovered(covered) { this.covered = covered; if (covered) this.job?.pause(); else this.job?.resume(); }
  lift(up) { this.cyGoal = up ? 0.31 : CENTRE.cy; }

  // ---- the workspace: the core docks, reaches out to panels and stays linked to them ------------
  /** Panels are open: shrink to the top centre (js/workspace/dock.js); none: back to the middle. */
  dock(on) { this.sideGoal = on === 'side' ? 1 : 0; this.dockGoal = on && on !== 'side' ? 1 : 0; this.job?.resume(); }
  /** Where the core is drawn now: { x, y, r } in CSS px (cards fly out of it and back into it). */
  point() { const p = this.p; return p && p.w ? { x: p.cx, y: p.cy, r: p.R } : null; }
  /** Particles stream to a panel's outline (dir 1, it is forming) or back into the core (dir -1). */
  beam(rect, dir = 1, ms = 520) {
    if (this.reduced || this.beams.length > 6) return;
    this.beams.push({ rect: [rect.x, rect.y, rect.w, rect.h], start: performance.now(), ms, dir, t: 0 });
  }
  /** The panels the core is linked to: [{ id, rect }] in CSS px (rect of each visible panel). */
  setLinks(list) {
    const keep = new Set();
    for (const { id, rect } of list) {
      keep.add(id);
      const l = this.links.get(id) || { p0: [0, 0], p1: [0, 0], c: [0, 0], alpha: 0, pulse: -1, pulseAt: 0, rect };
      l.rect = rect; this.links.set(id, l);
    }
    for (const id of [...this.links.keys()]) if (!keep.has(id)) this.links.delete(id);
  }
  // ---- agents at work: moons -------------------------------------------------------------------
  /** Who is working: [{key, ping}] (ping changes when her progress changes: the moon blinks). */
  setAgents(list) {
    const want = new Set();
    for (const a of list) {
      const p = personaOf(a.key); if (!p.ai || p.key === 'jarvis') continue;
      want.add(p.key);
      let m = this.moons.get(p.key);
      if (!m) {
        m = { key: p.key, persona: p, angle: Math.PI * 0.8 + this.moons.size * 2.1, alpha: 0, merge: 0, busy: true, blink: 0, ping: a.ping,
          q: { rot: new Float32Array(9), color: Float32Array.from(p.rgb), color2: Float32Array.from(p.rgb2), moons: null } };
        this.moons.set(p.key, m);
      }
      if (a.ping !== m.ping) { m.ping = a.ping; m.blink = 1; }
      m.busy = true;
    }
    for (const m of this.moons.values()) if (!want.has(m.key)) m.busy = false;
    this.job?.resume();
  }

  /** Where each moon is now, in CSS px (for its label): [{key, x, y, alpha, front}]. */
  moonPositions() { return [...this.moons.values()].map((m) => ({ key: m.key, x: m.q.cx, y: m.q.cy, r: m.q.R, alpha: m.alpha * (1 - m.merge), front: m.q.front })); }

  moonFrame(p, R, dt) {
    const list = p.moons || (p.moons = []); list.length = 0;
    for (const m of this.moons.values()) {
      m.alpha = lerp(m.alpha, m.busy ? 1 : 0, ease(m.busy ? 2.5 : 1.6, dt));
      if (!m.busy && m.alpha < 0.01) { this.moons.delete(m.key); continue; }
      // her presence takes the core: the moon flies in and the core becomes her; back out after
      m.merge = lerp(m.merge, this.goal.key === m.key ? 1 : 0, ease(2.6, dt));
      m.blink = Math.max(0, m.blink - dt * 1.6);
      m.angle += dt * (this.reduced ? 0.06 : 0.22);
      const ox = Math.cos(m.angle) * R * 2.05; const oy = Math.sin(m.angle) * R * 0.62;
      const depth = Math.sin(m.angle);                      // > 0 = the near half of the orbit
      const q = m.q; const k = 1 - m.merge;
      q.w = p.w; q.h = p.h; q.dpr = p.dpr; q.time = p.time; q.listen = 0; q.morph = 1;
      q.cx = p.cx + ox * k; q.cy = p.cy + oy * k; q.front = depth > 0 || m.merge > 0.5;
      q.R = R * (0.16 + 0.04 * depth) * (1 - 0.6 * m.merge); q.focal = q.R * 4.2;
      rotYX(q.rot, p.time * 0.9 + m.angle, 0.5);
      q.sigA = q.sigB = m.persona.signature;
      q.energy = 0.35 + 0.25 * Math.sin(p.time * 3 + m.angle) + m.blink * 0.5;
      q.waveR = 0.25 + (1 - m.blink) * 1.8; q.waveA = m.blink * 0.8;
      q.blink = m.blink; q.alpha = m.alpha * k;
      q.dim = q.alpha * (0.7 + 0.3 * depth); q.links = false;
      q.hr = q.R * 3.2; q.haloA = 0.22 * q.alpha * (1 + m.blink);
      q.coreR = q.R * (0.3 + m.blink * 0.2); q.coreA = 0.8 * q.alpha; q.hairR = q.R * 1.9; q.hairA = 0.18 * q.alpha;
      list.push(q);
    }
  }

  /** Jarvis acted on this panel: a pulse runs from the core along its link. */
  pulseLink(id) { const l = this.links.get(id); if (l) { l.pulseAt = performance.now(); this.job?.resume(); } }
  /** Quality tier from the governor: fewer particles, no synapses in lite. */
  setTier(tier) { this.renderer?.setTier(tier); }
  /** The AI in front (core/presence.js): colour and inner shape follow. */
  setPersona(p) {
    if (!p || p.key === this.goal.key) return;
    // start the morph from wherever the core is now
    this.sigA = this.morph >= 0.5 ? this.sigB : this.sigA; this.sigB = p.signature; this.morph = this.reduced ? 1 : 0;
    this.goal = p;
  }

  idleCap(fps = this.fps || 60) {
    // when nothing is happening the core breathes slowly: 30 frames a second is plenty
    const moving = this.moons.size > 0 || this.beams.length > 0 || Math.abs(this.docked - this.dockGoal) > 0.002 || Math.abs(this.side - this.sideGoal) > 0.002;
    const busy = moving || this.state === 'speaking' || this.state === 'thinking' || this.state === 'listening' || this.morph < 1;
    if (this.side > 0.5) return Math.min(fps, 40);   // a debrief is up: its cards and the voice need the GPU more than 60 fps of particles
    return busy ? fps : Math.min(fps, 30);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);   // soft light: 1.25x looks the same, far fewer pixels
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.w = w; this.h = h; this.dpr = dpr; this.box = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.renderer?.resize(this.canvas.width, this.canvas.height);
  }

  die() { this.job?.remove(); this.ro?.disconnect(); this.renderer = null; this.onDead?.(); }

  mode() {
    if (this.state === 'offline') return 'offline';
    if (this.muted && this.state !== 'speaking' && this.state !== 'thinking') return 'muted';
    return ['listening', 'thinking', 'speaking'].includes(this.state) ? this.state : 'idle';
  }

  // ---- one frame --------------------------------------------------------------------------------
  frame(dt) {
    if (!this.renderer || !this.w) return;
    const slow = this.reduced ? 0.3 : 1;
    this.t = (this.t + dt * slow) % TIME_WRAP;
    const mode = this.mode(); const mic = this.micLevel(); const out = this.outLevel();

    let energy = 0.14 + 0.05 * Math.sin(this.t * 1.4) + Math.min(0.4, mic * 3);
    let activity = 0.12; let listen = 0;
    if (mode === 'listening') { energy = Math.min(1, 0.28 + mic * 5); activity = 0.3; listen = Math.min(1, mic * 7); }
    else if (mode === 'thinking') { energy = 0.5 + 0.12 * Math.sin(this.t * 5); activity = 1; }
    else if (mode === 'speaking') { energy = Math.min(1, 0.3 + out * 4.5); activity = 0.45; }
    else if (mode === 'muted' || mode === 'offline') { energy = 0.05; activity = 0; }
    this.energy = lerp(this.energy, energy, ease(energy > this.energy ? 16 : 5, dt));
    this.activity = lerp(this.activity, activity, ease(3, dt));
    this.listen = lerp(this.listen, listen, ease(listen > this.listen ? 14 : 4, dt));

    // blink: fast attack, slower release on his voice; a wave leaves the core on each loud syllable
    const env = mode === 'speaking' ? Math.min(1, out * 5) : 0;
    this.blink = lerp(this.blink, env, ease(env > this.blink ? 30 : 7, dt));
    if (mode === 'speaking' && out > 0.07 && out > this.lastOut * 1.35 && this.t - this.waveT > 0.16) this.waveT = this.t;
    this.lastOut = lerp(this.lastOut, out, ease(12, dt));
    const age = this.t - this.waveT;
    const waveR = 0.25 + age * 1.9; const waveA = age >= 0 && age < 0.9 ? (1 - age / 0.9) * 0.9 : 0;

    // colour and shape of whoever is in front
    const k = ease(COLOR_RATE, dt);
    for (let i = 0; i < 3; i++) { this.color[i] = lerp(this.color[i], this.goal.rgb[i], k); this.color2[i] = lerp(this.color2[i], this.goal.rgb2[i], k); }
    if (this.morph < 1) this.morph = Math.min(1, this.morph + dt / MORPH_S);
    this.job.setFps(this.idleCap());

    const speed = (mode === 'thinking' ? 1.9 : mode === 'speaking' ? 0.8 : mode === 'listening' ? 0.6 : 0.28) * slow;
    this.spin += dt * speed;
    this.cy = lerp(this.cy, this.cyGoal, ease(4, dt));
    this.docked = lerp(this.docked, this.dockGoal, ease(3.2, dt));
    this.side = lerp(this.side, this.sideGoal, ease(3.2, dt));

    const { p, w, h } = this;
    const lifted = Math.min(1, (CENTRE.cy - this.cy) / 0.14);               // the file deck lifts it a little
    const scale = lerp(lerp(1 - lifted * 0.16, DOCKED.scale, this.docked), SIDE.scale, this.side);
    const R = coreRadius(w, h, scale);
    const cyNow = lerp(lerp(this.cy, DOCKED.cy, this.docked), SIDE.cy, this.side);
    const cxNow = lerp(w / 2, w * SIDE.cx, this.side);
    const dim = mode === 'muted' || mode === 'offline' ? 0.45 : 1;
    const flash = this.reduced ? 0 : this.blink;
    p.w = w; p.h = h; p.dpr = this.dpr; p.cx = cxNow; p.cy = h * cyNow; p.R = R; p.focal = R * 4.2;
    rotYX(p.rot, this.spin, 0.42 + 0.1 * Math.sin(this.t * 0.37));
    p.time = this.t; p.energy = this.energy; p.listen = this.listen; p.activity = this.activity;
    p.waveR = waveR; p.waveA = this.reduced ? 0 : waveA * dim; p.blink = flash;
    p.sigA = this.sigA; p.sigB = this.sigB; p.morph = this.morph; p.dim = dim;
    p.hr = R * (2.1 + this.energy * 0.8); p.haloA = Math.min(1, (0.16 + flash * 0.16) * dim);
    p.coreR = R * (0.2 + this.energy * 0.12 + flash * 0.08);
    p.coreA = Math.min(1, (0.75 + flash * 0.25 + 0.1 * Math.sin(this.t * 2.2)) * dim);
    p.hairR = R * (1.95 + this.energy * 0.3); p.hairA = Math.min(1, (0.16 + this.energy * 0.45) * dim);
    p.ringAlpha = (0.55 + this.energy * 0.5) * dim;
    for (let i = 0; i < RINGS.length; i++) {
      const ring = p.rings[i]; rotZX(ring.m, ring.tilt, this.spin * ring.turn * 1.3);
      ring.scale = RINGS[i].scale + this.energy * 0.08 * Math.sin(this.t * 3 + i);
    }
    this.workspace(p, R);
    this.moonFrame(p, R, dt);
    this.renderer.draw(p);
  }

  // beams and tendrils for this frame (reused objects; finished beams dropped)
  workspace(p, R) {
    const now = performance.now();
    this.beams = this.beams.filter((b) => { b.t = (now - b.start) / b.ms; return b.t < 1; });
    p.beams = this.beams;
    this.flow = (this.flow + 0.008) % 1; p.flow = this.flow * 1.0;
    const tendrils = p.tendrils || (p.tendrils = []); tendrils.length = 0;
    const reach = Math.max(this.docked, this.side);
    if (reach < 0.05) return;
    const box = this.box || { left: 0, top: 0 };   // measured on resize, never per frame
    for (const l of this.links.values()) {
      const r = l.rect; const x0 = r.x - box.left; const y0 = r.y - box.top;
      // the nearest point of the panel's outline to the core, and a point just outside the core
      const ax = Math.max(x0, Math.min(p.cx, x0 + r.w)); const ay = Math.max(y0, Math.min(p.cy, y0 + r.h));
      const dx = ax - p.cx; const dy = ay - p.cy; const len = Math.hypot(dx, dy) || 1;
      if (len < R * 1.4) continue;                                          // the panel is over the core
      l.p0[0] = p.cx + (dx / len) * R * 1.12; l.p0[1] = p.cy + (dy / len) * R * 1.12;
      l.p1[0] = ax; l.p1[1] = ay;
      l.c[0] = (l.p0[0] + ax) / 2 - (dy / len) * len * 0.12; l.c[1] = (l.p0[1] + ay) / 2 + (dx / len) * len * 0.12 + len * 0.06;
      l.alpha = reach * (this.reduced ? 0.6 : 1);
      const age = (now - l.pulseAt) / 650; l.pulse = age >= 0 && age <= 1.1 ? age : -1;
      tendrils.push(l);
    }
  }
}

/**
 * The stage's core: the neural core when the GPU allows it, otherwise the classic orb.
 * Returns an object with the orb interface that swaps itself to the classic orb if the GPU gives up.
 */
export function createOrb(canvas, opts) {
  const forced = new URLSearchParams(location.search).get('orb');
  const host = {
    impl: null, persona: null, tier: 'standard', state: ['offline', false], fps: 60, covered: false, up: false,
    set(state, muted) { this.state = [state, muted]; this.impl.set(state, muted); },
    setMaxFps(fps) { this.fps = fps; this.impl.setMaxFps(fps); },
    setCovered(c) { this.covered = c; this.impl.setCovered(c); },
    lift(up) { this.up = up; this.impl.lift(up); },
    setTier(tier) { this.tier = tier; this.impl.setTier?.(tier); },
    setPersona(p) { this.persona = p; this.impl.setPersona?.(p); },
    dock(on) { this.docked = on; if (this.impl.dock) this.impl.dock(on); else this.impl.lift(on || this.up); },
    beam(rect, dir) { this.impl.beam?.(rect, dir); },
    setLinks(list) { this.impl.setLinks?.(list); },
    pulseLink(id) { this.impl.pulseLink?.(id); },
    setAgents(list) { this.impl.setAgents?.(list); },
    moonPositions() { return this.impl.moonPositions?.() || null; },
    point() {
      const w = innerWidth; const h = innerHeight;
      return this.impl.point?.() || { x: w / 2, y: h * (this.docked ? 0.135 : 0.45), r: Math.min(w, h * 0.9) * 0.19 * (this.docked ? 0.42 : 1) };
    },
    get kind() { return this.impl instanceof NeuralCore ? 'neural' : 'classic'; },
  };
  const classic = (target) => new Orb(target, opts);
  const toClassic = () => {
    const fresh = canvas.cloneNode(false); canvas.replaceWith(fresh);   // a dead GL canvas cannot be reused
    host.impl = classic(fresh);
    host.impl.set(...host.state); host.impl.setMaxFps(host.fps); host.impl.lift(host.up || !!host.docked); host.impl.setCovered(host.covered);
  };
  if (forced !== 'classic' && forced !== '2d') host.impl = NeuralCore.create(canvas, { ...opts, onDead: toClassic });
  if (!host.impl) host.impl = classic(canvas);
  return host;
}
