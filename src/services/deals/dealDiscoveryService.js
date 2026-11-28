/**
 * Homepage Deal Discovery Service ("Săn Deal Hoàn Tiền Cao" - P2).
 *
 * Features:
 * - 3 Deal Groups: worth_buying (Đáng mua), trending (Bán chạy & Đang hot via sold7d/growth), high_cashback (Hoàn tiền cao)
 * - 6 Categories: all, cosmetics, home, electronics, mom_baby, fashion
 * - L1 RAM + L2 PostgreSQL Cache (45m Hard TTL / 30m SWR Soft TTL) + Single-Flight coalescing
 * - Dynamic per-user VIP Cashback calculation (70/73/76/80%) on top of shared raw pool
 * - Stateless HMAC verifyToken for serverless-safe affiliate link creation
 * - Zero internal commission/revenue/% leaks to client
 */

const logger = require('../../utils/logger');
const { getPgPool, calculateCommissionSplit } = require('../dbService');
const { searchAddlivetagShopeeMarket } = require('../shopeeService');
const { normalizeShopeeRawProduct } = require('../compare/adapters/shopeeAdapter');
const { fetchTikTokCandidates } = require('../compare/adapters/tiktokAdapter');
const { computeTrustSignals } = require('../compare/trustSignals');
const {
  signVerifiedProductToken,
  registerVerifiedShopeeProduct,
  registerVerifiedTikTokProduct
} = require('../compare/compareCache');

const DEAL_SOFT_TTL_MS = 30 * 60 * 1000; // 30 minutes (SWR background refresh)
const DEAL_HARD_TTL_MS = 45 * 60 * 1000; // 45 minutes (hard expiry)
const DEAL_UPSTREAM_TIMEOUT_MS = 5500;
const MAX_DEALS_RETURNED = 16;

const DEAL_DISCLAIMER =
  'Giá và tiền hoàn mang tính tham khảo, chưa bao gồm voucher cá nhân. Cashback thực nhận phụ thuộc điều kiện xác nhận đơn hàng và chính sách Affiliate.';

const DEAL_GROUPS = {
  worth_buying: { id: 'worth_buying', label: 'Đáng mua' },
  trending: { id: 'trending', label: 'Bán chạy & Đang hot' },
  high_cashback: { id: 'high_cashback', label: 'Hoàn tiền cao' }
};

const DEAL_CATEGORIES = {
  all: {
    id: 'all',
    label: 'Tất cả',
    shopeeQueries: ['kem chống nắng', 'tai nghe bluetooth', 'nồi chiên không dầu'],
    tiktokQueries: ['kem chống nắng', 'tai nghe bluetooth']
  },
  cosmetics: {
    id: 'cosmetics',
    label: 'Mỹ phẩm',
    shopeeQueries: ['kem chống nắng', 'sữa rửa mặt', 'nước tẩy trang'],
    tiktokQueries: ['kem chống nắng', 'sữa rửa mặt']
  },
  home: {
    id: 'home',
    label: 'Gia dụng',
    shopeeQueries: ['nồi chiên không dầu', 'bình giữ nhiệt', 'nước giặt'],
    tiktokQueries: ['bình giữ nhiệt', 'nồi chiên không dầu']
  },
  electronics: {
    id: 'electronics',
    label: 'Điện tử',
    shopeeQueries: ['tai nghe bluetooth', 'củ sạc nhanh', 'sạc dự phòng'],
    tiktokQueries: ['tai nghe bluetooth', 'củ sạc nhanh']
  },
  mom_baby: {
    id: 'mom_baby',
    label: 'Mẹ & Bé',
    shopeeQueries: ['tã quần', 'bình sữa', 'khăn sữa'],
    tiktokQueries: ['bình sữa', 'tã quần']
  },
  fashion: {
    id: 'fashion',
    label: 'Thời trang',
    shopeeQueries: ['áo thun nam', 'pijama nữ', 'giày thể thao'],
    tiktokQueries: ['pijama nữ', 'áo thun nam']
  }
};

// L1 Memory cache & Single-Flight registry
const l1DealCache = new Map();
const inFlightDealFetches = new Map();
let pgTableEnsured = false;

