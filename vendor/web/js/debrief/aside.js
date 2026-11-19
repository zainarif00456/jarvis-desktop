// Questions asked during a briefing, answered on the same screen (server tool report.ask).
// The card sits over the briefing beside what the owner pointed at; nothing closes. A quick answer
// (Jarvis, from the report) types in; a deep one shows "Friday is looking into it" until her short
// debrief arrives, which then plays inside this card (js/debrief/stage.js, host mode). The briefing
// carries on by itself when the answer is done (the server resumes it).

import { el } from '../util.js';

const calm = () => document.documentElement.dataset.fx === 'lite' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Show (or replace) the question card on a report/debrief view's root. Returns the card. */
export function showAside(view, { question, answer = '', pending = '', about = '', ref = '' } = {}) {
  view.asideEl?.remove();
  clearTimeout(view.asideTimer);
  const body = pending
    ? el('div', { class: 'ax-pending' }, el('i', { class: 'ax-spin', 'aria-hidden': 'true' }), el('span', { text: `${pending} is looking into it…` }))
    : el('p', { class: 'ax-answer' });
  const card = el('aside', { class: 'rp-aside', role: 'status', 'aria-live': 'polite' },
    el('div', { class: 'ax-head' }, el('b', { text: 'FOLLOW-UP' }), el('span', { text: pending ? 'AGENT' : 'JARVIS' })),
    el('div', { class: 'ax-q' }, el('span', { text: 'Q' }), el('p', { text: question })),
    about ? el('div', { class: 'ax-about' }, el('span', { text: 'ABOUT' }), el('b', { text: about })) : null,
    body, el('div', { class: 'ax-slot' }));
  view.root.append(card);
  view.asideEl = card;
  if (answer) typeIn(body, answer);
  // what it is about glows while the answer is up
  if (ref) for (const n of view.root.querySelectorAll(`[data-ref="${CSS.escape(ref)}"]`)) { n.classList.add('asked'); setTimeout(() => n.classList.remove('asked'), 12000); }
  if (!pending) view.asideTimer = setTimeout(() => closeAside(view), 14000);
  return card;
}

export function closeAside(view) {
  const card = view.asideEl; if (!card) return;
  view.asideEl = null;
  if (calm() || !card.animate) { card.remove(); return; }
  card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(18px)' }], { duration: 320, fill: 'forwards' }).finished.then(() => card.remove(), () => card.remove());
}

function typeIn(node, text) {
  if (calm()) { node.textContent = text; return; }
  const words = text.split(/(\s+)/); let i = 0;
  const step = () => { i += 2; node.textContent = words.slice(0, i).join(''); if (i < words.length) setTimeout(step, 45); };
  step();
}
