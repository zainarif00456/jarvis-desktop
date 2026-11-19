// How a panel comes into being and leaves: the hologram effects.
//
// Forming (~0.9 s): the core sends a beam of particles to where the panel will be (GPU, neural
// core) -> the outline draws itself and the corner nodes light -> a scan line fills the plate from
// the top -> the title, controls and content materialise.
// Closing (~0.45 s): the content fades, the plate folds into a line, a beam carries it back into
// the core.
// Only transform and opacity are animated (compositor work, never layout). In the lite quality
// tier, with reduced motion, on phones (sheets) or when the stage is not showing, the simple CSS
// open/close of holo.css is used instead.

const EASE = 'cubic-bezier(.2, .8, .2, 1)';

const simple = () => document.documentElement.dataset.fx === 'lite'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || document.body.dataset.mode !== 'stage';

function run(node, frames, opts) {
  if (!node?.animate) return null;
  return node.animate(frames, { easing: EASE, fill: 'both', ...opts });
}

export function createForming(core) {
  return {
    open(win) {
      const el = win.el;
      if (win.kind === 'debrief') return;   // a frameless layer: its cards form themselves (js/debrief/stage.js)
      if (simple() || el.classList.contains('sheet')) { el.classList.add('opening'); return; }
      el.classList.add('forming');
      const g = win.geo();
      core.beam?.(g, 1);
      const q = (sel) => [...el.querySelectorAll(`:scope > ${sel}`)];
      const scan = document.createElement('i'); scan.className = 'hw-form-scan'; scan.setAttribute('aria-hidden', 'true');
      el.append(scan);
      const anims = [
        ...q('.hw-edge').map((n) => run(n, [{ transform: 'scale(0, .02)', opacity: 0 }, { transform: 'scale(1, .02)', opacity: 1, offset: 0.45 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: 260 })),
        ...q('.hw-node').map((n, i) => run(n, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.8)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 300, delay: 300 + i * 40 })),
        ...q('.hw-plate').map((n) => run(n, [{ transform: 'scaleY(0)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 380, delay: 470 })),
        run(scan, [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${Math.round(g.h)}px)`, opacity: 0.9, offset: 0.92 }, { transform: `translateY(${Math.round(g.h)}px)`, opacity: 0 }], { duration: 420, delay: 470, easing: 'cubic-bezier(.5, 0, .4, 1)' }),
        ...q('.hw-aura').map((n) => run(n, [{ opacity: 0 }], { duration: 400, delay: 650 })),
        ...q('.hw-bar, .hw-ctl, .hw-body, .hw-grip').map((n, i) => run(n, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 640 + i * 50 })),
      ].filter(Boolean);
      // the plate's transform origin must be set on the element (keyframes cannot carry it everywhere)
      for (const n of q('.hw-plate')) n.style.setProperty('transform-origin', '50% 0');
      Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {
        for (const a of anims) a.cancel();
        scan.remove(); el.classList.remove('forming');
        for (const n of q('.hw-plate')) n.style.removeProperty('transform-origin');
      });
    },

    close(win, remove) {
      const el = win.el;
      if (win.kind === 'debrief') { el.style.setProperty('pointer-events', 'none'); setTimeout(remove, 520); return; }   // the cards dissolve first
      if (simple() || el.classList.contains('sheet') || el.classList.contains('max')) {
        el.classList.add('closing'); el.addEventListener('animationend', remove, { once: true }); setTimeout(remove, 500); return;
      }
      const g = win.geo();
      el.style.setProperty('pointer-events', 'none');
      const fade = run(el, [{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'scale(1, .02)', offset: 0.55 }, { opacity: 0, transform: 'scale(.04, .01)' }], { duration: 420, easing: 'cubic-bezier(.5, 0, .75, .3)' });
      setTimeout(() => core.beam?.(g, -1, 480), 160);
      if (fade) fade.finished.then(remove, remove); else remove();
      setTimeout(remove, 700);
    },
  };
}
