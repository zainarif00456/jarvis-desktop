// Runs in the PAGE's own JavaScript world (injected by preload/app.js before any page script). Not a module; no imports.
// It changes nothing in the vendored web client. It wraps two browser APIs the client already uses:
//   navigator.mediaDevices.getUserMedia({audio only})  -> returns a stream fed by a device chosen by the shell's policy, and that
//                                                          is re-attached to a fresh device when the old one dies or changes
//   window.AudioContext                                 -> every context gets the chosen output device (setSinkId)
// Policy ('auto' | 'laptop' | 'system' | <device label>) comes from the shell. 'auto' input = a non-Bluetooth microphone, so
// WirePlumber never flips the headset into its (often silent) call profile; 'auto' output = system default.
(() => {
  const host = window.__jdHost;
  if (!host || window.__jdAudio || !navigator.mediaDevices) return;
  const md = navigator.mediaDevices, origGUM = md.getUserMedia.bind(md), Orig = window.AudioContext;
  let cfg = { input: 'auto', output: 'auto', bt: [] };
  const proxies = new Set(), ctxs = new Set();
  const state = window.__jdAudio = { events: [], reacquires: 0, input: null, output: null, cfg: () => cfg,
    proxies: () => [...proxies], level() { const r = [...proxies][0]; if (!r) return null; const a = new Float32Array(r.an.fftSize); r.an.getFloatTimeDomainData(a); let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / a.length); } };
  const log = (m) => { state.events.push(Date.now() + ' ' + m); if (state.events.length > 60) state.events.shift(); try { host.log(m); } catch { /* host gone */ } };
  const norm = (s) => String(s || '').replace(/^(default|communications)\s*-\s*/i, '').trim().toLowerCase();
  const isBt = (l) => { const n = norm(l); return !!n && cfg.bt.some((b) => norm(b) === n); };
  const devices = async (kind) => { try { return (await md.enumerateDevices()).filter((d) => d.kind === kind); } catch { return []; } };
  const real = (l) => l.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');

  // The device the policy wants, or null = "let the system default decide".
  function pick(list, choice) {
    const r = real(list);
    if (choice === 'system') return null;
    if (choice === 'auto' || choice === 'laptop') {
      const own = r.filter((d) => d.label && !isBt(d.label));
      const def = list.find((d) => d.deviceId === 'default');
      const dl = def && norm(def.label);
      return own.find((d) => norm(d.label) === dl) || own[0] || null;
    }
    return r.find((d) => norm(d.label) === norm(choice)) || null;
  }
  // 'auto' output keeps the system default (the headset in its good A2DP profile is fine for listening); 'laptop' forces non-Bluetooth.
  const outChoice = () => (cfg.output === 'auto' ? 'system' : cfg.output);

  async function loadCfg() { try { const c = await host.getConfig(); if (c) cfg = { input: c.input || 'auto', output: c.output || 'auto', bt: c.bt || [] }; } catch { /* keep last */ } }

  async function acquire(spec) {
    const dev = pick(await devices('audioinput'), cfg.input);
    const a = { ...(spec && typeof spec === 'object' ? spec : {}) }; delete a.deviceId;
    if (dev) {
      try { const s = await origGUM({ audio: { ...a, deviceId: { exact: dev.deviceId } } }); log('mic: ' + dev.label); return s; }
      catch (e) { log('mic: ' + dev.label + ' failed (' + e.name + '), using system default'); }
    }
    const s = await origGUM({ audio: a });
    log('mic: system default (' + (s.getAudioTracks()[0]?.label || '?') + ')');
    return s;
  }

  function attach(rec, stream) {
    rec.stream = stream; rec.src = rec.ctx.createMediaStreamSource(stream);
    rec.src.connect(rec.dest); rec.src.connect(rec.an);
    const t = stream.getAudioTracks()[0]; state.input = t?.label || null;
    t?.addEventListener('ended', () => { if (rec.stream === stream && !rec.stopped) schedule(rec, 'microphone ended'); });
  }
  function detach(rec) { try { rec.src.disconnect(); } catch { /* gone */ } rec.stream.getTracks().forEach((t) => t.stop()); }
  function schedule(rec, why) { clearTimeout(rec.timer); rec.timer = setTimeout(() => reacquire(rec, why), 300); }
  async function reacquire(rec, why) {
    for (let i = 0; i < 4 && !rec.stopped; i++) {
      try {
        const s = await acquire(rec.spec);
        if (rec.stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        const old = rec.stream; rec.stream = null; try { rec.src.disconnect(); } catch { /* gone */ } old.getTracks().forEach((t) => t.stop());
        attach(rec, s); state.reacquires++; log('mic re-attached (' + why + ')'); return;
      } catch (e) { log('mic re-attach failed (' + e.name + '), retrying'); await new Promise((r) => setTimeout(r, 1000)); }
    }
  }

  md.getUserMedia = async function (c) {
    if (!c || !c.audio || c.video) return origGUM(c);   // camera clips etc. stay untouched
    await loadCfg();
    const stream = await acquire(c.audio);
    // The page gets a stable stream from a node we own, so swapping the physical device later never breaks its graph.
    const ctx = (() => { try { return new Orig({ sinkId: { type: 'none' } }); } catch { return new Orig(); } })();
    const dest = ctx.createMediaStreamDestination(), an = ctx.createAnalyser(); an.fftSize = 1024;
    const rec = { spec: c.audio, ctx, dest, an, stopped: false, timer: 0 };
    attach(rec, stream); ctx.resume().catch(() => {});
    const out = dest.stream, track = out.getAudioTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { rec.stopped = true; clearTimeout(rec.timer); try { detach(rec); } catch { /* gone */ } stop(); ctx.close().catch(() => {}); proxies.delete(rec); };
    proxies.add(rec);
    return out;
  };

  async function applySink(ctx) {
    if (typeof ctx.setSinkId !== 'function') return;
    try {
      const dev = pick(await devices('audiooutput'), outChoice());
      const want = dev ? dev.deviceId : '';
      if ((ctx.sinkId || '') === want) return;
      await ctx.setSinkId(want); state.output = dev ? dev.label : 'system default'; log('speaker: ' + state.output);
    } catch (e) { log('speaker switch failed: ' + e.name); }
  }
  class JDAudioContext extends Orig { constructor(o) { super(o); ctxs.add(this); this.addEventListener('statechange', () => { if (this.state === 'closed') ctxs.delete(this); }); loadCfg().then(() => applySink(this)); } }
  window.AudioContext = JDAudioContext; if (window.webkitAudioContext) window.webkitAudioContext = JDAudioContext;

  let busy = false;
  async function resync(why) {
    if (busy) return; busy = true;
    try {
      await loadCfg();
      const list = await devices('audioinput'), want = pick(list, cfg.input);
      for (const rec of proxies) {
        const t = rec.stream?.getAudioTracks()[0], cur = t?.getSettings().deviceId;
        const dead = !t || t.readyState !== 'live';
        const moved = !!want && want.deviceId !== cur;
        if (dead || moved) await reacquire(rec, dead ? why + ': microphone gone' : why + ': microphone changed');
      }
      for (const c of ctxs) await applySink(c);
    } finally { busy = false; }
  }
  md.addEventListener('devicechange', () => { log('devices changed'); setTimeout(() => resync('devicechange'), 400); });
  try { host.onConfig(() => resync('settings')); } catch { /* optional */ }
})();
