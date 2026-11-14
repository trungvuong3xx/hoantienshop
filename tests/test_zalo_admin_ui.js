/**
 * Test Suite: Admin UI Zalo Community Configuration & Live Toggle (Task 13)
 *
 * Verifies:
 * 1. Admin Settings HTML in public/index.html:
 *    - Input #admZaloGroupUrl with label, hint, and placeholder.
 *    - Checkbox #admZaloWidgetEnabled with label and hint.
 *    - Retention of #admSupportZalo for personal CSKH hotline support.
 * 2. Admin Settings Logic in public/app.js:
 *    - loadAdminSettings(settings) correctly populates input and checkbox.
 *    - saveAdminSettings collects payload, preserves boolean toggling, and trims URLs.
 *    - saveAdminSettings triggers public config refresh and immediately applies updates
 *      to the floating button via applyZaloWidget without requiring a page reload.
 * 3. Live DOM Reflection Simulation:
 *    - Enabling / disabling the widget dynamically reflects in #floatingZaloWidget visibility.
 *    - URL changes immediately update #floatingZaloLink href.
 *    - Disallowed URLs safely hide the widget.
 *    - Button loading states (disabled & text toggle) during save.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function runZaloAdminUiTestSuite() {
  console.log('=== STARTING TASK 13: ZALO ADMIN UI & LIVE TOGGLE VERIFICATION SUITE ===');

  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const appJsPath = path.join(__dirname, '..', 'public', 'app.js');

  const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  // =========================================================================
  // 1. HTML Verification (public/index.html)
  // =========================================================================
  console.log('\n--- 1. Testing public/index.html Admin Settings Controls ---');

  // 1.1 admZaloGroupUrl field
  assert.ok(
    htmlContent.includes('id="admZaloGroupUrl"'),
    'index.html must contain an input element with id="admZaloGroupUrl"'
  );
  assert.ok(
    /for="admZaloGroupUrl"[^>]*>.*(Nhóm Zalo|Cộng Đồng|Zalo)/i.test(htmlContent) ||
      /<label[^>]*>.*(Nhóm Zalo|Cộng Đồng|Zalo).*\n*.*id="admZaloGroupUrl"/i.test(htmlContent),
    'admZaloGroupUrl must have a descriptive label for Zalo Community Group'
  );
  assert.ok(
    /id="admZaloGroupUrl"[^>]*placeholder="https:\/\/zalo\.me\/g\//.test(htmlContent),
    'admZaloGroupUrl must provide a helpful placeholder starting with https://zalo.me/g/'
  );
  assert.ok(
    htmlContent.includes('https://zalo.me/g/'),
    'admZaloGroupUrl must include hint text indicating required https://zalo.me/g/ format'
  );

  // 1.2 admZaloWidgetEnabled checkbox
  assert.ok(
    htmlContent.includes('id="admZaloWidgetEnabled"'),
    'index.html must contain a checkbox element with id="admZaloWidgetEnabled"'
  );
  assert.ok(
    /type="checkbox"[^>]*id="admZaloWidgetEnabled"|id="admZaloWidgetEnabled"[^>]*type="checkbox"/.test(
      htmlContent
    ),
    'admZaloWidgetEnabled must be type="checkbox"'
  );
  assert.ok(
    /for="admZaloWidgetEnabled"[^>]*>.*(Zalo|nút)/i.test(htmlContent) ||
      /<label[^>]*>[\s\S]*?id="admZaloWidgetEnabled"[\s\S]*?(Hiển thị|Bật|nút|Zalo)/i.test(
        htmlContent
      ),
    'admZaloWidgetEnabled must have a descriptive label'
  );

  // 1.3 admSupportZalo CSKH hotline retention
  assert.ok(
    htmlContent.includes('id="admSupportZalo"'),
    'index.html must retain id="admSupportZalo" for CSKH hotline/personal support'
  );

  // 1.4 save button presence
  assert.ok(
    htmlContent.includes('id="saveAdminSettingsBtn"'),
    'index.html must retain the save button id="saveAdminSettingsBtn"'
  );

  console.log('  PASS: Admin HTML controls, labels, hint text, and CSKH hotline retention verified.');

  // =========================================================================
  // 2. JS Implementation & Code Contract (public/app.js)
  // =========================================================================
  console.log('\n--- 2. Testing public/app.js Logic & Code Contracts ---');

  // 2.1 loadAdminSettings function
  assert.ok(
    appJsContent.includes('function loadAdminSettings('),
    'app.js must define function loadAdminSettings(settings)'
  );
  assert.ok(
    appJsContent.includes('admZaloGroupUrl') && appJsContent.includes('zaloGroupUrl'),
    'loadAdminSettings must populate admZaloGroupUrl from settings.zaloGroupUrl'
  );
  assert.ok(
    appJsContent.includes('admZaloWidgetEnabled') &&
      appJsContent.includes('zaloWidgetEnabled'),
    'loadAdminSettings must set admZaloWidgetEnabled checked state from settings.zaloWidgetEnabled'
  );

  // 2.2 loadAdminDashboard calls loadAdminSettings
  assert.ok(
    appJsContent.includes('loadAdminSettings(s)') ||
      appJsContent.includes('loadAdminSettings(data.settings)'),
    'loadAdminDashboard must invoke loadAdminSettings with admin settings'
  );

  // 2.3 saveAdminSettings function
  assert.ok(
    appJsContent.includes('async function saveAdminSettings('),
    'app.js must define async function saveAdminSettings'
  );
  assert.ok(
    appJsContent.includes('zaloGroupUrl:') || appJsContent.includes('zaloGroupUrl,'),
    'saveAdminSettings must include zaloGroupUrl in the POST payload'
  );
  assert.ok(
    appJsContent.includes('zaloWidgetEnabled:') || appJsContent.includes('zaloWidgetEnabled,'),
    'saveAdminSettings must include zaloWidgetEnabled in the POST payload'
  );

  // 2.4 Immediate reflection without page reload
  assert.ok(
    appJsContent.includes('applyZaloWidget(publicConfig)'),
    'saveAdminSettings must invoke applyZaloWidget(publicConfig) after saving'
  );

  console.log('  PASS: Code contracts for loadAdminSettings, saveAdminSettings, and live refresh verified.');

  // =========================================================================
  // 3. Functional / Behavioral Runtime Simulation in VM Context
  // =========================================================================
  console.log('\n--- 3. Running Functional Runtime Tests with Mock DOM Environment ---');

  // Build a lightweight mock DOM environment
  const elements = {};
  function createMockElement(id, type = 'text', tag = 'INPUT') {
    const classes = new Set();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      type,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      href: '',
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
          if (force !== undefined) {
            if (force) classes.add(c);
            else classes.delete(c);
          } else {
            if (classes.has(c)) classes.delete(c);
            else classes.add(c);
          }
        }
      },
      listeners: {},
      addEventListener: (ev, fn) => {
        el.listeners[ev] = el.listeners[ev] || [];
        el.listeners[ev].push(fn);
      }
    };
    elements[id] = el;
    return el;
  }

  // Admin controls
  const admZaloGroupUrl = createMockElement('admZaloGroupUrl', 'url');
  const admZaloWidgetEnabled = createMockElement('admZaloWidgetEnabled', 'checkbox');
  const admSupportZalo = createMockElement('admSupportZalo', 'text');
  const saveAdminSettingsBtn = createMockElement('saveAdminSettingsBtn', 'button', 'BUTTON');
  const admNewPass = createMockElement('admNewPass', 'password');

  // Floating widget controls
  const floatingZaloWidget = createMockElement('floatingZaloWidget', '', 'DIV');
  floatingZaloWidget.classList.add('hidden');
  const floatingZaloLink = createMockElement('floatingZaloLink', '', 'A');

  // Other admin elements needed by saveAdminSettings
  createMockElement('admShopeeMode');
  createMockElement('admShopeeAffiliateId');
  createMockElement('admShopeeAppId');
  createMockElement('admShopeeAppSecret');
  createMockElement('admAddlivetagApiKey');
  createMockElement('admTiktokMode');
  createMockElement('admTiktokDeepLink');
  createMockElement('admAccesstradeApiKey');
  createMockElement('admTaxDeductPercent');
  createMockElement('admCashbackPercent');
  createMockElement('admMinWithdraw');
  createMockElement('admReferralBounty');
  createMockElement('admShortener');

  // Setup VM sandbox
  let lastFetchUrl = null;
  let lastFetchOpts = null;
  let lastSavedSettingsBody = null;
  let publicConfigMock = {
    cashbackPercent: 70,
    minWithdrawAmount: 50000,
    referralBountyAmount: 5000,
    supportZalo: '0901234567',
    zaloGroupUrl: 'https://zalo.me/g/cl2cmiseoqienusnrbyr',
    zaloWidgetEnabled: true
  };

  const sandbox = {
    window: {
      addEventListener: () => {},
      open: () => {}
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { addEventListener: () => {} }
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
    AbortController: global.AbortController || AbortController,
    showToast: (msg) => {},
    fetch: async (url, opts = {}) => {
      lastFetchUrl = url;
      lastFetchOpts = opts;
      if (url === '/api/public-config') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...publicConfigMock })
        };
      }
      if (url === '/api/admin/settings') {
        const body = JSON.parse(opts.body || '{}');
        lastSavedSettingsBody = body;
        if (body.zaloGroupUrl !== undefined) publicConfigMock.zaloGroupUrl = body.zaloGroupUrl;
        if (body.zaloWidgetEnabled !== undefined)
          publicConfigMock.zaloWidgetEnabled = Boolean(body.zaloWidgetEnabled);
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' })
        };
      }
      if (url === '/api/admin/dashboard') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            stats: {},
            settings: { ...publicConfigMock },
            orders: [],
            users: [],
            dbStatus: { mode: 'local_json' }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(appJsContent, sandbox);

  const { loadAdminSettings, saveAdminSettings, applyZaloWidget } = sandbox.window;

  // -------------------------------------------------------------------------
  // 3.1 Test loadAdminSettings
  // -------------------------------------------------------------------------
  console.log('\n--- 3.1 Testing loadAdminSettings(settings) ---');
  {
    // Case 1: Custom active settings
    loadAdminSettings({
      zaloGroupUrl: 'https://zalo.me/g/alphabeta999',
      zaloWidgetEnabled: true,
      supportZalo: '0988776655'
    });
    assert.strictEqual(
      admZaloGroupUrl.value,
      'https://zalo.me/g/alphabeta999',
      'loadAdminSettings must set admZaloGroupUrl value'
    );
    assert.strictEqual(
      admZaloWidgetEnabled.checked,
      true,
      'loadAdminSettings must set admZaloWidgetEnabled checked to true'
    );
    assert.strictEqual(
      admSupportZalo.value,
      '0988776655',
      'loadAdminSettings must retain supportZalo value in admSupportZalo'
    );

    // Case 2: Custom disabled settings
    loadAdminSettings({
      zaloGroupUrl: '',
      zaloWidgetEnabled: false,
      supportZalo: '0123456789'
    });
    assert.strictEqual(admZaloGroupUrl.value, '', 'Empty group URL populated correctly');
    assert.strictEqual(
      admZaloWidgetEnabled.checked,
      false,
      'loadAdminSettings must set admZaloWidgetEnabled checked to false when disabled'
    );

    // Case 3: zaloWidgetEnabled omitted (defaults to true)
    loadAdminSettings({
      zaloGroupUrl: 'https://zalo.me/g/validgroup'
    });
    assert.strictEqual(
      admZaloWidgetEnabled.checked,
      true,
      'loadAdminSettings defaults zaloWidgetEnabled to true if omitted/undefined'
    );

    // Case 4: Null / undefined settings object
    loadAdminSettings(null);
    assert.strictEqual(admZaloGroupUrl.value, '', 'Null settings handled safely');

    console.log('  PASS: loadAdminSettings properly sets inputs, checkboxes, and handles defaults.');
  }

  // -------------------------------------------------------------------------
  // 3.2 Test saveAdminSettings & Payload Serialization
  // -------------------------------------------------------------------------
  console.log('\n--- 3.2 Testing saveAdminSettings() Serialization & API Payload ---');
  {
    admZaloGroupUrl.value = '   https://zalo.me/g/savedgroup123   ';
    admZaloWidgetEnabled.checked = true;
    admSupportZalo.value = '0911223344';

    await saveAdminSettings();

    assert.ok(lastSavedSettingsBody, 'Settings payload must be sent');
    assert.strictEqual(
      lastSavedSettingsBody.zaloGroupUrl,
      'https://zalo.me/g/savedgroup123',
      'zaloGroupUrl must be trimmed in saveAdminSettings payload'
    );
    assert.strictEqual(
      lastSavedSettingsBody.zaloWidgetEnabled,
      true,
      'zaloWidgetEnabled boolean must be correctly serialized as true'
    );
    assert.strictEqual(
      lastSavedSettingsBody.supportZalo,
      '0911223344',
      'supportZalo must be correctly serialized'
    );

    // Test saving with unchecked toggle
    admZaloWidgetEnabled.checked = false;
    await saveAdminSettings();
    assert.strictEqual(
      lastSavedSettingsBody.zaloWidgetEnabled,
      false,
      'zaloWidgetEnabled boolean must be correctly serialized as false when unchecked'
    );

    console.log('  PASS: saveAdminSettings accurately trims URLs and serializes boolean toggles.');
  }

  // -------------------------------------------------------------------------
  // 3.3 Test Live DOM Updates Without Full Page Reload
  // -------------------------------------------------------------------------
  console.log('\n--- 3.3 Testing Live DOM Reflection (Floating Button without Reload) ---');
  {
    // Scenario 1: Admin enables the widget with a valid URL -> Floating widget appears immediately
    admZaloGroupUrl.value = 'https://zalo.me/g/liveupdatecommunity';
    admZaloWidgetEnabled.checked = true;

    await saveAdminSettings();

    assert.strictEqual(
      floatingZaloWidget.classList.contains('hidden'),
      false,
      'floatingZaloWidget must NOT have class .hidden after enabling with valid URL'
    );
    assert.strictEqual(
      floatingZaloLink.href,
      'https://zalo.me/g/liveupdatecommunity',
      'floatingZaloLink href must be updated immediately'
    );

    // Scenario 2: Admin unchecks the toggle -> Floating widget is immediately hidden
    admZaloWidgetEnabled.checked = false;

    await saveAdminSettings();

    assert.strictEqual(
      floatingZaloWidget.classList.contains('hidden'),
      true,
      'floatingZaloWidget must immediately have class .hidden when widget is toggled off'
    );

    // Scenario 3: Admin re-enables toggle with valid link -> Widget is visible again
    admZaloWidgetEnabled.checked = true;
    admZaloGroupUrl.value = 'https://zalo.me/g/secondcommunity';

    await saveAdminSettings();

    assert.strictEqual(
      floatingZaloWidget.classList.contains('hidden'),
      false,
      'floatingZaloWidget must become visible again when re-enabled'
    );
    assert.strictEqual(
      floatingZaloLink.href,
      'https://zalo.me/g/secondcommunity',
      'floatingZaloLink href must update to new community link'
    );

    // Scenario 4: Admin sets an invalid domain -> Widget is safely hidden by client validation
    admZaloGroupUrl.value = 'https://malicious-site.com/group';
    admZaloWidgetEnabled.checked = true;

    await saveAdminSettings();

    assert.strictEqual(
      floatingZaloWidget.classList.contains('hidden'),
      true,
      'floatingZaloWidget must remain hidden when URL fails allowlist check (^https://zalo.me/)'
    );

    console.log('  PASS: Live DOM updates without reload successfully verified.');
  }

  // -------------------------------------------------------------------------
  // 3.4 Button Loading State During Save
  // -------------------------------------------------------------------------
  console.log('\n--- 3.4 Testing Button Disabled & Text States During Save ---');
  {
    let capturedStateDuringFetch = null;
    sandbox.fetch = async (url, opts = {}) => {
      if (url === '/api/admin/settings') {
        capturedStateDuringFetch = {
          disabled: saveAdminSettingsBtn.disabled,
          textContent: saveAdminSettingsBtn.textContent
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    };

    admZaloGroupUrl.value = 'https://zalo.me/g/buttontest';
    admZaloWidgetEnabled.checked = true;

    const savePromise = saveAdminSettings();
    await savePromise;

    assert.ok(capturedStateDuringFetch, 'Fetch was executed');
    assert.strictEqual(
      capturedStateDuringFetch.disabled,
      true,
      'Save button must be disabled while saving'
    );
    assert.strictEqual(
      capturedStateDuringFetch.textContent,
      'Đang lưu cấu hình...',
      'Save button must display loading text while saving'
    );
    assert.strictEqual(
      saveAdminSettingsBtn.disabled,
      false,
      'Save button must be re-enabled after save completes'
    );
    assert.strictEqual(
      saveAdminSettingsBtn.textContent,
      'Lưu Cấu Hình',
      'Save button text must be restored after save completes'
    );

    console.log('  PASS: Button loading and disabled states verified.');
  }

  console.log('\n======================================================');
  console.log('ALL TASK 13 ZALO ADMIN UI TESTS PASSED CLEANLY (100%)');
  console.log('======================================================\n');
}

runZaloAdminUiTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
