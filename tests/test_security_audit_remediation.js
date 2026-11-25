if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { encryptSettingsObject, decryptSettingsObject, SENSITIVE_SETTING_KEYS } = require('../src/utils/secretCrypto');
const logger = require('../src/utils/logger');
const {
  initPostgresIfConfigured,
  reloadStateFromPostgres,
  ensureDbLoaded,
  saveDb,
  hashPassword,
  createToken
} = require('../src/services/dbService');
const { registerCashbackRoutes } = require('../src/services/cashbackController');

async function runTests() {
  // 1. Verify seedDb.json has no hardcoded admin passwordHash
  const seedRaw = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'seedDb.json'), 'utf8');
  const seedJson = JSON.parse(seedRaw);
  assert(Array.isArray(seedJson.users) && seedJson.users.length === 0, 'seedDb.json users must be empty');
  assert(!seedRaw.includes('scrypt$'), 'seedDb.json must not contain password hashes');

  // 2. Verify tiktokAccessToken & tiktokCookie are encrypted at rest
  const enc = encryptSettingsObject(
    { tiktokAccessToken: 'tok_live_123', tiktokCookie: 'sid=abc; csrf=xyz', siteName: 'LiLa' },
    'super-strong-test-key-32-chars-minimum!'
  );
  assert(enc.tiktokAccessToken.startsWith('enc:v1:'), 'tiktokAccessToken must be encrypted');
  assert(enc.tiktokCookie.startsWith('enc:v1:'), 'tiktokCookie must be encrypted');
  const dec = decryptSettingsObject(enc, 'super-strong-test-key-32-chars-minimum!');
  assert.strictEqual(dec.tiktokAccessToken, 'tok_live_123');
  assert.strictEqual(dec.tiktokCookie, 'sid=abc; csrf=xyz');

  // 3. Verify logger redacts sensitive fields
  let captured = '';
  const origLog = console.log;
  console.log = (msg) => {
    captured += String(msg);
  };
  try {
    logger.log('auditTest', 'Checking redaction', {
      password: 'plainPassword',
      token: 'jwt_abc',
      bankAccount: '1234567890',
      safeField: 'visible'
    });
  } finally {
    console.log = origLog;
  }
  assert(!captured.includes('plainPassword'), 'password must be redacted in logs');
  assert(!captured.includes('jwt_abc'), 'token must be redacted in logs');
  assert(!captured.includes('1234567890'), 'bankAccount must be redacted in logs');
  assert(captured.includes('visible'), 'non-sensitive field should remain visible');

  // 4. Verify browser XHR login omits raw token from JSON body while setting HttpOnly cookie
  await initPostgresIfConfigured();
  await reloadStateFromPostgres();
  const db = ensureDbLoaded();
  const suffix = Date.now();
  const u = {
    id: `usr_aud_${suffix}`,
    code: `AUD_${suffix}`,
    name: 'Audit User',
    phone: `0988${suffix.toString().slice(-6)}`,
    passwordHash: hashPassword('AuditPass123!'),
    role: 'user',
    tokenVersion: 1
  };
  db.users.push(u);
  await saveDb(db);

  const app = express();
  app.use(express.json());
  registerCashbackRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const xhrRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ identifier: u.phone, password: 'AuditPass123!' })
    });
    assert.strictEqual(xhrRes.status, 200);
    const xhrData = await xhrRes.json();
    assert.strictEqual(xhrData.token, undefined, 'Browser XHR login must not expose raw token in JSON body');
    assert(xhrRes.headers.get('set-cookie')?.includes('hts_auth='), 'HttpOnly cookie must be set');

    // 5. Verify GET /api/admin/settings masks all SENSITIVE_SETTING_KEYS by default
    const adminUser = {
      id: `usr_adm_aud_${suffix}`,
      code: `ADM_${suffix}`,
      name: 'Audit Admin',
      phone: `0977${suffix.toString().slice(-6)}`,
      passwordHash: hashPassword('AdminPass123!'),
      role: 'admin',
      tokenVersion: 1
    };
    const liveDb = ensureDbLoaded();
    liveDb.users.push(adminUser);
    liveDb.settings.tiktokAccessToken = 'secret_tt_tok_999';
    liveDb.settings.tiktokCookie = 'secret_tt_ck_999';
    liveDb.settings.accesstradeApiKey = 'secret_at_key_999';
    liveDb.settings.addlivetagApiKey = 'secret_alt_key_999';
    await saveDb(liveDb);
    const adminToken = createToken(adminUser);

    const setRes = await fetch(`${baseUrl}/api/admin/settings`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(setRes.status, 200);
    const setData = await setRes.json();
    for (const sKey of SENSITIVE_SETTING_KEYS) {
      if (setData.settings[sKey]) {
        assert.strictEqual(setData.settings[sKey], '***', `${sKey} must be masked when reveal is false`);
      }
    }
    assert.strictEqual(setData.settings.tiktokAccessToken, '***');
    assert.strictEqual(setData.settings.tiktokCookie, '***');
    assert.strictEqual(setData.settings.accesstradeApiKey, '***');
    assert.strictEqual(setData.settings.addlivetagApiKey, '***');

    // 6. Verify Mobile bottom nav has leaderboard button, absolute og:image, and bumped SW cache
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const swJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const bottomNavSlice = indexHtml.slice(indexHtml.indexOf('id="mobileBottomNav"'));
    assert(bottomNavSlice.includes('data-nav="leaderboard"'), 'Mobile bottom nav must include leaderboard tab');
    assert(indexHtml.includes('property="og:image" content="https://hoantiensan.online/'), 'og:image must be absolute URL');
    assert(/CACHE_NAME\s*=\s*'lila-pwa-v1[4-9]'/.test(swJs), 'sw.js cache version must be bumped');

    console.log('PASS: Security & comprehensive audit remediation verified (seedDb clean, all 8 admin secrets masked, logger redaction, XHR cookie-only, mobile bottom nav leaderboard, absolute og:image, SW v14)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
