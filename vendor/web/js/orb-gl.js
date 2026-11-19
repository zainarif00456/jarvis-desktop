// The orb on the GPU. The 2D painter in orb.js computed ~900 projected points and built paths on the
// main thread every frame; here the browser only uploads ~30 numbers and the GPU does the geometry:
// dots, the three gyroscope rings (as thin quads), halo, core and hairline are all drawn by shaders.
// The look is the same (additive light, same colours and depth falloff); orb.js falls back to the 2D
// painter when WebGL is unavailable or the GPU context is lost for good.

const COMMON = `
uniform vec2 u_size;      // canvas size in CSS px
uniform vec2 u_origin;    // orb centre in CSS px
uniform float u_R;        // orb radius in CSS px
uniform float u_focal;
uniform float u_sinY, u_cosY, u_sinX, u_cosX;
vec4 project(vec3 p) {     // -> (x px, y px, depth, perspective scale)
  float x1 = p.x * u_cosY + p.z * u_sinY;
  float z1 = -p.x * u_sinY + p.z * u_cosY;
  float y2 = p.y * u_cosX - z1 * u_sinX;
  float z2 = p.y * u_sinX + z1 * u_cosX;
  float k = u_focal / (u_focal + z2 * u_R);
  return vec4(u_origin.x + x1 * u_R * k, u_origin.y + y2 * u_R * k, z2, k);
}
vec4 toClip(vec2 px) { return vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0); }
`;

const FRAG_PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const POINTS_VS = `precision highp float;
${COMMON}
attribute vec4 a_pos;     // x y z on the unit sphere, and the dot's own phase
uniform float u_energy, u_ripple, u_dim, u_dpr;
varying float v_alpha, v_radius;
void main() {
  float ripple = 1.0 + u_energy * 0.14 * sin(a_pos.w + u_ripple) + u_energy * 0.05;
  vec4 p = project(a_pos.xyz * ripple);
  float depth = (p.z + 1.0) / 2.0;
  float s = (0.7 + 1.3 * p.w) * (1.0 + u_energy * 0.5);
  v_alpha = clamp((0.1 + 0.75 * (1.0 - depth)) * u_dim * (0.55 + u_energy * 0.6), 0.0, 1.0);
  v_radius = s * u_dpr;
  gl_PointSize = 2.0 * v_radius + 2.0;
  gl_Position = toClip(p.xy);
}`;

const POINTS_FS = `${FRAG_PRECISION}
uniform vec3 u_color;
varying float v_alpha, v_radius;
void main() {
  float d = length((gl_PointCoord - 0.5) * (2.0 * v_radius + 2.0));
  float a = v_alpha * clamp(v_radius - d + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(u_color * a, a);
}`;

const RING_VS = `precision highp float;
${COMMON}
attribute vec3 a_seg;     // segment index, which end (0/1), which side (-1/+1)
uniform float u_segs, u_cT, u_sT, u_cR, u_sR, u_scale, u_width, u_energy, u_dim;
varying float v_alpha, v_across, v_half;
vec4 ringPoint(float i) {
  float a = i / u_segs * 6.283185307;
  float x0 = cos(a) * u_scale; float z0 = sin(a) * u_scale;
  float y1 = -z0 * u_sT; float z1 = z0 * u_cT;
  return project(vec3(x0 * u_cR - y1 * u_sR, x0 * u_sR + y1 * u_cR, z1));
}
void main() {
  vec4 p0 = ringPoint(a_seg.x);
  vec4 p1 = ringPoint(a_seg.x + 1.0);
  vec2 d = p1.xy - p0.xy;
  float len = length(d);
  d = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float depth = (p1.z / u_scale + 1.0) / 2.0;
  v_alpha = clamp((0.1 + 0.55 * (1.0 - depth)) * u_dim * (0.5 + u_energy * 0.7), 0.0, 1.0);
  float w = u_width * (0.6 + 0.7 * p1.w);   // nearer segments are thicker
  float reach = w * 0.5 + 1.0;               // plus a pixel of room for the soft edge
  v_half = w * 0.5; v_across = a_seg.z * reach;
  vec2 at = a_seg.y < 0.5 ? p0.xy : p1.xy;
  gl_Position = toClip(at + n * a_seg.z * reach);
}`;

const RING_FS = `${FRAG_PRECISION}
uniform vec3 u_color;
uniform float u_dpr;
varying float v_alpha, v_across, v_half;
void main() {
  float a = v_alpha * clamp((v_half - abs(v_across)) * u_dpr + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(u_color * a, a);
}`;

