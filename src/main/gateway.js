'use strict';
// Loopback gateway: serves the vendored web UI and forwards /api, /health, /ws to the Jarvis server,
// adding the device cookie from the keychain and dropping Origin. See docs/ADAPTATIONS.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const httpProxy = require('http-proxy');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
const PROXIED = /^\/(api|health|ws)(\/|\?|$)/;
const SECRET_HEADER = 'x-jd-gateway';

/**
 * @param {{webRoot:string, getTarget:()=>string, getToken:()=>(string|null), setToken:(t:string)=>void,
 *          clearToken?:()=>void, deviceName?:string, log?:(...a:any[])=>void}} o
 */
function createGateway(o) {
  const log = o.log || (() => {});
  const secret = crypto.randomBytes(24).toString('hex');
  const proxy = httpProxy.createProxyServer({ changeOrigin: false, xfwd: false, ws: true, secure: true });
  let port = 0;
  const hostOk = (h) => h === `127.0.0.1:${port}`;

  function prep(proxyReq, req) {
    const t = new URL(o.getTarget());
    proxyReq.removeHeader('origin');                 // no Origin = "non-browser client" in the server's same-origin rule
    proxyReq.removeHeader(SECRET_HEADER);
    proxyReq.removeHeader('referer');
    proxyReq.removeHeader('cookie');
    proxyReq.setHeader('host', t.host);
    const tok = o.getToken();
    if (tok) proxyReq.setHeader('cookie', `jarvis_device=${tok}`);
    proxyReq.setHeader('ngrok-skip-browser-warning', '1');
    proxyReq.setHeader('user-agent', `JarvisDesktop/${o.version || '0'} (${process.platform}) ${req.headers['user-agent'] || ''}`.trim());
  }
  proxy.on('proxyReq', prep);
  proxy.on('proxyReqWs', prep);
  proxy.on('proxyRes', (pres, req) => {
    // Capture the pairing token, keep it out of the renderer (HttpOnly cookie that JS cannot read anyway).
    const sc = pres.headers['set-cookie'];
    if (sc) {
      const kept = [];
      for (const c of [].concat(sc)) {
        const m = /^jarvis_device=([^;]*)/.exec(c);
        if (m) { if (m[1]) o.setToken(decodeURIComponent(m[1])); else o.clearToken?.(); log('gateway: device token captured'); }
        else kept.push(c);
      }
      if (kept.length) pres.headers['set-cookie'] = kept; else delete pres.headers['set-cookie'];
    }
    // ngrok free-tier interstitial returns HTML where JSON is expected.
    if (/^\/api\//.test(req.url) && /text\/html/.test(pres.headers['content-type'] || '') && pres.statusCode === 200 && !/^\/api\/.*\.html/.test(req.url)) {
      log('gateway: HTML reply on an API route (wrong URL or an ngrok/proxy page)');
    }
  });
  proxy.on('error', (err, req, res) => {
    log('gateway proxy error', err.code || err.message, req.url);
    if (res && typeof res.writeHead === 'function' && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Jarvis server unreachable', code: err.code || 'ERR' }));
    } else if (res && res.destroy) res.destroy();
  });

  function pairBodyRewrite(req, res) {
    // The web pairing card posts name:"Browser"; label this device properly. Same JSON shape, same route.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      try { const j = JSON.parse(body.toString('utf8')); if (j && (j.name === 'Browser' || !j.name)) j.name = o.deviceName || 'Jarvis Desktop'; body = Buffer.from(JSON.stringify(j)); } catch { /* pass through */ }
      req.headers['content-length'] = String(body.length);
      const { Readable } = require('stream');
      proxy.web(req, res, { target: o.getTarget(), buffer: Readable.from([body]) });
    });
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req.headers.host) || req.headers[SECRET_HEADER] !== secret) { res.writeHead(403); return res.end('forbidden'); }
    let pathname;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end('bad request'); }
    if (pathname.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
    if (PROXIED.test(req.url)) {
      if (req.method === 'POST' && pathname === '/api/pair') return pairBodyRewrite(req, res);
      return proxy.web(req, res, { target: o.getTarget() });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(o.webRoot, rel);
    if (!file.startsWith(path.resolve(o.webRoot) + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-security-policy': CSP,
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'cache-control': rel === 'index.html' ? 'no-store' : 'no-cache', 'content-length': st.size };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req.headers.host) || req.headers[SECRET_HEADER] !== secret || !PROXIED.test(req.url)) { socket.destroy(); return; }
    socket.on('error', () => {});
    proxy.ws(req, socket, head, { target: o.getTarget() });
  });

  return {
    secret, SECRET_HEADER,
    get port() { return port; },
    get url() { return `http://127.0.0.1:${port}`; },
    // A stable port keeps the page origin (and so its localStorage: portal positions, fx tier, volume) the same between launches.
    listen: (preferred = 0) => new Promise((resolve, reject) => {
      const go = (p) => {
        server.once('error', (e) => { if (p && e.code === 'EADDRINUSE') go(0); else reject(e); });
        server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); });
      };
      go(preferred);
    }),
    close: () => { proxy.close(); server.close(); server.closeAllConnections?.(); },
  };
}
module.exports = { createGateway, CSP, SECRET_HEADER };
