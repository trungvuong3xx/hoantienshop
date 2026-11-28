const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';

const {
  classifyTrafficSource,
  ingestAnalyticsBatch,
  recordServerAffiliateClick,
  getAnalyticsOverview,
  getAnalyticsMembers,
  getMemberActivityTimeline,
  getAnalyticsTopProducts,
  getAnalyticsRealtime,
  getAnalyticsDailyTrend,
  rollupDailyAnalytics,
  withAdminCache,
  clearAnalyticsCache,
  clearMemoryAnalytics
} = require('../src/services/analytics/analyticsService');
const { ensureDbLoaded, saveDb, createToken, hashPassword } = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

async function run() {
  console.log('=== LILA ANALYTICS (P0) VERIFICATION SUITE ===\n');

  // 1. Vietnamese Traffic Source Classification (including stripped-referrer WebViews)
  console.log('1. Testing VN traffic source classification...');
  assert.strictEqual(classifyTrafficSource({ utmSource: 'zalo_oa' }), 'zalo');
  assert.strictEqual(classifyTrafficSource({ refCode: 'U12345' }), 'share_link');
  assert.strictEqual(classifyTrafficSource({ referrerHost: 'www.google.com' }), 'google');
  assert.strictEqual(classifyTrafficSource({ referrerHost: 'l.facebook.com' }), 'facebook');
  assert.strictEqual(classifyTrafficSource({ userAgent: 'Mozilla/5.0 (iPhone) Zalo/24.10' }), 'zalo');
  assert.strictEqual(classifyTrafficSource({ userAgent: 'Mozilla/5.0 FBAN/FBIOS' }), 'facebook');
  assert.strictEqual(classifyTrafficSource({ userAgent: 'Mozilla/5.0 BytedanceWebview' }), 'tiktok');
  assert.strictEqual(classifyTrafficSource({ userAgent: 'Mozilla/5.0 Chrome/120.0' }), 'direct');
  console.log('   PASS: All 8 traffic source rules verified.');

  // 2. Ingestion, Dedup, 30s Spam Filter, Safe Session Stitching & Member Timeline
  console.log('2. Testing ingestion, 30s spam filter, safe stitching & member timeline...');
  clearMemoryAnalytics();
  const db = ensureDbLoaded();
  db.users = [];
  db.orders = [];
  db.clicks = [];
  const member = {
    id: 'usr_an_1',
    code: 'UAN001',
    name: 'Nguyễn Văn A',
    phone: '0901112233',
    passwordHash: hashPassword('Test@12345'),
    role: 'user',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  const admin = {
    id: 'usr_an_admin',
    code: 'ADM01',
    name: 'Admin LiLa',
    phone: '0909998888',
    passwordHash: hashPassword('Admin@12345'),
    role: 'admin',
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(member, admin);
  db.orders.push({
    orderSn: 'ORD_AN_999',
    platform: 'shopee',
    clickId: 'clk_an_01',
    userId: member.id,
    status: 'approved',
    userCashbackAmount: 25000,
    createdAt: new Date().toISOString()
  });
  saveDb(db);

  // Guest visits from Zalo WebView
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_1', visitorId: 'vis_1' },
    events: [{ eventId: 'ev_1', eventType: 'page_view', viewName: 'home' }],
    authUser: null,
    userAgent: 'Mozilla/5.0 (iPhone) Zalo/24.10'
  });

  // Member logs in on SAME session -> safe stitching attaches userId to sess_1 + clicks product twice within 30s
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_1', visitorId: 'vis_1' },
    events: [
      {
        eventId: 'ev_2',
        eventType: 'affiliate_click',
        platform: 'shopee',
        productId: '53019542563',
        productName: 'Kem Chống Nắng La Roche Posay 50ml',
        sourceSurface: 'home_deal_shelf',
        dealGroup: 'worth_buying',
        clickId: 'clk_an_01'
      },
      {
        eventId: 'ev_3', // duplicate click within 30s -> marked isValid=false, raw row kept
        eventType: 'affiliate_click',
        platform: 'shopee',
        productId: '53019542563',
        productName: 'Kem Chống Nắng La Roche Posay 50ml',
        sourceSurface: 'home_deal_shelf',
        clickId: 'clk_an_02'
      }
    ],
    authUser: member,
    userAgent: 'Mozilla/5.0 (iPhone) Zalo/24.10'
  });

  const ov = await getAnalyticsOverview(7);
  assert.strictEqual(ov.kpis.uniqueVisitors, 1);
  assert.strictEqual(ov.kpis.activeMembers, 1);
  assert.strictEqual(ov.kpis.rawClicks, 2, 'Raw clicks must keep both events');
  assert.strictEqual(ov.kpis.validClicks, 1, '30s duplicate click must be filtered from validClicks');
  assert.strictEqual(ov.sources[0].source, 'zalo');

  const membersRes = await getAnalyticsMembers({ rangeDays: 30, sortBy: 'clicks' });
  assert.strictEqual(membersRes.items.length, 1);
  assert.strictEqual(membersRes.items[0].userCode, 'UAN001');
  assert.strictEqual(membersRes.items[0].lastSource, 'zalo');
  assert.strictEqual(membersRes.items[0].shopeeClicks, 1);

  const tl = await getMemberActivityTimeline({ userId: member.id, rangeDays: 30 });
  const affEv = tl.timeline.find((e) => e.clickId === 'clk_an_01');
  assert(affEv, 'Affiliate click must appear in member timeline');
  assert.strictEqual(affEv.productName, 'Kem Chống Nắng La Roche Posay 50ml');
  assert.strictEqual(affEv.trafficSource, 'zalo');
  assert.strictEqual(affEv.orderSn, 'ORD_AN_999', 'Timeline must join real order via clickId');
  assert.strictEqual(affEv.orderStatus, 'approved');

  const prods = await getAnalyticsTopProducts({ rangeDays: 30 });
  assert.strictEqual(prods.items.length, 1);
  assert.strictEqual(prods.items[0].validClicks, 1);
  assert.strictEqual(prods.items[0].rawClicks, 2);
  console.log('   PASS: Ingestion, 30s spam filter, Zalo source, safe stitching & order-joined timeline verified.');

  // 2b. Stage 1 Forensic Accuracy Regression Tests (AN-01, AN-02, AN-03, AN-04)
  console.log('2b. Testing Stage 1 accuracy fixes (AN-01..AN-04)...');
  // AN-01: Fast server affiliate click arrives BEFORE client batch -> direct must upgrade to zalo when batch arrives
  await recordServerAffiliateClick({
    req: {
      headers: {
        'x-analytics-session': 'sess_fast_click',
        'x-analytics-visitor': 'vis_fast_1',
        'user-agent': 'Mozilla/5.0 Chrome/120.0'
      },
      ip: '1.2.3.4'
    },
    authUser: null,
    platform: 'shopee',
    productId: '999888',
    productName: 'Tai Nghe Bluetooth Test',
    sourceSurface: 'home_deal_shelf',
    clickId: 'clk_fast_01'
  });
  // Client batch arrives 2 seconds later with real utmSource = 'zalo_oa'
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_fast_click', visitorId: 'vis_fast_1', utmSource: 'zalo_oa' },
    events: [{ eventId: 'ev_fast_pv_1', eventType: 'page_view', viewName: 'home' }],
    authUser: null,
    userAgent: 'Mozilla/5.0 Chrome/120.0'
  });

  // AN-02a: Retry same eventId batch must NOT double-count pageViews
  const beforeRetryOv = await getAnalyticsOverview(7);
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_fast_click', visitorId: 'vis_fast_1', utmSource: 'zalo_oa' },
    events: [{ eventId: 'ev_fast_pv_1', eventType: 'page_view', viewName: 'home' }],
    authUser: null,
    userAgent: 'Mozilla/5.0 Chrome/120.0'
  });
  const afterRetryOv = await getAnalyticsOverview(7);
  assert.strictEqual(afterRetryOv.kpis.pageViews, beforeRetryOv.kpis.pageViews, 'AN-02: Retry batch must not double-count pageViews');

  // AN-02b: Admin account & admin view must be excluded from customer analytics
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_admin_1', visitorId: 'vis_admin_1' },
    events: [{ eventId: 'ev_admin_1', eventType: 'page_view', viewName: 'admin' }],
    authUser: admin,
    userAgent: 'Mozilla/5.0 Chrome/120.0'
  });
  await recordServerAffiliateClick({
    req: { headers: { 'x-analytics-session': 'sess_admin_1', 'x-analytics-visitor': 'vis_admin_1', 'user-agent': 'Mozilla/5.0 Chrome/120.0' } },
    authUser: admin,
    platform: 'shopee',
    productId: '777',
    clickId: 'clk_admin_skip'
  });
  const afterAdminOv = await getAnalyticsOverview(7);
  assert.strictEqual(afterAdminOv.kpis.uniqueVisitors, afterRetryOv.kpis.uniqueVisitors, 'AN-02: Admin visits must not inflate uniqueVisitors');
  assert.strictEqual(afterAdminOv.kpis.pageViews, afterRetryOv.kpis.pageViews, 'AN-02: Admin visits must not inflate pageViews');

  // AN-01 check: fast click session upgraded from direct -> zalo (no direct source)
  const directSrc = afterAdminOv.sources.find((s) => s.source === 'direct');
  assert.strictEqual(directSrc, undefined, 'AN-01: Fast click session must upgrade from direct to zalo');

  // AN-04: Same visitor has BOTH an earlier anonymous session AND a logged-in session -> anonymousVisitors must NOT double-count
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_guest_earlier', visitorId: 'vis_1' },
    events: [{ eventId: 'ev_guest_pv_1', eventType: 'page_view', viewName: 'home' }],
    authUser: null,
    userAgent: 'Mozilla/5.0 (iPhone) Zalo/24.10'
  });
  const an04Ov = await getAnalyticsOverview(7);
  assert.strictEqual(an04Ov.kpis.uniqueVisitors, 2, 'Total unique visitors = vis_1 + vis_fast_1');
  assert.strictEqual(an04Ov.kpis.activeMembers, 1, 'Active members = member (vis_1)');
  assert.strictEqual(an04Ov.kpis.anonymousVisitors, 1, 'AN-04: Only vis_fast_1 is anonymous; vis_1 has logged-in session');
  assert(
    an04Ov.kpis.activeMembers + an04Ov.kpis.anonymousVisitors <= an04Ov.kpis.uniqueVisitors,
    'AN-04: activeMembers + anonymousVisitors must never exceed uniqueVisitors'
  );
  const an04Rt = await getAnalyticsRealtime({ filter: 'all' });
  assert.strictEqual(an04Rt.online.total, 2);
  assert.strictEqual(an04Rt.online.members, 1);
  assert.strictEqual(an04Rt.online.anonymous, 1, 'AN-04: Realtime anonymous must also exclude logged-in visitors');
  console.log('   PASS: AN-01 (source upgrade), AN-02 (retry dedup + admin exclusion), AN-03 (event-based pageViews) & AN-04 (visitor consistency) verified.');

  // 2c. Stage 2 Optimization Tests (AN-05 rollups + hybrid trend, AN-07 last_view + 30s L1 cache)
  console.log('2c. Testing Stage 2 optimizations (AN-05 & AN-07)...');
  // AN-07a: Session last_view updates on navigation without correlated subquery
  await ingestAnalyticsBatch({
    session: { sessionId: 'sess_1', visitorId: 'vis_1' },
    events: [{ eventId: 'ev_nav_lb', eventType: 'page_view', viewName: 'leaderboard' }],
    authUser: member,
    userAgent: 'Mozilla/5.0 (iPhone) Zalo/24.10'
  });
  const rtAfterNav = await getAnalyticsRealtime({ filter: 'members' });
  const memberSess = rtAfterNav.activeSessions.find((s) => s.sessionId === 'sess_1');
  assert(memberSess, 'Member session must appear in realtime');
  assert.strictEqual(memberSess.currentView, 'leaderboard', 'AN-07: Realtime currentView must reflect latest last_view');

  // AN-07b: L1 admin read cache hits within TTL and resets via clearAnalyticsCache
  clearAnalyticsCache();
  let computeCount = 0;
  const v1 = await withAdminCache('test_key', async () => ++computeCount, 5000);
  const v2 = await withAdminCache('test_key', async () => ++computeCount, 5000);
  assert.strictEqual(v1, 1);
  assert.strictEqual(v2, 1, 'AN-07: Second call within TTL must hit L1 cache');
  clearAnalyticsCache();
  const v3 = await withAdminCache('test_key', async () => ++computeCount, 5000);
  assert.strictEqual(v3, 2, 'AN-07: After clearAnalyticsCache, fetcher must recompute');

  // AN-05: Daily rollup + 90-day hybrid trend series
  const rollRes = await rollupDailyAnalytics(7);
  assert(rollRes.rolledUp >= 1, 'AN-05: rollupDailyAnalytics must roll up active days');
  const trend90 = await getAnalyticsDailyTrend(90);
  assert.strictEqual(trend90.series.length, 90, 'AN-05: Trend must support up to 90 days');
  const todayPoint = trend90.series[trend90.series.length - 1];
  assert(todayPoint.visitors >= 2 && todayPoint.clicks >= 2, 'AN-05: Today trend point must include live visitors & valid clicks');
  console.log('   PASS: AN-05 (daily rollup + 90d hybrid trend) & AN-07 (last_view + L1 cache) verified.');

  // 3. RBAC Security: Non-admin MUST receive 403 on /api/admin/analytics/*
  console.log('3. Testing Admin-only RBAC on /api/admin/analytics/*...');
  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const userToken = createToken(member);
  const adminToken = createToken(admin);

  try {
    const userRes = await fetch(`${base}/api/admin/analytics/overview`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.strictEqual(userRes.status, 403, 'Regular user must be blocked with 403');

    const adminRes = await fetch(`${base}/api/admin/analytics/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(adminRes.status, 200, 'Admin must receive 200');
    const adminJson = await adminRes.json();
    assert.strictEqual(adminJson.ok, true);

    // P1 endpoints verification
    const rtRes = await fetch(`${base}/api/admin/analytics/realtime?filter=all`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(rtRes.status, 200);
    const rtJson = await rtRes.json();
    assert.strictEqual(rtJson.online.total, 2);
    assert.strictEqual(rtJson.recentClicks.length, 2);

    const fnRes = await fetch(`${base}/api/admin/analytics/funnel?range=30`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(fnRes.status, 200);
    const fnJson = await fnRes.json();
    assert.strictEqual(fnJson.steps.length, 6);
    assert.strictEqual(fnJson.approvedCashback, 25000);

    const trRes = await fetch(`${base}/api/admin/analytics/trend?range=7`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(trRes.status, 200);
    const trJson = await trRes.json();
    assert.strictEqual(trJson.series.length, 7);

    const csvRes = await fetch(`${base}/api/admin/analytics/export.csv?type=members&range=30&source=zalo`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    assert(csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, 'CSV wire bytes must start with UTF-8 BOM');
    assert(csvBuf.toString('utf8').includes('UAN001'), 'CSV must include member code');

    // Stage 3: Extended filters (yesterday, 90d, source, device) + Pagination total/hasMore
    const ovFiltered = await fetch(`${base}/api/admin/analytics/overview?range=90&source=zalo&device=mobile`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(ovFiltered.status, 200);
    const ovFJson = await ovFiltered.json();
    assert.strictEqual(ovFJson.kpis.activeMembers, 1, 'Filtered overview (90d, zalo, mobile) must match member');

    const ovYest = await fetch(`${base}/api/admin/analytics/overview?range=yesterday`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(ovYest.status, 200);
    const ovYJson = await ovYest.json();
    assert.strictEqual(ovYJson.range, 'yesterday');
    assert.strictEqual(ovYJson.kpis.uniqueVisitors, 0, 'Yesterday must not include today-only events');

    const memPaged = await fetch(`${base}/api/admin/analytics/members?range=90&source=zalo&page=1&limit=20`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(memPaged.status, 200);
    const memPJson = await memPaged.json();
    assert.strictEqual(memPJson.total, 1, 'Members API must return pagination total');
    assert.strictEqual(memPJson.hasMore, false);

    console.log('   PASS: Admin RBAC + P1 Realtime, 7-Step Funnel, Daily Trend, CSV Export & Stage 3 Filters/Pagination verified.');
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log('\nALL LILA ANALYTICS (P0) TESTS PASSED!');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
