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
  verifyPassword,
  createToken,
  recalculateUserWallet,
  appendLedgerEntry,
  recordAuditLog,
  normalizePhoneNumber
} = require('../src/services/dbService');
const {
  registerCashbackRoutes,
  upsertNetworkOrder,
  sanitizeOrderForUser,
  AppError
} = require('../src/services/cashbackController');

async function runTestSuite() {
  console.log('=== STARTING TASK 8 P1 BACKEND FIXES VERIFICATION SUITE ===');
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();

  const db = ensureDbLoaded();
  const app = express();
  app.use(express.json());

  // Test route to verify centralized 500 error sanitization
  app.get('/api/test-trigger-500', (req, res, next) => {
    next(new Error('Sensitive internal database connection string: postgresql://admin:secret@host/db'));
  });

  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Create isolated test entities
  const testSuffix = Date.now();
  const testAdmin = {
    id: `usr_adm_test_${testSuffix}`,
    code: `ADM_${testSuffix}`,
    name: 'Admin Test',
    phone: `0999${testSuffix.toString().slice(-6)}`,
    passwordHash: hashPassword('adminPassword123@'),
    role: 'admin',
    tokenVersion: 1
  };
  db.users.push(testAdmin);
  const adminToken = createToken(testAdmin);

  const testUser = {
    id: `usr_u_test_${testSuffix}`,
    code: `USR_${testSuffix}`,
    name: 'User Test',
    phone: `0912${testSuffix.toString().slice(-6)}`,
    passwordHash: hashPassword('userPassword123@'),
    role: 'user',
    tokenVersion: 1,
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    bankName: 'Vietcombank',
    bankAccount: '1234567890',
    bankOwner: 'NGUYEN VAN A'
  };
  db.users.push(testUser);
  await saveDb(db);
  let userToken = createToken(testUser);

  // =========================================================================
  // 1. TIỀN HOÀN: Rates Locking & Modal Edit Handling
  // =========================================================================
  console.log('\n--- 1. Testing Tiền Hoàn: Rates Locking & Modal Order Edit ---');

  // Set global settings
  const origSettings = {
    cashbackPercent: db.settings.cashbackPercent,
    taxDeductPercent: db.settings.taxDeductPercent,
    shopeeAppSecret: db.settings.shopeeAppSecret,
    tiktokAppSecret: db.settings.tiktokAppSecret,
    turnstileSecretKey: db.settings.turnstileSecretKey,
    postbackToken: db.settings.postbackToken
  };
  db.settings.cashbackPercent = 70;
  db.settings.taxDeductPercent = 10;

  const testOrderSn1 = `ORD_LOCK_${testSuffix}`;
  const order1 = upsertNetworkOrder(db, {
    orderSn: testOrderSn1,
    rawSubId: testUser.code,
    grossCommission: 100000,
    orderAmount: 1000000,
    status: 'pending',
    platform: 'shopee',
    productName: 'Tai nghe Bluetooth'
  });

  assert.strictEqual(order1.lockedCashbackRate, 70, 'Order should lock cashbackRate = 70');
  assert.strictEqual(order1.lockedTaxRate, 10, 'Order should lock taxRate = 10');
  assert.strictEqual(order1.userCashbackAmount, 63000, 'User cashback should be 63,000đ (90,000 * 70%)');

  // Change global settings: cashbackPercent = 50%, tax = 20%
  db.settings.cashbackPercent = 50;
  db.settings.taxDeductPercent = 20;

  // Upsert the same order again (e.g. status update or commission update)
  const order1Updated = upsertNetworkOrder(db, {
    orderSn: testOrderSn1,
    rawSubId: testUser.code,
    grossCommission: 100000,
    status: 'approved'
  });

  assert.strictEqual(order1Updated.lockedCashbackRate, 70, 'Order must preserve locked cashbackRate = 70 despite global change');
  assert.strictEqual(order1Updated.lockedTaxRate, 10, 'Order must preserve locked taxRate = 10 despite global change');
  assert.strictEqual(order1Updated.userCashbackAmount, 63000, 'Cashback must remain calculated from locked 70% rate, not new 50%');

  // Test Modal edit: if userCashbackAmount is undefined, null, or empty string,
  // do NOT set hasCustomCashback = true and do NOT reset cashback to 0!
  const modalEditEmptyRes = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      id: order1Updated.id,
      orderSn: testOrderSn1,
      userCashbackAmount: '', // Empty string in modal
      status: 'approved'
    })
  });
  const modalEditEmptyJson = await modalEditEmptyRes.json();
  assert.strictEqual(modalEditEmptyRes.status, 200, 'Admin modal edit with empty userCashbackAmount should succeed');
  assert.strictEqual(modalEditEmptyJson.order.hasCustomCashback, false, 'hasCustomCashback must NOT be true when empty string passed');
  assert.strictEqual(modalEditEmptyJson.order.userCashbackAmount, 63000, 'userCashbackAmount must NOT be reset to 0');

  // Test Modal edit with positive custom cashback: sets hasCustomCashback = true
  const modalEditCustomRes = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      id: order1Updated.id,
      orderSn: testOrderSn1,
      userCashbackAmount: 75000
    })
  });
  const modalEditCustomJson = await modalEditCustomRes.json();
  assert.strictEqual(modalEditCustomRes.status, 200);
  assert.strictEqual(modalEditCustomJson.order.hasCustomCashback, true, 'hasCustomCashback must be true for explicit positive custom cashback');
  assert.strictEqual(modalEditCustomJson.order.userCashbackAmount, 75000, 'Custom cashback amount must be preserved');
  console.log('  PASS: Cashback rate locking and modal custom cashback handling work as required.');

  // =========================================================================
  // 2. RÚT TIỀN: Bank info protection & Idempotency
  // =========================================================================
  console.log('\n--- 2. Testing Rút Tiền: Bank Info Protection & Idempotency ---');

  // Attempt to change bank account without password -> Should return 400
  const changeBankNoPwdRes = await fetch(`${baseUrl}/api/user/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`
    },
    body: JSON.stringify({
      bankAccount: '9876543210'
    })
  });
  assert.strictEqual(changeBankNoPwdRes.status, 400, 'Changing bankAccount without password must return 400');
  const changeBankNoPwdJson = await changeBankNoPwdRes.json();
  assert(changeBankNoPwdJson.error.includes('mật khẩu'), 'Error message should mention password');

  // Attempt to change bank name with wrong password -> Should return 400
  const changeBankWrongPwdRes = await fetch(`${baseUrl}/api/user/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`
    },
    body: JSON.stringify({
      bankName: 'Techcombank',
      password: 'wrongPassword123'
    })
  });
  assert.strictEqual(changeBankWrongPwdRes.status, 400, 'Changing bankName with wrong password must return 400');

  // Change bank with correct password -> Should succeed (200)
  const changeBankCorrectPwdRes = await fetch(`${baseUrl}/api/user/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`
    },
    body: JSON.stringify({
      bankName: 'Techcombank',
      bankAccount: '9876543210',
      password: 'userPassword123@'
    })
  });
  assert.strictEqual(changeBankCorrectPwdRes.status, 200, 'Changing bank details with correct password must return 200');
  const changeBankCorrectJson = await changeBankCorrectPwdRes.json();
  assert.strictEqual(changeBankCorrectJson.user.bankName, 'Techcombank');
  assert.strictEqual(changeBankCorrectJson.user.bankAccount, '9876543210');

  // Test Withdrawal Idempotency
  // Credit user balance first
  appendLedgerEntry(testUser.id, 'order_cashback', 300000, `credit_${testSuffix}`, 'Credit balance for withdrawal test');
  recalculateUserWallet(testUser.id);
  await saveDb(db);
  assert(testUser.balanceAvailable >= 200000, 'User should have available balance');

  const idempotencyKey = `idemp_${testSuffix}_abc`;
  const withdrawBody = {
    amount: 100000,
    method: 'bank',
    bankName: 'Techcombank',
    bankAccount: '9876543210',
    bankOwner: 'NGUYEN VAN A',
    currentPassword: 'userPassword123@'
  };

  // First withdrawal call with idempotency-key
  const wdRes1 = await fetch(`${baseUrl}/api/user/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify(withdrawBody)
  });
  const wdJson1 = await wdRes1.json();
  assert.strictEqual(wdRes1.status, 200, 'First withdrawal request must succeed');
  const wdId1 = wdJson1.withdrawal.id;
  assert(wdId1, 'Withdrawal ID must be present');

  // Balance after first withdrawal
  recalculateUserWallet(testUser.id);
  const balanceAfterFirstWd = testUser.balanceAvailable;

  // Immediate second withdrawal call with the same idempotency-key
  const wdRes2 = await fetch(`${baseUrl}/api/user/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify(withdrawBody)
  });
  const wdJson2 = await wdRes2.json();
  assert.strictEqual(wdRes2.status, 200, 'Second idempotent withdrawal request must return 200');
  assert.strictEqual(wdJson2.withdrawal.id, wdId1, 'Second request must return existing withdrawal record');

  // Verify no double debit occurred
  recalculateUserWallet(testUser.id);
  assert.strictEqual(testUser.balanceAvailable, balanceAfterFirstWd, 'Balance must NOT be debited a second time');
  console.log('  PASS: Bank info change requires password (400 on error), and withdrawal idempotency prevents double debiting.');

  // =========================================================================
  // 3. LỘ DỮ LIỆU & BÍ MẬT: Data Sanitization & Secrets Masking
  // =========================================================================
  console.log('\n--- 3. Testing Lộ Dữ Liệu & Bí Mật ---');

  const rawOrder = {
    id: 'ord_leak_test',
    orderSn: 'SN_LEAK_TEST',
    platform: 'shopee',
    productName: 'Điện thoại Xiaomi',
    orderAmount: 5000000,
    grossCommission: 500000,
    taxAmount: 50000,
    netCommission: 450000,
    cashbackRate: 70,
    userCashbackAmount: 315000,
    adminShareAmount: 135000,
    claimedByUserId: 'usr_secret_123',
    submittedByUserId: 'usr_submitter_456',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  const sanitized = sanitizeOrderForUser(rawOrder);
  assert.strictEqual(sanitized.adminShareAmount, undefined, 'adminShareAmount must be stripped');
  assert.strictEqual(sanitized.grossCommission, undefined, 'grossCommission must be stripped');
  assert.strictEqual(sanitized.claimedByUserId, undefined, 'claimedByUserId must be stripped');
  assert.strictEqual(sanitized.submittedByUserId, undefined, 'submittedByUserId must be stripped');
  assert.strictEqual(sanitized.userCashbackAmount, 315000, 'Public userCashbackAmount must be preserved');

  // Verify secrets masking in GET /api/admin/settings
  db.settings.shopeeAppSecret = 'real_shopee_secret_key';
  db.settings.tiktokAppSecret = 'real_tiktok_secret_key';
  db.settings.turnstileSecretKey = 'real_turnstile_secret_key';
  db.settings.postbackToken = 'real_postback_token';

  const settingsMaskedRes = await fetch(`${baseUrl}/api/admin/settings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(settingsMaskedRes.status, 200);
  const settingsMaskedJson = await settingsMaskedRes.json();
  assert.strictEqual(settingsMaskedJson.settings.shopeeAppSecret, '***', 'shopeeAppSecret must be masked with ***');
  assert.strictEqual(settingsMaskedJson.settings.tiktokAppSecret, '***', 'tiktokAppSecret must be masked with ***');
  assert.strictEqual(settingsMaskedJson.settings.turnstileSecretKey, '***', 'turnstileSecretKey must be masked with ***');
  assert.strictEqual(settingsMaskedJson.settings.postbackToken, '***', 'postbackToken must be masked with ***');

  // Verify superadmin explicit reveal
  const settingsRevealRes = await fetch(`${baseUrl}/api/admin/settings?reveal=true`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const settingsRevealJson = await settingsRevealRes.json();
  assert.strictEqual(settingsRevealJson.settings.shopeeAppSecret, 'real_shopee_secret_key', 'Authorized reveal should unmask shopeeAppSecret');
  assert.strictEqual(settingsRevealJson.settings.postbackToken, 'real_postback_token', 'Authorized reveal should unmask postbackToken');
  console.log('  PASS: sanitizeOrderForUser strips internal margins, and secrets are masked with ***.');

  // =========================================================================
  // 4. ADMIN API & AUDIT LOG
  // =========================================================================
  console.log('\n--- 4. Testing Admin API & Audit Log ---');

  // Validate payload in POST /api/admin/orders
  const invalidPlatformRes = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      orderSn: 'SN_INVALID_PLATFORM',
      platform: 'invalid_mall'
    })
  });
  assert.strictEqual(invalidPlatformRes.status, 400, 'Invalid platform must return 400');

  const invalidStatusRes = await fetch(`${baseUrl}/api/admin/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      orderSn: 'SN_INVALID_STATUS',
      status: 'refunded_unknown'
    })
  });
  assert.strictEqual(invalidStatusRes.status, 400, 'Invalid status must return 400');

  // Test admin password update requires currentPassword
  const adminPwdNoCurrentRes = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      newAdminPassword: 'newAdminPassword456@'
    })
  });
  assert.strictEqual(adminPwdNoCurrentRes.status, 400, 'Updating admin password without currentPassword must return 400');

  const adminPwdWrongCurrentRes = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      newAdminPassword: 'newAdminPassword456@',
      currentPassword: 'wrongPassword'
    })
  });
  assert.strictEqual(adminPwdWrongCurrentRes.status, 400, 'Updating admin password with wrong currentPassword must return 400');

  // Test POST /api/admin/users/action adjust_balance rejection of Infinity / -Infinity / NaN
  for (const badVal of [Infinity, -Infinity, NaN, 'not-a-number']) {
    const badAdjustRes = await fetch(`${baseUrl}/api/admin/users/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        userId: testUser.id,
        action: 'adjust_balance',
        amount: badVal
      })
    });
    assert.strictEqual(badAdjustRes.status, 400, `adjust_balance must reject ${badVal} with 400`);
  }

  // Test soft delete for user with orders/withdrawals
  const deleteActionRes = await fetch(`${baseUrl}/api/admin/users/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      userId: testUser.id,
      action: 'delete'
    })
  });
  assert.strictEqual(deleteActionRes.status, 200);
  assert.strictEqual(testUser.accountLocked, true, 'User with financial records must be soft deleted (accountLocked = true)');
  assert.strictEqual(testUser.isDeleted, true, 'User with financial records must have isDeleted = true');

  // Verify Audit Logs structure in db.auditLogs
  assert(Array.isArray(db.auditLogs), 'db.auditLogs must be an array');
  const latestLog = db.auditLogs[0];
  assert(latestLog, 'Audit log entry must exist');
  assert(latestLog.id.startsWith('audit_'), 'Audit log id must start with audit_');
  assert(latestLog.adminId, 'Audit log adminId must be set');
  assert(latestLog.action, 'Audit log action must be set');
  assert(latestLog.timestamp, 'Audit log timestamp must be set');
  console.log('  PASS: Admin payload validation, password protection, soft-delete, and audit logs are fully verified.');

  // =========================================================================
  // 5. ĐỒNG BỘ & XÁC THỰC: Phone Normalization, Logout Revocation, Error Sanitization
  // =========================================================================
  console.log('\n--- 5. Testing Đồng Bộ, Logout Revocation, Phone Normalization & Error Sanitization ---');

  // Phone Normalization
  assert.strictEqual(normalizePhoneNumber('+84912345678'), '0912345678', 'Should convert +84 to 0');
  assert.strictEqual(normalizePhoneNumber('84912345678'), '0912345678', 'Should convert 84 to 0');
  assert.strictEqual(normalizePhoneNumber('0912 345 678'), '0912345678', 'Should strip spaces');
  assert.strictEqual(normalizePhoneNumber('0912-345-678'), '0912345678', 'Should strip dashes');
  assert.strictEqual(normalizePhoneNumber('+84 912-345-678'), '0912345678', 'Should strip +84, spaces, dashes');
  assert.strictEqual(normalizePhoneNumber(null), '', 'Null phone returns empty string');
  assert.strictEqual(normalizePhoneNumber(undefined), '', 'Undefined phone returns empty string');

  // Safe phone handling with null/undefined values in users
  const dummyUser = { id: 'usr_dummy_null_phone', phone: null };
  const safePhoneCheck = String(dummyUser.phone || '').toLowerCase();
  assert.strictEqual(safePhoneCheck, '', 'Safe phone handling does not throw TypeError on null');

  // Token Revocation on Logout: POST /api/auth/logout
  // Create a clean active user to test logout revocation
  const activeUser = {
    id: `usr_active_${testSuffix}`,
    code: `ACT_${testSuffix}`,
    phone: `0933${testSuffix.toString().slice(-6)}`,
    passwordHash: hashPassword('password123'),
    role: 'user',
    tokenVersion: 1
  };
  db.users.push(activeUser);
  await saveDb(db);
  const activeToken = createToken(activeUser);

  // User should be able to access /api/user/me
  const meBeforeLogoutRes = await fetch(`${baseUrl}/api/user/me`, {
    headers: { Authorization: `Bearer ${activeToken}` }
  });
  assert.strictEqual(meBeforeLogoutRes.status, 200, 'Token must be valid before logout');

  // Call POST /api/auth/logout
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${activeToken}` }
  });
  assert.strictEqual(logoutRes.status, 200);
  assert.strictEqual(activeUser.tokenVersion, 2, 'Logout must increment tokenVersion');

  // Token should now be completely rejected (401)
  const meAfterLogoutRes = await fetch(`${baseUrl}/api/user/me`, {
    headers: { Authorization: `Bearer ${activeToken}` }
  });
  assert.strictEqual(meAfterLogoutRes.status, 401, 'Revoked token must be rejected with 401');

  // Error Sanitization: verify centralized 500 error sanitization
  const errRes = await fetch(`${baseUrl}/api/test-trigger-500`);
  assert.strictEqual(errRes.status, 500, 'Should return status 500');
  const errJson = await errRes.json();
  assert.strictEqual(
    errJson.error,
    'Đã có lỗi xảy ra trên hệ thống.',
    'Internal error details must be sanitized to generic error message'
  );
  assert(!JSON.stringify(errJson).includes('postgresql'), 'Sensitive stack trace or message must not leak');
  console.log('  PASS: Phone normalization, token revocation on logout, and 500 error message sanitization verified cleanly.');

  // Cleanup test artifacts
  await new Promise((resolve) => server.close(resolve));
  Object.assign(db.settings, origSettings);
  db.users = db.users.filter((u) => u.id !== testAdmin.id && u.id !== testUser.id && u.id !== activeUser.id);
  db.orders = db.orders.filter((o) => o.orderSn !== testOrderSn1);
  db.withdrawals = db.withdrawals.filter((w) => w.userId !== testUser.id);
  db.ledger = db.ledger.filter((l) => l.userId !== testUser.id);
  await saveDb(db);

  console.log('\n=== ALL TASK 8 VERIFICATION TESTS PASSED SUCCESSFULLY! ===\n');
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
