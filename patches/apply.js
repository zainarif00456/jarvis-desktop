#!/usr/bin/env node
// The desktop PATCH LAYER for the vendored web client (vendor/web). The web app itself is not changed (Zain: "we will fix the web app
// later"); everything that differs from it lives here, so it can be carried back to clients/web as one reviewed change.
//
//   patches/web/**         files copied over / added to vendor/web (viewer.js = the card viewer, cards.js, css/cards.css)
//   EDITS below            small anchored text edits in vendor/web files (each one fails loudly if the web client changed under it)
//
// scripts/sync-web.sh runs this after every re-vendor, so a sync can never silently drop the patch.
// Usage: node patches/apply.js [vendor/web dir]       (idempotent; prints what it did; exit 1 when an anchor no longer matches)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const HERE = __dirname;
const DST = path.resolve(process.argv[2] || path.join(HERE, '..', 'vendor', 'web'));

const EDITS = [
  // ---- full screen that really fills the screen (desktop: page-filling mode + the shell makes the window / display full; see src/preload/app.js, src/main/overlay.js)
  ['js/holowin.js', "if (this.el.requestFullscreen && navigator.userActivation?.isActive !== false) {",
    "if (!document.documentElement.hasAttribute('data-jd-desktop') && this.el.requestFullscreen && navigator.userActivation?.isActive !== false) {   // desktop: the shell fills the display itself (no HTML fullscreen)"],
  ['js/holowin.js', "    this.el.dispatchEvent(new CustomEvent('hw-resize'));\n    changed(this, 'full');",
    "    document.documentElement.toggleAttribute('data-jd-full', [...wins.values()].some((w) => w.full));   // the shell watches this (overlay / window full screen)\n    this.el.dispatchEvent(new CustomEvent('hw-resize'));\n    changed(this, 'full');"],
  ['js/holowin.js', "this.closed = true; wins.delete(this.id);",
    "this.closed = true; wins.delete(this.id); document.documentElement.toggleAttribute('data-jd-full', [...wins.values()].some((w) => w.full));"],
  // ---- the workspace is reachable for the pin button
  ['js/workspace/workspace.js', "    this.pins = new Set();\n", "    this.pins = new Set();\n    windows.hooks.workspace = this;   // desktop patch: the pin button (js/cards.js)\n"],
  // ---- cameras: one hologram card per camera instead of the single wall
  ['js/cameras.js', "import { LivePlayer } from './player.js';", "import { LivePlayer } from './player.js';\nimport { CameraCards } from './cards.js';"],
  ['js/cameras.js', "class MainView {", "export class MainView {"],
  ['js/cameras.js', "this.cameras = []; this.wall = null; this.ffmpeg = true;", "this.cameras = []; this.wall = null; this.ffmpeg = true;\n    this.cards = new CameraCards(this, MainView);   // desktop patch: every camera is its own card"],
  ['js/cameras.js', "    this.cameras = list || [];\n", "    this.cameras = list || [];\n    this.cards?.sync();\n"],
  ['js/cameras.js', "(node.requestFullscreen ? node.requestFullscreen() : Promise.reject()).catch(() => this.deck.wall?.win.toggleFull());",
    "if (this.deck.cards?.cards.has(this.camera.id)) { this.deck.cards.toggleFull(this.camera.id); return; }\n    (node.requestFullscreen ? node.requestFullscreen() : Promise.reject()).catch(() => this.deck.wall?.win.toggleFull());"],
  ['js/cameras.js', "  close() { windows.get(WALL_ID)?.close(); }", "  close() { windows.get(WALL_ID)?.close(); this.cards.closeAll(); }"],
  { file: 'js/cameras.js', re: /  open\(ids, focus\) \{[\s\S]*?\n  \}\n(?=\n  \/\*\* Nothing is set up)/, with:
    "  open(ids, focus) {\n    if (!this.cameras.length) { this.detectThenOpen(ids, focus); return; }\n    const want = (ids && ids.length ? ids : this.cameras.map((c) => c.id)).filter((id) => this.byId(id));\n    if (!want.length) { this.toast('Those cameras are not set up.'); return; }\n    for (const id of want) this.cards.open(id, id === focus);   // desktop patch: one card each, live side by side\n  }\n",
    done: "this.cards.open(id, id === focus)" },
  // ---- screen commands know the cards (the old single 'viewer' id still resolves to the file / camera in front)
  { file: 'js/screen.js', re: /  win\(id\) \{[\s\S]*?\n  \}\n/, with:
    "  win(id) {\n    let w = windows.get(id);\n    if (!w && id === 'viewer') { const t = windows.top(); w = t && /^(file|camera)-/.test(t.id) ? t : windows.all().filter((x) => /^(file|camera)-/.test(x.id)).pop(); }   // desktop patch\n    if (!w) throw new Error(`nothing called ${id} is open`);\n    return w;\n  }\n", done: "desktop patch" },
  { file: 'js/screen.js', re: /  zoom\(id, a\) \{[\s\S]*?\n  \}\n\n  step\(id, by\) \{[\s\S]*?\n  \}\n/, with:
    "  zoom(id, a) {\n    const w = this.win(id || 'viewer');\n    if (!w.id.startsWith('file-')) throw new Error('only pictures can be zoomed');\n    w.restore(); w.focus();\n    return this.deck.viewer.zoomTo(a.level ?? 'in', a.region || null, w.id);\n  }\n\n  step(id, by) {\n    const w = this.win(id || 'viewer');\n    if (!w.id.startsWith('file-')) throw new Error('only files move to the next / previous one');\n    w.restore(); w.focus(); return this.deck.viewer.go(by, w.id)?.name || '';   // opens the neighbouring file as one more card\n  }\n", done: "this.deck.viewer.zoomTo(a.level ?? 'in', a.region || null, w.id)" },
  // ---- deck: "open this file full" targets the file's own card
  ['js/deck.js', "if (a.full) windows.get('viewer')?.setMax(true);", "if (a.full) windows.get(`file-${file.id}`)?.setMax(true);"],
  ['index.html', '  <link rel="stylesheet" href="/css/workspace.css">', '  <link rel="stylesheet" href="/css/workspace.css">\n  <link rel="stylesheet" href="/css/cards.css">   <!-- desktop patch (patches/) -->'],
];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let failed = 0; const touched = new Set();
const read = (f) => fs.readFileSync(path.join(DST, f), 'utf8');
const write = (f, s) => { fs.writeFileSync(path.join(DST, f), s); touched.add(f); };
for (const e of EDITS) {
  const file = Array.isArray(e) ? e[0] : e.file; const src = read(file);
  const done = Array.isArray(e) ? e[2] : e.done;
  if (Array.isArray(e)) {
    if (src.includes(e[2])) continue;                       // already applied
    if (!src.includes(e[1])) { console.error(`patch: anchor not found in ${file}: ${e[1].slice(0, 70)}…`); failed++; continue; }
    write(file, src.replace(e[1], () => e[2]));
  } else {
    if (src.includes(done)) continue;
    if (!e.re.test(src)) { console.error(`patch: anchor not found in ${file}: ${e.re}`); failed++; continue; }
    write(file, src.replace(e.re, () => e.with));
  }
}
(function copy(from, to) {
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name), d = path.join(to, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); continue; }
    const body = fs.readFileSync(s);
    if (!fs.existsSync(d) || !fs.readFileSync(d).equals(body)) { fs.writeFileSync(d, body); touched.add(path.relative(DST, d).split(path.sep).join('/')); }
  }
})(path.join(HERE, 'web'), DST);

// remember the patched files' hashes so scripts/check-drift.js can tell "patched on purpose" from "edited by hand"
const list = new Set(EDITS.map((e) => (Array.isArray(e) ? e[0] : e.file)));
(function walk(d, base) { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); ent.isDirectory() ? walk(p, base) : list.add(path.relative(base, p).split(path.sep).join('/')); } })(path.join(HERE, 'web'), path.join(HERE, 'web'));
const out = {}; for (const f of [...list].sort()) out[f] = sha(fs.readFileSync(path.join(DST, f)));
fs.writeFileSync(path.join(HERE, '..', 'vendor', 'patched.json'), JSON.stringify({ note: 'sha256 of every vendor/web file the desktop patch layer (patches/apply.js) changes or adds', files: out }, null, 1));
console.log(failed ? `patch: ${failed} edit(s) did not apply` : `patch: applied (${touched.size ? [...touched].join(', ') : 'nothing to change'})`);
process.exit(failed ? 1 : 0);
