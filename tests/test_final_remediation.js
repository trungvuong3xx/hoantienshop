process.env.NODE_ENV = 'test';
const assert = require('assert/strict');
const fs = require('fs');
const d = require('../src/services/dbService');
const { orderKey, ledgerOrderKey } = require('../src/services/orderIdentity');
const { upsertNetworkOrder } = require('../src/services/cashbackController');
const { acceptWebhookReceipt } = require('../src/services/webhookReceiptService');

(async () => {
  const db = d.ensureDbLoaded();
  db.settings.referralBountyAmount = 0;
  const a = db.users[0], b = { ...a, id: 'second-owner', code: 'SECOND', role: 'user' };
  db.users.push(b);
  const oldOrder = { platform: 'shopee', orderSn: 'SAME_SN', userId: a.id, userCode: a.code, status: 'approved', userCashbackAmount: 6300 };
  db.orders.push(oldOrder);
  d.appendLedgerEntry(a.id, 'order_cashback', 6300, 'order_credit_SAME_SN');
  const originalEntry = structuredClone(db.ledger[0]);
  d.recalculateAllWallets({ persist: false });
  assert.equal(a.balanceAvailable, 6300);
  upsertNetworkOrder(db, { platform: 'tiktok', orderSn: 'SAME_SN', rawSubId: b.code, status: 'approved', grossCommission: 20000 });
  oldOrder.userId = b.id; // A stale userCode must not keep credit on the old owner.
  d.recalculateAllWallets({ persist: false });
  assert.equal(a.balanceAvailable, 0);
  assert.equal(b.balanceAvailable, 18900);
  assert.deepEqual(db.ledger[0], originalEntry);
  const count = db.ledger.length;
  d.recalculateAllWallets({ persist: false });
  assert.equal(db.ledger.length, count);
  assert.equal(db.ledger.filter(e => e.userId === b.id && ledgerOrderKey(e, db) === orderKey(oldOrder)).reduce((sum, e) => sum + e.amount, 0), 6300);
  assert.throws(() => d.appendLedgerEntry(b.id, 'order_cashback', 6300, originalEntry.refId), { code: 'LEDGER_REFERENCE_CONFLICT' });
  await d.saveDb(db);
  console.log('PASS: legacy credit migration, platform collision, owner transfer, immutable ledger and replay');

  let release, started;
  const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const loser = d.runWithStateContext(async () => {
    const local = d.ensureDbLoaded(); local.settings.losingMutation = true;
    started(); await wait; await d.saveDb(local);
  });
  await start;
  await d.runWithStateContext(async () => {
    const local = d.ensureDbLoaded();
    assert.equal(local.settings.losingMutation, undefined);
    local.settings.winningMutation = true; await d.saveDb(local);
  });
  release(); await assert.rejects(loser, { code: 'STATE_CONFLICT' });
  assert.equal(d.ensureDbLoaded().settings.losingMutation, undefined);
  assert.equal(d.ensureDbLoaded().settings.winningMutation, true);
  console.log('PASS: overlapping request snapshots cannot publish each other\'s uncommitted mutations');

  const rename = fs.renameSync;
  const failedState = d.ensureDbLoaded();
  try {
    d.ensureDbLoaded().settings.failedDiskMutation = true;
    fs.renameSync = () => { throw new Error('fixture disk failure'); };
    await assert.rejects(d.saveDb(d.ensureDbLoaded()), /fixture disk failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(d.ensureDbLoaded().settings.failedDiskMutation, undefined);
  await assert.rejects(d.saveDb(failedState), { code: 'CACHE_UNAVAILABLE' });
  await d.saveDb(d.ensureDbLoaded());
  console.log('PASS: local disk failure rolls cache back and later saves cannot resurrect failed changes');

  await d.runWithStateContext(async () => {
    const local = d.ensureDbLoaded();
    const event = { event_id: 'event-1', orderSn: 'receipt-order', status: 'approved', eventTime: Date.now() };
    assert.equal(await acceptWebhookReceipt(local, 'fixture', event, null, 'approved'), true);
    await d.saveDb(local);
    assert.equal(await acceptWebhookReceipt(local, 'fixture', event, null, 'approved'), false);
    await assert.rejects(acceptWebhookReceipt(local, 'fixture', { ...event, status: 'cancelled' }, null, 'cancelled'), { status: 409 });
    await assert.rejects(acceptWebhookReceipt(local, 'fixture', { orderSn: 'new', status: 'approved' }, { status: 'cancelled' }, 'approved'), { status: 409 });
  });
  console.log('PASS: durable webhook replay, event ID payload conflict and undated terminal transition blocked');

  const fetchOriginal = global.fetch;
  try {
    const { fetchShopeeConversionReport } = require('../src/services/shopeeService');
    let requests = 0;
    global.fetch = async (_url, init) => {
      const query = JSON.parse(init.body).query; requests++;
      if (requests === 2) assert.match(query, /scrollId: "next"/);
      return { ok: true, json: async () => ({ data: { conversionReport: { nodes: [{ conversionId: requests }], pageInfo: { hasNextPage: requests === 1, scrollId: 'next' } } } }) };
    };
    assert.equal((await fetchShopeeConversionReport('fixture', 'fixture', 1)).length, 2);
    requests = 0;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { conversionReport: { nodes: [{}], pageInfo: { hasNextPage: true, scrollId: 'loop' } } } }) });
    await assert.rejects(fetchShopeeConversionReport('fixture', 'fixture'), /cursor/);
    const { fetchAccessTradeOrders } = require('../src/services/tiktokService');
    global.fetch = async input => {
      const url = new URL(input); assert.equal(url.pathname, '/v1/order-list');
      const page = Number(url.searchParams.get('page')); requests++;
      return { ok: true, json: async () => ({ total: 2, data: [{ order_id: 'row-' + page, merchant: 'tiktok' }] }) };
    };
    assert.equal((await fetchAccessTradeOrders('fixture')).length, 2);
    global.fetch = async () => ({ ok: true, json: async () => ({ total: 2, data: [{ order_id: 'same', merchant: 'tiktok' }] }) });
    await assert.rejects(fetchAccessTradeOrders('fixture'), /lặp trang/);
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    await assert.rejects(fetchAccessTradeOrders('fixture'), /data\/total/);
  } finally { global.fetch = fetchOriginal; }
  console.log('PASS: provider pagination reads subsequent pages and fails closed on repeated pages/missing metadata');

  const current = d.ensureDbLoaded();
  for (let i = 0; i < 35; i++) {
    const entry = d.appendLedgerEntry(b.id, 'admin_adjustment', 1, 'history-' + i, 'history-' + i);
    entry.createdAt = new Date(Date.now() + i * 1000 + 1000).toISOString();
  }
  await d.saveDb(current);
  const app = require('express')();
  require('../src/services/cashbackController').registerCashbackRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const headers = { Authorization: 'Bearer ' + d.createToken(current.users.find(u => u.id === b.id)) };
    const first = await (await fetch(base + '/api/user/me?ledgerPage=1', { headers })).json();
    const second = await (await fetch(base + '/api/user/me?ledgerPage=2', { headers })).json();
    assert.equal(first.ledger.length, 30); assert.equal(first.ledger[0].note, 'history-34');
    assert.equal(first.ledgerPagination.totalPages, 2);
    const ids = [...first.ledger, ...second.ledger].map(e => e.id);
    assert.equal(new Set(ids).size, first.ledgerPagination.total);
    assert.equal(ids.length, first.ledgerPagination.total);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: wallet history API returns newest entries first and pagination exposes all entries without duplicates');
})().catch(error => { console.error(error); process.exitCode = 1; });
