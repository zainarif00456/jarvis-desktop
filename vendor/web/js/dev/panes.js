// The nine panes of Development Mode and the messages that feed them. Shared by the IDE inside the main
// window (mode.js) and by a pane in its own OS window (window.js): both are fed by the same dev_* events.
import { el } from '../util.js';
import { TreePane } from './tree.js';
import { CodePane } from './code.js';
import { DiffPane } from './diff.js';
import { AgentPane } from './agent.js';
import { BrowserPane } from './browser.js';
import { QaPane } from './qa.js';
import { ExplainPane } from './explain.js';
import { ActionsPane } from './actions.js';

export const ORDER = ['tree', 'code', 'diff', 'explain', 'agent', 'browser', 'qa', 'terminal', 'actions'];
export const HOME = { tree: 'side', code: 'center', diff: 'center', explain: 'center', agent: 'right', browser: 'right', qa: 'right', terminal: 'bottom', actions: 'bottom' };
export const TITLE = { tree: 'Files', code: 'Code', diff: 'Changes', explain: 'Explain', agent: 'Agents', browser: 'Browser', qa: 'QA', terminal: 'Terminal', actions: 'Actions' };

export class PaneHub {
  /** `send` talks to the server; `front` says which pane the owner is looking at (for "this file"); `shown(name)` whether a pane is on screen (the diff is only fetched then). */
  constructor({ send, front = () => '', shown = () => true }) {
    this.send = send; this.front = front; this.shown = shown;
    const open = (path, line) => this.send({ type: 'dev_open', path, line: line || 0 });
    this.tree = new TreePane({ onOpen: open });
    this.code = new CodePane({ onView: (path, line) => this.report(path, line) });
    this.diff = new DiffPane({ onOpen: open });
    this.agent = new AgentPane({ onOpen: open });
    this.browser = new BrowserPane({ send });
    this.qa = new QaPane();
    this.explain = new ExplainPane();
    this.actions = new ActionsPane();
    this.termHost = el('div', { class: 'dv-termhost' }, el('p', { class: 'dv-empty', text: 'Terminal' }));
    this.nodes = { tree: this.tree.el, code: this.code.el, diff: this.diff.el, explain: this.explain.el, agent: this.agent.el, browser: this.browser.el, qa: this.qa.el, terminal: this.termHost, actions: this.actions.el };
  }

  /** The whole state arrived (the mode started, or this page connected). */
  async state(dev) {
    this.diff.setCheckpoints(dev.checkpoints || []);
    this.agent.state(dev);
    if (dev.qa) this.qa.show(dev.qa);
    if (dev.explain && !this.explain.data) this.explain.show(dev.explain);
    if (dev.browser) {
      this.browser.setBackend(dev.browser.backend === 'headless' && !dev.browser.url ? '' : dev.browser.backend);
      if (dev.browser.frame) this.browser.frame(dev.browser.frame);
    }
    this.actions.touch();
    const first = !this.started; this.started = true;
    if (first) { await this.tree.load().catch(() => {}); const s = dev.session; if (s.open_file) await this.openFile(s.open_file, s.open_line); }
  }

  /** One dev_* / qa_* / browser_* message. Returns true when a pane took it. */
  handle(m) {
    switch (m.type) {
      case 'dev_focus': this.openFile(m.path, m.line || 0, m.error); return true;
      case 'dev_refresh': this.refresh(m); return true;
      case 'dev_event': this.agent.event(m); this.actions.touch(); return true;
      case 'dev_diff': this.diff.load(m.path); return true;
      case 'dev_explain': this.explain.show(m.explain); return true;
      case 'dev_explain_step': this.explain.go(m.current); return true;
      case 'qa_update': this.qa.show(m.qa); return true;
      case 'browser_frame': this.browser.frame(m); return true;
      case 'browser_cmd': this.browser.command(m); return true;
      default: return false;
    }
  }

  async openFile(path, line = 0, error = '') {
    if (error) { this.code.error(path, error); return; }
    if (!await this.code.open(path, line)) return;
    this.tree.reveal(path);
  }

  async refresh(m) {
    this.tree.refresh();
    if (this.shown('diff') || !this.diff.files.length) this.diff.load();
    this.actions.touch();
    const paths = m.paths || [];
    if (this.code.path && (paths.includes(this.code.path) || !paths.length)) {
      if (this.code.follow && m.line && paths.includes(this.code.path)) await this.code.reload(m.line);
      else await this.code.reload();
    }
    if (this.code.follow && m.line && paths[0] && paths[0] !== this.code.path) await this.openFile(paths[0], m.line);
  }

  report(path, line) {
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.send({ type: 'dev_ui', open_file: path, line, pane: this.front() }), 400);
  }
}
