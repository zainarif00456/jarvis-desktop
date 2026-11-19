'use strict';
// Health / pairing probes against the Jarvis server (plain fetch from the main process: no Origin header).
const TIMEOUT = 4000;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'ngrok-skip-browser-warning': '1', ...headers }, redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, html: /^\s*</.test(text), headers: r.headers };
  } finally { clearTimeout(t); }
}

/** state: unreachable | not-jarvis | ok. `paired` only when a token is given. */
async function probe(baseUrl, token) {
  let h;
  try { h = await getJson(`${baseUrl}/health`); }
  catch (e) { return { state: 'unreachable', detail: e.name === 'AbortError' ? 'timed out' : (e.cause?.code || e.message) }; }
  if (!h.json || h.json.ok !== true) {
    return { state: 'not-jarvis', detail: h.html ? 'got a web page, not Jarvis (wrong address, or an ngrok/proxy interstitial)' : `unexpected reply (HTTP ${h.status})` };
  }
  const out = { state: 'ok', version: h.json.version || null, paired: false };
  try {
    const s = await getJson(`${baseUrl}/api/session`, token ? { cookie: `jarvis_device=${token}` } : {});
    out.paired = !!(s.json && s.json.paired);
  } catch { /* health said ok; pairing state unknown */ }
  return out;
}

async function pair(baseUrl, code, name) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST', signal: ctrl.signal, redirect: 'manual',
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({ code: String(code).trim(), name: String(name || 'Jarvis Desktop').slice(0, 60) }),
    });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    let token = null;
    for (const c of sc) { const m = /(?:^|,\s*)jarvis_device=([^;]+)/.exec(c); if (m) token = decodeURIComponent(m[1]); }
    if (!r.ok) {
      let detail = `HTTP ${r.status}`; try { detail = (await r.json()).detail || detail; } catch { /* keep */ }
      return { ok: false, error: detail };
    }
    if (!token) return { ok: false, error: 'The server accepted the code but sent no device token.' };
    return { ok: true, token };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timed out' : `could not reach the server (${e.cause?.code || e.message})` }; }
  finally { clearTimeout(t); }
}
module.exports = { probe, pair };
