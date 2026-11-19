// What can be done with a file or folder shown on a live work card (right-click, ⋯ or long-press).
// A popover at the pointer on the laptop, an action sheet on the phone. Every action goes to the
// server by the item's handle (js/exec/layer.js act) and shows up as its own command card.

import { el, copyText } from '../util.js';
import { isCompact } from '../holowin.js';
import { fileIcon } from './render.js';

const home = (path) => String(path || '').replace(/^\/home\/[^/]+/, '~');

export class ActionMenu {
  constructor({ act }) {
    this.act = act;
    this.node = el('div', { class: 'xm', role: 'menu', hidden: true });
    document.body.append(this.node);
    const away = (e) => { if (!this.node.hidden && !this.node.contains(e.target)) this.close(); };
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    addEventListener('resize', () => this.close());
  }

  open(item, x, y, from) {
    const dir = item.kind === 'dir';
    const go = (action) => () => { this.close(); this.act(item.h, action, from); };
    const rows = [
      ['Open on the laptop', go('open')],
      [dir ? 'Browse it here' : 'Browse its folder here', go('browse')],
      ['Show in its folder (laptop)', go('reveal')],
      !dir ? ['View on this screen', go('view')] : null,
      ['Open a terminal there', go('terminal')],
      ['Copy the path', () => { this.close(); copyText(item.path); }],
    ].filter(Boolean);
    this.node.replaceChildren(
      el('div', { class: 'xm-head' }, fileIcon(item.kind), el('span', { text: home(item.path) })),
      ...rows.map(([label, fn]) => el('button', { type: 'button', role: 'menuitem', class: 'xm-row', text: label, onclick: fn })),
    );
    this.node.hidden = false;
    this.node.classList.toggle('sheet', isCompact());
    if (!isCompact()) {
      const r = this.node.getBoundingClientRect();
      this.node.style.setProperty('--x', `${Math.round(Math.min(x, innerWidth - r.width - 8))}px`);
      this.node.style.setProperty('--y', `${Math.round(Math.min(y, innerHeight - r.height - 8))}px`);
    }
    this.node.querySelector('.xm-row')?.focus();
  }

  close() { this.node.hidden = true; }
}
