/**
 * Test Suite: Zalo Utility Module, Allowlist Validation & Settings API
 * Verifies Task 11 requirements (Giai đoạn 0 & 1)
 */

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const assert = require('assert');
const express = require('express');
const http = require('http');
const {
  DEFAULT_ZALO_GROUP_URL,
  isValidZaloGroupUrl,
  normalizeZaloTarget,
  migrateZaloSettings
} = require('../src/utils/zalo');
const {
  ensureDbLoaded,
  saveDb,
  createToken,
  initPostgresIfConfigured
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

async function runTests() {
  console.log('=== STARTING ZALO UTILITY & ALLOWLIST TEST SUITE ===\n');

  // ----------------------------------------------------
  // 1. Unit Tests: isValidZaloGroupUrl
  // ----------------------------------------------------
  console.log('--- 1. Testing isValidZaloGroupUrl ---');

  // Valid URLs
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me/g/cl2cmiseoqienusnrbyr'),
    true,
    'Valid default Zalo group URL must pass'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://chat.zalo.me/g/subgroup123'),
    true,
    'Valid Zalo subdomain group URL must pass'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('   https://zalo.me/g/cl2cmiseoqienusnrbyr   '),
    true,
    'Trimmed valid URL must pass'
  );
  console.log('  PASS: Valid Zalo group URLs accepted.');

  // Rejection of http
  assert.strictEqual(
    isValidZaloGroupUrl('http://zalo.me/g/cl2cmiseoqienusnrbyr'),
    false,
    'http protocol must be rejected'
  );
  console.log('  PASS: Insecure http protocol rejected.');

  // Rejection of spoof / bypass domains
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me.evil.com/g/123'),
    false,
    'zalo.me.evil.com must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://evil.com/zalo.me'),
    false,
    'evil.com/zalo.me must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me@evil.com'),
    false,
    'https://zalo.me@evil.com userinfo spoof must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me@evil.com/g/123'),
    false,
    'https://zalo.me@evil.com/g/123 must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://notzalo.me/g/123'),
    false,
    'notzalo.me must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://fake-zalo.me/g/123'),
    false,
    'fake-zalo.me must be rejected'
  );
  console.log('  PASS: Spoof domains & userinfo spoofing strictly rejected.');

  // Rejection of script / pseudo protocols
  assert.strictEqual(
    isValidZaloGroupUrl('javascript:alert(1)'),
    false,
    'javascript: scheme must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('data:text/html,<script>alert(1)</script>'),
    false,
    'data: scheme must be rejected'
  );
  console.log('  PASS: javascript: and data: schemes strictly rejected.');

  // Rejection of invalid inputs, lengths & malformed URLs
  assert.strictEqual(isValidZaloGroupUrl(''), false, 'Empty string must be rejected');
  assert.strictEqual(isValidZaloGroupUrl('   '), false, 'Whitespace only must be rejected');
  assert.strictEqual(isValidZaloGroupUrl(null), false, 'null must be rejected');
  assert.strictEqual(isValidZaloGroupUrl(undefined), false, 'undefined must be rejected');
  assert.strictEqual(isValidZaloGroupUrl(12345), false, 'Number must be rejected');
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me/' + 'a'.repeat(260)),
    false,
    'URL longer than 255 characters must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://admin:secret@zalo.me/g/123'),
    false,
    'URL with credentials must be rejected'
  );
  assert.strictEqual(
    isValidZaloGroupUrl('https://zalo.me:8080/g/123'),
    false,
    'Non-standard port must be rejected'
  );
  console.log('  PASS: Non-string, oversized, and malformed inputs rejected.');

  // ----------------------------------------------------
  // 2. Unit Tests: normalizeZaloTarget
  // ----------------------------------------------------
  console.log('\n--- 2. Testing normalizeZaloTarget ---');
  assert.strictEqual(
    normalizeZaloTarget('   https://zalo.me/g/cl2cmiseoqienusnrbyr   '),
    'https://zalo.me/g/cl2cmiseoqienusnrbyr',
    'Should return trimmed valid URL'
  );
  assert.strictEqual(
    normalizeZaloTarget('http://zalo.me/g/test'),
    '',
    'Should return empty string for invalid URL'
  );
  assert.strictEqual(
    normalizeZaloTarget('javascript:alert(1)'),
    '',
    'Should return empty string for javascript: URI'
  );
  assert.strictEqual(
    normalizeZaloTarget(null),
    '',
    'Should return empty string for non-string'
  );
  console.log('  PASS: normalizeZaloTarget returns trimmed target or empty string.');

  // ----------------------------------------------------
  // 3. Unit Tests: migrateZaloSettings
  // ----------------------------------------------------
  console.log('\n--- 3. Testing migrateZaloSettings ---');
  const dummyDb1 = {
    settings: {
      supportZalo: 'https://zalo.me/g/legacygroup123',
      zaloGroupUrl: ''
    }
  };
  migrateZaloSettings(dummyDb1);
  assert.strictEqual(
    dummyDb1.settings.zaloGroupUrl,
    'https://zalo.me/g/legacygroup123',
    'Legacy supportZalo group link should be migrated to zaloGroupUrl'
  );

  const dummyDb2 = {
    settings: {
      supportZalo: 'https://zalo.me/g/legacygroup123',
      zaloGroupUrl: 'https://zalo.me/g/alreadyconfigured'
    }
  };
  migrateZaloSettings(dummyDb2);
  assert.strictEqual(
    dummyDb2.settings.zaloGroupUrl,
    'https://zalo.me/g/alreadyconfigured',
    'Existing zaloGroupUrl must not be overwritten'
  );

  const dummyDb3 = {
    settings: {
      supportZalo: '0988123456',
      zaloGroupUrl: ''
    }
  };
  migrateZaloSettings(dummyDb3);
  assert.strictEqual(
    dummyDb3.settings.zaloGroupUrl,
    '',
    'Non-group supportZalo should not be migrated to zaloGroupUrl'
  );
  console.log('  PASS: Auto-migration logic operates correctly.');

  // ----------------------------------------------------
  // 4. Integration Tests: Express API Endpoints
  // ----------------------------------------------------
  console.log('\n--- 4. Testing API Endpoints (Public Config & Admin Settings) ---');
  await initPostgresIfConfigured();
  const db = ensureDbLoaded();
  const originalZaloGroupUrl = db.settings.zaloGroupUrl;
  const originalZaloWidgetEnabled = db.settings.zaloWidgetEnabled;

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 4.1 GET /api/public-config
    const publicRes = await fetch(`${baseUrl}/api/public-config`);
    assert.strictEqual(publicRes.status, 200, 'GET /api/public-config should return 200');
    const publicData = await publicRes.json();
    assert.ok(publicData.zaloGroupUrl, 'zaloGroupUrl must be exposed in public config');
    assert.strictEqual(
      typeof publicData.zaloWidgetEnabled,
      'boolean',
      'zaloWidgetEnabled must be a boolean'
    );
    console.log('  PASS: GET /api/public-config exposes zaloGroupUrl and zaloWidgetEnabled.');

    // 4.2 GET /api/settings
    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    assert.strictEqual(settingsRes.status, 200, 'GET /api/settings should return 200');
    const settingsData = await settingsRes.json();
    assert.strictEqual(
      settingsData.zaloGroupUrl,
      publicData.zaloGroupUrl,
      'GET /api/settings must match public config'
    );
    console.log('  PASS: GET /api/settings exposes identical configuration.');

    // 4.3 Setup Admin Token
    const adminUser = db.users.find((u) => u.role === 'admin') || {
      id: 'usr_admin',
      role: 'admin',
      tokenVersion: 1
    };
    const adminToken = createToken(adminUser);

    // 4.4 POST /api/admin/settings rejecting invalid URLs with 400
    const invalidAttempts = [
      'http://zalo.me/g/cl2cmiseoqienusnrbyr',
      'https://zalo.me.evil.com/g/123',
      'https://evil.com/zalo.me',
      'https://zalo.me@evil.com',
      'javascript:alert(1)'
    ];

    for (const badUrl of invalidAttempts) {
      const res = await fetch(`${baseUrl}/api/admin/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({ zaloGroupUrl: badUrl })
      });
      assert.strictEqual(
        res.status,
        400,
        `Expected 400 rejection for invalid URL: ${badUrl}, got ${res.status}`
      );
      const json = await res.json();
      assert.ok(json.error, 'Error message must be returned on rejection');
    }
    console.log('  PASS: POST /api/admin/settings rejected all invalid Zalo URLs with 400.');

    // 4.5 POST /api/admin/settings saving valid URL & updating widget enabled
    const customValidUrl = 'https://zalo.me/g/customtestgroup456';
    const updateRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        zaloGroupUrl: customValidUrl,
        zaloWidgetEnabled: false
      })
    });
    assert.strictEqual(updateRes.status, 200, 'POST /api/admin/settings should return 200 for valid data');
    const updateJson = await updateRes.json();
    assert.strictEqual(updateJson.status, 'ok', 'Status should be ok');

    // 4.6 Verify GET /api/public-config returns updated values
    const verifyRes = await fetch(`${baseUrl}/api/public-config`);
    const verifyData = await verifyRes.json();
    assert.strictEqual(
      verifyData.zaloGroupUrl,
      customValidUrl,
      'Public config should reflect newly saved zaloGroupUrl'
    );
    assert.strictEqual(
      verifyData.zaloWidgetEnabled,
      false,
      'Public config should reflect updated zaloWidgetEnabled: false'
    );
    console.log('  PASS: Saved valid URL and widget status verified in GET /api/public-config.');

    // 4.7 Re-enable widget and verify
    const reenableRes = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        zaloWidgetEnabled: true
      })
    });
    assert.strictEqual(reenableRes.status, 200);
    const reenableData = await (await fetch(`${baseUrl}/api/public-config`)).json();
    assert.strictEqual(reenableData.zaloWidgetEnabled, true, 'Widget should be re-enabled');
    console.log('  PASS: Re-enabling widget verified in public config.');

  } finally {
    db.settings.zaloGroupUrl =
      originalZaloGroupUrl && originalZaloGroupUrl !== 'https://zalo.me/g/customtestgroup456'
        ? originalZaloGroupUrl
        : DEFAULT_ZALO_GROUP_URL;
    db.settings.zaloWidgetEnabled =
      originalZaloWidgetEnabled !== undefined ? originalZaloWidgetEnabled : true;
    await saveDb(db);
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n=== ALL ZALO TEST SUITES PASSED CLEANLY! ===\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
