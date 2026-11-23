if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { encryptSettingsObject, decryptSettingsObject } = require('../src/utils/secretCrypto');
const logger = require('../src/utils/logger');
const {
  initPostgresIfConfigured,
  reloadStateFromPostgres,
  ensureDbLoaded,
  saveDb,
  hashPassword
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

    console.log('PASS: Security audit remediation verified (seedDb clean, TikTok secrets encrypted, logger redaction, XHR login cookie-only)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
