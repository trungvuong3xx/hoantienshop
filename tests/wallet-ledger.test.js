const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const logger = require('../src/utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  recalculateUserWallet,
  recalculateAllWallets,
  appendLedgerEntry,
  executeAtomicWithdrawal,
  refundWithdrawal,
  auditLedgerIntegrity,
  createToken,
  reloadStateFromPostgres,
  initPostgresIfConfigured
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

async function runWalletLedgerTests() {
  console.log('=== STARTING WALLET LEDGER TEST SUITE (P0 #3) ===');

  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // Clean any previous test users
  db.users = db.users.filter((u) => !u.id.startsWith('usr_test_p03_'));
  db.withdrawals = db.withdrawals.filter((w) => !w.id.startsWith('wd_test_p03_'));
  db.ledger = db.ledger.filter((l) => !l.userId?.startsWith('usr_test_p03_'));

  const randSuffix = Math.floor(100000 + Math.random() * 900000);
  const testUserId = `usr_test_p03_${randSuffix}`;
  const testUser = {
    id: testUserId,
    code: `U_P03_${randSuffix}`,
    name: 'Test P03 User',
    phone: `0977${randSuffix}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    bankName: 'Vietcombank',
    bankAccount: '999888777',
    bankOwner: 'TEST USER P03'
  };
  db.users.push(testUser);

  // Credit initial 1,000,000đ into user's wallet
  const initialCreditRef = `init_credit_p03_${Date.now()}`;
  appendLedgerEntry(testUserId, 'order_cashback', 1000000, initialCreditRef, 'Initial 1M cashback');
  recalculateUserWallet(testUserId);
  await saveDb(db);
  assert.strictEqual(testUser.balanceAvailable, 1000000, 'User should start with exactly 1,000,000đ available');

  // ----------------------------------------------------
  // TEST 1: Pending withdrawal creation and ledger lock
  // ----------------------------------------------------
  console.log('\n--- 1. Testing Pending Withdrawal Creation & Debit Lock ---');
  const withdrawAmount = 300000;
  const wdRes = await executeAtomicWithdrawal({
    userId: testUserId,
    amount: withdrawAmount,
    method: 'bank',
    bankName: 'Vietcombank',
    bankAccount: '999888777',
    bankOwner: 'TEST USER P03',
    minWithdraw: 50000
  });

  const createdWd = wdRes.withdrawal;
  assert.ok(createdWd, 'Withdrawal should be successfully created');
  assert.strictEqual(createdWd.amount, 300000, 'Withdrawal amount must be 300,000đ');
  assert.strictEqual(createdWd.status, 'pending', 'Withdrawal status must be pending');

  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 700000, 'Available balance must be exactly 700,000đ (1,000,000 - 300,000)');

  const debitEntry = db.ledger.find((l) => l.refId === `withdraw_debit_${createdWd.id}`);
  assert.ok(debitEntry, 'Debit lock ledger entry must exist');
  assert.strictEqual(debitEntry.amount, -300000, 'Debit lock amount must be -300,000đ');
  console.log('  PASS: Withdrawal created and available balance debited by exactly 300,000đ.');

  // ----------------------------------------------------
  // TEST 2: Rejection of pending withdrawal credits exactly the withdrawal amount (not double)
  // ----------------------------------------------------
  console.log('\n--- 2. Testing Rejection Credits Exactly Once (No Double Refund) ---');
  const adminUser = db.users.find((u) => u.role === 'admin') || {
    id: 'admin_test_p03',
    code: 'ADMIN_P03',
    role: 'admin',
    phone: '0999888777',
    passwordHash: 'scrypt$dummy'
  };
  if (!db.users.some((u) => u.id === adminUser.id)) {
    db.users.push(adminUser);
  }

  await refundWithdrawal(db, createdWd, adminUser);
  assert.strictEqual(createdWd.status, 'rejected', 'Withdrawal status must transition to rejected');

  recalculateUserWallet(testUserId);
  assert.strictEqual(
    testUser.balanceAvailable,
    1000000,
    'Available balance must be restored to exactly 1,000,000đ (+300,000 refund, NOT +600,000 double refund)'
  );

  const refundEntries = db.ledger.filter((l) => l.refId === `withdraw_refund_${createdWd.id}`);
  assert.strictEqual(refundEntries.length, 1, 'Exactly one refund ledger entry must exist for this withdrawal');
  assert.strictEqual(refundEntries[0].amount, 300000, 'Refund entry amount must be exactly +300,000đ');
  console.log('  PASS: Withdrawal rejection restored balance to 1,000,000đ with exactly one refund entry.');

  // ----------------------------------------------------
  // TEST 3: Calling reject again or recalculate again does not duplicate refund
  // ----------------------------------------------------
  console.log('\n--- 3. Testing Idempotency: Repeated Reject & Recalculate Does Not Duplicate ---');
  // Call refundWithdrawal again on the already-rejected withdrawal
  await refundWithdrawal(db, createdWd, adminUser);
  assert.strictEqual(
    testUser.balanceAvailable,
    1000000,
    'Balance must stay exactly 1,000,000đ after calling refundWithdrawal again'
  );

  const refundsAfterSecondCall = db.ledger.filter((l) => l.refId === `withdraw_refund_${createdWd.id}`);
  assert.strictEqual(refundsAfterSecondCall.length, 1, 'Refund count must remain exactly 1');

  // Call recalculateUserWallet 5 times consecutively
  for (let i = 0; i < 5; i++) {
    recalculateUserWallet(testUserId);
    assert.strictEqual(
      testUser.balanceAvailable,
      1000000,
      `Balance must remain 1,000,000đ on recalculation iteration ${i + 1}`
    );
  }

  // Call recalculateAllWallets
  recalculateAllWallets({ persist: false });
  assert.strictEqual(
    testUser.balanceAvailable,
    1000000,
    'Balance must remain 1,000,000đ after recalculateAllWallets'
  );

  const refundsAfterRecalculates = db.ledger.filter((l) => l.refId === `withdraw_refund_${createdWd.id}`);
  assert.strictEqual(refundsAfterRecalculates.length, 1, 'Refund count must still be exactly 1');
  console.log('  PASS: Multiple reject calls and recalculations maintain strict idempotency.');

  // ----------------------------------------------------
  // TEST 4: HTTP API Rejection and Cancel Endpoints
  // ----------------------------------------------------
  console.log('\n--- 4. Testing HTTP API Endpoints (/api/admin/withdrawals/update & cancel) ---');
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const adminAuthToken = createToken(adminUser);

  // Create another pending withdrawal of 200,000đ for API testing
  const apiWdRes = await executeAtomicWithdrawal({
    userId: testUserId,
    amount: 200000,
    method: 'bank',
    bankName: 'Vietcombank',
    bankAccount: '999888777',
    bankOwner: 'TEST USER P03',
    minWithdraw: 50000
  });
  const apiWd = apiWdRes.withdrawal;
  assert.strictEqual(testUser.balanceAvailable, 800000, 'Balance must be 800,000đ after withdrawing 200,000đ');

  // Test /api/admin/withdrawals/cancel
  const cancelRes = await fetch(`http://127.0.0.1:${port}/api/admin/withdrawals/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminAuthToken}`
    },
    body: JSON.stringify({ id: apiWd.id })
  });
  assert.strictEqual(cancelRes.status, 200, 'Cancel endpoint should return 200');
  const cancelData = await cancelRes.json();
  assert.strictEqual(cancelData.status, 'ok', 'Response status must be ok');

  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 1000000, 'Balance must be restored to 1,000,000đ after cancel');

  // Attempt to cancel again (must return 400 error and not duplicate refund)
  const cancelAgainRes = await fetch(`http://127.0.0.1:${port}/api/admin/withdrawals/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminAuthToken}`
    },
    body: JSON.stringify({ id: apiWd.id })
  });
  assert.strictEqual(cancelAgainRes.status, 400, 'Cancelling already cancelled withdrawal must return 400');
  await cancelAgainRes.json().catch(() => null);

  recalculateUserWallet(testUserId);
  assert.strictEqual(testUser.balanceAvailable, 1000000, 'Balance must stay 1,000,000đ (no double refund)');

  const apiRefunds = db.ledger.filter((l) => l.refId === `withdraw_refund_${apiWd.id}`);
  assert.strictEqual(apiRefunds.length, 1, 'Only one refund ledger entry must exist for api withdrawal');

  await new Promise((resolve) => server.close(resolve));
  console.log('  PASS: HTTP cancel API correctly rejects repeated cancellations and prevents double refunds.');

  // ----------------------------------------------------
  // TEST 5: Protection Against NaN, Null, and Negative Amounts in refundWithdrawal & executeAtomicWithdrawal
  // ----------------------------------------------------
  console.log('\n--- 5. Testing NaN, Null & Negative Amount Guards ---');

  // refundWithdrawal with NaN amount
  await assert.rejects(
    async () => {
      await refundWithdrawal(db, { id: 'wd_bad_nan', userId: testUserId, amount: NaN, status: 'pending' }, adminUser);
    },
    /Invalid withdrawal amount/,
    'refundWithdrawal must throw Invalid withdrawal amount for NaN'
  );

  // refundWithdrawal with null amount
  await assert.rejects(
    async () => {
      await refundWithdrawal(db, { id: 'wd_bad_null', userId: testUserId, amount: null, status: 'pending' }, adminUser);
    },
    /Invalid withdrawal amount/,
    'refundWithdrawal must throw Invalid withdrawal amount for null'
  );

  // refundWithdrawal with negative amount
  await assert.rejects(
    async () => {
      await refundWithdrawal(db, { id: 'wd_bad_neg', userId: testUserId, amount: -50000, status: 'pending' }, adminUser);
    },
    /Invalid withdrawal amount/,
    'refundWithdrawal must throw Invalid withdrawal amount for negative amounts'
  );

  // refundWithdrawal with string non-numeric amount
  await assert.rejects(
    async () => {
      await refundWithdrawal(db, { id: 'wd_bad_str', userId: testUserId, amount: 'abc_invalid', status: 'pending' }, adminUser);
    },
    /Invalid withdrawal amount/,
    'refundWithdrawal must throw Invalid withdrawal amount for non-numeric strings'
  );

  // refundWithdrawal with 0 amount
  await assert.rejects(
    async () => {
      await refundWithdrawal(db, { id: 'wd_bad_zero', userId: testUserId, amount: 0, status: 'pending' }, adminUser);
    },
    /Invalid withdrawal amount/,
    'refundWithdrawal must throw Invalid withdrawal amount for 0 amount'
  );

  // executeAtomicWithdrawal with NaN
  await assert.rejects(
    async () => {
      await executeAtomicWithdrawal({
        userId: testUserId,
        amount: NaN,
        method: 'bank',
        bankName: 'Vietcombank',
        bankAccount: '999888777',
        bankOwner: 'TEST USER P03'
      });
    },
    /Số tiền rút phải lớn hơn 0đ/,
    'executeAtomicWithdrawal must reject NaN amount'
  );

  // executeAtomicWithdrawal with null
  await assert.rejects(
    async () => {
      await executeAtomicWithdrawal({
        userId: testUserId,
        amount: null,
        method: 'bank',
        bankName: 'Vietcombank',
        bankAccount: '999888777',
        bankOwner: 'TEST USER P03'
      });
    },
    /Số tiền rút phải lớn hơn 0đ/,
    'executeAtomicWithdrawal must reject null amount'
  );

  // executeAtomicWithdrawal with negative amount
  await assert.rejects(
    async () => {
      await executeAtomicWithdrawal({
        userId: testUserId,
        amount: -100000,
        method: 'bank',
        bankName: 'Vietcombank',
        bankAccount: '999888777',
        bankOwner: 'TEST USER P03'
      });
    },
    /Số tiền rút phải lớn hơn 0đ/,
    'executeAtomicWithdrawal must reject negative amount'
  );

  console.log('  PASS: All NaN, null, zero, negative, and invalid withdrawal attempts strictly rejected.');

  // ----------------------------------------------------
  // TEST 6: Resilience of recalculateUserWallet against corrupted records
  // ----------------------------------------------------
  console.log('\n--- 6. Testing recalculateUserWallet Resilience Against Corrupted Records ---');

  // Push a malformed withdrawal directly to db.withdrawals
  const rogueWd = {
    id: `wd_test_p03_rogue_${Date.now()}`,
    userId: testUserId,
    amount: NaN,
    status: 'pending',
    bankName: 'Vietcombank'
  };
  db.withdrawals.push(rogueWd);

  // Recalculate should skip the corrupted withdrawal without adding NaN to ledger
  recalculateUserWallet(testUserId);
  assert.ok(Number.isFinite(testUser.balanceAvailable), 'User balanceAvailable must remain a valid finite number');
  assert.ok(Number.isFinite(testUser.totalWithdrawn), 'User totalWithdrawn must remain a valid finite number');
  assert.strictEqual(testUser.balanceAvailable, 1000000, 'Balance must remain 1,000,000đ');

  const rogueDebit = db.ledger.find((l) => l.refId === `withdraw_debit_${rogueWd.id}`);
  assert.strictEqual(rogueDebit, undefined, 'No ledger entry should be created for rogue NaN withdrawal');

  // Ensure no entry in db.ledger contains NaN amount
  for (const entry of db.ledger) {
    assert.ok(
      Number.isFinite(entry.amount),
      `Ledger entry #${entry.id} (${entry.refId}) has non-finite amount: ${entry.amount}`
    );
    assert.notStrictEqual(entry.amount, 0, `Ledger entry #${entry.id} has 0 amount`);
  }
  console.log('  PASS: recalculateUserWallet safely handles corrupted DB records without ledger pollution.');

  // ----------------------------------------------------
  // TEST 7: Full Ledger Audit Integrity
  // ----------------------------------------------------
  console.log('\n--- 7. Testing Full Ledger Audit Integrity ---');
  const audit = auditLedgerIntegrity({ autoRepair: false });
  assert.strictEqual(audit.ok, true, `Audit must pass cleanly, mismatches: ${JSON.stringify(audit.mismatches)}`);
  assert.strictEqual(audit.mismatchCount, 0, 'Mismatch count must be 0');
  console.log('  PASS: System-wide audit confirms 100% ledger integrity.');

  // Clean up test data
  db.users = db.users.filter((u) => u.id !== testUserId);
  db.withdrawals = db.withdrawals.filter((w) => w.userId !== testUserId);
  db.ledger = db.ledger.filter((l) => l.userId !== testUserId);
  await saveDb(db);

  console.log('\n=== ALL WALLET LEDGER TESTS PASSED SUCCESSFULLY! ===\n');
  setTimeout(() => process.exit(0), 100);
}

runWalletLedgerTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
