/* global document */
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const dbService = require('../src/services/dbService');
const app = require('../server');

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PWA_TEST_CHANNEL ? { channel: process.env.PWA_TEST_CHANNEL } : {})
  });

  let createdUserId = null;
  const seededOrderIds = [];
  const beforeClickIds = new Set((dbService.ensureDbLoaded().clicks || []).map((c) => c.clickId));

  try {
    const db = dbService.ensureDbLoaded();
    const phone = `09${String(Date.now()).slice(-8)}`;
    const initPass = 'MobileP3!123';
    const userCode = `P3${String(Date.now()).slice(-4)}`;
    createdUserId = `usr_p3_e2e_${Date.now()}`;

    db.users.push({
      id: createdUserId,
      code: userCode,
      name: 'Khách Mobile P3',
      phone,
      email: '',
      passwordHash: await dbService.hashPasswordAsync(initPass),
      role: 'user',
      tokenVersion: 1,
      referredBy: null,
      balanceAvailable: 0,
      balancePending: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      bankName: '',
      bankAccount: '',
      bankOwner: '',
      createdAt: new Date().toISOString()
    });

    // Seed 13 orders: 8 pending (newest), 2 cancelled, 3 approved (oldest -> on page 2 when unfiltered!)
    const now = Date.now();
    const statuses = [
      ...Array(8).fill('pending'),
      ...Array(2).fill('cancelled'),
      ...Array(3).fill('approved')
    ];
    statuses.forEach((st, idx) => {
      const ordId = `ord_p3e2e_${now}_${idx}`;
      seededOrderIds.push(ordId);
      db.orders.push({
        id: ordId,
        orderSn: `E2ESN_${idx}_${String(now).slice(-4)}`,
        platform: 'shopee',
        userId: createdUserId,
        userCode,
        productName: `Sản phẩm E2E #${idx}`,
        orderAmount: 200000,
        grossCommission: 20000,
        netCommission: 18000,
        totalCommission: 20000,
        cashbackRate: 70,
        userCashbackAmount: st === 'cancelled' ? 0 : 12600,
        status: st,
        createdAt: new Date(now - idx * 60000).toISOString(),
        updatedAt: new Date(now - idx * 60000).toISOString()
      });
    });
    dbService.recalculateUserWallet(createdUserId);
    await dbService.saveDb(db);

    // Emulate Zalo In-App WebView on 390x844 mobile screen
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo/24.09.01'
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 1. Login via Auth Modal
    await page.locator('#openLoginBtn').click();
    await page.locator('#loginIdentifier').fill(phone);
    await page.locator('#loginPassword').fill(initPass);
    await page.locator('#doLoginBtn').click();
    await page.locator('#authModal').waitFor({ state: 'hidden' });

    // 2. [MED-02] Convert link inside Zalo In-App WebView -> must display .webview-open-hint
    await page.locator('#productUrlInput').fill('https://shopee.vn/product/175753395/6065001847');
    await page.locator('#getCashbackLinkBtn').click();
    await page.locator('.webview-open-hint').waitFor({ state: 'visible', timeout: 8000 });

    // 3. [HIGH-03] Orders tab: global status counts (13 / 8 / 3 / 2) & server-side filter pill
    await page.locator('#mobileBottomNav [data-nav="orders"]').click();
    await page.locator('#ordersAuthenticatedContent:not(.hidden)').waitFor();
    assert.equal(await page.locator('#ordCountAll').textContent(), '13');
    assert.equal(await page.locator('#ordCountPending').textContent(), '8');
    assert.equal(await page.locator('#ordCountApproved').textContent(), '3');
    assert.equal(await page.locator('#ordCountCancelled').textContent(), '2');

    // Tap "Đã duyệt" pill -> fetches all 3 approved orders from server (even though they were on page 2 unfiltered!)
    await page.locator('[data-order-status="approved"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('#userOrdersTableBody tr').length === 3
    );

    // 4. [HIGH-04] Wallet tab: 1-tap MoMo <-> Bank sync via custom mobile choice dialog
    await page.locator('#mobileBottomNav [data-nav="wallet"]').click();
    await page.locator('#walletAuthenticatedContent:not(.hidden)').waitFor();
    assert.equal(await page.locator('#wdBankNameGroup').isVisible(), true);

    await page.locator('#wdMethodChoice').click();
    await page.locator('.app-choice-option', { hasText: 'Ví điện tử MoMo' }).click();
    assert.equal(await page.locator('#wdBankNameGroup').isVisible(), false, 'MoMo mode must hide bank picker group');
    assert.equal(await page.locator('#wdBankName').inputValue(), 'MoMo');
    assert.match(await page.locator('#wdBankAccountLabel').textContent(), /MoMo/);

    // Switch back to Bank -> bank picker reappears with empty / non-MoMo value
    await page.locator('#wdMethodChoice').click();
    await page.locator('.app-choice-option', { hasText: 'Chuyển khoản Ngân hàng' }).click();
    assert.equal(await page.locator('#wdBankNameGroup').isVisible(), true);
    assert.equal(await page.locator('#wdBankName').inputValue(), '');

    // 5. [MED-01] Account tab: Self-service Profile + MoMo save & Password change
    await page.locator('#mobileBottomNav [data-nav="account"]').click();
    await page.locator('#accountAuthenticatedContent:not(.hidden)').waitFor();

    await page.locator('#toggleAccProfileBtn').click();
    await page.locator('#accProfilePanel:not(.hidden)').waitFor();
    await page.locator('#accProfileName').fill('Nguyễn Văn Mobile');
    await page.locator('#accBankMethodChoice').click();
    await page.locator('.app-choice-option', { hasText: 'Ví điện tử MoMo' }).click();
    assert.equal(await page.locator('#accBankNameGroup').isVisible(), false);
    await page.locator('#accBankAccount').fill(phone);
    await page.locator('#accBankOwner').fill('NGUYEN VAN MOBILE');
    await page.locator('#accBankCurrentPassword').fill(initPass);
    await page.locator('#saveAccProfileBtn').click();

    await page.locator('#accProfilePanel').waitFor({ state: 'hidden', timeout: 8000 });
    assert.equal(await page.locator('#accountUserName').textContent(), 'Nguyễn Văn Mobile');
    assert.match(await page.locator('#accountBankSummary').textContent(), /MoMo/);

    // Verify Wallet tab automatically synced to the saved MoMo profile!
    await page.locator('#mobileBottomNav [data-nav="wallet"]').click();
    assert.equal(await page.locator('#wdMethod').inputValue(), 'momo');
    assert.equal(await page.locator('#wdBankNameGroup').isVisible(), false);
    assert.equal(await page.locator('#wdBankAccount').inputValue(), phone);

    // Return to Account tab and change password
    await page.locator('#mobileBottomNav [data-nav="account"]').click();
    await page.locator('#toggleAccPasswordBtn').click();
    await page.locator('#accPasswordPanel:not(.hidden)').waitFor();
    await page.locator('#accOldPassword').fill(initPass);
    await page.locator('#accNewPassword').fill('UpdatedPass789!');
    await page.locator('#accConfirmPassword').fill('UpdatedPass789!');
    await page.locator('#saveAccPasswordBtn').click();
    await page.locator('#accPasswordPanel').waitFor({ state: 'hidden', timeout: 8000 });

    assert.deepEqual(pageErrors, [], 'Must produce zero uncaught page errors');
    console.log('PASS: Mobile E2E (390x844 Zalo WebView) verified WebView hint, Server order pills, 1-tap MoMo sync & Self-service Account/Password.');
  } finally {
    const finalDb = dbService.ensureDbLoaded();
    if (createdUserId) {
      finalDb.users = finalDb.users.filter((u) => u.id !== createdUserId);
      finalDb.ledger = finalDb.ledger.filter((l) => l.userId !== createdUserId);
    }
    if (seededOrderIds.length > 0) {
      finalDb.orders = finalDb.orders.filter((o) => !seededOrderIds.includes(o.id));
    }
    finalDb.clicks = (finalDb.clicks || []).filter((c) => beforeClickIds.has(c.clickId));
    await dbService.saveDb(finalDb);
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Phase 3 Mobile E2E failed:', err);
  process.exitCode = 1;
});
