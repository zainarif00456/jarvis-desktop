'use strict';
// Pure layout for the hologram overlay (no DOM, no Electron): where each floating thing goes so nothing overlaps.
// Used by the page-side overlay script (src/preload/overlay-page.js, which receives this file's source) and by test/arrange.test.js.
//
//   zones  [{ x, y, w, h, primary }]   one per display, in the overlay window's coordinates (primary first)
//   items  [{ id, kind, w, h, minW, minH, shrink, prefer }]
//          kind    'card'   live tool / terminal-command card: a column on the right of the primary display
//                  'portal' everything else (windows, files, pictures, briefing / debrief columns, pop-ups)
//          prefer  'primary' | 'secondary' (secondary falls back to the primary display when only one display exists)
//   returns { rects: { id: { x, y, w, h, zone } }, overflow: [id] }  (overflow = did not fit even after shrinking; cascaded, may overlap)
(function (root) {
  const GAP = 16, MARGIN = 20, TOP = 48, BOTTOM = 28;   // TOP: leave the shell's panel / window title area free

  function packCards(area, cards) {
    // vertical stacks, right to left: a new column when the next card does not fit under the previous ones
    const cols = []; let col = null;
    for (const c of cards) {
      const h = Math.min(c.h, area.h);
      if (!col || col.h + GAP + h > area.h) { col = { items: [], w: 0, h: -GAP }; cols.push(col); }
      col.items.push({ c, h }); col.w = Math.max(col.w, c.w); col.h += GAP + h;
    }
    const rects = {}; let x = area.x + area.w;
    for (const k of cols) {
      x -= k.w; let y = area.y;
      for (const { c, h } of k.items) { rects[c.id] = { x: x + (k.w - c.w), y, w: c.w, h }; y += h + GAP; }
      x -= GAP;
    }
    const used = cols.reduce((s, k) => s + k.w + GAP, 0);
    return { rects, used };
  }

  function shelf(area, items) {
    // rows, left to right; shrinkable items scale down until everything fits; what still does not fit is returned as leftover
    let list = items.map((i) => ({ ...i, w: Math.min(i.w, area.w), h: Math.min(i.h, area.h) }));
    const build = () => {
      const rows = []; let row = null;
      for (const i of list) {
        if (!row || row.w + GAP + i.w > area.w) { row = { items: [], w: -GAP, h: 0 }; rows.push(row); }
        row.items.push(i); row.w += GAP + i.w; row.h = Math.max(row.h, i.h);
      }
      return rows;
    };
    const height = (rows) => rows.reduce((s, r) => s + r.h, 0) + GAP * Math.max(0, rows.length - 1);
    let rows = build();
    for (let n = 0; n < 12 && height(rows) > area.h; n++) {
      let changed = false;
      list = list.map((i) => {
        if (!i.shrink) return i;
        const w = Math.max(i.minW || 240, Math.round(i.w * 0.88)), h = Math.max(i.minH || 160, Math.round(i.h * 0.88));
        if (w !== i.w || h !== i.h) changed = true;
        return { ...i, w, h };
      });
      rows = build();
      if (!changed) break;
    }
    const rects = {}, leftover = [];
    let y = area.y;
    for (const r of rows) {
      if (y + r.h > area.y + area.h + 1) { for (const i of r.items) leftover.push(i); continue; }
      let x = area.x + Math.max(0, Math.round((area.w - r.w) / 2));
      for (const i of r.items) { rects[i.id] = { x, y, w: i.w, h: i.h }; x += i.w + GAP; }
      y += r.h + GAP;
    }
    return { rects, leftover };
  }

  function arrange(zones, items) {
    const out = { rects: {}, overflow: [] };
    if (!zones || !zones.length) return out;
    const primary = zones.find((z) => z.primary) || zones[0];
    const others = zones.filter((z) => z !== primary);
    const inner = (z) => ({ x: z.x + MARGIN, y: z.y + TOP, w: z.w - 2 * MARGIN, h: z.h - TOP - BOTTOM });
    const targets = new Map(zones.map((z) => [z, []]));
    const cards = items.filter((i) => i.kind === 'card');
    // 'secondary' work (presentations, briefings, pictures, files) goes to the other displays, spread over them by what is already there
    for (const i of items) {
      if (i.kind === 'card') continue;
      if (i.prefer === 'secondary' && others.length) {
        const z = others.reduce((best, o) => (targets.get(o).reduce((s, t) => s + t.w * t.h, 0) / (o.w * o.h) < targets.get(best).reduce((s, t) => s + t.w * t.h, 0) / (best.w * best.h) ? o : best), others[0]);
        targets.get(z).push(i);
      } else targets.get(primary).push(i);
    }
    const spill = [];
    for (const z of others) {
      const r = shelf(inner(z), targets.get(z));
      for (const [id, q] of Object.entries(r.rects)) out.rects[id] = { ...q, zone: zones.indexOf(z) };
      spill.push(...r.leftover);
    }
    const pa = inner(primary);
    const lane = packCards(pa, cards);
    for (const [id, q] of Object.entries(lane.rects)) out.rects[id] = { ...q, zone: zones.indexOf(primary) };
    const rest = { x: pa.x, y: pa.y, w: Math.max(240, pa.w - lane.used), h: pa.h };
    const r = shelf(rest, [...targets.get(primary), ...spill]);
    for (const [id, q] of Object.entries(r.rects)) out.rects[id] = { ...q, zone: zones.indexOf(primary) };
    // last resort: cascade what still does not fit (it may overlap, but it stays on screen)
    r.leftover.forEach((i, n) => {
      const w = Math.min(i.w, rest.w), h = Math.min(i.h, rest.h);
      out.rects[i.id] = { x: rest.x + Math.min(40 * (n + 1), Math.max(0, rest.w - w)), y: rest.y + Math.min(32 * (n + 1), Math.max(0, rest.h - h)), w, h, zone: zones.indexOf(primary) };
      out.overflow.push(i.id);
    });
    return out;
  }

  const api = { arrange, GAP, MARGIN, TOP, BOTTOM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JDArrange = api;
})(typeof window !== 'undefined' ? window : globalThis);
