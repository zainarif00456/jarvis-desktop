// Where the core sits. Shared by the neural core (which draws itself there) and the layout engine
// (which keeps panels out of its way), so both always agree.
//
// Centre: no panels open, the core is the stage. Docked: panels are open, the core shrinks and
// moves to the top centre, still alive, still the brain that drives them.

export const CENTRE = { cy: 0.45, scale: 1 };
export const DOCKED = { cy: 0.135, scale: 0.42 };
// Debrief: the core shrinks a little and rises while an agent walks the owner through a debrief; the
// popup cards stand in the free space to its left and right (js/debrief/stage.js, css/debrief.css)
export const SIDE = { cx: 0.5, cy: 0.34, scale: 0.62 };
const BASE_R = 0.19;          // core radius as a share of min(width, 0.9 * height)
const REACH = 1.85;           // the rings reach this many radii out

/** The core's radius in CSS px for a viewport and a dock scale. */
export const coreRadius = (w, h, scale = 1) => Math.min(w, h * 0.9) * BASE_R * scale;

/** The circle panels must keep clear of when docked: { x, y, r } in CSS px. */
export function coreZone(w, h) {
  const r = coreRadius(w, h, DOCKED.scale) * REACH;
  return { x: w / 2, y: h * DOCKED.cy, r };
}
