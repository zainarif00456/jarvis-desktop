'use strict';
// The Development Mode browser driver against a fake DevTools Protocol endpoint (no Electron needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Driver, BrowserError, SNAPSHOT_JS } = require('../src/main/devbrowser/driver');

class FakeCdp {
  constructor(handlers = {}) { this.calls = []; this.listeners = {}; this.handlers = handlers; }
  on(event, fn) { (this.listeners[event] ||= []).push(fn); }
  emit(event, params) { for (const fn of this.listeners[event] || []) fn(params); }
  async send(method, params) {
    this.calls.push([method, params]);
    const h = this.handlers[method];
    return typeof h === 'function' ? h(params) : (h ?? {});
  }
  of(method) { return this.calls.filter(([m]) => m === method).map(([, p]) => p); }
}
const driver = async (handlers, opts = { startGraceMs: 0, quietMs: 20 }) => { const cdp = new FakeCdp(handlers); const d = new Driver(cdp, opts); await d.start(); return { cdp, d }; };
const evalResult = (value) => ({ result: { value } });

test('start turns the protocol domains on', async () => {
  const { cdp } = await driver();
  assert.deepEqual(cdp.calls.map(([m]) => m), ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']);
});

test('console lines: logs, warnings, errors, uncaught exceptions and failed resource loads, drained once', async () => {
  const { cdp, d } = await driver();
  cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 3 }] });
  cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'exploded on purpose' }] });
  cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x is undefined\n    at app.js:1' } } });
  cdp.emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404' } });
  cdp.emit('Log.entryAdded', { entry: { level: 'info', text: 'ignored' } });
  assert.deepEqual(await d.console(), ['log: hello 3', 'error: exploded on purpose', 'error: Uncaught TypeError: x is undefined', 'error: Failed to load resource: 404']);
  assert.deepEqual(await d.console(), []);
});

test('network: status and timing per request, API bodies kept short, failures as status 0', async () => {
  const { cdp, d } = await driver({ 'Network.getResponseBody': () => ({ body: '{"ok":true}'.padEnd(5000, ' ') }) });
  cdp.emit('Network.requestWillBeSent', { requestId: '1', type: 'Fetch', request: { method: 'POST', url: 'http://localhost/api/login' } });
  cdp.emit('Network.responseReceived', { requestId: '1', type: 'Fetch', response: { status: 201 } });
  cdp.emit('Network.loadingFinished', { requestId: '1' });
  cdp.emit('Network.requestWillBeSent', { requestId: '2', type: 'Image', request: { method: 'GET', url: 'http://localhost/a.png' } });
  cdp.emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_CONNECTION_REFUSED' });
  cdp.emit('Network.requestWillBeSent', { requestId: '3', type: 'Fetch', request: { method: 'GET', url: 'http://localhost/cancelled' } });
  cdp.emit('Network.loadingFailed', { requestId: '3', errorText: 'aborted', canceled: true });
  const rows = await d.network();
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].method, rows[0].url, rows[0].status, rows[0].body.length], ['POST', 'http://localhost/api/login', 201, 1500]);
  assert.deepEqual([rows[1].status, rows[1].error], [0, 'net::ERR_CONNECTION_REFUSED']);
  assert.ok(rows.every((r) => typeof r.ms === 'number' && !('t0' in r)));
  assert.deepEqual(await d.network(), []);
});

test('snapshot runs the shared page script and returns its result', async () => {
  const page = { url: 'http://x/', title: 'T', text: 'hi', elements: [{ ref: 'e1', role: 'button', name: 'Go', value: '', disabled: false, box: [1, 2, 3, 4] }], viewport: [800, 600] };
  const { cdp, d } = await driver({ 'Runtime.evaluate': () => evalResult(page) });
  assert.deepEqual(await d.snapshot(), page);
  const [{ expression, returnByValue, awaitPromise }] = cdp.of('Runtime.evaluate');
  assert.ok(expression.startsWith('(()') || expression.startsWith('(() =>') || expression.includes('data-jarvis-ref'));
  assert.ok(returnByValue && awaitPromise);
});

