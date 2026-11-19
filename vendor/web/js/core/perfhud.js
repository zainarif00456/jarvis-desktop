// A small live readout for tuning on the real machine: add `?perf=1` to the address.
// Shows frames per second, the quality tier (js/perf.js), which core is drawing, the GPU, open
// panels, long tasks and the speaker's underruns/overflows (voice health). Loaded only when asked
// (main.js imports it on demand), so it costs nothing otherwise. Never shown to anyone by default.

import { frames } from './frames.js';
import { windows } from '../holowin.js';

export function startPerfHud({ orb, perf }) {
  const box = document.createElement('pre');
  box.className = 'perf-hud'; box.setAttribute('aria-hidden', 'true');
  document.body.append(box);
  let gpu = 'unknown';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'no WebGL');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* not available */ }
  let count = 0; let longTasks = 0; let worst = 0; let last = performance.now(); let prev = 0;
  frames.add((now) => { count += 1; if (prev) worst = Math.max(worst, now - prev); prev = now; }, { fps: 60 });
  try { new PerformanceObserver((l) => { longTasks += l.getEntries().length; }).observe({ type: 'longtask' }); } catch { /* unsupported */ }
  setInterval(() => {
    const now = performance.now(); const fps = (count * 1000) / (now - last);
    const v = window.__voice || {};
    box.textContent = [
      `fps      ${fps.toFixed(0).padStart(3)}  worst ${worst.toFixed(0)} ms`,
      `tier     ${perf?.tier || '?'}${perf?.forced ? ' (forced)' : ''}`,
      `core     ${orb?.kind || '?'}  ${orb?.impl?.renderer?.count ?? '-'} pts`,
      `gpu      ${String(gpu).slice(0, 46)}`,
      `panels   ${windows.all().filter((w) => !w.minimised).length}`,
      `long     ${longTasks} tasks`,
      `voice    underruns ${v.underruns ?? '-'}  overflows ${v.overflows ?? '-'}`,
    ].join('\n');
    count = 0; worst = 0; last = now;
  }, 1000);
}
