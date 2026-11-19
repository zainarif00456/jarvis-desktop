// Builds the neural core's particles and synapses once per quality tier (never per frame).
//
// Particles sit on three Fibonacci-sphere layers (the shell and two inner layers, so the core
// has depth like a brain). A few percent are neurons (a_r.y >= HUB); each neuron is linked to
// its nearest neurons. The links reuse the particle attributes of their two ends, so the shader
// places them with the same function and they follow every change of shape.

export const HUB = 0.94;          // a_r.y at or above this = a neuron (keep in step with shaders.js)

export const TIERS = {
  cinematic: { points: 7000, links: 2, size: 2.1, rings: true },
  standard: { points: 4200, links: 2, size: 2.3, rings: true },
  lite: { points: 1800, links: 0, size: 2.6, rings: false },
};

const LAYERS = [[1.0, 0.7], [0.66, 0.19], [0.4, 0.11]];   // [radius, share of particles]

function fibonacci(n, radius, out, o, rand) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i + rand() * 0.3;          // a little irregular: organic, not a golf ball
    out[o++] = Math.cos(th) * r; out[o++] = y; out[o++] = Math.sin(th) * r; out[o++] = radius;
  }
  return o;
}

// Small seeded generator: the same core every load (no shimmering re-layout after a reload).
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** -> { p: Float32Array(n*4), r: Float32Array(n*4), count, link: Float32Array(m*2*10) | null, linkVerts } */
export function buildCore(tier) {
  const spec = TIERS[tier] || TIERS.standard;
  const rand = seeded(0x51a7e);
  const n = spec.points;
  const p = new Float32Array(n * 4); const r = new Float32Array(n * 4);
  let o = 0; let used = 0;
  LAYERS.forEach(([radius, share], i) => {
    const count = i === LAYERS.length - 1 ? n - used : Math.round(n * share);
    o = fibonacci(count, radius, p, o, rand); used += count;
  });
  for (let i = 0; i < n * 4; i++) r[i] = rand();

  if (!spec.links) return { p, r, count: n, link: null, linkVerts: 0 };

  // neurons and their nearest neighbours (a few hundred: the quadratic search costs a few ms, once)
  const hubs = [];
  for (let i = 0; i < n; i++) if (r[i * 4 + 1] >= HUB) hubs.push(i);
  const pos = (i) => [p[i * 4] * p[i * 4 + 3], p[i * 4 + 1] * p[i * 4 + 3], p[i * 4 + 2] * p[i * 4 + 3]];
  const hp = hubs.map(pos);
  const pairs = new Set(); const links = [];
  for (let a = 0; a < hubs.length; a++) {
    const best = [];
    for (let b = 0; b < hubs.length; b++) {
      if (a === b) continue;
      const dx = hp[a][0] - hp[b][0]; const dy = hp[a][1] - hp[b][1]; const dz = hp[a][2] - hp[b][2];
      const d = dx * dx + dy * dy + dz * dz;
      if (best.length < spec.links + 1) { best.push([d, b]); best.sort((x, y) => x[0] - y[0]); }
      else if (d < best[best.length - 1][0]) { best[best.length - 1] = [d, b]; best.sort((x, y) => x[0] - y[0]); }
    }
    for (const [, b] of best.slice(0, spec.links)) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (pairs.has(key)) continue;
      pairs.add(key); links.push([hubs[a], hubs[b], rand()]);
    }
  }
  // per vertex: a_p (4) a_r (4) a_l (2)
  const link = new Float32Array(links.length * 2 * 10);
  let k = 0;
  for (const [i, j, phase] of links) {
    for (const [idx, end] of [[i, 0], [j, 1]]) {
      link.set(p.subarray(idx * 4, idx * 4 + 4), k); link.set(r.subarray(idx * 4, idx * 4 + 4), k + 4);
      link[k + 8] = end; link[k + 9] = phase; k += 10;
    }
  }
  return { p, r, count: n, link, linkVerts: links.length * 2 };
}

/** A small particle sphere for an agent's moon (shell + one inner layer), built once. */
export function buildMoon(n = 640) {
  const rand = seeded(0x30d);
  const p = new Float32Array(n * 4); const r = new Float32Array(n * 4);
  const shell = Math.round(n * 0.7);
  let o = fibonacci(shell, 1.0, p, 0, rand); fibonacci(n - shell, 0.55, p, o, rand);
  for (let i = 0; i < n * 4; i++) r[i] = rand();
  return { p, r, count: n };
}