const GLOW_VS = `precision highp float;
attribute vec2 a_q;
uniform vec2 u_size, u_center;
uniform float u_half;
varying vec2 v_px;
void main() {
  v_px = u_center + a_q * u_half;
  gl_Position = vec4(v_px.x / u_size.x * 2.0 - 1.0, 1.0 - v_px.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const GLOW_FS = `${FRAG_PRECISION}
uniform vec3 u_color;
uniform vec2 u_center;
uniform float u_R, u_hr, u_coreR, u_hairR, u_haloA0, u_haloA1, u_coreA0, u_coreA1, u_hairA, u_dpr;
varying vec2 v_px;
void main() {
  float d = length(v_px - u_center);
  // halo: radial gradient from 0.2R to hr, alpha A0 -> A1 (half way) -> 0
  float r0 = u_R * 0.2;
  float t = (d - r0) / (u_hr - r0);
  float ha = t <= 0.0 ? u_haloA0 : t < 0.5 ? mix(u_haloA0, u_haloA1, t * 2.0) : t < 1.0 ? mix(u_haloA1, 0.0, (t - 0.5) * 2.0) : 0.0;
  vec4 acc = vec4(u_color * ha, ha);
  // core: white hot centre fading into the colour, then out
  float u = d / (u_coreR * 2.4);
  if (u < 1.0) {
    vec4 inner = vec4(vec3(u_coreA0), u_coreA0);
    vec4 mid = vec4(u_color * u_coreA1, u_coreA1);
    acc += u < 0.25 ? mix(inner, mid, u / 0.25) : mid * (1.0 - (u - 0.25) / 0.75);
  }
  // the hairline ring that breathes with the voice
  float hl = clamp((0.75 - abs(d - u_hairR)) * u_dpr + 0.5, 0.0, 1.0) * u_hairA;
  gl_FragColor = acc + vec4(u_color * hl, hl);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`shader: ${log}`);
  }
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

const SHARED = ['u_size', 'u_origin', 'u_R', 'u_focal', 'u_sinY', 'u_cosY', 'u_sinX', 'u_cosX'];

