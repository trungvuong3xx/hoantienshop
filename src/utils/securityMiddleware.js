const logger = require('./logger');

const rateBuckets = new Map();

// Startup security audit for production environments
if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    logger.error(
      'SecurityStartupAudit',
      'TURNSTILE_SECRET_KEY is missing in production environment!'
    );
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    logger.warning(
      'SecurityStartupAudit',
      'UPSTASH_REDIS_REST_URL / TOKEN not configured; distributed rate limiting is inactive.'
    );
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Rate limiter middleware supporting Upstash Redis REST (serverless-safe).
 * When failClosed=true (auth & withdrawal routes), Redis errors reject the request (503) instead of falling back to RAM.
 */
function createRateLimiter({
  windowMs = 60000,
  max = 30,
  keyPrefix = 'rl',
  failClosed = false
} = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    const hasUpstash = Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    );

    if (hasUpstash) {
      try {
        const upstashUrl = `${process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '')}/pipeline`;
        const ttlSec = Math.ceil(windowMs / 1000);
        const resp = await fetch(upstashUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
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
        const count = Number(data?.[0]?.result || 1);
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
    } else if (failClosed && process.env.STRICT_PRODUCTION_SECURITY === 'true') {
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

  return function csrfGuardMiddleware(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next();
    }

    const fullPath = req.originalUrl || req.path || '';
    if (!fullPath.startsWith('/api/') || fullPath.startsWith('/api/webhooks/')) {
      return next();
    }

    const rawCookie = req.headers.cookie || '';
    const hasAuthCookie = /(?:^|;\s*)hts_auth=([^;]+)/.test(rawCookie);
    if (!hasAuthCookie) {
      return next();
    }

    const originHeader = req.headers.origin;
    if (originHeader) {
      let originAllowed = originWhitelist.has(originHeader) ||
        /^https:\/\/hoantienshop(-[a-z0-9-]+)?\.vercel\.app$/i.test(originHeader);
      if (!originAllowed) {
        try {
          const parsedOrigin = new URL(originHeader);
          const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
          if (reqHost && parsedOrigin.host === reqHost) {
            originAllowed = true;
          }
        } catch {
          originAllowed = false;
        }
      }
      if (!originAllowed) {
        logger.warning('csrfGuardMiddleware', 'Rejected cross-origin cookie request', {
          origin: originHeader,
          path: fullPath
        });
        return res.status(403).json({
          error: 'Yêu cầu bị từ chối do nguồn gốc (Origin) không hợp lệ (CSRF Blocked).'
        });
      }
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const isSimpleFormContent =
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data') ||
      contentType.includes('text/plain');

    if (isSimpleFormContent && !req.headers['x-requested-with']) {
      logger.warning('csrfGuardMiddleware', 'Rejected simple-content CSRF attempt without X-Requested-With', {
        contentType,
        path: fullPath
      });
      return res.status(403).json({
        error: 'Yêu cầu bị từ chối để bảo vệ chống tấn công CSRF.'
      });
    }

    return next();
  };
}

module.exports = {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl,
  createCsrfGuard
};
