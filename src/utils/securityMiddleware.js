const logger = require('./logger');

const rateBuckets = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Rate limiter middleware supporting Upstash Redis REST (serverless-safe) + memory fallback.
 */
function createRateLimiter({ windowMs = 60000, max = 30, keyPrefix = 'rl' } = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    // If Upstash Redis REST env vars are configured, use distributed rate limit
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
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
        if (resp.ok) {
          const data = await resp.json();
          const count = Number(data?.[0]?.result || 1);
          if (count > max) {
            logger.warning('rateLimitMiddleware', 'Rate limit exceeded (Upstash)', { ip, keyPrefix });
            return res.status(429).json({
              error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.'
            });
          }
          return next();
        }
      } catch {
        // Fallback to local memory bucket
      }
    }

    // Memory sliding window fallback
    if (rateBuckets.size > 5000) {
      rateBuckets.clear();
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
 * Verify Cloudflare Turnstile token if TURNSTILE_SECRET_KEY is configured in environment.
 */
async function verifyTurnstileIfEnabled(turnstileToken, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // Not enabled yet
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
    const data = await res.json();
    return Boolean(data.success);
  } catch {
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

module.exports = {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl
};
