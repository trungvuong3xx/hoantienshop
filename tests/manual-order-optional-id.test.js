process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';
const assert = require('node:assert/strict');
const dbService = require('../src/services/dbService');
const app = require('../server');

(async () => {
  const db = dbService.ensureDbLoaded();
  const admin = db.users.find(user => user.role === 'admin');
  assert.ok(admin);
  db.settings.cashbackPercent = 70;
  db.settings.taxDeductPercent = 10;
  await dbService.saveDb(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/admin/orders`;
    async function post(body) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dbService.createToken(admin)}` },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    }
    const input = { platform: 'tiktok', userCode: admin.code, totalCommission: 25000, status: 'pending' };
    const first = await post(input);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.order.orderSn, /^MANUAL-/);
    assert.equal(first.body.order.userId, admin.id);
    assert.equal(first.body.order.userCashbackAmount, 15750);
    const second = await post({ ...input, orderSn: '   ' });
    assert.equal(second.status, 200);
    assert.notEqual(first.body.order.id, second.body.order.id);
    const updated = await post({ id: first.body.order.id, status: 'approved' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.order.orderSn, first.body.order.orderSn);
    assert.equal(updated.body.order.platform, 'tiktok');
    assert.equal(updated.body.order.status, 'approved');
    const named = await post({ ...input, orderSn: 'TT-EXPLICIT-001' });
    assert.equal(named.status, 200);
    const namedAgain = await post({ ...input, orderSn: 'TT-EXPLICIT-001' });
    assert.equal(namedAgain.body.order.id, named.body.order.id);
    assert.equal((await post({ ...input, orderSn: 'x' })).status, 400);
    assert.equal((await post({ id: 'missing-order', status: 'pending' })).status, 404);
    console.log('PASS: optional/blank codes, distinct manual orders, customer cashback, stable edits, explicit upsert and validation.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
