const logger = require('../../../utils/logger');
const circuitBreaker = require('../circuitBreaker');

const ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS =
  'https://api.accesstrade.vn/v2/tiktokshop_product_feeds';
const PROVIDER_KEY = 'tiktok_accesstrade';
const DEFAULT_TIMEOUT_MS = 5000;

function parseNumeric(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractTikTokPrice(raw) {
  const saleMin = parseNumeric(raw?.sales_price?.minimum_amount);
  const saleMax = parseNumeric(raw?.sales_price?.maximum_amount);
  const origMin = parseNumeric(raw?.original_price?.minimum_amount);
  const origMax = parseNumeric(raw?.original_price?.maximum_amount);

  const price = saleMin > 0 ? saleMin : origMin > 0 ? origMin : saleMax > 0 ? saleMax : origMax;
  const priceMax = saleMax > 0 ? saleMax : origMax > 0 ? origMax : price;
  const originalPrice = origMin > 0 ? origMin : origMax > 0 ? origMax : price;

  const roundedPrice = Number.isFinite(price) && price > 0 ? Math.round(price) : 0;
  const roundedMax = Number.isFinite(priceMax) && priceMax > 0 ? Math.round(priceMax) : roundedPrice;
  const hasPriceRange = roundedPrice > 0 && roundedMax > roundedPrice * 1.25;

  return {
    price: roundedPrice,
    priceMin: roundedPrice,
    priceMax: roundedMax,
    hasPriceRange,
    originalPrice: Number.isFinite(originalPrice) && originalPrice > 0 ? Math.round(originalPrice) : 0
  };
}

function extractTikTokCommission(raw, price) {
  const commAmount = parseNumeric(raw?.commission?.amount);
  const rawRate = parseNumeric(raw?.commission?.rate);
  const commRatePercent =
    rawRate > 0 && rawRate <= 1 ? Number((rawRate * 100).toFixed(2)) : Number(rawRate.toFixed(2));

  let grossCommission = 0;
  if (commAmount > 0) {
    grossCommission = Math.round(commAmount);
  } else if (price > 0 && commRatePercent > 0) {
    grossCommission = Math.round((price * commRatePercent) / 100);
  }

  return {
    grossCommission: Number.isFinite(grossCommission) && grossCommission > 0 ? grossCommission : 0,
    commissionRate: Number.isFinite(commRatePercent) && commRatePercent > 0 ? commRatePercent : 0
  };
}

function normalizeTikTokRawProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const title = String(raw.title || '').trim();
  if (!/^\d{6,30}$/.test(id) || !title) return null;

  const { price, priceMin, priceMax, hasPriceRange, originalPrice } = extractTikTokPrice(raw);
  const { grossCommission, commissionRate } = extractTikTokCommission(raw, price);
  const detailLink = String(raw.detail_link || '').trim() ||
    `https://shop.tiktok.com/view/product/${id}?region=VN&local=en`;

  const rawRating = parseNumeric(raw.rating_star);
  return {
    id,
    shopId: '',
    title,
    shopName: String(raw?.shop?.name || '').trim() || 'TikTok Shop',
    imageUrl: String(raw.main_image_url || '').trim(),
    price,
    priceMin,
    priceMax,
    hasPriceRange,
    originalPrice,
    grossCommission,
    commissionRate,
    hasInventory: raw.has_inventory !== false,
    sales: parseNumeric(raw.units_sold),
    rating: rawRating > 0 && rawRating <= 5 ? Number(rawRating.toFixed(1)) : 0,
    sold7d: 0,
    sold30d: 0,
    growth: 0,
    revenueAll: 0,
    revenue30d: 0,
    catId: 0,
    detailLink
  };
}

/**
 * Call AccessTrade TikTok Shop v2 Product Feeds API with circuit breaker & timeout.
 */
async function fetchTikTokProductFeedsV2(keyword, apiKey, options = {}) {
  const cleanKeyword = String(keyword || '').trim();
  const cleanKey = String(apiKey || '').trim();
  const limit = Math.min(20, Math.max(1, Number(options.limit || options.pageSize) || 20));
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || global.fetch;
  const useBreaker = !options.fetchFn; // Don't trip global breaker during unit-test mock fetches

  if (!cleanKey) {
    const err = new Error('Chưa cấu hình AccessTrade API Key để tìm kiếm TikTok Shop.');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  if (!cleanKeyword) {
    return [];
  }

  if (useBreaker && !circuitBreaker.canExecute(PROVIDER_KEY)) {
    const err = new Error('Hệ thống tìm kiếm TikTok Shop đang tạm nghỉ để ổn định kết nối, vui lòng thử lại sau ít giây.');
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  const url = new URL(ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS);
  url.searchParams.set('title_keywords', cleanKeyword);
  url.searchParams.set('limit', String(limit));

  logger.logEnter('fetchTikTokProductFeedsV2', { keywordLength: cleanKeyword.length, limit });

  let response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Token ${cleanKey}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (useBreaker) circuitBreaker.recordFailure(PROVIDER_KEY);
    const isTimeout =
      err?.name === 'AbortError' ||
      err?.name === 'TimeoutError' ||
      /timeout|aborted/i.test(String(err?.message || ''));
    const wrapped = new Error(
      isTimeout
        ? 'Kết nối tìm kiếm TikTok Shop tạm thời quá thời gian chờ.'
        : 'Không thể kết nối máy chủ đối chiếu TikTok Shop.'
    );
    wrapped.code = isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR';
    logger.warning('fetchTikTokProductFeedsV2', 'Upstream fetch error', { code: wrapped.code });
    throw wrapped;
  }

  if (!response || !response.ok) {
    const status = response?.status || 0;
    if (useBreaker && (status === 429 || status >= 500 || status === 0)) {
      circuitBreaker.recordFailure(PROVIDER_KEY);
    }
    const err = new Error(
      status === 429
        ? 'Hệ thống tìm kiếm TikTok Shop đang bận, vui lòng thử lại sau ít giây.'
        : 'Hệ thống đối chiếu TikTok Shop tạm thời không phản hồi.'
    );
    err.code =
      status === 429
        ? 'RATE_LIMITED'
        : status === 401 || status === 403
          ? 'AUTH_ERROR'
          : 'UPSTREAM_ERROR';
    err.httpStatus = status;
    logger.warning('fetchTikTokProductFeedsV2', 'Upstream non-OK response', { status, code: err.code });
    throw err;
  }

  if (useBreaker) circuitBreaker.recordSuccess(PROVIDER_KEY);

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  const products = Array.isArray(data?.data?.products)
    ? data.data.products
    : Array.isArray(data?.products)
      ? data.products
      : [];

  logger.logLeave('fetchTikTokProductFeedsV2', { count: products.length });
  return products;
}

async function fetchTikTokCandidates(query, adapterOptions = {}) {
  const rawList = await fetchTikTokProductFeedsV2(query, adapterOptions.apiKey, {
    pageSize: adapterOptions.pageSize || 20,
    timeoutMs: adapterOptions.timeoutMs || DEFAULT_TIMEOUT_MS,
    fetchFn: adapterOptions.fetchFn
  });
  const candidates = [];
  for (const raw of rawList) {
    const norm = normalizeTikTokRawProduct(raw);
    if (norm) candidates.push(norm);
  }
  return { candidates, provider: PROVIDER_KEY };
}

module.exports = {
  ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS,
  extractTikTokPrice,
  extractTikTokCommission,
  normalizeTikTokRawProduct,
  fetchTikTokProductFeedsV2,
  fetchTikTokCandidates
};
