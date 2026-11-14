process.env.NODE_ENV = 'test';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const logger = require('../src/utils/logger');
const { createCsrfGuard } = require('../src/utils/securityMiddleware');
const dbService = require('../src/services/dbService');
const controller = require('../src/services/cashbackController');
const postgresRepository = require('../src/repositories/postgresRepository');
const orderReconciliationService = require('../src/services/orderReconciliationService');
const webhookSecurityService = require('../src/services/webhookSecurityService');
const app = require('../server');

async function main() {
  console.log('=== STARTING PHASE 2 & PHASE 3 DUE DILIGENCE TEST SUITE ===');

  await dbService.initPostgresIfConfigured();
  await dbService.reloadStateFromPostgres();
  const db = dbService.ensureDbLoaded();

  const suffix = Date.now().toString(36) + '_' + Math.floor(1000 + Math.random() * 9000);
  const cleanupUserIds = new Set();
  const cleanupOrderSns = new Set();
  const cleanupWithdrawalIds = new Set();

  // -------------------------------------------------------------------------
  // 1. [MED-04] Modular Repository & Domain Services Architecture
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Testing [MED-04] Modular Architecture & Re-exports ---');
  assert.strictEqual(typeof postgresRepository.normalizePagination, 'function');
  assert.strictEqual(typeof postgresRepository.queryOrdersPaginated, 'function');
  assert.strictEqual(typeof postgresRepository.queryUsersPaginated, 'function');
  assert.strictEqual(typeof postgresRepository.queryWithdrawalsPaginated, 'function');

  assert.strictEqual(typeof orderReconciliationService.canTransitionOrderStatus, 'function');
  assert.strictEqual(typeof orderReconciliationService.sanitizeOrderForUser, 'function');
  assert.strictEqual(typeof orderReconciliationService.normalizeNetworkStatus, 'function');
  assert.strictEqual(typeof orderReconciliationService.sanitizeFiniteNumber, 'function');
  assert.strictEqual(typeof orderReconciliationService.parseShopeeReportNodes, 'function');
  assert.ok(orderReconciliationService.ALLOWED_ORDER_TRANSITIONS);

  assert.strictEqual(typeof webhookSecurityService.getConfiguredPostbackToken, 'function');
  assert.strictEqual(typeof webhookSecurityService.verifyWebhookRequest, 'function');

  assert.strictEqual(controller.canTransitionOrderStatus, orderReconciliationService.canTransitionOrderStatus);
  assert.strictEqual(controller.sanitizeOrderForUser, orderReconciliationService.sanitizeOrderForUser);
  assert.strictEqual(controller.normalizeNetworkStatus, orderReconciliationService.normalizeNetworkStatus);
  assert.strictEqual(controller.sanitizeFiniteNumber, orderReconciliationService.sanitizeFiniteNumber);
  assert.strictEqual(controller.parseShopeeReportNodes, orderReconciliationService.parseShopeeReportNodes);
  assert.strictEqual(controller.verifyWebhookRequest, webhookSecurityService.verifyWebhookRequest);
  assert.strictEqual(controller.getConfiguredPostbackToken, webhookSecurityService.getConfiguredPostbackToken);
  assert.strictEqual(typeof controller.registerCashbackRoutes, 'function');

  const clampedPag = postgresRepository.normalizePagination({ page: '-5', limit: '9999' });
  assert.strictEqual(clampedPag.page, 1, 'Negative page must clamp to 1');
  assert.ok(clampedPag.limit <= 200 && clampedPag.limit >= 1, 'Oversized limit must be clamped');
  console.log('  PASS: Modular exports and backward-compatible re-exports verified.');

  // -------------------------------------------------------------------------
  // 2. [HIGH-04] PostgreSQL TLS SSL Configuration
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Testing [HIGH-04] PostgreSQL SSL Configuration ---');
  assert.strictEqual(typeof dbService.getPgPool, 'function', 'dbService.getPgPool must be exported');
  const dbServiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'dbService.js'), 'utf8');
  assert.ok(dbServiceSrc.includes('PG_SSL_CA'), 'dbService must support PG_SSL_CA');
  assert.ok(
    dbServiceSrc.includes('PG_SSL_REJECT_UNAUTHORIZED'),
    'dbService must support PG_SSL_REJECT_UNAUTHORIZED'
  );
  console.log('  PASS: Postgres TLS SSL configuration verified.');

  // -------------------------------------------------------------------------
  // 3. [LOW-05] Request Correlation & AsyncLocalStorage Tracing
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Testing [LOW-05] AsyncLocalStorage & X-Request-Id ---');
  const tracedId = await logger.runWithRequestContext({ requestId: `req_trace_${suffix}` }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return logger.getRequestId();
  });
  assert.strictEqual(tracedId, `req_trace_${suffix}`, 'AsyncLocalStorage must preserve requestId across awaits');
  assert.strictEqual(logger.getRequestId(), null, 'Outside request context getRequestId() must return null');

  // Seed admin & regular users + orders + withdrawals for API tests
  const adminUser = {
    id: `usr_p23_adm_${suffix}`,
    code: `P23ADM_${suffix.slice(-5)}`,
    name: 'Phase23 Admin',
    phone: `0991${String(Math.floor(100000 + Math.random() * 899999))}`,
    passwordHash: 'scrypt$dummy',
    role: 'admin',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  const user1 = {
    id: `usr_p23_u1_${suffix}`,
    code: `P23U1_${suffix.slice(-5)}`,
    name: 'Alice Pagination',
    phone: `0981${String(Math.floor(100000 + Math.random() * 899999))}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  const user2 = {
    id: `usr_p23_u2_${suffix}`,
    code: `P23U2_${suffix.slice(-5)}`,
    name: 'Bob SearchTarget',
    phone: `0982${String(Math.floor(100000 + Math.random() * 899999))}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  const user3 = {
    id: `usr_p23_u3_${suffix}`,
    code: `P23U3_${suffix.slice(-5)}`,
    name: 'Charlie PageThree',
    phone: `0983${String(Math.floor(100000 + Math.random() * 899999))}`,
    passwordHash: 'scrypt$dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };

  for (const u of [adminUser, user1, user2, user3]) {
    db.users.push(u);
    cleanupUserIds.add(u.id);
  }

  const statuses = ['approved', 'pending', 'approved', 'cancelled', 'pending'];
  for (let i = 1; i <= 5; i++) {
    const orderSn = `P23SN_${suffix}_${i}`;
    cleanupOrderSns.add(orderSn);
    db.orders.push({
      id: `ord_p23_${suffix}_${i}`,
      orderSn,
      userId: i <= 4 ? user1.id : user2.id,
      userCode: i <= 4 ? user1.code : user2.code,
      platform: 'shopee',
      productName: `San pham P23 ${i}`,
      orderAmount: 100000 * i,
      grossCommission: 10000 * i,
      totalCommission: 10000 * i,
      userCashbackAmount: 7000 * i,
      status: statuses[i - 1],
      createdAt: new Date(Date.now() - i * 60000).toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const wdStatuses = ['pending', 'paid', 'pending', 'rejected'];
  for (let i = 1; i <= 4; i++) {
    const wdId = `wd_p23_${suffix}_${i}`;
    cleanupWithdrawalIds.add(wdId);
    db.withdrawals.push({
      id: wdId,
      userId: user1.id,
      userCode: user1.code,
      amount: 1000 * i,
      method: 'bank',
      bankName: 'VCB',
      bankAccount: `00011122${i}`,
      bankOwner: `OWNER_${i}`,
      status: wdStatuses[i - 1],
      createdAt: new Date(Date.now() - i * 60000).toISOString()
    });
  }

  const prevPostbackToken = db.settings.postbackToken;
  const testPostbackToken = `p23_tok_${suffix}`;
  db.settings.postbackToken = testPostbackToken;
  await dbService.saveDb(db);

  const adminToken = dbService.createToken(adminUser);
  const user1Token = dbService.createToken(user1);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const reqIdHdr = `cid_test_${suffix}`;
    const traceRes = await fetch(`${baseUrl}/api/public-config`, {
      headers: { 'X-Request-Id': reqIdHdr }
    });
    assert.strictEqual(traceRes.status, 200);
    assert.strictEqual(
      traceRes.headers.get('x-request-id'),
      reqIdHdr,
      'Response must echo incoming X-Request-Id header'
    );

    const autoTraceRes = await fetch(`${baseUrl}/api/public-config`);
    assert.strictEqual(autoTraceRes.status, 200);
    assert.ok(
      autoTraceRes.headers.get('x-request-id') && autoTraceRes.headers.get('x-request-id').length >= 8,
      'Response must generate X-Request-Id when omitted'
    );
    console.log('  PASS: Request ID propagation and AsyncLocalStorage context verified.');

    // -----------------------------------------------------------------------
    // 4. [MED-01] Server-Side Pagination & Search APIs
    // -----------------------------------------------------------------------
    console.log('\n--- 4. Testing [MED-01] Server-Side Pagination & Search APIs ---');
    const authHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    };

    const ordPage1Res = await fetch(`${baseUrl}/api/admin/orders?page=1&limit=2`, { headers: authHeaders });
    assert.strictEqual(ordPage1Res.status, 200);
    const ordPage1 = await ordPage1Res.json();
    assert.strictEqual(ordPage1.orders.length, 2, 'Page 1 must return exact limit of 2 orders');
    assert.strictEqual(ordPage1.pagination.page, 1);
    assert.strictEqual(ordPage1.pagination.limit, 2);
    assert.ok(ordPage1.pagination.total >= 5);
    assert.ok(ordPage1.pagination.totalPages >= 3);

    const ordPage2Res = await fetch(`${baseUrl}/api/admin/orders?page=2&limit=2`, { headers: authHeaders });
    assert.strictEqual(ordPage2Res.status, 200);
    const ordPage2 = await ordPage2Res.json();
    assert.strictEqual(ordPage2.orders.length, 2, 'Page 2 must return 2 orders');
    const page1Sns = new Set(ordPage1.orders.map((o) => o.orderSn));
    for (const o of ordPage2.orders) {
      assert.ok(!page1Sns.has(o.orderSn), 'Page 2 orders must not overlap with Page 1');
    }

    const ordFilterRes = await fetch(
      `${baseUrl}/api/admin/orders?q=${encodeURIComponent(`P23SN_${suffix}`)}&status=approved&page=1&limit=10`,
      { headers: authHeaders }
    );
    assert.strictEqual(ordFilterRes.status, 200);
    const ordFilter = await ordFilterRes.json();
    assert.strictEqual(ordFilter.orders.length, 2, 'Should find 2 approved P23SN orders');
    assert.ok(ordFilter.orders.every((o) => o.status === 'approved'));

    const usrPage1Res = await fetch(`${baseUrl}/api/admin/users?page=1&limit=2`, { headers: authHeaders });
    assert.strictEqual(usrPage1Res.status, 200);
    const usrPage1 = await usrPage1Res.json();
    assert.strictEqual(usrPage1.users.length, 2);
    assert.ok(usrPage1.pagination.total >= 4);

    const usrSearchRes = await fetch(
      `${baseUrl}/api/admin/users?q=${encodeURIComponent(user2.code)}`,
      { headers: authHeaders }
    );
    assert.strictEqual(usrSearchRes.status, 200);
    const usrSearch = await usrSearchRes.json();
    assert.ok(usrSearch.users.some((u) => u.id === user2.id), 'User search must return target user');

    const wdRes = await fetch(`${baseUrl}/api/admin/withdrawals?page=1&limit=2&status=pending`, {
      headers: authHeaders
    });
    assert.strictEqual(wdRes.status, 200);
    const wdData = await wdRes.json();
    assert.strictEqual(wdData.withdrawals.length, 2);
    assert.ok(wdData.withdrawals.every((w) => w.status === 'pending'));

    const meRes = await fetch(
      `${baseUrl}/api/user/me?orderPage=1&orderLimit=2&q=${encodeURIComponent(`P23SN_${suffix}`)}`,
      {
        headers: {
          Authorization: `Bearer ${user1Token}`,
          'X-Requested-With': 'XMLHttpRequest'
        }
      }
    );
    assert.strictEqual(meRes.status, 200);
    const meData = await meRes.json();
    assert.strictEqual(meData.orders.length, 2, '/api/user/me orderLimit=2 must paginate user orders');
    assert.ok(meData.ordersPagination, '/api/user/me must include ordersPagination');
    assert.strictEqual(meData.ordersPagination.total, 4, 'user1 has 4 matching orders');
    assert.strictEqual(meData.ordersPagination.totalPages, 2);
    console.log('  PASS: Admin & user pagination + search endpoints verified.');

    // -----------------------------------------------------------------------
    // 5. [HIGH-07] Cookie-Auth CSRF Guard
    // -----------------------------------------------------------------------
    console.log('\n--- 5. Testing [HIGH-07] Cookie-Auth CSRF Protection ---');
    const evilOriginRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: {
        Cookie: `hts_auth=${adminToken}`,
        Origin: 'https://evil.attacker.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ note: 'csrf_test' })
    });
    assert.strictEqual(evilOriginRes.status, 403, 'Cross-origin cookie mutation must be blocked with 403');

    const formWithoutXrwRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: {
        Cookie: `hts_auth=${adminToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'note=csrf_form'
    });
    assert.strictEqual(
      formWithoutXrwRes.status,
      403,
      'Simple form cookie POST without X-Requested-With must be blocked with 403'
    );

    const validSameOriginRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: {
        Cookie: `hts_auth=${adminToken}`,
        Origin: 'http://localhost:3456',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({})
    });
    assert.strictEqual(
      validSameOriginRes.status,
      200,
      'Valid Origin + X-Requested-With cookie mutation must be allowed (200)'
    );

    // Webhook exemption check: even if Origin is third-party and hts_auth cookie exists, webhook route must not 403 on CSRF
    const webhookOrderSn = `P23_WH_${suffix}`;
    cleanupOrderSns.add(webhookOrderSn);
    const webhookRes = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        Cookie: `hts_auth=${adminToken}`,
        Origin: 'https://partner-webhook.example.com',
        'Content-Type': 'application/json',
        'X-Postback-Token': testPostbackToken
      },
      body: JSON.stringify({
        orderSn: webhookOrderSn,
        status: 'pending',
        grossCommission: 10000
      })
    });
    assert.notStrictEqual(webhookRes.status, 403, 'Webhook routes must be exempt from CSRF guard');
    assert.strictEqual(webhookRes.status, 200, 'Authenticated webhook postback should succeed');

    // Also unit-test createCsrfGuard directly with allowedOrigins option
    const guard = createCsrfGuard({ allowedOrigins: ['https://app.example.com'] });
    let nextCalled = false;
    let statusSent = 200;
    guard(
      {
        method: 'POST',
        path: '/api/user/profile',
        originalUrl: '/api/user/profile',
        headers: {
          cookie: 'hts_auth=abc',
          origin: 'https://phishing.example.com',
          'content-type': 'application/json',
          'x-requested-with': 'XMLHttpRequest'
        }
      },
      {
        status(code) {
          statusSent = code;
          return { json() {} };
        }
      },
      () => {
        nextCalled = true;
      }
    );
    assert.strictEqual(statusSent, 403);
    assert.strictEqual(nextCalled, false);
    console.log('  PASS: CSRF guard blocks cross-origin & simple-form mutations, allows valid XHR, exempts webhooks.');

    // -----------------------------------------------------------------------
    // 6. [MED-03] Multi-Cycle Referral Bounty Reconciler
    // -----------------------------------------------------------------------
    console.log('\n--- 6. Testing [MED-03] Multi-Cycle Referral Bounty Reconciler ---');
    const prevBounty = db.settings.referralBountyAmount;
    db.settings.referralBountyAmount = 5000;

    const refOwner = {
      id: `usr_p23_refowner_${suffix}`,
      code: `REFOWN_${suffix.slice(-4)}`,
      name: 'Referrer Owner',
      phone: `0971${String(Math.floor(100000 + Math.random() * 899999))}`,
      passwordHash: 'scrypt$dummy',
      role: 'user',
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    };
    const referee = {
      id: `usr_p23_referee_${suffix}`,
      code: `REFEE_${suffix.slice(-4)}`,
      name: 'Referee Buyer',
      phone: `0972${String(Math.floor(100000 + Math.random() * 899999))}`,
      passwordHash: 'scrypt$dummy',
      role: 'user',
      referredBy: refOwner.code,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    };
    db.users.push(refOwner, referee);
    cleanupUserIds.add(refOwner.id);
    cleanupUserIds.add(referee.id);

    const refOrd1Sn = `P23_REF1_${suffix}`;
    cleanupOrderSns.add(refOrd1Sn);
    const refOrd1 = {
      id: `ord_p23_ref1_${suffix}`,
      orderSn: refOrd1Sn,
      userId: referee.id,
      userCode: referee.code,
      platform: 'shopee',
      productName: 'Ref Order 1',
      orderAmount: 100000,
      grossCommission: 10000,
      totalCommission: 10000,
      userCashbackAmount: 7000,
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.orders.push(refOrd1);

    // Cycle 1: 1st approved order -> credit +5000
    dbService.recalculateUserWallet(refOwner.id);
    assert.strictEqual(refOwner.balanceAvailable, 5000, 'Cycle 1: referrer must receive 5000đ bounty');
    assert.ok(
      db.ledger.some((l) => l.userId === refOwner.id && l.refId === `ref_bounty_${referee.id}` && l.amount === 5000),
      'Cycle 1 must write ref_bounty ledger credit'
    );

    // Cycle 2: Order cancelled -> revoke -5000
    refOrd1.status = 'cancelled';
    dbService.recalculateUserWallet(refOwner.id);
    assert.strictEqual(refOwner.balanceAvailable, 0, 'Cycle 2: bounty must be revoked when referee has 0 approved orders');
    assert.ok(
      db.ledger.some(
        (l) => l.userId === refOwner.id && l.refId === `ref_bounty_revoke_${referee.id}` && l.amount === -5000
      ),
      'Cycle 2 must write ref_bounty_revoke ledger debit'
    );

    // Cycle 3: 2nd order approved -> re-credit +5000 via delta reconciler
    const refOrd2Sn = `P23_REF2_${suffix}`;
    cleanupOrderSns.add(refOrd2Sn);
    db.orders.push({
      id: `ord_p23_ref2_${suffix}`,
      orderSn: refOrd2Sn,
      userId: referee.id,
      userCode: referee.code,
      platform: 'shopee',
      productName: 'Ref Order 2',
      orderAmount: 120000,
      grossCommission: 12000,
      totalCommission: 12000,
      userCashbackAmount: 8400,
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    dbService.recalculateUserWallet(refOwner.id);
    assert.strictEqual(refOwner.balanceAvailable, 5000, 'Cycle 3: bounty must be re-credited when referee completes a new order');
    assert.ok(
      db.ledger.some(
        (l) => l.userId === refOwner.id && l.refId === `ref_bounty_adj_${referee.id}_3` && l.amount === 5000
      ),
      'Cycle 3 must write ref_bounty_adj_3 delta re-credit entry'
    );

    // Idempotency check
    dbService.recalculateUserWallet(refOwner.id);
    assert.strictEqual(refOwner.balanceAvailable, 5000, 'Repeated recalculation must be idempotent');
    db.settings.referralBountyAmount = prevBounty;
    console.log('  PASS: Multi-cycle referral bounty credit -> revoke -> re-credit verified.');

    // -----------------------------------------------------------------------
    // 7. [MED-05], [LOW-01], [LOW-02], [LOW-04] Frontend, Icons, Cache & Legal
    // -----------------------------------------------------------------------
    console.log('\n--- 7. Testing [MED-05], [LOW-01], [LOW-02], [LOW-04] Assets, CSP/Headers & UI ---');
    const publicDir = path.join(__dirname, '..', 'public');
    const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const manifestJson = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));

    // CSRF header in apiFetch
    assert.ok(appJs.includes("'X-Requested-With': 'XMLHttpRequest'"), 'apiFetch must send X-Requested-With header');

    // Pagination/Search UI IDs & endpoints
    for (const id of [
      'admOrderSearchInput',
      'admOrderStatusFilter',
      'admOrderSearchBtn',
      'admOrdersPrevBtn',
      'admOrdersPageInfo',
      'admOrdersNextBtn',
      'admUserSearchInput',
      'admUserSearchBtn',
      'admUsersPrevBtn',
      'admUsersPageInfo',
      'admUsersNextBtn'
    ]) {
      assert.ok(indexHtml.includes(id), `index.html missing control ID ${id}`);
      assert.ok(appJs.includes(id), `app.js missing control ID ${id}`);
    }
    assert.ok(appJs.includes('/api/admin/orders'), 'app.js must call /api/admin/orders');
    assert.ok(appJs.includes('/api/admin/users'), 'app.js must call /api/admin/users');

    // CSPRNG password generation
    const pwdMatch = appJs.match(/on\('btnGenerateRandomPwd',[\s\S]*?\}\);/);
    assert.ok(pwdMatch, 'btnGenerateRandomPwd handler must exist in app.js');
    assert.ok(
      pwdMatch[0].includes('window.crypto.getRandomValues'),
      'btnGenerateRandomPwd must use window.crypto.getRandomValues'
    );
    assert.ok(!pwdMatch[0].includes('Math.random'), 'btnGenerateRandomPwd must not use Math.random');

    // Asset cache-busting & HTTP headers
    assert.ok(indexHtml.includes('/styles.css?v=2.1.0'), 'index.html must reference versioned styles.css');
    assert.ok(indexHtml.includes('/app.js?v=2.1.0'), 'index.html must reference versioned app.js');
    const appAssetRes = await fetch(`${baseUrl}/app.js`);
    assert.strictEqual(appAssetRes.status, 200);
    const cacheCtrl = appAssetRes.headers.get('cache-control') || '';
    assert.ok(
      cacheCtrl.includes('max-age=0') && cacheCtrl.includes('must-revalidate'),
      `Static /app.js must set Cache-Control max-age=0, must-revalidate (got: ${cacheCtrl})`
    );

    // Branded PNG icons & manifest
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const iconName of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
      const buf = fs.readFileSync(path.join(publicDir, iconName));
      assert.ok(buf.length > 500, `${iconName} must be non-trivial PNG binary`);
      assert.ok(buf.subarray(0, 8).equals(pngSig), `${iconName} must have valid PNG magic bytes`);
    }
    assert.ok(indexHtml.includes('/apple-touch-icon.png'), 'index.html must reference /apple-touch-icon.png');
    const iconSrcs = (manifestJson.icons || []).map((i) => i.src);
    assert.ok(iconSrcs.some((s) => s.includes('icon-192.png')), 'manifest.webmanifest must list icon-192.png');
    assert.ok(iconSrcs.some((s) => s.includes('icon-512.png')), 'manifest.webmanifest must list icon-512.png');

    // Transparent Terms disclosure for api.qrserver.com
    assert.ok(indexHtml.includes('api.qrserver.com'), 'Terms view must transparently disclose api.qrserver.com');
    console.log('  PASS: Frontend CSRF header, CSPRNG password, PNG icons, Cache-Control, and Terms disclosure verified.');
  } finally {
    // Cleanup seeded test records in isolated test DB state
    db.orders = db.orders.filter((o) => !cleanupOrderSns.has(o.orderSn));
    db.withdrawals = db.withdrawals.filter((w) => !cleanupWithdrawalIds.has(w.id));
    db.ledger = db.ledger.filter((l) => !cleanupUserIds.has(l.userId));
    db.users = db.users.filter((u) => !cleanupUserIds.has(u.id));
    db.settings.postbackToken = prevPostbackToken;
    await dbService.saveDb(db);

    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n=== ALL PHASE 2 & PHASE 3 DUE DILIGENCE TESTS PASSED ===');
}

main()
  .then(() => {
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    setTimeout(() => process.exit(1), 100);
  });
