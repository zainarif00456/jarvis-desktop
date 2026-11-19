// Jarvis's hands on this screen. The server sends `screen_cmd` (open, focus, close, arrange, zoom,
// full screen, next...), this runs it on the portals and answers `screen_ack` with what happened.
// Every change, whoever made it (Jarvis, a click, a key), is reported as `screen_state`, so Jarvis
// always knows exactly what the owner is looking at and never acts on a guess.

import { windows, isCompact } from './holowin.js';
import { panels } from './workspace/registry.js';

export { layoutRects } from './workspace/layout.js';   // kept for older imports

const REPORT_DELAY_MS = 120;

export class ScreenController {
  /** deck: { viewer, cameras, reports }, workspace (layout + core links), send(payload) -> bool, showStage() */
  constructor({ deck, workspace, pointer, send, showStage }) {
    this.deck = deck; this.workspace = workspace; this.pointer = pointer; this.send = send; this.showStage = showStage; this.timer = 0;
    windows.onChange(() => this.report());
    window.addEventListener('resize', () => this.report());
  }

  // ---- what is on the screen ---------------------------------------------------------------
  state() {
    const top = windows.top();
    return {
      windows: windows.all().map((w) => {
        const g = w.geo();
        const extra = w.extra ? w.extra() : {};
        return {
          id: w.id, kind: w.kind, title: w.titleEl.textContent, item: w.item || null,
          active: w === top && !w.minimised, full: w.full, minimised: w.minimised,
          rect: [Math.round(g.x), Math.round(g.y), Math.round(g.w), Math.round(g.h)], ...extra,
        };
      }),
      viewport: [window.innerWidth, window.innerHeight], compact: isCompact(),
      mode: document.body.dataset.mode || 'stage',
      layout: this.workspace?.mode || 'grid', pinned: [...(this.workspace?.pins || [])],
      pointing: this.pointer?.state() || null,
    };
  }

  report() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send({ type: 'screen_state', ...this.state() }, { quiet: true }), REPORT_DELAY_MS);
  }

  // ---- doing what Jarvis asked -------------------------------------------------------------
  async handle(m) {
    let ok = true; let error = ''; let detail = '';
    try { detail = (await this.run(m)) || ''; } catch (err) { ok = false; error = String(err?.message || err); }
    if (ok) this.workspace?.pulse(m.target || windows.top()?.id);   // the core reaches out to what it touched
    this.send({ type: 'screen_ack', cmd_id: m.cmd_id, ok, error, detail, state: this.state() }, { quiet: true });
  }

  win(id) {
    let w = windows.get(id);
    if (!w && id === 'viewer') { const t = windows.top(); w = t && /^(file|camera)-/.test(t.id) ? t : windows.all().filter((x) => /^(file|camera)-/.test(x.id)).pop(); }   // desktop patch
    if (!w) throw new Error(`nothing called ${id} is open`);
    return w;
  }

  async run(m) {
    const a = m.args || {};
    switch (m.action) {
      case 'open': return this.open(a);
      case 'focus': { const w = this.win(m.target); w.restore(); w.focus(); w.flag(); return ''; }
      case 'flag': { const w = this.win(m.target); w.restore(); w.focus(); w.flag(); return ''; }
      case 'close': this.win(m.target).close(); return '';
      case 'close_all': { const n = windows.all().length; windows.closeAll(); return `${n} closed`; }
      case 'minimise': this.win(m.target).minimise(); return '';
      case 'restore': { const w = this.win(m.target); w.restore(); w.focus(); return ''; }
      case 'maximise': { this.showStage(); const w = this.win(m.target); w.restore(); w.focus(); w.setMax(true); return ''; }
      case 'unmaximise': this.win(m.target).exitFull(); return '';
      case 'arrange': this.showStage(); return this.workspace.arrange(a.layout || 'grid', { main: a.main || m.target || null, order: a.order || [] });
      case 'zoom': return this.zoom(m.target, a);
      case 'next': case 'previous': return this.step(m.target, m.action === 'next' ? 1 : -1);
      case 'report_open': return this.deck.reports.open(a.id, { section: a.section, full: a.full !== false, briefing: !!a.briefing, asideOf: a.aside_of || null });
      case 'report_aside': return this.deck.reports.get(a.id).aside({ question: a.question, answer: a.answer || '', pending: a.pending || '', about: a.about || '', ref: a.ref || '' });
      case 'report_focus': return this.deck.reports.get(a.id).focus(a.section);
      case 'report_overview': return this.deck.reports.get(a.id).overview();
      case 'report_step': return this.deck.reports.get(a.id).step(a.by || 1);
      case 'report_flag': return this.deck.reports.get(a.id).flag(a.section, a.part);
      case 'report_zoom': return this.deck.reports.get(a.id).zoom(a.section, { label: a.label, region: a.region, level: a.level });
      case 'report_pop': return this.deck.reports.get(a.id).pop(a.section);
      case 'report_keep': return this.deck.reports.get(a.id).keep() ? 'kept open' : 'it was not closing';
      case 'report_linger': this.deck.reports.get(a.id).lingerThenClose(a.seconds || 8); return 'closing soon';
      case 'report_close': this.deck.reports.get(a.id).closeAll(); return 'closed';
      case 'report_diagram': return this.deck.reports.get(a.id).diagram(a.section, { focus: a.focus || [], flow: a.flow || [], overview: !!a.overview });
      case 'report_code': return this.deck.reports.get(a.id).code(a.section, { index: a.index ?? null, node: a.node || null, lines: a.lines || [] });
      case 'report_row': return this.deck.reports.get(a.id).row(a.section, a.row);
      case 'report_build': return this.deck.reports.get(a.id).build(a.section, a.step);
      case 'report_media': return this.deck.reports.get(a.id).media(a.section, { index: a.index ?? null, play: !!a.play, pause: !!a.pause });
      case 'report_item': return this.deck.reports.get(a.id).item(a.section, a.part, a.item);
      case 'report_cite': return this.deck.reports.get(a.id).cite(a.section, a.sources || []);
      case 'report_changes': return this.deck.reports.get(a.id).showChanges();
      default: throw new Error(`unknown screen action ${m.action}`);
    }
  }

  /** Open a registered view (js/workspace/registry.js): file, files, cameras, schedule, ... */
  open(a) {
    this.showStage();
    return panels.open(a.what, a);
  }

  zoom(id, a) {
    const w = this.win(id || 'viewer');
    if (!w.id.startsWith('file-')) throw new Error('only pictures can be zoomed');
    w.restore(); w.focus();
    return this.deck.viewer.zoomTo(a.level ?? 'in', a.region || null, w.id);
  }

  step(id, by) {
    const w = this.win(id || 'viewer');
    if (!w.id.startsWith('file-')) throw new Error('only files move to the next / previous one');
    w.restore(); w.focus(); return this.deck.viewer.go(by, w.id)?.name || '';   // opens the neighbouring file as one more card
  }
}
