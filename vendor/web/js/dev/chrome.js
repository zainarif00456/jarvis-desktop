// The buttons every pane has: minimise, maximise, full screen, pop out into a window, close.
// They do nothing themselves: they ask (`act`) and the server's layout answers, exactly as for a voice command.
import { el } from '../util.js';
import { TITLE } from './panes.js';

const SAY = { minimise: 'minimise', maximise: 'maximise', fullscreen: 'full screen', popout: 'pop out', close: 'close' };

/** The control cluster for one pane. `layout` is the current layout, `act(op, pane)` asks for a change. */
export function paneControls(pane, layout, act, { canPop = true } = {}) {
  const max = layout.max === pane; const full = layout.full === pane;
  const name = TITLE[pane].toLowerCase();
  const btn = (cls, glyph, label, onclick, hint = '') => el('button', { type: 'button', class: `dv-cb ${cls}`, text: glyph, title: `${label}${hint ? ` (${hint})` : ''}`, 'aria-label': `${label} ${name}`, onclick });
  return el('span', { class: 'dv-ctl', role: 'group', 'aria-label': `${TITLE[pane]} window controls` },
    btn('min', '–', 'Minimise', () => act('minimise', pane), `say: ${SAY.minimise} the ${name}`),
    btn('max', max ? '❐' : '□', max ? 'Restore size of' : 'Maximise', () => act(max ? 'restore' : 'maximise', pane), 'Ctrl+Shift+M'),
    btn('full', '⛶', full ? 'Leave full screen for' : 'Full screen', () => act(full ? 'unfull' : 'fullscreen', pane), 'Ctrl+Shift+F'),
    canPop ? btn('pop', '⧉', 'Pop out into its own window', () => act('popout', pane), 'Ctrl+Shift+P') : null,
    btn('close', '✕', 'Close', () => act('close', pane)));
}
