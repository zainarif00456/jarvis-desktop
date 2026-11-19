// One animation clock for everything drawn per frame (the neural core, the panel beams...).
// One requestAnimationFrame for the whole page instead of one per feature: fewer wake-ups, one
// place that stops when the tab is hidden, and per-job frame-rate caps the quality governor sets.
//
//   const job = frames.add((now, dt) => { ... }, { fps: 60 });
//   job.setFps(30); job.pause(); job.resume(); job.remove();
// `dt` is in seconds, capped at 50 ms so a stall never makes things jump.

const jobs = new Set();
let raf = 0; let last = 0;

function tick(now) {
  raf = 0;
  if (document.hidden) return;
  const dt = Math.min((now - (last || now)) / 1000, 0.05); last = now;
  let any = false;
  for (const job of jobs) {
    if (job.paused) continue;
    any = true;
    if (job.gap && now - job.at < job.gap) continue;
    const step = Math.min((now - (job.at || now)) / 1000, 0.05);
    job.at = now;
    try { job.fn(now, job.gap ? step : dt); } catch (err) { console.error('frame job failed:', err); job.paused = true; }
  }
  if (any) raf = requestAnimationFrame(tick);
}

function wake() { if (!raf && !document.hidden) { last = 0; for (const j of jobs) j.at = 0; raf = requestAnimationFrame(tick); } }

document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

class Job {
  constructor(fn, fps) { this.fn = fn; this.paused = false; this.at = 0; this.setFps(fps); }
  /** At most this many frames a second (60 or more = every frame). */
  setFps(fps) { this.gap = !fps || fps >= 60 ? 0 : 1000 / fps - 2; }
  pause() { this.paused = true; }
  resume() { if (this.paused) { this.paused = false; this.at = 0; wake(); } }
  remove() { jobs.delete(this); }
}

export const frames = {
  add(fn, { fps = 60, paused = false } = {}) { const job = new Job(fn, fps); job.paused = paused; jobs.add(job); wake(); return job; },
};
