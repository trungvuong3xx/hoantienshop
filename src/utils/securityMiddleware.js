const logger = require('./logger');
const { getRedisConfig } = require('./runtimeConfig');

const rateBuckets = new Map();

// Startup security audit for production environments
if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    logger.error(
      'SecurityStartupAudit',
      'TURNSTILE_SECRET_KEY is missing in production environment!'
    );
  }
  const redis = getRedisConfig();
  if (!redis.url || !redis.token) {
    logger.warning(
      'SecurityStartupAudit',
      'UPSTASH_REDIS_REST_URL / TOKEN not configured; distributed rate limiting is inactive.'
    );
  }
}

function getClientIp(req) {
  // Express resolves req.ip using the configured trust-proxy boundary.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Rate limiter middleware supporting Upstash Redis REST (serverless-safe).
 * When failClosed=true (auth & withdrawal routes), Redis errors reject the request (503) instead of falling back to RAM.
 */
function createRateLimiter({
  windowMs = 60000,
  max = 30,
  keyPrefix = 'rl',
  failClosed = false,
  keyGenerator = getClientIp
} = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${keyGenerator(req)}`;
    const now = Date.now();

    const redis = getRedisConfig();
    const hasUpstash = Boolean(redis.url && redis.token);

    if (hasUpstash) {
      try {
        const upstashUrl = `${redis.url.replace(/\/$/, '')}/pipeline`;
        const ttlSec = Math.ceil(windowMs / 1000);
        const resp = await fetch(upstashUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${redis.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([
            ['INCR', key],
            ['EXPIRE', key, ttlSec, 'NX']
          ]),
          signal: AbortSignal.timeout(1500)
        });
        if (!resp.ok) {
          throw new Error(`Upstash HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const count = Number(data?.[0]?.result);
        if (!Array.isArray(data) || data.some(entry => entry.error) || !Number.isSafeInteger(count) || count < 1) {
          throw new Error('Invalid rate-limit response');
        }
        if (count > max) {
          logger.warning('rateLimitMiddleware', 'Rate limit exceeded (Upstash)', { ip, keyPrefix });
          return res.status(429).json({
            error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.'
          });
        }
        return next();
      } catch (err) {
        logger.error('rateLimitMiddleware', 'Upstash Redis error', {
          keyPrefix,
          failClosed,
          error: err.message
        });
        if (failClosed) {
          return res.status(503).json({
            error: 'Hệ thống kiểm soát bảo mật đang tạm gián đoạn. Vui lòng thử lại sau ít giây.'
          });
        }
      }
    } else if (failClosed && (process.env.STRICT_PRODUCTION_SECURITY === 'true' || process.env.NODE_ENV === 'production' || process.env.VERCEL)) {
      logger.error('rateLimitMiddleware', 'Fail-closed route blocked: Upstash Redis not configured', {
        keyPrefix
      });
      return res.status(503).json({
        error: 'Hệ thống chưa cấu hình bộ giới hạn tốc độ phân tán (Upstash Redis).'
      });
    }

    // Memory sliding window (used for local dev or non-critical routes when Upstash is not set)
    const MAX_STORE_SIZE = 10000;
    if (!rateBuckets.has(key) && rateBuckets.size >= MAX_STORE_SIZE) {
      for (const [k, b] of rateBuckets.entries()) {
        if (now > b.resetAt) rateBuckets.delete(k);
        if (rateBuckets.size < MAX_STORE_SIZE) break;
      }
      if (rateBuckets.size >= MAX_STORE_SIZE) {
        const oldestKey = rateBuckets.keys().next().value;
        if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
      }
    }
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);

    if (bucket.count > max) {
      logger.warning('rateLimitMiddleware', 'Rate limit exceeded', { ip, keyPrefix });
      return res.status(429).json({
        error: 'Bạn thao tác quá nhanh. Vui lòng đợi 1 phút rồi thử lại.'
      });
    }
    return next();
  };
}

/**
 * Verify Cloudflare Turnstile token safely (prevents self-lockout when only secret key exists without siteKey).
 */
async function verifyTurnstileIfEnabled(turnstileToken, remoteIp, options = {}) {
  const settings = options?.settings || {};
  const rawSecret = (process.env.TURNSTILE_SECRET_KEY || settings.turnstileSecretKey || '').trim();
  const secret = rawSecret && rawSecret !== '***' ? rawSecret : '';
  const siteKey = (process.env.TURNSTILE_SITE_KEY || settings.turnstileSiteKey || '').trim();
  const forceEnforceInTest = process.env.ENFORCE_TURNSTILE_IN_TEST === 'true';

  if (process.env.NODE_ENV === 'test' && !forceEnforceInTest) {
    return true;
  }

  const explicitRequire = process.env.REQUIRE_TURNSTILE === 'true';
  if (!secret) {
    if (explicitRequire || siteKey) {
      logger.error(
        'verifyTurnstileIfEnabled',
        'Fail-closed: TURNSTILE_SITE_KEY / REQUIRE_TURNSTILE is set but TURNSTILE_SECRET_KEY is missing!'
      );
      return false;
    }
    return true;
  }

  // Prevent accidental lockout when secretKey is present without a siteKey on frontend
  if (!siteKey && !turnstileToken && !explicitRequire) {
    logger.warning(
      'verifyTurnstileIfEnabled',
      'TURNSTILE_SECRET_KEY configured without TURNSTILE_SITE_KEY; skipping verification to prevent login lockout'
    );
    return true;
  }

  if (!turnstileToken) return false;

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: turnstileToken,
        remoteip: remoteIp
      }),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.success);
  } catch (err) {
    logger.error('verifyTurnstileIfEnabled', 'Turnstile verification network error (failing closed)', {
      error: err.message
    });
    return false;
  }
}

