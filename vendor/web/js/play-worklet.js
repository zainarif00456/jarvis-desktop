// Runs on the audio thread: a ring buffer that turns the server's 24 kHz PCM chunks into one steady stream.
// Network chunks arrive unevenly; the main thread may be busy. Neither can make the sound stutter here.
const SOURCE_RATE = 24000;
const CAPACITY = SOURCE_RATE * 90;     // seconds of audio the ring can hold
const PREBUFFER_S = 0.2;               // after silence/starvation, wait for this much audio (measured: covers Deepgram's early burst gaps)...
const MAX_WAIT_S = 0.2;                // ...but never longer than this (latency stays flat)
const JITTER_STEP_S = 0.08;            // each real glitch adds this much cushion (bad network, e.g. a tunnel)...
const JITTER_MAX_S = 0.6;              // ...up to this; a good connection never pays for it
const IDLE_AFTER_S = 0.3;              // empty this long after playing: the reply is over
const FADE_SAMPLES = 96;               // 2 ms fade in/out so a stop or a start never clicks
const STARVE_REPORT_S = 1.5;           // data returning within this long after running dry = a glitch

class PlayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(CAPACITY);
    this.write = 0; this.read = 0;     // monotonically increasing sample counters; read is fractional
    this.step = SOURCE_RATE / sampleRate;
    this.playing = false; this.env = 0; this.last = 0;
    this.waitSince = -1; this.emptySince = -1; this.starvedAt = -1;
    this.energy = 0; this.count = 0; this.reportedIdle = true;
    this.prebuffer = PREBUFFER_S; this.maxWait = MAX_WAIT_S;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.cut) { this.read = this.write; this.playing = false; this.waitSince = -1; this.emptySince = -1; this.starvedAt = -1; this.reportedIdle = true; return; }
    const pcm = new Int16Array(m.pcm, 0, m.pcm.byteLength >> 1);
    const room = CAPACITY - (this.write - Math.floor(this.read));
    const n = Math.min(pcm.length, Math.max(room, 0));
    for (let i = 0; i < n; i++) this.ring[(this.write + i) % CAPACITY] = pcm[i] / 32768;
    this.write += n;
    // Full ring = audio thrown away (heard as garbled, then cut-short speech). The server paces
    // itself to stay a few seconds ahead, so this should never happen: say so loudly if it does.
    if (n < pcm.length) this.port.postMessage({ t: 'overflow', droppedMs: Math.round((pcm.length - n) / SOURCE_RATE * 1000) });
    this.emptySince = -1;
    if (this.reportedIdle) { this.reportedIdle = false; this.port.postMessage({ t: 'playing' }); }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const buffered = this.write - this.read;
    if (!this.playing && buffered >= 2) {   // >= 2: one interpolation needs two samples, else it starts, starves, and 'underruns' in a loop
      if (this.waitSince < 0) this.waitSince = currentTime;
      if (buffered >= this.prebuffer * SOURCE_RATE || currentTime - this.waitSince >= this.maxWait) {
        this.playing = true; this.waitSince = -1;
        if (this.starvedAt >= 0 && currentTime - this.starvedAt < STARVE_REPORT_S) {
          this.port.postMessage({ t: 'underrun', gapMs: Math.round((currentTime - this.starvedAt) * 1000) });
          this.prebuffer = Math.min(JITTER_MAX_S, this.prebuffer + JITTER_STEP_S); this.maxWait = this.prebuffer;
        }
        this.starvedAt = -1;
      }
    }
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      if (this.playing && this.write - this.read >= 2) {
        const base = Math.floor(this.read); const frac = this.read - base;
        const a = this.ring[base % CAPACITY]; const b = this.ring[(base + 1) % CAPACITY];
        s = a + (b - a) * frac; this.last = s; this.read += this.step;
        this.env = Math.min(1, this.env + 1 / FADE_SAMPLES);
      } else {
        if (this.playing) {             // ran dry mid-speech: stop cleanly, wait for more audio
          this.playing = false; this.starvedAt = currentTime; this.emptySince = currentTime;
        }
        this.env = Math.max(0, this.env - 1 / FADE_SAMPLES); s = this.last;
      }
      out[i] = s * this.env;
      this.energy += out[i] * out[i];
    }
    this.count += out.length;
    if (this.count >= 2400) {           // ~50 ms: tell the orb how loud it is
      this.port.postMessage({ t: 'level', v: Math.sqrt(this.energy / this.count) });
      this.energy = 0; this.count = 0;
    }
    if (!this.playing && this.write - this.read < 2 && !this.reportedIdle) {
      if (this.emptySince < 0) this.emptySince = currentTime;
      if (currentTime - this.emptySince >= IDLE_AFTER_S) { this.reportedIdle = true; this.port.postMessage({ t: 'idle' }); }
    }
    return true;
  }
}
registerProcessor('play-processor', PlayProcessor);
