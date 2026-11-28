const assert = require('assert');

process.env.NODE_ENV = 'test';

const {
  searchComparableTikTokProducts,
  getVerifiedTikTokProduct,
  getVerifiedShopeeProduct,
  signVerifiedProductToken,
  verifyProductToken,
  clearCompareCaches
} = require('../../src/services/tiktokCompareService');
const circuitBreaker = require('../../src/services/compare/circuitBreaker');

function makeMockProduct(overrides = {}) {
  return {
    id: '1738459399426246582',
    title: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
    detail_link: 'https://shop.tiktok.com/view/product/1738459399426246582?region=VN&local=en',
    main_image_url: 'https://p16-oec-sg.ibyteimg.com/sample.jpg',
    has_inventory: true,
    units_sold: 120,
    shop: { name: 'LRP Official' },
    sales_price: { currency: 'VND', minimum_amount: '350000', maximum_amount: '350000' },
    original_price: { currency: 'VND', minimum_amount: '420000', maximum_amount: '420000' },
    commission: { currency: 'VND', amount: '35000', rate: '0.10' },
    ...overrides
  };
}

async function run() {
  console.log('=== P0 + P1 + P2 COMPARE ENGINE VERIFICATION ===\n');

  // 1. Decoupled Raw Candidate Cache across VIP tiers (70% vs 80%)
  console.log('1. Testing decoupled raw candidate cache across VIP tiers...');
  clearCompareCaches();
  let upstreamCalls = 0;
  const mockFetch = async () => {
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, 15));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { products: [makeMockProduct()] } })
    };
  };

  const bronzeRes = await searchComparableTikTokProducts(
    {
      shopeeTitle: '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      shopeePrice: 380000,
      shopeeEstimatedCashback: 20000,
      cashbackPercent: 70,
      taxDeductPercent: 10,
      apiKey: 'dummy'
    },
    { fetchFn: mockFetch }
  );

  const vipRes = await searchComparableTikTokProducts(
    {
      shopeeTitle: '[CHÍNH HÃNG] Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      shopeePrice: 395000,
      shopeeEstimatedCashback: 25000,
      cashbackPercent: 80,
      taxDeductPercent: 10,
      apiKey: 'dummy'
    },
    { fetchFn: mockFetch }
  );

  assert.strictEqual(upstreamCalls, 1, 'VIP user must reuse raw candidate cache from Bronze user');
  assert.strictEqual(bronzeRes.cached, false);
  assert.strictEqual(vipRes.cached, true);
  assert.strictEqual(bronzeRes.items[0].estimatedCashback, 22050, '35000 * 0.9 * 0.7 = 22050');
  assert.strictEqual(vipRes.items[0].estimatedCashback, 25200, '35000 * 0.9 * 0.8 = 25200');
  assert(bronzeRes.fetchedAt && vipRes.fetchedAt, 'fetchedAt timestamp must be returned');
  assert.strictEqual(bronzeRes.fetchedAt, vipRes.fetchedAt, 'Cached response must preserve original fetchedAt');
  assert.strictEqual(bronzeRes.items[0].matchTier, 'exact');
  console.log('   PASS: VIP 80% reused raw cache from Bronze 70% with exact dynamic cashback!');

  // 2. Single-Flight Request Coalescing
  console.log('2. Testing Single-Flight concurrent coalescing...');
  clearCompareCaches();
  let concurrentCalls = 0;
  const slowFetch = async () => {
    concurrentCalls++;
    await new Promise((r) => setTimeout(r, 40));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { products: [makeMockProduct()] } })
    };
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      searchComparableTikTokProducts(
        {
          shopeeTitle: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
          shopeePrice: 380000,
          apiKey: 'dummy'
        },
        { fetchFn: slowFetch }
      )
    )
  );
  assert.strictEqual(concurrentCalls, 1, '5 concurrent identical searches must coalesce into 1 upstream call');
  assert(results.every((r) => r.found && r.items.length === 1));
  console.log('   PASS: 5 concurrent searches coalesced into 1 upstream call.');

  // 3. Stateless HMAC verifyToken survives serverless cold-start (clearCompareCaches)
  console.log('3. Testing stateless HMAC verifyToken across cold-start...');
  const token = bronzeRes.items[0].verifyToken;
  assert(token && token.includes('.'), 'verifyToken must be issued on compare items');
  clearCompareCaches(); // Simulate cold-start on a brand-new Vercel lambda!
  const verifiedAfterColdStart = getVerifiedTikTokProduct('1738459399426246582', token);
  assert(verifiedAfterColdStart, 'HMAC verifyToken must verify even when L1 RAM cache is empty');
  assert.strictEqual(
    verifiedAfterColdStart.detailLink,
    'https://shop.tiktok.com/view/product/1738459399426246582?region=VN&local=en'
  );
  // Tampered token must fail
  assert.strictEqual(verifyProductToken(`${token}tampered`, 'tiktok', '1738459399426246582'), null);
  // Wrong platform must fail
  assert.strictEqual(getVerifiedShopeeProduct('1738459399426246582', token), null);
  // Foreign domain must fail
  const badDomainToken = signVerifiedProductToken({
    platform: 'tiktok',
    productId: '1738459399426246582',
    detailLink: 'https://evil.example.com/phish'
  });
  assert.strictEqual(verifyProductToken(badDomainToken, 'tiktok', '1738459399426246582'), null);
  console.log('   PASS: HMAC verifyToken survives cold-start & blocks tampering/foreign domains.');

  // 4. Multi-SKU Price Range detection
  console.log('4. Testing multi-SKU hasPriceRange detection...');
  clearCompareCaches();
  const rangeRes = await searchComparableTikTokProducts(
    {
      shopeeTitle: 'Kem Chống Nắng La Roche Posay Anthelios UVMune 400 SPF50+ 50ml',
      shopeePrice: 380000,
      apiKey: 'dummy'
    },
    {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            products: [
              makeMockProduct({
                sales_price: { minimum_amount: '150000', maximum_amount: '450000' }
              })
            ]
          }
        })
      })
    }
  );
  assert.strictEqual(rangeRes.items[0].hasPriceRange, true, '150k..450k must flag hasPriceRange=true');
  console.log('   PASS: Multi-SKU price range flagged cleanly.');

  // 5. Circuit Breaker
  console.log('5. Testing Circuit Breaker open/half-open/close...');
  circuitBreaker.resetCircuitBreakers();
  const prov = 'test_provider';
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(circuitBreaker.canExecute(prov), true);
    circuitBreaker.recordFailure(prov, { failureThreshold: 5 });
  }
  assert.strictEqual(circuitBreaker.getCircuitState(prov), 'open');
  assert.strictEqual(circuitBreaker.canExecute(prov), false);
  circuitBreaker.recordSuccess(prov);
  assert.strictEqual(circuitBreaker.getCircuitState(prov), 'closed');
  assert.strictEqual(circuitBreaker.canExecute(prov), true);
  console.log('   PASS: Circuit Breaker state transitions verified.');

  // 6. Trust Signals & Highlight Badges (P0/P1)
  console.log('6. Testing Trust Signals, 4 Highlight Badges & Smart Warnings...');
  const { computeTrustSignals } = require('../../src/services/compare/trustSignals');

  const trendingShopee = computeTrustSignals(
    { rating: 4.9, sales: 5500, sold7d: 596, growth: 0.65, price: 350000, estimatedCashback: 25000 },
    { platform: 'shopee', sourcePrice: 380000 }
  );
  assert.strictEqual(trendingShopee.highlightBadge?.type, 'trending');
  assert.strictEqual(trendingShopee.trustWarning, null);

  const bestsellerTikTok = computeTrustSignals(
    { rating: 0, sales: 800, price: 300000, estimatedCashback: 12000 },
    { platform: 'tiktok', sourcePrice: 320000 }
  );
  assert.strictEqual(bestsellerTikTok.highlightBadge?.type, 'bestseller');
  assert.strictEqual(bestsellerTikTok.trustWarning, null, 'Missing rating on TikTok must NOT trigger warning');

  const highCb = computeTrustSignals(
    { rating: 4.7, sales: 120, price: 300000, estimatedCashback: 22000 },
    { platform: 'shopee', sourcePrice: 310000 }
  );
  assert.strictEqual(highCb.highlightBadge?.type, 'high_cashback');

  const topRated = computeTrustSignals(
    { rating: 4.9, sales: 80, price: 200000, estimatedCashback: 4000 },
    { platform: 'shopee', sourcePrice: 210000 }
  );
  assert.strictEqual(topRated.highlightBadge?.type, 'top_rated');

  const lowRatingWarn = computeTrustSignals(
    { rating: 3.8, sales: 500, price: 300000, estimatedCashback: 25000 },
    { platform: 'shopee', sourcePrice: 320000 }
  );
  assert.strictEqual(lowRatingWarn.trustWarning?.code, 'low_rating');
  assert.strictEqual(lowRatingWarn.highlightBadge, null, 'Warned items must not show positive highlight badge');

  const cheapLowSalesWarn = computeTrustSignals(
    { rating: 0, sales: 3, price: 150000, estimatedCashback: 5000 },
    { platform: 'tiktok', sourcePrice: 350000 }
  );
  assert.strictEqual(cheapLowSalesWarn.trustWarning?.code, 'low_sales_cheap');
  console.log('   PASS: All 4 highlight badges & smart warnings verified.');

  console.log('\nALL P0 + P1 + P2 COMPARE ENGINE TESTS PASSED!');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
