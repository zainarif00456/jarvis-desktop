// GLSL for the neural core (WebGL 1). Every particle's position is worked out here from its
// attributes and a handful of uniforms, so the page only uploads ~40 numbers a frame.
//
// One function, `nodePos`, places a particle; the synapse lines call the same function for both
// of their ends, so links stay attached to their neurons whatever shape the core takes.
//
// Shapes (signature, see js/core/personas.js): the outer shell is always the neural sphere; the
// INNER layers (a_p.w < 1) take the present AI's shape:
//   0 Jarvis   concentric neural layers      1 Friday    a knotted heart
//   2 EDITH    a faceted lattice (shell too) 3 Veronica  spiral arms through the core

const COMMON = `
uniform vec2 u_size;        // canvas in CSS px
uniform vec2 u_origin;      // core centre in CSS px
uniform float u_R;          // core radius in CSS px
uniform float u_focal;
uniform mat3 u_rot;
uniform float u_time, u_energy, u_listen, u_waveR, u_waveA;
uniform float u_sigA, u_sigB, u_morph;
attribute vec4 a_p;         // unit direction (xyz) and layer radius (w: 1 = shell)
attribute vec4 a_r;         // four random numbers per particle

const float PI2 = 6.2831853;

vec3 knot(float t) {
  float r = cos(3.0 * t) + 2.0;
  return vec3(r * cos(2.0 * t), -sin(3.0 * t), r * sin(2.0 * t)) * 0.24;
}

vec3 innerShape(float sig, vec3 base) {
  if (sig < 0.5) return base;                                   // Jarvis: the layers as they are
  if (sig < 1.5) {                                              // Friday: knotted heart
    float t = a_r.x * PI2;
    return knot(t) + (a_r.yzw - 0.5) * 0.11;
  }
  if (sig < 2.5) {                                              // EDITH: lattice on an octahedron
    vec3 d = base / (abs(base.x) + abs(base.y) + abs(base.z) + 1e-4);
    return floor(d * 6.0 + 0.5) / 6.0 * 0.95 + (a_r.yzw - 0.5) * 0.02;
  }
  float rad = pow(a_r.x, 0.6) * 0.92;                           // Veronica: three spiral arms
  float ang = rad * 5.2 + floor(fract(a_r.x * 7.0) * 3.0) * 2.0944 + u_time * 0.35;
  vec3 s = (a_r.wzy - 0.5) * (0.16 - rad * 0.08);
  return vec3(cos(ang) * rad, (a_r.z - 0.5) * 0.08, sin(ang) * rad) + s;
}

vec3 shapeOf(float sig) {
  vec3 base = a_p.xyz * a_p.w;
  if (a_p.w < 0.99) return innerShape(sig, base);
  if (sig > 1.5 && sig < 2.5) {                                 // EDITH: the shell becomes faceted too
    vec3 d = a_p.xyz / (abs(a_p.x) + abs(a_p.y) + abs(a_p.z));
    return normalize(mix(a_p.xyz, d, 0.55)) * mix(1.0, length(d) * 1.45, 0.5);
  }
  return base;
}

vec3 nodePos() {
  vec3 from = shapeOf(u_sigA);
  vec3 to = shapeOf(u_sigB);
  float f = smoothstep(0.0, 1.0, clamp(u_morph * 1.5 - a_r.w * 0.5, 0.0, 1.0));
  vec3 p = mix(from, to, f);
  p += normalize(a_r.xyz - 0.5 + 0.001) * sin(f * 3.14159) * 0.22;   // particles arc while they move
  // living surface: slow 3-axis noise, stronger with energy
  float n = sin(p.x * 3.0 + u_time) * sin(p.y * 3.2 + u_time * 1.3) * sin(p.z * 2.8 + u_time * 0.7);
  p *= 1.0 + n * (0.05 + u_energy * 0.07);
  // listening: ripples run over the surface with the owner's voice
  p *= 1.0 + u_listen * 0.07 * sin(dot(a_p.xyz, vec3(0.6, 0.8, 0.0)) * 7.0 - u_time * 9.0);
  // speaking: a wave of light leaves the core on each loud syllable
  float w = exp(-pow((length(p) - u_waveR) * 5.0, 2.0)) * u_waveA;
  p *= 1.0 + w * 0.06;
  return p;
}

float waveAt(vec3 p) { return exp(-pow((length(p) - u_waveR) * 5.0, 2.0)) * u_waveA; }

vec4 project(vec3 p) {        // -> (x px, y px, depth 0 near..1 far, perspective scale)
  vec3 q = u_rot * p;
  float k = u_focal / (u_focal + q.z * u_R);
  return vec4(u_origin.x + q.x * u_R * k, u_origin.y - q.y * u_R * k, clamp((q.z + 1.2) / 2.4, 0.0, 1.0), k);
}
vec4 toClip(vec2 px) { return vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0); }
`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

