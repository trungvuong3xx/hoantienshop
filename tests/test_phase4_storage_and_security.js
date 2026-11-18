process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dbService = require('../src/services/dbService');
const {
  CIPHER_PREFIX,
  deriveSettingsAesKey,
  encryptSecretValue,
  decryptSecretValue,
  encryptSettingsObject,
  decryptSettingsObject
} = require('../src/utils/secretCrypto');
const { clearFailedLoginAttempts } = require('../src/utils/securityMiddleware');
const app = require('../server');

(async () => {
  console.log('--- Running Phase 4 Storage Optimization & Security Hardening Verification ---');

  // 1. [HIGH-02A] Unit-test AES-256-GCM secret encryption, backward compatibility & tamper resistance
  const testKey = deriveSettingsAesKey('super-secret-master-key-at-least-32-chars!!');
  const rawSecret = 'shpss_live_998877665544332211';
  const encrypted = encryptSecretValue(rawSecret, testKey);
  assert.ok(encrypted.startsWith(CIPHER_PREFIX), 'Encrypted secret must carry enc:v1: prefix');
  assert.ok(!encrypted.includes(rawSecret), 'Ciphertext must never contain plaintext secret');
  assert.equal(decryptSecretValue(encrypted, testKey), rawSecret, 'Decryption must recover exact secret');

  // Idempotent double-encrypt guard
  assert.equal(encryptSecretValue(encrypted, testKey), encrypted, 'Already encrypted value must not double-encrypt');

  // Backward compatibility with legacy plaintext
  assert.equal(decryptSecretValue('legacy_plain_token', testKey), 'legacy_plain_token', 'Plaintext must pass through seamlessly');

  // Tamper resistance (flip last character of ciphertext)
  const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('A') ? 'B' : 'A') + 'A';
  assert.equal(decryptSecretValue(tampered, testKey), '', 'Tampered ciphertext must fail authentication safely');

  const rawSettingsObj = {
    siteName: 'LiLa',
    shopeeAppSecret: 'secret_shopee_abc',
    accesstradeApiKey: 'at_key_xyz',
    postbackToken: 'pb_tok_123456'
  };
  const encObj = encryptSettingsObject(rawSettingsObj, 'master-key-material-32-bytes-minimum');
  assert.equal(encObj.siteName, 'LiLa');
  assert.ok(encObj.shopeeAppSecret.startsWith(CIPHER_PREFIX));
  assert.ok(encObj.accesstradeApiKey.startsWith(CIPHER_PREFIX));
  assert.ok(encObj.postbackToken.startsWith(CIPHER_PREFIX));
  const decObj = decryptSettingsObject(encObj, 'master-key-material-32-bytes-minimum');
  assert.deepEqual(decObj, rawSettingsObj, 'Settings object must round-trip cleanly');

  // 2. Verify saveDb() encrypts secrets on disk while keeping plaintext in memory
  const db = dbService.ensureDbLoaded();
  const prevPostbackToken = db.settings.postbackToken;
  const testPostbackToken = `pb_phase4_${Date.now()}_secret`;
  db.settings.postbackToken = testPostbackToken;
  db.settings.shopeeAppSecret = 'shopee_secret_at_rest_test';
  await dbService.saveDb(db);

  const testDbFile = path.join(os.tmpdir(), `hoantienshop_test_db_${process.pid}.json`);
  const rawDiskContent = fs.readFileSync(testDbFile, 'utf8');
  assert.ok(!rawDiskContent.includes(testPostbackToken), 'On-disk JSON must NOT contain plaintext postbackToken');
  assert.ok(!rawDiskContent.includes('shopee_secret_at_rest_test'), 'On-disk JSON must NOT contain plaintext shopeeAppSecret');
  assert.ok(rawDiskContent.includes(CIPHER_PREFIX), 'On-disk JSON must store enc:v1: AES-256-GCM ciphertext');
  assert.equal(dbService.ensureDbLoaded().settings.postbackToken, testPostbackToken, 'In-memory settings must remain decrypted');

  // 3. [CRIT-03] Verify composite Postgres indexes & delta fingerprint engine exist in dbService.js
  const dbServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8');
  for (const idxName of [
    'idx_orders_user_status_created',
    'idx_orders_created_at',
    'idx_ledger_user_created',
    'idx_withdrawals_user_status',
    'idx_clicks_created_at',
    'idx_users_phone',
    'function capturePgFingerprints('
  ]) {
    assert.ok(dbServiceSrc.includes(idxName), `dbService.js must include ${idxName}`);
  }

  // 4. [MED-04] Verify recalculateAffectedWallets O(K) targeting + Webhook Referrer Bounty attribution
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createdUserIds = [];
  const createdOrderSns = [];

  try {
    const guestRecalc = dbService.recalculateAffectedWallets(['GUEST', null, ''], { persist: false });
    assert.equal(guestRecalc.recalculatedCount, 0, 'GUEST order must recalculate 0 wallets');

    const referrerPhone = `091${String(Date.now()).slice(-7)}`;
    const refereePhone = `092${String(Date.now() + 1).slice(-7)}`;
    const bystanderPhone = `093${String(Date.now() + 2).slice(-7)}`;
    const passHash = await dbService.hashPasswordAsync('Phase4Pass!123');

    const referrer = {
      id: `usr_p4_ref_${Date.now()}`,
      code: `P4REF${String(Date.now()).slice(-4)}`,
      name: 'Referrer P4',
      phone: referrerPhone,
      passwordHash: passHash,
      role: 'user',
      tokenVersion: 1,
      referredBy: null,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    };
    const referee = {
      id: `usr_p4_child_${Date.now()}`,
      code: `P4CHD${String(Date.now()).slice(-4)}`,
      name: 'Referee P4',
      phone: refereePhone,
      passwordHash: passHash,
      role: 'user',
      tokenVersion: 1,
      referredBy: referrer.code,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    };
    const bystander = {
      id: `usr_p4_bys_${Date.now()}`,
      code: `P4BYS${String(Date.now()).slice(-4)}`,
      name: 'Bystander P4',
      phone: bystanderPhone,
      passwordHash: passHash,
      role: 'user',
      tokenVersion: 1,
      referredBy: null,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    };
    createdUserIds.push(referrer.id, referee.id, bystander.id);
    db.users.push(referrer, referee, bystander);
    await dbService.saveDb(db);

    const targeted = dbService.recalculateAffectedWallets([referee.id], { persist: false });
    assert.equal(targeted.recalculatedCount, 2, 'Targeting referee must include exactly referee + referrer (2 users)');
    assert.ok(targeted.userIds.includes(referee.id) && targeted.userIds.includes(referrer.id));
    assert.ok(!targeted.userIds.includes(bystander.id), 'Unrelated bystander must not be recalculated');

    // Deliver approved order via /api/webhooks/postback for referee -> referrer MUST receive 10.000đ bounty!
    const whOrderSn = `P4_WH_REF_${Date.now()}`;
    createdOrderSns.push(whOrderSn);
    const whRes = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postback-Token': testPostbackToken
      },
      body: JSON.stringify({
        orderSn: whOrderSn,
        sub1: referee.code,
        platform: 'shopee',
        status: 'approved',
        orderAmount: 200000,
        grossCommission: 20000
      })
    });
    assert.equal(whRes.status, 200, 'Webhook postback for referee order must succeed');

    const freshDb = dbService.ensureDbLoaded();
    const updatedReferee = freshDb.users.find((u) => u.id === referee.id);
    const updatedReferrer = freshDb.users.find((u) => u.id === referrer.id);
    assert.equal(updatedReferee.balanceAvailable, 12600, 'Referee must receive 12.600đ cashback');
    assert.equal(
      updatedReferrer.balanceAvailable,
      Number(freshDb.settings.referralBountyAmount || 10000),
      'Referrer must automatically receive referral bounty upon webhook order approval'
    );

    // 5. [HIGH-02B] Verify Account-Level Login Brute-Force Cooldown (8 wrong attempts -> 429 cooldown)
    for (let attempt = 1; attempt <= 7; attempt++) {
      const badRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({ identifier: bystanderPhone, password: `WrongPass_${attempt}` })
      });
      assert.equal(badRes.status, 401, `Attempt ${attempt} must return 401`);
    }

    const eighthRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ identifier: bystanderPhone, password: 'WrongPass_8' })
    });
    assert.equal(eighthRes.status, 429, '8th consecutive failed attempt must trigger 429 account cooldown');

    // Even with the RIGHT password while in cooldown, login must stay blocked with 429
    const blockedValidRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ identifier: bystanderPhone, password: 'Phase4Pass!123' })
    });
    assert.equal(blockedValidRes.status, 429, 'Account must remain in 429 cooldown until window expires');

    // Clear lock and confirm valid login works again
    await clearFailedLoginAttempts(`acct:${bystander.id}`);
    const unlockedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ identifier: bystanderPhone, password: 'Phase4Pass!123' })
    });
    assert.equal(unlockedRes.status, 200, 'Login must succeed once cooldown clears');

    console.log('PASS: Phase 4 verified (AES-256-GCM at rest, delta Postgres sync + indexes, O(K) wallet + webhook bounty, login brute-force cooldown).');
  } finally {
    const cleanDb = dbService.ensureDbLoaded();
    cleanDb.settings.postbackToken = prevPostbackToken || '';
    cleanDb.settings.shopeeAppSecret = '';
    cleanDb.users = cleanDb.users.filter((u) => !createdUserIds.includes(u.id));
    cleanDb.orders = cleanDb.orders.filter((o) => !createdOrderSns.includes(o.orderSn));
    cleanDb.ledger = cleanDb.ledger.filter((l) => !createdUserIds.includes(l.userId));
    await dbService.saveDb(cleanDb);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Phase 4 test suite failed:', err);
  process.exitCode = 1;
});
