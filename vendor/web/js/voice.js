// Voice call: microphone -> server (16 kHz PCM), server speech -> speakers (24 kHz PCM),
// with a local volume-duck so Jarvis goes quiet the instant you start talking.

const TTS_RATE = 24000;
const DUCK_RMS = 0.03;          // mic level that counts as "the owner is talking"
const DUCK_BLEED = 1.2;         // ...and it must beat this multiple of what Jarvis himself is outputting (speaker bleed)
const DUCK_FRAMES = 5;          // ...sustained for 200 ms
const DUCK_GAIN = 0.2;
const DUCK_RESTORE_MS = 1100;   // if the server does not confirm real speech, come back up
const STATS_EVERY_MS = 15000;   // playback health report to the server (logged there)
const PLAY_LATENCY_S = 0.06;    // output buffer: headroom so a busy page cannot make the speakers crackle

export class Voice {
  constructor({ sendBinary, send, onState, onCaption, onError }) {
    Object.assign(this, { sendBinary, send, onState, onCaption, onError });
    this.active = false; this.muted = false; this.state = 'idle'; this.volume = 1; this.micLevel = 0;
    this.stats = { framesSent: 0, bytesReceived: 0, chunksPlayed: 0, secondsQueued: 0, stops: 0, ducks: 0, underruns: 0, worstGapMs: 0, state: 'idle' };
    window.__voice = this.stats;      // read by the browser tests
  }

