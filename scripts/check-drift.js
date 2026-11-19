// Compares vendor/web (and the source tree, if present) against vendor/manifest.json.
// Usage: node scripts/check-drift.js [path/to/project-jarvis]   exit 1 on drift.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const man = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'manifest.json'), 'utf8'));
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p, o) : o.push(p); } return o; };
const patched = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'patched.json'), 'utf8')).files; } catch { return {}; } })();   // files the desktop patch layer changes on purpose (patches/apply.js)
function compare(label, dir, usePatched) {
  const have = {}; for (const f of walk(dir)) have[path.relative(dir, f).split(path.sep).join('/')] = hash(f);
  const bad = [];
  const want = (k) => (usePatched && patched[k]) || man.files[k];
  for (const k of Object.keys(man.files)) if (!have[k]) bad.push(`missing  ${k}`); else if (have[k] !== want(k)) bad.push(`changed  ${k}`);
  for (const k of Object.keys(have)) if (!man.files[k] && !(usePatched && patched[k])) bad.push(`new      ${k}`);
  if (usePatched) for (const k of Object.keys(patched)) if (!have[k]) bad.push(`missing patched  ${k}`);
  console.log(`${label}: ${bad.length ? bad.length + ' difference(s)' : 'in sync'}`); bad.slice(0, 40).forEach((b) => console.log('  ' + b));
  return bad.length;
}
let n = compare('vendor/web vs manifest (local edits?)', path.join(root, 'vendor', 'web'), true);
const src = process.argv[2] || path.join(process.env.HOME || '', 'Documents/Projects/project-jarvis');
if (fs.existsSync(path.join(src, 'clients/web/index.html'))) n += compare('Jarvis source vs manifest (Jarvis changed?)', path.join(src, 'clients/web'));
else console.log('Jarvis source not found; skipped.');
process.exit(n ? 1 : 0);
