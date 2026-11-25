const assert = require('assert');
const {
  TIKTOK_VIDEO_LINK_ERROR,
  fetchAccessTradeOrders,
  fetchAccessTradeOrderProducts,
  generateTikTokAccessTradeLink,
  fetchTikTokAccessTradePreview,
  convertTikTokLink,
  parseAccessTradeMoney,
  parseAccessTradeCommissionRate
} = require('../src/services/tiktokService');
const { isAllowedAffiliateRedirectUrl } = require('../src/services/urlResolver');
const { mapOrderRow } = require('../src/services/orderMapper');

async function runTests() {
  console.log('--- Running AccessTrade Resilience & Schema Tests ---');

  // 1. Retry on HTTP 429 with Retry-After header
  {
    let calls = 0;
    const sleeps = [];
    const mockFetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '1.5' : null) },
          json: async () => ({ success: false, message: 'Rate limit exceeded', retry_after: 1.5 })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          data: [{ order_id: 'AT001', merchant: 'tiktokshop', order_pending: 1 }]
        })
      };
    };

    const rows = await fetchAccessTradeOrders('test_key', 7, {
      fetchFn: mockFetch,
      sleepFn: async (ms) => sleeps.push(ms)
    });
    assert.strictEqual(calls, 2, 'Should retry once after 429');
    assert.deepStrictEqual(sleeps, [1500], 'Should respect Retry-After capped at 3000ms');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].order_id, 'AT001');
    console.log('✓ Test 1: HTTP 429 Retry-After backoff passed');
  }

  // 2. Retry on HTTP 200 with success: false (Query exceeded maximum execution time)
  {
    let calls = 0;
    const sleeps = [];
    const mockFetch = async () => {
      calls++;
      if (calls <= 2) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            success: false,
            message: 'Query exceeded maximum execution time. Please narrow your date range or filters.'
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          data: [{ order_id: 'AT002', merchant: 'shopee_kolnew', order_approved: 1 }]
        })
      };
    };

    const rows = await fetchAccessTradeOrders('test_key', 7, {
      fetchFn: mockFetch,
      sleepFn: async (ms) => sleeps.push(ms)
    });
    assert.strictEqual(calls, 3, 'Should retry twice on transient success: false timeout');
    assert.deepStrictEqual(sleeps, [1000, 2000], 'Should use exponential backoff 1000ms -> 2000ms');
    assert.strictEqual(rows[0].order_id, 'AT002');
    console.log('✓ Test 2: HTTP 200 success=false timeout retry passed');
  }

  // 3. Fail fast if deadline budget is insufficient for backoff wait
  {
    let calls = 0;
    const sleeps = [];
    const mockFetch = async () => {
      calls++;
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ message: 'Service Unavailable' })
      };
    };

    await assert.rejects(
      () =>
        fetchAccessTradeOrders('test_key', 7, {
          fetchFn: mockFetch,
          sleepFn: async (ms) => sleeps.push(ms),
          deadlineMs: 1800
        }),
      /HTTP 503/
    );
    assert.strictEqual(calls, 1, 'Should not sleep/retry when remaining deadline is insufficient');
    assert.strictEqual(sleeps.length, 0);
    console.log('✓ Test 3: Deadline-aware fail-fast passed');
  }

  // 4. Non-retryable HTTP 403 fails immediately
  {
    let calls = 0;
    const mockFetch = async () => {
      calls++;
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({ message: 'Invalid token' })
      };
    };

    await assert.rejects(
      () => fetchAccessTradeOrders('bad_key', 7, { fetchFn: mockFetch }),
      /HTTP 403 \(Invalid token\)/
    );
    assert.strictEqual(calls, 1, 'HTTP 403 should not retry');
    console.log('✓ Test 4: HTTP 403 non-retryable fail-fast passed');
  }

  // 5. mapOrderRow includes merchant and rejectReason
  {
    const mapped = mapOrderRow({
      order_sn: 'ORD_AT_1',
      platform: 'tiktok',
      merchant: 'tiktokshop',
      reject_reason: 'Khách hoàn hàng',
      status: 'cancelled'
    });
    assert.strictEqual(mapped.merchant, 'tiktokshop');
    assert.strictEqual(mapped.rejectReason, 'Khách hoàn hàng');
    console.log('✓ Test 5: mapOrderRow merchant & rejectReason mapping passed');
  }

  // 6. AccessTrade money & commission rate parsers (real live formats + doc formats)
  {
    assert.strictEqual(parseAccessTradeMoney('8814.56800'), 8815);
    assert.strictEqual(parseAccessTradeMoney('3.000'), 3000);
    assert.strictEqual(parseAccessTradeMoney('136000'), 136000);
    assert.strictEqual(parseAccessTradeCommissionRate('0.06481', 8815, 136000), 6.48);
    assert.strictEqual(parseAccessTradeCommissionRate(1500, 3000, 20000), 15);
    console.log('✓ Test 6: AccessTrade money & rate parsers passed');
  }

  // 7. Redirect allowlist accepts shorten.asia & blocks evil hosts
  {
    assert.strictEqual(isAllowedAffiliateRedirectUrl('https://shorten.asia/kVe435N8'), true);
    assert.strictEqual(isAllowedAffiliateRedirectUrl('https://evil-tracker.example/x'), false);
    console.log('✓ Test 7: urlResolver shorten.asia allowlist passed');
  }

  // 8. generateTikTokAccessTradeLink with real production payload structure
  {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: '0',
        status: true,
        message: 'create link affiliate success',
        data: {
          aff_short_url: 'https://shorten.asia/kVe435N8',
          aff_url: 'https://go.isclix.com/deep_link/7110811489339796158/6648523843406889655?url=https%3A%2F%2Fwww.tiktok.com%2Ft%2FZSs85LWTt%2F&utm_source=CLK123&sub1=CLK123',
          product_commission: { amount: '8814.56800', currency: 'VND', rate: '0.06481' },
          product_id: '1733649211783283904',
          product_image: 'https://p16-oec-sg.ibyteimg.com/img.jpeg',
          product_name: 'Cà Phê Sấy Lạnh',
          product_price: { currency: 'VND', maximum_amount: '407160', minimum_amount: '136000' }
        }
      })
    });

    const res = await generateTikTokAccessTradeLink(
      'https://shop.tiktok.com/view/product/1733649211783283904',
      '1733649211783283904',
      { accesstradeApiKey: 'test_key', subId: 'CLK123', fetchFn: mockFetch }
    );
    assert.strictEqual(res.affiliateUrl, 'https://shorten.asia/kVe435N8');
    assert.strictEqual(res.price, 136000);
    assert.strictEqual(res.commission, 8815);
    assert.strictEqual(res.commissionRate, 6.48);
    assert.strictEqual(res.productName, 'Cà Phê Sấy Lạnh');
    assert.strictEqual(res.hasMeta, true);
    console.log('✓ Test 8: generateTikTokAccessTradeLink live payload parsing passed');
  }

  // 9. convertTikTokLink throws explicit error without falling back to DeepLink v6 when AT v2 fails
  {
    const mockFailFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Server error' })
    });

    await assert.rejects(
      () =>
        convertTikTokLink(
          {
            cleanUrl: 'https://shop.tiktok.com/view/product/1733649211783283904',
            productId: '1733649211783283904',
            linkType: 'product'
          },
          {
            tiktokMode: 'deeplink',
            accesstradeApiKey: 'test_key',
            subId: 'CLK999',
            tiktokDeepLinkTemplate: 'https://go.isclix.com/deep_link/v6/7110811489339796158/6648523843406889655?sub4=oneatweb',
            fetchFn: mockFailFetch
          }
        ),
      /Hệ thống TikTok đang bận/
    );
    console.log('✓ Test 9: convertTikTokLink strict no-fallback on AT v2 error passed');
  }

  // 10. fetchAccessTradeOrderProducts extracts & deduplicates reject reasons, ignores N/A
  {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total: 3,
        data: [
          { _id: 'p1', product_price: 50000, product_quantity: 1, reason_rejected: 'N/A' },
          { _id: 'p2', product_price: 80000, product_quantity: 1, reason_rejected: 'Khách hoàn hàng' },
          { _id: 'p3', product_price: 80000, product_quantity: 1, reason_rejected: 'Khách hoàn hàng' }
        ]
      })
    });

    const res = await fetchAccessTradeOrderProducts('test_key', 'ORD_REJECT_1', 'tiktokshop', {
      fetchFn: mockFetch
    });
    assert.strictEqual(res.products.length, 3);
    assert.strictEqual(res.rejectReason, 'Khách hoàn hàng');
    console.log('✓ Test 10: fetchAccessTradeOrderProducts reject reason extraction passed');
  }

  // 11. convertTikTokLink blocks video/content links with clear guidance
  {
    await assert.rejects(
      () =>
        convertTikTokLink(
          {
            cleanUrl: 'https://www.tiktok.com/@nguyetsuy/video/7601779958305885448',
            productId: null,
            linkType: 'content'
          },
          {
            tiktokMode: 'deeplink',
            accesstradeApiKey: 'test_key',
            subId: 'CLK_VID'
          }
        ),
      (err) => err.message === TIKTOK_VIDEO_LINK_ERROR
    );
    console.log('✓ Test 11: convertTikTokLink blocks video/content links passed');
  }

  // 12. fetchTikTokAccessTradePreview caches metadata from AT v2
  {
    let calls = 0;
    const mockFetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: {
            aff_short_url: 'https://shorten.asia/preview123',
            aff_url: 'https://go.isclix.com/deep_link/7110811489339796158/6648523843406889655?url=https%3A%2F%2Fwww.tiktok.com%2Ft%2Fabc%2F',
            product_id: '1733649211783999999',
            product_name: 'Sản phẩm Test Cache',
            product_image: 'https://p16-oec-sg.ibyteimg.com/test.jpeg',
            product_price: { minimum_amount: '99000' },
            product_commission: { amount: '5940', rate: '0.06' }
          }
        })
      };
    };

    const first = await fetchTikTokAccessTradePreview(
      'https://www.tiktok.com/view/product/1733649211783999999',
      '1733649211783999999',
      { accesstradeApiKey: 'test_key', fetchFn: mockFetch }
    );
    const second = await fetchTikTokAccessTradePreview(
      'https://www.tiktok.com/view/product/1733649211783999999',
      '1733649211783999999',
      { accesstradeApiKey: 'test_key', fetchFn: mockFetch }
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(first.productName, 'Sản phẩm Test Cache');
    assert.strictEqual(second.commission, 5940);
    assert.strictEqual(second.dataSource, 'accesstrade_v2');
    console.log('✓ Test 12: fetchTikTokAccessTradePreview cache & metadata passed');
  }

  console.log('ALL ACCESSTRADE RESILIENCE TESTS PASSED ✔');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
