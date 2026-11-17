const fs = require('node:fs');
const path = require('node:path');
const files = ['index.html', 'pwa.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'];
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
for (const file of files) fs.copyFileSync(path.join(__dirname, file), path.join(__dirname, 'dist', file));
console.log('Built standalone PWA assets in dist/');
