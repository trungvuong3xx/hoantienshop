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
  const beforeClickIds = new Set((dbService.ensureDbLoaded().clicks || []).map((c) => c.clickId));

  try {
    // Seed a member account for mobile login E2E
    const db = dbService.ensureDbLoaded();
    const testPhone = `09${String(Date.now()).slice(-8)}`;
    const testPass = 'MobilePass123!';
    const testUser = {
      id: `usr_e2e_${Date.now()}`,
      code: `U${String(Date.now()).slice(-5)}`,
      name: 'Khách Mobile E2E',
      phone: testPhone,
      email: '',
      passwordHash: await dbService.hashPasswordAsync(testPass),
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
    };
    createdUserId = testUser.id;
    db.users.push(testUser);
    await dbService.saveDb(db);

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('BROWSER PAGEERROR:', err));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('BROWSER CONSOLE ERROR:', msg.text());
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // 1. Guest converts a Shopee product link on mobile
    const sampleUrl = 'https://shopee.vn/product/175753395/6065001847';
    await page.locator('#productUrlInput').fill(sampleUrl);
    await page.locator('#getCashbackLinkBtn').click();

    await page.locator('#conversionResultSection:not(.hidden)').waitFor({ timeout: 10000 });
    const guestNote = page.locator('.guest-card-note');
    await guestNote.waitFor({ state: 'visible', timeout: 5000 });

    const guestHref = await page.locator('.btn-open-aff').getAttribute('href');
    assert.ok(guestHref, 'Guest conversion must render CTA href');

    // 2. Tap "Đăng nhập ngay" directly inside the Guest card notice
    await guestNote.locator('[data-open-auth="login"]').click();
    await page.locator('#authModal:not(.hidden)').waitFor({ timeout: 5000 });

    await page.locator('#loginIdentifier').fill(testPhone);
    await page.locator('#loginPassword').fill(testPass);
    await page.locator('#doLoginBtn').click();

    // 3. Verify automatic re-conversion replaces GUEST link with member-attributed link & shows green confirmation
    await page.locator('.auth-linked-card-note').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('.guest-card-note').count(), 0, 'Guest warning note must disappear after login refresh');

    const authHref = await page.locator('.btn-open-aff').getAttribute('href');
    assert.ok(authHref, 'Authenticated conversion must render CTA href');
    assert.notEqual(authHref, guestHref, 'CTA href must be refreshed from GUEST link to authenticated user link');

    const noteText = await page.locator('.auth-linked-card-note').textContent();
    assert.ok(noteText.includes(testUser.code), 'Confirmation note must display member code');

    // 4. Switch to Orders tab on mobile bottom nav and confirm manual order form is absent
    await page.locator('#mobileBottomNav [data-nav="orders"]').click();
    await page.locator('#ordersAuthenticatedContent:not(.hidden)').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#toggleClaimBoxBtn').count(), 0, 'Manual order claim trigger must be absent');
    assert.equal(await page.locator('#submitOrderClaimBtn').count(), 0, 'Manual order submit button must be absent');

    console.log('PASS: Mobile E2E (390x844) verified Guest -> Login auto link refresh & clean Orders view.');
  } finally {
    const finalDb = dbService.ensureDbLoaded();
    if (createdUserId) {
      finalDb.users = finalDb.users.filter((u) => u.id !== createdUserId);
    }
    finalDb.clicks = (finalDb.clicks || []).filter((c) => beforeClickIds.has(c.clickId));
    await dbService.saveDb(finalDb);
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error('Guest-to-Login E2E failed:', err);
  process.exitCode = 1;
});
