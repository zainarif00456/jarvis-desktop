// The QA pane: what the browser proved. Every step shows its expectation, the checks computed from the
// recorded evidence, the requests and console lines, and the screenshot. The verdict is the server's.
import { el } from '../util.js';
import { evidenceUrl } from './api.js';

const LABEL = { pass: 'PASS', fail: 'FAIL', flaky: 'FLAKY', untested: 'UNTESTED' };

export class QaPane {
  constructor() {
    this.badge = el('span', { class: 'dv-verdict v-untested', text: 'NO RUN' });
    this.body = el('div', { class: 'dv-qa' }, el('p', { class: 'dv-empty', text: 'No QA run yet. Ask me to test a page or an API: every result here comes with its proof.' }));
    this.el = el('div', { class: 'dv-qapane' }, el('div', { class: 'dv-bar' }, el('b', { text: 'QA evidence' }), this.badge), this.body);
  }

  show(qa) {
    if (!qa) return;
    this.badge.textContent = `${LABEL[qa.verdict] || qa.verdict}${qa.finished ? '' : ' · running'}`;
    this.badge.className = `dv-verdict v-${qa.verdict}`;
    const head = el('div', { class: 'dv-qahead' }, el('b', { text: qa.title }), qa.loose_actions ? el('i', { class: 'dv-warn', text: `${qa.loose_actions} browser action(s) had no expectation: they prove nothing` }) : null);
    this.body.replaceChildren(head, ...qa.steps.map((s) => this.step(qa.id, s)));
  }

  step(run, s) {
    const checks = s.checks.map((c) => el('li', { class: `ck ${c.result === true ? 'ok' : c.result === false ? 'no' : ''}` }, el('b', { text: c.result === true ? '✓' : c.result === false ? '✗' : '?' }), el('span', { text: `${c.kind} ${c.value ? `“${c.value}”` : ''} — ${c.detail}` })));
    const reload = s.reload ? el('div', { class: 'dv-reload' }, el('b', { text: 'after reload' }), el('ul', {}, ...s.reload.checks.map((c) => el('li', { class: `ck ${c.result ? 'ok' : 'no'}` }, el('b', { text: c.result ? '✓' : '✗' }), el('span', { text: c.detail }))))) : null;
    const net = s.network.length ? el('div', { class: 'dv-net' }, ...s.network.map((r) => el('code', { class: `rq s${String(r.status)[0]}`, text: `${r.method} ${r.url} → ${r.status}` }))) : null;
    const con = s.console.length ? el('div', { class: 'dv-con' }, ...s.console.map((l) => el('code', { class: l.startsWith('error') ? 'er' : '', text: l }))) : null;
    const shot = s.shot ? el('img', { class: 'dv-thumb', src: evidenceUrl(run, s.shot), alt: `screenshot for ${s.name}` }) : null;
    shot?.addEventListener('click', () => this.zoom(shot.src));
    return el('div', { class: `dv-step v-${s.verdict}` },
      el('div', { class: 'sh' }, el('span', { class: `dv-verdict v-${s.verdict}`, text: LABEL[s.verdict] || s.verdict }), el('b', { text: `${s.id}. ${s.name}` }), s.attempts > 1 ? el('i', { text: `${s.attempts} attempts` }) : null),
      el('p', { class: 'ex', text: `Expected: ${s.expectation}${s.persist ? ' (and it must survive a reload)' : ''}` }),
      s.action ? el('p', { class: 'ac', text: `Did: ${s.action}` }) : null,
      el('p', { class: 'wy', text: s.why }),
      checks.length ? el('ul', { class: 'dv-checks' }, ...checks) : null, reload, net, con, shot);
  }

  zoom(src) {
    const layer = el('div', { class: 'dv-lightbox', role: 'dialog', 'aria-label': 'Screenshot', onclick: () => layer.remove() }, el('img', { src, alt: 'screenshot' }));
    document.body.append(layer);
  }
}
