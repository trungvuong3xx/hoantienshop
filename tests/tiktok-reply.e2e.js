/* global window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PWA_TEST_CHANNEL ? { channel: process.env.PWA_TEST_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const start = html.indexOf('<details class="admin-collapse-panel" id="tiktokReplyPanel">');
    const panel = html.slice(start, html.indexOf('</details>', start) + '</details>'.length);
    assert.ok(start >= 0);
    await page.setContent(`<html lang="vi"><body>${panel}</body></html>`);
    await page.addStyleTag({ path: path.join(__dirname, '../public/styles.css') });
    await page.evaluate(() => { window.copyText = text => { window.copiedReply = text; }; });
    await page.addScriptTag({ path: path.join(__dirname, '../public/tiktokReply.js') });
    await page.locator('summary').click();
    const link = 'https://vt.tiktok.com/ZS9fTJXVguGEL-9gSmU/?test=a%2Fb';
    const submit = page.getByRole('button', { name: 'Tạo mẫu', exact: true });
    const copy = page.locator('#tiktokReplyCopy');
    const output = page.locator('#tiktokReplyOutput');
    await submit.click();
    assert.match(await page.locator('#tiktokReplyStatus').textContent(), /https/);
    assert.equal(await copy.isDisabled(), true);
    await page.locator('#tiktokReplyLink').fill(link);
    await submit.click();
    assert.match(await page.locator('#tiktokReplyStatus').textContent(), /Nhập hoa hồng/);
    await page.locator('#tiktokReplyCommission').fill('25000');
    await submit.click();
    const message = await output.inputValue();
    assert.ok(message.includes(link));
    assert.ok(message.includes('15.750đ'));
    assert.ok(!message.includes('30%'));
    await copy.click();
    assert.equal(await page.evaluate(() => window.copiedReply), message);
    await page.locator('#tiktokReplyCommission').fill('10000');
    assert.equal(await output.inputValue(), '');
    assert.equal(await copy.isDisabled(), true);
    await submit.click();
    assert.ok((await output.inputValue()).includes('6.300đ'));
    await page.locator('#tiktokReplyCommission').fill('-1');
    await submit.click();
    assert.equal(await copy.isDisabled(), true);
    await page.locator('#tiktokReplyCommission').fill('0');
    await submit.click();
    assert.ok((await output.inputValue()).includes('0đ'));
    await page.locator('#tiktokReplyLink').fill('javascript:alert(1)');
    await submit.click();
    assert.equal(await copy.isDisabled(), true);
    const bounds = await page.locator('#tiktokReplyPanel').boundingBox();
    assert.ok(bounds.width <= 390);
    console.log('PASS: TikTok reply calculation, exact link, copy, stale output clearing, invalid inputs and mobile width.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