test('click: scrolls to the element, moves, presses and releases at its centre; a stale ref is a plain error', async () => {
  const box = { x: 110, y: 60, w: 100, h: 40, rx: 60, ry: 40 };
  const { cdp, d } = await driver({ 'Runtime.evaluate': () => evalResult(box) });
  await d.click({ ref: 'e3' });
  const mouse = cdp.of('Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map((m) => m.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(mouse.every((m) => m.x === 110 && m.y === 60));
  assert.equal(mouse[1].button, 'left');
  const missing = await driver({ 'Runtime.evaluate': () => evalResult(null) });
  await assert.rejects(() => missing.d.click({ ref: 'e99' }), (e) => e instanceof BrowserError && /no element e99 on the page now/.test(e.message));
});

test('type: focuses and selects the field, inserts the text, optionally presses Enter', async () => {
  let n = 0;
  const { cdp, d } = await driver({ 'Runtime.evaluate': () => evalResult(n++ === 0 ? { x: 5, y: 5, w: 10, h: 10, rx: 0, ry: 0 } : n === 2 ? undefined : true) });
  await d.type({ ref: 'e2', text: 'Buy oat milk', submit: true });
  assert.deepEqual(cdp.of('Input.insertText'), [{ text: 'Buy oat milk' }]);
  assert.deepEqual(cdp.of('Input.dispatchKeyEvent').map((k) => [k.type, k.key]), [['keyDown', 'Enter'], ['keyUp', 'Enter']]);
});

test('press: named keys and single letters, unknown keys refused', async () => {
  const { cdp, d } = await driver();
  await d.press({ key: 'Escape' });
  await d.press({ key: 'a' });
  assert.deepEqual(cdp.of('Input.dispatchKeyEvent').map((k) => [k.type, k.key]), [['rawKeyDown', 'Escape'], ['keyUp', 'Escape'], ['keyDown', 'a'], ['keyUp', 'a']]);
  await assert.rejects(() => d.press({ key: 'Hyper' }), /do not know the key/);
});

test('settle waits for requests in flight and then for quiet', async () => {
  const { cdp, d } = await driver({}, { startGraceMs: 0, quietMs: 30 });
  cdp.emit('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch', request: { method: 'GET', url: 'http://x/slow' } });
  const started = Date.now();
  setTimeout(() => cdp.emit('Network.loadingFinished', { requestId: 'a' }), 120);
  await d.settle({ timeout_ms: 2000 });
  assert.ok(Date.now() - started >= 120, 'returned before the request finished');
  assert.equal(d.pending.size, 0);
  const slow = Date.now();
  cdp.emit('Network.requestWillBeSent', { requestId: 'b', type: 'Fetch', request: { method: 'GET', url: 'http://x/never' } });
  await d.settle({ timeout_ms: 150 });
  assert.ok(Date.now() - slow >= 140 && Date.now() - slow < 600, 'a request that never ends must not hang the loop');
});

test('open: waits for the load event, reports a failed navigation, refuses script urls', async () => {
  const { cdp, d } = await driver({ 'Page.navigate': () => { setTimeout(() => cdp.emit('Page.loadEventFired', {}), 20); return { frameId: 'f' }; } });
  await d.open({ url: 'http://localhost:3000/login' });
  assert.deepEqual(cdp.of('Page.navigate'), [{ url: 'http://localhost:3000/login' }]);
  const bad = await driver({ 'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }) });
  await assert.rejects(() => bad.d.open({ url: 'http://nope.invalid' }), /ERR_NAME_NOT_RESOLVED/);
  await assert.rejects(() => d.open({ url: 'javascript:alert(1)' }), /web addresses/);
});

test('screenshot returns base64; unknown operations are refused; close blanks the page and forgets evidence', async () => {
  const { cdp, d } = await driver({ 'Page.captureScreenshot': () => ({ data: 'iVBORw0KGgo=' }) });
  assert.equal(await d.call('screenshot'), 'iVBORw0KGgo=');
  await assert.rejects(() => d.call('exec', {}), /unknown browser operation/);
  cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x' }] });
  await d.call('close');
  assert.deepEqual(cdp.of('Page.navigate').pop(), { url: 'about:blank' });
  assert.deepEqual(await d.console(), []);
});

test('the page script is syntactically valid and identical to the server copy when both repos are side by side', () => {
  assert.doesNotThrow(() => new Function(`return (${SNAPSHOT_JS})`));
  const server = path.resolve(__dirname, '..', '..', 'project-jarvis', 'server', 'jarvis', 'devmode', 'browser', 'snapshot.js');
  if (fs.existsSync(server)) assert.equal(SNAPSHOT_JS, fs.readFileSync(server, 'utf8'), 'snapshot.js drifted from the server copy: copy it over');
});
