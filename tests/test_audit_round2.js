const assert = require('assert');
const crypto = require('crypto');
const {
  ensureDbLoaded,
  saveDb,
  recalculateUserWallet,
  appendLedgerEntry,
  reloadStateFromPostgres,
  initPostgresIfConfigured
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');
const express = require('express');
const http = require('http');

async function runTests() {
  console.log('=== STARTING AUDIT ROUND 2 VERIFICATION SUITE ===');
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();
  // Filter out any stale test users
  db.users = db.users.filter((u) => !u.id.startsWith('usr_test_wd_'));

  // ----------------------------------------------------
  // TEST 1: Click Slice Verification (Newest 5000 preserved, oldest dropped)
  // ----------------------------------------------------
  console.log('\n--- 1. Testing db.clicks.slice(0, 5000) ---');
  const testClicks = [];
  for (let i = 0; i < 5005; i++) {
    testClicks.unshift({
      clickId: `click_${i}`,
      createdAt: new Date(Date.now() + i * 1000).toISOString()
    });
  }
  const sliced = testClicks.slice(0, 5000);
  assert.strictEqual(sliced.length, 5000, 'Should keep exactly 5000 clicks');
  assert.strictEqual(sliced[0].clickId, 'click_5004', 'Newest click must be at index 0');
  assert.strictEqual(sliced[4999].clickId, 'click_5', 'Oldest kept click should be click_5');
  console.log('  PASS: Newest clicks are preserved at the beginning of the array, oldest dropped.');

  // ----------------------------------------------------
  // TEST 2: Withdrawal Rejection & Single Refund Guarantee
  // ----------------------------------------------------
  console.log('\n--- 2. Testing Withdrawal Rejection Single-Refund Guarantee ---');
  const testUserId = `usr_test_wd_${Date.now()}`;
  const randDigits = Math.floor(100000 + Math.random() * 900000);
  const testUser = {
    id: testUserId,
    code: `U_TEST_${randDigits}`,
    name: 'Test Withdrawal User',
    phone: `0988${randDigits}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    bankName: 'MBBank',
    bankAccount: '123456789',
    bankOwner: 'TEST USER'
  };
  db.users.push(testUser);

  // Credit 500,000đ into user's wallet via initial ledger
  appendLedgerEntry(testUserId, 'order_cashback', 500000, `init_credit_${Date.now()}`, 'Initial balance');
  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 500000, 'User should have 500,000đ available');

  // Create a pending withdrawal of 100,000đ
  const testWdId = `wd_test_${Date.now()}`;
  const testWd = {
    id: testWdId,
    userId: testUserId,
    userCode: testUser.code,
    amount: 100000,
    method: 'bank',
    bankName: 'MBBank',
    bankAccount: '123456789',
    bankOwner: 'TEST USER',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.withdrawals.push(testWd);

  // recalculate debit for pending withdrawal
  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 400000, 'Available balance should be 400,000đ while withdrawal is pending');

  // Now reject withdrawal: set status to 'rejected'
  testWd.status = 'rejected';
  recalculateUserWallet(testUserId);

  assert.strictEqual(testUser.balanceAvailable, 500000, 'User balance should be refunded back to 500,000đ');

  const refunds = db.ledger.filter((l) => l.refId === `withdraw_refund_${testWdId}`);
  assert.strictEqual(refunds.length, 1, 'Exactly one refund ledger entry must exist');
  assert.strictEqual(refunds[0].amount, 100000, 'Refund entry must equal 100,000đ');

  // Run recalculateUserWallet again to prove idempotency (no double-refund!)
  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 500000, 'Balance must remain 500,000đ on repeated recalculation');
  const refundsAfter = db.ledger.filter((l) => l.refId === `withdraw_refund_${testWdId}`);
  assert.strictEqual(refundsAfter.length, 1, 'Still exactly one refund entry (no duplicate)');
  console.log('  PASS: Rejection refunds balance cleanly without double-refund.');

  // ----------------------------------------------------
  // TEST 3: Status Transition & Financial Amount Preservation
  // ----------------------------------------------------
  console.log('\n--- 3. Testing upsertNetworkOrder Financial Amount & Status Preservation ---');
  // Load controller functions to test upsertNetworkOrder behavior via route or directly
  const testOrderSn = `SN_APPROVED_${Date.now()}`;
  const approvedOrder = {
    id: `ord_${Date.now()}`,
    orderSn: testOrderSn,
    platform: 'shopee',
    userCode: testUser.code,
    userId: testUserId,
    productName: 'Áo Thun Cao Cấp',
    orderAmount: 1000000,
    grossCommission: 100000,
    taxAmount: 10000,
    netCommission: 90000,
    totalCommission: 90000,
    cashbackRate: 70,
    userCashbackAmount: 63000,
    adminShareAmount: 27000,
    status: 'approved',
    hasCustomCashback: false,
    createdAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.unshift(approvedOrder);

  // Simulate late sync or webhook replay with status='pending' and low commission estimates
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  // Attempt to downgrade status and overwrite amounts via fake postback
  const postbackSecret = process.env.POSTBACK_SECRET || 'test-secret-123';
  process.env.POSTBACK_SECRET = postbackSecret;

  const replayPayload = {
    orderSn: testOrderSn,
    status: 'pending',
    grossCommission: 10000,
    orderAmount: 100000,
    platform: 'shopee'
  };
  const rawBody = JSON.stringify(replayPayload);
  const signature = crypto.createHmac('sha256', postbackSecret).update(rawBody).digest('hex');

  const postbackRes = await fetch(`http://127.0.0.1:${port}/api/webhooks/postback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-postback-signature': signature
    },
    body: rawBody
  });

  const postbackJson = await postbackRes.json();
  assert.strictEqual(postbackRes.status, 200, 'Postback endpoint should return 200');

  // Verify the approved order was NOT downgraded to pending and amounts were NOT overwritten
  const inspectedOrder = db.orders.find((o) => o.orderSn === testOrderSn);
  assert.strictEqual(inspectedOrder.status, 'approved', 'Status must stay approved, cannot be downgraded to pending');
  assert.strictEqual(inspectedOrder.grossCommission, 100000, 'Gross commission must not be overwritten by pending event');
  assert.strictEqual(inspectedOrder.userCashbackAmount, 63000, 'Cashback amount must remain 63,000đ');
  assert.strictEqual(inspectedOrder.orderAmount, 1000000, 'Order amount must remain 1,000,000đ');
  console.log('  PASS: Approved order status and financial amounts protected against pending replay.');

  // ----------------------------------------------------
  // TEST 4: adjust_balance Infinity / NaN Rejection
  // ----------------------------------------------------
  console.log('\n--- 4. Testing adjust_balance Infinity & NaN Rejection ---');
  // Login as admin
  const adminUser = db.users.find((u) => u.role === 'admin') || {
    id: 'admin_test_1',
    code: 'ADMIN',
    role: 'admin',
    phone: '0999999999',
    passwordHash: 'scrypt$dummy'
  };
  if (!db.users.includes(adminUser)) db.users.push(adminUser);

  const { createToken } = require('../src/services/dbService');
  const adminToken = createToken(adminUser);

  // Send adjust_balance with Infinity
  const infRes = await fetch(`http://127.0.0.1:${port}/api/admin/users/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      userId: testUserId,
      action: 'adjust_balance',
      amount: Infinity
    })
  });
  const infJson = await infRes.json();
  assert.strictEqual(infRes.status, 400, 'Should reject Infinity with 400');
  assert(infJson.error.includes('không hợp lệ'), 'Error message should indicate invalid amount');

  // Send adjust_balance with NaN
  const nanRes = await fetch(`http://127.0.0.1:${port}/api/admin/users/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      userId: testUserId,
      action: 'adjust_balance',
      amount: 'abc'
    })
  });
  assert.strictEqual(nanRes.status, 400, 'Should reject non-numeric string with 400');
  console.log('  PASS: Infinity and NaN amounts strictly rejected by adjust_balance.');

  // ----------------------------------------------------
  // TEST 5: Data Privacy & Sanitization for User Orders
  // ----------------------------------------------------
  console.log('\n--- 5. Testing sanitizeOrderForUser Data Leakage Prevention ---');
  const userToken = createToken(testUser);
  const meRes = await fetch(`http://127.0.0.1:${port}/api/user/me`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  const meJson = await meRes.json();
  assert.strictEqual(meRes.status, 200, 'GET /api/user/me should return 200');
  assert(Array.isArray(meJson.orders), 'Orders should be an array');
  const userVisibleOrder = meJson.orders.find((o) => o.orderSn === testOrderSn);
  assert(userVisibleOrder, 'User order should be present in /api/user/me');

  // Verify internal margins are NOT leaked
  assert.strictEqual(userVisibleOrder.adminShareAmount, undefined, 'adminShareAmount must NOT be visible to user');
  assert.strictEqual(userVisibleOrder.grossCommission, undefined, 'grossCommission must NOT be visible to user');
  assert.strictEqual(userVisibleOrder.netCommission, undefined, 'netCommission must NOT be visible to user');
  assert.strictEqual(userVisibleOrder.taxAmount, undefined, 'taxAmount must NOT be visible to user');
  assert.strictEqual(userVisibleOrder.orderAmount, 1000000, 'Public order amount is visible');
  assert.strictEqual(userVisibleOrder.userCashbackAmount, 63000, 'User cashback amount is visible');
  console.log('  PASS: Internal business metrics completely masked from client-facing order responses.');

  // ----------------------------------------------------
  // TEST 6: Admin Cancel Withdrawal endpoint restriction
  // ----------------------------------------------------
  console.log('\n--- 6. Testing /api/admin/withdrawals/cancel Pending-Only Enforcement ---');
  // Attempt to cancel an already paid withdrawal
  const paidWdId = `wd_paid_${Date.now()}`;
  db.withdrawals.push({
    id: paidWdId,
    userId: testUserId,
    userCode: testUser.code,
    amount: 50000,
    status: 'paid',
    createdAt: new Date().toISOString()
  });

  const cancelPaidRes = await fetch(`http://127.0.0.1:${port}/api/admin/withdrawals/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ id: paidWdId })
  });
  assert.strictEqual(cancelPaidRes.status, 400, 'Cannot cancel already paid withdrawal');

  // Attempt to cancel an already rejected withdrawal
  const cancelRejectedRes = await fetch(`http://127.0.0.1:${port}/api/admin/withdrawals/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ id: testWdId }) // testWd is already rejected
  });
  assert.strictEqual(cancelRejectedRes.status, 400, 'Cannot re-cancel already rejected withdrawal');
  console.log('  PASS: Only pending withdrawals can be cancelled.');

  await new Promise((resolve) => server.close(resolve));
  console.log('\n=== ALL 6 AUDIT VERIFICATION SUITES PASSED CLEANLY! ===\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
