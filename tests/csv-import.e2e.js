const assert = require('assert/strict');
const { fork } = require('child_process');
const { buildCsv, sample } = require('./test_csv_import');
if (process.env.CSV_UI_WORKER === '1') {
  process.env.NODE_ENV = 'test'; process.env.TEST_DATABASE_URL = '';
  process.env.ADMIN_PHONE = '0900000111'; process.env.ADMIN_PASSWORD = 'CsvFixture!123';
  const logger = require('../src/utils/logger');
  for (const key of ['log', 'logEnter', 'logLeave', 'warning', 'error']) logger[key] = () => {};
  const d = require('../src/services/dbService'); const db = d.ensureDbLoaded();
  db.users.push({ id: 'csv-user', code: 'CSVUSER', role: 'user', tokenVersion: 1, passwordHash: d.hashPassword('CsvFixture!123') });
  db.clicks.push({ clickId: 'CSVTRACK', userId: 'csv-user', userCode: 'CSVUSER', platform: 'shopee', affiliateUrl: 'https://shopee.vn/product/1/2', createdAt: new Date().toISOString() });
  d.saveDb(db).then(() => {
    const server = require('../server').listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('message', message => {
      if (message === 'stop') server.close(() => process.disconnect());
      else if (message === 'state') {
        const state = d.ensureDbLoaded();
        process.send({ state: { orders: state.orders.length, balance: state.users.find(u => u.id === 'csv-user').balanceAvailable || 0, entries: state.ledger.filter(e => e.userId === 'csv-user').length } });
      }
    });
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  (async () => {
    const { chromium } = require('playwright');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].includes(key.toUpperCase())));
    const child = fork(__filename, [], { env: { ...env, NODE_ENV: 'test', CSV_UI_WORKER: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let browser;
    try {
      const { port } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Fixture exited: ' + code))); });
      const base = 'http://127.0.0.1:' + port;
      const state = () => new Promise(resolve => { child.once('message', msg => resolve(msg.state)); child.send('state'); });
      browser = await chromium.launch({ headless: true, executablePath: process.env.AUDIT_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base); await page.locator('#openLoginBtn').click();
      await page.locator('#loginIdentifier').fill('0900000111'); await page.locator('#loginPassword').fill('CsvFixture!123');
      await page.locator('#doLoginBtn').click(); await page.locator('#authModal').waitFor({ state: 'hidden' });
      await page.locator('[data-nav="admin"]:visible').first().click();
      const upload = async (text, minute, approve = true) => {
        await page.locator('#admCsvInput').setInputFiles({ name: `AffiliateCommissionReport_2026111611${minute}.csv`, mimeType: 'text/csv', buffer: Buffer.from(text) });
        await page.locator('#confirmModalOkBtn').waitFor({ state: 'visible' });
        const response = approve ? page.waitForResponse(r => r.url().endsWith('/api/admin/import-orders')) : null;
        await page.locator(approve ? '#confirmModalOkBtn' : '#confirmModalCancelBtn').click();
        const res = response ? await response : null;
        await page.waitForFunction(() => !document.getElementById('admCsvInput').disabled);
        if (res) { assert.equal(res.status(), 200); return res.json(); }
      };
      await upload(buildCsv([sample()]), '33', false);
      assert.equal((await state()).orders, 0);
      await upload(buildCsv([sample()]), '33');
      assert.equal((await state()).balance, 0);
      const completed = sample({ 'Trạng thái đặt hàng': 'Hoàn thành', 'Trạng thái sản phẩm liên kết': 'Hoàn thành', 'Tổng hoa hồng đơn hàng(₫)': '10000', 'Tên Item': 'Test, "quoted"\nsecond line' });
      const multi = buildCsv([completed, { ...completed, 'Item id': 'OTHER_ITEM' }]);
      assert.equal((await upload(multi, '34')).importedCount, 1);
      const credited = await state(); assert.equal(credited.balance, 6300); assert.equal(credited.orders, 1);
      await upload(multi, '34'); assert.deepEqual(await state(), credited);
      await upload(buildCsv([sample()]), '35'); assert.equal((await state()).balance, 0);
      const stale = await upload(multi, '34'); assert.equal(stale.importedCount, 0); assert.ok(stale.errors.length);
      assert.equal((await state()).balance, 0);
      await page.locator('#admCsvInput').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(buildCsv([{ ...completed, 'Tổng hoa hồng đơn hàng(₫)': '10oops' }])) });
      await page.locator('#toast').filter({ hasText: 'không hợp lệ' }).waitFor();
      assert.equal(await page.locator('#confirmModal').isVisible(), false);
      assert.equal((await state()).balance, 0); assert.deepEqual(errors, []);
      console.log('PASS: real file-input parser, confirmation/cancel, multi-item dedup, repeat import, cancellation, stale replay and invalid money');
      // Commit the last batch, lose its response, then import the identical file again.
      const batchRows = Array.from({ length: 501 }, (_, i) => ({ ...completed, 'ID đơn hàng': 'CSV_BATCH_' + i }));
      let loseResponse = true;
      await page.route('**/api/admin/import-orders', async route => {
        const response = await route.fetch();
        if (loseResponse && route.request().postDataJSON().rows.length === 1) {
          loseResponse = false;
          await route.abort('failed');
        } else await route.fulfill({ response });
      });
      await upload(buildCsv(batchRows), '36');
      const report = await page.locator('#csvImportReport').textContent();
      assert.match(report, /Đã xác nhận nhập 500 đơn/);
      assert.match(report, /1 đơn ở lô hiện tại chưa rõ kết quả/);
      const committed = await state();
      assert.equal(committed.balance, 501 * 6300);
      assert.equal(committed.orders, 502);
      await upload(buildCsv(batchRows), '36');
      assert.deepEqual(await state(), committed, 'Retry must not double-credit committed batches');
      assert.match(await page.locator('#csvImportReport').textContent(), /501\/501/);
      assert.deepEqual(errors, []);
      console.log('PASS: 501-order import, committed batch with lost response, visible partial result and safe manual retry');
    } finally {
      if (browser) await browser.close();
      if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.send('stop'); });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
