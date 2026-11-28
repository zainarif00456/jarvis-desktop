// The browser pane. Two ways to see the page, and the pane always shows the picture:
//  * the server's screenshot of every action (what the evidence is made of) is ALWAYS painted, whichever
//    browser took it, so the pane can never be an empty black box;
//  * on the desktop app the real native browser view (see window.jarvisBrowser) is drawn over the picture
//    when it is the one being driven (backend "desktop"), so the owner sees the live page at full size.
// The server records the evidence either way; page text is untrusted data.
import { el } from '../util.js';
import { evidenceUrl } from './api.js';

/** This page can drive the native browser (the desktop app's Jarvis page). */
export const drives = () => !!(window.jarvisBrowser && typeof window.jarvisBrowser.call === 'function');
/** This page can show the native browser view over a pane (also a pane in its own desktop window). */
export const hosts = () => !!(window.jarvisBrowser && typeof window.jarvisBrowser.setBounds === 'function');

export class BrowserPane {
  constructor({ send }) {
    this.send = send;
    this.backend = '';
    this.visible = false;
    this.url = el('span', { class: 'dv-url', text: 'about:blank' });
    this.tag = el('span', { class: 'dv-meta' });
    this.badges = el('span', { class: 'dv-badges' });
    this.caption = el('div', { class: 'dv-bcap', text: 'The browser opens here when I test a page.' });
    this.img = el('img', { class: 'dv-bshot', alt: 'What the browser shows', hidden: true });
    this.box = el('div', { class: 'dv-bbox', hidden: true });
    this.hint = el('p', { class: 'dv-empty dv-bhint', text: 'No page is open yet. Say “open the browser on” a local address, or ask me to test a page: it shows here.' });
    this.stage = el('div', { class: 'dv-bstage' }, this.hint, this.img, this.box);
    this.el = el('div', { class: 'dv-browserpane' }, el('div', { class: 'dv-bar' }, this.url, this.tag, this.badges), this.stage, this.caption);
    if (hosts()) {
      new ResizeObserver(() => this.report()).observe(this.stage);
      window.addEventListener('resize', () => this.report());
      window.jarvisBrowser.onEvent?.((e) => { if (e.url) this.url.textContent = e.url; });
    }
  }

  /** The server's state says which browser is in use. */
  setBackend(backend) {
    this.backend = backend || '';
    this.tag.textContent = this.backend === 'desktop' ? 'desktop browser' : this.backend ? 'server browser' : '';
    this.stage.classList.toggle('native', this.backend === 'desktop' && hosts());
    this.report();
  }

  /** The pane is on screen (or not): the native view follows it. */
  setVisible(on) {
    this.visible = on;
    this.report();
  }

  report() {
    if (!hosts()) return;
    const r = this.stage.getBoundingClientRect();
    const show = this.visible && this.backend === 'desktop' && r.width > 40 && r.height > 40;
    window.jarvisBrowser.setBounds(show ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null);
  }

  frame(m) {
    this.url.textContent = m.url || 'about:blank';
    this.setBackend(m.backend);
    this.caption.textContent = m.action;
    this.badges.replaceChildren(...[
      m.console_errors ? el('i', { class: 'bad', text: `${m.console_errors} console error${m.console_errors > 1 ? 's' : ''}` }) : null,
      m.failed_requests ? el('i', { class: 'bad', text: `${m.failed_requests} failed request${m.failed_requests > 1 ? 's' : ''}` }) : null].filter(Boolean));
    if (!m.shot) return;
    this.img.onload = () => this.place(m.box);
    this.img.src = `${evidenceUrl(m.run, m.shot)}?t=${Date.now()}`;   // shot-001 of ad hoc browsing is reused after a restart: never show a cached one
    this.img.hidden = false;
    this.hint.hidden = true;
  }

  place(box) {
    if (!box || !this.img.naturalWidth) { this.box.hidden = true; return; }
    const k = this.img.clientWidth / this.img.naturalWidth;
    const set = (p, v) => this.box.style.setProperty(p, `${v}px`);
    set('left', this.img.offsetLeft + box[0] * k); set('top', this.img.offsetTop + box[1] * k); set('width', box[2] * k); set('height', box[3] * k);
    this.box.hidden = false;
    setTimeout(() => { this.box.hidden = true; }, 1600);
  }

  /** The server asks this page to drive the native browser; answer over the socket. */
  async command(m) {
    if (!drives()) { this.send({ type: 'browser_result', id: m.id, ok: false, error: 'this page has no native browser' }); return; }
    try {
      const data = await window.jarvisBrowser.call(m.op, m.args || {});
      this.send({ type: 'browser_result', id: m.id, ok: true, data: data ?? null });
    } catch (err) {
      this.send({ type: 'browser_result', id: m.id, ok: false, error: String(err?.message || err).slice(0, 500) });
    }
  }
}
