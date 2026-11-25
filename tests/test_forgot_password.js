process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = '';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const dbService = require('../src/services/dbService');
const mailService = require('../src/services/mailService');
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
  console.log('=== STARTING FORGOT PASSWORD (EMAIL OTP) & OPTIONAL EMAIL TESTS ===');

  const sentEmails = [];
  mailService.setMailTransportOverride(async (payload) => {
    sentEmails.push(payload);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Register WITHOUT email -> succeeds immediately (zero-friction)
    const regNoEmail = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ name: 'Fast User', phone: '0977111222', password: 'Password!123' })
    });
    assert.equal(regNoEmail.status, 200);
    const noEmailBody = await regNoEmail.json();
    assert.equal(noEmailBody.user.email, '');

    // 2. Register WITH optional email -> succeeds; duplicate email rejected
    const regWithEmail = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        name: 'Email User',
        phone: '0977333444',
        email: 'emailuser@example.com',
        password: 'OldPassword!123'
      })
    });
    assert.equal(regWithEmail.status, 200);
    const regCookies = getSetCookies(regWithEmail);
    const oldAuthCookie = extractCookieValue(regCookies, 'hts_auth');
    const oldRefreshCookie = extractCookieValue(regCookies, 'hts_refresh');

    const dupEmailRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        name: 'Dup User',
        phone: '0977555666',
        email: 'EMAILUSER@example.com',
        password: 'Password!123'
      })
    });
    assert.equal(dupEmailRes.status, 400);

    // 3. Anti-enumeration: unknown account still returns 200, sends 0 emails
    const unknownRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: '0999888777' })
    });
    assert.equal(unknownRes.status, 200);
    assert.equal(sentEmails.length, 0);

    // 4. Valid forgot-password sends 6-digit OTP
    const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: '0977333444' })
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, 'emailuser@example.com');
    assert.match(sentEmails[0].otpCode, /^\d{6}$/);
    const otp1 = sentEmails[0].otpCode;

    // 5. Wrong OTP 5 times locks the token
    const wrongOtp = otp1 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const badRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ identifier: '0977333444', otp: wrongOtp, newPassword: 'NewPassword!999' })
      });
      assert.equal(badRes.status, 400);
    }
    const lockedAttempt = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: '0977333444', otp: otp1, newPassword: 'NewPassword!999' })
    });
    assert.equal(lockedAttempt.status, 400, 'Locked OTP must reject even valid code after 5 failures');

    // 6. Request fresh OTP -> reset password -> old sessions revoked -> new password works
    const forgotRes2 = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: 'emailuser@example.com' })
    });
    assert.equal(forgotRes2.status, 200);
    assert.equal(sentEmails.length, 2);
    const otp2 = sentEmails[1].otpCode;

    const resetOk = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: 'emailuser@example.com', otp: otp2, newPassword: 'NewPassword!999' })
    });
    assert.equal(resetOk.status, 200);

    // Reusing consumed OTP must fail
    const reuseOtp = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: 'emailuser@example.com', otp: otp2, newPassword: 'AnotherPassword!1' })
    });
    assert.equal(reuseOtp.status, 400);

    // Old access token & old refresh token must be revoked
    const oldMe = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: `hts_auth=${encodeURIComponent(oldAuthCookie)}` }
    });
    assert.equal(oldMe.status, 401);
    const oldRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Cookie: `hts_refresh=${encodeURIComponent(oldRefreshCookie)}` }
    });
    assert.equal(oldRefresh.status, 401);

    // Login with new password succeeds
    const loginNew = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ identifier: '0977333444', password: 'NewPassword!999' })
    });
    assert.equal(loginNew.status, 200);
    const newAuthCookie = extractCookieValue(getSetCookies(loginNew), 'hts_auth');

    // 7. Changing email via /api/user/profile requires currentPassword
    const noPwdProfile = await fetch(`${baseUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_auth=${encodeURIComponent(newAuthCookie)}`
      },
      body: JSON.stringify({ email: 'updated@example.com' })
    });
    assert.equal(noPwdProfile.status, 400);

    const okProfile = await fetch(`${baseUrl}/api/user/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: `hts_auth=${encodeURIComponent(newAuthCookie)}`
      },
      body: JSON.stringify({ email: 'updated@example.com', currentPassword: 'NewPassword!999' })
    });
    assert.equal(okProfile.status, 200);
    assert.equal((await okProfile.json()).user.email, 'updated@example.com');

    // 8. Expiry check (>10 min)
    const userObj = dbService.ensureDbLoaded().users.find((u) => u.phone === '0977333444');
    const tNow = Date.now();
    const expTok = await dbService.createPasswordResetOtp(userObj, { ttlSec: 600, nowMs: tNow });
    const expVerify = await dbService.verifyAndConsumePasswordResetOtp(userObj.id, expTok.otpCode, {
      nowMs: tNow + 601 * 1000
    });
    assert.equal(expVerify.ok, false);
    assert.equal(expVerify.reason, 'EXPIRED');

    // 9. Frontend UI checks
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="openForgotPwdBtn"'));
    assert.ok(indexHtml.includes('id="forgotPasswordBox"'));
    assert.ok(indexHtml.includes('id="forgotZaloSupportBtn"'));
    assert.ok(indexHtml.includes('id="regEmail"'));
    assert.ok(indexHtml.includes('id="accProfileEmail"'));
    assert.ok(indexHtml.includes('id="admResendApiKey"'));

    console.log('PASS: Forgot password (Email OTP + rate/attempts/expiry/revocation), optional email, and UI verified.');
  } finally {
    mailService.setMailTransportOverride(null);
    server.close();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
