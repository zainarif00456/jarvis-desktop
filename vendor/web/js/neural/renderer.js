// WebGL painter for the neural core: compiles the shaders, holds the static buffers of one quality
// tier and draws a frame from a parameter object (NeuralCore.frame fills it; nothing is allocated
// here per frame). Returns null from `create` when this machine should not run it (no WebGL, or
// only a slow software WebGL): the caller then uses the classic orb.

import { POINTS_VS, POINTS_FS, LINKS_VS, LINKS_FS, GLOW_VS, GLOW_FS, RING_VS, RING_FS, BEAM_VS, BEAM_FS, TENDRIL_VS, TENDRIL_FS } from './shaders.js';
import { buildCore, buildMoon, TIERS } from './geometry.js';

const RING_SEGMENTS = 128;
const BEAM_PARTICLES = 360;
const TENDRIL_STEPS = 48;
const NODE_UNIFORMS = ['u_size', 'u_origin', 'u_R', 'u_focal', 'u_rot', 'u_time', 'u_energy', 'u_listen', 'u_waveR', 'u_waveA', 'u_sigA', 'u_sigB', 'u_morph', 'u_dim', 'u_color', 'u_color2'];

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`shader: ${log}`); }
  return shader;
}

function program(gl, vs, fs, uniforms, attribs) {
  const prog = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs); const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  const u = {}; for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  const a = {}; for (const name of attribs) a[name] = gl.getAttribLocation(prog, name);
  return { prog, u, a };
}