export class OrbGL {
  // Returns a painter, or null when this browser/GPU cannot do it (the caller then draws in 2D).
  static create(canvas, points, ringSegments, { onLost, allowSoftware = false } = {}) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: !allowSoftware,
      });
    } catch { gl = null; }
    if (!gl) return null;                    // failIfMajorPerformanceCaveat: no software WebGL when 2D is cheaper
    try { return new OrbGL(canvas, gl, points, ringSegments, onLost); } catch (error) {
      console.warn('orb: WebGL unavailable, using the 2D painter:', error.message); return null;
    }
  }

  constructor(canvas, gl, points, ringSegments, onLost) {
    this.canvas = canvas; this.gl = gl; this.points = points; this.segs = ringSegments; this.onLost = onLost;
    this.lost = false; this.dead = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.restoreTimer = setTimeout(() => { if (this.lost) { this.dead = true; this.onLost?.(); } }, 2500); });
    canvas.addEventListener('webglcontextrestored', () => { clearTimeout(this.restoreTimer); try { this.build(); this.lost = false; } catch { this.dead = true; this.onLost?.(); } });
    this.build();
  }

  build() {
    const { gl } = this;
    this.pointsProg = program(gl, POINTS_VS, POINTS_FS, [...SHARED, 'u_energy', 'u_ripple', 'u_dim', 'u_dpr', 'u_color'], ['a_pos']);
    this.ringProg = program(gl, RING_VS, RING_FS, [...SHARED, 'u_segs', 'u_cT', 'u_sT', 'u_cR', 'u_sR', 'u_scale', 'u_width', 'u_energy', 'u_dim', 'u_dpr', 'u_color'], ['a_seg']);
    this.glowProg = program(gl, GLOW_VS, GLOW_FS, ['u_size', 'u_center', 'u_half', 'u_color', 'u_R', 'u_hr', 'u_coreR', 'u_hairR', 'u_haloA0', 'u_haloA1', 'u_coreA0', 'u_coreA1', 'u_hairA', 'u_dpr'], ['a_q']);

    const dots = new Float32Array(this.points.length * 4);
    this.points.forEach((p, i) => dots.set(p, i * 4));
    this.dotBuf = this.buffer(dots);
    this.dotCount = this.points.length;

    // Each ring segment is a quad (two triangles): [segment, end, side] per vertex.
    const corners = [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]];
    const seg = new Float32Array(this.segs * corners.length * 3);
    let o = 0;
    for (let i = 0; i < this.segs; i++) for (const [end, side] of corners) { seg[o++] = i; seg[o++] = end; seg[o++] = side; }
    this.segBuf = this.buffer(seg);
    this.segCount = this.segs * corners.length;

    this.quadBuf = this.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);       // light adds: same as the 2D 'lighter' mode
    gl.clearColor(0, 0, 0, 0);
  }

  buffer(data) {
    const { gl } = this;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  resize(deviceW, deviceH) { this.gl.viewport(0, 0, deviceW, deviceH); }

  shared(u, p) {
    const { gl } = this;
    gl.uniform2f(u.u_size, p.w, p.h); gl.uniform2f(u.u_origin, p.cx, p.cy);
    gl.uniform1f(u.u_R, p.R); gl.uniform1f(u.u_focal, p.focal);
    gl.uniform1f(u.u_sinY, p.sinY); gl.uniform1f(u.u_cosY, p.cosY);
    gl.uniform1f(u.u_sinX, p.sinX); gl.uniform1f(u.u_cosX, p.cosX);
  }

  // p: everything the shaders need for this frame (see Orb.paintGL); no allocation here.
  draw(p) {
    if (this.lost || this.dead) return;
    const { gl } = this;
    gl.clear(gl.COLOR_BUFFER_BIT);
    const [r, g, b] = [p.color[0] / 255, p.color[1] / 255, p.color[2] / 255];

    // halo + core + hairline: one quad around the orb
    let g1 = this.glowProg; gl.useProgram(g1.prog);
    gl.uniform2f(g1.u.u_size, p.w, p.h); gl.uniform2f(g1.u.u_center, p.cx, p.cy);
    gl.uniform1f(g1.u.u_half, p.hr + 2); gl.uniform3f(g1.u.u_color, r, g, b);
    gl.uniform1f(g1.u.u_R, p.R); gl.uniform1f(g1.u.u_hr, p.hr); gl.uniform1f(g1.u.u_coreR, p.coreR); gl.uniform1f(g1.u.u_hairR, p.hairR);
    gl.uniform1f(g1.u.u_haloA0, p.haloA0); gl.uniform1f(g1.u.u_haloA1, p.haloA1);
    gl.uniform1f(g1.u.u_coreA0, p.coreA0); gl.uniform1f(g1.u.u_coreA1, p.coreA1); gl.uniform1f(g1.u.u_hairA, p.hairA);
    gl.uniform1f(g1.u.u_dpr, p.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(g1.a.a_q); gl.vertexAttribPointer(g1.a.a_q, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(g1.a.a_q);

    // the sphere of dots
    const pp = this.pointsProg; gl.useProgram(pp.prog);
    this.shared(pp.u, p);
    gl.uniform1f(pp.u.u_energy, p.energy); gl.uniform1f(pp.u.u_ripple, p.ripple); gl.uniform1f(pp.u.u_dim, p.dim);
    gl.uniform1f(pp.u.u_dpr, p.dpr); gl.uniform3f(pp.u.u_color, r, g, b);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuf);
    gl.enableVertexAttribArray(pp.a.a_pos); gl.vertexAttribPointer(pp.a.a_pos, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, this.dotCount);
    gl.disableVertexAttribArray(pp.a.a_pos);

    // the three rings
    const rp = this.ringProg; gl.useProgram(rp.prog);
    this.shared(rp.u, p);
    gl.uniform1f(rp.u.u_segs, this.segs); gl.uniform1f(rp.u.u_energy, p.energy); gl.uniform1f(rp.u.u_dim, p.dim);
    gl.uniform1f(rp.u.u_dpr, p.dpr); gl.uniform3f(rp.u.u_color, r, g, b);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.enableVertexAttribArray(rp.a.a_seg); gl.vertexAttribPointer(rp.a.a_seg, 3, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 3; i++) {
      const ring = p.rings[i];
      gl.uniform1f(rp.u.u_cT, ring.cT); gl.uniform1f(rp.u.u_sT, ring.sT);
      gl.uniform1f(rp.u.u_cR, ring.cR); gl.uniform1f(rp.u.u_sR, ring.sR);
      gl.uniform1f(rp.u.u_scale, ring.scale); gl.uniform1f(rp.u.u_width, ring.width);
      gl.drawArrays(gl.TRIANGLES, 0, this.segCount);
    }
    gl.disableVertexAttribArray(rp.a.a_seg);
  }
}
