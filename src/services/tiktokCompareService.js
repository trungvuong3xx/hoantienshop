/**
 * Cross-Platform Price & Cashback Comparison Facade (Shopee <-> TikTok Shop).
 * Delegates all matching, normalization, caching, circuit breaking, and ranking
 * to the modular engine under src/services/compare/*.
 */

const {
  cleanShopeeTitleForSearch,
  buildShorterFallbackQuery,
  normalizeObfuscatedWords,
  extractDistinctiveBrandTokens,
  extractProductUnits
} = require('./compare/productNormalizer');

const {
  compareUnits,
  evaluateProductMatch
} = require('./compare/productMatcher');

const {
  getVerifiedTikTokProduct,
  registerVerifiedTikTokProduct,
  getVerifiedShopeeProduct,
  registerVerifiedShopeeProduct,
  signVerifiedProductToken,
  verifyProductToken,
  clearCompareCaches: clearCacheStorage
} = require('./compare/compareCache');

const { resetCircuitBreakers } = require('./compare/circuitBreaker');

const {
  ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS,
  normalizeTikTokRawProduct,
  fetchTikTokProductFeedsV2,
  fetchTikTokCandidates
} = require('./compare/adapters/tiktokAdapter');

const {
  normalizeShopeeRawProduct,
  fetchShopeeCandidates
} = require('./compare/adapters/shopeeAdapter');

const {
  TRANSPARENCY_DISCLAIMER,
  buildUnifiedComparableItem,
  runCrossPlatformCompare
} = require('./compare/compareEngine');

/**
 * Backward-compatible TikTok candidate scorer.
 */
function scoreTikTokCandidate(shopeeTitle, shopeePrice, rawCandidate) {
  const norm = normalizeTikTokRawProduct(rawCandidate);
  if (!norm) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'invalid_product_fields' };
  }
  return evaluateProductMatch(shopeeTitle, shopeePrice, norm);
}

/**
 * Backward-compatible TikTok comparable product builder.
 */
function buildComparableProduct(rawProduct, options = {}) {
  const norm = normalizeTikTokRawProduct(rawProduct) || {
    id: String(rawProduct?.id || ''),
    shopId: '',
    title: String(rawProduct?.title || ''),
    shopName: String(rawProduct?.shop?.name || 'TikTok Shop'),
    imageUrl: String(rawProduct?.main_image_url || ''),
    price: 0,
    priceMin: 0,
    priceMax: 0,
    hasPriceRange: false,
    originalPrice: 0,
    grossCommission: 0,
    commissionRate: 0,
    hasInventory: true,
    sales: 0,
    detailLink: String(rawProduct?.detail_link || '')
  };

  return buildUnifiedComparableItem(norm, {
    targetPlatform: 'tiktok',
    sourceEffectivePrice: options.shopeeEffectivePrice || 0,
    cashbackPercent: options.cashbackPercent ?? 70,
    taxDeductPercent: options.taxDeductPercent ?? 10,
    matchScore: options.matchScore || 0,
    matchTier: options.matchTier || (options.matchScore >= 0.75 ? 'exact' : options.matchScore >= 0.6 ? 'high' : 'similar'),
    matchQuality: options.matchQuality || (options.matchScore >= 0.6 ? 'exact' : 'similar'),
    unitMatched: Boolean(options.unitMatched)
  });
}

/**
 * Shopee -> TikTok Shop Price & Cashback Comparison.
 */
async function searchComparableTikTokProducts(params = {}, runtimeOptions = {}) {
  const {
    shopeeTitle,
    shopeePrice = 0,
    shopeeEstimatedCashback = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    apiKey = ''
  } = params;

  const useCache = !runtimeOptions.disableCache;

  return runCrossPlatformCompare({
    targetPlatform: 'tiktok',
    sourceTitle: shopeeTitle,
    sourcePrice: shopeePrice,
    sourceEstimatedCashback: shopeeEstimatedCashback,
    cashbackPercent,
    taxDeductPercent,
    useCache,
    fetchCandidatesFn: (query, opts) =>
      fetchTikTokCandidates(query, {
        apiKey,
        pageSize: 20,
        timeoutMs: opts?.timeoutMs || 5000,
        fetchFn: runtimeOptions.fetchFn
      })
  });
}

