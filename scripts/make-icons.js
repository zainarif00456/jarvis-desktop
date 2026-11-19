// Regenerates build/icon.png (1024) and build/tray.png (32) with ImageMagick: a cyan orb on a dark rounded square.
const { execFileSync } = require('child_process'); const path = require('path');
const out = path.join(__dirname, '..', 'build');
const mk = (size, file, radius) => execFileSync('convert', ['-size', `${size}x${size}`, 'radial-gradient:#bff3ff-#4cc9f0', '-gravity', 'center',
  '(', '-size', `${size}x${size}`, 'xc:none', '-fill', 'white', '-draw', `circle ${size / 2},${size / 2} ${size / 2},${size * 0.5 - radius}`, ')', '-alpha', 'off', '-compose', 'copy_opacity', '-composite', path.join(out, file)]);
const bg = (size, file, r) => execFileSync('convert', ['-size', `${size}x${size}`, 'xc:none', '-fill', '#03121c', '-draw', `roundrectangle 0,0 ${size - 1},${size - 1} ${size * 0.22},${size * 0.22}`, path.join(out, file)]);
bg(1024, 'icon-bg.png'); mk(640, 'orb.png', 320);
execFileSync('convert', [path.join(out, 'icon-bg.png'), path.join(out, 'orb.png'), '-gravity', 'center', '-composite', path.join(out, 'icon.png')]);
execFileSync('convert', [path.join(out, 'orb.png'), '-resize', '32x32', path.join(out, 'tray.png')]);
require('fs').unlinkSync(path.join(out, 'icon-bg.png')); require('fs').unlinkSync(path.join(out, 'orb.png'));
