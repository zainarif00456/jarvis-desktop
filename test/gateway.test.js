'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createGateway } = require('../src/main/gateway');
const { normalizeBaseUrl } = require('../src/main/store');

// A fake Jarvis server: records what it receives, mimics the Origin==Host rule and the cookie-only auth.
function fakeServer() {
  const seen = []; const socks = new Set();
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/api/pair' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        seen[seen.length - 1].body = b;
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'jarvis_device=TOKEN123; HttpOnly; Path=/; SameSite=Strict' });
        res.end('{"ok":true}');
      }); return;
    }
    if (req.url === '/api/me') { const ok = /jarvis_device=TOKEN123/.test(req.headers.cookie || ''); res.writeHead(ok ? 200 : 401); return res.end('{}'); }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"version":"0.1.0"}'); }
    res.writeHead(404); res.end();
  });
  srv.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, ws: true });
    const key = req.headers['sec-websocket-key'];
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));   // text frame "hi"
  });
  srv.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); }); srv.destroyAll = () => socks.forEach((s) => s.destroy());
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, port: srv.address().port })));
}
const get = (port, p, headers = {}, method = 'GET', body) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b })); });
  r.on('error', rej); if (body) r.write(body); r.end();
});

test('gateway', async (t) => {
  const f = await fakeServer(); let token = 'TOKEN123';
  const gw = createGateway({ webRoot: path.join(__dirname, '..', 'vendor', 'web'), getTarget: () => `http://127.0.0.1:${f.port}`, getToken: () => token,
    setToken: (x) => { token = x; }, deviceName: 'Test Device' });
  await gw.listen();
  const H = { host: `127.0.0.1:${gw.port}`, [gw.SECRET_HEADER]: gw.secret };
  t.after(() => { gw.close(); f.srv.close(); f.srv.destroyAll(); });

  await t.test('rejects requests without the secret or with a foreign Host', async () => {
    assert.strictEqual((await get(gw.port, '/', { host: `127.0.0.1:${gw.port}` })).status, 403);
    assert.strictEqual((await get(gw.port, '/', { ...H, host: 'evil.example' })).status, 403);
  });
  await t.test('serves the vendored UI with the CSP', async () => {
    const r = await get(gw.port, '/', H); assert.strictEqual(r.status, 200); assert.match(r.body, /<title>Jarvis<\/title>/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.strictEqual((await get(gw.port, '/js/main.js', H)).status, 200);
    assert.strictEqual((await get(gw.port, '/..%2f..%2fpackage.json', H)).status, 403);
  });
  await t.test('malformed percent-encoding gets 400 and does not crash the gateway', async () => {
    assert.strictEqual((await get(gw.port, '/%E0%A4%A', H)).status, 400);
    assert.strictEqual((await get(gw.port, '/%00', H)).status, 400);
    assert.strictEqual((await get(gw.port, '/', H)).status, 200);
  });
  await t.test('injects the cookie, strips Origin, forwards /api', async () => {
    const r = await get(gw.port, '/api/me', { ...H, origin: `http://127.0.0.1:${gw.port}`, cookie: 'jarvis_device=EVIL' });
    assert.strictEqual(r.status, 200);
    const s = f.seen.find((x) => x.url === '/api/me');
    assert.strictEqual(s.headers.origin, undefined); assert.strictEqual(s.headers.cookie, 'jarvis_device=TOKEN123');
    assert.strictEqual(s.headers.host, `127.0.0.1:${f.port}`); assert.strictEqual(s.headers['ngrok-skip-browser-warning'], '1');
    assert.strictEqual(s.headers[gw.SECRET_HEADER], undefined);
  });
  await t.test('captures the pairing token, hides Set-Cookie, labels the device', async () => {
    token = null;
    const body = JSON.stringify({ code: 'ABCD2345', name: 'Browser' });
    const r = await get(gw.port, '/api/pair', { ...H, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, 'POST', body);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['set-cookie'], undefined); assert.strictEqual(token, 'TOKEN123');
    assert.strictEqual(JSON.parse(f.seen.find((x) => x.url === '/api/pair').body).name, 'Test Device');
  });
  await t.test('proxies WebSocket upgrades (no Origin, cookie injected) and rejects without secret', async () => {
    const open = (extra) => new Promise((resolve) => {
      const s = net.connect(gw.port, '127.0.0.1', () => s.write(`GET /ws/session?r=1 HTTP/1.1\r\nHost: 127.0.0.1:${gw.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://127.0.0.1:${gw.port}\r\n${extra}\r\n`));
      let buf = ''; s.on('data', (d) => { buf += d.toString('latin1'); if (/\r\n\r\n.+/s.test(buf) || buf.length > 400) { s.destroy(); resolve(buf); } });
      s.on('close', () => resolve(buf)); s.on('error', () => resolve(buf)); setTimeout(() => { s.destroy(); resolve(buf); }, 1500);
    });
    assert.match(await open(`${gw.SECRET_HEADER}: ${gw.secret}\r\n`), /101 Switching/);
    const ws = f.seen.find((x) => x.ws); assert.strictEqual(ws.headers.origin, undefined); assert.strictEqual(ws.headers.cookie, 'jarvis_device=TOKEN123');
    assert.doesNotMatch(await open(''), /101 Switching/);
  });
  await t.test('502 JSON when the server is down', async () => {
    const gw2 = createGateway({ webRoot: '.', getTarget: () => 'http://127.0.0.1:1', getToken: () => null, setToken() {} }); await gw2.listen();
    const r = await get(gw2.port, '/health', { host: `127.0.0.1:${gw2.port}`, [gw2.SECRET_HEADER]: gw2.secret }); gw2.close();
    assert.strictEqual(r.status, 502); assert.match(r.body, /unreachable/);
  });
});

test('normalizeBaseUrl', () => {
  assert.strictEqual(normalizeBaseUrl('localhost:8000'), 'http://localhost:8000');
  assert.strictEqual(normalizeBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
  assert.strictEqual(normalizeBaseUrl('abc.ngrok-free.app'), 'https://abc.ngrok-free.app');
  assert.strictEqual(normalizeBaseUrl('100.100.1.2:8000'), 'http://100.100.1.2:8000');
  assert.throws(() => normalizeBaseUrl('http://example.com'));
  assert.throws(() => normalizeBaseUrl('ftp://x'));
});
