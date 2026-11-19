'use strict';
// Dev only (JARVIS_DESKTOP_DEV=1): a unix socket in the user-data dir so scripts/dev-overlay.js can minimise the window and read
// the overlay state. Not started in normal use.
const net = require('net');
const fs = require('fs');
const path = require('path');
function start({ dir, log, state, main, hotkey, evalIn, displays, capture }) {
  const sock = path.join(dir, 'dev.sock');
  try { fs.rmSync(sock, { force: true }); } catch { /* none */ }
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let out;
        (async () => { try {
          const m = JSON.parse(line);
          if (m.cmd === 'state') out = state();
          else if (m.cmd === 'main') { main(m.action); out = { ok: true }; }
          else if (m.cmd === 'hotkey') out = { suppressed: hotkey() };
          else if (m.cmd === 'eval') out = { result: await evalIn(m.code, m.target) };
          else if (m.cmd === 'displays') { displays(m.list || null); out = { ok: true }; }   // [{id,x,y,width,height,primary?}] or null = the real ones
          else if (m.cmd === 'capture') out = { file: await capture(m.file) };           // PNG of the page (the whole overlay, also the part off the real screen)
          else out = { error: 'unknown' };
        } catch (e) { out = { error: e.message }; }
        c.write(JSON.stringify(out) + '\n'); })();
      }
    });
    c.on('error', () => {});
  });
  srv.listen(sock, () => { fs.chmodSync(sock, 0o600); log('dev control on', sock); });
}
module.exports = { start };
