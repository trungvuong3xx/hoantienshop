const logger = require('../../../utils/logger');
const {
  searchShopeeProductOffersByKeyword,
  searchAddlivetagShopeeMarket
} = require('../../shopeeService');
const circuitBreaker = require('../circuitBreaker');

const OPENAPI_PROVIDER = 'shopee_openapi';
const ADDLIVETAG_PROVIDER = 'shopee_addlivetag';

function parseNumeric(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    let s = val.trim();
    if (!s) return 0;
    // Handle Vietnamese thousands dot-grouping like "33.000" or "1.250.000"
    if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeShopeeRawProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = String(raw.itemId || raw.id || '').trim();
  const shopId = String(raw.shopId || '').trim();
  const title = String(raw.productName || raw.title || '').trim();
  if (!/^\d{4,30}$/.test(itemId) || !title) return null;

  const priceMin = Math.round(parseNumeric(raw.priceMin || raw.price || raw.priceMax));
  const priceMax = Math.round(parseNumeric(raw.priceMax || raw.price || priceMin));
  const price = priceMin > 0 ? priceMin : priceMax;
  const hasPriceRange = price > 0 && priceMax > price * 1.25;

  const rawRate = parseNumeric(raw.commissionRate);
  const commissionRate =
    rawRate > 0 && rawRate < 1 ? Number((rawRate * 100).toFixed(2)) : Number(rawRate.toFixed(2));
  const explicitComm = Math.round(parseNumeric(raw.commission));
  let grossCommission = explicitComm > 0 ? explicitComm : 0;
  if (grossCommission <= 0 && price > 0 && commissionRate > 0) {
    grossCommission = Math.round((price * commissionRate) / 100);
  }

  const detailLink =
    String(raw.productLink || '').trim() ||
    (shopId ? `https://shopee.vn/product/${shopId}/${itemId}` : `https://shopee.vn/item-i.0.${itemId}`);

  const rawRating = parseNumeric(raw.rating);
  return {
    id: itemId,
    shopId,
    title,
    shopName: String(raw.shopName || '').trim() || 'Shopee',
    imageUrl: String(raw.imageUrl || '').trim(),
    price,
    priceMin: price,
    priceMax: priceMax || price,
    hasPriceRange,
    originalPrice: priceMax || price,
    grossCommission: Number.isFinite(grossCommission) && grossCommission > 0 ? grossCommission : 0,
    commissionRate: Number.isFinite(commissionRate) && commissionRate > 0 ? commissionRate : 0,
    hasInventory: true,
    sales: parseNumeric(raw.sales),
    rating: rawRating > 0 && rawRating <= 5 ? Number(rawRating.toFixed(1)) : 0,
    sold7d: parseNumeric(raw.sold7d),
    sold30d: parseNumeric(raw.sold30d),
    growth: parseNumeric(raw.growth),
    revenueAll: parseNumeric(raw.revenueAll),
    revenue30d: parseNumeric(raw.revenue30d),
    catId: parseNumeric(raw.catId),
    detailLink
  };
}

/**
 * Fetch Shopee candidates with circuit breaker & intelligent provider fallback:
 * 1. Official Shopee Open API productOfferV2 (when appId + appSecret configured & circuit closed)
 * 2. Fallback to AddLiveTag Market Search API (when addlivetagApiKey configured & circuit closed)
 */
async function fetchShopeeCandidates(query, adapterOptions = {}) {
  const {
    appId = '',
    appSecret = '',
    addlivetagApiKey = '',
    limit = 20,
    timeoutMs = 5500,
    searchFn,
    addlivetagSearchFn
  } = adapterOptions;

  const hasOpenApi = Boolean(searchFn || (appId && appSecret));
  const hasAddlivetag = Boolean(addlivetagSearchFn || addlivetagApiKey);
  const useBreaker = !searchFn && !addlivetagSearchFn;

  const openApiCaller =
    searchFn ||
    ((kw, lim) => searchShopeeProductOffersByKeyword(kw, appId, appSecret, lim));
  const addlivetagCaller =
    addlivetagSearchFn ||
    ((kw, lim) => searchAddlivetagShopeeMarket(kw, addlivetagApiKey, lim, { timeoutMs }));

  let rawProducts = [];
  let lastErr = null;
  let providerUsed = '';

  // 1. Try Shopee Open API first
  if (hasOpenApi && (!useBreaker || circuitBreaker.canExecute(OPENAPI_PROVIDER))) {
    try {
      const res = await openApiCaller(query, limit);
      if (useBreaker) circuitBreaker.recordSuccess(OPENAPI_PROVIDER);
      if (Array.isArray(res) && res.length > 0) {
        rawProducts = res;
        providerUsed = OPENAPI_PROVIDER;
      }
    } catch (err) {
      lastErr = err;
      if (useBreaker && (err?.code === 'TIMEOUT' || err?.code === 'RATE_LIMITED' || err?.code === 'UPSTREAM_ERROR')) {
        circuitBreaker.recordFailure(OPENAPI_PROVIDER);
      }
      logger.warning('fetchShopeeCandidates', 'Open API failed, checking AddLiveTag fallback', {
        code: err?.code,
        hasAddlivetag
      });
    }
  }

  // 2. Fallback to AddLiveTag Market Search
  if (rawProducts.length === 0 && hasAddlivetag && (!useBreaker || circuitBreaker.canExecute(ADDLIVETAG_PROVIDER))) {
    try {
      const res = await addlivetagCaller(query, limit);
      if (useBreaker) circuitBreaker.recordSuccess(ADDLIVETAG_PROVIDER);
      if (Array.isArray(res) && res.length > 0) {
        rawProducts = res;
        providerUsed = ADDLIVETAG_PROVIDER;
      } else {
        lastErr = null;
        providerUsed = ADDLIVETAG_PROVIDER;
      }
    } catch (err) {
      lastErr = err;
      if (useBreaker && (err?.code === 'TIMEOUT' || err?.code === 'RATE_LIMITED' || err?.code === 'UPSTREAM_ERROR' || err?.code === 'NETWORK_ERROR')) {
        circuitBreaker.recordFailure(ADDLIVETAG_PROVIDER);
      }
      logger.warning('fetchShopeeCandidates', 'AddLiveTag search failed', {
        code: err?.code,
        error: err?.message
      });
    }
  }

  if (rawProducts.length === 0 && lastErr) {
    throw lastErr;
  }

  const candidates = [];
  for (const raw of rawProducts) {
    const norm = normalizeShopeeRawProduct(raw);
    if (norm) candidates.push(norm);
  }

  return { candidates, provider: providerUsed || (hasOpenApi ? OPENAPI_PROVIDER : ADDLIVETAG_PROVIDER) };
}

module.exports = {
  normalizeShopeeRawProduct,
  fetchShopeeCandidates
};
