// Live video from the server: fragmented MP4 over a WebSocket, played through Media Source
// Extensions (with sound), and a snapshot-polling fallback for browsers without MSE.

const MAX_BUFFER_S = 12;       // keep at most this much video behind the live edge
const KEEP_S = 5;
const LIVE_LAG_S = 2.2;        // further behind than this: jump to the live edge
const RETRY_MS = [1000, 2000, 4000, 8000, 10000];

export const mseSupported = () => !!(window.ManagedMediaSource || window.MediaSource);

export class LivePlayer {
  /**
   * @param {{box: HTMLElement, cameraId: string, onStatus?: Function, muted?: boolean}} o
   * `box` receives the <video> (or <img> fallback). Status: {state, detail, audio, video, mode}
   */
  constructor(o) {
    this.box = o.box; this.cameraId = o.cameraId; this.onStatus = o.onStatus || (() => {});
    this.muted = o.muted !== false; this.volume = 1;
    this.ws = null; this.ms = null; this.sb = null; this.queue = []; this.mime = '';
    this.stopped = true; this.attempt = 0; this.retryTimer = 0; this.snapTimer = 0;
    this.mode = 'idle'; this.audio = false; this.server = {};
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true; this.video.autoplay = true;
    this.video.disablePictureInPicture = false; this.video.setAttribute('disableremoteplayback', '');
    this.video.className = 'lp-video';
    this.box.append(this.video);
    this.meter = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false; this.attempt = 0;
    if (!mseSupported()) { this.startSnapshots(); return; }
    this.connect();
  }

  stop() {
    this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.snapTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.teardownMedia(); this.stopMeter();
    this.emit('idle', '');
  }

  destroy() { this.stop(); this.video.remove(); this.img?.remove(); }

  emit(state, detail = '') {
    this.state = state; this.detail = detail;
    this.onStatus({ state, detail, audio: this.audio, video: this.server.video !== false, mode: this.mode });
  }

