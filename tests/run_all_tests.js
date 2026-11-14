/**
 * Master Test Runner: Comprehensive System Audit & Verification
 * Task 15 (Phần 4 & 6: Kiểm Thử Toàn Diện & Kế Hoạch Phát Hành)
 *
 * Sequentially executes all project test suites in isolated child processes,
 * tracks durations, aggregates pass/fail results, and produces a comprehensive summary.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TEST_SUITES = [
  'clicks-ttl.test.js',
  'referral_sync.test.js',
  'wallet-ledger.test.js',
  'test_concurrency_lock.js',
  'test_upsert_order.js',
  'test_webhook_security.js',
  'test_shopee_sync_schema.js',
  'test_p1_backend_fixes.js',
  'test_p1_frontend_fixes.js',
  'test_p2_polish.js',
  'zalo.test.js',
  'test_zalo_frontend.js',
  'test_zalo_admin_ui.js',
  'test_zalo_safety_faq.js',
  'test_url_resolver.js',
  'test_audit_round2.js',
  'test_manual_checklist_simulation.js'
];

async function runAllTests() {
  const overallStartTime = Date.now();
  console.log('================================================================');
  console.log('     COMPREHENSIVE SYSTEM VERIFICATION & AUDIT TEST RUNNER      ');
  console.log('================================================================');
  console.log(`Found ${TEST_SUITES.length} test suites to execute.\n`);

  const results = [];
  let allPassed = true;

  for (let i = 0; i < TEST_SUITES.length; i++) {
    const suiteName = TEST_SUITES[i];
    const suitePath = path.join(__dirname, suiteName);
    const indexStr = `[${i + 1}/${TEST_SUITES.length}]`;

    console.log(`\n${'='.repeat(64)}`);
    console.log(`${indexStr} RUNNING: tests/${suiteName}`);
    console.log(`${'='.repeat(64)}`);

    const startTime = Date.now();
    const child = spawnSync(process.execPath, [suitePath], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' }
    });
    const duration = Date.now() - startTime;

    const passed = child.status === 0;
    if (!passed) {
      allPassed = false;
    }

    results.push({
      name: suiteName,
      passed,
      exitCode: child.status,
      duration
    });

    console.log(`--> ${suiteName}: ${passed ? 'PASSED ✔' : 'FAILED ✖'} (${duration}ms)`);
  }

  const overallDuration = ((Date.now() - overallStartTime) / 1000).toFixed(2);

  console.log('\n\n================================================================');
  console.log('                 TEST EXECUTION SUMMARY REPORT                  ');
  console.log('================================================================');

  let passedCount = 0;
  let failedCount = 0;

  results.forEach((r, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    const namePad = r.name.padEnd(38, ' ');
    const status = r.passed ? 'PASS ✔' : `FAIL ✖ (code ${r.exitCode})`;
    const durPad = `${r.duration}ms`.padStart(8, ' ');
    console.log(`${num}. ${namePad} ${status.padEnd(16, ' ')} ${durPad}`);
    if (r.passed) passedCount++;
    else failedCount++;
  });

  console.log('----------------------------------------------------------------');
  console.log(`Total Test Suites: ${TEST_SUITES.length}`);
  console.log(`Passed Suites:     ${passedCount} / ${TEST_SUITES.length} (${((passedCount / TEST_SUITES.length) * 100).toFixed(1)}%)`);
  console.log(`Failed Suites:     ${failedCount}`);
  console.log(`Total Elapsed:     ${overallDuration}s`);
  console.log('================================================================\n');

  if (allPassed) {
    console.log('🎉 ALL SYSTEM AUDIT & REGRESSION TESTS PASSED CLEANLY (100%)!\n');
    process.exit(0);
  } else {
    console.error('❌ SOME TEST SUITES FAILED. PLEASE INSPECT LOGS ABOVE.\n');
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
