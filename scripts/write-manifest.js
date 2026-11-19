// node write-manifest.js <webdir> <out.json> <commit> <serverVersion> <dirtyCount>
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dir, out, commit, serverVersion, dirty] = process.argv.slice(2);
const files = {};
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files[path.relative(dir, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
})(dir);
fs.writeFileSync(out, JSON.stringify({ sourceCommit: commit, serverVersion, uncommittedAtSync: Number(dirty), syncedAt: new Date().toISOString(), fileCount: Object.keys(files).length, files }, null, 1));
