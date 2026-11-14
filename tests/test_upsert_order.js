const assert = require('assert');
const crypto = require('crypto');
const logger = require('../src/utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  recalculateUserWallet,
  recalculateAllWallets,
  appendLedgerEntry,
  auditLedgerIntegrity,
  reloadStateFromPostgres,
  initPostgresIfConfigured
} = require('../src/services/dbService');
const {
  upsertNetworkOrder,
  canTransitionOrderStatus,
  normalizeNetworkStatus
} = require('../src/services/cashbackController');

async function runUpsertOrderTests() {
  console.log('=== STARTING UPSERT NETWORK ORDER TEST SUITE (P0 #5) ===');

  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // Cleanup any test records from prior runs
  const TEST_PREFIX = 'usr_test_ord5_';
  db.users = db.users.filter((u) => !u.id.startsWith(TEST_PREFIX));
  db.orders = db.orders.filter((o) => !o.orderSn.startsWith('SN_TEST5_'));
  db.ledger = db.ledger.filter((l) => !l.userId?.startsWith(TEST_PREFIX));

  const randSuffix = Math.floor(100000 + Math.random() * 900000);
  const testUserId = `${TEST_PREFIX}${randSuffix}`;
  const testUserCode = `U_ORD5_${randSuffix}`;

  const testUser = {
    id: testUserId,
    code: testUserCode,
    name: 'Test P05 Upsert User',
    phone: `0966${randSuffix}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0
  };
  db.users.push(testUser);

  // ----------------------------------------------------
  // TEST 1: Reverse status transition (approved -> pending) is completely blocked
  // ----------------------------------------------------
  console.log('\n--- 1. Testing Reverse Status Transition (approved -> pending) is Blocked ---');
  const sn1 = `SN_TEST5_REV_${randSuffix}`;
  const order1 = upsertNetworkOrder(db, {
    orderSn: sn1,
    rawSubId: testUserCode,
    grossCommission: 100000,
    orderAmount: 1000000,
    status: 'approved',
    platform: 'shopee',
    productName: 'Sản phẩm Test Duyệt 1'
  });

  assert.ok(order1, 'Order 1 should be created');
  assert.strictEqual(order1.status, 'approved', 'Initial status must be approved');
  assert.strictEqual(order1.grossCommission, 100000, 'Gross commission should be 100,000đ');
  const initialCashback1 = order1.userCashbackAmount;
  assert.ok(initialCashback1 > 0, 'User cashback amount must be positive');

  // Recalculate wallet so user is credited
  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, initialCashback1, 'User wallet balance should match initial approved cashback');

  // Attempt to downgrade status to pending with drastically reduced amounts
  const downgradedOrder1 = upsertNetworkOrder(db, {
    orderSn: sn1,
    rawSubId: testUserCode,
    grossCommission: 5000,
    orderAmount: 50000,
    status: 'pending',
    platform: 'shopee'
  });

  assert.strictEqual(downgradedOrder1.status, 'approved', 'Status must stay approved, cannot be downgraded to pending');
  assert.strictEqual(downgradedOrder1.grossCommission, 100000, 'Gross commission must not be overwritten by pending event');
  assert.strictEqual(downgradedOrder1.userCashbackAmount, initialCashback1, 'User cashback amount must remain intact');
  assert.strictEqual(downgradedOrder1.orderAmount, 1000000, 'Order amount must not be downgraded');

  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, initialCashback1, 'User available balance must remain fully intact');
  console.log('  PASS: Approved order is strictly protected against pending downgrade and amount overwrite.');

  // ----------------------------------------------------
  // TEST 2: Stale event does not overwrite amounts on approved orders
  // ----------------------------------------------------
  console.log('\n--- 2. Testing Stale Event Rejection on Approved Orders ---');
  const sn2 = `SN_TEST5_STALE_${randSuffix}`;
  const baseTime = Date.now();
  const timeT2 = baseTime + 100000;
  const timeT1 = baseTime + 50000; // Older than T2

  const order2 = upsertNetworkOrder(db, {
    orderSn: sn2,
    rawSubId: testUserCode,
    grossCommission: 200000,
    orderAmount: 2000000,
    status: 'approved',
    platform: 'shopee',
    productName: 'Sản phẩm Test Stale 2',
    eventTime: timeT2
  });

  assert.strictEqual(order2.status, 'approved');
  assert.strictEqual(order2.grossCommission, 200000);
  const initialCashback2 = order2.userCashbackAmount;

  // Stale event arriving with older eventTime (T1 < T2) trying to change commission to 50,000
  const staleAttempt = upsertNetworkOrder(db, {
    orderSn: sn2,
    rawSubId: testUserCode,
    grossCommission: 50000,
    orderAmount: 500000,
    status: 'approved',
    platform: 'shopee',
    eventTime: timeT1
  });

  assert.strictEqual(staleAttempt.grossCommission, 200000, 'Gross commission must remain 200,000đ (stale event rejected)');
  assert.strictEqual(staleAttempt.userCashbackAmount, initialCashback2, 'Cashback amount must not be altered by stale event');
  assert.strictEqual(staleAttempt.orderAmount, 2000000, 'Order amount must not be altered by stale event');
  console.log('  PASS: Stale network event with older eventTime was completely ignored on approved order.');

  // ----------------------------------------------------
  // TEST 3: Out-of-order network webhooks with older eventTime are ignored
  // ----------------------------------------------------
  console.log('\n--- 3. Testing Out-of-Order Network Webhook with Older eventTime ---');
  const sn3 = `SN_TEST5_OUTOFORDER_${randSuffix}`;
  const tInitial = baseTime + 50000;
  const tOlder = baseTime + 30000;
  const tNewer = baseTime + 70000;

  const order3 = upsertNetworkOrder(db, {
    orderSn: sn3,
    rawSubId: testUserCode,
    grossCommission: 80000,
    orderAmount: 800000,
    status: 'pending',
    platform: 'tiktok',
    productName: 'TikTok Order Initial',
    eventTime: tInitial
  });

  assert.strictEqual(order3.eventTime, tInitial, 'Initial eventTime must be recorded');
  assert.strictEqual(order3.grossCommission, 80000);

  // Incoming webhook with older eventTime = 3,000,000
  const outOfOrderResult = upsertNetworkOrder(db, {
    orderSn: sn3,
    rawSubId: testUserCode,
    grossCommission: 30000,
    orderAmount: 300000,
    status: 'pending',
    platform: 'tiktok',
    eventTime: tOlder
  });

  assert.strictEqual(outOfOrderResult.grossCommission, 80000, 'Order amounts must NOT be updated by older webhook');
  assert.strictEqual(outOfOrderResult.eventTime, tInitial, 'eventTime must remain at newer value');

  // Newer webhook with eventTime = 7,000,000
  const newerResult = upsertNetworkOrder(db, {
    orderSn: sn3,
    rawSubId: testUserCode,
    grossCommission: 120000,
    orderAmount: 1200000,
    status: 'approved',
    platform: 'tiktok',
    eventTime: tNewer
  });

  assert.strictEqual(newerResult.status, 'approved', 'Newer event is accepted and transitions status');
  assert.strictEqual(newerResult.grossCommission, 120000, 'Newer event updates gross commission');
  assert.strictEqual(newerResult.eventTime, tNewer, 'eventTime advances to newer timestamp');
  console.log('  PASS: Out-of-order events rejected; newer events properly accepted and processed.');

  // ----------------------------------------------------
  // TEST 4: Cancellation of an approved order issues order_clawback and reduces balance cleanly
  // ----------------------------------------------------
  console.log('\n--- 4. Testing Cancellation & Clawback of Approved Order ---');
  const sn4 = `SN_TEST5_CLAW_${randSuffix}`;
  const order4 = upsertNetworkOrder(db, {
    orderSn: sn4,
    rawSubId: testUserCode,
    grossCommission: 150000,
    orderAmount: 1500000,
    status: 'approved',
    platform: 'shopee',
    productName: 'Đơn Hàng Sắp Bị Hủy',
    eventTime: baseTime + 1000
  });

  const creditedCashback4 = order4.userCashbackAmount;
  assert.ok(creditedCashback4 > 0, 'Cashback must be positive');

  // Recalculate wallet so user is credited in ledger
  recalculateUserWallet(testUserId);
  const balanceBeforeCancel = testUser.balanceAvailable;
  assert.ok(balanceBeforeCancel >= creditedCashback4, 'Balance must include credited cashback');

  // Now incoming valid event cancels the approved order
  const cancelledOrder4 = upsertNetworkOrder(db, {
    orderSn: sn4,
    status: 'cancelled',
    eventTime: baseTime + 2000
  });

  assert.strictEqual(cancelledOrder4.status, 'cancelled', 'Status must transition to cancelled');
  assert.ok(cancelledOrder4.clawbackAt, 'clawbackAt timestamp must be recorded');
  const parsedClawbackTime = new Date(cancelledOrder4.clawbackAt).getTime();
  assert.ok(Number.isFinite(parsedClawbackTime), 'clawbackAt must be a valid ISO date');

  // Verify ledger entry for clawback
  const clawbackRef = `clawback_${sn4}`;
  const clawbackEntry = db.ledger.find((l) => l.refId === clawbackRef);
  assert.ok(clawbackEntry, 'Ledger entry with refId clawback_SN must exist');
  assert.strictEqual(clawbackEntry.type, 'order_clawback', 'Ledger type must be order_clawback');
  assert.strictEqual(clawbackEntry.amount, -creditedCashback4, 'Clawback amount must exactly equal negative of credited cashback');

  // Verify wallet balance is reduced cleanly
  recalculateUserWallet(testUserId);
  const balanceAfterCancel = testUser.balanceAvailable;
  assert.strictEqual(balanceAfterCancel, balanceBeforeCancel - creditedCashback4, 'Available balance must be cleanly reduced by clawback amount');
  assert.strictEqual(testUser.hasNegativeBalance, false, 'User must not have negative balance');

  // ----------------------------------------------------
  // TEST 5: Idempotency of Clawback (Repeated cancellations do NOT create duplicate deductions)
  // ----------------------------------------------------
  console.log('\n--- 5. Testing Clawback Idempotency on Repeated Cancellation Events ---');
  const repeatCancel = upsertNetworkOrder(db, {
    orderSn: sn4,
    status: 'cancelled',
    eventTime: baseTime + 3000
  });

  const clawbackEntriesAfterRepeat = db.ledger.filter((l) => l.refId === clawbackRef);
  assert.strictEqual(clawbackEntriesAfterRepeat.length, 1, 'Only exactly 1 clawback entry must exist (no duplicate clawback)');

  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, balanceAfterCancel, 'Balance must remain identical after repeated cancellation events');
  console.log('  PASS: Clawback is completely idempotent across multiple webhook events.');

  // ----------------------------------------------------
  // TEST 6: Clawback with prior withdrawal: safe negative balance handling
  // ----------------------------------------------------
  console.log('\n--- 6. Testing Clawback With Prior Withdrawal (Negative Balance Safety) ---');
  const randSuffix2 = Math.floor(100000 + Math.random() * 900000);
  const testUserId2 = `${TEST_PREFIX}wd_${randSuffix2}`;
  const testUserCode2 = `U_ORD5_WD_${randSuffix2}`;

  const testUser2 = {
    id: testUserId2,
    code: testUserCode2,
    name: 'Test Clawback Withdrawn User',
    phone: `0955${randSuffix2}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0
  };
  db.users.push(testUser2);

  const sn6 = `SN_TEST5_WD_${randSuffix2}`;
  const order6 = upsertNetworkOrder(db, {
    orderSn: sn6,
    rawSubId: testUserCode2,
    grossCommission: 100000,
    orderAmount: 1000000,
    status: 'approved',
    platform: 'shopee'
  });

  const cashback6 = order6.userCashbackAmount;
  recalculateUserWallet(testUserId2);
  assert.strictEqual(testUser2.balanceAvailable, cashback6, 'User 2 should have exact cashback available');

  // User withdraws the full cashback amount
  const wdId = `wd_test5_${randSuffix2}`;
  db.withdrawals.push({
    id: wdId,
    userId: testUserId2,
    userCode: testUserCode2,
    amount: cashback6,
    status: 'paid',
    createdAt: new Date().toISOString()
  });

  recalculateUserWallet(testUserId2);
  assert.strictEqual(testUser2.balanceAvailable, 0, 'Available balance should be 0đ after full withdrawal');
  assert.strictEqual(testUser2.hasNegativeBalance, false);

  // Now network cancels the approved order -> clawback triggered
  upsertNetworkOrder(db, {
    orderSn: sn6,
    status: 'cancelled'
  });

  recalculateUserWallet(testUserId2);
  assert.strictEqual(testUser2.balanceAvailable, -cashback6, 'Available balance should accurately reflect -cashback');
  assert.strictEqual(testUser2.hasNegativeBalance, true, 'hasNegativeBalance must be flagged true');

  // Verify system audit reports clean integrity (mismatches = 0)
  const audit = auditLedgerIntegrity({ autoRepair: false });
  assert.strictEqual(audit.ok, true, 'Ledger sum and stored balance must match 100%');
  assert.strictEqual(audit.mismatchCount, 0, 'Zero ledger mismatches expected');
  console.log('  PASS: Clawback after withdrawal accurately transitions balance into negative without corruption.');

  // ----------------------------------------------------
  // TEST 7: Cancellation of an uncredited order does NOT generate phantom clawback
  // ----------------------------------------------------
  console.log('\n--- 7. Testing Cancellation of Uncredited Order (No Phantom Debit) ---');
  const sn7 = `SN_TEST5_UNCREDITED_${randSuffix}`;
  const order7 = {
    id: `ord_${Date.now()}_guest`,
    orderSn: sn7,
    platform: 'shopee',
    userCode: 'GUEST',
    userId: null,
    orderAmount: 500000,
    grossCommission: 50000,
    taxAmount: 5000,
    netCommission: 45000,
    totalCommission: 45000,
    cashbackRate: 70,
    userCashbackAmount: 31500,
    adminShareAmount: 13500,
    status: 'approved',
    createdAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.unshift(order7);

  // Cancel the uncredited order
  const cancelled7 = upsertNetworkOrder(db, {
    orderSn: sn7,
    status: 'cancelled'
  });

  assert.strictEqual(cancelled7.status, 'cancelled');
  const phantomClawback = db.ledger.find((l) => l.refId === `clawback_${sn7}`);
  assert.strictEqual(phantomClawback, undefined, 'No clawback entry should be created for uncredited order');
  console.log('  PASS: Uncredited orders do not create phantom clawback entries.');

  // Clean test data
  db.users = db.users.filter((u) => !u.id.startsWith(TEST_PREFIX));
  db.orders = db.orders.filter((o) => !o.orderSn.startsWith('SN_TEST5_'));
  db.ledger = db.ledger.filter((l) => !l.userId?.startsWith(TEST_PREFIX));
  db.withdrawals = db.withdrawals.filter((w) => w.id !== wdId);
  await saveDb(db);

  console.log('\n=== ALL 7 UPSERT ORDER VERIFICATION SUITES PASSED CLEANLY! ===\n');
  process.exit(0);
}

runUpsertOrderTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
