'use strict';
// The pop-out window logic of Development Mode panes (no Electron): one window per pane, quiet closes, placement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PaneWindows, paneUrl, placeWindow, PANES } = require('../src/main/devwindows/logic');

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };
function rig(extra = {}) {
  const made = []; const closedByOwner = []; const saved = [];
  const create = (spec, h) => { const w = { spec, h, focused: 0, closed: 0, focus() { this.focused += 1; }, close() { this.closed += 1; h.onClosed(); } }; made.push(w); return w; };
  const pw = new PaneWindows({ create, base: 'http://127.0.0.1:5555', areas: () => [AREA], onClosed: (p) => closedByOwner.push(p), onSaved: (s) => saved.push(JSON.parse(JSON.stringify(s))), ...extra });
  return { pw, made, closedByOwner, saved };
}

test('every pane can have a window, and the page it loads is on the gateway with the pane named', () => {
  assert.deepEqual(PANES, ['tree', 'code', 'diff', 'explain', 'agent', 'browser', 'qa', 'terminal', 'actions']);
  assert.equal(paneUrl('http://127.0.0.1:5555/', 'browser'), 'http://127.0.0.1:5555/dev-window.html?pane=browser');
  assert.equal(paneUrl('http://x', 'terminal', { term: 'ab12cd34ef56' }), 'http://x/dev-window.html?pane=terminal&term=ab12cd34ef56');
  assert.equal(paneUrl('http://x', 'terminal', { term: '../../etc' }), 'http://x/dev-window.html?pane=terminal', 'a terminal id is hex only');
  assert.equal(paneUrl('http://x', 'code', { term: 'ab12cd34' }), 'http://x/dev-window.html?pane=code', 'only the terminal takes an id');
});

test('opening twice gives one window, brought to the front', () => {
  const { pw, made } = rig();
  assert.deepEqual(pw.open('browser'), { pane: 'browser', created: true });
  assert.deepEqual(pw.open('browser'), { pane: 'browser', created: false });
  assert.equal(made.length, 1); assert.equal(made[0].focused, 1);
  assert.equal(made[0].spec.title, 'Jarvis · Browser');
  assert.deepEqual(pw.list(), ['browser']);
});

test('an unknown pane is refused', () => {
  const { pw, made } = rig();
  assert.throws(() => pw.open('settings'), /no pane called settings/);
  assert.equal(made.length, 0);
});

test('the owner closing a window tells the page (so the pane comes back); a close the layout asked for does not', () => {
  const { pw, made, closedByOwner } = rig();
  pw.open('terminal'); pw.open('diff');
  made[0].h.onClosed();   // the window's own close button
  assert.deepEqual(closedByOwner, ['terminal']);
  assert.equal(pw.has('terminal'), false);
  assert.equal(pw.close('diff'), true);   // the page docked it again
  assert.deepEqual(closedByOwner, ['terminal'], 'no echo for a close that was asked for');
  assert.equal(pw.close('diff'), false);
  pw.open('terminal');   // can be opened again after either way of closing
  assert.equal(pw.has('terminal'), true);
});

test('quitting closes every window without telling the page (the layout keeps them for next time)', () => {
  const { pw, made, closedByOwner } = rig();
  pw.open('code'); pw.open('qa');
  pw.closeAll();
  assert.equal(made.every((w) => w.closed === 1), true);
  assert.deepEqual(closedByOwner, []);
  assert.deepEqual(pw.list(), []);
});

test('a window opens where it was last left, and the new bounds are saved as it moves', () => {
  const { pw, made, saved } = rig({ saved: { browser: { x: 300, y: 200, width: 900, height: 600 } } });
  pw.open('browser');
  assert.deepEqual(made[0].spec.bounds, { x: 300, y: 200, width: 900, height: 600 });
  made[0].h.onBounds({ x: 10, y: 20, width: 1000, height: 700, extra: 1 });
  assert.deepEqual(saved.at(-1).browser, { x: 10, y: 20, width: 1000, height: 700 });
});

test('placement: centred on the primary display and staggered, clamped to a display, never off screen', () => {
  assert.deepEqual(placeWindow(null, [AREA], 0), { x: 410, y: 160, width: 1100, height: 760 });
  assert.deepEqual(placeWindow(null, [AREA], 2), { x: 470, y: 220, width: 1100, height: 760 });
  const small = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(placeWindow(null, [small], 0), { x: 0, y: 0, width: 800, height: 600 }, 'bigger than the display: shrunk to fit');
  // saved on a display that is gone (a second monitor unplugged): back to the primary
  assert.deepEqual(placeWindow({ x: 3000, y: 100, width: 900, height: 600 }, [AREA], 0), { x: 510, y: 240, width: 900, height: 600 });
  // half off the edge of a display: pulled back in
  assert.deepEqual(placeWindow({ x: 1700, y: 900, width: 900, height: 600 }, [AREA], 0), { x: 1020, y: 480, width: 900, height: 600 });
  // on a second display
  const second = { x: 1920, y: 0, width: 1280, height: 1024 };
  assert.deepEqual(placeWindow({ x: 2000, y: 50, width: 800, height: 500 }, [AREA, second], 0), { x: 2000, y: 50, width: 800, height: 500 });
  assert.deepEqual(placeWindow({ x: 5, y: 5, width: 10, height: 10 }, [AREA], 0).width, 360, 'never smaller than the minimum');
});
