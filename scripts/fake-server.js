// Dev/verification helper ONLY: a stand-in "paired" Jarvis server so the deck can be exercised without touching the real
// server. Usage: node scripts/fake-server.js [port=8765].
//   GET /health, /api/session      -> ok / paired
//   WS  /ws/session                -> sends a `welcome`, then relays whatever is POSTed to /__push as a server message
//   WS  /ws/terminal/<id>          -> prints a few lines so a terminal portal has something to show
//   GET /api/files/<id>/download   -> scripts/dev-assets/sample.png
// Not part of the app.
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const port = Number(process.argv[2] || 8765);
const clients = new Set();
const WEB = path.resolve(__dirname, '..', 'vendor', 'web');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const png = fs.readFileSync(path.join(__dirname, 'dev-assets', 'sample.png'));
// test media (scripts/dev-assets/make-assets.sh): file id -> asset; camera ids cam1 / cam2 stream a looping fragmented MP4 over /ws/camera/<id>
const ASSETS = process.env.DEV_ASSETS || '/tmp/jd-assets';
const FILES = { img2: ['img2.png', 'image/png'], img3: ['img3.png', 'image/png'], img4: ['img4.png', 'image/png'], sheet: ['sheet.png', 'image/png'], vid1: ['vid1.mp4', 'video/mp4'], vid2: ['vid1.mp4', 'video/mp4'] };
const asset = (n) => { try { return fs.readFileSync(path.join(ASSETS, n)); } catch { return null; } };
const frame = (data, op = 0x1) => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = b.length < 126 ? Buffer.from([0x80 | op, b.length]) : b.length < 65536 ? Buffer.from([0x80 | op, 126, b.length >> 8, b.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); return h; })();
  return Buffer.concat([head, b]);
};
const welcome = { type: 'welcome', tasks: [], approvals: [], files: [], team: [], busy: false, device: 'Dev fake', terminals: [], cameras: [], history: [],
  schedules: { items: [], scheduler: {}, waiting: [] }, status: { spent_usd: 0, budget_usd: 5, busy: false },
  agents: { enabled: true, active: 'jarvis', agents: ['jarvis', 'friday', 'veronica', 'edith'].map((k) => ({ key: k, name: k[0].toUpperCase() + k.slice(1), available: true, detail: '', warm: true, model: 'fake' })) } };
const srv = http.createServer((req, res) => {
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/health') return json({ ok: true, version: '0.1.0' });
  if (req.url.startsWith('/api/session')) return json({ paired: true });
  if (req.method === 'POST' && req.url === '/__push') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { for (const s of clients) s.write(frame(b)); json({ ok: true, clients: clients.size }); }); return;
  }
  const dl = /^\/api\/files\/([^/]+)\/download/.exec(req.url);
  if (dl && FILES[dl[1]] && asset(FILES[dl[1]][0])) {
    const b = asset(FILES[dl[1]][0]); const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { const a = Number(m[1] || 0), z = m[2] ? Number(m[2]) : b.length - 1; res.writeHead(206, { 'content-type': FILES[dl[1]][1], 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${z}/${b.length}`, 'content-length': z - a + 1 }); return res.end(b.subarray(a, z + 1)); }
    res.writeHead(200, { 'content-type': FILES[dl[1]][1], 'accept-ranges': 'bytes', 'content-length': b.length }); return res.end(b);
  }
  const snap = /^\/api\/cameras\/([^/]+)\/snapshot/.exec(req.url);
  if (snap && asset(`${snap[1]}.jpg`)) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(asset(`${snap[1]}.jpg`)); }
  if (/^\/api\/files\/[^/]+\/download/.test(req.url)) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
  if (/^\/api\/files\/[^/]+\/preview/.test(req.url)) return json({ text: 'preview' });
  // static: the vendored web client, with the real server's CSP, so a plain browser can show the same deck for comparison
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = path.resolve(WEB, rel);
  if (!req.url.startsWith('/api/') && f.startsWith(WEB + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' }[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'content-security-policy': CSP }); return fs.createReadStream(f).pipe(res);
  }
  json(req.url.match(/history|list|files|schedules|briefings|sessions|reports/) ? [] : {});
});
srv.on('upgrade', (req, sock) => {
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  console.log('ws', req.url, 'cookie=', req.headers.cookie, 'origin=', req.headers.origin);
  // answer the page's JSON ping (net.js closes a socket that does not pong within 20 s)
  sock.on('data', (d) => { try { if ((d[0] & 15) === 1 && (d[1] & 127) < 126 && d[1] & 128) { const n = d[1] & 127, k = d.subarray(2, 6), t = Buffer.from(d.subarray(6, 6 + n).map((b, i) => b ^ k[i % 4])).toString(); if (JSON.parse(t).type === 'ping') sock.write(frame(JSON.stringify({ type: 'pong' }))); } } catch { /* not a ping */ } }); sock.on('error', () => clients.delete(sock)); sock.on('close', () => clients.delete(sock));
  if (req.url.startsWith('/ws/session')) { clients.add(sock); sock.write(frame(JSON.stringify(welcome))); return; }
  if (req.url.startsWith('/ws/camera/')) {
    const id = req.url.split('/').pop().split('?')[0], mp4 = asset(`${id}.mp4`); if (!mp4) return sock.end();
    sock.write(frame(JSON.stringify({ type: 'init', mime: 'video/mp4; codecs="avc1.42E01E"', audio: false, video: true })));
    sock.write(frame(JSON.stringify({ type: 'status', state: 'live' })));
    let at = 0; const t = setInterval(() => { if (sock.destroyed) return clearInterval(t); sock.write(frame(mp4.subarray(at, at + 16384), 0x2)); at += 16384; if (at >= mp4.length) { clearInterval(t); sock.end(); } }, 150);   // about real time for the test clips
    sock.on('close', () => clearInterval(t)); return;
  }
  if (req.url.startsWith('/ws/terminal/')) {
    sock.write(frame(JSON.stringify({ type: 'info', terminal: { id: req.url.split('/').pop().split('?')[0], title: 'deploy.sh', cwd: '~/jarvis' } })));
    const lines = ['$ ./deploy.sh --env staging', 'building image ........ done', 'running 42 tests ...... 42 passed', 'pushing jarvis:0.1.0 .. ok', 'rollout: 3/3 replicas ready', '$ '];
    lines.forEach((l, i) => setTimeout(() => sock.write(frame(Buffer.from(l + '\r\n'), 0x2)), 300 + i * 250));
  }
});
srv.listen(port, '127.0.0.1', () => console.log('fake jarvis on', port));
