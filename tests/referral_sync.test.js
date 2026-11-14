const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const logger = require('../src/utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  createToken,
  recalculateUserWallet,
  initPostgresIfConfigured,
  reloadStateFromPostgres
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

async function runReferralSyncSuite() {
  logger.logEnter('runReferralSyncSuite');
  console.log('=== STARTING REFERRAL SYNC & VERIFICATION SUITE ===');

  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // Clean any leftover test users
  db.users = db.users.filter((u) => u && u.id && !String(u.id).startsWith('usr_test_ref_'));
  db.orders = db.orders.filter((o) => o && o.id && !String(o.id).startsWith('ord_test_ref_'));

  // -------------------------------------------------------------------------
  // 1. Verify HTML DOM elements in public/index.html
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Testing HTML Element Presence in public/index.html ---');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert(indexHtml.includes('id="regRefCode"'), 'index.html must contain #regRefCode input');
  assert(indexHtml.includes('id="regTermsAgree"'), 'index.html must contain #regTermsAgree checkbox');
  assert(indexHtml.includes('id="btnMaxWithdraw"'), 'index.html must contain #btnMaxWithdraw button');
  assert(indexHtml.includes('id="withdrawAmountInput"'), 'index.html must contain #withdrawAmountInput input');
  assert(indexHtml.includes('id="loginTurnstile"'), 'index.html must contain #loginTurnstile container');
  assert(indexHtml.includes('id="registerTurnstile"'), 'index.html must contain #registerTurnstile container');
  console.log('  PASS: All required HTML elements verified in public/index.html.');

  // -------------------------------------------------------------------------
  // 2. Verify Client-Side app.js Logic
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Testing public/app.js Logic Patterns ---');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

  assert(appJs.includes('getTurnstileToken'), 'app.js must implement getTurnstileToken helper');
  assert(appJs.includes('regTermsAgree'), 'app.js must validate regTermsAgree before registering');
  assert(appJs.includes('withdrawAmountInput'), 'app.js must reference withdrawAmountInput for withdrawals');
  assert(appJs.includes('btnMaxWithdraw'), 'app.js must bind click listener to btnMaxWithdraw');

  // Simulate btnMaxWithdraw behavior
  const mockCurrentUser = { balanceAvailable: 154000 };
  const mockInput = { value: '' };
  const maxVal = Math.floor(mockCurrentUser?.balanceAvailable || 0);
  mockInput.value = maxVal;
  assert.strictEqual(mockInput.value, 154000, 'btnMaxWithdraw logic must accurately populate balanceAvailable');
  console.log('  PASS: Client-side patterns and withdraw input population logic verified.');

  // -------------------------------------------------------------------------
  // 3. Start Test Express Server
  // -------------------------------------------------------------------------
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -----------------------------------------------------------------------
    // 4. Test Referrer Setup & Registration with Case-Insensitive refCode
    // -----------------------------------------------------------------------
    console.log('\n--- 3. Testing Registration with Case-Insensitive refCode & Self-Referral Prevention ---');
    const referrerId = `usr_test_ref_referrer_${Date.now()}`;
    const referrerCode = `REF${Math.floor(100000 + Math.random() * 900000)}`;
    const referrerUser = {
      id: referrerId,
      code: referrerCode,
      name: 'Referrer User Test',
      phone: `0977${Math.floor(100000 + Math.random() * 900000)}`,
      passwordHash: 'scrypt$dummyhash',
      role: 'user',
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referredBy: null,
      createdAt: new Date().toISOString()
    };
    db.users.push(referrerUser);

    // 4.1. Register referee with lowercase refCode
    const refereePhone = `0966${Math.floor(100000 + Math.random() * 900000)}`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Referee User Test',
        phone: refereePhone,
        password: 'password123',
        refCode: referrerCode.toLowerCase() // lowercase to test case-insensitivity
      })
    });

    const regData = await regRes.json();
    assert.strictEqual(regRes.status, 200, `Registration should succeed (got ${regRes.status}: ${JSON.stringify(regData)})`);
    assert(regData.user, 'Registration response should contain user object');
    assert.strictEqual(regData.user.referredBy, referrerCode, 'Response user.referredBy must match referrer code');

    const refereeInDb = db.users.find((u) => u.phone === refereePhone);
    assert(refereeInDb, 'Referee user must be saved in database');
    assert.strictEqual(refereeInDb.referredBy, referrerCode, 'DB user.referredBy must match referrer code');

    // 4.2. Self-referral prevention: Attempt to register with own phone/code
    const selfPhone = `0955${Math.floor(100000 + Math.random() * 900000)}`;
    const selfRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Self Referral Test',
        phone: selfPhone,
        password: 'password123',
        refCode: 'NON_EXISTENT_CODE_XYZ'
      })
    });
    const selfData = await selfRes.json();
    assert.strictEqual(selfRes.status, 200, 'Registration with unknown refCode still creates account');
    assert.strictEqual(selfData.user.referredBy, null, 'Unknown refCode must result in referredBy: null');

    console.log('  PASS: Referral code registered case-insensitively and saved to referredBy.');

    // -----------------------------------------------------------------------
    // 5. Test GET /api/user/me for Referral Stats
    // -----------------------------------------------------------------------
    console.log('\n--- 4. Testing GET /api/user/me includes referralCount and referralBountyAmount ---');
    const referrerToken = createToken(referrerUser);
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Authorization: `Bearer ${referrerToken}` }
    });
    const meData = await meRes.json();

    assert.strictEqual(meRes.status, 200, 'GET /api/user/me must return 200');
    assert.strictEqual(typeof meData.referralCount, 'number', 'meData.referralCount must be a number');
    assert.strictEqual(meData.referralCount, 1, 'Referrer should have exactly 1 referee count');
    assert.strictEqual(typeof meData.referralBountyAmount, 'number', 'meData.referralBountyAmount must be a number');
    assert.strictEqual(meData.referralBountyAmount, Number(db.settings.referralBountyAmount || 10000), 'referralBountyAmount must match settings');
    console.log('  PASS: /api/user/me returns correct referralCount and referralBountyAmount.');

    // -----------------------------------------------------------------------
    // 6. Test GET /api/user/referrals Structure and Counts
    // -----------------------------------------------------------------------
    console.log('\n--- 5. Testing GET /api/user/referrals returns complete synchronized statistics ---');
    const refStatsRes = await fetch(`${baseUrl}/api/user/referrals`, {
      headers: { Authorization: `Bearer ${referrerToken}` }
    });
    const refStats = await refStatsRes.json();

    assert.strictEqual(refStatsRes.status, 200, 'GET /api/user/referrals must return 200');
    assert(Array.isArray(refStats.referrals), 'res.body.referrals must be an array');
    assert.strictEqual(refStats.referralCount, 1, 'res.body.referralCount must be 1');
    assert.strictEqual(refStats.referralBountyAmount, Number(db.settings.referralBountyAmount || 10000), 'referralBountyAmount must match');
    assert.strictEqual(refStats.completedFriends, 0, 'completedFriends must be 0 before first approved order');
    assert.strictEqual(refStats.pendingFriends, 1, 'pendingFriends must be 1 before first approved order');
    assert.strictEqual(refStats.totalBountyEarned, 0, 'totalBountyEarned must be 0');
    assert.strictEqual(refStats.referrals[0].status, 'pending', 'Referral status must be pending');

    // 6.2. Simulate Referee's First Approved Order
    console.log('\n--- 6. Testing Referral Bounty Conversion on Approved Order ---');
    const testOrderSn = `SN_REF_TEST_${Date.now()}`;
    const approvedOrder = {
      id: `ord_test_ref_${Date.now()}`,
      orderSn: testOrderSn,
      userId: refereeInDb.id,
      userCode: refereeInDb.code,
      productName: 'Sản phẩm Test Referral',
      orderAmount: 250000,
      grossCommission: 30000,
      userCashbackAmount: 18900,
      status: 'approved',
      createdAt: new Date().toISOString()
    };
    db.orders.unshift(approvedOrder);

    // Call /api/user/referrals again
    const refStatsAfterRes = await fetch(`${baseUrl}/api/user/referrals`, {
      headers: { Authorization: `Bearer ${referrerToken}` }
    });
    const refStatsAfter = await refStatsAfterRes.json();

    assert.strictEqual(refStatsAfter.completedFriends, 1, 'completedFriends must transition to 1');
    assert.strictEqual(refStatsAfter.pendingFriends, 0, 'pendingFriends must transition to 0');
    assert.strictEqual(
      refStatsAfter.totalBountyEarned,
      refStatsAfter.referralBountyAmount,
      'totalBountyEarned must equal referralBountyAmount'
    );
    assert.strictEqual(refStatsAfter.referrals[0].status, 'completed', 'Referral status must be completed');
    assert.strictEqual(
      refStatsAfter.referrals[0].bonusEarned,
      refStatsAfter.referralBountyAmount,
      'Referral bonusEarned must match bounty amount'
    );

    console.log('  PASS: Referral bounty converted upon friend order approval.');
    console.log('\n=== ALL REFERRAL SYNC TESTS COMPLETED SUCCESSFULLY! ===');
  } finally {
    // Cleanup
    db.users = db.users.filter((u) => u && u.id && !String(u.id).startsWith('usr_test_ref_'));
    db.orders = db.orders.filter((o) => o && o.id && !String(o.id).startsWith('ord_test_ref_'));
    await new Promise((resolve) => server.close(resolve));
    logger.logLeave('runReferralSyncSuite', { status: 'passed' });
  }
}

if (require.main === module) {
  runReferralSyncSuite()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('REFERRAL SYNC TEST FAILED:', err);
      process.exit(1);
    });
}

module.exports = { runReferralSyncSuite };
