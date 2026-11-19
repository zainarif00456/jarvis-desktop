#!/usr/bin/env node
// Dev command: fire test portals (a picture, a terminal, a briefing card) at the running Jarvis Desktop while its main window
// is minimised, so you can watch them hover over your other apps.
//
//   terminal 1:  node scripts/fake-server.js 8765
//   terminal 2:  JARVIS_DESKTOP_DEV=1 JARVIS_DESKTOP_USERDATA=/tmp/jd-dev npm start      (config: baseUrl http://127.0.0.1:8765, configured:true)
//   terminal 3:  node scripts/dev-overlay.js /tmp/jd-dev            fire portals (minimises the main window first)
//                node scripts/dev-overlay.js /tmp/jd-dev clear      dissolve them again
//                node scripts/dev-overlay.js /tmp/jd-dev state      print overlay state
//                node scripts/dev-overlay.js /tmp/jd-dev hotkey     same as pressing the overlay hotkey
// The messages go through the fake server as if Jarvis had sent them, so the web client's own code builds the portals.
const net = require('net'), http = require('http'), path = require('path');
const [dir = '/tmp/jd-dev', what = 'fire'] = process.argv.slice(2);
const FAKE = Number(process.env.FAKE_PORT || 8765);
const dev = (msg) => new Promise((res, rej) => {
  const c = net.connect(path.join(dir, 'dev.sock'), () => c.write(JSON.stringify(msg) + '\n'));
  c.on('data', (d) => { res(JSON.parse(String(d))); c.end(); }); c.on('error', rej);
});
const push = (msg) => new Promise((res, rej) => {
  const body = JSON.stringify(msg);
  const r = http.request({ host: '127.0.0.1', port: FAKE, path: '/__push', method: 'POST' }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res(JSON.parse(b))); });
  r.on('error', rej); r.end(body);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = { id: 'f1', name: 'hologram-test.png', mime: 'image/png', owner: 'jarvis', size: 33975, created_at: new Date().toISOString(), description: 'test picture' };

