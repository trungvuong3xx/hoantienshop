// Explicit browser suite; uses a disposable local JSON fixture, never .env or providers.
const assert = require('assert/strict');
const { fork, spawnSync } = require('child_process');
const path = require('path');
if (process.env.WITHDRAW_UI_WORKER === '1') {
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_URL = '';
  const logger = require('../src/utils/logger');
  for (const key of ['log', 'logEnter', 'logLeave', 'warning', 'error']) logger[key] = () => {};
  const d = require('../src/services/dbService');
  const db = d.ensureDbLoaded();
  db.users.push({ id: 'withdraw-ui', code: 'WDUI', name: 'Audit user', phone: '0900000123', role: 'user', tokenVersion: 1, passwordHash: d.hashPassword('FixtureOnly!123') });
  d.appendLedgerEntry('withdraw-ui', 'admin_adjustment', 100000, 'ui-fixture-credit');
  d.recalculateUserWallet('withdraw-ui');
  const server = require('../server').listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', () => server.close(() => process.disconnect()));
} else {
  (async () => {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase())));
    const child = fork(__filename, [], { env: { ...env, NODE_ENV: 'test', WITHDRAW_UI_WORKER: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let browser;
    try {
      const { port } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Fixture exited: ' + code))); });
      const base = 'http://127.0.0.1:' + port;
      browser = await chromium.launch({ headless: true, executablePath: process.env.AUDIT_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#openLoginBtn').click();
      await page.locator('#loginIdentifier').fill('0900000123');
      await page.locator('#loginPassword').fill('FixtureOnly!123');
      await page.locator('#doLoginBtn').click();
      await page.locator('#authModal').waitFor({ state: 'hidden' });
      await page.locator('[data-nav="wallet"]:visible').first().click();
      await page.locator('#wdBankNameChoice').click();
      await page.locator('.app-choice-search').fill('MBBank');
      assert.equal(await page.locator('.app-choice-option').count(), 1);
      assert.equal(await page.locator('.app-choice-option').textContent(), 'MBBank');
      await page.locator('.app-choice-option').click();
      assert.equal(await page.locator('#wdBankName').inputValue(), 'MBBank');
      assert.equal(await page.locator('#wdBankNameChoice').textContent(), 'MBBank');
      await page.locator('#wdBankNameChoice').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.app-choice-dialog').isVisible(), false);
      assert.equal(await page.locator('select:visible').count(), 0);
      console.log('PASS: app bank picker search, clean labels, selection, Escape and no native selects');
      await page.locator('#wdBankAccount').fill('12345678');
      await page.locator('#wdBankOwner').fill('AUDIT USER');
      await page.locator('#withdrawAmountInput').fill('50000');
      assert.equal(await page.locator('#wdCurrentPassword').isVisible(), true);
      assert.equal(await page.locator('#wdCurrentPassword').getAttribute('required'), '');
      await page.locator('#wdCurrentPassword').fill('wrong-password');
      const requests = [], outcomes = [];
      let loseNextResponse = false;
      await page.route('**/api/user/withdraw', async route => {
        requests.push(route.request().headers()['idempotency-key']);
        const response = await route.fetch();
        outcomes.push({ status: response.status(), body: await response.json() });
        if (loseNextResponse) { loseNextResponse = false; await route.abort('failed'); }
        else await route.fulfill({ response });
      });
      const ready = () => page.waitForFunction(() => !document.getElementById('submitWithdrawBtn').disabled);
      // Enter then cancel must not dispatch a withdrawal.
      await page.locator('#wdCurrentPassword').press('Enter');
      await page.locator('#confirmModalCancelBtn').click(); await ready();
      assert.equal(requests.length, 0);
      await page.evaluate(() => {
        window.auditOriginalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key.startsWith('hts_withdraw_intents_')) throw new Error('fixture storage denied');
          return window.auditOriginalSetItem.call(this, key, value);
        };
      });
      await page.locator('#submitWithdrawBtn').click();
      await page.locator('#confirmModalOkBtn').click(); await ready();
      assert.equal(requests.length, 0);
      await page.evaluate(() => { Storage.prototype.setItem = window.auditOriginalSetItem; delete window.auditOriginalSetItem; });
      console.log('PASS: unavailable intent storage blocks dispatch and releases the submit lock');
      // Wrong password remains retryable, and repeated submit while confirming is ignored.
      await page.locator('#submitWithdrawBtn').click();
      await page.locator('#withdrawFormBox').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      await page.locator('#confirmModalOkBtn').click(); await ready();
      assert.equal(requests.length, 1); assert.equal(outcomes[0].status, 403);
      await page.locator('#wdCurrentPassword').fill('FixtureOnly!123');
      await page.locator('#submitWithdrawBtn').click();
      await page.locator('#confirmModalOkBtn').click(); await ready();
      assert.equal(requests.length, 2); assert.equal(outcomes[1].status, 200);
      assert.equal(requests[0], requests[1]);
      let state = await (await context.request.get(base + '/api/user/me')).json();
      assert.equal(state.withdrawals.length, 1); assert.equal(state.user.balanceAvailable, 50000);
      console.log('PASS: first bank password, Enter/cancel, duplicate submit guard and password retry');
      // Commit the last 50k, lose its response, reload and retry with zero available balance.
      await page.locator('#withdrawAmountInput').fill('50000');
      loseNextResponse = true;
      await page.locator('#submitWithdrawBtn').click();
      await page.locator('#confirmModalOkBtn').click(); await ready();
      assert.equal(requests.length, 3); assert.equal(outcomes[2].status, 200);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('wdBankAccount').value === '12345678');
      await page.locator('#withdrawAmountInput').fill('50000');
      await page.locator('#withdrawAmountInput').press('Enter');
      await page.locator('#confirmModalOkBtn').click(); await ready();
      assert.equal(requests.length, 4); assert.equal(outcomes[3].status, 200);
      assert.equal(requests[2], requests[3]);
      assert.equal(outcomes[2].body.withdrawal.id, outcomes[3].body.withdrawal.id);
      state = await (await context.request.get(base + '/api/user/me')).json();
      assert.equal(state.withdrawals.length, 2); assert.equal(state.user.balanceAvailable, 0);
      assert.equal(state.ledger.filter(e => e.type === 'withdrawal_lock').length, 2);
      assert.equal(await page.evaluate(() => Object.entries(sessionStorage).some(([k, v]) => k.startsWith('hts_withdraw_intents_') && v.includes('FixtureOnly!123'))), false);
      assert.deepEqual(errors, []);
      console.log('PASS: lost response + reload + retry at zero balance reuses key and does not debit twice');
      for (const width of [360, 375, 390, 412, 430, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const view of ['home', 'orders', 'wallet', 'account', 'guide', 'terms']) {
          if (view === 'terms') await page.locator('[data-nav="account"]:visible').first().click();
          await page.locator(`[data-nav="${view}"]:visible`).first().click();
          await page.locator(`#view-${view}.active`).waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${view} overflows at ${width}px`);
        }
        await page.evaluate(() => showToast('Kiểm tra thông báo dài trên màn hình điện thoại: thao tác đã được ghi nhận.'));
        const toast = page.locator('.toast:visible').last();
        await toast.waitFor();
        const bounds = await toast.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `toast clipped at ${width}px`);
        if (width < 640) {
          await page.locator('[data-nav="wallet"]:visible').first().click();
          assert.ok((await page.locator('#btnMaxWithdraw').boundingBox()).height >= 44);
          await page.locator('[data-nav="account"]:visible').first().click();
          assert.ok((await page.locator('#copyAccountCodeBtn').boundingBox()).height >= 44);
        }
      }
      assert.deepEqual(errors, []);
      console.log('PASS: six viewports, six navigable views, toast bounds and mobile touch targets');
      await page.locator('[data-nav="home"]:visible').first().click();
      await page.route('**/api/preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture provider unavailable' }) }));
      await page.locator('#productUrlInput').fill('https://shopee.vn/product/123/456');
      await page.locator('#instantPreviewCard').filter({ hasText: 'Chưa tải được thông tin sản phẩm' }).waitFor();
      assert.equal(await page.locator('#instantPreviewArea').isVisible(), true);
      await page.locator('#clearInputBtn').click();
      assert.equal(await page.locator('#instantPreviewArea').isVisible(), false);
      console.log('PASS: preview API failure is visible and clearing input resets the error');
      const disabled = spawnSync(process.execPath, [path.join(__dirname, '../scripts/clean_test_data.js')], { env: { ...env, DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/never-connect' }, encoding: 'utf8', timeout: 3000 });
      assert.equal(disabled.status, 1); assert.match(disabled.stderr, /DISABLED/);
      console.log('PASS: obsolete cleanup script exits nonzero without loading app or connecting to database');
    } finally {
      if (browser) await browser.close();
      if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.send('stop'); });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
