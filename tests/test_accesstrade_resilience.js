const assert = require('assert');
const { fetchAccessTradeOrders } = require('../src/services/tiktokService');
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

  console.log('ALL ACCESSTRADE RESILIENCE TESTS PASSED ✔');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