export const POINTS_VS = `precision highp float;
${COMMON}
uniform float u_dpr, u_dim, u_blink, u_size0;
varying float v_alpha, v_hot;
void main() {
  vec3 p = nodePos();
  vec4 s = project(p);
  float hub = step(0.94, a_r.y);                                // neurons: bigger, brighter
  float near = 1.0 - s.z;
  float wave = waveAt(p);
  v_hot = clamp(hub * 0.5 + wave * 0.8 + step(0.985, a_r.z) * 0.6, 0.0, 1.0);
  v_alpha = clamp((0.12 + 0.62 * near) * (0.55 + u_energy * 0.5 + hub * 0.5 + wave) * u_dim * (0.85 + 0.25 * u_blink), 0.0, 1.0);
  gl_PointSize = u_size0 * u_dpr * s.w * (0.55 + a_r.z * 0.9 + hub * 1.4) * (1.0 + u_energy * 0.25);
  gl_Position = toClip(s.xy);
}`;

export const POINTS_FS = `${PRECISION}
uniform vec3 u_color, u_color2;
varying float v_alpha, v_hot;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = smoothstep(0.25, 0.0, d) * v_alpha;
  vec3 col = mix(u_color, mix(u_color2, vec3(1.0), 0.35), v_hot);
  gl_FragColor = vec4(col * a, a);
}`;

export const LINKS_VS = `precision highp float;
${COMMON}
attribute vec2 a_l;           // (which end 0|1, the link's own phase 0..1)
uniform float u_dim, u_activity;
varying float v_t, v_alpha, v_head, v_live;
void main() {
  vec3 p = nodePos();
  vec4 s = project(p);
  v_t = a_l.x;
  // a signal travels along some links; how many and how fast follows u_activity (thinking = busy).
  // Worked out per link here (both ends get the same value) so the fragment shader needs no time.
  float ph = a_l.y;
  v_live = step(ph, 0.15 + u_activity * 0.7) * (0.35 + u_activity);
  v_head = fract(u_time * (0.35 + ph * 0.9) * (0.6 + u_activity * 1.6) + ph * 7.0);
  v_alpha = (0.04 + 0.16 * (1.0 - s.z)) * u_dim * (0.6 + u_energy * 0.8 + waveAt(p));
  gl_Position = toClip(s.xy);
}`;

export const LINKS_FS = `${PRECISION}
uniform vec3 u_color, u_color2;
varying float v_t, v_alpha, v_head, v_live;
void main() {
  float pulse = smoothstep(0.12, 0.0, abs(v_t - v_head)) * v_live;
  float a = clamp(v_alpha + pulse * 0.85, 0.0, 1.0);
  vec3 col = mix(u_color, mix(u_color2, vec3(1.0), 0.4), clamp(pulse, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);
}`;

// halo + core + the hairline ring that breathes with the voice: one quad around the core
export const GLOW_VS = `precision highp float;
attribute vec2 a_q;
uniform vec2 u_size, u_center;
uniform float u_half;
varying vec2 v_px;
void main() {
  v_px = u_center + a_q * u_half;
  gl_Position = vec4(v_px.x / u_size.x * 2.0 - 1.0, 1.0 - v_px.y / u_size.y * 2.0, 0.0, 1.0);
}`;

export const GLOW_FS = `${PRECISION}
uniform vec3 u_color, u_color2;
uniform vec2 u_center;
uniform float u_R, u_hr, u_coreR, u_hairR, u_haloA, u_coreA, u_hairA, u_dpr, u_waveR, u_waveA;
varying vec2 v_px;
void main() {
  float d = length(v_px - u_center);
  float t = clamp((d - u_R * 0.15) / (u_hr - u_R * 0.15), 0.0, 1.0);
  float halo = u_haloA * (1.0 - t) * (1.0 - t);
  vec4 acc = vec4(u_color * halo, halo);
  float u = d / (u_coreR * 2.6);
  if (u < 1.0) {
    float c = u_coreA * pow(1.0 - u, 2.2);
    acc += vec4(mix(u_color2, vec3(1.0), 0.6 * (1.0 - u)) * c, c);
  }
  float hl = clamp((0.7 - abs(d - u_hairR)) * u_dpr + 0.5, 0.0, 1.0) * u_hairA;
  float wv = clamp((1.2 - abs(d - u_waveR * u_R)) * u_dpr * 0.5 + 0.5, 0.0, 1.0) * u_waveA * 0.35;
  acc += vec4(u_color2 * (hl + wv), hl + wv);
  gl_FragColor = acc;
}`;

