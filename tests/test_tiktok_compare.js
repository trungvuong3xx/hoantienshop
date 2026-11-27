const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.NODE_ENV = 'test';

const {
  cleanShopeeTitleForSearch,
  buildShorterFallbackQuery,
  extractProductUnits,
  scoreTikTokCandidate,
  buildComparableProduct,
  searchComparableTikTokProducts,
  scoreShopeeCandidate,
  buildComparableShopeeProduct,
  searchComparableShopeeProducts,
  clearCompareCaches
} = require('../src/services/tiktokCompareService');
const { ensureDbLoaded, saveDb, createToken, hashPassword } = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

function makeMockProduct(overrides = {}) {
  return {
    id: '1738459399426246582',
    title: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ Kiềm Dầu 50ml',
    detail_link: 'https://shop.tiktok.com/view/product/1738459399426246582?region=VN&local=en',
    main_image_url: 'https://p16-oec-sg.ibyteimg.com/sample.jpg',
    has_inventory: true,
    units_sold: 120,
    shop: { name: 'Lorocheoutletstore' },
    sales_price: { currency: 'VND', minimum_amount: '350034', maximum_amount: '350034' },
    original_price: { currency: 'VND', minimum_amount: '420000', maximum_amount: '420000' },
    commission: { currency: 'VND', amount: '34030.06565', rate: '0.09721' },
    ...overrides
  };
}

