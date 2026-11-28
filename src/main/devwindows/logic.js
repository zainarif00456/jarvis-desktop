'use strict';
// Panes of Development Mode in their own OS windows: which windows exist, what they load, where they open.
// Pure logic (no Electron): `create(spec, handlers)` is given by index.js, so this is tested with a fake.
// The Jarvis page (web client js/dev/windows.js) decides WHEN a pane has a window; this only keeps them.
const PANES = ['tree', 'code', 'diff', 'explain', 'agent', 'browser', 'qa', 'terminal', 'actions'];
const TITLE = { tree: 'Files', code: 'Code', diff: 'Changes', explain: 'Explain', agent: 'Agents', browser: 'Browser', qa: 'QA', terminal: 'Terminal', actions: 'Actions' };
const DEFAULT_SIZE = { width: 1100, height: 760 };
const MIN_SIZE = { width: 360, height: 240 };
const STAGGER = 30;
const MIN_VISIBLE = 120;   // a saved window must show at least this much of itself on some display

/** The page a pane window loads, on the gateway (so the device token and the same origin apply). */
function paneUrl(base, pane, opts = {}) {
  const q = new URLSearchParams({ pane });
  if (pane === 'terminal' && /^[a-f0-9]{4,20}$/.test(String(opts.term || ''))) q.set('term', opts.term);
  return `${String(base).replace(/\/$/, '')}/dev-window.html?${q}`;
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
const overlapY = (a, b) => Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where a window opens: where it was last (if that is still on a display), else the middle of the primary
 * display, nudged for each window already open so they do not hide each other. Always inside a work area.
 */
function placeWindow(saved, areas, open = 0) {
  const primary = areas[0] || { x: 0, y: 0, width: 1280, height: 800 };
  const size = { width: Math.max(MIN_SIZE.width, Math.round(saved?.width || DEFAULT_SIZE.width)), height: Math.max(MIN_SIZE.height, Math.round(saved?.height || DEFAULT_SIZE.height)) };
  const home = areas.find((a) => saved && overlap(saved, a) >= MIN_VISIBLE && overlapY(saved, a) >= MIN_VISIBLE);
  const area = home || primary;
  const width = Math.min(size.width, area.width); const height = Math.min(size.height, area.height);
  let x; let y;
  if (home) {
    x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width);
    y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height);
  } else {
    const shift = (open % 6) * STAGGER;
    x = area.x + Math.max(0, Math.round((area.width - width) / 2)) + shift; y = area.y + Math.max(0, Math.round((area.height - height) / 2)) + shift;
    x = Math.min(x, area.x + area.width - width); y = Math.min(y, area.y + area.height - height);
  }
  return { x, y, width, height };
}

class PaneWindows {
  /** create(spec, { onClosed, onBounds }) -> { focus(), close() }. `saved` is { pane: bounds }. */
  constructor({ create, base, areas = () => [], saved = {}, onSaved = () => {}, onClosed = () => {} }) {
    this.create = create; this.base = base; this.areas = areas; this.saved = { ...saved }; this.onSaved = onSaved; this.onClosedCb = onClosed;
    this.windows = new Map(); this.requested = new Set(); this.shutting = false;
  }

  has(pane) { return this.windows.has(pane); }
  list() { return [...this.windows.keys()]; }

  /** Open the pane's window, or bring the one it has to the front. Returns { pane, created }. */
  open(pane, opts = {}) {
    if (!PANES.includes(pane)) throw new Error(`there is no pane called ${String(pane).slice(0, 30)}`);
    const have = this.windows.get(pane);
    if (have) { have.focus(); return { pane, created: false }; }
    const spec = { pane, title: `Jarvis · ${TITLE[pane]}`, url: paneUrl(typeof this.base === 'function' ? this.base() : this.base, pane, opts), bounds: placeWindow(this.saved[pane], this.areas(), this.windows.size), min: MIN_SIZE };
    const handle = this.create(spec, {
      onClosed: () => this.closed(pane),
      onBounds: (b) => { this.saved[pane] = { x: b.x, y: b.y, width: b.width, height: b.height }; this.onSaved(this.saved); },
    });
    this.windows.set(pane, handle);
    return { pane, created: true };
  }

  /** The server's layout says the pane is docked again: close its window quietly (no "closed by the owner"). */
  close(pane) {
    const have = this.windows.get(pane);
    if (!have) return false;
    this.requested.add(pane);
    have.close();
    return true;
  }

  closeAll() {
    this.shutting = true;   // the app is quitting: the layout keeps these panes as windows, so they come back
    for (const handle of [...this.windows.values()]) handle.close();
  }

  closed(pane) {
    this.windows.delete(pane);
    const byRequest = this.requested.delete(pane);
    if (!byRequest && !this.shutting) this.onClosedCb(pane);   // the owner used the window's own close button
  }
}

module.exports = { PaneWindows, paneUrl, placeWindow, PANES, TITLE, MIN_SIZE, DEFAULT_SIZE };
