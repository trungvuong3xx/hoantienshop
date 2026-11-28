const assert = require('assert');

process.env.NODE_ENV = 'test';

const { getHomeDeals, clearDealCaches } = require('../../src/services/deals/dealDiscoveryService');

function makeShopeeRaw(id, overrides = {}) {
  return {
    itemId: String(id),
    shopId: '1862178474',
    productName: `Kem Chống Nắng La Roche Posay ${id}`,
    shopName: 'LRP Mall',
    imageUrl: 'https://cf.shopee.vn/file/sample.jpg',
    price: 350000,
    priceMin: 350000,
    priceMax: 350000,
    commissionRate: 8,
    commission: 0,
    sales: 2500,
    rating: 4.9,
    sold7d: 180,
    sold30d: 620,
    growth: 0.75,
    revenueAll: 900000000,
    catId: 100630,
    productLink: `https://shopee.vn/product/1862178474/${id}`,
    ...overrides
  };
}

function makeTikTokCand(id, overrides = {}) {
  return {
    id: String(id),
    shopId: '',
    title: `Tai Nghe Bluetooth Sony ${id}`,
    shopName: 'Sony Official',
    imageUrl: 'https://p16-oec-sg.ibyteimg.com/sample.jpg',
    price: 490000,
    priceMin: 490000,
    priceMax: 490000,
    hasPriceRange: false,
    originalPrice: 490000,
    grossCommission: 49000,
    commissionRate: 10,
    hasInventory: true,
    sales: 650,
    rating: 0,
    sold7d: 0,
    sold30d: 0,
    growth: 0,
    revenueAll: 0,
    revenue30d: 0,
    catId: 0,
    detailLink: `https://shop.tiktok.com/view/product/${id}?region=VN&local=en`,
    ...overrides
  };
}

async function run() {
  console.log('=== HOMEPAGE DEAL DISCOVERY (P2) VERIFICATION ===\n');

  // 1. Shared raw cache across VIP tiers (70% vs 80%) + zero internal leaks
  console.log('1. Testing shared raw cache across VIP tiers & zero internal leaks...');
  clearDealCaches();
  let shopeeCalls = 0;
  let tiktokCalls = 0;

  const shopeeFetcher = async () => {
    shopeeCalls++;
    return [
      makeShopeeRaw('53019542561'),
      makeShopeeRaw('53019542562', { rating: 3.7, sales: 500 }), // Must be filtered out (low rating < 4.2)
      makeShopeeRaw('53019542563', { commissionRate: 0 })         // Must be filtered out (0 commission)
    ];
  };
  const tiktokFetcher = async () => {
    tiktokCalls++;
    return [makeTikTokCand('1738459399426246581')];
  };

  const bronze = await getHomeDeals({
    group: 'worth_buying',
    category: 'cosmetics',
    cashbackPercent: 70,
    taxDeductPercent: 10,
    shopeeFetcher,
    tiktokFetcher
  });

  const firstCalls = shopeeCalls + tiktokCalls;
  assert(firstCalls > 0);
  assert.strictEqual(bronze.ok, true);
  assert.strictEqual(bronze.cached, false);
  assert.strictEqual(bronze.items.length, 2, 'Low-rating & zero-commission items must be excluded');

  // Verify NO internal/sensitive fields leaked
  for (const it of bronze.items) {
    assert.strictEqual(it.grossCommission, undefined, 'grossCommission must not leak');
    assert.strictEqual(it.commissionRate, undefined, 'commissionRate must not leak');
    assert.strictEqual(it.revenueAll, undefined, 'revenueAll must not leak');
    assert.strictEqual(it.growth, undefined, 'growth must not leak');
    assert.strictEqual(it.detailLink, undefined, 'detailLink must not leak');
    assert(it.verifyToken && it.verifyToken.includes('.'), 'HMAC verifyToken must be present');
  }

  // Second call for VIP 80% user -> must hit L1 cache with 0 upstream calls & higher cashback!
  const vip = await getHomeDeals({
    group: 'worth_buying',
    category: 'cosmetics',
    cashbackPercent: 80,
    taxDeductPercent: 10,
    shopeeFetcher,
    tiktokFetcher
  });
  assert.strictEqual(vip.cached, true);
  assert.strictEqual(shopeeCalls + tiktokCalls, firstCalls, 'VIP call must reuse cached raw pool');
  const bronzeSp = bronze.items.find((x) => x.platform === 'shopee');
  const vipSp = vip.items.find((x) => x.platform === 'shopee');
  assert(vipSp.estimatedCashback > bronzeSp.estimatedCashback, 'VIP 80% must compute higher cashback dynamically');
  console.log('   PASS: VIP cache sharing, quality filtering & zero leaks verified.');

  // 2. Trending group calls AddLiveTag with sort=sold7d and sort=growth
  console.log('2. Testing trending group uses sold7d & growth sorts...');
  clearDealCaches();
  const observedSorts = new Set();
  const trendingRes = await getHomeDeals({
    group: 'trending',
    category: 'all',
    cashbackPercent: 70,
    shopeeFetcher: async (_q, sort) => {
      observedSorts.add(sort);
      return [makeShopeeRaw('53019542599', { sold7d: 520, growth: 1.5 })];
    },
    tiktokFetcher: async () => [makeTikTokCand('1738459399426246599', { sales: 900 })]
  });
  assert(observedSorts.has('sold7d'), 'Trending group must query sort=sold7d');
  assert(observedSorts.has('growth'), 'Trending group must query sort=growth');
  assert.strictEqual(trendingRes.items[0].highlightBadge?.type, 'trending');
  console.log('   PASS: Trending group leverages sold7d & growth.');

  // 3. Fault tolerance: if TikTok throws, Shopee deals still load cleanly
  console.log('3. Testing fault tolerance when one platform fails...');
  clearDealCaches();
  const partial = await getHomeDeals({
    group: 'high_cashback',
    category: 'home',
    shopeeFetcher: async () => [makeShopeeRaw('53019542600', { commissionRate: 12 })],
    tiktokFetcher: async () => {
      throw new Error('Upstream 503');
    }
  });
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.items.length, 1);
  assert.strictEqual(partial.items[0].platform, 'shopee');
  console.log('   PASS: Partial platform failure handled gracefully.');

  console.log('\nALL HOMEPAGE DEAL DISCOVERY (P2) TESTS PASSED!');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
