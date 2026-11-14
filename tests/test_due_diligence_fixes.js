process.env.NODE_ENV = 'test';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

const {
  ensureDbLoaded,
  saveDb,
  hashPasswordAsync,
  createToken,
  recalculateUserWallet,
  appendLedgerEntry
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

const ROOT_DIR = path.resolve(__dirname, '..');
const PROD_DB_PATH = path.join(ROOT_DIR, 'data', 'db.json');
const TEST_DB_PATH = path.join(os.tmpdir(), `hoantienshop_test_db_${process.pid}.json`);

function startTestServer() {
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`
      });
    });
  });
}

async function runTests() {
  console.log('--- Running Technical Due Diligence Fixes Verification ---');
  let passed = 0;
  let serverInfo = null;

  try {
    // Prepare isolated test DB and Express server
    const db = await ensureDbLoaded();
    const adminUser = db.users.find((u) => u.role === 'admin');
    assert.ok(adminUser, 'Admin user must exist in seeded test DB');

    const initialAdminPw = 'InitialAdmin#2026';
    adminUser.passwordHash = await hashPasswordAsync(initialAdminPw);
    adminUser.tokenVersion = Number(adminUser.tokenVersion || 1);
    await saveDb(db);

    let adminToken = createToken(adminUser);
    serverInfo = await startTestServer();
    const { baseUrl } = serverInfo;

    // -------------------------------------------------------------------------
    // TEST 1 [CRIT-01]: Click retention preserves newest 5000 unshifted clicks
    // -------------------------------------------------------------------------
    {
      const savedClicksBackup = Array.isArray(db.clicks) ? [...db.clicks] : [];
      db.clicks = [];
      for (let i = 1; i <= 5005; i += 1) {
        db.clicks.unshift({
          id: `click_${i}`,
          clickId: `click_${i}`,
          platform: 'shopee',
          originalUrl: `https://shopee.vn/item-${i}`,
          affiliateUrl: `https://s.shopee.vn/item-${i}`,
          createdAt: new Date(Date.now() + i).toISOString()
        });
      }

      await saveDb(db);
      const persisted = JSON.parse(fs.readFileSync(TEST_DB_PATH, 'utf8'));
      assert.strictEqual(persisted.clicks.length, 5000, 'Persisted clicks should cap at 5000');
      assert.strictEqual(persisted.clicks[0].id, 'click_5005', 'Newest click (index 0) must be kept');
      assert.strictEqual(persisted.clicks[4999].id, 'click_6', '5000th kept click should be click_6');

      db.clicks = savedClicksBackup;
      await saveDb(db);
      console.log('✓ Test 1 [CRIT-01]: Unshifted newest 5000 clicks retained accurately');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 2 [CRIT-02]: Admin password update persists across ensureDbLoaded()
    // -------------------------------------------------------------------------
    {
      const newAdminPw = 'UpdatedAdmin#2026!Strong';
      const settingsRes = await fetch(`${baseUrl}/api/admin/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          currentPassword: initialAdminPw,
          newAdminPassword: newAdminPw
        })
      });
      const settingsData = await settingsRes.json();
      assert.strictEqual(settingsRes.status, 200, `Expected 200 on password change, got ${settingsRes.status}: ${JSON.stringify(settingsData)}`);
      assert.strictEqual(settingsData.status, 'ok', 'Admin settings update must return status: ok');

      const hashAfterChange = adminUser.passwordHash;
      await ensureDbLoaded();
      assert.strictEqual(adminUser.passwordHash, hashAfterChange, 'ensureDbLoaded must not overwrite admin passwordHash');

      const oldLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: adminUser.phone,
          password: initialAdminPw
        })
      });
      assert.strictEqual(oldLoginRes.status, 401, 'Old admin password must fail after change');

      const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: adminUser.phone,
          password: newAdminPw
        })
      });
      const newLoginData = await newLoginRes.json();
      assert.strictEqual(newLoginRes.status, 200, `New admin login must succeed, got ${newLoginRes.status}`);
      assert.ok(newLoginData.token, 'New admin login must return fresh token');
      adminToken = newLoginData.token;

      console.log('✓ Test 2 [CRIT-02]: Admin password change persists across ensureDbLoaded and login');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 3 [CRIT-05]: Deleting approved order revokes credited cashback
    // -------------------------------------------------------------------------
    {
      const testUserId = 'usr_crit05_test';
      const testOrderId = 'ord_crit05_test';
      const testOrderSn = 'CRIT05ORDER999';

      db.users.push({
        id: testUserId,
        code: 'CRIT05USER',
        name: 'CRIT-05 User',
        phone: '0911000005',
        email: 'crit05@example.com',
        passwordHash: await hashPasswordAsync('UserPass!123'),
        role: 'user',
        balanceAvailable: 0,
        balancePending: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        bankName: '',
        bankAccount: '',
        bankOwner: '',
        createdAt: new Date().toISOString(),
        hasNegativeBalance: false,
        tokenVersion: 1
      });

      db.orders.push({
        id: testOrderId,
        orderSn: testOrderSn,
        platform: 'shopee',
        userId: testUserId,
        status: 'approved',
        orderAmount: 200000,
        grossCommission: 25000,
        userCashbackAmount: 15000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      appendLedgerEntry(testUserId, 'order_credit', 15000, `order_credit_${testOrderSn}`, `Credit for ${testOrderSn}`);
      recalculateUserWallet(testUserId, { persist: false });
      await saveDb(db);

      const userBefore = db.users.find((u) => u.id === testUserId);
      assert.strictEqual(userBefore.balanceAvailable, 15000, 'User balance must be 15000 before deletion');

      const delRes = await fetch(`${baseUrl}/api/admin/orders/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          id: testOrderId,
          orderSn: testOrderSn
        })
      });
      const delData = await delRes.json();
      assert.strictEqual(delRes.status, 200, `Expected 200 on order delete, got ${delRes.status}: ${JSON.stringify(delData)}`);
      assert.strictEqual(delData.status, 'ok', 'Order delete must return status: ok');

      const dbAfter = await ensureDbLoaded();
      const userAfter = dbAfter.users.find((u) => u.id === testUserId);
      assert.strictEqual(userAfter.balanceAvailable, 0, 'User balance must drop back to 0 after approved order deletion');
      const hasRevocation = dbAfter.ledger.some(
        (entry) => entry.userId === testUserId && String(entry.refId || '').includes(`order_revocation_${testOrderSn}_deleted_`)
      );
      assert.strictEqual(hasRevocation, true, 'Ledger must contain revocation entry for deleted approved order');

      console.log('✓ Test 3 [CRIT-05]: Deleting approved order revokes credited cashback cleanly');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 4 [CRIT-06]: /go/:clickId Open Redirect allowlist enforcement
    // -------------------------------------------------------------------------
    {
      db.clicks.unshift(
        {
          id: 'click_allow_isclix',
          clickId: 'click_allow_isclix',
          platform: 'tiktok',
          originalUrl: 'https://www.tiktok.com/@shop/video/1',
          affiliateUrl: 'https://go.isclix.com/deep_link/v6/123/456?url=https%3A%2F%2Fshopee.vn',
          createdAt: new Date().toISOString()
        },
        {
          id: 'click_allow_isgd',
          clickId: 'click_allow_isgd',
          platform: 'shopee',
          originalUrl: 'https://shopee.vn/item-1',
          affiliateUrl: 'https://is.gd/safeabc',
          createdAt: new Date().toISOString()
        },
        {
          id: 'click_block_evil',
          clickId: 'click_block_evil',
          platform: 'shopee',
          originalUrl: 'https://shopee.vn/item-2',
          affiliateUrl: 'https://evil.example.com/phishing?token=123',
          createdAt: new Date().toISOString()
        }
      );
      await saveDb(db);

      const resIsclix = await fetch(`${baseUrl}/go/click_allow_isclix`, { redirect: 'manual' });
      assert.strictEqual(resIsclix.status, 302, 'Allowed go.isclix.com URL must redirect 302');
      assert.strictEqual(
        resIsclix.headers.get('location'),
        'https://go.isclix.com/deep_link/v6/123/456?url=https%3A%2F%2Fshopee.vn',
        'Must preserve allowed go.isclix.com redirect target'
      );

      const resIsgd = await fetch(`${baseUrl}/go/click_allow_isgd`, { redirect: 'manual' });
      assert.strictEqual(resIsgd.status, 302, 'Allowed is.gd URL must redirect 302');
      assert.strictEqual(resIsgd.headers.get('location'), 'https://is.gd/safeabc');

      const resEvil = await fetch(`${baseUrl}/go/click_block_evil`, { redirect: 'manual' });
      const evilLocation = resEvil.headers.get('location') || '';
      assert.strictEqual(resEvil.status, 400, `Blocked unapproved redirect host must return 400, got ${resEvil.status}`);
      assert.strictEqual(evilLocation.includes('evil.example.com'), false, 'Must never redirect to unapproved external host');

      console.log('✓ Test 4 [CRIT-06]: /go/:clickId blocks open redirects and permits allowlisted hosts');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 5 [CRIT-07]: NODE_ENV=test never mutates data/db.json
    // -------------------------------------------------------------------------
    {
      const prodDbExistsBefore = fs.existsSync(PROD_DB_PATH);
      const prodHashBefore = prodDbExistsBefore
        ? crypto.createHash('sha256').update(fs.readFileSync(PROD_DB_PATH)).digest('hex')
        : null;

      const script = `
        const { ensureDbLoaded, saveDb } = require('./src/services/dbService');
        (async () => {
          const db = await ensureDbLoaded();
          db.clicks.unshift({ id: 'click_isolation_probe', platform: 'shopee', affiliateUrl: 'https://s.shopee.vn/probe', createdAt: new Date().toISOString() });
          await saveDb(db);
          process.exit(0);
        })().catch((err) => { console.error(err); process.exit(1); });
      `;

      const child = spawnSync(process.execPath, ['-e', script], {
        cwd: ROOT_DIR,
        env: { ...process.env, NODE_ENV: 'test' },
        encoding: 'utf8'
      });

      assert.strictEqual(child.status, 0, `Child test DB isolation script failed: ${child.stderr || child.stdout}`);

      if (prodDbExistsBefore) {
        const prodRawAfter = fs.readFileSync(PROD_DB_PATH, 'utf8');
        const prodHashAfter = crypto.createHash('sha256').update(prodRawAfter).digest('hex');
        assert.strictEqual(prodHashAfter, prodHashBefore, 'data/db.json hash must remain byte-for-byte identical in NODE_ENV=test');
        assert.strictEqual(prodRawAfter.includes('click_isolation_probe'), false, 'data/db.json must not contain test probe click');
      } else {
        assert.strictEqual(fs.existsSync(PROD_DB_PATH), false, 'data/db.json must not be created during NODE_ENV=test');
      }

      console.log('✓ Test 5 [CRIT-07]: NODE_ENV=test completely isolates writes away from data/db.json');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 6 [HIGH-01]: Admin HTML table headers match JS column counts
    // -------------------------------------------------------------------------
    {
      const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
      const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js'), 'utf8');

      const ordersTableMatch = indexHtml.match(/<thead>((?:(?!<\/thead>)[\s\S])*)<\/thead>\s*<tbody id="admOrdersTableBody"/i);
      assert.ok(ordersTableMatch, 'Could not locate admOrdersTableBody table header in public/index.html');
      const ordersThCount = (ordersTableMatch[1].match(/<th\b/gi) || []).length;
      assert.strictEqual(ordersThCount, 8, `Admin orders table must have 8 <th> columns, found ${ordersThCount}`);
      assert.ok(appJs.includes('colspan="8"'), 'public/app.js must use colspan="8" for empty admin orders state');

      const withdrawTableMatch = indexHtml.match(/<thead>((?:(?!<\/thead>)[\s\S])*)<\/thead>\s*<tbody id="admWithdrawalsTableBody"/i);
      assert.ok(withdrawTableMatch, 'Could not locate admWithdrawalsTableBody table header in public/index.html');
      const withdrawThCount = (withdrawTableMatch[1].match(/<th\b/gi) || []).length;
      assert.strictEqual(withdrawThCount, 6, `Admin withdrawals table must have 6 <th> columns, found ${withdrawThCount}`);

      console.log('✓ Test 6 [HIGH-01]: Admin orders (8 cols) and withdrawals (6 cols) tables align cleanly');
      passed += 1;
    }

    // -------------------------------------------------------------------------
    // TEST 7 [HIGH-06]: /api/convert does not leak affiliateUrl to api.qrserver.com
    // -------------------------------------------------------------------------
    {
      const convertRes = await fetch(`${baseUrl}/api/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          text: 'https://shopee.vn/product/123456/7890123'
        })
      });
      const convertText = await convertRes.text();
      assert.strictEqual(convertRes.status, 200, `Expected 200 from /api/convert, got ${convertRes.status}: ${convertText}`);
      assert.strictEqual(convertText.includes('qrserver.com'), false, '/api/convert response must not leak affiliateUrl to api.qrserver.com');

      const convertData = JSON.parse(convertText);
      const items = convertData.items || convertData.results || [];
      assert.ok(items.length >= 1, 'Expected at least 1 converted item from /api/convert');
      for (const item of items) {
        assert.strictEqual(item.qrUrl, null, 'Expected item.qrUrl to be null instead of external QR service');
      }

      console.log('✓ Test 7 [HIGH-06]: /api/convert sets qrUrl = null and eliminates api.qrserver.com leakage');
      passed += 1;
    }

    console.log(`\nALL DUE DILIGENCE FIX TESTS PASSED (${passed}/7)`);
  } finally {
    if (serverInfo?.server) {
      serverInfo.server.closeAllConnections?.();
      await new Promise((resolve) => serverInfo.server.close(resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
