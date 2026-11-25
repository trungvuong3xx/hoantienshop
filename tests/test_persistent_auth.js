process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const dbService = require('../src/services/dbService');
const app = require('../server');

function extractCookieValue(setCookieHeaders, name) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
  for (const header of list) {
    const m = String(header).match(new RegExp(`^${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return '';
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function run() {
  console.log('=== STARTING PERSISTENT AUTH & ROTATING REFRESH SESSION TESTS ===');

  const db = dbService.ensureDbLoaded();
  const phone = '0988777666';
  const password = 'PersistentAuth!123';
  const passwordHash = await dbService.hashPasswordAsync(password);
  const testUser = {
    id: 'usr_persist_test_' + Date.now(),
    code: 'UPERSIST1',
    name: 'Persistent Test User',
    phone,
    email: 'persist@example.com',
    passwordHash,
    role: 'user',
    tokenVersion: 1,
    balanceAvailable: 0,
    balancePending: 0,
    totalEarned: 0,
    totalWithdrawn: 0
  };
  db.users.push(testUser);
  await dbService.saveDb(db);

  // 1. Verify session policies for user vs admin
  const userPolicy = dbService.getSessionPolicy({ role: 'user' });
  assert.equal(userPolicy.accessTtlSec, 3600);
  assert.equal(userPolicy.idleTtlSec, 30 * 24 * 3600);
  assert.equal(userPolicy.absTtlSec, 90 * 24 * 3600);

  const adminPolicy = dbService.getSessionPolicy({ role: 'admin' });
  assert.equal(adminPolicy.accessTtlSec, 1800);
  assert.equal(adminPolicy.idleTtlSec, 7 * 24 * 3600);
  assert.equal(adminPolicy.absTtlSec, 14 * 24 * 3600);
  console.log('PASS: Session TTL policies (user 1h/30d/90d, admin 30m/7d/14d) verified.');

  // 2. Time-jump simulation: 1h, 6h, 24h, 3d, 7d, 29d, >30d idle, >90d absolute
  const t0 = Date.now();
  const sess = await dbService.createRefreshSession(testUser, { nowMs: t0, userAgent: 'MobileSafari' });
  let currentToken = sess.rawRefreshToken;
  let cursor = t0;
  for (const jumpDays of [1 / 24, 6 / 24, 1, 3, 7, 29]) {
    cursor += Math.round(jumpDays * 24 * 3600 * 1000);
    const rot = await dbService.rotateRefreshSession(currentToken, { nowMs: cursor });
    assert.equal(rot.ok, true, `Rotation after +${jumpDays} days must succeed`);
    assert.ok(rot.rawRefreshToken && rot.rawRefreshToken !== currentToken, 'Must issue rotated refresh token');
    currentToken = rot.rawRefreshToken;
  }

  // Idle expiry (>30 days without activity)
  const idleExpired = await dbService.rotateRefreshSession(currentToken, {
    nowMs: cursor + 30 * 24 * 3600 * 1000 + 1000
  });
  assert.equal(idleExpired.ok, false);
  assert.equal(idleExpired.reason, 'EXPIRED');

  // Absolute expiry (>90 days even with continuous activity)
  const sessAbs = await dbService.createRefreshSession(testUser, { nowMs: t0 });
  let tokAbs = sessAbs.rawRefreshToken;
  for (const day of [25, 50, 75, 89]) {
    const r = await dbService.rotateRefreshSession(tokAbs, { nowMs: t0 + day * 24 * 3600 * 1000 });
    assert.equal(r.ok, true);
    tokAbs = r.rawRefreshToken;
  }
  const pastAbs = await dbService.rotateRefreshSession(tokAbs, { nowMs: t0 + 90 * 24 * 3600 * 1000 + 1000 });
  assert.equal(pastAbs.ok, false);
  assert.equal(pastAbs.reason, 'EXPIRED');
  console.log('PASS: 1h/6h/24h/3d/7d/29d sliding refresh, 30d idle cap, and 90d absolute cap verified.');

  // 3. Multi-tab grace window & token reuse detection
  const sessRace = await dbService.createRefreshSession(testUser, { nowMs: t0 });
  const r1 = sessRace.rawRefreshToken;
  const tabA = await dbService.rotateRefreshSession(r1, { nowMs: t0 + 1000 });
  assert.equal(tabA.ok, true);
  assert.equal(tabA.graceReuse, false);
  const r2 = tabA.rawRefreshToken;

  // Tab B arrives 2s later with r1 (within 15s grace window) -> succeeds safely without revoking r2
  const tabB = await dbService.rotateRefreshSession(r1, { nowMs: t0 + 3000 });
  assert.equal(tabB.ok, true);
  assert.equal(tabB.graceReuse, true);

  // Attacker replays r1 after grace window (20s later) -> REUSE_DETECTED & revokes r2 too
  const replay = await dbService.rotateRefreshSession(r1, { nowMs: t0 + 21000 });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'REUSE_DETECTED');
  const victimAttempt = await dbService.rotateRefreshSession(r2, { nowMs: t0 + 22000 });
  assert.equal(victimAttempt.ok, false);
  assert.equal(victimAttempt.reason, 'REVOKED');
  console.log('PASS: Multi-tab 15s grace window and post-grace reuse family revocation verified.');

  // 4. HTTP endpoints: login, refresh, CSRF guard, single-device logout, logout-all, password change
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Login on Device A & Device B
    const loginA = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: phone, password })
    });
    assert.equal(loginA.status, 200);
    const cookiesA = getSetCookies(loginA);
    const authA = extractCookieValue(cookiesA, 'hts_auth');
    const refreshA = extractCookieValue(cookiesA, 'hts_refresh');
    assert.ok(authA && refreshA, 'Login must set both hts_auth and hts_refresh cookies');
    assert.ok(cookiesA.some((c) => c.includes('hts_refresh=') && c.includes('Path=/api/auth') && c.includes('HttpOnly')));

    const loginB = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: phone, password })
    });
    assert.equal(loginB.status, 200);
    const cookiesB = getSetCookies(loginB);
    const refreshB = extractCookieValue(cookiesB, 'hts_refresh');

    // CSRF guard blocks cross-origin POST /api/auth/refresh
    const csrfBlocked = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Cookie: `hts_refresh=${encodeURIComponent(refreshA)}`
      },
      body: '{}'
    });
    assert.equal(csrfBlocked.status, 403);

    // Legitimate refresh rotates refreshA -> refreshA2 and returns fresh hts_auth
    const refreshResA = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_refresh=${encodeURIComponent(refreshA)}`
      },
      body: '{}'
    });
    assert.equal(refreshResA.status, 200);
    const newCookiesA = getSetCookies(refreshResA);
    const authA2 = extractCookieValue(newCookiesA, 'hts_auth');
    const refreshA2 = extractCookieValue(newCookiesA, 'hts_refresh');
    assert.ok(authA2 && refreshA2 && refreshA2 !== refreshA);

    // Fresh access token works on /api/user/me
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: `hts_auth=${encodeURIComponent(authA2)}` }
    });
    assert.equal(meRes.status, 200);

    // Single-device logout on Device A revokes Device A, leaves Device B intact
    const logoutA = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_auth=${encodeURIComponent(authA2)}; hts_refresh=${encodeURIComponent(refreshA2)}`
      }
    });
    assert.equal(logoutA.status, 200);

    const retryA = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_refresh=${encodeURIComponent(refreshA2)}`
      }
    });
    assert.equal(retryA.status, 401, 'Logged-out Device A refresh token must fail');

    const refreshResB = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_refresh=${encodeURIComponent(refreshB)}`
      }
    });
    assert.equal(refreshResB.status, 200, 'Device B must stay logged in after Device A logs out');
    const refreshB2 = extractCookieValue(getSetCookies(refreshResB), 'hts_refresh');
    const authB2 = extractCookieValue(getSetCookies(refreshResB), 'hts_auth');

    // Logout-all revokes Device B across all sessions
    const logoutAllRes = await fetch(`${baseUrl}/api/auth/logout-all`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_auth=${encodeURIComponent(authB2)}; hts_refresh=${encodeURIComponent(refreshB2)}`
      }
    });
    assert.equal(logoutAllRes.status, 200);

    const retryB = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_refresh=${encodeURIComponent(refreshB2)}`
      }
    });
    assert.equal(retryB.status, 401, 'Logout-all must revoke all sessions');
    console.log('PASS: HTTP login, refresh rotation, CSRF guard, single-device logout, and logout-all verified.');

    // 5. Frontend integration checks
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(appJs.includes('function refreshAuthSession()'), 'app.js must define refreshAuthSession');
    assert.ok(appJs.includes('_retriedAfterRefresh'), 'apiFetch must retry once after silent refresh');
    assert.ok(appJs.includes('visibilitychange'), 'app.js must refresh when tab becomes visible');
    assert.ok(appJs.includes('logoutAllDevicesBtn'), 'app.js must bind logoutAllDevicesBtn');
    assert.ok(indexHtml.includes('id="logoutAllDevicesBtn"'), 'index.html must include logoutAllDevicesBtn');
    console.log('PASS: Frontend silent auto-refresh, multi-tab sync, and logout-all UI verified.');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