/**
 * Generate VietQR quick transfer image URL for Admin payout.
 */
function buildVietQrImageUrl(bankName = '', bankAccount = '', amount = 0, bankOwner = '', addInfo = '') {
  if (!bankAccount || !bankName) return '';
  const normBank = String(bankName)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/bank$/, '');

  const bankMap = {
    vcb: 'VCB',
    vietcombank: 'VCB',
    mb: 'MB',
    mbbank: 'MB',
    tcb: 'TCB',
    techcombank: 'TCB',
    acb: 'ACB',
    bidv: 'BIDV',
    vietin: 'ICB',
    vietinbank: 'ICB',
    icb: 'ICB',
    vp: 'VPB',
    vpbank: 'VPB',
    tp: 'TPB',
    tpbank: 'TPB',
    agri: 'VBA',
    agribank: 'VBA',
    stb: 'STB',
    sacombank: 'STB',
    vib: 'VIB',
    hdb: 'HDB',
    hdbank: 'HDB',
    shb: 'SHB',
    ocb: 'OCB',
    msb: 'MSB',
    seabank: 'SEAB',
    cake: 'CAKE',
    timo: 'TIMO'
  };

  const binCode = bankMap[normBank] || String(bankName).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!binCode || binCode === 'MOMO') return '';

  const url = new URL(`https://img.vietqr.io/image/${binCode}-${encodeURIComponent(bankAccount.trim())}-compact2.png`);
  if (amount > 0) url.searchParams.set('amount', String(Math.round(amount)));
  if (addInfo) url.searchParams.set('addInfo', addInfo);
  if (bankOwner) url.searchParams.set('accountName', bankOwner);
  return url.toString();
}

/**
 * CSRF protection middleware for state-changing /api/* routes authenticated via cookies.
 */
function createCsrfGuard({ allowedOrigins = [] } = {}) {
  const defaultSafeOrigins = [
    'https://hoantiensan.online',
    'https://www.hoantiensan.online',
    'https://hoantienshop.vercel.app',
    'http://localhost:3456',
    'http://127.0.0.1:3456'
  ];
  const envOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];
  const originWhitelist = new Set([
    ...defaultSafeOrigins,
    ...envOrigins,
    ...(Array.isArray(allowedOrigins) ? allowedOrigins : [])
  ]);

  function isOriginPermitted(candidateOrigin, req) {
    if (!candidateOrigin || candidateOrigin === 'null') return false;
    if (
      originWhitelist.has(candidateOrigin) ||
      /^https:\/\/hoantienshop(-[a-z0-9-]+)?\.vercel\.app$/i.test(candidateOrigin)
    ) {
      return true;
    }
    try {
      const parsedOrigin = new URL(candidateOrigin);
      const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0]
        .trim();
      return Boolean(reqHost && parsedOrigin.host === reqHost);
    } catch {
      return false;
    }
  }

  return function csrfGuardMiddleware(req, res, next) {
    if (req._csrfVerified) {
      return next();
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next();
    }

    const fullPath = req.originalUrl || req.path || '';
    if (!fullPath.startsWith('/api/') || fullPath.startsWith('/api/webhooks/')) {
      return next();
    }

    const rawCookie = req.headers.cookie || '';
    const hasAuthCookie = /(?:^|;\s*)(?:hts_auth|hts_refresh)=([^;]+)/.test(rawCookie);
    if (!hasAuthCookie) {
      return next();
    }

    const originHeader = req.headers.origin;
    if (originHeader) {
      if (!isOriginPermitted(originHeader, req)) {
        logger.warning('csrfGuardMiddleware', 'Rejected cross-origin cookie request', {
          origin: originHeader,
          path: fullPath
        });
        return res.status(403).json({
          error: 'Yêu cầu bị từ chối do nguồn gốc (Origin) không hợp lệ (CSRF Blocked).'
        });
      }
    } else if (req.headers.referer) {
      let refererOrigin = '';
      try {
        refererOrigin = new URL(String(req.headers.referer)).origin;
      } catch {
        refererOrigin = '';
      }
      if (!isOriginPermitted(refererOrigin, req)) {
        logger.warning('csrfGuardMiddleware', 'Rejected cross-referer cookie request', {
          referer: req.headers.referer,
          path: fullPath
        });
        return res.status(403).json({
          error: 'Yêu cầu bị từ chối do nguồn tham chiếu (Referer) không hợp lệ (CSRF Blocked).'
        });
      }
    }

    const hasBearerAuth = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
    if (!hasBearerAuth && !req.headers['x-requested-with']) {
      logger.warning('csrfGuardMiddleware', 'Rejected cookie mutation without X-Requested-With', {
        contentType: String(req.headers['content-type'] || '').toLowerCase(),
        path: fullPath
      });
      return res.status(403).json({
        error: 'Yêu cầu bị từ chối để bảo vệ chống tấn công CSRF.'
      });
    }

    req._csrfVerified = true;
    return next();
  };
}

