const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const {
  ensureDbLoaded,
  initPostgresIfConfigured,
  reloadStateFromPostgres
} = require('../src/services/dbService');
const {
  registerCashbackRoutes,
  verifyWebhookRequest,
  getConfiguredPostbackToken
} = require('../src/services/cashbackController');
const logger = require('../src/utils/logger');

async function runWebhookSecurityTests() {
  console.log('=== STARTING WEBHOOK SECURITY & ANTI-REPLAY TEST SUITE ===');
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // Setup express server with rawBody preservation as configured in server.js
  const app = express();
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const savedEnvToken = process.env.POSTBACK_TOKEN;
  const savedEnvSecret = process.env.POSTBACK_SECRET;
  const savedDbSetting = db.settings.postbackToken;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Reject with 403 when postback token is not configured on server
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Testing Unconfigured Token Rejection (403) ---');
    delete process.env.POSTBACK_TOKEN;
    delete process.env.POSTBACK_SECRET;
    delete db.settings.postbackToken;

    assert.strictEqual(getConfiguredPostbackToken(db), '', 'Token must be empty when unconfigured');

    const resUnconfPostback = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderSn: 'ORD_TEST_UNCONFIGURED' })
    });
    assert.strictEqual(resUnconfPostback.status, 403, 'Must return 403 when postback token not configured');
    const jsonUnconfPostback = await resUnconfPostback.json();
    assert(jsonUnconfPostback.error.includes('not configured'), 'Error message should indicate unconfigured token');

    const resUnconfAt = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: 'ORD_AT_UNCONF' })
    });
    assert.strictEqual(resUnconfAt.status, 403, 'POST /api/webhooks/accesstrade must return 403 when unconfigured');

    const resUnconfAtGet = await fetch(`${baseUrl}/api/webhooks/accesstrade?order_id=ORD_AT_GET_UNCONF`);
    assert.strictEqual(resUnconfAtGet.status, 403, 'GET /api/webhooks/accesstrade must return 403 when unconfigured');

    console.log('  PASS: All webhook endpoints strictly reject with 403 when token is unconfigured.');

    // Configure test token for remaining tests
    const TEST_TOKEN = 'secure_postback_token_test_xyz_9988';
    process.env.POSTBACK_TOKEN = TEST_TOKEN;
    assert.strictEqual(getConfiguredPostbackToken(db), TEST_TOKEN, 'Token should now be configured');

    // -------------------------------------------------------------------------
    // TEST 2: Reject Tokens / Signatures in Query Parameters on Write Operations
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Query Parameter Rejection on Write Operations ---');
    // POST to accesstrade with token in query string only (no headers)
    const resPostQueryToken = await fetch(`${baseUrl}/api/webhooks/accesstrade?token=${TEST_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: 'ORD_QUERY_POST_1', billing: 100000, pub_commission: 10000 })
    });
    assert.strictEqual(resPostQueryToken.status, 401, 'POST with query token must be rejected with 401');

    // POST to postback with token/sig in query string only (no headers)
    const resPostbackQuerySig = await fetch(`${baseUrl}/api/webhooks/postback?sig=some_sig`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderSn: 'ORD_QUERY_POST_2' })
    });
    assert.strictEqual(resPostbackQuerySig.status, 401, 'POST /api/webhooks/postback with query sig must be rejected with 401');

    // GET to accesstrade with query token should be ACCEPTED for AccessTrade macro pings
    const resGetQueryToken = await fetch(`${baseUrl}/api/webhooks/accesstrade?token=${TEST_TOKEN}&order_id={order_id}`);
    assert.strictEqual(resGetQueryToken.status, 200, 'GET /api/webhooks/accesstrade with query token must return 200 for test ping');

    console.log('  PASS: Tokens in query params rejected on write operations (POST), allowed only for GET macro pings.');

    // -------------------------------------------------------------------------
    // TEST 3: HTTP Header Authentication (x-postback-token, Authorization: Bearer)
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing HTTP Header Token Authentication ---');
    // 3a. Header x-postback-token
    const resHeaderToken = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-postback-token': TEST_TOKEN
      },
      body: JSON.stringify({ order_id: '{order_id}' }) // AccessTrade test ping
    });
    assert.strictEqual(resHeaderToken.status, 200, 'x-postback-token header should succeed with 200');

    // 3b. Header Authorization: Bearer <token>
    const resBearerToken = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`
      },
      body: JSON.stringify({ order_id: '{order_id}' })
    });
    assert.strictEqual(resBearerToken.status, 200, 'Authorization: Bearer header should succeed with 200');

    // 3c. Invalid header token
    const resBadHeaderToken = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-postback-token': 'wrong_token'
      },
      body: JSON.stringify({ order_id: '{order_id}' })
    });
    assert.strictEqual(resBadHeaderToken.status, 401, 'Invalid x-postback-token must return 401');

    console.log('  PASS: Header token authentication (x-postback-token and Bearer) verified.');

    // -------------------------------------------------------------------------
    // TEST 4: Raw-Body HMAC SHA256 Verification & Timing-Safe Comparison
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Raw-Body HMAC SHA256 Verification ---');
    // Raw wire string with deliberate irregular whitespace to prove rawBody verification
    const irregularRawBody = '{\n  "orderSn" :  "ORD_HMAC_RAW_TEST_1", \n  "billing": 250000,\n  "status": "approved"\n}';
    const validHmac = crypto.createHmac('sha256', TEST_TOKEN).update(Buffer.from(irregularRawBody, 'utf8')).digest('hex');

    // 4a. Header x-signature-sha256 with valid raw-body HMAC
    const resHmacValid = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': validHmac
      },
      body: irregularRawBody
    });
    assert.strictEqual(resHmacValid.status, 200, 'Valid HMAC on rawBody should return 200');

    // 4b. Header x-signature-sha256 with sha256= prefix
    const resHmacPrefix = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': `sha256=${validHmac}`
      },
      body: irregularRawBody
    });
    assert.strictEqual(resHmacPrefix.status, 200, 'Valid HMAC with sha256= prefix should return 200');

    // 4c. Header x-postback-signature with valid raw-body HMAC
    const resPostbackSig = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-postback-signature': validHmac
      },
      body: irregularRawBody
    });
    assert.strictEqual(resPostbackSig.status, 200, 'Valid HMAC via x-postback-signature should return 200');

    // 4d. Invalid HMAC signature
    const resHmacBad = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': '0000000000000000000000000000000000000000000000000000000000000000'
      },
      body: irregularRawBody
    });
    assert.strictEqual(resHmacBad.status, 401, 'Invalid HMAC signature must return 401');

    // 4e. TimingSafeEqual mismatch length safety (doesn't crash)
    const resShortSig = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': 'abc'
      },
      body: irregularRawBody
    });
    assert.strictEqual(resShortSig.status, 401, 'Mismatched signature length must return 401 without crashing');

    console.log('  PASS: Raw-body HMAC SHA256 verified directly on incoming wire bytes.');

    // -------------------------------------------------------------------------
    // TEST 5: Anti-Replay Protection (Timestamp > 300s or in future > 60s)
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Anti-Replay Protection ---');
    const now = Date.now();

    // 5a. Expired timestamp (> 300s ago, e.g. 305s) via header x-webhook-timestamp
    const expiredTs = now - 305 * 1000;
    const expiredPayload = JSON.stringify({ orderSn: 'ORD_EXPIRED_1' });
    const expiredSig = crypto.createHmac('sha256', TEST_TOKEN).update(expiredPayload).digest('hex');

    const resExpired = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': expiredSig,
        'x-webhook-timestamp': String(expiredTs)
      },
      body: expiredPayload
    });
    assert.strictEqual(resExpired.status, 401, 'Expired timestamp (>300s) must return 401');
    const jsonExpired = await resExpired.json();
    assert(jsonExpired.error.includes('expired'), 'Error message should indicate expired timestamp');

    // 5b. Future timestamp (> 60s in future, e.g. 70s) via header x-webhook-timestamp
    const futureTs = now + 70 * 1000;
    const futurePayload = JSON.stringify({ orderSn: 'ORD_FUTURE_1' });
    const futureSig = crypto.createHmac('sha256', TEST_TOKEN).update(futurePayload).digest('hex');

    const resFuture = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': futureSig,
        'x-webhook-timestamp': String(futureTs)
      },
      body: futurePayload
    });
    assert.strictEqual(resFuture.status, 401, 'Future timestamp (>60s) must return 401');
    const jsonFuture = await resFuture.json();
    assert(jsonFuture.error.includes('future'), 'Error message should indicate timestamp in the future');

    // 5c. Valid timestamp within tolerance window (e.g. 10s ago)
    const validTs = now - 10 * 1000;
    const validTsPayload = JSON.stringify({ orderSn: 'ORD_VALID_TS_1' });
    const validTsSig = crypto.createHmac('sha256', TEST_TOKEN).update(validTsPayload).digest('hex');

    const resValidTs = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': validTsSig,
        'x-webhook-timestamp': String(validTs)
      },
      body: validTsPayload
    });
    assert.strictEqual(resValidTs.status, 200, 'Valid timestamp within window must return 200');

    // 5d. Expired timestamp in payload body.timestamp
    const expiredBodyPayload = JSON.stringify({
      orderSn: 'ORD_EXPIRED_PAYLOAD',
      timestamp: now - 400 * 1000
    });
    const expiredBodySig = crypto.createHmac('sha256', TEST_TOKEN).update(expiredBodyPayload).digest('hex');

    const resExpiredBody = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': expiredBodySig
      },
      body: expiredBodyPayload
    });
    assert.strictEqual(resExpiredBody.status, 401, 'Expired body.timestamp must return 401');

    // 5e. Invalid timestamp string
    const resInvalidTs = await fetch(`${baseUrl}/api/webhooks/postback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': validTsSig,
        'x-webhook-timestamp': 'not_a_valid_timestamp'
      },
      body: validTsPayload
    });
    assert.strictEqual(resInvalidTs.status, 401, 'Invalid timestamp format must return 401');

    console.log('  PASS: Replayed webhooks (>300s) and future requests (>60s) strictly rejected.');

    // -------------------------------------------------------------------------
    // TEST 6: AccessTrade Real-Time Postback with Header Signature & State Update
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing AccessTrade Real-Time Postback with Header Signature ---');
    const atOrderSn = `ORD_AT_REALTIME_${Date.now()}`;
    const atPayload = JSON.stringify({
      order_id: atOrderSn,
      billing: 500000,
      pub_commission: 50000,
      status: 'approved',
      merchant: 'shopee'
    });
    const atSig = crypto.createHmac('sha256', TEST_TOKEN).update(atPayload).digest('hex');

    const resAtPostback = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': atSig
      },
      body: atPayload
    });
    assert.strictEqual(resAtPostback.status, 200, 'POST /api/webhooks/accesstrade with HMAC must return 200');
    const jsonAt = await resAtPostback.json();
    assert.strictEqual(jsonAt.status, 'ok');
    assert.strictEqual(jsonAt.orderSn, atOrderSn);

    const savedOrder = db.orders.find((o) => o.orderSn === atOrderSn);
    assert(savedOrder, 'Order must be saved in database');
    assert.strictEqual(savedOrder.status, 'approved', 'Order status must be approved');
    assert.strictEqual(savedOrder.orderAmount, 500000, 'Order amount must match');

    console.log('  PASS: AccessTrade real-time webhook processed securely with HMAC.');

    // -------------------------------------------------------------------------
    // TEST 7: Database Settings Postback Token Support (db.settings.postbackToken)
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Testing db.settings.postbackToken fallback ---');
    delete process.env.POSTBACK_TOKEN;
    delete process.env.POSTBACK_SECRET;
    const DB_TOKEN = 'db_setting_token_9999';
    db.settings.postbackToken = DB_TOKEN;
    assert.strictEqual(getConfiguredPostbackToken(db), DB_TOKEN, 'Should load token from db.settings.postbackToken');

    const testDbPayload = JSON.stringify({ order_id: '{order_id}' });
    const testDbSig = crypto.createHmac('sha256', DB_TOKEN).update(testDbPayload).digest('hex');

    const resDbToken = await fetch(`${baseUrl}/api/webhooks/accesstrade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature-sha256': testDbSig
      },
      body: testDbPayload
    });
    assert.strictEqual(resDbToken.status, 200, 'Token configured in db.settings.postbackToken must authenticate successfully');

    console.log('  PASS: db.settings.postbackToken works correctly.');

    console.log('\n=== ALL WEBHOOK SECURITY TESTS PASSED SUCCESSFULLY! ===\n');
  } finally {
    // Restore environment
    if (savedEnvToken !== undefined) process.env.POSTBACK_TOKEN = savedEnvToken;
    else delete process.env.POSTBACK_TOKEN;

    if (savedEnvSecret !== undefined) process.env.POSTBACK_SECRET = savedEnvSecret;
    else delete process.env.POSTBACK_SECRET;

    if (savedDbSetting !== undefined) db.settings.postbackToken = savedDbSetting;
    else delete db.settings.postbackToken;

    await new Promise((resolve) => server.close(resolve));
  }
}

runWebhookSecurityTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