  // ---- connection
  connect() {
    if (this.stopped) return;
    this.emit(this.attempt ? 'reconnecting' : 'starting', this.detail || '');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/camera/${encodeURIComponent(this.cameraId)}`);
    ws.binaryType = 'arraybuffer'; this.ws = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') { try { this.onJson(JSON.parse(event.data)); } catch { /* ignore */ } } else this.onBinary(event.data);
    };
    ws.onclose = (event) => {
      this.ws = null;
      if (this.stopped) return;
      if (event.code === 4401 || event.code === 4403) { this.emit('error', 'Not signed in — pair this browser again.'); return; }
      if (event.code === 4404) { this.emit('error', 'This camera was removed.'); return; }
      this.scheduleRetry();
    };
    ws.onerror = () => { /* close follows */ };
  }
  scheduleRetry() {
    if (this.stopped) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]; this.attempt += 1;
    clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.connect(), delay);
  }
  retry() { if (this.stopped) return; clearTimeout(this.retryTimer); this.attempt = 0; if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } this.connect(); }

  onJson(m) {
    if (m.type === 'status') {
      this.server = m;
      if (m.state === 'error') this.emit('error', m.detail);
      else if (m.state === 'reconnecting' || m.state === 'starting') this.emit(m.state, m.detail);
      else if (m.state === 'live' && this.state !== 'live') this.emit('live', '');
    } else if (m.type === 'init') {
      this.audio = !!m.audio; this.server = { ...this.server, video: m.video !== false };
      this.resetMedia(m.mime);
      if (this.state) this.emit(this.state, this.detail); // tell the controls whether there is sound
    }
  }

  // ---- media source
  teardownMedia() {
    this.queue = []; this.sb = null;
    if (this.ms) { try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch { /* closed already */ } this.ms = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.video.removeAttribute('src'); try { this.video.load(); } catch { /* ignore */ }
  }
  resetMedia(mime) {
    this.teardownMedia(); this.mime = mime;
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (!MS.isTypeSupported(mime)) { this.fallbackSnapshots(`This browser cannot play ${mime}.`); return; }
    this.ms = new MS();
    this.url = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      if (!this.ms || this.sb) return;
      try {
        this.sb = this.ms.addSourceBuffer(mime); this.sb.mode = 'sequence';
        this.sb.addEventListener('updateend', () => this.pump());
        this.sb.addEventListener('error', () => this.retry());
        this.pump();
      } catch (err) { this.fallbackSnapshots(String(err.message || err)); }
    }, { once: true });
    this.video.src = this.url;
    this.applyAudio();
    this.video.play().catch(() => {});
    this.mode = 'live';
  }
  onBinary(data) {
    this.queue.push(data);
    if (this.queue.length > 90) this.queue.splice(0, this.queue.length - 30); // never let a stuck buffer grow
    this.pump();
    if (this.state !== 'live') this.emit('live', '');
  }
  pump() {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length || !this.ms || this.ms.readyState !== 'open') return;
    // trim old video first so the buffer never grows without bound
    const b = sb.buffered;
    if (b.length && b.end(b.length - 1) - b.start(0) > MAX_BUFFER_S) {
      try { sb.remove(b.start(0), Math.max(b.start(0), b.end(b.length - 1) - KEEP_S)); return; } catch { /* try again later */ }
    }
    try { sb.appendBuffer(this.queue.shift()); } catch (err) {
      if (err.name === 'QuotaExceededError') { this.queue.length = 0; try { sb.remove(0, Infinity); } catch { /* ignore */ } } else this.retry();
      return;
    }
    this.chaseLiveEdge();
  }
  chaseLiveEdge() {
    const v = this.video; const b = v.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (v.paused) v.play().catch(() => {});
    if (end - v.currentTime > LIVE_LAG_S) v.currentTime = end - 0.35;
  }
  get lagSeconds() { const b = this.video.buffered; return b.length ? Math.max(0, b.end(b.length - 1) - this.video.currentTime) : 0; }
  get size() { return this.video.videoWidth ? `${this.video.videoWidth}×${this.video.videoHeight}` : ''; }

  // ---- sound
  applyAudio() { this.video.muted = this.muted; this.video.volume = this.volume; }
  setMuted(muted) { this.muted = muted; this.applyAudio(); if (!muted) { this.startMeter(); this.video.play().catch(() => {}); } }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.applyAudio(); }
  /** Level 0..1 of what is being heard (for the meter); 0 while muted. */
  level() {
    if (!this.analyser || this.muted) return 0;
    const data = this.levelData || (this.levelData = new Uint8Array(this.analyser.fftSize));
    this.analyser.getByteTimeDomainData(data);
    let peak = 0; for (const x of data) peak = Math.max(peak, Math.abs(x - 128));
    return Math.min(1, peak / 90);
  }
  startMeter() {
    if (this.analyser || !this.audio) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.actx = new Ctx(); const src = this.actx.createMediaElementSource(this.video);
      this.analyser = this.actx.createAnalyser(); this.analyser.fftSize = 512;
      src.connect(this.analyser); this.analyser.connect(this.actx.destination);
      if (this.actx.state === 'suspended') this.actx.resume().catch(() => {});
    } catch { this.analyser = null; }
  }
  stopMeter() { if (this.actx) { this.actx.close().catch(() => {}); this.actx = null; this.analyser = null; } }

  // ---- fallback: a fresh still every half second (no sound)
  fallbackSnapshots(why) { this.teardownMedia(); this.mode = 'stills'; this.startSnapshots(why); }
  startSnapshots(why = '') {
    this.mode = 'stills'; this.video.hidden = true;
    if (!this.img) { this.img = document.createElement('img'); this.img.className = 'lp-video'; this.img.alt = ''; this.box.append(this.img); }
    this.emit('starting', why);
    const tick = async () => {
      if (this.stopped) return;
      try {
        const r = await fetch(`/api/cameras/${encodeURIComponent(this.cameraId)}/snapshot?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        const blob = await r.blob(); const old = this.img.src; this.img.src = URL.createObjectURL(blob);
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
        if (this.state !== 'live') this.emit('live', why);
        this.snapTimer = setTimeout(tick, 500);
      } catch (err) { this.emit('reconnecting', String(err.message || err)); this.snapTimer = setTimeout(tick, 3000); }
    };
    tick();
  }
}
