'use strict';
// The desktop patch layer (patches/apply.js): idempotent, consistent with vendor/patched.json, and the patched web files still parse.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('applying the patch to the vendored (already patched) web client changes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-patch-'));
  fs.cpSync(path.join(ROOT, 'vendor', 'web'), tmp, { recursive: true });
  const before = fs.readFileSync(path.join(ROOT, 'vendor', 'patched.json'), 'utf8');
  const out = cp.execFileSync('node', [path.join(ROOT, 'patches', 'apply.js'), tmp], { encoding: 'utf8' });
  assert.match(out, /nothing to change/);
  assert.equal(fs.readFileSync(path.join(ROOT, 'vendor', 'patched.json'), 'utf8'), before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('vendor/patched.json matches the files on disk, and drift check agrees', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'patched.json'), 'utf8')).files;
  assert.ok(Object.keys(p).length >= 8);
  for (const [f, h] of Object.entries(p)) assert.equal(sha(path.join(ROOT, 'vendor', 'web', f)), h, f);
  const r = cp.spawnSync('node', [path.join(ROOT, 'scripts', 'check-drift.js'), '/nonexistent'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});

test('patched web modules and shell scripts parse', () => {
  for (const f of ['js/viewer.js', 'js/cards.js', 'js/cameras.js', 'js/screen.js', 'js/deck.js', 'js/holowin.js', 'js/workspace/workspace.js']) {
    const tmp = path.join(os.tmpdir(), `jd-check-${path.basename(f)}.mjs`);
    fs.copyFileSync(path.join(ROOT, 'vendor', 'web', f), tmp);
    cp.execFileSync('node', ['--check', tmp]);
  }
  for (const f of ['src/preload/overlay-page.js', 'src/preload/app.js', 'src/main/main.js']) cp.execFileSync('node', ['--check', path.join(ROOT, f)]);
});

test('the card viewer replaces the gallery: no film strip, no swipe nav, whole pictures', () => {
  const v = fs.readFileSync(path.join(ROOT, 'vendor', 'web', 'js', 'viewer.js'), 'utf8');
  assert.ok(!/fv-strip|fv-nav|SWIPE_PX/.test(v));
  assert.match(v, /id: cardId\(file\)|cardId\(file\)/);
  const css = fs.readFileSync(path.join(ROOT, 'vendor', 'web', 'css', 'cards.css'), 'utf8');
  assert.match(css, /\.jc-img[^}]*object-fit: contain/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'vendor', 'web', 'index.html'), 'utf8').includes('/css/cards.css'));
});
