'use strict';
const $ = (id) => document.getElementById(id);
const say = (id, text, cls) => { const e = $(id); e.textContent = text || ''; e.className = 'out' + (cls ? ' ' + cls : ''); };
let cfg = null;

const MSG = {
  unreachable: (r) => `Cannot reach the server (${r.detail || 'no answer'}). Is "jarvis serve" running at that address?`,
  'not-jarvis': (r) => `Something answered, but it is not Jarvis: ${r.detail}.`,
  invalid: (r) => r.detail,
};
function describe(r) {
  if (r.state === 'ok') return [`Connected. Jarvis server v${r.version || '?'}. ${r.paired ? 'This device is paired.' : 'Not paired yet: enter a pairing code below.'}`, r.paired ? 'ok' : 'warn'];
  return [(MSG[r.state] || (() => r.state))(r), 'bad'];
}
async function refresh() {
  cfg = await window.jd.get();
  $('base').value = cfg.baseUrl;
  $('hotkey').value = cfg.hotkey;
  for (const k of ['alwaysOnTop', 'closeToTray', 'startOnLogin', 'notifications', 'overlay']) $(k).checked = !!cfg[k];
  $('overlayHotkey').value = cfg.overlayHotkey || '';
  if (cfg.overlayHotkeyState?.error) say('ohk-out', cfg.overlayHotkeyState.error, 'warn');
  else if (cfg.overlayHotkeyState?.registered) say('ohk-out', `Overlay hotkey active: ${cfg.overlayHotkeyState.accelerator}`, 'ok');
  const t = $('tokstate'); t.textContent = cfg.hasToken ? 'Paired (token in ' + (cfg.tokenBackend === 'keychain' ? 'system keychain' : 'encrypted file; no keyring found') + ')' : 'Not paired'; t.className = 'pill' + (cfg.hasToken ? ' ok' : '');
  $('forget').disabled = !cfg.hasToken;
  if (cfg.hotkeyState?.error) say('hk-out', cfg.hotkeyState.error, 'warn');
  else if (cfg.hotkeyState?.registered) say('hk-out', `Global hotkey active: ${cfg.hotkeyState.accelerator}`, 'ok');
  $('about').textContent = `Jarvis Desktop ${cfg.appVersion} · ${cfg.platform}${cfg.sessionType ? ' / ' + cfg.sessionType : ''} · UI vendored from Jarvis ${cfg.uiManifest.serverVersion || '?'} (${(cfg.uiManifest.sourceCommit || '').slice(0, 8)})`;
  if (!$('devname').value) $('devname').value = 'Jarvis Desktop';
  await fillAudio();
}
const AUDIO_OPTS = {
  audioInput: [['auto', 'Automatic: laptop / non-Bluetooth microphone (recommended)'], ['laptop', 'Laptop microphone (never Bluetooth)'], ['system', 'Follow the system default (may switch earbuds to call mode)']],
  audioOutput: [['auto', 'Automatic: system default output'], ['laptop', 'Laptop speakers (never Bluetooth)'], ['system', 'Follow the system default']],
};
async function fillAudio() {
  let d = { sinks: [], sources: [] }; try { d = (await window.jd.audioDevices()) || d; } catch { /* none */ }
  for (const [id, list] of [['audioInput', d.sources], ['audioOutput', d.sinks]]) {
    const sel = $(id), want = cfg?.[id] || 'auto'; sel.textContent = '';
    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    for (const [v, t] of AUDIO_OPTS[id]) add(v, t);
    for (const x of list) add(x.label, x.label + (x.bluetooth ? ' (Bluetooth)' : ''));
    if (![...sel.options].some((o) => o.value === want)) add(want, want + ' (not connected now)');
    sel.value = want;
  }
  say('audio-out', d.error ? `Device list unavailable (${d.error}); automatic mode still works.` : '');
}
$('audio-laptop').onclick = () => { $('audioInput').value = 'laptop'; $('audioOutput').value = 'laptop'; say('audio-out', 'Laptop speakers and microphone selected. Press Save to apply.', 'ok'); };
$('audio-reset').onclick = () => { $('audioInput').value = 'auto'; $('audioOutput').value = 'auto'; say('audio-out', 'Automatic selected. Press Save to apply.', 'ok'); };
$('audio-refresh').onclick = fillAudio;
async function test() {
  say('test-out', 'Testing…'); const r = await window.jd.test($('base').value);
  const [m, c] = describe(r); say('test-out', m, c); return r;
}
$('test').onclick = test;
$('pair').onclick = async () => {
  const code = $('code').value.trim(); if (!code) return say('pair-out', 'Enter the pairing code from "jarvis pair".', 'warn');
  say('pair-out', 'Pairing…'); const r = await window.jd.pair({ baseUrl: $('base').value, code, name: $('devname').value });
  if (r.ok) { say('pair-out', 'Paired.', 'ok'); $('code').value = ''; await refresh(); } else say('pair-out', r.error, 'bad');
};
$('forget').onclick = async () => { await window.jd.forget($('base').value); say('pair-out', 'Device forgotten. Pair again to continue.', 'warn'); await refresh(); };
function recorder(id, clearId, outId) {
  $(clearId).onclick = () => { $(id).value = ''; };
  $(id).addEventListener('keydown', (e) => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = []; if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
    let key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.code;
    if (!mods.length) return say(outId, 'Use at least one modifier (Ctrl/Cmd, Alt or Shift).', 'warn');
    $(id).value = [...mods, key].join('+'); say(outId, '');
  });
}
recorder('hotkey', 'hk-clear', 'hk-out'); recorder('overlayHotkey', 'ohk-clear', 'ohk-out');
$('save').onclick = async () => {
  const r = await window.jd.save({ baseUrl: $('base').value, hotkey: $('hotkey').value, alwaysOnTop: $('alwaysOnTop').checked, closeToTray: $('closeToTray').checked,
    startOnLogin: $('startOnLogin').checked, notifications: $('notifications').checked, overlay: $('overlay').checked, overlayHotkey: $('overlayHotkey').value,
    audioInput: $('audioInput').value, audioOutput: $('audioOutput').value });
  if (!r.ok) return say('save-out', r.error, 'bad');
  cfg = r.settings; say('save-out', 'Saved. Connecting…', 'ok');
  const o = await window.jd.openApp();
  if (o.state !== 'ok') { const t = await test(); say('save-out', 'Saved, but the server is not reachable yet.', 'warn'); }
};
window.jd.onStatus((s) => { if (s.state === 'ok' && new URLSearchParams(location.search).get('reason') === 'unreachable') window.jd.openApp(); });
(async () => {
  await refresh();
  const reason = new URLSearchParams(location.search).get('reason');
  const b = $('banner');
  if (reason === 'first-run') { b.hidden = false; b.className = 'banner info'; b.textContent = 'Welcome. Confirm the server address, pair this device, then open Jarvis.'; }
  else if (reason === 'unreachable' || reason === 'not-jarvis') { b.hidden = false; b.textContent = reason === 'unreachable' ? 'Jarvis server is unreachable. Retrying every few seconds; you can also fix the address below.' : 'That address answered, but not like a Jarvis server.'; test(); }
})();