async function runTests() {
  console.log('=== STARTING SHOPEE -> TIKTOK COMPARISON VERIFICATION SUITE ===\n');

  // 1. Keyword Cleaning
  console.log('1. Testing cleanShopeeTitleForSearch...');
  const cleaned = cleanShopeeTitleForSearch(
    '[CHÍNH HÃNG] [Hỏa tốc] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml (Freeship)'
  );
  assert(!/chính hãng|hỏa tốc|freeship|\[|\]/i.test(cleaned), `Promo tags should be removed: ${cleaned}`);
  assert(cleaned.includes('La Roche Posay'), `Brand must be preserved: ${cleaned}`);
  assert(cleaned.includes('50ml'), `Volume must be preserved: ${cleaned}`);
  console.log('   PASS:', cleaned);

  // 2. Unit Extraction & Volume Mismatch Guard (Case 3)
  console.log('2. Testing volume/capacity mismatch rejection...');
  const units50 = extractProductUnits('Kem Chống Nắng La Roche Posay 50ml');
  assert.strictEqual(units50[0].type, 'volume');
  assert.strictEqual(units50[0].value, 50);

  const exactMatch = scoreTikTokCandidate(
    '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    380000,
    makeMockProduct()
  );
  assert.strictEqual(exactMatch.eligible, true, 'Exact 50ml product must be eligible');
  assert(exactMatch.score >= 0.5, `Expected high score, got ${exactMatch.score}`);

  const wrongVolume = scoreTikTokCandidate(
    '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    380000,
    makeMockProduct({
      id: '1738459399426246599',
      title: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 15ml Mini'
    })
  );
  assert.strictEqual(wrongVolume.eligible, false, '15ml mini must not match 50ml full-size');
  assert.strictEqual(wrongVolume.reason, 'unit_mismatch');

  // Combo vs single & Combo 3 vs Combo 5 must be rejected
  const combo3VsCombo5 = scoreTikTokCandidate(
    'Combo 3 Bộ Pijama Nữ Mặc Nhà Lụa Satin Cao Cấp',
    180000,
    makeMockProduct({
      id: '1738459399426246601',
      title: 'Combo 5 Bộ Pijama Nữ Mặc Nhà Lụa Satin Cao Cấp',
      sales_price: { minimum_amount: '250000' }
    })
  );
  assert.strictEqual(combo3VsCombo5.eligible, false, 'Combo 3 must not match Combo 5');
  assert.strictEqual(combo3VsCombo5.reason, 'unit_mismatch');

  const singleVsCombo3 = scoreTikTokCandidate(
    'Bộ Pijama Nữ Mặc Nhà Lụa Satin Cao Cấp',
    120000,
    makeMockProduct({
      id: '1738459399426246602',
      title: 'Combo 3 Bộ Pijama Nữ Mặc Nhà Lụa Satin Cao Cấp',
      sales_price: { minimum_amount: '180000' }
    })
  );
  assert.strictEqual(singleVsCombo3.eligible, false, 'Single item must not match Combo 3');
  assert.strictEqual(singleVsCombo3.reason, 'unit_mismatch');

  const combo3VsCombo3 = scoreTikTokCandidate(
    'Combo 3 Bộ Pijama Nữ Mặc Nhà Lụa Satin Cao Cấp',
    180000,
    makeMockProduct({
      id: '1738459399426246603',
      title: '[Peinn] Combo 3 Bộ Pijama Nữ Mặc Nhà Lụa Satin Mềm Mịn',
      sales_price: { minimum_amount: '165000' }
    })
  );
  assert.strictEqual(combo3VsCombo3.eligible, true, 'Combo 3 must match Combo 3');
  console.log('   PASS: Exact volume, combo-vs-single, and combo-count mismatch guards verified.');

  // 3. Exact Cashback Formula & Net Price Comparison (Cases 1, 8, 9)
  console.log('3. Testing cashback formula (commission * 0.9 * 0.7) & comparison labels...');
  const priced = buildComparableProduct(makeMockProduct(), {
    shopeeEffectivePrice: 356595,
    cashbackPercent: 70,
    taxDeductPercent: 10,
    matchScore: 0.9
  });
  assert.strictEqual(priced.price, 350034);
  assert.strictEqual(priced.grossCommission, 34030);
  assert.strictEqual(priced.estimatedCashback, 21439, '34030 -> net 30627 -> 70% = 21439');
  assert.strictEqual(priced.effectivePrice, 328595, '350034 - 21439 = 328595');
  assert.strictEqual(priced.savingsVsShopee, 28000);
  assert.strictEqual(priced.comparisonStatus, 'tiktok_cheaper');
  assert(priced.comparisonLabel.includes('28.000đ'), `Expected savings label, got ${priced.comparisonLabel}`);

  // Zero / invalid commission must yield 0 cashback (no fabricated rate)
  const zeroComm = buildComparableProduct(
    makeMockProduct({ commission: { amount: '0', rate: '0' } }),
    { shopeeEffectivePrice: 320000, cashbackPercent: 70, taxDeductPercent: 10, matchScore: 0.8 }
  );
  assert.strictEqual(zeroComm.grossCommission, 0);
  assert.strictEqual(zeroComm.estimatedCashback, 0);
  assert.strictEqual(zeroComm.effectivePrice, 350034);
  assert.strictEqual(zeroComm.comparisonStatus, 'shopee_cheaper');

  // Invalid/missing price must be rejected
  const invalidPriceEval = scoreTikTokCandidate(
    'Kem Chống Nắng La Roche Posay Anthelios 50ml',
    350000,
    makeMockProduct({ sales_price: { minimum_amount: '' }, original_price: { minimum_amount: '0' } })
  );
  assert.strictEqual(invalidPriceEval.eligible, false);
  assert.strictEqual(invalidPriceEval.reason, 'invalid_price');
  console.log('   PASS: Exact formula, zero commission, and invalid price verified.');

  // 4. Multiple Similar Results, Top-3 Cap, Empty 200, Errors 401/403/429/500 & Timeout (Cases 2, 4, 5, 6, 7)
  console.log('4. Testing multi-result ranking, empty 200, HTTP 401/403/429/500, and timeout...');
  clearCompareCaches();
  const multiFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        products: [
          makeMockProduct({ id: '100000000001', sales_price: { minimum_amount: '360000' } }),
          makeMockProduct({ id: '100000000002', sales_price: { minimum_amount: '330000' } }),
          makeMockProduct({ id: '100000000003', sales_price: { minimum_amount: '345000' } }),
          makeMockProduct({ id: '100000000004', sales_price: { minimum_amount: '370000' } }),
          makeMockProduct({
            id: '100000000005',
            title: 'Ốp lưng điện thoại silicon trong suốt',
            sales_price: { minimum_amount: '340000' }
          })
        ]
      }
    })
  });

  const multiRes = await searchComparableTikTokProducts(
    {
      shopeeTitle: '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      shopeePrice: 380000,
      shopeeEstimatedCashback: 20000,
      apiKey: 'dummy_test_key'
    },
    { fetchFn: multiFetch }
  );
  assert.strictEqual(multiRes.found, true);
  assert.strictEqual(multiRes.items.length, 3, 'Must cap results at max 3');
  assert.strictEqual(multiRes.items[0].productId, '100000000002', 'Cheapest effective price among equal matches must rank first');
  assert.strictEqual(multiRes.items[0].detailLink, undefined, 'Internal detailLink must not leak to client');

  // Cache hit check
  let fetchCalls = 0;
  const cachedRes = await searchComparableTikTokProducts(
    {
      shopeeTitle: '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      shopeePrice: 380000,
      shopeeEstimatedCashback: 20000,
      apiKey: 'dummy_test_key'
    },
    {
      fetchFn: async () => {
        fetchCalls++;
        return multiFetch();
      }
    }
  );
  assert.strictEqual(cachedRes.cached, true);
  assert.strictEqual(fetchCalls, 0, 'Repeated query must hit cache without calling upstream API');

  // Empty 200
  clearCompareCaches();
  const emptyRes = await searchComparableTikTokProducts(
    { shopeeTitle: 'Sản phẩm rất hiếm XYZ 999', shopeePrice: 200000, apiKey: 'dummy_test_key' },
    {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { products: [] } })
      })
    }
  );
  assert.strictEqual(emptyRes.ok, true);
  assert.strictEqual(emptyRes.found, false);
  assert.strictEqual(emptyRes.items.length, 0);

  // HTTP 401, 403, 429, 500
  for (const statusCode of [401, 403, 429, 500]) {
    clearCompareCaches();
    let caught = null;
    try {
      await searchComparableTikTokProducts(
        { shopeeTitle: 'Kem Chống Nắng La Roche Posay 50ml', shopeePrice: 350000, apiKey: 'dummy_test_key' },
        { fetchFn: async () => ({ ok: false, status: statusCode }) }
      );
    } catch (e) {
      caught = e;
    }
    assert(caught, `HTTP ${statusCode} must throw handled error`);
    assert(!caught.message.includes('dummy_test_key'), 'API key must never appear in error message');
  }

  // Timeout error
  clearCompareCaches();
  let timeoutErr = null;
  try {
    await searchComparableTikTokProducts(
      { shopeeTitle: 'Kem Chống Nắng La Roche Posay 50ml', shopeePrice: 350000, apiKey: 'dummy_test_key' },
      {
        fetchFn: async () => {
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          throw e;
        }
      }
    );
  } catch (e) {
    timeoutErr = e;
  }
  assert(timeoutErr && timeoutErr.code === 'TIMEOUT', 'Timeout must be classified cleanly');
  console.log('   PASS: Ranking, top-3 cap, cache, empty 200, HTTP 401/403/429/500 & timeout verified.');

  // 5. Endpoint Integration Tests: POST /api/compare/tiktok & POST /api/compare/tiktok/link (Cases 10, 11, 12)
  console.log('5. Testing Express endpoints /api/compare/tiktok & /api/compare/tiktok/link...');
  const db = ensureDbLoaded();
  db.users = [];
  db.clicks = [];
  db.settings = {
    ...(db.settings || {}),
    cashbackPercent: 70,
    taxDeductPercent: 10,
    accesstradeApiKey: 'test_secret_at_key_999'
  };
  const testUser = {
    id: 'usr_cmp_test_1',
    code: 'UCMP01',
    name: 'Test Compare User',
    phone: '0901234567',
    passwordHash: hashPassword('Test@12345'),
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(testUser);
  saveDb(db);
  const userToken = createToken(testUser);

  const originalFetch = global.fetch;
  let createLinkShouldFail = false;

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) {
      return originalFetch(url, init);
    }
    if (u.includes('/v2/tiktokshop_product_feeds/create_link')) {
      if (createLinkShouldFail) {
        return { ok: false, status: 500, json: async () => ({ status: false, message: 'Server error' }) };
      }
      const parsedBody = JSON.parse(init.body || '{}');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: {
            product_id: parsedBody.product_id,
            aff_short_url: 'https://shorten.asia/testAff123',
            aff_url: `https://go.isclix.com/deep_link/1/2?url=https%3A%2F%2Fwww.tiktok.com%2Ft%2FZStest&sub1=${parsedBody.sub1}&utm_source=${parsedBody.utm_source}`
          }
        })
      };
    }
    if (u.includes('/v2/tiktokshop_product_feeds')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { products: [makeMockProduct()] } })
      };
    }
    return originalFetch(url, init);
  };

  try {
    clearCompareCaches();
    // Compare endpoint
    const cmpRes = await originalFetch(`${baseUrl}/api/compare/tiktok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        productName: '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
        shopeePrice: 380000,
        shopeeEstimatedCashback: 23405
      })
    });
    assert.strictEqual(cmpRes.status, 200);
    const cmpJson = await cmpRes.json();
    assert.strictEqual(cmpJson.found, true);
    assert.strictEqual(cmpJson.items.length, 1);
    assert.strictEqual(cmpJson.items[0].grossCommission, undefined, 'grossCommission must be stripped from public response');
    assert.strictEqual(cmpJson.items[0].commissionRate, undefined, 'commissionRate must be stripped from public response');
    assert(!JSON.stringify(cmpJson).includes('test_secret_at_key_999'), 'API key must never leak in response');

    // Reject invalid productId (arbitrary URL / non-numeric)
    const badIdRes = await originalFetch(`${baseUrl}/api/compare/tiktok/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ productId: 'https://evil.example.com/phish' })
    });
    assert.strictEqual(badIdRes.status, 400, 'Non-numeric productId must be rejected');

    // Create affiliate link success -> verify click recorded & balance stays 0
    const linkRes = await originalFetch(`${baseUrl}/api/compare/tiktok/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ productId: '1738459399426246582' })
    });
    assert.strictEqual(linkRes.status, 200);
    const linkJson = await linkRes.json();
    assert.strictEqual(linkJson.ok, true);
    assert.strictEqual(linkJson.affiliateUrl, 'https://shorten.asia/testAff123');
    assert(linkJson.clickId && linkJson.clickId.length === 16, 'Must generate 16-hex clickId');

    const recordedClick = db.clicks.find((c) => c.clickId === linkJson.clickId);
    assert(recordedClick, 'Click must be recorded in db.clicks');
    assert.strictEqual(recordedClick.userId, testUser.id);
    assert.strictEqual(recordedClick.userCode, 'UCMP01');
    assert.strictEqual(recordedClick.platform, 'tiktok');
    assert.strictEqual(testUser.balanceAvailable, 0, 'Clicking must NEVER credit available balance');

    // Create affiliate link failure -> must return error and NOT record click
    createLinkShouldFail = true;
    const clicksBeforeFail = db.clicks.length;
    const failLinkRes = await originalFetch(`${baseUrl}/api/compare/tiktok/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ productId: '1738459399426246582' })
    });
    assert.strictEqual(failLinkRes.status, 502);
    const failLinkJson = await failLinkRes.json();
    assert.strictEqual(failLinkJson.ok, false);
    assert.strictEqual(db.clicks.length, clicksBeforeFail, 'Failed link creation must not record a click');
  } finally {
    global.fetch = originalFetch;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('   PASS: Endpoints, click tracking, security guards & failure handling verified.');

  // 6. Frontend UI & Security Markers (Cases 12, 13, 14)
  console.log('6. Testing reverse direction (TikTok Shop -> Shopee)...');
  clearCompareCaches();
  const mockShopeeNode = {
    itemId: '28899112233',
    shopId: '99887766',
    productName: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    shopName: 'La Roche-Posay Official',
    imageUrl: 'https://down-vn.img.susercontent.com/sample.jpg',
    price: 330000,
    commissionRate: 10,
    commission: 33000,
    sales: 1500,
    productLink: 'https://shopee.vn/product/99887766/28899112233'
  };
  const spScore = scoreShopeeCandidate(
    'LA Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    350034,
    mockShopeeNode
  );
  assert.strictEqual(spScore.eligible, true);
  const spPriced = buildComparableShopeeProduct(mockShopeeNode, {
    tiktokEffectivePrice: 328595,
    cashbackPercent: 70,
    taxDeductPercent: 10,
    matchScore: spScore.score,
    productLink: spScore.productLink
  });
  assert.strictEqual(spPriced.estimatedCashback, 20790, '33000 -> net 29700 -> 70% = 20790');
  assert.strictEqual(spPriced.effectivePrice, 309210, '330000 - 20790 = 309210');
  assert.strictEqual(spPriced.comparisonStatus, 'target_cheaper');
  assert(spPriced.comparisonLabel.includes('Shopee'), `Expected Shopee cheaper label, got ${spPriced.comparisonLabel}`);

  // String formatted price ("330,000" / "1.250.000") handling on Shopee side
  const formattedPriceNode = { ...mockShopeeNode, price: '330,000', commission: '33.000' };
  const spStrScore = scoreShopeeCandidate(
    'LA Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    350034,
    formattedPriceNode
  );
  assert.strictEqual(spStrScore.eligible, true, 'Comma-formatted string price must parse cleanly');
  const spStrPriced = buildComparableShopeeProduct(formattedPriceNode, {
    tiktokEffectivePrice: 328595,
    cashbackPercent: 70,
    taxDeductPercent: 10,
    matchScore: spStrScore.score,
    productLink: spStrScore.productLink
  });
  assert.strictEqual(spStrPriced.price, 330000);
  assert.strictEqual(spStrPriced.grossCommission, 33000);

  const spSearchRes = await searchComparableShopeeProducts(
    {
      tiktokTitle: 'LA Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      tiktokPrice: 350034,
      tiktokEstimatedCashback: 21439,
      appId: 'dummy_app',
      appSecret: 'dummy_secret'
    },
    {
      searchShopeeFn: async () => [
        mockShopeeNode,
        { ...mockShopeeNode, itemId: '28899112244', productName: 'Kem Chống Nắng La Roche Posay 15ml Mini' }
      ]
    }
  );
  assert.strictEqual(spSearchRes.found, true);
  assert.strictEqual(spSearchRes.items.length, 1, '15ml mini must be filtered out on Shopee side too');
  assert.strictEqual(spSearchRes.items[0].productLink, undefined, 'Internal productLink must not leak');
  assert.strictEqual(spSearchRes.items[0].grossCommission, undefined, 'Internal grossCommission must not leak');

  // Regression: TikTok obfuscated title ("N. ú.m") + Brand Gate must reject unrelated Shopee products
  const obfuscatedTitle = '[LIVE] Đồ dùng trẻ em N. ú.m Greenfinger Bebegrow mềm mại, chịu nhiệt tốt';
  const cleanedNipple = cleanShopeeTitleForSearch(obfuscatedTitle);
  assert(cleanedNipple.includes('Núm'), `Expected obfuscated N. ú.m -> Núm, got: ${cleanedNipple}`);
  const nippleFallback = buildShorterFallbackQuery(cleanedNipple);
  assert(
    nippleFallback.includes('Greenfinger') && nippleFallback.includes('Bebegrow'),
    `Fallback query must preserve brand tokens, got: ${nippleFallback}`
  );
  const unrelatedShopeeNodes = [
    { ...mockShopeeNode, itemId: '90001', price: 54400, productName: 'Kam Vải ủi chịu nhiệt 6 tờ Lớp bảo vệ có thể tái sử dụng cho hạt cầu chì' },
    { ...mockShopeeNode, itemId: '90002', price: 46224, productName: 'SWEET Thiết Kế Chống Trơn Trượt Ngón Tay Ván Trượt Đồ Chơi Ván' },
    { ...mockShopeeNode, itemId: '90003', price: 48165, productName: '(V & N) Kids Beach Castle Buet Spade Xẻng Cào Dụng Cụ Nước Cho Bé' }
  ];
  for (const junk of unrelatedShopeeNodes) {
    const rej = scoreShopeeCandidate(obfuscatedTitle, 179520, junk);
    assert.strictEqual(rej.eligible, false, `Unrelated product must be rejected: ${junk.productName}`);
    assert.strictEqual(rej.reason, 'brand_mismatch', `Expected brand_mismatch for: ${junk.productName}`);
  }
  const realNippleNode = {
    ...mockShopeeNode,
    itemId: '90004',
    price: 165000,
    commission: 12000,
    productName: 'Núm ti Greenfinger Bebegrow mềm mại chịu nhiệt cho bé'
  };
  const accNipple = scoreShopeeCandidate(obfuscatedTitle, 179520, realNippleNode);
  assert.strictEqual(accNipple.eligible, true, 'Real Greenfinger Bebegrow nipple must match cleanly');

  // Test POST /api/compare/shopee/link endpoint
  const app2 = express();
  app2.use(express.json());
  registerCashbackRoutes(app2);
  const server2 = http.createServer(app2);
  await new Promise((resolve) => server2.listen(0, resolve));
  const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const badSpId = await originalFetch(`${baseUrl2}/api/compare/shopee/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ itemId: 'https://evil.com/x' })
    });
    assert.strictEqual(badSpId.status, 400);

    const okSpLink = await originalFetch(`${baseUrl2}/api/compare/shopee/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ itemId: '28899112233', shopId: '99887766' })
    });
    assert.strictEqual(okSpLink.status, 200);
    const okSpJson = await okSpLink.json();
    assert.strictEqual(okSpJson.ok, true);
    assert(okSpJson.affiliateUrl && okSpJson.affiliateUrl.includes('shopee'), 'Must return valid Shopee affiliate URL');
    const spClick = db.clicks.find((c) => c.clickId === okSpJson.clickId);
    assert(spClick && spClick.platform === 'shopee' && spClick.userCode === 'UCMP01', 'Shopee click must be tracked');
  } finally {
    server2.closeAllConnections?.();
    await new Promise((resolve) => server2.close(resolve));
  }
  console.log('   PASS: Reverse direction (TikTok -> Shopee) search, formula, security & tracking verified.');

  console.log('7. Checking frontend HTML/CSS/JS integration...');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  assert(html.includes('id="tiktokCompareSection"'), 'index.html must include #tiktokCompareSection');
  assert(css.includes('.tt-compare-section') && css.includes('.cp-net-price-formula'), 'styles.css must include comparison styles');
  assert(js.includes('/api/compare/tiktok') && js.includes('/api/compare/tiktok/link'), 'app.js must call backend TikTok compare endpoints');
  assert(js.includes('/api/compare/shopee') && js.includes('/api/compare/shopee/link'), 'app.js must call backend Shopee compare endpoints');
  assert(!js.includes('api.accesstrade.vn'), 'Frontend must NEVER call AccessTrade API directly');
  assert(js.includes('inFlightTikTokCompareLinks') && js.includes('createdTikTokCompareLinks'), 'Frontend must deduplicate rapid clicks');
  assert(js.includes('tiktokCompareRenderSeq'), 'Frontend must guard against stale async race conditions');
  assert(js.includes('Hoàn tối đa ~'), 'Frontend must show cashback label on compare cards');
  assert(!js.includes('Hoa hồng dự kiến'), 'Frontend must not expose gross commission row');
  assert(js.includes('MUA TIKTOK NHẬN HOÀN TIỀN') && js.includes('MUA SHOPEE NHẬN HOÀN TIỀN'), 'Frontend must include both CTA buttons');
  assert(js.includes('Chưa bao gồm voucher cá nhân'), 'Frontend must include transparency disclaimer');
  console.log('   PASS: Frontend markers, anti-double-click, and security checks verified.');

  console.log('\n=== ALL SHOPEE -> TIKTOK COMPARISON TESTS PASSED ===');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
