// The layout engine: pure functions, no DOM. Given how many panels, the free area and the docked
// core, return a rectangle per panel. Easy to test and to extend: add a mode = add a function to
// LAYOUTS and its name to MODES (and to the server's screen.control `arrange` list).
//
//   orbit         panels gather around the docked core (default): 1 = under it, 2 = either side,
//                 3 = both sides + one under, 4 = two on each side, more = a grid under it
//   grid          even grid over the whole area
//   focus         one big, the rest stacked in a column on the right
//   side_by_side  first two halves, the rest cascaded on top
//   cascade       overlapping, offset copies

export const GAP = 18;
export const MODES = ['orbit', 'grid', 'focus', 'side_by_side', 'cascade'];

function grid(n, a) {
  const cols = Math.ceil(Math.sqrt(n)); const rows = Math.ceil(n / cols);
  const cw = (a.w - GAP * (cols - 1)) / cols; const ch = (a.h - GAP * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({ x: a.x + (i % cols) * (cw + GAP), y: a.y + Math.floor(i / cols) * (ch + GAP), w: cw, h: ch }));
}

function focus(n, a) {
  if (n < 2) return grid(n, a);
  const side = Math.max(260, Math.round(a.w * 0.28));
  const out = [{ x: a.x, y: a.y, w: a.w - side - GAP, h: a.h }];
  const each = (a.h - GAP * (n - 2)) / (n - 1);
  for (let i = 1; i < n; i++) out.push({ x: a.x + a.w - side, y: a.y + (i - 1) * (each + GAP), w: side, h: each });
  return out;
}

function sideBySide(n, a) {
  if (n < 2) return grid(n, a);
  const half = (a.w - GAP) / 2;
  const out = [{ x: a.x, y: a.y, w: half, h: a.h }, { x: a.x + half + GAP, y: a.y, w: half, h: a.h }];
  for (let i = 2; i < n; i++) out.push({ x: a.x + 40 * (i - 1), y: a.y + 40 * (i - 1), w: half, h: a.h * 0.8 });
  return out;
}

function cascade(n, a) {
  const w = Math.min(a.w * 0.62, 980); const h = Math.min(a.h * 0.7, 660);
  return Array.from({ length: n }, (_, i) => ({ x: a.x + 36 * i, y: a.y + 32 * i, w, h }));
}

function orbit(n, a, core) {
  if (!core) return grid(n, a);
  const below = Math.min(a.y + a.h, core.y + core.r + GAP);        // first free line under the core
  const under = { x: a.x, y: below, w: a.w, h: a.y + a.h - below };
  // beside the core, full height (the core is centred on the screen, the area may not be)
  const left = { x: a.x, y: a.y, w: core.x - core.r - GAP - a.x, h: a.h };
  const right = { x: core.x + core.r + GAP, y: a.y, w: a.x + a.w - (core.x + core.r + GAP), h: a.h };
  const flankW = Math.min(left.w, right.w);
  const midX = core.x - core.r; const midW = core.r * 2;
  if (n === 1) {
    const w = Math.min(a.w * 0.74, 1180);
    return [{ x: a.x + (a.w - w) / 2, y: under.y, w, h: under.h }];
  }
  if (flankW < 300 || under.h < 220) return grid(n, under.h >= 220 ? under : a);   // small screens
  if (n === 2) return [left, right];
  if (n === 3) return [left, right, { x: midX, y: under.y, w: midW, h: under.h }];
  if (n === 4) {
    const h = (a.h - GAP) / 2;
    return [{ ...left, h }, { ...right, h }, { ...left, y: a.y + h + GAP, h }, { ...right, y: a.y + h + GAP, h }];
  }
  return grid(n, under);
}

const LAYOUTS = { orbit, grid, focus, side_by_side: sideBySide, cascade };

/** Rectangles for `n` panels in `area` ({x, y, w, h}); `core` = { x, y, r } when docked. */
export function layoutRects(mode, n, area, core = null) {
  if (n <= 0) return [];
  const fn = LAYOUTS[mode] || grid;
  return fn(n, area, core).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(Math.max(120, r.w)), h: Math.round(Math.max(100, r.h)) }));
}

/** Snap zones for dragging a panel to an edge: which zone the pointer is in, and its rectangle. */
export function snapZone(px, py, area, edge = 28) {
  const { x, y, w, h } = area; const half = (w - GAP) / 2; const halfH = (h - GAP) / 2;
  const left = px <= x + edge; const right = px >= x + w - edge; const top = py <= y + edge; const bottom = py >= y + h - edge;
  if (left && top) return { zone: 'top-left', rect: { x, y, w: half, h: halfH } };
  if (right && top) return { zone: 'top-right', rect: { x: x + half + GAP, y, w: half, h: halfH } };
  if (left && bottom) return { zone: 'bottom-left', rect: { x, y: y + halfH + GAP, w: half, h: halfH } };
  if (right && bottom) return { zone: 'bottom-right', rect: { x: x + half + GAP, y: y + halfH + GAP, w: half, h: halfH } };
  if (left) return { zone: 'left', rect: { x, y, w: half, h } };
  if (right) return { zone: 'right', rect: { x: x + half + GAP, y, w: half, h } };
  if (top) return { zone: 'max', rect: { x, y, w, h } };
  return null;
}
