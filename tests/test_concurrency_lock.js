/**
 * Comprehensive Concurrency & Mutex Verification Test Suite
 * Tests: withUserLock FIFO serialization, zero lost updates, multi-user isolation,
 * error recovery without deadlocks, and financial balance integrity under concurrent mutations.
 */

const assert = require('assert');
const crypto = require('crypto');
const {
  ensureDbLoaded,
  saveDb,
  withUserLock,
  appendLedgerEntry,
  recalculateUserWallet,
  executeAtomicWithdrawal,
  auditLedgerIntegrity,
  initPostgresIfConfigured,
  reloadStateFromPostgres
} = require('../src/services/dbService');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runConcurrencyLockTests() {
  console.log('=== STARTING CONCURRENCY & USER MUTEX VERIFICATION SUITE ===\n');

  // Initialize Postgres if configured
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // ----------------------------------------------------
  // TEST 1: Serial Execution Guarantee & Zero Lost Updates
  // ----------------------------------------------------
  console.log('--- 1. Testing Single-User FIFO Serialization & Zero Lost Updates ---');
  {
    const userId = `usr_concurrency_test_${Date.now()}`;
    const N = 25;
    let activeWorkers = 0;
    let overlapCount = 0;
    let counter = 0;

    const tasks = Array.from({ length: N }, (_, idx) => {
      return withUserLock(userId, async () => {
        if (activeWorkers > 0) {
          overlapCount++;
        }
        activeWorkers++;

        // Read phase
        const current = counter;
        // Introduce asynchronous jitter to maximize race hazard if lock was broken
        await sleep(5 + Math.floor(Math.random() * 15));
        // Write phase
        counter = current + 1;

        activeWorkers--;
        return { idx, counter };
      });
    });

    const results = await Promise.all(tasks);

    assert.strictEqual(overlapCount, 0, `Critical failure: ${overlapCount} overlapping executions detected inside critical section!`);
    assert.strictEqual(counter, N, `Lost update detected! Expected counter ${N}, got ${counter}`);
    assert.strictEqual(results.length, N, `Expected ${N} completed task results`);
    console.log(`  PASS: ${N} concurrent tasks serialized flawlessly with 0 overlaps and 0 lost updates.`);
  }

  // ----------------------------------------------------
  // TEST 2: Multi-User Isolation (Different Users Do Not Block Each Other)
  // ----------------------------------------------------
  console.log('\n--- 2. Testing Independent Mutex Keys (User A vs User B Parallelism) ---');
  {
    const userA = `usr_test_user_a_${Date.now()}`;
    const userB = `usr_test_user_b_${Date.now()}`;

    let activeA = 0;
    let activeB = 0;
    let maxConcurrentTotal = 0;
    let counterA = 0;
    let counterB = 0;

    const runWorker = (userKey, isA) => {
      return withUserLock(userKey, async () => {
        if (isA) activeA++;
        else activeB++;

        const currentTotal = activeA + activeB;
        if (currentTotal > maxConcurrentTotal) {
          maxConcurrentTotal = currentTotal;
        }

        if (isA) {
          assert.strictEqual(activeA, 1, 'User A had concurrent internal executions!');
          const cur = counterA;
          await sleep(20);
          counterA = cur + 1;
          activeA--;
        } else {
          assert.strictEqual(activeB, 1, 'User B had concurrent internal executions!');
          const cur = counterB;
          await sleep(20);
          counterB = cur + 1;
          activeB--;
        }
      });
    };

    const tasksA = Array.from({ length: 5 }, () => runWorker(userA, true));
    const tasksB = Array.from({ length: 5 }, () => runWorker(userB, false));

    await Promise.all([...tasksA, ...tasksB]);

    assert.strictEqual(counterA, 5, `User A counter expected 5, got ${counterA}`);
    assert.strictEqual(counterB, 5, `User B counter expected 5, got ${counterB}`);
    assert.ok(maxConcurrentTotal > 1, `Expected parallel execution between User A and User B (maxConcurrentTotal was ${maxConcurrentTotal})`);
    console.log(`  PASS: Mutexes are strictly partitioned per user key (Parallel execution observed: ${maxConcurrentTotal} concurrent users).`);
  }

  // ----------------------------------------------------
  // TEST 3: Error Isolation & Deadlock Prevention
  // ----------------------------------------------------
  console.log('\n--- 3. Testing Error Isolation & Mutex Deadlock Recovery ---');
  {
    const userId = `usr_test_error_recovery_${Date.now()}`;
    let task2Executed = false;
    let task3Executed = false;

    // Task 1: Rejects with error
    const p1 = withUserLock(userId, async () => {
      await sleep(10);
      throw new Error('Simulated critical failure in locked task');
    }).catch((err) => err);

    // Task 2: Should proceed immediately after Task 1 releases lock
    const p2 = withUserLock(userId, async () => {
      await sleep(10);
      task2Executed = true;
      return 'task2_ok';
    });

    // Task 3: Should also proceed normally
    const p3 = withUserLock(userId, async () => {
      task3Executed = true;
      return 'task3_ok';
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.ok(r1 instanceof Error, 'Task 1 should have caught the thrown error');
    assert.strictEqual(r1.message, 'Simulated critical failure in locked task');
    assert.strictEqual(r2, 'task2_ok', 'Task 2 should execute cleanly');
    assert.strictEqual(r3, 'task3_ok', 'Task 3 should execute cleanly');
    assert.strictEqual(task2Executed, true, 'Task 2 executed flag not set');
    assert.strictEqual(task3Executed, true, 'Task 3 executed flag not set');
    console.log('  PASS: Thrown errors safely release the lock and do not deadlock subsequent queued operations.');
  }

  // ----------------------------------------------------
  // TEST 4: Concurrent Financial Balance & Ledger Transactions
  // ----------------------------------------------------
  console.log('\n--- 4. Testing Concurrent Financial Mutations & Ledger Accounting ---');
  {
    const testUserId = `usr_fin_test_${Date.now()}`;
    const testUser = {
      id: testUserId,
      code: `U_FIN_${Math.floor(Math.random() * 100000)}`,
      name: 'Nguyen Van Concurrency',
      phone: `099${Math.floor(1000000 + Math.random() * 9000000)}`,
      passwordHash: 'dummyhash',
      role: 'user',
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      accountLocked: false
    };
    db.users.push(testUser);

    // Initial seed: 500,000đ
    const initRef = `seed_${Date.now()}`;
    appendLedgerEntry(testUserId, 'admin_adjustment', 500000, initRef, 'Nạp tiền khởi tạo');
    recalculateUserWallet(testUserId, { persist: false });
    await saveDb(db);

    assert.strictEqual(testUser.balanceAvailable, 500000);

    // Launch 20 concurrent transactions:
    // - 10 deposits of +50,000đ (+500,000đ)
    // - 10 debits of -20,000đ (-200,000đ)
    // Net expected change: +300,000đ -> Final balance: 800,000đ
    const operations = [];
    for (let i = 0; i < 10; i++) {
      operations.push({ type: 'cashback_confirmed', amount: 50000, note: `Bonus #${i}` });
      operations.push({ type: 'admin_adjustment', amount: -20000, note: `Fee #${i}` });
    }

    // Shuffle operations to maximize race hazards
    operations.sort(() => Math.random() - 0.5);

    const promises = operations.map((op, idx) => {
      return withUserLock(testUserId, async () => {
        await sleep(5 + Math.floor(Math.random() * 10));
        const refId = `concurr_op_${Date.now()}_${idx}_${crypto.randomBytes(2).toString('hex')}`;
        appendLedgerEntry(testUserId, op.type, op.amount, refId, op.note);
        recalculateUserWallet(testUserId, { persist: false });
        await saveDb(db);
        return op.amount;
      });
    });

    await Promise.all(promises);

    recalculateUserWallet(testUserId, { persist: false });
    assert.strictEqual(
      testUser.balanceAvailable,
      800000,
      `Financial balance mismatch! Expected 800,000đ, got ${testUser.balanceAvailable}`
    );

    const audit = auditLedgerIntegrity({ autoRepair: false });
    assert.strictEqual(audit.ok, true, 'Ledger integrity audit failed after concurrent transactions!');
    console.log('  PASS: 20 concurrent financial mutations executed with 100% ledger & wallet precision (800,000đ).');
  }

  // ----------------------------------------------------
  // TEST 5: Concurrent Withdrawal Double-Spend / Overdraft Protection
  // ----------------------------------------------------
  console.log('\n--- 5. Testing Concurrent Withdrawal Double-Spend Prevention ---');
  {
    const wdUserId = `usr_test_overdraft_${Date.now()}`;
    const wdUser = {
      id: wdUserId,
      code: `U_OD_${Math.floor(Math.random() * 100000)}`,
      name: 'Nguyen Van Overdraft',
      phone: `098${Math.floor(1000000 + Math.random() * 9000000)}`,
      passwordHash: 'dummyhash',
      role: 'user',
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      accountLocked: false
    };
    db.users.push(wdUser);

    // Initial balance: 100,000đ
    appendLedgerEntry(wdUserId, 'admin_adjustment', 100000, `init_od_${Date.now()}`, 'Initial balance');
    recalculateUserWallet(wdUserId, { persist: false });
    await saveDb(db);
    assert.strictEqual(wdUser.balanceAvailable, 100000);

    // Fire 2 concurrent withdrawals of 70,000đ each (Total: 140,000đ > 100,000đ)
    const wdReq1 = executeAtomicWithdrawal({
      userId: wdUserId,
      amount: 70000,
      method: 'bank',
      bankName: 'MBBank',
      bankAccount: '123456789',
      bankOwner: 'NGUYEN VAN OVERDRAFT',
      minWithdraw: 50000
    }).then(
      (res) => ({ success: true, res }),
      (err) => ({ success: false, error: err.message })
    );

    const wdReq2 = executeAtomicWithdrawal({
      userId: wdUserId,
      amount: 70000,
      method: 'bank',
      bankName: 'MBBank',
      bankAccount: '123456789',
      bankOwner: 'NGUYEN VAN OVERDRAFT',
      minWithdraw: 50000
    }).then(
      (res) => ({ success: true, res }),
      (err) => ({ success: false, error: err.message })
    );

    const [r1, r2] = await Promise.all([wdReq1, wdReq2]);

    const successes = [r1, r2].filter((r) => r.success);
    const failures = [r1, r2].filter((r) => !r.success);

    assert.strictEqual(successes.length, 1, 'Exactly one withdrawal should succeed');
    assert.strictEqual(failures.length, 1, 'Exactly one withdrawal should be rejected due to insufficient balance');
    assert.ok(
      failures[0].error.includes('không đủ'),
      `Expected insufficient balance error message, got: ${failures[0].error}`
    );

    recalculateUserWallet(wdUserId, { persist: false });
    assert.strictEqual(
      wdUser.balanceAvailable,
      30000,
      `Balance after one successful withdrawal should be 30,000đ, got ${wdUser.balanceAvailable}`
    );
    console.log('  PASS: Double-spending successfully blocked; exactly 1 withdrawal succeeded, 1 rejected.');
  }

  // ----------------------------------------------------
  // TEST 6: Atomic Order Attribution & Wallet Mutex
  // ----------------------------------------------------
  console.log('\n--- 6. Testing Order Attribution & Claim Concurrency ---');
  {
    const claimUserId = `usr_claim_test_${Date.now()}`;
    const claimUser = {
      id: claimUserId,
      code: `U_CLM_${Math.floor(Math.random() * 100000)}`,
      name: 'Nguyen Van Claim',
      phone: `097${Math.floor(1000000 + Math.random() * 9000000)}`,
      passwordHash: 'dummyhash',
      role: 'user',
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      accountLocked: false
    };
    db.users.push(claimUser);

    const testSn = `SN_CONCURR_${Date.now()}`;
    const testOrder = {
      id: `ord_${Date.now()}`,
      orderSn: testSn,
      platform: 'shopee',
      clickId: null,
      userCode: 'GUEST',
      userId: null,
      productName: 'Tai nghe Bluetooth',
      orderAmount: 500000,
      grossCommission: 50000,
      taxAmount: 5000,
      netCommission: 45000,
      cashbackRate: 70,
      userCashbackAmount: 31500,
      adminShareAmount: 13500,
      status: 'approved',
      hasCustomCashback: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.orders.unshift(testOrder);

    // Simulate concurrent claim operations for the order
    const claimTask1 = withUserLock(claimUserId, async () => {
      await sleep(10);
      if (!testOrder.userId) {
        testOrder.userId = claimUserId;
        testOrder.userCode = claimUser.code;
        recalculateUserWallet(claimUserId, { persist: false });
        await saveDb(db);
        return { claimed: true };
      }
      return { claimed: false, alreadyAttributed: true };
    });

    const claimTask2 = withUserLock(claimUserId, async () => {
      await sleep(10);
      if (!testOrder.userId) {
        testOrder.userId = claimUserId;
        testOrder.userCode = claimUser.code;
        recalculateUserWallet(claimUserId, { persist: false });
        await saveDb(db);
        return { claimed: true };
      }
      return { claimed: false, alreadyAttributed: true };
    });

    const [c1, c2] = await Promise.all([claimTask1, claimTask2]);

    assert.strictEqual(testOrder.userId, claimUserId);
    assert.ok(
      (c1.claimed && !c2.claimed) || (!c1.claimed && c2.claimed),
      'Order should be claimed once without race condition'
    );
    console.log('  PASS: Order claim & attribution executed serially under user lock.');
  }

  console.log('\n=== ALL 6 CONCURRENCY & MUTEX TEST SUITES PASSED CLEANLY! ===');
  process.exit(0);
}

runConcurrencyLockTests().catch((err) => {
  console.error('\nCONCURRENCY LOCK TEST FAILED:', err);
  process.exit(1);
});
