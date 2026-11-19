'use strict';
const test = require('node:test'), assert = require('node:assert');
const { arrange } = require('../src/main/arrange');
const { unionBounds, computeZones } = require('../src/main/overlay');

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noOverlap = (rects) => { const v = Object.values(rects); for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (v[i].zone === v[j].zone && overlap(v[i], v[j])) return false; return true; };
const one = [{ x: 0, y: 0, w: 1920, h: 1080, primary: true }];
const two = [{ x: 0, y: 0, w: 1920, h: 1080, primary: true }, { x: 1920, y: 0, w: 1280, h: 1024 }];
const card = (id, h = 160) => ({ id, kind: 'card', w: 400, h });
const win = (id, prefer = 'secondary', w = 720, h = 480) => ({ id, kind: 'portal', w, h, minW: 320, minH: 200, shrink: true, prefer });

test('one display: cards stack on the right, windows fill the rest, nothing overlaps', () => {
  const items = [card('c1'), card('c2', 300), card('c3'), win('w1'), win('t1', 'primary', 820, 500)];
  const { rects, overflow } = arrange(one, items);
  assert.deepEqual(overflow, []);
  assert.ok(noOverlap(rects));
  for (const r of Object.values(rects)) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080);
  assert.ok(rects.c1.x > rects.w1.x + rects.w1.w - 1, 'cards sit right of the windows');
});

test('one display: many windows shrink to fit instead of overlapping', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => win(id));
  const { rects, overflow } = arrange(one, items);
  assert.deepEqual(overflow, []);
  assert.ok(noOverlap(rects));
  assert.ok(Object.values(rects).every((r) => r.w >= 320 && r.h >= 200));
});

test('two displays: cards and terminals on the primary, presentations and pictures on the second', () => {
  const items = [card('c1'), card('c2'), win('t1', 'primary', 820, 500), win('pic'), win('deck', 'secondary', 460, 700)];
  const { rects } = arrange(two, items);
  assert.equal(rects.c1.zone, 0); assert.equal(rects.c2.zone, 0); assert.equal(rects.t1.zone, 0);
  assert.equal(rects.pic.zone, 1); assert.equal(rects.deck.zone, 1);
  assert.ok(rects.pic.x >= 1920, 'second display starts at x=1920');
  assert.ok(noOverlap(rects));
});

test('second display full: the rest spills onto the primary; only what fits nowhere cascades', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ ...win(id, 'secondary', 900, 700), shrink: false }));   // fixed-size: cannot shrink to fit
  const { rects, overflow } = arrange(two, items);
  const placed = Object.fromEntries(Object.entries(rects).filter(([id]) => !overflow.includes(id)));
  assert.ok(noOverlap(placed), 'everything that fits is placed without overlap');
  assert.ok(Object.values(placed).some((r) => r.zone === 0), 'the spill uses the primary display');
  assert.deepEqual(overflow.sort(), ['d', 'e', 'f'], 'only what fits nowhere is cascaded (reported as overflow)');
});

test('display removed: the same items land on the remaining display', () => {
  const items = [card('c1'), win('pic')];
  assert.equal(arrange(two, items).rects.pic.zone, 1);
  const after = arrange(one, items);
  assert.equal(after.rects.pic.zone, 0); assert.ok(noOverlap(after.rects));
});

test('no zones / no items are harmless', () => {
  assert.deepEqual(arrange([], [card('c')]).rects, {});
  assert.deepEqual(arrange(one, []).rects, {});
});

test('union bounds and zones in window coordinates (second display to the left, primary first)', () => {
  const d = [{ id: 7, bounds: { x: -1280, y: 100, width: 1280, height: 1024 } }, { id: 3, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const u = unionBounds(d);
  assert.deepEqual(u, { x: -1280, y: 0, width: 3200, height: 1124 });
  const z = computeZones(d, 3, u);
  assert.equal(z[0].id, 3); assert.equal(z[0].primary, true); assert.equal(z[0].x, 1280);
  assert.equal(z[1].id, 7); assert.equal(z[1].x, 0); assert.equal(z[1].y, 100);
});

test('many picture / video / camera cards: spread over two displays, nothing overlaps, each stays usable', () => {
  const items = Array.from({ length: 7 }, (_, i) => win(`p${i}`, 'secondary', 520, 400));
  const { rects, overflow } = arrange(two, items);
  assert.deepEqual(overflow, []);
  assert.ok(noOverlap(rects));
  assert.ok(Object.values(rects).every((r) => r.zone === 1 && r.w >= 320 && r.h >= 200));
});

test('a single picture card keeps its size and sits whole inside the display', () => {
  const { rects } = arrange(one, [win('p', 'secondary', 760, 543)]);
  assert.equal(rects.p.w, 760); assert.equal(rects.p.h, 543);
  assert.ok(rects.p.x >= 0 && rects.p.y >= 0 && rects.p.x + rects.p.w <= 1920 && rects.p.y + rects.p.h <= 1080);
});
