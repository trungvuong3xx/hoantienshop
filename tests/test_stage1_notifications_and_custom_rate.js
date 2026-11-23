if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  initPostgresIfConfigured,
  reloadStateFromPostgres,
  ensureDbLoaded,
  saveDb,
  hashPassword,
  createToken,
  resolveUserCashbackRate
} = require('../src/services/dbService');
const {
  registerCashbackRoutes,
  upsertNetworkOrder
} = require('../src/services/cashbackController');

async function runTests() {
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();

  const db = ensureDbLoaded();
  db.settings.cashbackPercent = 70;
  db.settings.taxDeductPercent = 10;

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const suffix = Date.now();
  const adminUser = {
    id: `usr_adm_s1_${suffix}`,
    code: `ADMS1_${suffix}`,
    name: 'Admin S1',
    phone: `0998${suffix.toString().slice(-6)}`,
    passwordHash: hashPassword('AdminPass123!'),
    role: 'admin',
    tokenVersion: 1
  };
  const userA = {
    id: `usr_a_s1_${suffix}`,
    code: `USRA_${suffix}`,
    name: 'User A',
    phone: `0911${suffix.toString().slice(-6)}`,
    passwordHash: hashPassword('UserPass123!'),
    role: 'user',
    tokenVersion: 1
  };
  const userB = {
    id: `usr_b_s1_${suffix}`,
    code: `USRB_${suffix}`,
    name: 'User B',
    phone: `0922${suffix.toString().slice(-6)}`,
    passwordHash: hashPassword('UserPass123!'),
    role: 'user',
    tokenVersion: 1
  };
  db.users.push(adminUser, userA, userB);
  await saveDb(db);

  const adminToken = createToken(adminUser);
  const tokenA = createToken(userA);
  const tokenB = createToken(userB);

  const api = async (path, opts = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  try {
    // 1. Default cashback rate
    assert.strictEqual(resolveUserCashbackRate(userA, db.settings), 70);

    // 2. Admin sets custom rate 85% for User A
    const r1 = await api('/api/admin/users/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        userId: userA.id,
        action: 'set_cashback_rate',
        customCashbackPercent: 85
      })
    });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.data.customCashbackPercent, 85);
    const liveDb = ensureDbLoaded();
    const freshUserA = liveDb.users.find((u) => u.id === userA.id);
    assert.strictEqual(resolveUserCashbackRate(freshUserA, liveDb.settings), 85);

    // Verify audit log created
    const audit = liveDb.auditLogs.find(
      (l) => l.action === 'set_cashback_rate' && l.targetId === userA.id
    );
    assert(audit, 'Audit log for set_cashback_rate must exist');

    // 3. Create order 1 -> locks 85%
    const ord1 = upsertNetworkOrder(liveDb, {
      orderSn: `ORD_S1_1_${suffix}`,
      rawSubId: userA.code,
      grossCommission: 100000,
      orderAmount: 500000,
      status: 'pending',
      platform: 'shopee'
    });
    assert.strictEqual(ord1.lockedCashbackRate, 85);
    assert.strictEqual(ord1.userCashbackAmount, Math.round(90000 * 0.85));

    // 4. Admin overrides User A rate to 50% (lower than default) and 100% (no cap)
    const rLower = await api('/api/admin/users/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        userId: userA.id,
        action: 'set_cashback_rate',
        customCashbackPercent: 50
      })
    });
    assert.strictEqual(rLower.status, 200);
    assert.strictEqual(rLower.data.customCashbackPercent, 50);

    // Existing order 1 must NOT retroactively change
    const ord1After = upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_S1_1_${suffix}`,
      rawSubId: userA.code,
      grossCommission: 100000,
      orderAmount: 500000,
      status: 'approved',
      platform: 'shopee'
    });
    assert.strictEqual(ord1After.lockedCashbackRate, 85);

    // Uncapped 100% rate allowed
    const r100 = await api('/api/admin/users/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        userId: userA.id,
        action: 'set_cashback_rate',
        customCashbackPercent: 100
      })
    });
    assert.strictEqual(r100.status, 200);
    const ord2 = upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_S1_2_${suffix}`,
      rawSubId: userA.code,
      grossCommission: 100000,
      orderAmount: 500000,
      status: 'pending',
      platform: 'tiktok'
    });
    assert.strictEqual(ord2.lockedCashbackRate, 100);
    assert.strictEqual(ord2.userCashbackAmount, 90000);

    // Reset back to default (null)
    const rReset = await api('/api/admin/users/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        userId: userA.id,
        action: 'set_cashback_rate',
        customCashbackPercent: null
      })
    });
    assert.strictEqual(rReset.status, 200);
    assert.strictEqual(
      resolveUserCashbackRate(
        ensureDbLoaded().users.find((u) => u.id === userA.id),
        ensureDbLoaded().settings
      ),
      70
    );

    // 5. Notification triggers & idempotency
    // Allow microtasks from async notifications to flush
    await new Promise((r) => setTimeout(r, 40));

    // Re-approving ord1 must NOT duplicate notification
    upsertNetworkOrder(ensureDbLoaded(), {
      orderSn: `ORD_S1_1_${suffix}`,
      rawSubId: userA.code,
      grossCommission: 100000,
      orderAmount: 500000,
      status: 'approved',
      platform: 'shopee'
    });
    await new Promise((r) => setTimeout(r, 40));

    const notifA1 = await api('/api/notifications', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(notifA1.status, 200);
    const approvedCount = notifA1.data.items.filter(
      (n) => n.dedupeKey === `order_approved:shopee:ORD_S1_1_${suffix}`
    ).length;
    assert.strictEqual(approvedCount, 1, 'Duplicate order approval must not create duplicate notification');
    assert(notifA1.data.unreadCount >= 3);

    // 6. Broadcast notification read isolation (User A reads -> User B still unread)
    const bc = await api('/api/admin/notifications/broadcast', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        title: `Sale 12/12 ${suffix}`,
        message: 'Hoàn tiền siêu tốc!'
      })
    });
    assert.strictEqual(bc.status, 200);

    const meA = await api('/api/user/me', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(meA.status, 200);
    assert(meA.data.unreadNotificationCount >= 4);

    // User A marks all read
    const markA = await api('/api/notifications/mark-read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ all: true })
    });
    assert.strictEqual(markA.status, 200);
    assert.strictEqual(markA.data.unreadCount, 0);

    // User B must STILL have the broadcast unread
    const notifB = await api('/api/notifications', {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(notifB.status, 200);
    assert.strictEqual(notifB.data.unreadCount, 1);
    assert.strictEqual(notifB.data.items[0].isRead, false);

    console.log('PASS: Stage 1 custom cashback rate (override, uncapped, locked) & notification center (dedupe, broadcast isolation)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