async function ensureDealCacheTable(pool) {
  if (pgTableEnsured || !pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_shelf_cache (
        cache_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    pgTableEnsured = true;
  } catch (err) {
    logger.warning('ensureDealCacheTable', 'Failed to ensure deal_shelf_cache table', { error: err?.message });
  }
}

async function readL2DealCache(cacheKey) {
  const pool = getPgPool();
  if (!pool) return null;
  try {
    await ensureDealCacheTable(pool);
    const { rows } = await pool.query(
      'SELECT payload, fetched_at, expires_at FROM deal_shelf_cache WHERE cache_key = $1 LIMIT 1',
      [cacheKey]
    );
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }
    const fetchedAtMs = new Date(row.fetched_at).getTime();
    return {
      payload: row.payload,
      fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : Date.now(),
      expiresAtMs
    };
  } catch (err) {
    logger.warning('readL2DealCache', 'Postgres cache read failed, falling back to upstream', { error: err?.message });
    return null;
  }
}

async function writeL2DealCache(cacheKey, payload, hardExpiresAtMs) {
  const pool = getPgPool();
  if (!pool) return;
  try {
    await ensureDealCacheTable(pool);
    await pool.query(
      `INSERT INTO deal_shelf_cache (cache_key, payload, fetched_at, expires_at)
       VALUES ($1, $2::jsonb, NOW(), to_timestamp($3 / 1000.0))
       ON CONFLICT (cache_key)
       DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [cacheKey, JSON.stringify(payload), hardExpiresAtMs]
    );
  } catch (err) {
    logger.warning('writeL2DealCache', 'Postgres cache write failed (non-fatal)', { error: err?.message });
  }
}

function isValidHttpsImage(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  return /^https:\/\/.+/i.test(urlStr.trim());
}

/**
 * Fetch raw cross-platform candidates for a given (group, category) in parallel.
 * Uses Promise.allSettled so one platform's error never breaks the shelf.
 */
async function fetchRawDealPool(groupId, categoryId, config = {}) {
  const cat = DEAL_CATEGORIES[categoryId] || DEAL_CATEGORIES.all;
  const addlivetagKey = String(config.addlivetagApiKey || '').trim();
  const accesstradeKey = String(config.accesstradeApiKey || '').trim();
  const shopeeFetcher = config.shopeeFetcher;
  const tiktokFetcher = config.tiktokFetcher;

  const tasks = [];

  // 1. Shopee (AddLiveTag) queries — tailored sort by Deal Group!
  if (shopeeFetcher || addlivetagKey) {
    const queries = cat.shopeeQueries.slice(0, groupId === 'trending' ? 2 : 3);
    for (const q of queries) {
      if (groupId === 'trending') {
        // Leverage AddLiveTag native sort=sold7d & sort=growth for rising products!
        tasks.push(
          (shopeeFetcher
            ? shopeeFetcher(q, 'sold7d', 10)
            : searchAddlivetagShopeeMarket(q, addlivetagKey, 10, {
                sort: 'sold7d',
                timeoutMs: DEAL_UPSTREAM_TIMEOUT_MS
              })
          ).then((list) =>
            (Array.isArray(list) ? list : [])
              .map(normalizeShopeeRawProduct)
              .filter(Boolean)
              .map((c) => ({ ...c, platform: 'shopee' }))
          )
        );
        tasks.push(
          (shopeeFetcher
            ? shopeeFetcher(q, 'growth', 6)
            : searchAddlivetagShopeeMarket(q, addlivetagKey, 6, {
                sort: 'growth',
                timeoutMs: DEAL_UPSTREAM_TIMEOUT_MS
              })
          ).then((list) =>
            (Array.isArray(list) ? list : [])
              .map(normalizeShopeeRawProduct)
              .filter(Boolean)
              .map((c) => ({ ...c, platform: 'shopee' }))
          )
        );
      } else {
        tasks.push(
          (shopeeFetcher
            ? shopeeFetcher(q, 'revenue_all', 12)
            : searchAddlivetagShopeeMarket(q, addlivetagKey, 12, {
                sort: 'revenue_all',
                timeoutMs: DEAL_UPSTREAM_TIMEOUT_MS
              })
          ).then((list) =>
            (Array.isArray(list) ? list : [])
              .map(normalizeShopeeRawProduct)
              .filter(Boolean)
              .map((c) => ({ ...c, platform: 'shopee' }))
          )
        );
      }
    }
  }

  // 2. TikTok Shop (AccessTrade API v2) queries
  if (tiktokFetcher || accesstradeKey) {
    const ttQueries = cat.tiktokQueries.slice(0, 2);
    for (const q of ttQueries) {
      tasks.push(
        (tiktokFetcher
          ? tiktokFetcher(q, 12)
          : fetchTikTokCandidates(q, {
              apiKey: accesstradeKey,
              pageSize: 12,
              timeoutMs: DEAL_UPSTREAM_TIMEOUT_MS
            }).then((r) => r.candidates)
        ).then((list) =>
          (Array.isArray(list) ? list : [])
            .filter(Boolean)
            .map((c) => ({ ...c, platform: 'tiktok' }))
        )
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  const seen = new Set();
  const pool = [];

  for (const res of settled) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const cand of res.value) {
      const uid = `${cand.platform}:${cand.id}`;
      if (seen.has(uid)) continue;
      seen.add(uid);

      // Group C hard reject: missing image, invalid/extreme price, out of stock, low rating, or zero commission
      if (!isValidHttpsImage(cand.imageUrl)) continue;
      if (cand.hasInventory === false) continue;
      if (cand.price < 20000 || cand.price > 15000000) continue;
      if (cand.grossCommission <= 0) continue;
      if (cand.rating > 0 && cand.rating < 4.2) continue;

      pool.push(cand);
    }
  }

  return {
    candidates: pool,
    fetchedAt: new Date().toISOString()
  };
}

/**
 * Score & rank raw deal candidates for a specific Deal Group and user VIP cashback rate.
 */
function rankAndFormatDeals(rawCandidates, { groupId, cashbackPercent, taxDeductPercent, fetchedAt, limit = MAX_DEALS_RETURNED }) {
  const groupA = []; // Complete data & strong quality floor
  const groupB = []; // Partial data fallback (e.g. TikTok unitsSold === 0)

  for (const cand of rawCandidates) {
    const split = calculateCommissionSplit(cand.grossCommission, cashbackPercent, taxDeductPercent);
    const estimatedCashback = Math.max(0, Math.round(split.userCashbackAmount || 0));
    if (estimatedCashback < 1000) continue;

    const effectivePrice = Math.max(0, cand.price - estimatedCashback);
    const cashbackRatio = cand.price > 0 ? estimatedCashback / cand.price : 0;

    const trust = computeTrustSignals(
      {
        rating: cand.rating,
        sales: cand.sales,
        sold7d: cand.sold7d,
        growth: cand.growth,
        price: cand.price,
        estimatedCashback
      },
      { platform: cand.platform }
    );

    if (trust.trustWarning) continue; // Never promote warned items on Homepage Deal Shelf

    // Quality tier classification (Group A vs Group B)
    const isStrongQuality =
      cand.platform === 'shopee'
        ? (cand.rating === 0 || cand.rating >= 4.5) && cand.sales >= 20
        : cand.sales >= 10;

    // Normalized sub-scores (0..1)
    const ratingScore = cand.rating > 0 ? Math.min(1, Math.max(0, (cand.rating - 4.0) / 1.0)) : 0.65;
    const salesScore = Math.min(1, Math.log10(Math.max(1, cand.sales) + 1) / 4.2);
    const trustScore = ratingScore * 0.45 + salesScore * 0.55;

    const cbAmountScore = Math.min(1, estimatedCashback / 50000);
    const cbRatioScore = Math.min(1, cashbackRatio / 0.12);
    const cashbackScore = cbAmountScore * 0.5 + cbRatioScore * 0.5;

    const sold7dScore = Math.min(1, Math.log10(Math.max(1, cand.sold7d) + 1) / 3.0);
    const growthBonus = cand.sold7d >= 20 && cand.growth > 0 ? 0.25 : 0;
    const momentumScore = Math.min(1, sold7dScore * 0.75 + growthBonus);

    const completenessScore = (cand.rating > 0 ? 0.4 : 0) + (cand.sales > 0 ? 0.4 : 0) + (cand.sold7d > 0 ? 0.2 : 0);

    // Penalty for very expensive items with low sales (avoid high-ticket low-demand trap)
    const expensiveLowSalesPenalty = cand.price > 3000000 && cand.sales < 50 ? 0.25 : 0;

    let rankScore = 0;
    if (groupId === 'trending') {
      rankScore =
        momentumScore * 0.50 +
        salesScore * 0.30 +
        ratingScore * 0.10 +
        cashbackScore * 0.10 -
        expensiveLowSalesPenalty;
    } else if (groupId === 'high_cashback') {
      rankScore =
        cashbackScore * 0.65 +
        trustScore * 0.25 +
        completenessScore * 0.10 -
        expensiveLowSalesPenalty;
    } else {
      // worth_buying (default balanced)
      rankScore =
        trustScore * 0.35 +
        cashbackScore * 0.35 +
        momentumScore * 0.20 +
        completenessScore * 0.10 -
        expensiveLowSalesPenalty;
    }

    const verifyToken = signVerifiedProductToken({
      platform: cand.platform,
      productId: cand.id,
      shopId: cand.shopId || '',
      detailLink: cand.detailLink || ''
    });

    if (cand.platform === 'tiktok') {
      registerVerifiedTikTokProduct({ productId: cand.id, detailLink: cand.detailLink, title: cand.title, price: cand.price });
    } else {
      registerVerifiedShopeeProduct({ productId: cand.id, shopId: cand.shopId, productLink: cand.detailLink, title: cand.title, price: cand.price });
    }

    const publicItem = {
      platform: cand.platform,
      productId: cand.id,
      shopId: cand.shopId || '',
      title: cand.title,
      shopName: cand.shopName || (cand.platform === 'shopee' ? 'Shopee' : 'TikTok Shop'),
      imageUrl: cand.imageUrl,
      price: cand.price,
      hasPriceRange: Boolean(cand.hasPriceRange),
      estimatedCashback,
      rating: trust.rating,
      sales: trust.sales,
      sold7d: trust.sold7d,
      highlightBadge: trust.highlightBadge,
      verifyToken,
      fetchedAt,
      _rankScore: rankScore,
      _effectivePrice: effectivePrice
    };

    if (isStrongQuality) {
      groupA.push(publicItem);
    } else {
      groupB.push(publicItem);
    }
  }

  const sortFn = (a, b) => {
    if (groupId === 'high_cashback' && b.estimatedCashback !== a.estimatedCashback) {
      // Primary by cashback when rank scores are close, while keeping trust weighting
      return b._rankScore - a._rankScore || b.estimatedCashback - a.estimatedCashback;
    }
    return b._rankScore - a._rankScore || a._effectivePrice - b._effectivePrice;
  };

  groupA.sort(sortFn);
  groupB.sort(sortFn);

  // Interleave Shopee & TikTok gently (2:1 ratio) so TikTok Shop deals aren't buried by missing rating/sold7d fields
  const ordered = [...groupA, ...groupB];
  const spList = ordered.filter((x) => x.platform === 'shopee');
  const ttList = ordered.filter((x) => x.platform === 'tiktok');
  const combined = [];
  let si = 0;
  let ti = 0;
  while (combined.length < limit && (si < spList.length || ti < ttList.length)) {
    if (si < spList.length) combined.push(spList[si++]);
    if (combined.length < limit && si < spList.length) combined.push(spList[si++]);
    if (combined.length < limit && ti < ttList.length) combined.push(ttList[ti++]);
  }

  return combined.map((item) => {
    const clean = { ...item };
    delete clean._rankScore;
    delete clean._effectivePrice;
    return clean;
  });
}

/**
 * Main entry point for GET /api/deals/home.
 */
async function getHomeDeals(options = {}) {
  const startedAt = Date.now();
  const groupId = DEAL_GROUPS[options.group] ? options.group : 'worth_buying';
  const categoryId = DEAL_CATEGORIES[options.category] ? options.category : 'all';
  const cashbackPercent = Number(options.cashbackPercent ?? 70);
  const taxDeductPercent = Number(options.taxDeductPercent ?? 10);
  const limit = Math.min(24, Math.max(4, Number(options.limit) || MAX_DEALS_RETURNED));
  const useCache = !options.disableCache;

  const cacheKey = `deals:v1:${groupId}:${categoryId}`;
  const now = Date.now();

  let rawData = null;
  let cacheLayer = 'miss';

  // 1. Check L1 RAM Cache
  if (useCache) {
    const l1 = l1DealCache.get(cacheKey);
    if (l1 && l1.expiresAtMs > now) {
      rawData = l1.payload;
      cacheLayer = 'l1';
      // Stale-While-Revalidate: trigger non-blocking refresh if older than 30 min
      if (now - l1.fetchedAtMs >= DEAL_SOFT_TTL_MS && !inFlightDealFetches.has(cacheKey)) {
        void refreshDealPoolInBackground(cacheKey, groupId, categoryId, options);
      }
    }
  }

  // 2. Check L2 PostgreSQL Cache (shared across all Vercel Lambdas!)
  if (!rawData && useCache) {
    const l2 = await readL2DealCache(cacheKey);
    if (l2 && l2.payload && Array.isArray(l2.payload.candidates)) {
      rawData = l2.payload;
      cacheLayer = 'l2_pg';
      l1DealCache.set(cacheKey, l2);
      if (now - l2.fetchedAtMs >= DEAL_SOFT_TTL_MS && !inFlightDealFetches.has(cacheKey)) {
        void refreshDealPoolInBackground(cacheKey, groupId, categoryId, options);
      }
    }
  }

  // 3. Cache Miss -> Single-Flight upstream fetch
  if (!rawData) {
    rawData = await fetchAndCacheSingleFlight(cacheKey, groupId, categoryId, options, useCache);
  }

  const items = rankAndFormatDeals(rawData?.candidates || [], {
    groupId,
    cashbackPercent,
    taxDeductPercent,
    fetchedAt: rawData?.fetchedAt || new Date().toISOString(),
    limit
  });

  logger.log('deals_telemetry', 'Home deals served', {
    groupId,
    categoryId,
    cacheLayer,
    durationMs: Date.now() - startedAt,
    poolCount: rawData?.candidates?.length || 0,
    returnedCount: items.length
  });

  return {
    ok: true,
    group: groupId,
    category: categoryId,
    groups: Object.values(DEAL_GROUPS),
    categories: Object.values(DEAL_CATEGORIES).map((c) => ({ id: c.id, label: c.label })),
    cached: cacheLayer !== 'miss',
    cacheLayer,
    fetchedAt: rawData?.fetchedAt || new Date().toISOString(),
    disclaimer: DEAL_DISCLAIMER,
    items
  };
}

async function fetchAndCacheSingleFlight(cacheKey, groupId, categoryId, options, useCache) {
  if (useCache && inFlightDealFetches.has(cacheKey)) {
    return inFlightDealFetches.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const payload = await fetchRawDealPool(groupId, categoryId, options);
      if (useCache && Array.isArray(payload.candidates) && payload.candidates.length > 0) {
        const fetchedAtMs = Date.now();
        const expiresAtMs = fetchedAtMs + DEAL_HARD_TTL_MS;
        l1DealCache.set(cacheKey, { payload, fetchedAtMs, expiresAtMs });
        void writeL2DealCache(cacheKey, payload, expiresAtMs);
      }
      return payload;
    } finally {
      inFlightDealFetches.delete(cacheKey);
    }
  })();
  if (useCache) inFlightDealFetches.set(cacheKey, promise);
  return promise;
}

async function refreshDealPoolInBackground(cacheKey, groupId, categoryId, options) {
  try {
    await fetchAndCacheSingleFlight(cacheKey, groupId, categoryId, options, true);
  } catch (err) {
    logger.warning('refreshDealPoolInBackground', 'SWR refresh failed (stale data still valid)', {
      cacheKey,
      error: err?.message
    });
  }
}

function clearDealCaches() {
  l1DealCache.clear();
  inFlightDealFetches.clear();
}

module.exports = {
  DEAL_GROUPS,
  DEAL_CATEGORIES,
  DEAL_DISCLAIMER,
  getHomeDeals,
  rankAndFormatDeals,
  clearDealCaches
};
