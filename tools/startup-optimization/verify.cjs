const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('../../node_modules/playwright');
const root = path.resolve(__dirname, '../..');
let mode = 'before';
let delay = 1400;
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (name.startsWith('api/')) {
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }, delay);
    return;
  }
  const staged = path.join(__dirname, name);
  const file = mode === 'after' && ['app.js', 'index.html', 'sw.js'].includes(name)
    ? staged : path.join(root, 'public', name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const results = {};
    let baselineErrors;
    for (mode of ['before', 'after']) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', err => { errors.push(err.message); console.log(mode, err.stack); });
      await page.route('https://**/*', route => route.abort());
      const begin = Date.now();
      await page.goto(origin + '/#guide', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#view-guide.active');
      results[mode] = Date.now() - begin;
      if (mode === 'before') baselineErrors = errors;
      else assert.deepEqual(errors, baselineErrors);
      await context.close();
    }
    assert(results.after < 1000, JSON.stringify(results));
    assert(results.before - results.after > 900, JSON.stringify(results));
    console.log('Guide ready with API delayed 1400ms:', results);
    console.log('Existing browser errors:', baselineErrors);
    mode = 'after';
    delay = 0;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const keys = await page.evaluate(async () => {
      const cache = await caches.open('lila-pwa-v7');
      return (await cache.keys()).map(req => req.url);
    });
    assert(keys.some(url => url.endsWith('/')));
    assert(!keys.some(url => url.includes('/api/')));
    await context.setOffline(true);
    const begin = Date.now();
    await page.goto(origin + '/#guide', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-guide.active');
    assert(await page.locator('#view-home').count());
    console.log('Cached offline shell and guide ready:', Date.now() - begin, 'ms; no API cached.');
    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
})().catch(err => { console.error(err); server.close(); process.exitCode = 1; });
