// The Jarvis orb: a 3D sphere of light with orbiting rings and a glowing core, drawn on a canvas.
// It breathes when idle, pulses with your voice when listening, spins when thinking and beats
// with his voice when speaking. Real 3D maths (rotation + perspective).
//
// Two painters, same picture: WebGL (orb-gl.js: the GPU does the geometry, the main thread only sends
// ~30 numbers per frame) and a 2D-canvas painter below, used when WebGL is unavailable or the GPU
// context is lost for good. `?orb=2d` forces the 2D painter, `?orb=gl` allows software WebGL.

import { OrbGL } from './orb-gl.js';

const TAU = Math.PI * 2;
const POINTS = 420;
const RING_SEGMENTS = 140;
const LEVELS = 16;          // alpha steps: dots and ring segments are drawn in one path per step, not one call each

const PALETTE = {
  idle: [76, 201, 240],
  listening: [94, 234, 212],
  thinking: [167, 139, 250],
  speaking: [140, 225, 255],
  muted: [100, 116, 139],
  offline: [71, 85, 105],
};

const RINGS = [
  { tilt: 0.0, turn: 1.0, scale: 1.32, width: 1.6 },
  { tilt: 1.15, turn: -0.7, scale: 1.52, width: 1.2 },
  { tilt: -0.75, turn: 0.45, scale: 1.72, width: 1 },
];

const lerp = (a, b, t) => a + (b - a) * t;
const level = (a) => Math.max(0, Math.min(LEVELS - 1, Math.round(a * (LEVELS - 1))));

function fibonacciSphere(n) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r, Math.random() * TAU]);
  }
  return pts;
}