// ================= ACCOUNT-LEVEL LOGIN BRUTE-FORCE COOLDOWN =================
const loginFailBuckets = new Map();
const MAX_LOGIN_FAILURES = 8;
const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

function normalizeLoginLockKey(identifier) {
  return String(identifier || '')
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

async function checkLoginAccountLock(identifier) {
  const normKey = normalizeLoginLockKey(identifier);
  if (!normKey) return { locked: false, remainingSec: 0 };

  const redis = getRedisConfig();
  if (redis.url && redis.token) {
    try {
      const upstashUrl = `${redis.url.replace(/\/$/, '')}/pipeline`;
      const rKey = `login-fail:${normKey}`;
      const resp = await fetch(upstashUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redis.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          ['GET', rKey],
          ['TTL', rKey]
        ]),
        signal: AbortSignal.timeout(1500)
      });
      if (resp.ok) {
        const data = await resp.json();
        const count = Number(data?.[0]?.result || 0);
        const ttl = Number(data?.[1]?.result || 0);
        if (count >= MAX_LOGIN_FAILURES && ttl > 0) {
          return { locked: true, remainingSec: ttl };
        }
        return { locked: false, remainingSec: 0 };
      }
    } catch (err) {
      logger.warning('checkLoginAccountLock', 'Upstash check fallback to memory', { error: err.message });
    }
  }

  const now = Date.now();
  const bucket = loginFailBuckets.get(normKey);
  if (!bucket || now >= bucket.resetAt) {
    if (bucket) loginFailBuckets.delete(normKey);
    return { locked: false, remainingSec: 0 };
  }
  if (bucket.count >= MAX_LOGIN_FAILURES) {
    return { locked: true, remainingSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { locked: false, remainingSec: 0 };
}

async function recordFailedLoginAttempt(identifier) {
  const normKey = normalizeLoginLockKey(identifier);
  if (!normKey) return 0;

  const redis = getRedisConfig();
  if (redis.url && redis.token) {
    try {
      const upstashUrl = `${redis.url.replace(/\/$/, '')}/pipeline`;
      const rKey = `login-fail:${normKey}`;
      const ttlSec = Math.ceil(LOGIN_LOCKOUT_WINDOW_MS / 1000);
      const resp = await fetch(upstashUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redis.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          ['INCR', rKey],
          ['EXPIRE', rKey, ttlSec, 'NX']
        ]),
        signal: AbortSignal.timeout(1500)
      });
      if (resp.ok) {
        const data = await resp.json();
        return Number(data?.[0]?.result || 1);
      }
    } catch (err) {
      logger.warning('recordFailedLoginAttempt', 'Upstash increment fallback to memory', { error: err.message });
    }
  }

  const now = Date.now();
  if (!loginFailBuckets.has(normKey) && loginFailBuckets.size >= 5000) {
    for (const [k, b] of loginFailBuckets.entries()) {
      if (now >= b.resetAt) loginFailBuckets.delete(k);
      if (loginFailBuckets.size < 5000) break;
    }
    if (loginFailBuckets.size >= 5000) {
      const oldest = loginFailBuckets.keys().next().value;
      if (oldest !== undefined) loginFailBuckets.delete(oldest);
    }
  }

  const bucket = loginFailBuckets.get(normKey) || { count: 0, resetAt: now + LOGIN_LOCKOUT_WINDOW_MS };
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + LOGIN_LOCKOUT_WINDOW_MS;
  }
  bucket.count += 1;
  loginFailBuckets.set(normKey, bucket);
  return bucket.count;
}

async function clearFailedLoginAttempts(identifier) {
  const normKey = normalizeLoginLockKey(identifier);
  if (!normKey) return;
  loginFailBuckets.delete(normKey);

  const redis = getRedisConfig();
  if (redis.url && redis.token) {
    try {
      const upstashUrl = `${redis.url.replace(/\/$/, '')}/pipeline`;
      await fetch(upstashUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redis.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([['DEL', `login-fail:${normKey}`]]),
        signal: AbortSignal.timeout(1500)
      });
    } catch (_) {}
  }
}

module.exports = {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl,
  createCsrfGuard,
  checkLoginAccountLock,
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
  MAX_LOGIN_FAILURES
};
