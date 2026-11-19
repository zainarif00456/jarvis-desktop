// Runs on the audio thread: downsample the microphone to 16 kHz mono and hand over 40 ms frames.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;      // input samples per output sample (may be fractional)
    this.phase = 0; this.sum = 0; this.count = 0;
    this.frame = new Int16Array(640);     // 40 ms at 16 kHz
    this.n = 0; this.energy = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i]; this.count += 1; this.phase += 1;
      if (this.phase >= this.ratio) {     // box filter: the mean of the samples in this window
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.n++] = v < 0 ? v * 32768 : v * 32767;
        this.energy += v * v;
        this.phase -= this.ratio; this.sum = 0; this.count = 0;
        if (this.n === this.frame.length) {
          const rms = Math.sqrt(this.energy / this.n);
          this.port.postMessage({ pcm: this.frame.buffer.slice(0), rms }, []);
          this.n = 0; this.energy = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
