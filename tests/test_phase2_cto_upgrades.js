process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dbService = require('../src/services/dbService');
const { createCsrfGuard } = require('../src/utils/securityMiddleware');
const app = require('../server');

(async () => {
  console.log('--- Running Phase 2 CTO Upgrades Verification ---');

  // 1. Static verification of Guest -> Authenticated re-conversion & retired manual order form
  const rootDir = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(rootDir, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'public/styles.css'), 'utf8');

  assert.ok(!html.includes('submitOrderClaimBtn'), 'User manual order submit button must not exist in index.html');
  assert.ok(!html.includes('orderClaimCollapsible'), 'User manual order accordion must not exist in index.html');
  assert.ok(!css.includes('.claim-accordion-card'), 'Unused .claim-accordion-card CSS must be removed');
  assert.ok(appJs.includes('async function refreshGuestConversionAfterAuth('), 'Guest-to-auth re-conversion helper must exist');
  assert.ok(appJs.includes('auth-linked-card-note'), 'Refreshed card confirmation badge must exist');
  assert.ok(appJs.includes('is-refreshing-aff'), 'Race-condition lock class must be applied during re-conversion');

  // 2. Integration tests against live Express server
  const db = dbService.ensureDbLoaded();
  const initialOrdersCount = db.orders.length;

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let createdUserId = null;
  const createdClickIds = [];

  try {
    // 2A. Register a fresh member account & capture Set-Cookie
    const uniquePhone = `09${String(Date.now()).slice(-8)}`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        name: 'Phase2 Tester',
        phone: uniquePhone,
        password: 'Password123!'
      })
    });
    assert.equal(regRes.status, 200, 'Member registration must succeed');
    const regCookieRaw = regRes.headers.get('set-cookie') || '';
    const cookieMatch = regCookieRaw.match(/hts_auth=[^;]+/);
    assert.ok(cookieMatch, 'Register response must set HttpOnly hts_auth cookie');
    const authCookie = cookieMatch[0];
    const regBody = await regRes.json();
    createdUserId = regBody.user.id;

    // 2B. [CRIT-01] Verify Guest /api/convert vs Cookie-Authenticated /api/convert attribution
    const sampleShopeeUrl = 'https://shopee.vn/product/175753395/6065001847';
    const guestConvRes = await fetch(`${baseUrl}/api/convert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ text: sampleShopeeUrl })
    });
    assert.equal(guestConvRes.status, 200);
    const guestConvData = await guestConvRes.json();
    const guestItem = guestConvData.items?.[0];
    assert.equal(guestItem?.status, 'success');
    assert.ok(guestItem?.clickId, 'Guest convert must return clickId');
    createdClickIds.push(guestItem.clickId);

    const guestClickRecord = await dbService.findClickById(guestItem.clickId);
    assert.equal(guestClickRecord.userCode, 'GUEST', 'Unauthenticated convert must record GUEST click');
    assert.equal(guestClickRecord.userId, null, 'Unauthenticated convert must have null userId');

    // Now re-convert the exact same URL with the authenticated cookie (simulating refreshGuestConversionAfterAuth)
    const authConvRes = await fetch(`${baseUrl}/api/convert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: authCookie
      },
      body: JSON.stringify({ text: sampleShopeeUrl })
    });
    assert.equal(authConvRes.status, 200);
    const authConvData = await authConvRes.json();
    const authItem = authConvData.items?.[0];
    assert.equal(authItem?.status, 'success');
    assert.notEqual(authItem.clickId, guestItem.clickId, 'Re-converted link must generate a fresh clickId');
    createdClickIds.push(authItem.clickId);

    const authClickRecord = await dbService.findClickById(authItem.clickId);
    assert.equal(authClickRecord.userId, createdUserId, 'Authenticated re-convert must bind click to user.id');
    assert.equal(authClickRecord.userCode, regBody.user.code, 'Authenticated re-convert must bind click to user.code');

    // 2C. Retired POST /api/user/submit-order returns 410 Gone, writes 0 orders, and enforces rate limit
    const retiredRes = await fetch(`${baseUrl}/api/user/submit-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: baseUrl,
        Cookie: authCookie
      },
      body: JSON.stringify({ platform: 'shopee', orderSn: '261118ABCDEF' })
    });
    assert.equal(retiredRes.status, 410, 'Retired /api/user/submit-order must return 410 Gone');
    assert.equal(dbService.ensureDbLoaded().orders.length, initialOrdersCount, 'Retired endpoint must never insert orders');

    let rateLimited = false;
    for (let i = 0; i < 12; i++) {
      const rlRes = await fetch(`${baseUrl}/api/user/submit-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: baseUrl,
          Cookie: authCookie
        },
        body: JSON.stringify({ platform: 'shopee', orderSn: `261118RL${i}` })
      });
      if (rlRes.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.ok(rateLimited, 'submitOrderLimiter must throttle excessive calls with 429');

    // 2D. [HIGH-01] Strict CSRF Guard: JSON or empty-body cookie mutation without X-Requested-With MUST be blocked (403)
    const noXrwJsonRes = await fetch(`${baseUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
        Cookie: authCookie
      },
      body: JSON.stringify({ name: 'CSRF Bypass Attempt' })
    });
    assert.equal(noXrwJsonRes.status, 403, 'Cookie JSON POST without X-Requested-With must be rejected with 403');

    const noXrwEmptyBeaconRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Cookie: authCookie
      }
    });
    assert.equal(noXrwEmptyBeaconRes.status, 403, 'Empty-body sendBeacon cookie POST without X-Requested-With must be rejected with 403');

    // Evil Referer when Origin header is stripped must also be rejected with 403
    const guard = createCsrfGuard({ allowedOrigins: ['https://hoantiensan.online'] });
    let refererStatus = 200;
    guard(
      {
        method: 'POST',
        path: '/api/user/profile',
        originalUrl: '/api/user/profile',
        headers: {
          cookie: 'hts_auth=token123',
          referer: 'https://evil-phishing.example/attack.html',
          'x-requested-with': 'XMLHttpRequest'
        }
      },
      {
        status(code) {
          refererStatus = code;
          return { json() {} };
        }
      },
      () => {}
    );
    assert.equal(refererStatus, 403, 'Cross-site Referer without Origin header must be blocked with 403');

    console.log('PASS: Phase 2 CTO upgrades verified (Guest->Auth attribution, retired submit-order 410 + rate limit, strict CSRF guard).');
  } finally {
    // Clean up test user & clicks from in-memory test state
    const finalDb = dbService.ensureDbLoaded();
    if (createdUserId) {
      finalDb.users = finalDb.users.filter((u) => u.id !== createdUserId);
    }
    if (createdClickIds.length > 0) {
      finalDb.clicks = finalDb.clicks.filter((c) => !createdClickIds.includes(c.clickId));
    }
    await dbService.saveDb(finalDb);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Phase 2 test suite failed:', err);
  process.exitCode = 1;
});
