/* global document */
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

async function run() {
  console.log('=== STARTING MOBILE VIRTUAL KEYBOARD & POPUP LAYOUT VERIFICATION ===');

  const root = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const selectCss = fs.readFileSync(path.join(root, 'public', 'selectPopup.css'), 'utf8');
  const selectJs = fs.readFileSync(path.join(root, 'public', 'selectPopup.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  // 1. Meta viewport supports Android Chrome resizes-content
  assert.ok(
    indexHtml.includes('interactive-widget=resizes-content'),
    'Meta viewport must include interactive-widget=resizes-content'
  );

  // 2. Bank search / select dialog must anchor to live visual viewport top on mobile, NOT bottom
  assert.ok(
    !selectCss.includes('margin: auto auto 12px'),
    'selectPopup.css must not pin dialog to bottom of layout viewport on mobile'
  );
  assert.ok(selectCss.includes('top: calc(var(--vv-top, 0px) + 8px)'), 'selectPopup.css must anchor to --vv-top');
  assert.ok(selectCss.includes('max-height: calc(var(--vvh, 100dvh) - 16px)'), 'selectPopup.css must cap height to --vvh');
  assert.ok(selectCss.includes('.app-choice-dialog.has-search[open]'), 'selectPopup.css must size searchable dialogs to live visual viewport');
  assert.ok(selectCss.includes('align-content: start'), 'selectPopup.css list must pack filtered results from the top');
  assert.ok(selectJs.includes("dialog.classList.toggle('has-search'"), 'selectPopup.js must toggle has-search class');
  assert.ok(selectJs.includes('list.scrollTop = 0'), 'selectPopup.js must reset scroll position on search filter');

  // 3. Shared modal system uses visual viewport vars, keyboard-open top alignment, flex-column scroll, and background scroll lock
  assert.ok(stylesCss.includes('height: var(--vvh, 100dvh)'), 'styles.css .modal-backdrop must track --vvh');
  assert.ok(stylesCss.includes('top: var(--vv-top, 0px)'), 'styles.css .modal-backdrop must track --vv-top');
  assert.ok(stylesCss.includes('html.kb-open .modal-backdrop'), 'styles.css must switch modal alignment when keyboard is open');
  assert.ok(stylesCss.includes('body:has(dialog.app-choice-dialog[open])'), 'styles.css must lock body scroll while dialog/modal is open');

  // 4. Shared Visual Viewport & Keyboard Manager in app.js
  assert.ok(appJs.includes('function initMobileViewportManager()'), 'app.js must define initMobileViewportManager');
  assert.ok(appJs.includes('window.visualViewport'), 'app.js must listen to window.visualViewport');
  assert.ok(appJs.includes("root.style.setProperty('--vvh'"), 'app.js must set --vvh');
  assert.ok(appJs.includes("root.style.setProperty('--vv-top'"), 'app.js must set --vv-top');
  assert.ok(appJs.includes("root.classList.toggle('kb-open'"), 'app.js must toggle kb-open class');

  console.log('PASS: Meta viewport, Visual Viewport Manager, Bank Search dialog, and Modal CSS/JS verified.');

  // 5. Real browser geometry check across mobile viewports (360px, 390px, 430px) if Playwright + Edge/Chrome available
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.log('SKIP: Playwright not installed; static assertions passed.');
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
    for (const vp of [
      { width: 360, height: 740 },
      { width: 390, height: 844 },
      { width: 430, height: 932 }
    ]) {
      const page = await browser.newPage({ viewport: vp });
      await page.route('**/*', (route) => (new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort()));
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#openLoginBtn');

      // Simulate virtual keyboard opening by shrinking viewport height to 360px
      const kbVisibleH = 360;
      await page.setViewportSize({ width: vp.width, height: kbVisibleH });
      await page.waitForFunction(() => document.documentElement.classList.contains('kb-open'));

      // Test 1: Auth Modal (Login & Register) fits entirely inside [0, kbVisibleH]
      await page.locator('#openLoginBtn').click();
      await page.waitForSelector('#authModal:not(.hidden)');
      const authRect = await page.locator('#authModal .modal-box').boundingBox();
      assert.ok(authRect && authRect.y >= 0 && authRect.y + authRect.height <= kbVisibleH + 2, `Auth modal must fit above keyboard at ${vp.width}px`);

      // Switch to Register tab (longer form) and verify no horizontal overflow and fits above keyboard
      await page.locator('[data-auth-tab="register"]').click();
      const regRect = await page.locator('#authModal .modal-box').boundingBox();
      assert.ok(regRect && regRect.y >= 0 && regRect.y + regRect.height <= kbVisibleH + 2, `Register modal must fit above keyboard at ${vp.width}px`);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflowX, false, `Must have zero horizontal overflow at ${vp.width}px`);
      await page.locator('#closeAuthModalBtn').click();

      // Test 2: Bank Search Dialog (#wdBankNameChoice) fits entirely inside [0, kbVisibleH] and results stay visible when filtered
      await page.evaluate(() => {
        document.getElementById('wdBankNameChoice')?.click();
      });
      await page.waitForSelector('dialog.app-choice-dialog[open]');
      await page.locator('dialog.app-choice-dialog .app-choice-search').fill('Vietcom');
      const dlgRect = await page.locator('dialog.app-choice-dialog').boundingBox();
      const optRect = await page.locator('dialog.app-choice-dialog .app-choice-option').first().boundingBox();
      assert.ok(dlgRect && dlgRect.y >= 0 && dlgRect.y + dlgRect.height <= kbVisibleH + 2, `Bank search dialog must stay above keyboard at ${vp.width}px`);
      assert.ok(optRect && optRect.y >= 0 && optRect.y + optRect.height <= kbVisibleH + 2, `Filtered bank option must stay visible above keyboard at ${vp.width}px`);
      await page.locator('dialog.app-choice-dialog header button').click();

      await page.close();
    }
    console.log('PASS: Real mobile browser geometry verified at 360px, 390px, and 430px with simulated virtual keyboard.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