// the gyroscope rings, drawn as thin quads (kept from the first orb: Jarvis's signature)
export const RING_VS = `precision highp float;
attribute vec3 a_seg;         // segment index, which end (0|1), which side (-1|+1)
uniform vec2 u_size, u_origin;
uniform float u_R, u_focal, u_segs, u_scale, u_width, u_alpha;
uniform mat3 u_rot, u_ring;
varying float v_alpha, v_across, v_half;
vec4 ringPoint(float i) {
  float a = i / u_segs * 6.2831853;
  vec3 q = u_rot * (u_ring * vec3(cos(a) * u_scale, 0.0, sin(a) * u_scale));
  float k = u_focal / (u_focal + q.z * u_R);
  return vec4(u_origin.x + q.x * u_R * k, u_origin.y - q.y * u_R * k, q.z / u_scale, k);
}
void main() {
  vec4 p0 = ringPoint(a_seg.x); vec4 p1 = ringPoint(a_seg.x + 1.0);
  vec2 d = p1.xy - p0.xy; float len = length(d);
  d = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  v_alpha = u_alpha * (0.25 + 0.75 * (1.0 - (p1.z + 1.0) / 2.0));
  float w = u_width * (0.6 + 0.7 * p1.w); float reach = w * 0.5 + 1.0;
  v_half = w * 0.5; v_across = a_seg.z * reach;
  vec2 at = a_seg.y < 0.5 ? p0.xy : p1.xy;
  vec2 px = at + n * a_seg.z * reach;
  gl_Position = vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0);
}`;

export const RING_FS = `${PRECISION}
uniform vec3 u_color;
uniform float u_dpr;
varying float v_alpha, v_across, v_half;
void main() {
  float a = v_alpha * clamp((v_half - abs(v_across)) * u_dpr + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(u_color * a, a);
}`;

// ---- the core reaching out to the workspace ------------------------------------------------
// Beam: particles stream from the core to a panel's outline when it forms (u_dir 1), or from the
// outline back into the core when it closes (u_dir -1). One draw per beam, u_t = progress 0..1.
export const BEAM_VS = `precision highp float;
attribute vec4 a_r;
uniform vec2 u_size, u_from;
uniform vec4 u_rect;          // x y w h (CSS px)
uniform float u_t, u_dir, u_dpr, u_size0;
varying float v_alpha;
vec2 onOutline(float s) {     // a point on the rectangle's outline, s in 0..1
  float w = u_rect.z; float h = u_rect.w; float d = s * 2.0 * (w + h);
  if (d < w) return u_rect.xy + vec2(d, 0.0);
  d -= w; if (d < h) return u_rect.xy + vec2(w, d);
  d -= h; if (d < w) return u_rect.xy + vec2(w - d, h);
  d -= w; return u_rect.xy + vec2(0.0, h - d);
}
void main() {
  vec2 target = onOutline(a_r.x);
  vec2 a = u_dir > 0.0 ? u_from : target;
  vec2 b = u_dir > 0.0 ? target : u_from;
  vec2 mid = (a + b) * 0.5; vec2 d = b - a;
  vec2 ctrl = mid + vec2(-d.y, d.x) * (a_r.y - 0.5) * 0.55 - vec2(0.0, length(d) * 0.12);
  float local = clamp((u_t - a_r.z * 0.4) / 0.6, 0.0, 1.0);
  float e = local * local * (3.0 - 2.0 * local);
  vec2 p = mix(mix(a, ctrl, e), mix(ctrl, b, e), e);
  v_alpha = sin(local * 3.14159) * (0.55 + a_r.w * 0.45);
  gl_PointSize = u_size0 * u_dpr * (0.7 + a_r.w * 0.8);
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`;

export const BEAM_FS = `${PRECISION}
uniform vec3 u_color, u_color2;
varying float v_alpha;
void main() {
  vec2 c = gl_PointCoord - 0.5; float d = dot(c, c);
  if (d > 0.25) discard;
  float a = smoothstep(0.25, 0.0, d) * v_alpha;
  gl_FragColor = vec4(mix(u_color, u_color2, 0.5) * a, a);
}`;

// Tendril: a curved hairline from the core to a panel, light flowing along it; a pulse runs out
// when Jarvis acts on that panel. Drawn as a line strip of a_t = 0..1.
export const TENDRIL_VS = `precision highp float;
attribute float a_t;
uniform vec2 u_size, u_p0, u_p1, u_c;
varying float v_t;
void main() {
  float t = a_t; v_t = t;
  vec2 p = mix(mix(u_p0, u_c, t), mix(u_c, u_p1, t), t);
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`;

export const TENDRIL_FS = `${PRECISION}
uniform vec3 u_color, u_color2;
uniform float u_alpha, u_flow, u_pulse;
varying float v_t;
void main() {
  float ends = smoothstep(0.0, 0.12, v_t) * smoothstep(1.0, 0.85, v_t);
  float flow = pow(0.5 + 0.5 * sin((v_t * 5.0 - u_flow) * 6.2831853), 6.0);
  float pulse = u_pulse >= 0.0 ? smoothstep(0.1, 0.0, abs(v_t - u_pulse)) : 0.0;
  float a = clamp((0.16 + flow * 0.32) * ends * u_alpha + pulse, 0.0, 1.0);
  gl_FragColor = vec4(mix(u_color, mix(u_color2, vec3(1.0), 0.5), pulse) * a, a);
}`;