/**
 * Backward-compatible Shopee candidate scorer.
 */
function scoreShopeeCandidate(tiktokTitle, tiktokPrice, rawCandidate) {
  const norm = normalizeShopeeRawProduct(rawCandidate);
  if (!norm) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'invalid_product_fields' };
  }
  return evaluateProductMatch(tiktokTitle, tiktokPrice, norm);
}

/**
 * Backward-compatible Shopee comparable product builder.
 */
function buildComparableShopeeProduct(rawProduct, options = {}) {
  const norm = normalizeShopeeRawProduct(rawProduct) || {
    id: String(rawProduct?.itemId || rawProduct?.id || ''),
    shopId: String(rawProduct?.shopId || ''),
    title: String(rawProduct?.productName || rawProduct?.title || ''),
    shopName: String(rawProduct?.shopName || 'Shopee'),
    imageUrl: String(rawProduct?.imageUrl || ''),
    price: 0,
    priceMin: 0,
    priceMax: 0,
    hasPriceRange: false,
    originalPrice: 0,
    grossCommission: 0,
    commissionRate: 0,
    hasInventory: true,
    sales: 0,
    detailLink: String(rawProduct?.productLink || '')
  };

  return buildUnifiedComparableItem(norm, {
    targetPlatform: 'shopee',
    sourceEffectivePrice: options.tiktokEffectivePrice || 0,
    cashbackPercent: options.cashbackPercent ?? 70,
    taxDeductPercent: options.taxDeductPercent ?? 10,
    matchScore: options.matchScore || 0,
    matchTier: options.matchTier || (options.matchScore >= 0.75 ? 'exact' : options.matchScore >= 0.6 ? 'high' : 'similar'),
    matchQuality: options.matchQuality || (options.matchScore >= 0.6 ? 'exact' : 'similar'),
    unitMatched: Boolean(options.unitMatched)
  });
}

/**
 * TikTok Shop -> Shopee Price & Cashback Comparison.
 */
async function searchComparableShopeeProducts(params = {}, runtimeOptions = {}) {
  const {
    tiktokTitle,
    tiktokPrice = 0,
    tiktokEstimatedCashback = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    appId = '',
    appSecret = '',
    addlivetagApiKey = ''
  } = params;

  const useCache = !runtimeOptions.disableCache;

  return runCrossPlatformCompare({
    targetPlatform: 'shopee',
    sourceTitle: tiktokTitle,
    sourcePrice: tiktokPrice,
    sourceEstimatedCashback: tiktokEstimatedCashback,
    cashbackPercent,
    taxDeductPercent,
    useCache,
    fetchCandidatesFn: (query, opts) =>
      fetchShopeeCandidates(query, {
        appId,
        appSecret,
        addlivetagApiKey,
        limit: 20,
        timeoutMs: opts?.timeoutMs || 5500,
        searchFn: runtimeOptions.searchShopeeFn || runtimeOptions.searchFn,
        addlivetagSearchFn: runtimeOptions.addlivetagSearchFn
      })
  });
}

function clearCompareCaches() {
  clearCacheStorage();
  resetCircuitBreakers();
}

module.exports = {
  ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS,
  TRANSPARENCY_DISCLAIMER,
  cleanShopeeTitleForSearch,
  buildShorterFallbackQuery,
  normalizeObfuscatedWords,
  extractDistinctiveBrandTokens,
  extractProductUnits,
  compareUnits,
  scoreTikTokCandidate,
  buildComparableProduct,
  fetchTikTokProductFeedsV2,
  searchComparableTikTokProducts,
  getVerifiedTikTokProduct,
  registerVerifiedTikTokProduct,
  scoreShopeeCandidate,
  buildComparableShopeeProduct,
  searchComparableShopeeProducts,
  getVerifiedShopeeProduct,
  registerVerifiedShopeeProduct,
  signVerifiedProductToken,
  verifyProductToken,
  resetCircuitBreakers,
  clearCompareCaches
};
