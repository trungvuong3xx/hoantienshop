process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('node:assert/strict');
const dbService = require('../src/services/dbService');
const app = require('../server');

(async () => {
  console.log('--- Running Phase 3 Mobile-First UX & API Verification ---');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let createdUserId = null;
  const seededOrderIds = [];

  try {
    // 1. Register a test member
    const phone = `09${String(Date.now()).slice(-8)}`;
    const initPassword = 'OldPassword123!';
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ name: 'Phase3 Member', phone, password: initPassword })
    });
    assert.equal(regRes.status, 200);
    const oldCookie = (regRes.headers.get('set-cookie') || '').match(/hts_auth=[^;]+/)?.[0];
    assert.ok(oldCookie, 'Must receive initial hts_auth cookie');
    const regData = await regRes.json();
    createdUserId = regData.user.id;
    const userCode = regData.user.code;

    // 2. Seed 14 orders across 2 pages (6 pending, 5 approved, 3 cancelled) where approved orders have older timestamps (Page 2)
    const db = dbService.ensureDbLoaded();
    const now = Date.now();
    const statuses = [
      ...Array(6).fill('pending'),
      ...Array(3).fill('cancelled'),
      ...Array(5).fill('approved')
    ];
    statuses.forEach((st, idx) => {
      const ordId = `ord_p3_${now}_${idx}`;
      seededOrderIds.push(ordId);
      db.orders.push({
        id: ordId,
        orderSn: `P3SN_${idx}_${String(now).slice(-5)}`,
        platform: idx % 2 === 0 ? 'shopee' : 'tiktok',
        userId: createdUserId,
        userCode,
        productName: idx === 13 ? 'Tai nghe Bluetooth Đặc Biệt' : `Sản phẩm test #${idx}`,
        orderAmount: 150000,
        grossCommission: 15000,
        netCommission: 13500,
        totalCommission: 15000,
        cashbackRate: 70,
        userCashbackAmount: st === 'cancelled' ? 0 : 9450,
        status: st,
        createdAt: new Date(now - idx * 60000).toISOString(),
        updatedAt: new Date(now - idx * 60000).toISOString()
      });
    });
    dbService.recalculateUserWallet(createdUserId);
    // Top up balance so user has >= 50k withdrawable
    dbService.appendLedgerEntry(createdUserId, 'admin_adjustment', 60000, 'Phase3 withdraw test credit');
    dbService.recalculateUserWallet(createdUserId);
    await dbService.saveDb(db);

    // 3. [HIGH-03] Verify global orderStatusCounts & server-side orderStatus filter across pages
    const page1Res = await fetch(`${baseUrl}/api/user/me?orderPage=1&orderLimit=10`, {
      headers: { Cookie: oldCookie }
    });
    assert.equal(page1Res.status, 200);
    const page1Data = await page1Res.json();
    assert.equal(page1Data.orders.length, 10, 'Page 1 returns 10 orders');
    assert.deepEqual(
      page1Data.orderStatusCounts,
      { all: 14, pending: 6, approved: 5, cancelled: 3 },
      'orderStatusCounts must reflect all 14 orders across all pages, not just page 1'
    );

    const approvedFilterRes = await fetch(
      `${baseUrl}/api/user/me?orderPage=1&orderLimit=10&orderStatus=approved`,
      { headers: { Cookie: oldCookie } }
    );
    const approvedData = await approvedFilterRes.json();
    assert.equal(approvedData.orders.length, 5, 'Server-side approved filter must return all 5 approved orders');
    assert.ok(approvedData.orders.every((o) => o.status === 'approved'));

    const searchRes = await fetch(
      `${baseUrl}/api/user/me?orderPage=1&orderLimit=10&q=${encodeURIComponent('Bluetooth Đặc Biệt')}`,
      { headers: { Cookie: oldCookie } }
    );
    const searchData = await searchRes.json();
    assert.deepEqual(
      searchData.orderStatusCounts,
      { all: 1, pending: 0, approved: 1, cancelled: 0 },
      'orderStatusCounts must scope accurately to search query q'
    );

    // 4. [HIGH-04] Verify bankName change with same phone-number account requires password on /api/user/withdraw
    const saveProfileRes = await fetch(`${baseUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: oldCookie
      },
      body: JSON.stringify({
        name: 'Phase3 Updated Name',
        bankName: 'Vietcombank',
        bankAccount: phone,
        bankOwner: 'NGUYEN VAN P',
        currentPassword: initPassword
      })
    });
    assert.equal(saveProfileRes.status, 200, 'Saving initial bank profile with password must succeed');

    const switchToMomoNoPwdRes = await fetch(`${baseUrl}/api/user/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: oldCookie
      },
      body: JSON.stringify({
        amount: 50000,
        method: 'momo',
        bankName: 'MoMo',
        bankAccount: phone,
        bankOwner: 'NGUYEN VAN P'
      })
    });
    assert.equal(
      switchToMomoNoPwdRes.status,
      403,
      'Switching bankName (Vietcombank -> MoMo) with identical account number must still require password'
    );

    // 5. [MED-01] Verify POST /api/user/change-password validation, session rotation & old cookie revocation
    const wrongOldPwdRes = await fetch(`${baseUrl}/api/user/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: oldCookie
      },
      body: JSON.stringify({ currentPassword: 'WrongPassword!', newPassword: 'NewPassword456!' })
    });
    assert.equal(wrongOldPwdRes.status, 400, 'Wrong current password must return 400');

    const samePwdRes = await fetch(`${baseUrl}/api/user/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: oldCookie
      },
      body: JSON.stringify({ currentPassword: initPassword, newPassword: initPassword })
    });
    assert.equal(samePwdRes.status, 400, 'Identical new password must return 400');

    const changePwdRes = await fetch(`${baseUrl}/api/user/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: oldCookie
      },
      body: JSON.stringify({ currentPassword: initPassword, newPassword: 'NewPassword456!' })
    });
    assert.equal(changePwdRes.status, 200, 'Valid password change must return 200');
    const newCookie = (changePwdRes.headers.get('set-cookie') || '').match(/hts_auth=[^;]+/)?.[0];
    assert.ok(newCookie && newCookie !== oldCookie, 'Password change must issue rotated hts_auth cookie');

    // Old session cookie must now be rejected (401)
    const staleMeRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: oldCookie }
    });
    assert.equal(staleMeRes.status, 401, 'Old session token must be revoked after password change');

    // New session cookie must succeed (200)
    const freshMeRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: newCookie }
    });
    assert.equal(freshMeRes.status, 200, 'Rotated session cookie on current device must remain valid');

    console.log('PASS: Phase 3 backend & integration checks passed (Server status counts/filter, bank switch guard, password rotation).');
  } finally {
    const finalDb = dbService.ensureDbLoaded();
    if (createdUserId) {
      finalDb.users = finalDb.users.filter((u) => u.id !== createdUserId);
      finalDb.ledger = finalDb.ledger.filter((l) => l.userId !== createdUserId);
      finalDb.withdrawals = finalDb.withdrawals.filter((w) => w.userId !== createdUserId);
    }
    if (seededOrderIds.length > 0) {
      finalDb.orders = finalDb.orders.filter((o) => !seededOrderIds.includes(o.id));
    }
    await dbService.saveDb(finalDb);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Phase 3 test failed:', err);
  process.exitCode = 1;
});