(async () => {
  if (what === 'state') return console.log(await dev({ cmd: 'state' }));
  if (what === 'eval') return console.log(JSON.stringify((await dev({ cmd: 'eval', code: process.argv[4], target: process.argv[5] })).result, null, 1));   // optional 5th arg: 'settings' evaluates in the settings window
  if (what === 'displays') {   // displays /tmp/jd-dev two|one|real : pretend a second 1280x1024 display to the right of a 1920x1080 primary (dev only)
    const list = { two: [{ id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }, { id: 2, x: 1920, y: 0, width: 1280, height: 1024 }], one: [{ id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }], real: null }[process.argv[4] || 'two'];
    return console.log(await dev({ cmd: 'displays', list }));
  }
  if (what === 'capture') return console.log(await dev({ cmd: 'capture', file: process.argv[4] || '/tmp/overlay-capture.png' }));   // PNG of the whole page (also the part beyond the real screen)
  if (what === 'hotkey') return console.log(await dev({ cmd: 'hotkey' }));
  if (what === 'exec' || what === 'stuck' || what === 'interrupt') {
    // exec cards as the server's activity feed sends them: exec_start, then exec_end with the structured result.
    if (!process.env.NO_APP && process.env.MAIN_ACTION !== 'none') { await dev({ cmd: 'main', action: process.env.MAIN_ACTION || 'minimize' }); await sleep(600); }
    const st = (id, kind, title, who = 'jarvis') => push({ type: 'exec_start', id, kind, title, who });
    const en = (id, result, ok = true, ms = 900) => push({ type: 'exec_end', id, ok, ms, result });
    await st('x1', 'shell', 'sleep 3; DISPLAY=:0 xdotool key super');
    if (what === 'stuck') { console.log('x1 started and never ended'); return; }
    if (what === 'interrupt') { await sleep(1500); await push({ type: 'turn_interrupted', turn_id: 't1' }); return console.log('turn_interrupted pushed'); }
    await st('x2', 'tool', 'Gmail: check inbox', 'friday'); await st('x3', 'read', 'Read README.md'); await st('x4', 'search', 'Search: overlay');
    await sleep(900);
    await en('x2', { type: 'data', data: { status: 'ok', unread: 3, messages: [{ from: 'Awais', subject: 'Staging deploy', date: new Date().toISOString() }, { from: 'Sara', subject: 'Invoice 114', date: new Date().toISOString() }] } });
    await en('x3', { type: 'lines', path: '~/jarvis/README.md', text: '# Jarvis\nPersonal assistant.\nRuns on the laptop.', start: 1 });
    await en('x4', { type: 'hits', items: [{ path: '~/jarvis/src/overlay.js', line: 12, text: 'const overlay = ...' }] });
    await en('x1', { type: 'terminal', cwd: '~', command: 'sleep 3; echo done', stdout: 'done\n', exit: 0 });
    return console.log('exec cards pushed');
  }
  if (what === 'cards' || what === 'single' || what === 'sheet' || what === 'full' || what === 'unfull') {
    // hologram cards: node scripts/dev-overlay.js DIR cards   3+ pictures, a video, two cameras (needs scripts/dev-assets/make-assets.sh; fake server)
    //                                              single | sheet (the 4x2 contact sheet alone)   full <win id> | unfull <win id>   (screen.control full_screen / exit_full_screen)
    if (what === 'full' || what === 'unfull') return console.log(await push({ type: 'screen_cmd', cmd_id: `f${Date.now()}`, action: what === 'full' ? 'maximise' : 'unmaximise', target: process.argv[4] || 'file-sheet', args: {} }));
    if (!process.env.NO_APP && process.env.MAIN_ACTION !== 'none') { await dev({ cmd: 'main', action: process.env.MAIN_ACTION || 'minimize' }); await sleep(600); }
    const now = new Date().toISOString();
    const f = (id, name, mime, size) => ({ id, name, mime, owner: 'jarvis', size, created_at: now, description: name });
    const files = [f('f1', 'hologram-test.png', 'image/png', 33975), f('img2', 'gradient.png', 'image/png', 45397), f('img3', 'portrait-plasma.png', 'image/png', 4761982), f('img4', 'wide.png', 'image/png', 26133), f('sheet', 'jackets-all.png', 'image/png', 5480000), f('vid1', 'clip.mp4', 'video/mp4', 843544)];
    for (const x of files) await push({ type: 'file_added', file: x });
    await push({ type: 'cameras', cameras: [{ id: 'cam1', name: 'Front door', kind: 'camera', state: 'live' }, { id: 'cam2', name: 'Garage', kind: 'camera', state: 'live' }] });
    const open = (id) => push({ type: 'screen_cmd', cmd_id: `o-${id}`, action: 'open', target: null, args: { what: 'file', id } });
    if (what === 'sheet') { await open('sheet'); return console.log('sheet opened'); }
    if (what === 'single') { await open('img2'); return console.log('single opened'); }
    for (const id of ['f1', 'img2', 'img3', 'vid1']) { await open(id); await sleep(250); }
    await push({ type: 'camera_open', ids: ['cam1', 'cam2'], focus: 'cam1' });
    return console.log('cards pushed');
  }
  if (what === 'clear') {
    await push({ type: 'screen_cmd', cmd_id: 'c9', action: 'close_all', args: {} });
    await push({ type: 'terminal_closed', id: 't1' }); await push({ type: 'briefing_cleared', ids: ['b1'] });
    return console.log('cleared');
  }
  if (!process.env.NO_APP && process.env.MAIN_ACTION !== 'none') { await dev({ cmd: 'main', action: process.env.MAIN_ACTION || 'minimize' }); await sleep(600); }   // NO_APP=1: only push (e.g. to a browser tab on the fake server)
  console.log('pushed', await push({ type: 'file_added', file }));
  await push({ type: 'screen_cmd', cmd_id: 'c1', action: 'open', target: null, args: { what: 'file', id: 'f1' } });
  await sleep(500);
  await push({ type: 'terminal_opened', terminal: { id: 't1', title: 'deploy.sh', cwd: '~/jarvis', by: 'jarvis' } });
  await sleep(500);
  await push({ type: 'briefing_request', runs: [{ id: 'b1', title: 'Morning briefing', priority: 'high', preview: 'Three things need you today: the staging deploy, two approvals and a calendar clash.' }] });
  await sleep(2500);
  if (!process.env.NO_APP) console.log(await dev({ cmd: 'state' }));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
