// WebSocket connection that stays up: reconnects by itself, fast, and never runs two sockets.
//
// - One socket at a time. Every socket has a generation number; events from an older socket are
//   ignored, so a late onclose can never open a second connection.
// - Reconnect at once when the tab comes back, the network returns, or the page wakes from a
//   browser freeze; otherwise retry with a short, jittered backoff.
// - Watchdog: a ping every 15 s; no answer within 20 s of a ping (or a send buffer that stopped
//   draining) means the socket is dead even if the browser has not noticed yet.
// - Diagnosis: the server is told how the previous socket ended and whether the browser had
//   frozen or discarded the tab (logged as ws.open).

const PING_EVERY_MS = 15000;
const PONG_TIMEOUT_MS = 20000;
const STUCK_BUFFER_BYTES = 2 * 1024 * 1024;  // ~1 min of mic audio that never left
const STALE_CLOSE = 4000;  // our own code: "this socket looked dead, reconnecting"

export function connect({ onMessage, onState, onBinary }) {
  let ws = null; let gen = 0; let attempt = 0; let closed = false;
  let pingTimer = null; let retryTimer = null;
  let lastRx = 0; let lastPing = 0;
  let everOpen = false;  // after the first connection, every new one is a reconnect (no greeting)
  let lastClose = '';    // how the previous socket ended, reported on reconnect for diagnosis
  let frozenAt = 0;
  let lifecycle = document.wasDiscarded ? '&d=1' : '';  // the browser discarded this tab and reloaded it

  const live = () => ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);

  const open = () => {
    clearTimeout(retryTimer); retryTimer = null;
    if (closed || live()) return;
    const mine = ++gen;
    onState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = `r=${everOpen ? 1 : 0}&v=${document.hidden ? 0 : 1}${lastClose}${lifecycle}`;
    lifecycle = '';
    const sock = new WebSocket(`${proto}://${location.host}/ws/session?${query}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      if (mine !== gen) return;
      attempt = 0; everOpen = true; lastRx = Date.now(); lastPing = 0;
      sock.send(JSON.stringify({ type: 'hello', client: 'web' }));
      clearInterval(pingTimer);
      pingTimer = setInterval(watch, PING_EVERY_MS);
      onState('open');
    };
    sock.onmessage = (event) => {
      if (mine !== gen) return;
      lastRx = Date.now();
      if (event.data instanceof ArrayBuffer) { if (onBinary) onBinary(event.data); return; }
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { console.error('bad message', err); return; }
      if (msg.type === 'pong') return;
      try { onMessage(msg); } catch (err) { console.error('message handler failed', msg.type, err); }
    };
    sock.onclose = (event) => {
      if (mine !== gen) return;  // an old socket ending late: already replaced
      clearInterval(pingTimer); ws = null;
      lastClose = `&c=${event.code}&h=${document.hidden ? 1 : 0}&o=${navigator.onLine ? 1 : 0}`;
      if (event.code === 4401 || event.code === 4403) { onState('unauthorized'); return; }
      onState('closed');
      if (closed) return;
      attempt += 1;
      // first retry almost at once (a restart or a blip), then back off; jitter avoids lockstep
      const base = attempt === 1 ? 250 : Math.min(1000 * 2 ** Math.min(attempt - 2, 4), 15000);
      retryTimer = setTimeout(open, base + Math.random() * 250);
    };
    sock.onerror = () => { /* onclose follows */ };
  };

  // Runs every PING_EVERY_MS (a hidden tab may run it less often: the checks allow for that).
  const watch = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const unanswered = lastPing && lastRx < lastPing && now - lastPing > PONG_TIMEOUT_MS;
    if (unanswered || ws.bufferedAmount > STUCK_BUFFER_BYTES) { reopen('stale'); return; }
    lastPing = now;
    ws.send(JSON.stringify({ type: 'ping' }));
  };

  // Drop a socket that looks dead and connect again straight away.
  const reopen = () => {
    const old = ws; gen += 1; ws = null; clearInterval(pingTimer);
    if (old) { try { old.close(STALE_CLOSE, 'stale'); } catch { /* already closing */ } }
    lastClose = `&c=${STALE_CLOSE}&h=${document.hidden ? 1 : 0}&o=${navigator.onLine ? 1 : 0}`;
    onState('closed');
    open();
  };

  // Something changed that makes a reconnect worth trying now instead of waiting for the timer.
  const nudge = () => {
    if (closed) return;
    if (!live()) { attempt = 0; open(); return; }
    if (ws.readyState === WebSocket.OPEN) watch();  // check the open one is really alive
  };

  open();
  document.addEventListener('visibilitychange', () => {
    // tell the server whether the owner can see Jarvis: a greeting needs a real return
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', visible: !document.hidden }));
    if (!document.hidden) nudge();
  });
  window.addEventListener('online', nudge);
  window.addEventListener('pageshow', (e) => { if (e.persisted) nudge(); });  // back from the back/forward cache
  document.addEventListener('freeze', () => { frozenAt = Date.now(); });     // Chrome paused the tab
  document.addEventListener('resume', () => {
    if (frozenAt) lifecycle = `&f=${Math.round((Date.now() - frozenAt) / 1000)}`;
    frozenAt = 0; nudge();
  });

  return {
    send(payload) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(payload)); return true; } return false; },
    sendBinary(buffer) { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(buffer); return true; } return false; },
    close() { closed = true; clearTimeout(retryTimer); clearInterval(pingTimer); if (ws) ws.close(1000); },
    get open() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
}
