'use strict';
// Audio device knowledge for the shell (Linux/PipeWire; elsewhere the list is simply empty and the page uses the system default).
// Why this exists: when the page opens the microphone while a Bluetooth headset is the default source, WirePlumber switches the
// headset from A2DP to the HFP/HSP "headset" profile. On some adapters that call audio never flows (see docs/AUDIO.md), and the
// streams stay attached to nodes that vanish when the profile changes. The shell therefore keeps the microphone off Bluetooth
// unless the owner picks it, and tells the page which devices are Bluetooth.
const { execFile } = require('child_process');

const isBt = (p) => p['device.api'] === 'bluez5' || /^bluez_/.test(p['node.name'] || '');

/** pw-dump JSON -> { sinks, sources }: real playback / capture devices (no monitors, no per-app streams, no internal loopbacks). */
function parseDump(dump) {
  const sinks = [], sources = [];
  for (const o of Array.isArray(dump) ? dump : []) {
    if (o?.type !== 'PipeWire:Interface:Node') continue;
    const p = o.info?.props || {};
    const cls = p['media.class'];
    if (cls !== 'Audio/Sink' && cls !== 'Audio/Source' && cls !== 'Audio/Source/Virtual') continue;
    if (/\.monitor$/.test(p['node.name'] || '') || /internal/i.test(p['node.name'] || '')) continue;
    const label = String(p['node.description'] || p['node.nick'] || p['node.name'] || '').trim();
    if (!label) continue;
    (cls === 'Audio/Sink' ? sinks : sources).push({ label, name: p['node.name'], bluetooth: isBt(p) });
  }
  return { sinks, sources };
}
function listDevices() {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve({ sinks: [], sources: [] });
    execFile('pw-dump', { timeout: 4000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ sinks: [], sources: [], error: err.code === 'ENOENT' ? 'pw-dump not installed' : err.message });
      try { resolve(parseDump(JSON.parse(out))); } catch (e) { resolve({ sinks: [], sources: [], error: e.message }); }
    });
  });
}
const CHOICES = new Set(['auto', 'laptop', 'system']);
const cleanChoice = (v) => { v = String(v ?? 'auto').trim().slice(0, 200); return v || 'auto'; };
module.exports = { parseDump, listDevices, cleanChoice, CHOICES };