export class Orb {
  constructor(canvas, { micLevel, outLevel } = {}) {
    this.canvas = canvas;
    const forced = new URLSearchParams(location.search).get('orb');
    this.gl = forced === '2d' ? null : OrbGL.create(canvas, fibonacciSphere(POINTS), RING_SEGMENTS, { onLost: () => this.fallback(), allowSoftware: forced === 'gl' });
    this.ctx = this.gl ? null : canvas.getContext('2d');
    if (!this.gl && !this.ctx) this.fallback();      // a failed WebGL attempt can leave the canvas unusable for 2D: start from a fresh one
    this.micLevel = micLevel || (() => 0); this.outLevel = outLevel || (() => 0);
    this.state = 'offline'; this.muted = false; this.cy = 0.45; this.cyGoal = 0.45;
    this.color = [...PALETTE.offline]; this.energy = 0; this.spin = 0; this.t = 0; this.last = 0;
    this.points = this.gl ? this.gl.points : fibonacciSphere(POINTS);
    this.params = { color: [0, 0, 0], rings: [{}, {}, {}] };   // what the GPU painter is handed each frame (reused)
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize = this.resize.bind(this); this.frame = this.frame.bind(this);
    // Scratch buffers, allocated once: nothing is allocated per frame, so the garbage collector never stalls the page.
    this.dotX = new Float32Array(POINTS); this.dotY = new Float32Array(POINTS); this.dotS = new Float32Array(POINTS);
    this.dotL = new Uint8Array(POINTS);
    this.segX0 = new Float32Array(RING_SEGMENTS); this.segY0 = new Float32Array(RING_SEGMENTS);
    this.segX1 = new Float32Array(RING_SEGMENTS); this.segY1 = new Float32Array(RING_SEGMENTS);
    this.segL = new Uint8Array(RING_SEGMENTS); this.lvlK = new Float32Array(LEVELS); this.lvlN = new Uint16Array(LEVELS);
    this.px = 0; this.py = 0; this.pz = 0; this.pk = 0;          // result of project()
    this.cosY = 1; this.sinY = 0; this.cosX = 1; this.sinX = 0; this.focal = 1; this.ox = 0; this.oy = 0; this.R = 1;
    this.raf = 0; this.minGap = 0; this.lastDraw = 0; this.covered = false;
    this.ro = new ResizeObserver(this.resize); this.ro.observe(this.canvas);
    // A hidden page draws nothing and schedules nothing; coming back resumes without a time jump.
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); else this.resume(); });
    this.resize(); this.resume();
  }

  resume() { if (!this.raf && !document.hidden && !this.covered) { this.last = 0; this.raf = requestAnimationFrame(this.frame); } }

  /** Draw at most this many frames a second (the quality governor lowers it on slow machines). */
  setMaxFps(fps) { this.minGap = fps >= 60 ? 0 : 1000 / fps - 2; }

  /** A full-screen portal hides the orb: draw nothing until it is visible again. */
  setCovered(covered) { this.covered = covered; if (covered) this.pause(); else this.resume(); }

  pause() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }

  lift(up) { this.cyGoal = up ? 0.31 : 0.45; }

  set(state, muted = false) { this.state = state; this.muted = muted; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // soft glow: 1.5x looks the same and costs ~45% fewer pixels
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
    if (this.gl) this.gl.resize(this.canvas.width, this.canvas.height);
  }

  // The GPU context was lost and did not come back: carry on with the 2D painter on a fresh canvas.
  fallback() {
    this.gl = null;
    const next = this.canvas.cloneNode(false);
    this.canvas.replaceWith(next);
    if (this.ro) { this.ro.disconnect(); this.ro.observe(next); }
    this.canvas = next; this.ctx = next.getContext('2d');
    if (this.w) this.resize();
  }

  mode() {
    if (this.state === 'offline') return 'offline';
    if (this.muted && this.state !== 'speaking' && this.state !== 'thinking') return 'muted';
    return this.state === 'listening' || this.state === 'thinking' || this.state === 'speaking' ? this.state : 'idle';
  }

  frame(now) {
    this.raf = document.hidden ? 0 : requestAnimationFrame(this.frame);
    if (document.hidden || !this.w) return;
    if (this.minGap && now - this.lastDraw < this.minGap) return;
    this.lastDraw = now;
    const dt = Math.min((now - (this.last || now)) / 1000, 0.05); this.last = now;
    const slow = this.reduced ? 0.3 : 1;
    this.t += dt;
    const mode = this.mode();

    // Energy: how alive the orb looks right now (0..1).
    let target = 0.12 + 0.06 * Math.sin(this.t * 1.6);
    if (mode === 'listening') target = Math.min(1, 0.25 + this.micLevel() * 5);
    else if (mode === 'idle') target = 0.14 + 0.06 * Math.sin(this.t * 1.4) + Math.min(0.5, this.micLevel() * 3);
    else if (mode === 'thinking') target = 0.45 + 0.15 * Math.sin(this.t * 5);
    else if (mode === 'speaking') target = Math.min(1, 0.3 + this.outLevel() * 4.5);
    else if (mode === 'muted' || mode === 'offline') target = 0.05;
    this.energy = lerp(this.energy, target, 1 - Math.exp(-dt * (target > this.energy ? 18 : 6)));

    const goal = PALETTE[mode];
    for (let i = 0; i < 3; i++) this.color[i] = lerp(this.color[i], goal[i], 1 - Math.exp(-dt * 5));
    const speed = (mode === 'thinking' ? 2.4 : mode === 'speaking' ? 1.1 : mode === 'listening' ? 0.8 : 0.35) * slow;
    this.spin += dt * speed;
    this.cy = lerp(this.cy, this.cyGoal, 1 - Math.exp(-dt * 4));
    this.draw(mode);
  }

  // Rotates and projects a point into this.px/py/pz/pk (fields, not a returned array: no allocation).
  project(x, y, z) {
    const x1 = x * this.cosY + z * this.sinY; const z1 = -x * this.sinY + z * this.cosY;
    const y2 = y * this.cosX - z1 * this.sinX; const z2 = y * this.sinX + z1 * this.cosX;
    const k = this.focal / (this.focal + z2 * this.R);
    this.px = this.ox + x1 * this.R * k; this.py = this.oy + y2 * this.R * k; this.pz = z2; this.pk = k;
  }

  draw(mode) {
    if (this.gl) this.paintGL(mode); else this.paint2d(mode);
  }

  // GPU painter: work out this frame's numbers (the same ones paint2d uses) and hand them over.
  paintGL(mode) {
    const { w, h, dpr, energy, t, params: p } = this;
    const cx = w / 2; const cy = h * this.cy;
    const R = Math.min(w, h * 0.9) * (0.17 - Math.min(1, (0.45 - this.cy) / 0.14) * 0.025);
    const dim = mode === 'muted' || mode === 'offline' ? 0.55 : 1;
    const rate = mode === 'speaking' ? 9 : mode === 'listening' ? 5 : mode === 'thinking' ? 7 : 1.8;
    const blink = this.reduced ? 1 : 0.8 + 0.2 * Math.sin(t * rate) * (0.4 + energy);
    const unit = (a) => Math.max(0, Math.min(1, a));
    const ay = this.spin; const ax = 0.45 + 0.12 * Math.sin(t * 0.4);
    p.w = w; p.h = h; p.dpr = dpr; p.cx = cx; p.cy = cy; p.R = R; p.focal = R * 4.2;
    p.sinY = Math.sin(ay); p.cosY = Math.cos(ay); p.sinX = Math.sin(ax); p.cosX = Math.cos(ax);
    p.color[0] = Math.round(this.color[0]); p.color[1] = Math.round(this.color[1]); p.color[2] = Math.round(this.color[2]);
    p.energy = energy; p.dim = dim; p.ripple = (t * (mode === 'speaking' ? 11 : 3)) % TAU;
    p.hr = R * (2.3 + energy * 0.9); p.coreR = R * (0.34 + energy * 0.22) * (0.94 + 0.06 * blink); p.hairR = R * (2.0 + energy * 0.35);
    p.haloA0 = unit(0.22 * blink * dim); p.haloA1 = unit(0.07 * dim);
    p.coreA0 = unit(0.95 * blink * dim); p.coreA1 = unit(0.85 * blink * dim); p.hairA = unit((0.25 + energy * 0.6) * dim);
    for (let i = 0; i < RINGS.length; i++) {
      const ring = RINGS[i]; const r = p.rings[i]; const rot = this.spin * ring.turn * 1.4;
      r.cT = Math.cos(ring.tilt); r.sT = Math.sin(ring.tilt); r.cR = Math.cos(rot); r.sR = Math.sin(rot);
      r.scale = ring.scale + energy * 0.12 * Math.sin(t * 3 + i); r.width = ring.width;
    }
    this.gl.draw(p);
  }

  paint2d(mode) {
    const { ctx, w, h, dpr, energy, t } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const cx = w / 2; const cy = h * this.cy;
    const R = Math.min(w, h * 0.9) * (0.17 - Math.min(1, (0.45 - this.cy) / 0.14) * 0.025);
    const r = Math.round(this.color[0]); const g = Math.round(this.color[1]); const b = Math.round(this.color[2]);
    const rgba = (a) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
    const dim = mode === 'muted' || mode === 'offline' ? 0.55 : 1;

    // Blink: his core flickers faster the more he is doing.
    const rate = mode === 'speaking' ? 9 : mode === 'listening' ? 5 : mode === 'thinking' ? 7 : 1.8;
    const blink = this.reduced ? 1 : 0.8 + 0.2 * Math.sin(t * rate) * (0.4 + energy);

    // Halo
    const hr = R * (2.3 + energy * 0.9);
    const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, hr);
    halo.addColorStop(0, rgba(0.22 * blink * dim)); halo.addColorStop(0.5, rgba(0.07 * dim)); halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo; ctx.fillRect(cx - hr, cy - hr, hr * 2, hr * 2);   // only the halo's box, not the whole screen

    const ay = this.spin; const ax = 0.45 + 0.12 * Math.sin(t * 0.4);
    this.sinY = Math.sin(ay); this.cosY = Math.cos(ay); this.sinX = Math.sin(ax); this.cosX = Math.cos(ax);
    this.focal = R * 4.2; this.ox = cx; this.oy = cy; this.R = R;

    // Batched by alpha step: hundreds of separate fills/strokes per frame starve the audio thread on weak GPUs.
    const { dotX, dotY, dotS, dotL, segX0, segY0, segX1, segY1, segL, lvlK, lvlN } = this;

    // Sphere of points; the surface ripples with energy.
    const spin = t * (mode === 'speaking' ? 11 : 3);
    for (let i = 0; i < POINTS; i++) {
      const p = this.points[i];
      const ripple = 1 + energy * 0.14 * Math.sin(p[3] + spin) + energy * 0.05;
      this.project(p[0] * ripple, p[1] * ripple, p[2] * ripple);
      const depth = (this.pz + 1) / 2;
      dotX[i] = this.px; dotY[i] = this.py;
      dotS[i] = (0.7 + 1.3 * this.pk) * (1 + energy * 0.5);
      dotL[i] = level((0.1 + 0.75 * (1 - depth)) * dim * (0.55 + energy * 0.6));
    }
    for (let l = 0; l < LEVELS; l++) {
      let open = false;
      for (let i = 0; i < POINTS; i++) {
        if (dotL[i] !== l) continue;
        if (!open) { ctx.beginPath(); open = true; }
        ctx.moveTo(dotX[i] + dotS[i], dotY[i]); ctx.arc(dotX[i], dotY[i], dotS[i], 0, TAU);
      }
      if (open) { ctx.fillStyle = rgba(l / (LEVELS - 1)); ctx.fill(); }
    }

    // Three orbiting rings on different axes (a gyroscope).
    for (let idx = 0; idx < RINGS.length; idx++) {
      const ring = RINGS[idx];
      lvlK.fill(0); lvlN.fill(0);
      const scale = ring.scale + energy * 0.12 * Math.sin(t * 3 + idx);
      const rot = this.spin * ring.turn * 1.4;
      const cT = Math.cos(ring.tilt); const sT = Math.sin(ring.tilt); const cR = Math.cos(rot); const sR = Math.sin(rot);
      let n = 0; let prevX = 0; let prevY = 0;
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * TAU;
        const x0 = Math.cos(a) * scale; const z0 = Math.sin(a) * scale;
        const y1 = -z0 * sT; const z1 = z0 * cT;
        this.project(x0 * cR - y1 * sR, x0 * sR + y1 * cR, z1);
        if (i > 0) {
          const depth = (this.pz / scale + 1) / 2;
          const l = level((0.1 + 0.55 * (1 - depth)) * dim * (0.5 + energy * 0.7));
          segL[n] = l; lvlK[l] += this.pk; lvlN[l] += 1;
          segX0[n] = prevX; segY0[n] = prevY; segX1[n] = this.px; segY1[n] = this.py; n++;
        }
        prevX = this.px; prevY = this.py;
      }
      for (let l = 0; l < LEVELS; l++) {
        if (!lvlN[l]) continue;
        ctx.beginPath();
        for (let i = 0; i < n; i++) if (segL[i] === l) { ctx.moveTo(segX0[i], segY0[i]); ctx.lineTo(segX1[i], segY1[i]); }
        ctx.lineWidth = ring.width * (0.6 + 0.7 * lvlK[l] / lvlN[l]);   // nearer segments are thicker
        ctx.strokeStyle = rgba(l / (LEVELS - 1)); ctx.stroke();
      }
    }

    // Core
    const coreR = R * (0.34 + energy * 0.22) * (0.94 + 0.06 * blink);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
    core.addColorStop(0, `rgba(255,255,255,${(0.95 * blink * dim).toFixed(3)})`);
    core.addColorStop(0.25, rgba(0.85 * blink * dim)); core.addColorStop(1, rgba(0));
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, coreR * 2.4, 0, TAU); ctx.fill();

    // A hairline ring that breathes with the voice.
    ctx.strokeStyle = rgba((0.25 + energy * 0.6) * dim); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R * (2.0 + energy * 0.35), 0, TAU); ctx.stroke();
  }
}
