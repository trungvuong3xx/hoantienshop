/* global window, document, navigator */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext();
    await context.setOffline(true);
    const page = await context.newPage();
    const remoteRequests = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.goto(pathToFileURL(path.join(__dirname, '../tools/tiktok-reply/index.html')).href);
    const generate = page.getByRole('button', { name: 'Tạo tin nhắn ↗' });
    const copy = page.locator('#copyButton');
    await generate.click();
    assert.match(await page.locator('#formStatus').textContent(), /https/);
    const link = 'https://vt.tiktok.com/ZS9fTJXVguGEL-9gSmU/?tag=a%2Fb';
    await page.locator('#affiliateLink').fill(link);
    for (const amount of ['25000', '25.000', '25,000']) {
      await page.locator('#commission').fill(amount);
      await generate.click();
      assert.equal(await page.locator('#cashback').textContent(), '15.750đ');
      assert.equal(await page.locator('#tax').textContent(), '2.500đ');
      assert.equal(await page.locator('#adminShare').textContent(), '6.750đ');
      assert.ok((await page.locator('#replyOutput').inputValue()).includes(link));
    }
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } }); });
    await copy.click();
    assert.equal(await page.evaluate(() => window.copied), await page.locator('#replyOutput').inputValue());
    assert.ok(!(await page.locator('#replyOutput').inputValue()).includes('6.750'));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
      document.execCommand = () => false;
    });
    await copy.click();
    assert.match(await page.locator('#copyStatus').textContent(), /Ctrl\+C/);
    for (const bad of ['', '-5', '25.50', '25%', '1e5']) {
      await page.locator('#commission').fill(bad);
      assert.equal(await copy.isDisabled(), true);
      await generate.click();
      assert.equal(await page.locator('#replyOutput').inputValue(), '');
    }
    await page.locator('#commission').fill('25000');
    await page.locator('#affiliateLink').fill('javascript:alert(1)');
    await generate.click();
    assert.equal(await copy.isDisabled(), true);
    await page.locator('#affiliateLink').fill(link);
    await generate.click();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    if (process.env.TIKTOK_REPLY_SCREENSHOT) await page.screenshot({ path: process.env.TIKTOK_REPLY_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Làm mới' }).click();
    assert.equal(await page.locator('#affiliateLink').inputValue(), '');
    assert.equal(await copy.isDisabled(), true);
    assert.deepEqual(remoteRequests, []);
    console.log('PASS: standalone file offline; calculation, input validation, clipboard/fallback, reset, responsive widths, no network requests.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
