// Копирует статику PWA в www/ — webDir для Capacitor.
// Кроссплатформенно (win + linux CI): только fs/path.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');

const FILES = [
  'index.html',
  'manifest.webmanifest',
  'service-worker.js',
  '_headers',
  '.nojekyll',
];
const DIRS = ['css', 'js', 'icons'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const f of FILES) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}
for (const d of DIRS) {
  fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
}
console.log('www/ assembled');
