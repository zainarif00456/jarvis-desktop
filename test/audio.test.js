'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseDump, cleanChoice } = require('../src/main/audio');

const node = (id, name, cls, desc, extra = {}) => ({ id, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': name, 'media.class': cls, 'node.description': desc, ...extra } } });
const DUMP = [
  node(55, 'alsa_output.pci-0000_00_1f.3.analog-stereo', 'Audio/Sink', 'Built-in Audio Analog Stereo'),
  node(56, 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'Audio/Source', 'Built-in Audio Analog Stereo'),
  node(57, 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor', 'Audio/Source', 'Monitor of Built-in'),
  node(73, 'bluez_output.11_E1_CF_FA_77_44.1', 'Audio/Sink', 'AIRBUD', { 'device.api': 'bluez5' }),
  node(90, 'bluez_input.11:E1:CF:FA:77:44', 'Audio/Source', 'AIRBUD', { 'device.api': 'bluez5' }),
  node(74, 'bluez_input_internal.11_E1_CF_FA_77_44.0', 'Audio/Source/Internal', 'internal'),
  node(79, 'Jarvis Desktop', 'Stream/Output/Audio', 'stream'),
  { id: 1, type: 'PipeWire:Interface:Device', info: { props: {} } },
];

test('parseDump keeps real devices, drops monitors/internals/streams, flags Bluetooth', () => {
  const d = parseDump(DUMP);
  assert.deepStrictEqual(d.sinks.map((x) => [x.label, x.bluetooth]), [['Built-in Audio Analog Stereo', false], ['AIRBUD', true]]);
  assert.deepStrictEqual(d.sources.map((x) => [x.label, x.bluetooth]), [['Built-in Audio Analog Stereo', false], ['AIRBUD', true]]);
  assert.deepStrictEqual(parseDump(null), { sinks: [], sources: [] });
});
test('cleanChoice defaults to auto and bounds length', () => {
  assert.strictEqual(cleanChoice(undefined), 'auto');
  assert.strictEqual(cleanChoice('  '), 'auto');
  assert.strictEqual(cleanChoice('laptop'), 'laptop');
  assert.strictEqual(cleanChoice('x'.repeat(500)).length, 200);
});

// ---- the in-page shim, run against a fake browser
function browser({ inputs, outputs, cfg }) {
  const calls = { gum: [], sink: [] }, listeners = {}, ctxInstances = [];
  const mkTrack = (label, id) => { const t = { label, kind: 'audio', readyState: 'live', enabled: true, _l: {}, getSettings: () => ({ deviceId: id }), stop() { this.readyState = 'ended'; }, addEventListener(e, f) { this._l[e] = f; } }; return t; };
  const mkStream = (t) => ({ getAudioTracks: () => [t], getTracks: () => [t] });
  const mediaDevices = {
    _inputs: inputs, _outputs: outputs,
    enumerateDevices: async () => [...mediaDevices._inputs.map((d) => ({ kind: 'audioinput', ...d })), ...mediaDevices._outputs.map((d) => ({ kind: 'audiooutput', ...d }))],
    getUserMedia: async (c) => {
      calls.gum.push(c);
      const want = c.audio.deviceId?.exact; const d = mediaDevices._inputs.find((x) => x.deviceId === (want || 'default'));
      if (!d) { const e = new Error('x'); e.name = 'OverconstrainedError'; throw e; }
      const t = mkTrack(d.label, d.deviceId); mediaDevices.last = t; return mkStream(t);
    },
    addEventListener: (e, f) => { listeners[e] = f; },
  };
  class AC {
    constructor() { this.sinkId = ''; this.state = 'running'; ctxInstances.push(this); }
    addEventListener() {}
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createMediaStreamDestination() { const t = mkTrack('dest', 'dest'); return { stream: mkStream(t) }; }
    createAnalyser() { return { fftSize: 1024 }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async setSinkId(id) { this.sinkId = id; calls.sink.push(id); }
  }
  const host = { getConfig: async () => cfg, log() {}, onConfig() {} };
  const win = { __jdHost: host, AudioContext: AC, navigator: { mediaDevices }, setTimeout, clearTimeout, Date, Float32Array, Promise, console };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'audio-shim.js'), 'utf8'), win);
  return { win, calls, mediaDevices, fire: (e) => listeners[e]?.(), ctxInstances };
}
const IN = [{ deviceId: 'default', label: 'Default' }, { deviceId: 'int', label: 'Built-in Audio Analog Stereo' }, { deviceId: 'bt', label: 'AIRBUD 550' }];
const OUT = [{ deviceId: 'default', label: 'Default' }, { deviceId: 'int', label: 'Built-in Audio Analog Stereo' }, { deviceId: 'bt', label: 'AIRBUD 550' }];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('shim: automatic input never picks the Bluetooth microphone', async () => {
  const b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'auto', output: 'auto', bt: ['AIRBUD 550'] } });
  await b.win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, channelCount: 1 } });
  assert.strictEqual(b.calls.gum[0].audio.deviceId.exact, 'int');
  assert.strictEqual(b.calls.gum[0].audio.echoCancellation, true);
});
test('shim: an explicit device name is honoured; a missing one falls back to the system default', async () => {
  let b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'AIRBUD 550', output: 'auto', bt: ['AIRBUD 550'] } });
  await b.win.navigator.mediaDevices.getUserMedia({ audio: true });
  assert.strictEqual(b.calls.gum[0].audio.deviceId.exact, 'bt');
  b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'Unplugged USB mic', output: 'auto', bt: [] } });
  await b.win.navigator.mediaDevices.getUserMedia({ audio: true });
  assert.strictEqual(b.calls.gum[0].audio.deviceId, undefined);
});
test('shim: video+audio requests are left alone', async () => {
  const b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'auto', output: 'auto', bt: ['AIRBUD 550'] } });
  await b.win.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(b.calls.gum[0])), { audio: true, video: true });
});
test('shim: the page keeps one live track while the microphone underneath is replaced after it ends', async () => {
  const b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'auto', output: 'auto', bt: ['AIRBUD 550'] } });
  const s = await b.win.navigator.mediaDevices.getUserMedia({ audio: true });
  const pageTrack = s.getAudioTracks()[0];
  const first = b.mediaDevices.last; first.readyState = 'ended'; first._l.ended();
  await wait(700);
  assert.strictEqual(b.calls.gum.length, 2);
  assert.notStrictEqual(b.mediaDevices.last, first);
  assert.strictEqual(b.mediaDevices.last.readyState, 'live');
  assert.strictEqual(pageTrack.readyState, 'live');
  assert.strictEqual(b.win.__jdAudio.reacquires, 1);
  pageTrack.stop();   // the page ending the call releases the real microphone
  assert.strictEqual(b.mediaDevices.last.readyState, 'ended');
});
test('shim: a device change moves a headset-bound microphone to the laptop and re-applies the speaker', async () => {
  const b = browser({ inputs: IN, outputs: OUT, cfg: { input: 'laptop', output: 'laptop', bt: ['AIRBUD 550'] } });
  await b.win.navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new b.win.AudioContext(); await wait(30);
  assert.strictEqual(ctx.sinkId, 'int');   // output 'laptop' goes to the built-in speakers, not the headset
  b.mediaDevices._inputs = IN.filter((d) => d.deviceId !== 'int');   // laptop mic vanishes (e.g. a dock)
  b.fire('devicechange'); await wait(900);
  assert.ok(b.win.__jdAudio.events.some((e) => /devices changed/.test(e)));
});
