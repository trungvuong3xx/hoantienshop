/* global document */
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert/strict');
const fs = require('fs');
const { ensureDbLoaded, createToken, hashPassword } = require('../src/services/dbService');
const { detectImageMime } = require('../src/services/avatarStorageService');

// Valid minimal 1x1 red PNG binary
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// Valid minimal JPEG header + EOI bytes
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
// Valid minimal WEBP header bytes
const VALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x14, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
]);

async function run() {
  console.log('=== STARTING USER AVATAR UPLOAD & SYNC VERIFICATION ===');

  // 1. Magic-byte MIME validator unit checks
  assert.equal(detectImageMime(VALID_PNG), 'image/png');
  assert.equal(detectImageMime(VALID_JPEG), 'image/jpeg');
  assert.equal(detectImageMime(VALID_WEBP), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('<svg onload="alert(1)"></svg>')), null, 'SVG must be rejected');
  assert.equal(detectImageMime(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00')), null, 'EXE must be rejected');
  assert.equal(detectImageMime(Buffer.from('<html><script>alert(1)</script></html>')), null, 'HTML must be rejected');
  console.log('PASS: Magic-byte MIME validation blocks SVG/HTML/EXE and allows JPEG/PNG/WEBP.');

  // Seed 2 normal users + use existing admin
  const db = ensureDbLoaded();
  const userA = {
    id: 'usr_avatar_a',
    code: 'UAVT01',
    name: 'Nguyễn Văn An',
    phone: '0911223344',
    email: 'an@example.com',
    passwordHash: hashPassword('Pass12345!'),
    role: 'user',
    tokenVersion: 1,
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    avatarUrl: '',
    createdAt: new Date().toISOString()
  };
  const userB = {
    id: 'usr_avatar_b',
    code: 'UAVT02',
    name: 'Trần Thị Bình',
    phone: '0911223355',
    email: 'binh@example.com',
    passwordHash: hashPassword('Pass12345!'),
    role: 'user',
    tokenVersion: 1,
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    avatarUrl: '',
    createdAt: new Date().toISOString()
  };
  db.users.push(userA, userB);

  const tokenA = createToken(userA);
  const tokenB = createToken(userB);
  const adminUser = db.users.find((u) => u.role === 'admin');
  const tokenAdmin = adminUser ? createToken(adminUser) : null;

  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    // 2. Unauthenticated upload -> 401
    const unauthRes = await fetch(`${baseUrl}/api/user/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: VALID_PNG
    });
    assert.equal(unauthRes.status, 401, 'Unauthenticated avatar upload must return 401');

    // 3. Fake image (script masquerading as image/jpeg) -> 400
    const fakeRes = await fetch(`${baseUrl}/api/user/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${tokenA}` },
      body: Buffer.from('<script>alert("xss")</script>1234567890')
    });
    assert.equal(fakeRes.status, 400, 'Spoofed Content-Type with script payload must return 400');

    // 4. Oversized payload (> 2 MB) -> 413
    const hugeBuf = Buffer.concat([VALID_PNG, Buffer.alloc(2 * 1024 * 1024 + 512, 0)]);
    const hugeRes = await fetch(`${baseUrl}/api/user/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${tokenA}` },
      body: hugeBuf
    });
    assert.equal(hugeRes.status, 413, 'Oversized payload (>2MB) must return 413');

    // 5. Valid PNG upload by User A (even if query tries ?userId=usr_avatar_b -> MUST only update User A)
    const up1Res = await fetch(`${baseUrl}/api/user/avatar?userId=${userB.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${tokenA}` },
      body: VALID_PNG
    });
    assert.equal(up1Res.status, 200);
    const up1Data = await up1Res.json();
    assert.ok(up1Data.avatarUrl.startsWith('/api/avatars/avt_'), 'Avatar URL must point to storage route, not base64');
    assert.ok(!up1Data.avatarUrl.startsWith('data:'), 'Must NOT store base64 data URI in user record');
    assert.equal(up1Data.user.id, userA.id);
    assert.equal(userB.avatarUrl, '', 'User A must never be able to alter User B avatar');

    // 6. Serve uploaded avatar with strict security & caching headers
    const get1Res = await fetch(`${baseUrl}${up1Data.avatarUrl}`);
    assert.equal(get1Res.status, 200);
    assert.equal(get1Res.headers.get('content-type'), 'image/png');
    assert.equal(get1Res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((get1Res.headers.get('cache-control') || '').includes('immutable'));
    const servedBuf = Buffer.from(await get1Res.arrayBuffer());
    assert.deepEqual(servedBuf, VALID_PNG);

    // 7. Replace avatar -> new URL returned & OLD avatar deleted (returns 404)
    const up2Res = await fetch(`${baseUrl}/api/user/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${tokenA}` },
      body: VALID_JPEG
    });
    assert.equal(up2Res.status, 200);
    const up2Data = await up2Res.json();
    assert.notEqual(up2Data.avatarUrl, up1Data.avatarUrl, 'Replaced avatar must get a fresh cache-busted URL');

    const oldCheckRes = await fetch(`${baseUrl}${up1Data.avatarUrl}`);
    assert.equal(oldCheckRes.status, 404, 'Previous avatar must be cleaned up to prevent storage garbage');

    // 8. Persistence across /api/user/me (simulates new device / re-login)
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.user.avatarUrl, up2Data.avatarUrl, '/api/user/me must return persisted avatarUrl');

    // 9. User B & Admin isolation check
    const meBRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const meBData = await meBRes.json();
    assert.equal(meBData.user.avatarUrl, '', 'User B remains unaffected');

    if (tokenAdmin) {
      const admUpRes = await fetch(`${baseUrl}/api/user/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp', Authorization: `Bearer ${tokenAdmin}` },
        body: VALID_WEBP
      });
      assert.equal(admUpRes.status, 200, 'Admin account can also update own avatar without breaking admin role');
      const admUpData = await admUpRes.json();
      assert.equal(admUpData.user.role, 'admin');
    }

    console.log('PASS: Backend auth, magic-byte security, cleanup, cross-user isolation & persistence verified.');

    // 10. Real Mobile Browser E2E test (390x844)
    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      console.log('SKIP: Playwright unavailable.');
      return;
    }

    const execPath =
      process.env.AUDIT_BROWSER ||
      (process.platform === 'win32' && fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
        ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        : undefined);

    browser = await playwright.chromium.launch({ headless: true, executablePath: execPath });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort()));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // Login as User B via UI
    await page.locator('#openLoginBtn').click();
    await page.waitForSelector('#authModal:not(.hidden)');
    await page.fill('#loginIdentifier', userB.phone);
    await page.fill('#loginPassword', 'Pass12345!');
    await page.locator('#doLoginBtn').click();
    await page.waitForSelector('#navUserArea:not(.hidden)');

    // Navigate to Account ("Tôi") tab
    await page.locator('#mobileBottomNav [data-nav="account"]').click();
    await page.waitForSelector('#accountAuthenticatedContent:not(.hidden)');

    // Select a valid PNG -> Crop modal opens -> Cancel -> avatar remains default initial
    await page.locator('#avatarFileInput').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: VALID_PNG
    });
    await page.waitForSelector('#avatarCropModal:not(.hidden)');
    await page.locator('#avatarCropCancelBtn').click();
    await page.waitForSelector('#avatarCropModal', { state: 'hidden', timeout: 5000 });
    const imgCountAfterCancel = await page.locator('#accountAvatarInitial img').count();
    assert.equal(imgCountAfterCancel, 0, 'Cancelling crop modal must not upload or alter avatar');

    // Select invalid file format -> Toast error, crop modal stays hidden
    await page.locator('#avatarFileInput').setInputFiles({
      name: 'malware.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ1234567890')
    });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#avatarCropModal').evaluate((el) => el.classList.contains('hidden')), true);

    // Select valid PNG -> Confirm upload -> Synced immediately across Profile, Header, and Mobile Bottom Nav
    await page.locator('#avatarFileInput').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: VALID_PNG
    });
    await page.waitForSelector('#avatarCropModal:not(.hidden)');
    await page.locator('#avatarCropConfirmBtn').click();
    await page.waitForSelector('#avatarCropModal', { state: 'hidden', timeout: 5000 });
    await page.waitForSelector('#accountAvatarInitial img', { timeout: 5000 });

    const profileSrc = await page.locator('#accountAvatarInitial img').getAttribute('src');
    const headerSrc = await page.locator('#headerUserAvatar img').getAttribute('src');
    const mobileNavSrc = await page.locator('#mobileNavAccountAvatar img').getAttribute('src');
    assert.ok(profileSrc && profileSrc.startsWith('/api/avatars/avt_'), 'Profile avatar must update immediately');
    assert.equal(headerSrc, profileSrc, 'Header avatar must sync immediately without reload');
    assert.equal(mobileNavSrc, profileSrc, 'Mobile bottom nav avatar must sync immediately without reload');

    // Verify zero horizontal overflow on small mobile screen
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflowX, false, 'Zero horizontal overflow on mobile after avatar sync');

    // Reload page -> Avatar persists seamlessly
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#headerUserAvatar img', { timeout: 5000 });
    const persistedSrc = await page.locator('#headerUserAvatar img').getAttribute('src');
    assert.equal(persistedSrc, profileSrc, 'Uploaded avatar must persist across page reload');

    console.log('PASS: Mobile crop UI, cancel flow, invalid file guard, instant multi-spot sync & reload persistence verified.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
