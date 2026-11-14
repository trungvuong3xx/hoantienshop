const assert = require('assert');
const logger = require('../src/utils/logger');
const {
  parseShopeeReportNodes,
  sanitizeFiniteNumber,
  normalizeNetworkStatus,
  upsertNetworkOrder
} = require('../src/services/cashbackController');
const {
  ensureDbLoaded,
  recalculateAllWallets,
  initPostgresIfConfigured,
  reloadStateFromPostgres
} = require('../src/services/dbService');

async function runShopeeSyncSchemaTests() {
  console.log('=== STARTING SHOPEE AUTO SYNC SCHEMA API V2 TEST SUITE (P0 #7) ===');

  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();

  // --------------------------------------------------------------------------
  // TEST 1: Official Shopee Open API v2 Schema Mapping (snake_case fields)
  // --------------------------------------------------------------------------
  console.log('\n--- 1. Testing Official Shopee Open API v2 Schema Mapping (snake_case) ---');
  const v2ReportNode = {
    purchase_order_id: 'PO_V2_241114_001',
    purchase_order_status: 'COMPLETED',
    total_commission: 45000,
    total_order_amount: 450000,
    utm_content: 'U12345-campaign1',
    purchase_time: 1731542400,
    item_list: [
      {
        item_id: 'ITM_99881',
        item_name: 'Tai nghe Bluetooth không dây TWS',
        item_price: 450000,
        qty: 1,
        item_commission: 45000
      }
    ]
  };

  const parsedV2 = parseShopeeReportNodes([v2ReportNode]);
  assert.strictEqual(parsedV2.length, 1, 'Should parse exactly 1 order from v2 node');
  assert.strictEqual(parsedV2[0].orderSn, 'PO_V2_241114_001', 'Order SN should match purchase_order_id');
  assert.strictEqual(parsedV2[0].status, 'approved', 'COMPLETED should normalize to approved');
  assert.strictEqual(parsedV2[0].grossCommission, 45000, 'Gross commission should match total_commission');
  assert.strictEqual(parsedV2[0].orderAmount, 450000, 'Order amount should match total_order_amount');
  assert.strictEqual(parsedV2[0].rawSubId, 'U12345', 'UTM content should extract prefix U12345');
  assert.strictEqual(parsedV2[0].productName, 'Tai nghe Bluetooth không dây TWS', 'Product name should match item_name');
  assert.strictEqual(parsedV2[0].commissionEstimated, false, 'Commission should not be estimated when explicit');
  console.log('  PASS: Official Shopee Open API v2 schema parsed accurately.');

  // --------------------------------------------------------------------------
  // TEST 2: Alternative Official Fields (order_sn, gmv, order_items, product_id)
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Testing Alternative Official Fields (order_sn, gmv, order_items) ---');
  const altReportNode = {
    order_sn: 'SN_V2_ALT_8877',
    order_status: 'APPROVED',
    actual_amount: 32000,
    gmv: 320000,
    sub_id_1: 'U99887-postback',
    order_items: [
      {
        product_id: 'PRD_4455',
        product_name: 'Bàn phím cơ không dây RGB',
        price: 160000,
        quantity: 2,
        commission: 16000
      }
    ]
  };

  const parsedAlt = parseShopeeReportNodes([altReportNode]);
  assert.strictEqual(parsedAlt.length, 1, 'Should parse 1 order');
  assert.strictEqual(parsedAlt[0].orderSn, 'SN_V2_ALT_8877', 'Order SN should match order_sn');
  assert.strictEqual(parsedAlt[0].status, 'approved', 'APPROVED should normalize to approved');
  assert.strictEqual(parsedAlt[0].grossCommission, 32000, 'Gross commission should match actual_amount');
  assert.strictEqual(parsedAlt[0].orderAmount, 320000, 'Order amount should match gmv');
  assert.strictEqual(parsedAlt[0].rawSubId, 'U99887', 'Sub ID should match sub_id_1');
  assert.strictEqual(parsedAlt[0].productName, 'Bàn phím cơ không dây RGB', 'Product name should match product_name');
  console.log('  PASS: Alternative official fields correctly mapped.');

  // --------------------------------------------------------------------------
  // TEST 3: GraphQL Conversion Report Schema (conversionId, orders, items)
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Testing GraphQL Conversion Report Nested Orders Schema ---');
  const gqlReportNode = {
    conversionId: 'CONV_GQL_0099',
    purchaseTime: 1731550000,
    totalCommission: 60000,
    utmContent: 'U44556-aff',
    orders: [
      {
        orderId: 'ORD_GQL_SUB_01',
        orderStatus: 'COMPLETED',
        totalCommission: 60000,
        items: [
          {
            itemId: 'ITM_GQL_1',
            itemName: 'Chuột Gaming không dây',
            itemPrice: 600000,
            itemCommission: 60000
          }
        ]
      }
    ]
  };

  const parsedGql = parseShopeeReportNodes([gqlReportNode]);
  assert.strictEqual(parsedGql.length, 1, 'Should parse nested order from GraphQL report node');
  assert.strictEqual(parsedGql[0].orderSn, 'ORD_GQL_SUB_01', 'Order SN should match nested orderId');
  assert.strictEqual(parsedGql[0].status, 'approved', 'Status should be approved');
  assert.strictEqual(parsedGql[0].grossCommission, 60000, 'Gross commission should match totalCommission');
  assert.strictEqual(parsedGql[0].orderAmount, 600000, 'Order amount should match itemPrice');
  console.log('  PASS: GraphQL conversion report schema parsed cleanly.');

  // --------------------------------------------------------------------------
  // TEST 4: Commission Preservation Without Item Breakdown (Eliminate Equal-Split)
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Testing Preservation of Order Total Commission When Items Lack Breakdown ---');
  const nodeWithoutItemComm = {
    purchase_order_id: 'PO_NO_ITEM_COMM_001',
    purchase_order_status: 'COMPLETED',
    total_commission: 85000, // Order has actual commission
    total_order_amount: 850000,
    utm_content: 'U11223',
    item_list: [
      {
        item_id: 'ITM_A',
        item_name: 'Áo khoác gió thể thao',
        item_price: 850000,
        qty: 1
        // Notice: item_commission is intentionally omitted/undefined
      }
    ]
  };

  const parsedNoItemComm = parseShopeeReportNodes([nodeWithoutItemComm]);
  assert.strictEqual(parsedNoItemComm.length, 1);
  assert.strictEqual(
    parsedNoItemComm[0].grossCommission,
    85000,
    'Actual order total commission must be preserved exactly when items lack commission breakdown'
  );
  assert.strictEqual(
    parsedNoItemComm[0].commissionEstimated,
    false,
    'Commission should NOT be marked estimated when explicit order commission is provided'
  );
  console.log('  PASS: Order actual commission preserved; no distortion from missing item-level commissions.');

  // --------------------------------------------------------------------------
  // TEST 5: Zero Equal-Split Distortion Across Multiple Orders In Same Node
  // --------------------------------------------------------------------------
  console.log('\n--- 5. Testing Zero Equal-Split Distortion Across Multiple Orders ---');
  // Scenario: Node has 2 orders with asymmetric commissions (70,000 vs 30,000).
  // Neither order has item-level breakdowns.
  // The buggy previous code divided nodeCommission / 2 (or by equal amounts) distorting commissions.
  const multiOrderNode = {
    conversionId: 'CONV_MULTI_ASYMMETRIC',
    totalCommission: 100000,
    utmContent: 'U33445',
    orders: [
      {
        orderId: 'ORD_MULTI_01',
        orderStatus: 'COMPLETED',
        totalCommission: 70000,
        orderAmount: 700000,
        items: [
          { itemName: 'Màn hình 27 inch 4K', itemPrice: 700000 }
        ]
      },
      {
        orderId: 'ORD_MULTI_02',
        orderStatus: 'COMPLETED',
        totalCommission: 30000,
        orderAmount: 300000,
        items: [
          { itemName: 'Giá đỡ màn hình công thái học', itemPrice: 300000 }
        ]
      }
    ]
  };

  const parsedMulti = parseShopeeReportNodes([multiOrderNode]);
  assert.strictEqual(parsedMulti.length, 2, 'Should parse both orders');

  const ord1 = parsedMulti.find((o) => o.orderSn === 'ORD_MULTI_01');
  const ord2 = parsedMulti.find((o) => o.orderSn === 'ORD_MULTI_02');

  assert.strictEqual(
    ord1.grossCommission,
    70000,
    'Order 1 must keep its explicit 70,000 commission, NEVER distorted by equal-split'
  );
  assert.strictEqual(
    ord2.grossCommission,
    30000,
    'Order 2 must keep its explicit 30,000 commission, NEVER distorted by equal-split'
  );
  assert.strictEqual(ord1.commissionEstimated, false);
  assert.strictEqual(ord2.commissionEstimated, false);
  console.log('  PASS: Zero equal-split distortion verified across multiple orders.');

  // --------------------------------------------------------------------------
  // TEST 6: Zero Distortion When Orders Have 0 Amount And Lack Breakdown
  // --------------------------------------------------------------------------
  console.log('\n--- 6. Testing Safe Fallback When No Order Amounts Exist (No Arbitrary Splitting) ---');
  const emptyAmountMultiNode = {
    conversionId: 'CONV_ZERO_AMOUNT',
    totalCommission: 50000,
    orders: [
      { orderId: 'ORD_EMPTY_1', orderStatus: 'NEW' },
      { orderId: 'ORD_EMPTY_2', orderStatus: 'NEW' }
    ]
  };

  const parsedEmptyAmount = parseShopeeReportNodes([emptyAmountMultiNode]);
  assert.strictEqual(parsedEmptyAmount.length, 2);
  // Both orders lack amount and explicit commission. System must NOT arbitrarily divide 50000 / 2 = 25000!
  assert.strictEqual(
    parsedEmptyAmount[0].grossCommission,
    0,
    'Order 1 must not receive arbitrary equal split when amounts and item breakdown are missing'
  );
  assert.strictEqual(
    parsedEmptyAmount[1].grossCommission,
    0,
    'Order 2 must not receive arbitrary equal split when amounts and item breakdown are missing'
  );
  console.log('  PASS: Arbitrary equal-split strictly prevented when order amounts are missing.');

  // --------------------------------------------------------------------------
  // TEST 7: Status Normalization (UNPAID, CANCELLED, COMPLETED, APPROVED)
  // --------------------------------------------------------------------------
  console.log('\n--- 7. Testing Status Normalization ---');
  assert.strictEqual(normalizeNetworkStatus('UNPAID'), 'pending', 'UNPAID -> pending');
  assert.strictEqual(normalizeNetworkStatus('ORDER_STATUS_UNPAID'), 'pending', 'ORDER_STATUS_UNPAID -> pending');
  assert.strictEqual(normalizeNetworkStatus('PENDING'), 'pending', 'PENDING -> pending');
  assert.strictEqual(normalizeNetworkStatus('COMPLETED'), 'approved', 'COMPLETED -> approved');
  assert.strictEqual(normalizeNetworkStatus('APPROVED'), 'approved', 'APPROVED -> approved');
  assert.strictEqual(normalizeNetworkStatus('ORDER_STATUS_COMPLETED'), 'approved', 'ORDER_STATUS_COMPLETED -> approved');
  assert.strictEqual(normalizeNetworkStatus('CANCELLED'), 'cancelled', 'CANCELLED -> cancelled');
  assert.strictEqual(normalizeNetworkStatus('CANCELED'), 'cancelled', 'CANCELED -> cancelled');
  assert.strictEqual(normalizeNetworkStatus('ORDER_STATUS_CANCELLED'), 'cancelled', 'ORDER_STATUS_CANCELLED -> cancelled');
  assert.strictEqual(normalizeNetworkStatus('INVALID'), 'cancelled', 'INVALID -> cancelled');
  assert.strictEqual(normalizeNetworkStatus('REJECTED'), 'cancelled', 'REJECTED -> cancelled');
  console.log('  PASS: All network statuses correctly normalized according to specification.');

  // --------------------------------------------------------------------------
  // TEST 8: Numeric Sanitization with Number.isFinite
  // --------------------------------------------------------------------------
  console.log('\n--- 8. Testing Numeric Sanitization with Number.isFinite ---');
  assert.strictEqual(sanitizeFiniteNumber(15000), 15000);
  assert.strictEqual(sanitizeFiniteNumber('15000.75'), 15000.75);
  assert.strictEqual(sanitizeFiniteNumber('150,000'), 150000);
  assert.strictEqual(sanitizeFiniteNumber(NaN), 0);
  assert.strictEqual(sanitizeFiniteNumber(Infinity), 0);
  assert.strictEqual(sanitizeFiniteNumber(-Infinity), 0);
  assert.strictEqual(sanitizeFiniteNumber('invalid_str'), 0);
  assert.strictEqual(sanitizeFiniteNumber(undefined), 0);
  assert.strictEqual(sanitizeFiniteNumber(null), 0);
  assert.strictEqual(sanitizeFiniteNumber({}, 0), 0);
  assert.strictEqual(sanitizeFiniteNumber(undefined, 1), 1);

  // Test malformed numbers inside parseShopeeReportNodes
  const malformedNode = {
    order_id: 'ORD_MALFORMED_NUM',
    order_status: 'COMPLETED',
    total_commission: NaN,
    total_order_amount: 'Infinity',
    item_list: [
      {
        item_name: 'Sản phẩm thử nghiệm',
        item_price: 'not_a_number',
        qty: null,
        item_commission: undefined
      }
    ]
  };

  const parsedMalformed = parseShopeeReportNodes([malformedNode]);
  assert.strictEqual(parsedMalformed.length, 1);
  assert.strictEqual(Number.isFinite(parsedMalformed[0].grossCommission), true);
  assert.strictEqual(parsedMalformed[0].grossCommission, 0);
  assert.strictEqual(Number.isFinite(parsedMalformed[0].orderAmount), true);
  assert.strictEqual(parsedMalformed[0].orderAmount, 0);
  console.log('  PASS: Numeric sanitization strictly guarantees finite numbers.');

  // --------------------------------------------------------------------------
  // TEST 9: End-to-End Upsert and Post-Tax 70/30 Cashback Calculation
  // --------------------------------------------------------------------------
  console.log('\n--- 9. Testing End-to-End Database Upsert Integration ---');
  const testUserCode = `U_SYNC_${Date.now()}`;
  const testUser = {
    id: `usr_sync_${Date.now()}`,
    code: testUserCode,
    name: 'Sync Schema Test User',
    phone: `0988${Math.floor(100000 + Math.random() * 900000)}`,
    passwordHash: 'dummy',
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0
  };
  db.users.push(testUser);

  const syncPayload = {
    purchase_order_id: `PO_E2E_${Date.now()}`,
    purchase_order_status: 'COMPLETED',
    total_commission: 100000, // 100,000 VND gross commission
    total_order_amount: 1000000,
    utm_content: testUserCode,
    item_list: [
      {
        item_name: 'Tai nghe gaming chống ồn',
        item_price: 1000000,
        qty: 1
      }
    ]
  };

  const [parsedSyncOrder] = parseShopeeReportNodes([syncPayload]);
  const createdOrder = upsertNetworkOrder(db, parsedSyncOrder);

  assert.strictEqual(createdOrder.orderSn, parsedSyncOrder.orderSn);
  assert.strictEqual(createdOrder.grossCommission, 100000);
  // Default tax is 10%: net = 90,000; default cashback is 70%: user = 63,000
  assert.strictEqual(createdOrder.taxAmount, 10000, 'Tax should be 10,000 (10%)');
  assert.strictEqual(createdOrder.netCommission, 90000, 'Net commission should be 90,000');
  assert.strictEqual(createdOrder.userCashbackAmount, 63000, 'User cashback should be 63,000 (70% of 90k)');
  assert.strictEqual(createdOrder.adminShareAmount, 27000, 'Admin share should be 27,000');
  assert.strictEqual(createdOrder.status, 'approved');
  assert.strictEqual(createdOrder.userId, testUser.id, 'Attributed to matched user');
  console.log('  PASS: End-to-end upsert with 70/30 post-tax split successful.');

  console.log('\n=== ALL 9 SHOPEE SYNC SCHEMA TESTS PASSED CLEANLY! ===\n');
  process.exit(0);
}

runShopeeSyncSchemaTests().catch((err) => {
  console.error('[TEST FAILURE]', err);
  process.exit(1);
});
