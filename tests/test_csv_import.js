process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const csv = require('../public/csvImport');
const fixture = require('./fixtures/shopee-commission-schema.json');

function buildCsv(rows, delimiter = ',') {
  const quote = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '\uFEFF' + [fixture.headers, ...rows.map(r => fixture.headers.map(h => r[h] ?? ''))].map(r => r.map(quote).join(delimiter)).join('\r\n');
}
function sample(overrides = {}) { return { ...fixture.sample, ...overrides }; }

async function run() {
  const result = csv.parse(buildCsv([sample()]), 'AffiliateCommissionReport_202611161133.csv');
  assert.equal(result.rows[0].status, 'cancelled');
  assert.equal(result.rows[0].orderAmount, 209000);
  assert.equal(result.rows[0].totalCommission, 0);
  assert.equal(result.rows[0].userCode, 'CSVTRACK');
  const rawPath = process.env.CSV_SAMPLE_PATH;
  if (rawPath) {
    const raw = fs.readFileSync(rawPath), hash = crypto.createHash('sha256').update(raw).digest('hex');
    const actual = csv.parse(raw.toString('utf8'), require('path').basename(rawPath));
    assert.equal(actual.sourceRows, 1); assert.equal(actual.rows[0].status, 'cancelled');
    assert.equal(actual.rows[0].orderAmount, 209000); assert.equal(actual.rows[0].totalCommission, 0);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex'), hash);
    console.log('PASS: original CSV read correctly; source SHA256 unchanged: ' + hash);
  }
  const completed = sample({ 'Trạng thái đặt hàng': 'Hoàn thành', 'Trạng thái sản phẩm liên kết': 'Hoàn thành', 'Tổng hoa hồng đơn hàng(₫)': '10,000.00', 'Tên Item': 'Sản phẩm, "đặc biệt"\nxuống dòng' });
  const secondItem = { ...completed, 'Item id': 'FIXTURE_ITEM_2', 'Tên Item': 'Sản phẩm thứ hai' };
  const multi = csv.parse(buildCsv([completed, secondItem, completed]));
  assert.equal(multi.rows.length, 1); assert.equal(multi.rows[0].totalCommission, 10000);
  assert.equal(multi.rows[0].productName, completed['Tên Item']); assert.equal(multi.duplicateRows, 2);
  assert.equal(csv.parse(buildCsv([completed], ';')).rows[0].totalCommission, 10000);
  for (const overrides of [
    { 'Tổng hoa hồng đơn hàng(₫)': '123bad' }, { 'Tổng hoa hồng đơn hàng(₫)': '-10' },
    { 'Trạng thái đặt hàng': 'không xác định' }, { 'Phí quản lý MCN(₫)': '100' },
    { 'Trạng thái sản phẩm liên kết': 'Đã hủy' }
  ]) assert.throws(() => csv.parse(buildCsv([{ ...completed, ...overrides }])));
  assert.throws(() => csv.parse(buildCsv([completed, { ...secondItem, 'Tổng hoa hồng đơn hàng(₫)': '20000' }])), /khác nhau/);
  assert.throws(() => csv.parse('order_id,status,total commission,order amount\nBAD,approved,100,200,EXTRA'), /số cột/);
  assert.throws(() => csv.parse('order_id,status,total commission,order amount\nBAD,approved,"100,200'), /nháy đóng/);
  assert.equal(csv.reportTime('AffiliateCommissionReport_202611161133.csv'), Date.parse('2026-11-16T11:33:00+07:00'));
  const shopeeFraction = sample({ 'Trạng thái đặt hàng': 'Đang chờ xử lý', 'Trạng thái sản phẩm liên kết': 'Đang chờ xử lý', 'Tổng hoa hồng đơn hàng(₫)': '1363.275', 'Giá trị đơn hàng (₫)': '54531' });
  const shopeeShortFraction = sample({ 'ID đơn hàng': 'CSV_SHORT_FRACTION', 'Trạng thái đặt hàng': 'Đang chờ xử lý', 'Trạng thái sản phẩm liên kết': 'Đang chờ xử lý', 'Tổng hoa hồng đơn hàng(₫)': '308.625', 'Giá trị đơn hàng (₫)': '12345' });
  const shopeeParsed = csv.parse(buildCsv([shopeeFraction, shopeeShortFraction]), 'AffiliateCommissionReport_202611161133.csv');
  assert.equal(shopeeParsed.rows[0].status, 'pending');
  assert.equal(shopeeParsed.rows[0].totalCommission, 1363);
  assert.equal(shopeeParsed.rows[0].orderAmount, 54531);
  assert.equal(shopeeParsed.rows[1].totalCommission, 309, '3-digit integer + 3-digit decimal in Shopee CSV must not be multiplied by 1000');
  const vnThousands = csv.parse(buildCsv([sample({ 'Tổng hoa hồng đơn hàng(₫)': '1.000.000', 'Giá trị đơn hàng (₫)': '2.500.000' })]));
  assert.equal(vnThousands.rows[0].totalCommission, 1000000);
  assert.equal(vnThousands.rows[0].orderAmount, 2500000);
  console.log('PASS: exact 48-column schema, money, BOM, quotes/newlines, duplicate items and invalid/conflicting rows');

  const d = require('../src/services/dbService');
  await d.initPostgresIfConfigured();
  const db = d.ensureDbLoaded(); db.settings.referralBountyAmount = 0;
  db.users.push({ id: 'csv-user', code: 'CSVUSER', name: 'CSV fixture', phone: '0900000222', role: 'user', tokenVersion: 1, passwordHash: d.hashPassword('Fixture!123') });
  db.clicks.push({ clickId: 'CSVTRACK', userId: 'csv-user', userCode: 'CSVUSER', platform: 'shopee', affiliateUrl: 'https://shopee.vn/product/1/2', createdAt: new Date().toISOString() });
  await d.saveDb(db);
  if (d.getPgPool()) {
    await d.getPgPool().query("UPDATE clicks SET created_at = NOW() - INTERVAL '120 days' WHERE click_id = $1", ['CSVTRACK']);
    await d.reloadStateFromPostgres({ strict: true });
    assert.ok(!d.ensureDbLoaded().clicks.some(c => c.clickId === 'CSVTRACK'));
    assert.equal(await d.findClickById('CSVTRACK'), null, 'Expired public links must stay expired');
    assert.equal((await d.findClickById('CSVTRACK', { forAttribution: true })).userId, 'csv-user');
    assert.equal(await d.findClickById('CSVTRACK'), null, 'Attribution cache must not revive redirects');
    assert.equal(await d.findClickById('MISSING_TRACK', { forAttribution: true }), null);
    await d.reloadStateFromPostgres({ strict: true });
    console.log('PASS: 120-day attribution resolves from PostgreSQL while public redirect stays expired');
  }
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = d.createToken(db.users[0]);
  const read = async () => {
    if (d.getPgPool()) await d.reloadStateFromPostgres({ strict: true });
    const current = d.ensureDbLoaded();
    return { db: current, balance: current.users.find(u => u.id === 'csv-user').balanceAvailable, ledger: current.ledger.filter(e => e.userId === 'csv-user') };
  };
  const post = async (rows, auth = token) => {
    const res = await fetch(base + '/api/admin/import-orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify({ rows }) });
    return { status: res.status, body: await res.json() };
  };
  const importReport = (row, minute) => post(csv.parse(buildCsv(Array.isArray(row) ? row : [row]), `AffiliateCommissionReport_2026111611${minute}.csv`).rows);
  try {
    const pending = { ...completed, 'Trạng thái đặt hàng': 'Chờ duyệt', 'Trạng thái sản phẩm liên kết': 'Chờ duyệt' };
    assert.equal((await importReport(pending, '33')).body.importedCount, 1);
    assert.equal((await read()).balance, 0);
    assert.equal((await importReport([completed, secondItem], '34')).body.importedCount, 1);
    assert.equal((await read()).balance, 6300);
    const approvedLedger = (await read()).ledger.length;
    assert.equal((await importReport(completed, '34')).body.importedCount, 1);
    assert.equal((await read()).ledger.length, approvedLedger);
    assert.equal((await importReport(sample(), '35')).body.importedCount, 1);
    assert.equal((await read()).balance, 0);
    const cancelledLedger = (await read()).ledger.length;
    assert.equal((await importReport(sample(), '35')).body.importedCount, 1);
    assert.equal((await read()).ledger.length, cancelledLedger);
    assert.equal((await importReport(completed, '34')).body.importedCount, 0);
    assert.equal((await read()).balance, 0);
    assert.equal((await importReport(completed, '36')).body.importedCount, 1);
    assert.equal((await read()).balance, 6300);
    assert.equal((await importReport({ ...completed, 'Tổng hoa hồng đơn hàng(₫)': '5000' }, '37')).body.importedCount, 1);
    assert.equal((await read()).balance, 3150);
    assert.equal((await importReport({ ...completed, 'Tổng hoa hồng đơn hàng(₫)': '0' }, '38')).body.importedCount, 1);
    let after = await read(); assert.equal(after.balance, 0);
    assert.equal(after.db.orders.find(o => o.orderSn === fixture.sample['ID đơn hàng']).userCashbackAmount, 0);
    const me = await fetch(base + '/api/user/me', { headers: { Authorization: 'Bearer ' + d.createToken(after.db.users.find(u => u.id === 'csv-user')) } });
    assert.equal((await me.json()).user.balanceAvailable, 0);
    const ledgerCount = after.ledger.length;
    const canonical = csv.parse(buildCsv([completed])).rows[0];
    assert.equal((await post([{ ...canonical, totalCommission: -1 }])).status, 400);
    assert.equal((await post([canonical, { ...canonical, totalCommission: 777 }])).status, 400);
    const userToken = d.createToken(after.db.users.find(u => u.id === 'csv-user'));
    assert.equal((await post([canonical], userToken)).status, 403);
    after = await read(); assert.equal(after.ledger.length, ledgerCount);
    assert.equal(after.db.orders.filter(o => o.orderSn === canonical.orderSn).length, 1);
    assert.ok(after.db.auditLogs.some(a => a.action === 'import_orders'));
    console.log('PASS: HTTP import pending/approved/cancelled, repeat, stale replay, adjustment to zero, auth and durable ledger');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (d.getPgPool()) await d.getPgPool().end();
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildCsv, sample };
