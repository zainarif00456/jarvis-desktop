// The explain view: code beside a diagram of how it runs, walked step by step. The code is cut from
// the real files by the server; the diagram is the briefing renderer's SVG (js/report-parts.js).
import { el } from '../util.js';
import { CodeView, DiagramView } from '../report-parts.js';

export class ExplainPane {
  constructor() {
    this.title = el('b', { text: 'Explain' });
    this.step = el('span', { class: 'dv-meta' });
    this.say = el('p', { class: 'dv-say' });
    this.left = el('div', { class: 'dv-exleft' });
    this.right = el('div', { class: 'dv-exright' });
    this.prev = el('button', { type: 'button', class: 'dv-btn', text: '‹ back', onclick: () => this.go(this.at - 1) });
    this.next = el('button', { type: 'button', class: 'dv-btn', text: 'next ›', onclick: () => this.go(this.at + 1) });
    this.el = el('div', { class: 'dv-explainpane' }, el('div', { class: 'dv-bar' }, this.title, this.step, this.prev, this.next), this.say,
      el('div', { class: 'dv-exsplit' }, this.left, this.right));
    this.data = null; this.at = 0;
    this.left.append(el('p', { class: 'dv-empty', text: 'Ask me to explain how a function runs: the code and a diagram of it appear side by side.' }));
  }

  show(explain) {
    this.dia?.destroy?.();
    this.data = explain; this.at = explain.current || 0; this.dia = null;
    this.title.textContent = explain.title;
    this.right.replaceChildren(explain.diagram
      ? (this.dia = new DiagramView({ ...explain.diagram }, {})).el
      : el('p', { class: 'dv-empty', text: explain.diagram_problem ? `Diagram: ${explain.diagram_problem}` : 'No diagram for this one.' }));
    this.go(this.at);
  }

  async go(index) {
    if (!this.data) return;
    this.at = Math.max(0, Math.min(this.data.steps.length - 1, index));
    const step = this.data.steps[this.at];
    this.step.textContent = `step ${this.at + 1} of ${this.data.steps.length}`;
    this.say.textContent = step.say;
    this.prev.disabled = this.at === 0; this.next.disabled = this.at === this.data.steps.length - 1;
    if (step.path) {
      const view = new CodeView({ path: step.path, start: step.start, end: step.end, language: step.language, text: step.code.join('\n'), marks: [[step.start, step.end]] }, { big: true });
      this.left.replaceChildren(view.el);
    } else this.left.replaceChildren(el('p', { class: 'dv-empty', text: 'This step has no code.' }));
    if (this.dia) { try { await this.dia.focus(step.nodes || []); } catch { /* a node the diagram lacks: whole view */ } }
  }
}
