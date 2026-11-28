const crypto = require('crypto');
const { foldText } = require('./productNormalizer');

const RAW_CACHE_TTL_MS = 15 * 60 * 1000;      // 15 minutes for non-empty raw candidate results
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000;  // 3 minutes for empty results
const MAX_L1_CACHE_ENTRIES = 300;
const VERIFIED_PRODUCT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_VERIFIED_PRODUCTS = 600;
const L2_TIMEOUT_MS = 450;

const l1CandidateCache = new Map();
const inFlightRawSearches = new Map();
const verifiedTikTokProducts = new Map();
const verifiedShopeeProducts = new Map();

function getVerifySecret() {
  return String(
    process.env.COMPARE_VERIFY_SECRET ||
    process.env.JWT_SECRET ||
    process.env.AUTH_SECRET ||
    'lila_compare_verify_v2_secret'
  );
}

function buildRawCandidateCacheKey(targetPlatform, query) {
  const norm = foldText(String(query || '').trim()).replace(/\s+/g, ' ');
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
  return `v2:cand:${targetPlatform}:${hash}`;
}

function getUpstashConfig() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  return { url, token };
}

async function readL2Cache(key) {
  const cfg = getUpstashConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(L2_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json.result !== 'string') return null;
    return JSON.parse(json.result);
  } catch (_) {
    return null;
  }
}

