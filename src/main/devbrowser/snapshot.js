() => {
  // Reads the page like an accessibility tree: interactive elements get a stable ref (data-jarvis-ref).
  // Version 1. The Electron view in jarvis-desktop runs the same script (keep them identical).
  document.querySelectorAll('[data-jarvis-ref]').forEach((e) => e.removeAttribute('data-jarvis-ref'));
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=textbox],[role=combobox],[onclick],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.02;
  };
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const labelled = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) return ids.split(/\s+/).map((id) => { const t = document.getElementById(id); return t ? text(t) : ''; }).join(' ').trim();
    return '';
  };
  const nameOf = (el) => (
    el.getAttribute('aria-label') || labelled(el) ||
    (el.labels && el.labels[0] ? text(el.labels[0]) : '') ||
    el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') ||
    (['submit', 'button', 'reset'].includes(el.type) ? el.value : '') || text(el)
  ).slice(0, 80);
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return el.isContentEditable ? 'textbox' : 'generic';
  };
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    n += 1;
    const ref = 'e' + n;
    el.setAttribute('data-jarvis-ref', ref);
    const r = el.getBoundingClientRect();
    const checkable = el.type === 'checkbox' || el.type === 'radio';
    elements.push({
      ref, role: roleOf(el), name: nameOf(el),
      value: checkable ? (el.checked ? 'checked' : 'unchecked') : (el.type === 'password' ? (el.value ? '••••' : '') : String(el.value || '').slice(0, 80)),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    });
    if (n >= 150) break;
  }
  return {
    url: location.href, title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000),
    elements, viewport: [innerWidth, innerHeight],
  };
}