export class NeuralRenderer {
  static create(canvas, { tier = 'standard', allowSoftware = false, onLost } = {}) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: !allowSoftware,
      });
    } catch { gl = null; }
    if (!gl) return null;
    try { return new NeuralRenderer(canvas, gl, tier, onLost); } catch (error) {
      console.warn('neural core: WebGL setup failed, using the classic orb:', error.message); return null;
    }
  }

  constructor(canvas, gl, tier, onLost) {
    this.canvas = canvas; this.gl = gl; this.tier = tier; this.onLost = onLost; this.lost = false; this.dead = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); this.lost = true;
      this.restoreTimer = setTimeout(() => { if (this.lost) { this.dead = true; this.onLost?.(); } }, 2500);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      clearTimeout(this.restoreTimer);
      try { this.build(); this.lost = false; } catch { this.dead = true; this.onLost?.(); }
    });
    this.build();
  }

  build() {
    const { gl } = this;
    this.pointsProg = program(gl, POINTS_VS, POINTS_FS, [...NODE_UNIFORMS, 'u_dpr', 'u_blink', 'u_size0'], ['a_p', 'a_r']);
    this.linksProg = program(gl, LINKS_VS, LINKS_FS, [...NODE_UNIFORMS, 'u_activity'], ['a_p', 'a_r', 'a_l']);
    this.glowProg = program(gl, GLOW_VS, GLOW_FS, ['u_size', 'u_center', 'u_half', 'u_color', 'u_color2', 'u_R', 'u_hr', 'u_coreR', 'u_hairR', 'u_haloA', 'u_coreA', 'u_hairA', 'u_dpr', 'u_waveR', 'u_waveA'], ['a_q']);
    this.ringProg = program(gl, RING_VS, RING_FS, ['u_size', 'u_origin', 'u_R', 'u_focal', 'u_segs', 'u_scale', 'u_width', 'u_alpha', 'u_rot', 'u_ring', 'u_color', 'u_dpr'], ['a_seg']);
    const corners = [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]];
    const seg = new Float32Array(RING_SEGMENTS * corners.length * 3);
    let o = 0;
    for (let i = 0; i < RING_SEGMENTS; i++) for (const [end, side] of corners) { seg[o++] = i; seg[o++] = end; seg[o++] = side; }
    this.segBuf = this.buffer(seg); this.segCount = RING_SEGMENTS * corners.length;
    this.quadBuf = this.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    // the workspace effects: beams (panel forming / closing) and tendrils (core -> panel)
    this.beamProg = program(gl, BEAM_VS, BEAM_FS, ['u_size', 'u_from', 'u_rect', 'u_t', 'u_dir', 'u_dpr', 'u_size0', 'u_color', 'u_color2'], ['a_r']);
    this.tendrilProg = program(gl, TENDRIL_VS, TENDRIL_FS, ['u_size', 'u_p0', 'u_p1', 'u_c', 'u_color', 'u_color2', 'u_alpha', 'u_flow', 'u_pulse'], ['a_t']);
    const beam = new Float32Array(BEAM_PARTICLES * 4);
    for (let i = 0; i < beam.length; i++) beam[i] = Math.random();
    this.beamBuf = this.buffer(beam);
    const moon = buildMoon();   // agents' moons (small spheres orbiting the core)
    this.moonBuf = this.buffer(moon.p); this.moonRand = this.buffer(moon.r); this.moonCount = moon.count;
    this.tendrilBuf = this.buffer(Float32Array.from({ length: TENDRIL_STEPS + 1 }, (_, i) => i / TENDRIL_STEPS));
    this.setTier(this.tier, true);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);   // light adds up (premultiplied colours)
    gl.clearColor(0, 0, 0, 0);
  }

  buffer(data) {
    const { gl } = this; const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  /** New particle/link buffers for a quality tier (rare: the governor changes tier at most every few seconds). */
  setTier(tier, force = false) {
    if (!TIERS[tier] || (tier === this.tier && !force && this.nodeBuf)) return;
    const { gl } = this;
    for (const b of [this.nodeBuf, this.randBuf, this.linkBuf]) if (b) gl.deleteBuffer(b);
    const core = buildCore(tier);
    this.tier = tier; this.spec = TIERS[tier];
    this.nodeBuf = this.buffer(core.p); this.randBuf = this.buffer(core.r); this.count = core.count;
    this.linkBuf = core.link ? this.buffer(core.link) : null; this.linkVerts = core.linkVerts;
  }

  resize(w, h) { this.gl.viewport(0, 0, w, h); }

  nodeUniforms(u, p) {
    const { gl } = this;
    gl.uniform2f(u.u_size, p.w, p.h); gl.uniform2f(u.u_origin, p.cx, p.cy);
    gl.uniform1f(u.u_R, p.R); gl.uniform1f(u.u_focal, p.focal); gl.uniformMatrix3fv(u.u_rot, false, p.rot);
    gl.uniform1f(u.u_time, p.time); gl.uniform1f(u.u_energy, p.energy); gl.uniform1f(u.u_listen, p.listen);
    gl.uniform1f(u.u_waveR, p.waveR); gl.uniform1f(u.u_waveA, p.waveA);
    gl.uniform1f(u.u_sigA, p.sigA); gl.uniform1f(u.u_sigB, p.sigB); gl.uniform1f(u.u_morph, p.morph);
    gl.uniform1f(u.u_dim, p.dim); gl.uniform3fv(u.u_color, p.color); gl.uniform3fv(u.u_color2, p.color2);
  }

  attrib(loc, buf, size, stride = 0, offset = 0) {
    if (loc < 0) return;
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  }
  detach(...locs) { for (const l of locs) if (l >= 0) this.gl.disableVertexAttribArray(l); }

  /** p: the frame's numbers (see NeuralCore.frame). */
  draw(p) {
    if (this.lost || this.dead) return;
    const { gl } = this;
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawTendrils(p);
    this.drawMoons(p, false);   // moons on the far side of their orbit, behind the core
    this.drawGlow(p);

    // synapses (lines), then the particles over them
    if (this.linkBuf && p.links) {
      const l = this.linksProg; gl.useProgram(l.prog);
      this.nodeUniforms(l.u, p); gl.uniform1f(l.u.u_activity, p.activity);
      const stride = 40;
      this.attrib(l.a.a_p, this.linkBuf, 4, stride, 0); this.attrib(l.a.a_r, this.linkBuf, 4, stride, 16); this.attrib(l.a.a_l, this.linkBuf, 2, stride, 32);
      gl.drawArrays(gl.LINES, 0, this.linkVerts);
      this.detach(l.a.a_p, l.a.a_r, l.a.a_l);
    }
    this.drawPoints(p, this.nodeBuf, this.randBuf, this.count, this.spec.size);

    // the gyroscope rings
    if (this.spec.rings && p.ringAlpha > 0.003) {
      const r = this.ringProg; gl.useProgram(r.prog);
      gl.uniform2f(r.u.u_size, p.w, p.h); gl.uniform2f(r.u.u_origin, p.cx, p.cy);
      gl.uniform1f(r.u.u_R, p.R); gl.uniform1f(r.u.u_focal, p.focal); gl.uniform1f(r.u.u_segs, RING_SEGMENTS);
      gl.uniformMatrix3fv(r.u.u_rot, false, p.rot); gl.uniform3fv(r.u.u_color, p.color); gl.uniform1f(r.u.u_dpr, p.dpr);
      this.attrib(r.a.a_seg, this.segBuf, 3);
      for (const ring of p.rings) {
        gl.uniformMatrix3fv(r.u.u_ring, false, ring.m); gl.uniform1f(r.u.u_scale, ring.scale);
        gl.uniform1f(r.u.u_width, ring.width); gl.uniform1f(r.u.u_alpha, p.ringAlpha * ring.alpha);
        gl.drawArrays(gl.TRIANGLES, 0, this.segCount);
      }
      this.detach(r.a.a_seg);
    }
    this.drawMoons(p, true);    // moons passing in front
    this.drawBeams(p);
  }

  /** Halo, core, hairline and the speaking wave's ring around a centre (the core, or a moon). */
  drawGlow(p) {
    const { gl } = this; const g = this.glowProg; gl.useProgram(g.prog);
    gl.uniform2f(g.u.u_size, p.w, p.h); gl.uniform2f(g.u.u_center, p.cx, p.cy); gl.uniform1f(g.u.u_half, p.hr + 4);
    gl.uniform3fv(g.u.u_color, p.color); gl.uniform3fv(g.u.u_color2, p.color2);
    gl.uniform1f(g.u.u_R, p.R); gl.uniform1f(g.u.u_hr, p.hr); gl.uniform1f(g.u.u_coreR, p.coreR); gl.uniform1f(g.u.u_hairR, p.hairR);
    gl.uniform1f(g.u.u_haloA, p.haloA); gl.uniform1f(g.u.u_coreA, p.coreA); gl.uniform1f(g.u.u_hairA, p.hairA);
    gl.uniform1f(g.u.u_dpr, p.dpr); gl.uniform1f(g.u.u_waveR, p.waveR); gl.uniform1f(g.u.u_waveA, p.waveA);
    this.attrib(g.a.a_q, this.quadBuf, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.detach(g.a.a_q);
  }

  /** A particle sphere (the core's, or a moon's buffers) with p's uniforms. */
  drawPoints(p, nodeBuf, randBuf, count, size) {
    const { gl } = this; const pp = this.pointsProg; gl.useProgram(pp.prog);
    this.nodeUniforms(pp.u, p);
    gl.uniform1f(pp.u.u_dpr, p.dpr); gl.uniform1f(pp.u.u_blink, p.blink); gl.uniform1f(pp.u.u_size0, size);
    this.attrib(pp.a.a_p, nodeBuf, 4); this.attrib(pp.a.a_r, randBuf, 4);
    gl.drawArrays(gl.POINTS, 0, count);
    this.detach(pp.a.a_p, pp.a.a_r);
  }

  /** Agents at work: p.moons [{...frame params of a small sphere, front, alpha}] (NeuralCore.moonFrame). */
  drawMoons(p, front) {
    for (const m of p.moons || []) {
      if (m.alpha < 0.02 || m.front !== front) continue;
      this.drawGlow(m);
      this.drawPoints(m, this.moonBuf, this.moonRand, this.moonCount, 1.6);
    }
  }

  /** p.tendrils: [{ p0:[x,y], p1:[x,y], c:[x,y], alpha, pulse }] in CSS px. */
  drawTendrils(p) {
    if (!p.tendrils?.length) return;
    const { gl } = this; const t = this.tendrilProg; gl.useProgram(t.prog);
    gl.uniform2f(t.u.u_size, p.w, p.h); gl.uniform3fv(t.u.u_color, p.color); gl.uniform3fv(t.u.u_color2, p.color2);
    gl.uniform1f(t.u.u_flow, p.flow);
    this.attrib(t.a.a_t, this.tendrilBuf, 1);
    for (const l of p.tendrils) {
      gl.uniform2f(t.u.u_p0, l.p0[0], l.p0[1]); gl.uniform2f(t.u.u_p1, l.p1[0], l.p1[1]); gl.uniform2f(t.u.u_c, l.c[0], l.c[1]);
      gl.uniform1f(t.u.u_alpha, l.alpha); gl.uniform1f(t.u.u_pulse, l.pulse);
      gl.drawArrays(gl.LINE_STRIP, 0, TENDRIL_STEPS + 1);
    }
    this.detach(t.a.a_t);
  }

  /** p.beams: [{ rect:[x,y,w,h], t, dir }] in CSS px; p.from = the core centre. */
  drawBeams(p) {
    if (!p.beams?.length) return;
    const { gl } = this; const b = this.beamProg; gl.useProgram(b.prog);
    gl.uniform2f(b.u.u_size, p.w, p.h); gl.uniform2f(b.u.u_from, p.cx, p.cy);
    gl.uniform1f(b.u.u_dpr, p.dpr); gl.uniform1f(b.u.u_size0, 2.4);
    gl.uniform3fv(b.u.u_color, p.color); gl.uniform3fv(b.u.u_color2, p.color2);
    this.attrib(b.a.a_r, this.beamBuf, 4);
    for (const beam of p.beams) {
      gl.uniform4f(b.u.u_rect, beam.rect[0], beam.rect[1], beam.rect[2], beam.rect[3]);
      gl.uniform1f(b.u.u_t, beam.t); gl.uniform1f(b.u.u_dir, beam.dir);
      gl.drawArrays(gl.POINTS, 0, BEAM_PARTICLES);
    }
    this.detach(b.a.a_r);
  }
}
