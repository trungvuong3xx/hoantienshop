/* global document, window */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const vm = require('node:vm');

async function verifyApiDeadline() {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const apiSource = source.slice(source.indexOf('async function apiFetch('), source.indexOf('// Navigation & History API'));
  const notices = [];
  const context = {
    AbortController, AbortSignal,
    setTimeout: (callback) => setTimeout(callback, 25),
    clearTimeout,
    navigator: { onLine: true },
    authToken: null,
    showConnectionNotice: (message) => notices.push(message),
    fetch: async (url, options) => ({
      status: 200,
      ok: true,
      json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('Aborted while reading body');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      })
    })
  };
  await assert.rejects(vm.runInNewContext(`${apiSource}\napiFetch('/api/public-config')`, context), /Kết nối quá lâu/);
  assert.equal(notices.length, 1);
  console.log('PASS: API timeout covers a stalled JSON body and displays recovery instructions.');
}

async function main() {
  await verifyApiDeadline();
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    if (req.url === '/slow') return;
    if (req.url === '/broken') {
      res.writeHead(503).end('Unavailable');
      return;
    }
    if (req.url === '/healthy' || req.url === '/setup') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><body>Ready</body></html>');
      return;
    }
    const name = req.url.slice(1);
    if (!['sw.js', 'offline.html', 'offline.js', 'icon.svg'].includes(name)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, '../public', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PWA_TEST_CHANNEL ? { channel: process.env.PWA_TEST_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/setup`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    await page.goto(`${origin}/broken`);
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Máy chủ tạm thời gặp lỗi');
    assert.equal(await page.locator('#retryConnection').count(), 1);
    await page.goto(`${origin}/slow`, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Kết nối quá lâu');

    await context.setOffline(true);
    await page.goto(`${origin}/healthy`);
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Thiết bị đang mất mạng');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await context.setOffline(false);
    await Promise.all([
      page.waitForNavigation(),
      page.locator('#retryConnection').click()
    ]);
    assert.equal(await page.locator('body').textContent(), 'Ready');
    console.log('PASS: mobile viewport, offline cached script, timeout, HTTP 503, retry under CSP.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