  // Must run inside the click that starts the call (autoplay + mic permission rules).
  async prepare() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.micCtx = new AudioContext();
    await this.micCtx.audioWorklet.addModule('/js/mic-worklet.js');
    this.mic = new AudioWorkletNode(this.micCtx, 'mic-processor');
    this.micCtx.createMediaStreamSource(this.stream).connect(this.mic);
    this.mic.port.onmessage = (e) => this.onMicFrame(e.data);
    try { this.playCtx = new AudioContext({ sampleRate: TTS_RATE, latencyHint: PLAY_LATENCY_S }); } catch { this.playCtx = new AudioContext({ latencyHint: PLAY_LATENCY_S }); }
    await this.playCtx.audioWorklet.addModule('/js/play-worklet.js');
    this.player = new AudioWorkletNode(this.playCtx, 'play-processor');   // ring buffer: steady output whatever the network does
    this.player.port.onmessage = (e) => this.onPlayer(e.data);
    this.outRms = 0; this.playing = false;
    this.gain = this.playCtx.createGain();                 // ducking
    this.master = this.playCtx.createGain(); this.master.gain.value = this.volume;  // owner's volume
    this.analyser = this.playCtx.createAnalyser(); this.analyser.fftSize = 512;
    this.player.connect(this.gain); this.gain.connect(this.master); this.master.connect(this.playCtx.destination); this.master.connect(this.analyser);
    this.wave = new Float32Array(this.analyser.fftSize);
    // Without a recent click the browser may keep audio suspended: do not hang on it.
    await Promise.race([Promise.all([this.micCtx.resume(), this.playCtx.resume()]), new Promise((r) => setTimeout(r, 400))]);
    this.micLevel = 0; this.loud = 0; this.duckTimer = 0;
  }

  start() {
    this.active = true; this.setState('idle');
    clearInterval(this.statsTimer); this.statsTimer = setInterval(() => this.reportStats(), STATS_EVERY_MS);
  }

  stop() {
    this.active = false; this.cutAudio();
    clearTimeout(this.duckTimer); clearInterval(this.statsTimer);
    this.reportStats();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.mic?.disconnect(); this.player?.disconnect();
    this.micCtx?.close(); this.playCtx?.close();
    this.stream = this.mic = this.micCtx = this.playCtx = this.player = null;
    this.setState('idle'); this.onCaption('');
  }

  // True when the browser is still holding audio back (needs one tap on the page).
  suspended() { return !!this.playCtx && (this.playCtx.state !== 'running' || this.micCtx?.state !== 'running'); }
  async unlock() { await Promise.all([this.micCtx?.resume(), this.playCtx?.resume()]); return !this.suspended(); }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.playCtx.currentTime, 0.03); }

  // Loudness of what he is saying right now (0..~0.3), for the orb.
  outLevel() {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0; for (let i = 0; i < this.wave.length; i++) sum += this.wave[i] * this.wave[i];
    return Math.sqrt(sum / this.wave.length);
  }

  setMuted(muted) { this.muted = muted; this.stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; }); }

  setState(state) { this.state = state; this.stats.state = state; this.onState(state); }

  onMicFrame({ pcm, rms }) {
    if (!this.active) return;
    this.micLevel = this.muted ? 0 : Math.max(rms, this.micLevel * 0.85);
    if (!this.muted) { this.sendBinary(pcm); this.stats.framesSent += 1; }
    const speaking = this.playing && !this.ducked;
    // Only count the mic as the owner's voice when it is clearly louder than Jarvis's own output leaking back in.
    const threshold = Math.max(DUCK_RMS, this.outRms * DUCK_BLEED);
    this.loud = !this.muted && rms > threshold ? this.loud + 1 : 0;
    if (speaking && this.loud >= DUCK_FRAMES && !this.ducked) this.duck();
  }

  duck() {
    this.ducked = true; this.stats.ducks += 1;
    this.gain.gain.setTargetAtTime(DUCK_GAIN, this.playCtx.currentTime, 0.02);
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => this.unduck(), DUCK_RESTORE_MS);
  }
  unduck() { this.ducked = false; if (this.gain) this.gain.gain.setTargetAtTime(1, this.playCtx.currentTime, 0.05); }

  // Server audio: raw 16-bit little-endian mono PCM at 24 kHz, arriving faster than real time.
  // It goes straight into the worklet's ring buffer; the audio thread does the pacing.
  push(buffer) {
    if (!this.active || !this.player) return;
    this.stats.bytesReceived += buffer.byteLength;
    this.stats.chunksPlayed += 1; this.stats.secondsQueued += buffer.byteLength / (TTS_RATE * 2);
    this.player.port.postMessage({ pcm: buffer }, [buffer]);
  }

  onPlayer(m) {
    if (m.t === 'level') this.outRms = Math.max(m.v, this.outRms * 0.8);
    else if (m.t === 'playing') this.playing = true;
    else if (m.t === 'idle') { this.playing = false; this.outRms = 0; this.send({ type: 'voice_playback', event: 'idle' }); }
    else if (m.t === 'underrun') {
      this.stats.underruns += 1; this.stats.worstGapMs = Math.max(this.stats.worstGapMs, m.gapMs);
      this.send({ type: 'voice_playback', event: 'underrun', underruns: 1, gap_ms: m.gapMs });
    } else if (m.t === 'overflow') {
      this.send({ type: 'voice_playback', event: 'overflow', gap_ms: m.droppedMs });
    }
  }

  reportStats() {
    if (this.stats.chunksPlayed) this.send({ type: 'voice_playback', event: 'stats', underruns: this.stats.underruns, gap_ms: this.stats.worstGapMs });
  }

  // The server confirmed real speech (or ended the call): drop everything queued, right now.
  cutAudio() {
    this.stats.stops += 1;
    this.player?.port.postMessage({ cut: true }); this.outRms = 0; this.playing = false;
    clearTimeout(this.duckTimer); this.unduck();
  }

  handle(m) {
    switch (m.type) {
      case 'voice_state': this.setState(m.state); break;
      case 'voice_partial': this.onCaption(m.text); break;
      case 'voice_final': this.onCaption(''); break;
      case 'voice_stop': this.cutAudio(); break;
      case 'voice_error': this.onError(m.text, m.recoverable); break;
      default: break;
    }
  }
}