async function writeL2Cache(key, value, ttlMs) {
  const cfg = getUpstashConfig();
  if (!cfg) return;
  const ttlSec = Math.max(30, Math.round(ttlMs / 1000));
  try {
    await fetch(`${cfg.url}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(L2_TIMEOUT_MS)
    });
  } catch (_) {
    // Best-effort L2 write; never block request
  }
}

/**
 * Read raw target candidates from L1 (Memory) or L2 (optional Upstash Redis).
 * Returns { data, cacheLayer: 'l1' | 'l2' } or null on miss.
 */
async function getCachedRawCandidates(targetPlatform, query) {
  const key = buildRawCandidateCacheKey(targetPlatform, query);
  const now = Date.now();

  const l1Entry = l1CandidateCache.get(key);
  if (l1Entry) {
    if (l1Entry.expiresAt > now) {
      return { data: l1Entry.value, cacheLayer: 'l1' };
    }
    l1CandidateCache.delete(key);
  }

  const l2Value = await readL2Cache(key);
  if (l2Value && Array.isArray(l2Value.candidates)) {
    const ttlMs = l2Value.candidates.length > 0 ? RAW_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    setL1Cache(key, l2Value, ttlMs);
    return { data: l2Value, cacheLayer: 'l2' };
  }

  return null;
}

function setL1Cache(key, value, ttlMs) {
  if (l1CandidateCache.size >= MAX_L1_CACHE_ENTRIES) {
    const oldestKey = l1CandidateCache.keys().next().value;
    if (oldestKey) l1CandidateCache.delete(oldestKey);
  }
  l1CandidateCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value
  });
}

async function setCachedRawCandidates(targetPlatform, query, payload) {
  const key = buildRawCandidateCacheKey(targetPlatform, query);
  const isNonEmpty = Array.isArray(payload?.candidates) && payload.candidates.length > 0;
  const ttlMs = isNonEmpty ? RAW_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  setL1Cache(key, payload, ttlMs);
  // Fire-and-forget L2 write
  writeL2Cache(key, payload, ttlMs);
}

/**
 * Single-Flight helper: coalesces concurrent upstream fetches for the exact same (platform, query).
 */
async function runSingleFlight(targetPlatform, query, fn) {
  const key = buildRawCandidateCacheKey(targetPlatform, query);
  const existing = inFlightRawSearches.get(key);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlightRawSearches.delete(key);
    }
  })();
  inFlightRawSearches.set(key, promise);
  return promise;
}

/**
 * Stateless HMAC-SHA256 verification token so POST /api/compare/:platform/link works reliably
 * across different Vercel Serverless Lambda instances (no cold-start miss!).
 */
function signVerifiedProductToken({ platform, productId, shopId = '', detailLink = '' }) {
  const payloadObj = {
    p: platform,
    id: String(productId || '').trim(),
    s: String(shopId || '').trim(),
    u: String(detailLink || '').trim(),
    exp: Date.now() + VERIFIED_PRODUCT_TTL_MS
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getVerifySecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function isAllowedCanonicalUrl(platform, urlStr) {
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (platform === 'tiktok') {
      return host === 'shop.tiktok.com' || host.endsWith('.tiktok.com') || host === 'tiktok.com';
    }
    if (platform === 'shopee') {
      return host === 'shopee.vn' || host.endsWith('.shopee.vn');
    }
    return false;
  } catch (_) {
    return false;
  }
}

function verifyProductToken(token, expectedPlatform, expectedProductId) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  try {
    const expectedSig = crypto.createHmac('sha256', getVerifySecret()).update(payloadB64).digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || payload.exp < Date.now()) return null;
    if (payload.p !== expectedPlatform) return null;
    if (String(payload.id) !== String(expectedProductId).trim()) return null;
    if (payload.u && !isAllowedCanonicalUrl(expectedPlatform, payload.u)) return null;

    return {
      productId: payload.id,
      shopId: payload.s || '',
      detailLink: payload.u || '',
      productLink: payload.u || ''
    };
  } catch (_) {
    return null;
  }
}

// Backward-compatible L1 verified product registries
function registerVerifiedTikTokProduct(item) {
  if (!item || !item.productId) return;
  if (verifiedTikTokProducts.size >= MAX_VERIFIED_PRODUCTS) {
    const oldestKey = verifiedTikTokProducts.keys().next().value;
    if (oldestKey) verifiedTikTokProducts.delete(oldestKey);
  }
  verifiedTikTokProducts.set(String(item.productId), {
    productId: String(item.productId),
    detailLink: item.detailLink || '',
    title: item.title || '',
    price: Number(item.price || 0),
    expiresAt: Date.now() + VERIFIED_PRODUCT_TTL_MS
  });
}

function getVerifiedTikTokProduct(productId, verifyToken = '') {
  const cleanId = String(productId || '').trim();
  if (!cleanId) return null;

  // 1. Check stateless HMAC token first (serverless-safe)
  if (verifyToken) {
    const fromToken = verifyProductToken(verifyToken, 'tiktok', cleanId);
    if (fromToken) return fromToken;
  }

  // 2. Fallback to L1 memory map
  const entry = verifiedTikTokProducts.get(cleanId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    verifiedTikTokProducts.delete(cleanId);
    return null;
  }
  return entry;
}

function registerVerifiedShopeeProduct(item) {
  if (!item || !item.productId) return;
  if (verifiedShopeeProducts.size >= MAX_VERIFIED_PRODUCTS) {
    const oldestKey = verifiedShopeeProducts.keys().next().value;
    if (oldestKey) verifiedShopeeProducts.delete(oldestKey);
  }
  verifiedShopeeProducts.set(String(item.productId), {
    itemId: String(item.productId),
    shopId: String(item.shopId || ''),
    productLink: item.productLink || item.detailLink || '',
    title: item.title || '',
    price: Number(item.price || 0),
    expiresAt: Date.now() + VERIFIED_PRODUCT_TTL_MS
  });
}

function getVerifiedShopeeProduct(itemId, verifyToken = '') {
  const cleanId = String(itemId || '').trim();
  if (!cleanId) return null;

  // 1. Check stateless HMAC token first (serverless-safe)
  if (verifyToken) {
    const fromToken = verifyProductToken(verifyToken, 'shopee', cleanId);
    if (fromToken) {
      return {
        itemId: fromToken.productId,
        shopId: fromToken.shopId,
        productLink: fromToken.productLink
      };
    }
  }

  // 2. Fallback to L1 memory map
  const entry = verifiedShopeeProducts.get(cleanId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    verifiedShopeeProducts.delete(cleanId);
    return null;
  }
  return entry;
}

function clearCompareCaches() {
  l1CandidateCache.clear();
  inFlightRawSearches.clear();
  verifiedTikTokProducts.clear();
  verifiedShopeeProducts.clear();
}

module.exports = {
  RAW_CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
  buildRawCandidateCacheKey,
  getCachedRawCandidates,
  setCachedRawCandidates,
  runSingleFlight,
  signVerifiedProductToken,
  verifyProductToken,
  registerVerifiedTikTokProduct,
  getVerifiedTikTokProduct,
  registerVerifiedShopeeProduct,
  getVerifiedShopeeProduct,
  clearCompareCaches
};
