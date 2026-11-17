const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const crypto = require('node:crypto');
const targets = ['public/app.js', 'public/index.html', 'public/sw.js', 'tests/pwa-startup.e2e.js'];
fs.writeFileSync(path.join(__dirname, 'original-hashes.json'), JSON.stringify(Object.fromEntries(targets.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]))));
const read = name => fs.readFileSync(path.join(root, 'public', name), 'utf8');
const write = (name, text) => fs.writeFileSync(path.join(__dirname, name), text);
let app = read('app.js');
app = app.replace("if (targetView === 'admin' && authToken && currentUser?.role === 'admin')", "if (targetView === 'admin' && authToken && currentUser?.role === 'admin' && !options.skipReload)");
app = app.replace('    loadUserReferrals();', "    if (document.getElementById('view-account')?.classList.contains('active')) loadUserReferrals();");
const start = app.indexOf('async function initBoot() {');
const end = app.indexOf('// Global Escape key', start);
app = app.slice(0, start) + `async function initBoot() {
  syncAuthUi();
  // Font download must not block the first paint or application scripts.
  const font = document.getElementById('webFont');
  if (font) {
    const enableFont = () => { font.media = 'all'; };
    if (font.sheet) enableFont();
    else font.addEventListener('load', enableFont, { once: true });
  }

  // Show the requested screen immediately; refresh authoritative data in parallel.
  const initialHash = window.location.hash.replace('#', '');
  if (['home', 'wallet', 'admin', 'guide', 'faq', 'terms', 'orders', 'account'].includes(initialHash)) {
    switchView(initialHash, false, { skipReload: true });
  }
  const userReady = authToken ? loadUserDashboard() : Promise.resolve();
  const adminReady = userReady.then(() => {
    if (document.getElementById('view-admin')?.classList.contains('active')) {
      if (authToken && currentUser?.role === 'admin') return loadAdminDashboard();
      switchView('home', false);
    }
  });
  await Promise.all([initPublicConfig(), adminReady]);
}

` + app.slice(end);
write('app.js', app);
let html = read('index.html');
html = html.replace('href="https://fonts.googleapis.com/css2?', 'id="webFont" media="print" href="https://fonts.googleapis.com/css2?');
html = html.replace('/app.js?v=2.3.4', '/app.js?v=2.3.5');
const scripts = html.match(/  <script src="[^\"]+" defer><\/script>/g);
for (const script of scripts) html = html.replace(script, '');
html = html.replace('</head>', scripts.join('\n') + '\n</head>');
write('index.html', html);
let sw = read('sw.js').replace('lila-pwa-v6', 'lila-pwa-v7');
const assets = [...html.matchAll(/(?:href|src)="(\/[^\"]+\.(?:css|js)(?:\?[^\"]*)?)"/g)].map(m => m[1]);
sw = sw.replace("const OFFLINE_URL = '/offline.html';", `const OFFLINE_URL = '/offline.html';
// Bump CACHE_NAME whenever shell assets change; installation is all-or-nothing.
const SHELL_ASSETS = ${JSON.stringify(['/', ...assets])};`);
sw = sw.replace("[OFFLINE_URL, '/offline.js', '/icon.svg']", "[OFFLINE_URL, '/offline.js', '/icon.svg', ...SHELL_ASSETS].map(url => new Request(url, { cache: 'reload' }))");
sw = sw.replace("  if (event.request.mode === 'navigate'", `  // Only public shell files are cached. API, authentication and redirect data stay live.
  const shellKey = url.pathname === '/' || url.pathname === '/index.html'
    ? '/' : url.pathname + url.search;
  if (SHELL_ASSETS.includes(shellKey)) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache =>
      (await cache.match(shellKey)) || fetch(event.request)));
    return;
  }
  if (event.request.mode === 'navigate'`);
write('sw.js', sw);
// Keep existing failure/retry tests working with the expanded installation manifest.
let test = fs.readFileSync(path.join(root, 'tests/pwa-startup.e2e.js'), 'utf8');
test = test.replace("const name = req.url.slice(1);", "const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';");
test = test.replace("if (!['sw.js', 'offline.html', 'offline.js', 'icon.svg'].includes(name))", "if (!['sw.js', 'offline.html', 'offline.js', 'icon.svg', 'index.html', 'styles.css', 'selectPopup.css', 'adminMobile.css', 'csvImport.js', 'app.js', 'tiktokReply.js', 'selectPopup.js', 'adminMobile.js'].includes(name))");
write('pwa-startup.e2e.js', test);
console.log('Prepared app.js, index.html, sw.js and PWA test.');
