/* global document */
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const dbService = require('../src/services/dbService');
const app = require('../server');

(async () => {
  console.log('--- Running Phase 5 Bundle Lazy-Load, SWR PWA & Mobile Activity Retention Suite ---');

  const rootDir = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(rootDir, 'public/index.html'), 'utf8');
  const swJs = fs.readFileSync(path.join(rootDir, 'public/sw.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'public/app.js'), 'utf8');

  // 1. [LOW-01] Verify dead 2MB video asset removed & public config deduplicated
  assert.equal(
    fs.existsSync(path.join(rootDir, 'public/guide_video.mp4')),
    false,
    'Unused public/guide_video.mp4 (~2MB) must be removed'
  );

  // 2. [MED-05 & MED-03] Verify Admin assets removed from customer HTML head & SWR active in sw.js
  for (const adminAsset of ['/adminMobile.css', '/adminMobile.js', '/csvImport.js', '/tiktokReply.js']) {
    assert.equal(
      html.includes(`src="${adminAsset}`) || html.includes(`href="${adminAsset}`),
      false,
      `Customer index.html must NOT eagerly block/download ${adminAsset}`
    );
  }
  assert.ok(appJs.includes('function ensureAdminAssetsLoaded()'), 'Admin lazy loader must exist in app.js');
  assert.ok(swJs.includes('LAZY_ADMIN_PATHS') && swJs.includes('event.waitUntil(networkUpdate)'), 'sw.js must implement Stale-While-Revalidate');

  // 3. Live Server + Mobile Browser E2E Verification (390x844)
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Verify /api/public-config and /api/settings return identical payloads
  const [pubCfg, setCfg] = await Promise.all([
    fetch(`${baseUrl}/api/public-config`).then((r) => r.json()),
    fetch(`${baseUrl}/api/settings`).then((r) => r.json())
  ]);
  assert.deepEqual(pubCfg, setCfg, '/api/public-config and /api/settings must return identical responses');

  const edgeWinPath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PWA_TEST_CHANNEL
      ? { channel: process.env.PWA_TEST_CHANNEL }
      : process.platform === 'win32' && fs.existsSync(edgeWinPath)
      ? { executablePath: edgeWinPath }
      : {})
  });

  let createdUserId = null;
  const createdOrderIds = [];

  try {
    const db = dbService.ensureDbLoaded();
    const phone = `09${String(Date.now()).slice(-8)}`;
    const pass = 'Phase5Pass!123';
    const userCode = `P5${String(Date.now()).slice(-4)}`;
    createdUserId = `usr_p5_${Date.now()}`;
    db.users.push({
      id: createdUserId,
      code: userCode,
      name: 'Khách P5',
      phone,
      email: '',
      passwordHash: await dbService.hashPasswordAsync(pass),
      role: 'user',
      tokenVersion: 1,
      referredBy: null,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      createdAt: new Date().toISOString()
    });
    await dbService.saveDb(db);

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    const requestedPaths = new Set();
    page.on('request', (req) => {
      try {
        requestedPaths.add(new URL(req.url()).pathname);
      } catch {}
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Customer session must request ZERO admin assets
    for (const adminPath of ['/adminMobile.css', '/adminMobile.js', '/csvImport.js', '/tiktokReply.js']) {
      assert.equal(requestedPaths.has(adminPath), false, `Customer startup must not fetch ${adminPath}`);
    }

    // Login as member -> initial load sets watermarks, notification dots MUST remain hidden
    await page.locator('#openLoginBtn').click();
    await page.locator('#loginIdentifier').fill(phone);
    await page.locator('#loginPassword').fill(pass);
    await page.locator('#doLoginBtn').click();
    await page.locator('#authModal').waitFor({ state: 'hidden' });

    assert.equal(await page.locator('#mobileOrdersNotifyDot').isVisible(), false, 'No false-positive order dot on initial login');
    assert.equal(await page.locator('#mobileWalletNotifyDot').isVisible(), false, 'No false-positive wallet dot on initial login');

    // Simulate a newly synced & approved order arriving in background while user is on Home
    const ordId = `ord_p5_${Date.now()}`;
    createdOrderIds.push(ordId);
    const liveDb = dbService.ensureDbLoaded();
    liveDb.orders.push({
      id: ordId,
      orderSn: `P5SN_${Date.now()}`,
      platform: 'shopee',
      userId: createdUserId,
      userCode,
      productName: 'Bình giữ nhiệt Phase 5',
      orderAmount: 180000,
      grossCommission: 18000,
      netCommission: 16200,
      totalCommission: 18000,
      cashbackRate: 70,
      userCashbackAmount: 11340,
      status: 'approved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    dbService.recalculateUserWallet(createdUserId);
    await dbService.saveDb(liveDb);

    // Trigger background dashboard refresh while still on #view-home (e.g. switching to Account tab)
    await page.locator('#mobileBottomNav [data-nav="account"]').click();
    await page.waitForFunction(
      () =>
        !document.getElementById('mobileOrdersNotifyDot').classList.contains('hidden') &&
        !document.getElementById('mobileWalletNotifyDot').classList.contains('hidden')
    );

    // Tapping Orders tab clears #mobileOrdersNotifyDot immediately
    await page.locator('#mobileBottomNav [data-nav="orders"]').click();
    assert.equal(await page.locator('#mobileOrdersNotifyDot').isVisible(), false, 'Orders dot must clear when viewing Orders');
    assert.equal(await page.locator('#mobileWalletNotifyDot').isVisible(), true, 'Wallet dot stays lit until Wallet is viewed');

    // Tapping Wallet tab clears #mobileWalletNotifyDot immediately
    await page.locator('#mobileBottomNav [data-nav="wallet"]').click();
    assert.equal(await page.locator('#mobileWalletNotifyDot').isVisible(), false, 'Wallet dot must clear when viewing Wallet');

    console.log('PASS: Phase 5 verified (Zero admin payload for customers, SWR PWA, unified config, unseen Order/Wallet mobile badges).');
  } finally {
    const cleanDb = dbService.ensureDbLoaded();
    if (createdUserId) {
      cleanDb.users = cleanDb.users.filter((u) => u.id !== createdUserId);
      cleanDb.ledger = cleanDb.ledger.filter((l) => l.userId !== createdUserId);
    }
    if (createdOrderIds.length > 0) {
      cleanDb.orders = cleanDb.orders.filter((o) => !createdOrderIds.includes(o.id));
    }
    await dbService.saveDb(cleanDb);
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Phase 5 test failed:', err);
  process.exitCode = 1;
});
