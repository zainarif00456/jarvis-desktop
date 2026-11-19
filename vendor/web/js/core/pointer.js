// Pointing without clicking: the mouse resting on something tells Jarvis what "this" is.
//
// When the pointer rests ~0.6 s on a meaningful thing (a message, a check, a log line, a chart
// bar, a diagram node, a table row, a step, a stat, a picture, a scene card, a section, a portal),
// a faint reticle frames it (so the owner sees what Jarvis now means by "this") and the screen
// state carries `pointing` {win, report, section, ref, label, at}. Jarvis reads it in <on_screen>
// and answers "what is this / explain this" about exactly that (server: screen.pointing_line,
// tool report.ask). Nothing is clicked or changed. Touch screens do not hover: nothing happens.
//
// What counts as a thing: elements with data-ref (js/blocks/data.js), diagram nodes, table rows,
// steps, stats, events, scene cards, pictures, then the section, then the portal.

const DWELL_MS = 600;
const TARGETS = '[data-ref], [data-node], .rp-table tr, .rp-step, .rp-stat, .rp-ev, .rp-stage, .db-card, .rp-card, .rp-focus, .hw';

const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();

function describe(node) {
  const win = node.closest('.hw[data-win]')?.dataset.win || '';
  const report = win.startsWith('report-') ? win.slice(7) : '';
  const section = node.closest('[data-section]')?.dataset.section || '';
  let ref = node.dataset.ref || ''; let label = '';
  if (node.matches('[data-node]')) { ref = `node:${node.dataset.node}`; label = `diagram node ${text(node).slice(0, 60) || node.dataset.node}`; }
  else if (node.matches('.rp-table tr')) { ref = `row:${[...node.parentElement.children].indexOf(node)}`; label = `table row ${text(node.querySelector('th')) || ''}`; }
  else if (node.matches('.rp-step')) label = `step ${text(node.querySelector('h4'))}`;
  else if (node.matches('.rp-stat')) label = `figure ${text(node)}`;
  else if (node.matches('.rp-ev')) label = `event ${text(node)}`;
  else if (node.matches('.rp-stage')) label = `the picture/diagram of ${text(node.closest('.rp-focus')?.querySelector('h2')) || 'this section'}`;
  else if (node.matches('.db-card, .rp-card')) label = `section card ${text(node)}`;
  else if (node.matches('.rp-focus')) label = `section ${text(node.querySelector('h2'))}`;
  else if (node.matches('.hw')) label = `portal ${node.getAttribute('aria-label') || win}`;
  else {
    const [part] = ref.split(':');
    const who = text(node.querySelector('.bk-who b, h4, .bk-ctext h4'));
    label = `${part} ${who ? `${who}: ` : ''}${text(node.querySelector('p, .bk-body') || node)}`;
  }
  return { win, report, section, ref, label: label.slice(0, 160), at: Date.now() };
}

export class PointerWatch {
  /** onPoint(pointing | null): the thing under the pointer changed (after the dwell). */
  constructor({ onPoint }) {
    this.onPoint = onPoint; this.current = null; this.candidate = null; this.timer = 0; this.raf = 0;
    this.reticle = document.createElement('i'); this.reticle.className = 'pt-reticle'; this.reticle.setAttribute('aria-hidden', 'true');
    document.body.append(this.reticle);
    if (!window.matchMedia('(hover: hover)').matches) return;
    document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') this.move(e); }, { passive: true });
    document.addEventListener('pointerleave', () => this.drop(), { passive: true });
    window.addEventListener('scroll', () => this.place(), { passive: true, capture: true });
  }

  move(e) {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const node = under?.closest(TARGETS);
      if (!node || !node.closest('.hw, #stage')) { this.candidate = null; clearTimeout(this.timer); return; }
      if (node === this.candidate || node === this.current?.node) return;
      this.candidate = node; clearTimeout(this.timer);
      this.timer = setTimeout(() => this.settle(node), DWELL_MS);
    });
  }

  settle(node) {
    if (!node.isConnected) return;
    this.current = { node, info: describe(node) };
    this.place(true);
    this.onPoint(this.current.info);
  }

  /** Frame the thing pointed at (transform only). */
  place(flash = false) {
    const node = this.current?.node;
    if (!node?.isConnected) { this.reticle.classList.remove('on'); return; }
    const r = node.getBoundingClientRect();
    const s = this.reticle.style;
    s.setProperty('transform', `translate(${Math.round(r.left - 4)}px, ${Math.round(r.top - 4)}px)`);
    s.setProperty('width', `${Math.round(r.width + 8)}px`); s.setProperty('height', `${Math.round(r.height + 8)}px`);
    this.reticle.classList.add('on');
    if (flash) { this.reticle.classList.remove('lock'); void this.reticle.offsetWidth; this.reticle.classList.add('lock'); }
  }

  drop() { clearTimeout(this.timer); this.candidate = null; }

  /** For the screen state: what the owner points at (kept a while after the mouse moves away). */
  state() { return this.current?.info || null; }
}
