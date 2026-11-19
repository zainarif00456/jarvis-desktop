// Quality governor: keeps the screen effects inside what this machine can draw without hurting the
// voice. It watches frame times, long tasks on the main thread and the speaker's underruns, and
// sets <html data-fx="cinematic|standard|lite"> (css/holo.css reads it). It steps down fast when
// something struggles and climbs back slowly once things have been smooth for a while.
//
// Override for a test or a slow machine: ?fx=lite (or standard / cinematic) in the address, or
// localStorage 'jarvis.fx'.

const TIERS = ['cinematic', 'standard', 'lite'];
const WINDOW_MS = 2500;        // judge frame times over this window
const SLOW_FRAME_MS = 34;      // slower than ~30 fps
const SLOW_SHARE = 0.2;        // this share of slow frames in the window -> step down
const LONG_TASKS = 3;          // this many long tasks (>50 ms) within LONG_WINDOW_MS -> step down
const LONG_WINDOW_MS = 5000;
const STEP_GAP_MS = 4000;      // at most one step down per this long
const RECOVER_MS = 30000;      // smooth for this long -> one step back up
const KEY = 'jarvis.fx.settled';   // the tier this device last settled on

export class PerfGovernor {
  constructor({ voiceStats = () => window.__voice, onTier = () => {} } = {}) {
    this.voiceStats = voiceStats; this.onTier = onTier;
    const forced = new URLSearchParams(location.search).get('fx') || safeGet('jarvis.fx');
    this.forced = TIERS.includes(forced) ? forced : null;
    // start where this machine last settled (never above what it managed): no cinematic burst that
    // has to be stepped down on every page load
    const remembered = TIERS.indexOf(safeGet(KEY));
    this.level = this.forced ? TIERS.indexOf(this.forced) : Math.max(0, remembered);
    this.frames = []; this.long = []; this.lastStep = 0; this.calmSince = performance.now();
    this.underruns = this.voiceStats()?.underruns || 0;
    this.frame = this.frame.bind(this); this.raf = 0; this.prev = 0;
    this.apply();
    if (this.forced) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) if (entry.duration > 50) this.long.push(now);
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch { /* long tasks are not reported here: frame times still are */ }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else this.start(); });
    this.start();
  }

  get tier() { return TIERS[this.level]; }

  start() { if (!this.raf && !document.hidden && !this.forced) { this.prev = 0; this.raf = requestAnimationFrame(this.frame); } }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.frames.length = 0; }

  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    if (this.prev) {
      const dt = now - this.prev;
      if (dt < 1000) this.frames.push([now, dt]);  // a long gap is the tab coming back, not a slow frame
    }
    this.prev = now;
    while (this.frames.length && now - this.frames[0][0] > WINDOW_MS) this.frames.shift();
    while (this.long.length && now - this.long[0] > LONG_WINDOW_MS) this.long.shift();
    if (this.frames.length % 15) return;  // judge four times a second, not every frame
    const slow = this.frames.filter(([, dt]) => dt > SLOW_FRAME_MS).length;
    const underruns = this.voiceStats()?.underruns || 0;
    const voiceHurt = underruns > this.underruns; this.underruns = underruns;
    const struggling = voiceHurt || (this.frames.length >= 30 && slow / this.frames.length > SLOW_SHARE) || this.long.length >= LONG_TASKS;
    if (struggling) {
      this.calmSince = now;
      if (this.level < TIERS.length - 1 && now - this.lastStep > STEP_GAP_MS) this.step(1, now, voiceHurt ? 'voice underrun' : slow ? 'slow frames' : 'long tasks');
    } else if (this.level > 0 && now - this.calmSince > RECOVER_MS) {
      this.calmSince = now; this.step(-1, now, 'smooth again');
    }
  }

  step(delta, now, why) {
    this.level = Math.max(0, Math.min(TIERS.length - 1, this.level + delta)); this.lastStep = now;
    this.frames.length = 0; this.long.length = 0;
    this.apply(why);
  }

  apply(why = '') {
    document.documentElement.dataset.fx = this.tier;
    if (!this.forced) safeSet(KEY, this.tier);
    try { this.onTier(this.tier, why); } catch (err) { console.error(err); }
  }
}

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: it just starts high next time */ } }
