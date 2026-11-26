/* global window, document, CustomEvent */
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

async function run() {
  console.log('=== STARTING SHIBA COMPANION (MẪU B) VERIFICATION ===');

  const root = path.join(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'public', 'shibaCompanion.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'shibaCompanion.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

  // 1. Structural & performance guarantees (no setInterval, prefers-reduced-motion, auto-hide rules, lazy-loaded)
  assert.ok(!/\bsetInterval\s*\(/.test(js), 'Shiba Companion must not use continuous setInterval');
  assert.ok(css.includes('prefers-reduced-motion'), 'shibaCompanion.css must respect prefers-reduced-motion');
  assert.ok(css.includes('html.kb-open .shiba-companion-layer'), 'Must auto-hide when mobile keyboard is open');
  assert.ok(css.includes('body:has(#view-admin.active) .shiba-companion-layer'), 'Must auto-hide in Admin area');
  assert.ok(css.includes('body:has(.modal-backdrop:not(.hidden)) .shiba-companion-layer'), 'Must auto-hide when modals open');
  assert.ok(appJs.includes('/shibaCompanion.css?v=6'), 'app.js must lazy-load shibaCompanion.css after first paint');
  assert.ok(appJs.includes('/shibaCompanion.js?v=6'), 'app.js must lazy-load shibaCompanion.js after first paint');
  assert.ok(indexHtml.includes('id="toggleShibaCompanionBtn"'), 'index.html must include Account Shiba toggle');

  const cssSizeKb = (Buffer.byteLength(css, 'utf8') / 1024).toFixed(1);
  const jsSizeKb = (Buffer.byteLength(js, 'utf8') / 1024).toFixed(1);
  console.log(`PASS: Static & performance checks passed (CSS: ${cssSizeKb} KB, JS: ${jsSizeKb} KB, zero setInterval).`);

  // 2. Real browser verification on Mobile (390x844) and Desktop (1280x800)
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

  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true, executablePath: execPath });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('**/*', (route) => (new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort()));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#lilaShibaActor');

    // Check position above mobile bottom nav & zero horizontal overflow
    const shibaRect = await page.locator('#lilaShibaActor').boundingBox();
    const navRect = await page.locator('#mobileBottomNav').boundingBox();
    assert.ok(shibaRect && shibaRect.width <= 60, 'Mobile Shiba must be compact');
    if (navRect) {
      assert.ok(shibaRect.y + shibaRect.height <= navRect.y + 4, 'Shiba must sit above mobile bottom nav');
    }
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflowX, false, 'Zero horizontal overflow on mobile');

    // Progressive tap interaction: 1st tap -> curious, 2nd tap -> happy + clamped speech bubble
    await page.locator('#lilaShibaActor').click();
    await page.waitForSelector('#lilaShibaBubble.is-visible');
    const stateAfterFirstTap = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(stateAfterFirstTap, 'curious', '1st tap should make Shiba look curiously at Sen');

    await page.locator('#lilaShibaActor').click();
    const stateAfterSecondTap = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(stateAfterSecondTap, 'happy', '2nd tap should make Shiba jump happily');
    const bubbleRect = await page.locator('#lilaShibaBubble').boundingBox();
    assert.ok(bubbleRect && bubbleRect.x >= 0 && bubbleRect.x + bubbleRect.width <= 390, 'Speech bubble must stay inside mobile viewport');

    // Edge peek animation -> zero horizontal overflow
    await page.evaluate(() => window.LilaShiba.setState('peek'));
    const peekState = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(peekState, 'peek', 'peek state must activate cleanly');
    const overflowDuringPeek = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflowDuringPeek, false, 'Zero horizontal overflow while peeking from side edge');

    // Cashback convert-success event -> happy + exact celebration message
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lila:convert-success')));
    const successText = await page.locator('#lilaShibaBubbleText').textContent();
    assert.ok(successText.includes('Tuyệt vời!'), 'convert-success must trigger celebration bubble');

    // Cashback convert-error event -> sad state (NOT happy!)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lila:convert-error')));
    const errState = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(errState, 'sad', 'convert-error must not trigger happy animation');

    // Modal open -> Shiba layer auto-hides (opacity fades to 0)
    await page.locator('#openLoginBtn').click();
    await page.waitForSelector('#authModal:not(.hidden)');
    await page.waitForFunction(
      () => Number(window.getComputedStyle(document.getElementById('lilaShibaLayer')).opacity) === 0,
      null,
      { timeout: 2000 }
    );
    await page.locator('#closeAuthModalBtn').click();

    // Virtual keyboard open (html.kb-open) -> Shiba layer auto-hides
    await page.evaluate(() => document.documentElement.classList.add('kb-open'));
    await page.waitForFunction(
      () => Number(window.getComputedStyle(document.getElementById('lilaShibaLayer')).opacity) === 0,
      null,
      { timeout: 2000 }
    );
    await page.evaluate(() => document.documentElement.classList.remove('kb-open'));

    // Order recorded (curious) vs Cashback confirmed (happy)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lila:order-update')));
    const orderState = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(orderState, 'curious', 'order-update must trigger curious/recorded state');

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lila:cashback-confirmed')));
    const confirmedState = await page.locator('#lilaShibaActor').getAttribute('data-state');
    assert.equal(confirmedState, 'happy', 'cashback-confirmed must trigger happy coin celebration');

    // Sleep & Hide persistence across reload
    await page.evaluate(() => window.LilaShiba.hide());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#lilaShibaLayer');
    const persistedMode = await page.evaluate(() => window.LilaShiba.getMode());
    assert.equal(persistedMode, 'hidden', 'Hidden preference must persist after reload');

    // Wake back up
    await page.evaluate(() => window.LilaShiba.show());
    const wokeMode = await page.evaluate(() => window.LilaShiba.getMode());
    assert.equal(wokeMode, 'active', 'User must be able to summon Shiba back');

    // Desktop viewport (1280x800) check: compact bottom-left corner, zero overflow
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(150);
    const desktopRect = await page.locator('#lilaShibaActor').boundingBox();
    assert.ok(desktopRect && desktopRect.y > 650 && desktopRect.width <= 72, 'Desktop Shiba must sit compactly near bottom edge');
    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(desktopOverflow, false, 'Zero horizontal overflow on desktop');

    console.log('PASS: Mobile & desktop positioning, tap interaction, Cashback events, modal/keyboard auto-hide, and sleep/hide persistence verified.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
