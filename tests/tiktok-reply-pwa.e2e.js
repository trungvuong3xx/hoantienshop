/* global navigator, document */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.join(__dirname, '../tools/tiktok-reply/dist');
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!/^[a-z0-9.-]+$/.test(name) || !fs.existsSync(path.join(root, name))) return res.writeHead(404).end();
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(name)];
    res.setHeader('Content-Type', type || 'text/plain');
    res.end(fs.readFileSync(path.join(root, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.getElementById('pwaStatus').textContent === 'Sẵn sàng dùng ngoại tuyến');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
    await page.getByRole('button', { name: 'Cài trên điện thoại' }).click();
    assert.equal(await page.locator('#installGuide').isVisible(), true);
    await page.getByRole('button', { name: 'Đã hiểu' }).click();
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('pwaStatus').textContent === 'Đang dùng ngoại tuyến');
    await page.locator('#affiliateLink').fill('https://vt.tiktok.com/example/');
    await page.locator('#commission').fill('25000');
    await page.getByRole('button', { name: 'Tạo tin nhắn ↗' }).click();
    assert.equal(await page.locator('#cashback').textContent(), '15.750đ');
    assert.ok((await page.locator('#replyOutput').inputValue()).includes('Đặt hàng qua link trên để nhận hoàn tiền nhé.'));
    assert.deepEqual(errors, []);
    console.log('PASS: install metadata, installation guide, service worker activation, offline cold reload and calculation.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
