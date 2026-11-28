const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';

const { ensureDbLoaded, saveDb, createToken, hashPassword } = require('../../src/services/dbService');
const { registerCashbackRoutes } = require('../../src/services/cashbackController');
const { signVerifiedProductToken } = require('../../src/services/tiktokCompareService');
const { generateTikTokAccessTradeLink } = require('../../src/services/tiktokService');

async function run() {
  console.log('=== AFFILIATE ATTRIBUTION & SECURITY AUDIT TESTS ===\n');

  // 1. TikTok AccessTrade v2 MUST reject aff_url missing subId
  console.log('1. Testing TikTok subId tracking guard...');
  let missingSubErr = null;
  try {
    await generateTikTokAccessTradeLink(
      'https://shop.tiktok.com/view/product/1731441537784974253',
      '1731441537784974253',
      {
        accesstradeApiKey: 'dummy_key',
        subId: 'expected_sub_123',
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              product_id: '1731441537784974253',
              aff_short_url: 'https://shorten.asia/abc',
              aff_url: 'https://go.isclix.com/deep_link/7110811489339796158/6648523843406889655?url=https%3A%2F%2Fwww.tiktok.com%2Ft%2FZStest'
            }
          })
        })
      }
    );
  } catch (err) {
    missingSubErr = err;
  }
  assert(missingSubErr && /subId/i.test(missingSubErr.message), 'Must reject aff_url missing subId tracking');
  console.log('   PASS: aff_url missing subId rejected.');

  // 2. Express End-to-End Affiliate Link & clickRecord Attribution (Compare + Deal Shelf)
  console.log('2. Testing Shopee & TikTok compare/deal link endpoints & clickRecord attribution...');
  const db = ensureDbLoaded();
  db.users = [];
  db.clicks = [];
  db.settings = {
    ...(db.settings || {}),
    shopeeMode: 'an_redir',
    shopeeAffiliateId: '17346310715',
    accesstradeApiKey: 'test_at_key_audit',
    tiktokDeepLinkTemplate: 'https://go.isclix.com/deep_link/v6/7110811489339796158/6648523843406889655?sub4=oneatweb'
  };
  const user = {
    id: 'usr_aff_audit_1',
    code: 'UAFF01',
    name: 'Affiliate Audit User',
    phone: '0909111222',
    passwordHash: hashPassword('Audit@12345'),
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDb(db);
  const token = createToken(user);

  const originalFetch = global.fetch;
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(base)) return originalFetch(url, init);
    if (u.includes('/v2/tiktokshop_product_feeds/create_link')) {
      const parsed = JSON.parse(init.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: {
            product_id: parsed.product_id,
            aff_short_url: 'https://shorten.asia/auditTtOk',
            aff_url: `https://go.isclix.com/deep_link/7110811489339796158/6648523843406889655?url=https%3A%2F%2Fwww.tiktok.com%2Ft%2FZSok&sub1=${parsed.sub1}&utm_source=${parsed.utm_source}`
          }
        })
      };
    }
    return originalFetch(url, init);
  };

  try {
    // 2A. Shopee link from Home Deal Shelf (with HMAC verifyToken + spoofed userId attempt)
    const spToken = signVerifiedProductToken({
      platform: 'shopee',
      productId: '53019542563',
      shopId: '1862178474',
      detailLink: 'https://shopee.vn/product/1862178474/53019542563'
    });
    const spRes = await originalFetch(`${base}/api/compare/shopee/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        itemId: '53019542563',
        shopId: '1862178474',
        verifyToken: spToken,
        source: 'home_deal_shelf',
        dealGroup: 'trending',
        userId: 'spoofed_other_user', // Must be ignored!
        affiliateUrl: 'https://evil.com/hijack' // Must be ignored!
      })
    });
    assert.strictEqual(spRes.status, 200);
    const spJson = await spRes.json();
    assert.strictEqual(spJson.ok, true);
    const spUrl = new URL(spJson.affiliateUrl);
    assert.strictEqual(spUrl.hostname, 's.shopee.vn');
    assert.strictEqual(spUrl.searchParams.get('affiliate_id'), '17346310715');
    assert.strictEqual(spUrl.searchParams.get('sub_id'), spJson.clickId);

    const spClick = ensureDbLoaded().clicks.find((c) => c.clickId === spJson.clickId);
    assert(spClick, 'Shopee clickRecord must be saved');
    assert.strictEqual(spClick.userId, user.id, 'Spoofed userId must be ignored');
    assert.strictEqual(spClick.platform, 'shopee');
    assert.strictEqual(spClick.source, 'home_deal_shelf');
    assert.strictEqual(spClick.dealGroup, 'trending');

    // 2B. TikTok link from Shopee->TikTok compare
    const ttToken = signVerifiedProductToken({
      platform: 'tiktok',
      productId: '1731441537784974253',
      detailLink: 'https://shop.tiktok.com/view/product/1731441537784974253?region=VN&local=en'
    });
    const ttRes = await originalFetch(`${base}/api/compare/tiktok/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        productId: '1731441537784974253',
        verifyToken: ttToken
      })
    });
    assert.strictEqual(ttRes.status, 200);
    const ttJson = await ttRes.json();
    assert.strictEqual(ttJson.ok, true);
    assert.strictEqual(ttJson.affiliateUrl, 'https://shorten.asia/auditTtOk');

    const ttClick = ensureDbLoaded().clicks.find((c) => c.clickId === ttJson.clickId);
    assert(ttClick, 'TikTok clickRecord must be saved');
    assert.strictEqual(ttClick.userId, user.id);
    assert.strictEqual(ttClick.platform, 'tiktok');
    assert.strictEqual(ttClick.source, 'compare_sp_to_tt');
    console.log('   PASS: Shopee & TikTok affiliate links, Publisher IDs, sub_id tracking & clickRecord attribution verified!');
  } finally {
    global.fetch = originalFetch;
    await new Promise((r) => server.close(r));
  }

  console.log('\nALL AFFILIATE ATTRIBUTION & SECURITY TESTS PASSED!');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
