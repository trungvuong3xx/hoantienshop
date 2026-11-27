const logger = require('../utils/logger');
const { calculateCommissionSplit } = require('./dbService');
const { parseAccessTradeMoney, parseAccessTradeCommissionRate } = require('./tiktokService');
const { searchShopeeProductOffersByKeyword, searchAddlivetagShopeeMarket } = require('./shopeeService');

const ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS = 'https://api.accesstrade.vn/v2/tiktokshop_product_feeds';
const COMPARE_CACHE_TTL_MS = 10 * 60 * 1000;
const COMPARE_CACHE_MAX = 200;
const VERIFIED_PRODUCT_TTL_MS = 30 * 60 * 1000;
const VERIFIED_PRODUCT_MAX = 1000;
const MAX_COMPARE_RESULTS = 3;
const DEFAULT_SEARCH_LIMIT = 15;
const DEFAULT_SEARCH_TIMEOUT_MS = 6500;
const MIN_MATCH_SCORE = 0.34;
const PRICE_SIMILAR_THRESHOLD_VND = 1000;

const TRANSPARENCY_DISCLAIMER =
  'Giá và tiền hoàn được tính theo giá bán công khai và hoa hồng dự kiến tại thời điểm tra cứu. Chưa bao gồm voucher cá nhân, mã giảm giá riêng hoặc ưu đãi trong tài khoản của bạn. Tiền hoàn thực tế phụ thuộc vào điều kiện ghi nhận đơn hàng và đối soát của nền tảng.';

const compareSearchCache = new Map();
const inFlightCompareSearches = new Map();
const verifiedTikTokProducts = new Map();

const PROMO_PHRASES_REGEX =
  /\b(chinh hang|chinh\s*hang|hoa toc|giao nhanh|ship\s*24h|freeship|free\s*ship|mien phi van chuyen|gia re|sieu re|xa kho|sale\s*soc|deal\s*soc|flash\s*sale|tang\s*kem|qua\s*tang|gia\s*tot|hang\s*moi|new\s*202\d|auth|authentic|official|mall|fullbox|full\s*box|nhap\s*khau|cao\s*cap|loai\s*1|chuan\s*auth|sieu\s*hot|hot\s*trend)\b/gi;

const STOPWORDS = new Set([
  'cho', 'cua', 'voi', 'va', 'cac', 'loai', 'moi', 'nhat', 'cao', 'cap',
  'chinh', 'hang', 'gia', 'tot', 're', 'sieu', 'dep', 'xinh', 'nam', 'nu',
  'dung', 'khong', 'co', 'tu', 'den', 'tai', 'bo', 'set', 'combo', 'hop',
  'chai', 'tuyp', 'goi', 'tui', 'cai', 'chiec', 'san', 'pham', 'the', 'for',
  'and', 'with', 'new', 'hot', 'sale', 'free', 'ship', 'vn', 'viet', 'nam'
]);

function stripDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function sanitizeHttpsUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl.trim());
    return u.protocol === 'https:' ? u.toString() : '';
  } catch (_) {
    return '';
  }
}

function isValidTikTokDetailLink(rawUrl) {
  const safe = sanitizeHttpsUrl(rawUrl);
  if (!safe) return false;
  try {
    const u = new URL(safe);
    const host = u.hostname.toLowerCase();
    return host === 'shop.tiktok.com' || host === 'www.tiktok.com' || host.endsWith('.tiktok.com');
  } catch (_) {
    return false;
  }
}

/**
 * Clean Shopee product title into a focused TikTok Shop search query.
 * Removes promo tags ([Chính hãng], [Hỏa tốc], emojis, noise) while preserving brand, line, model, and volume/size.
 */
function cleanShopeeTitleForSearch(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';

  let text = rawTitle
    // Remove bracketed promotional tags like [CHÍNH HÃNG], [Hỏa tốc], 【Mall】
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\([^)]*(chính hãng|hỏa tốc|freeship|quà tặng|tặng kèm|mall|sale|auth|date)[^)]*\)/gi, ' ')
    // Remove emojis and symbols while keeping letters, digits, Vietnamese chars, +, ., -
    .replace(/[^\p{L}\p{N}\s+.\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove promotional Vietnamese/English phrases (diacritic-insensitive matching per token window)
  const words = text.split(' ').filter(Boolean);
  const cleanedWords = [];
  let i = 0;
  while (i < words.length) {
    const twoWord = i + 1 < words.length ? stripDiacritics(`${words[i]} ${words[i + 1]}`).toLowerCase() : '';
    const oneWord = stripDiacritics(words[i]).toLowerCase();
    if (twoWord && new RegExp(`^(${PROMO_PHRASES_REGEX.source})$`, 'i').test(twoWord)) {
      i += 2;
      continue;
    }
    if (new RegExp(`^(${PROMO_PHRASES_REGEX.source})$`, 'i').test(oneWord)) {
      i += 1;
      continue;
    }
    // Strip isolated punctuation tokens
    if (/^[+.\-]+$/.test(words[i])) {
      i += 1;
      continue;
    }
    cleanedWords.push(words[i]);
    i += 1;
  }

  // Deduplicate adjacent identical tokens and keep up to 10 high-signal words (max ~85 chars)
  const deduped = [];
  for (const w of cleanedWords) {
    const prev = deduped[deduped.length - 1];
    if (prev && stripDiacritics(prev).toLowerCase() === stripDiacritics(w).toLowerCase()) continue;
    deduped.push(w);
  }

  // Keep unit/model tokens even if they appear slightly later in the title
  const unitRegex = /^(\d+(?:[.,]\d+)?(?:ml|l|g|gr|kg|mg|oz|gb|tb|w|mah|cm|mm|spf\d+\+?)|spf\d+\+?)$/i;
  const head = deduped.slice(0, 9);
  const tailUnits = deduped.slice(9).filter((w) => unitRegex.test(stripDiacritics(w))).slice(0, 2);
  const combined = [...head, ...tailUnits];

  let query = combined.join(' ').replace(/\s+/g, ' ').trim();
  if (query.length > 85) {
    query = query.slice(0, 85).replace(/\s+\S*$/, '').trim();
  }
  return query;
}

/**
 * Build a shorter fallback query (first 5-6 key words + unit) when full query returns 0 results.
 */
function buildShorterFallbackQuery(cleanQuery) {
  const tokens = String(cleanQuery || '').split(/\s+/).filter(Boolean);
  if (tokens.length <= 5) return '';
  const unitRegex = /(\d+(?:[.,]\d+)?(?:ml|l|g|gr|kg|gb|tb|mah)|spf\d+)/i;
  const units = tokens.filter((t) => unitRegex.test(stripDiacritics(t)));
  const base = tokens.slice(0, 5);
  for (const u of units) {
    if (!base.includes(u)) base.push(u);
  }
  const shorter = base.join(' ').trim();
  return shorter && shorter !== cleanQuery ? shorter : '';
}

/**
 * Extract normalized volume/weight/capacity/pack units from a product title.
 */
function extractProductUnits(title) {
  const norm = stripDiacritics(title).toLowerCase();
  const units = [];

  // Volume (normalize to ml)
  for (const m of norm.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|l|lit)\b/g)) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0) continue;
    const isLiter = m[2] === 'l' || m[2] === 'lit';
    units.push({ type: 'volume', value: isLiter ? val * 1000 : val, raw: m[0].trim() });
  }

  // Weight (normalize to g)
  for (const m of norm.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gam|mg)\b/g)) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0) continue;
    let grams = val;
    if (m[2] === 'kg') grams = val * 1000;
    else if (m[2] === 'mg') grams = val / 1000;
    units.push({ type: 'weight', value: grams, raw: m[0].trim() });
  }

  // Storage capacity (normalize to GB)
  for (const m of norm.matchAll(/(\d+(?:[.,]\d+)?)\s*(gb|tb)\b/g)) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(val) || val <= 0) continue;
    units.push({ type: 'storage', value: m[2] === 'tb' ? val * 1024 : val, raw: m[0].trim() });
  }

  // Pack / count (e.g., 30 viên, 10 miếng, 2 chai, 3 bộ, 5 cái)
  for (const m of norm.matchAll(/\b(\d+)\s*(vien|mieng|goi|chai|tuyp|hop|cap|chiec|cai|doi|lon|thung|loc|quyen|cuon)\b/g)) {
    const val = parseInt(m[1], 10);
    if (!Number.isFinite(val) || val <= 0) continue;
    units.push({ type: 'count', value: val, raw: m[0].trim() });
  }

  // Multi-pack / Combo / Set / Bộ (e.g., "combo 3 bộ", "set 2", "5 đồ bộ", "combo 5")
  const packValues = new Set();
  for (const m of norm.matchAll(/\b(?:combo|set)\s*(\d+)\b/g)) {
    const val = parseInt(m[1], 10);
    if (Number.isFinite(val) && val >= 2 && val <= 50) packValues.add(val);
  }
  for (const m of norm.matchAll(/\b(\d+)\s*(?:do\s*)?bo\b/g)) {
    const val = parseInt(m[1], 10);
    if (Number.isFinite(val) && val >= 2 && val <= 50) packValues.add(val);
  }
  for (const val of packValues) {
    units.push({ type: 'pack', value: val, raw: `pack_${val}` });
  }

  return units;
}

/**
 * Extract meaningful tokens for similarity scoring.
 */
function tokenizeForMatching(title) {
  const norm = stripDiacritics(title)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();

  const rawTokens = norm.split(/\s+/).filter(Boolean);
  return rawTokens.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Evaluate compatibility between unit measurements of source and target titles.
 * Enforces strict multi-pack (combo/set/bộ) compatibility so single items never match combos,
 * and combo-3 never matches combo-5.
 * Returns { status: 'exact' | 'mismatch' | 'neutral' }.
 */
function compareUnits(sourceUnits, targetUnits) {
  const sPacks = sourceUnits.filter((u) => u.type === 'pack').map((u) => u.value);
  const tPacks = targetUnits.filter((u) => u.type === 'pack').map((u) => u.value);
  if (sPacks.length > 0 || tPacks.length > 0) {
    // Reject single-item vs multi-pack mismatch
    if (sPacks.length === 0 || tPacks.length === 0) {
      return { status: 'mismatch' };
    }
    const samePack = sPacks.some((sv) => tPacks.includes(sv));
    if (!samePack) {
      return { status: 'mismatch' };
    }
  }

  if (!sourceUnits.length || !targetUnits.length) {
    return { status: 'neutral' };
  }

  const sharedTypes = new Set(
    sourceUnits.map((u) => u.type).filter((t) => targetUnits.some((tu) => tu.type === t))
  );
  if (sharedTypes.size === 0) {
    return { status: 'neutral' };
  }

  let matchedAny = false;
  for (const type of sharedTypes) {
    const sVals = sourceUnits.filter((u) => u.type === type).map((u) => u.value);
    const tVals = targetUnits.filter((u) => u.type === type).map((u) => u.value);
    const tolerance = type === 'pack' || type === 'count' ? 0 : 0.1;
    const hasCloseMatch = sVals.some((sv) =>
      tVals.some((tv) =>
        tolerance === 0
          ? sv === tv
          : Math.abs(sv - tv) / Math.max(sv, tv, 1) <= tolerance
      )
    );
    if (!hasCloseMatch) {
      return { status: 'mismatch' };
    }
    matchedAny = true;
  }

  return { status: matchedAny ? 'exact' : 'neutral' };
}

/**
 * Extract valid TikTok product price (prefers sales_price, falls back to original_price).
 */
function extractTikTokPrice(rawProd) {
  const sp = rawProd?.sales_price || {};
  const op = rawProd?.original_price || {};
  const saleMin = parseAccessTradeMoney(sp.minimum_amount ?? sp.amount);
  const saleMax = parseAccessTradeMoney(sp.maximum_amount);
  const origMin = parseAccessTradeMoney(op.minimum_amount ?? op.amount);
  const origMax = parseAccessTradeMoney(op.maximum_amount);

  const price = saleMin || saleMax || origMin || origMax || 0;
  const originalPrice = origMin || origMax || price;
  return { price, originalPrice };
}

/**
 * Extract valid TikTok gross commission from AccessTrade API payload.
 * Never invents a default commission rate if API returns 0/null/invalid.
 */
function extractTikTokCommission(rawProd, price) {
  const commObj = rawProd?.commission || {};
  const rawAmount = Number(commObj.amount);
  const grossCommission =
    Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount) : 0;

  const rawRate = commObj.rate ?? rawProd?.commission_rate;
  const commissionRate =
    grossCommission > 0
      ? parseAccessTradeCommissionRate(rawRate, grossCommission, price)
      : 0;

  return { grossCommission, commissionRate };
}

/**
 * Score how well a TikTok product candidate matches the Shopee product.
 */
function scoreTikTokCandidate(shopeeTitle, shopeePrice, rawProd) {
  const title = String(rawProd?.title || '').trim();
  const id = String(rawProd?.id || '').trim();
  const detailLink = String(rawProd?.detail_link || '').trim();

  if (!id || !/^\d{6,30}$/.test(id) || !title || !isValidTikTokDetailLink(detailLink)) {
    return { eligible: false, score: 0, reason: 'invalid_product_fields' };
  }
  if (rawProd?.has_inventory === false) {
    return { eligible: false, score: 0, reason: 'out_of_stock' };
  }

  const { price } = extractTikTokPrice(rawProd);
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, score: 0, reason: 'invalid_price' };
  }

  const shopeeTokens = tokenizeForMatching(shopeeTitle);
  const tiktokTokens = tokenizeForMatching(title);
  if (shopeeTokens.length === 0 || tiktokTokens.length === 0) {
    return { eligible: false, score: 0, reason: 'empty_tokens' };
  }

  // Unit/volume/weight compatibility guard
  const shopeeUnits = extractProductUnits(shopeeTitle);
  const tiktokUnits = extractProductUnits(title);
  const unitCheck = compareUnits(shopeeUnits, tiktokUnits);
  if (unitCheck.status === 'mismatch') {
    return { eligible: false, score: 0, reason: 'unit_mismatch' };
  }

  // Price sanity guard (prevent matching a 15k sample/accessory against a 400k full-size product)
  const validShopeePrice = Number(shopeePrice);
  if (Number.isFinite(validShopeePrice) && validShopeePrice > 0) {
    const ratio = price / validShopeePrice;
    if (ratio < 0.25 || ratio > 3.5) {
      return { eligible: false, score: 0, reason: 'price_outlier' };
    }
  }

  const tiktokSet = new Set(tiktokTokens);
  const shopeeUnique = Array.from(new Set(shopeeTokens));

  let matchedCount = 0;
  let weightedMatched = 0;
  let totalWeight = 0;
  let modelOrNumericMatched = 0;

  shopeeUnique.forEach((tok, idx) => {
    const isModelOrNum = /\d/.test(tok);
    const isLeadingBrandToken = idx < 3;
    const weight = isModelOrNum ? 2.0 : isLeadingBrandToken ? 1.6 : 1.0;
    totalWeight += weight;

    if (tiktokSet.has(tok)) {
      matchedCount++;
      weightedMatched += weight;
      if (isModelOrNum) modelOrNumericMatched++;
    }
  });

  if (matchedCount < 2 && shopeeUnique.length >= 2) {
    return { eligible: false, score: 0, reason: 'insufficient_keyword_overlap' };
  }

  const recall = totalWeight > 0 ? weightedMatched / totalWeight : 0;
  const precision = tiktokTokens.length > 0 ? matchedCount / new Set(tiktokTokens).size : 0;
  let score = recall * 0.72 + precision * 0.28;

  if (unitCheck.status === 'exact') {
    score += 0.14;
  }
  if (modelOrNumericMatched > 0) {
    score += 0.06;
  }

  // Slight boost for products with verified sales
  const unitsSold = Number(rawProd?.units_sold || 0);
  if (Number.isFinite(unitsSold) && unitsSold > 0) {
    score += Math.min(0.05, Math.log10(unitsSold + 1) * 0.015);
  }

  const finalScore = Number(Math.min(1, score).toFixed(4));
  if (finalScore < MIN_MATCH_SCORE) {
    return { eligible: false, score: finalScore, reason: 'below_threshold' };
  }

  return { eligible: true, score: finalScore, unitMatch: unitCheck.status };
}

/**
 * Compute comparison metrics for a matched TikTok product against Shopee effective price.
 */
function buildComparableProduct(rawProd, options = {}) {
  const {
    shopeeEffectivePrice = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    matchScore = 0
  } = options;

  const { price, originalPrice } = extractTikTokPrice(rawProd);
  const { grossCommission, commissionRate } = extractTikTokCommission(rawProd, price);

  const split =
    grossCommission > 0
      ? calculateCommissionSplit(grossCommission, cashbackPercent, taxDeductPercent)
      : {
          grossCommission: 0,
          taxDeductPercent,
          taxAmount: 0,
          netCommission: 0,
          cashbackRate: cashbackPercent,
          userCashbackAmount: 0,
          adminShareAmount: 0
        };

  const estimatedCashback = split.userCashbackAmount;
  const effectivePrice = Math.max(0, price - estimatedCashback);

  let savingsVsShopee = null;
  let comparisonStatus = 'no_shopee_price';
  let comparisonLabel = '';

  if (Number.isFinite(shopeeEffectivePrice) && shopeeEffectivePrice > 0 && effectivePrice > 0) {
    savingsVsShopee = Math.round(shopeeEffectivePrice - effectivePrice);
    if (savingsVsShopee >= PRICE_SIMILAR_THRESHOLD_VND) {
      comparisonStatus = 'tiktok_cheaper';
      comparisonLabel = `TikTok Shop rẻ hơn ${savingsVsShopee.toLocaleString('vi-VN')}đ`;
    } else if (savingsVsShopee <= -PRICE_SIMILAR_THRESHOLD_VND) {
      comparisonStatus = 'shopee_cheaper';
      comparisonLabel = `Shopee rẻ hơn ${Math.abs(savingsVsShopee).toLocaleString('vi-VN')}đ`;
    } else {
      comparisonStatus = 'similar';
      comparisonLabel = 'Giá tương đương';
    }
  }

  return {
    productId: String(rawProd.id).trim(),
    title: String(rawProd.title || '').trim(),
    shopName: String(rawProd?.shop?.name || '').trim() || 'TikTok Shop',
    imageUrl: sanitizeHttpsUrl(rawProd?.main_image_url),
    detailLink: String(rawProd.detail_link).trim(),
    price,
    originalPrice,
    grossCommission: split.grossCommission,
    commissionRate,
    estimatedCashback,
    effectivePrice,
    savingsVsShopee,
    comparisonStatus,
    comparisonLabel,
    unitsSold: Number(rawProd?.units_sold || 0) || 0,
    matchScore
  };
}

function registerVerifiedTikTokProduct(product) {
  if (!product?.productId || !product?.detailLink) return;
  if (verifiedTikTokProducts.size >= VERIFIED_PRODUCT_MAX) {
    const oldestKey = verifiedTikTokProducts.keys().next().value;
    if (oldestKey !== undefined) verifiedTikTokProducts.delete(oldestKey);
  }
  verifiedTikTokProducts.set(product.productId, {
    productId: product.productId,
    detailLink: product.detailLink,
    title: product.title,
    imageUrl: product.imageUrl,
    price: product.price,
    grossCommission: product.grossCommission,
    commissionRate: product.commissionRate,
    shopName: product.shopName,
    expiresAt: Date.now() + VERIFIED_PRODUCT_TTL_MS
  });
}

function getVerifiedTikTokProduct(productId) {
  const cleanId = String(productId || '').trim();
  if (!/^\d{6,30}$/.test(cleanId)) return null;
  const entry = verifiedTikTokProducts.get(cleanId);
  if (entry) {
    if (entry.expiresAt > Date.now()) {
      return entry;
    }
    verifiedTikTokProducts.delete(cleanId);
  }
  return null;
}

/**
 * Call AccessTrade GET /v2/tiktokshop_product_feeds with strict timeout and clear error classification.
 */
async function fetchTikTokProductFeedsV2(query, apiKey, options = {}) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    const err = new Error('Chưa cấu hình AccessTrade API Key để tìm sản phẩm TikTok Shop.');
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SEARCH_TIMEOUT_MS;
  const limit = Math.min(20, Math.max(1, Number(options.limit) || DEFAULT_SEARCH_LIMIT));

  const url = new URL(ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS);
  url.searchParams.set('title_keywords', query);
  url.searchParams.set('limit', String(limit));

  logger.logEnter('fetchTikTokProductFeedsV2', { queryLength: query.length, limit });

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
    const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout|aborted/i.test(String(err?.message || ''));
    const wrapped = new Error(
      isTimeout
        ? 'Kết nối tìm kiếm TikTok Shop tạm thời quá thời gian chờ.'
        : 'Không thể kết nối máy chủ tìm kiếm TikTok Shop.'
    );
    wrapped.code = isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR';
    logger.warning('fetchTikTokProductFeedsV2', 'Request failed', { code: wrapped.code });
    throw wrapped;
  }

  if (!response.ok) {
    const status = response.status;
    let code = 'UPSTREAM_ERROR';
    let msg = 'Hệ thống đối chiếu TikTok Shop tạm thời không phản hồi.';
    if (status === 401 || status === 403) {
      code = 'AUTH_ERROR';
      msg = 'Không thể xác thực kết nối dữ liệu TikTok Shop lúc này.';
    } else if (status === 429) {
      code = 'RATE_LIMITED';
      msg = 'Hệ thống tìm kiếm TikTok Shop đang bận, vui lòng thử lại sau ít giây.';
    }
    const err = new Error(msg);
    err.code = code;
    err.httpStatus = status;
    logger.warning('fetchTikTokProductFeedsV2', 'Upstream HTTP error', { status, code });
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    const err = new Error('Dữ liệu trả về từ TikTok Shop không hợp lệ.');
    err.code = 'INVALID_JSON';
    throw err;
  }

  const products = Array.isArray(payload?.data?.products) ? payload.data.products : [];
  logger.logLeave('fetchTikTokProductFeedsV2', { returned: products.length });
  return products;
}

function getCacheKey(cleanQuery, shopeePrice, shopeeEstimatedCashback, cashbackPercent, taxDeductPercent) {
  const priceBucket = shopeePrice > 0 ? Math.round(shopeePrice / 1000) : 0;
  const cbBucket = shopeeEstimatedCashback > 0 ? Math.round(shopeeEstimatedCashback / 500) : 0;
  return `${stripDiacritics(cleanQuery).toLowerCase()}|p:${priceBucket}|c:${cbBucket}|r:${cashbackPercent}|t:${taxDeductPercent}`;
}

/**
 * Main comparison entry point: Shopee title & pricing -> top 1-3 matched TikTok Shop products with cashback & net price.
 */
async function searchComparableTikTokProducts(params = {}, options = {}) {
  const {
    shopeeTitle = '',
    shopeePrice = 0,
    shopeeEstimatedCashback = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    apiKey = ''
  } = params;

  logger.logEnter('searchComparableTikTokProducts', {
    hasTitle: Boolean(shopeeTitle),
    shopeePrice: Number(shopeePrice || 0)
  });

  const cleanQuery = cleanShopeeTitleForSearch(shopeeTitle);
  if (!cleanQuery || cleanQuery.length < 3) {
    logger.logLeave('searchComparableTikTokProducts', { found: false, reason: 'invalid_query' });
    return {
      ok: true,
      found: false,
      query: cleanQuery,
      shopeePrice: Math.max(0, Math.round(Number(shopeePrice) || 0)),
      shopeeEstimatedCashback: Math.max(0, Math.round(Number(shopeeEstimatedCashback) || 0)),
      shopeeEffectivePrice: Math.max(
        0,
        Math.round(Number(shopeePrice) || 0) - Math.round(Number(shopeeEstimatedCashback) || 0)
      ),
      items: [],
      bestComparison: null,
      disclaimer: TRANSPARENCY_DISCLAIMER,
      message: 'Chưa đủ thông tin tên sản phẩm Shopee để tìm sản phẩm tương đương trên TikTok Shop.',
      cached: false
    };
  }

  const safeShopeePrice = Number.isFinite(Number(shopeePrice)) && Number(shopeePrice) > 0 ? Math.round(Number(shopeePrice)) : 0;
  const safeShopeeCb =
    Number.isFinite(Number(shopeeEstimatedCashback)) && Number(shopeeEstimatedCashback) > 0
      ? Math.round(Number(shopeeEstimatedCashback))
      : 0;
  const shopeeEffectivePrice = safeShopeePrice > 0 ? Math.max(0, safeShopeePrice - safeShopeeCb) : 0;

  const cacheKey = getCacheKey(cleanQuery, safeShopeePrice, safeShopeeCb, cashbackPercent, taxDeductPercent);
  const useCache = options.bypassCache !== true;

  if (useCache) {
    const cached = compareSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      for (const item of cached.verifiedItems || []) {
        registerVerifiedTikTokProduct(item);
      }
      logger.logLeave('searchComparableTikTokProducts', { cached: true, count: cached.value.items.length });
      return { ...cached.value, cached: true };
    }
    if (cached) {
      compareSearchCache.delete(cacheKey);
    }

    if (inFlightCompareSearches.has(cacheKey)) {
      const sharedResult = await inFlightCompareSearches.get(cacheKey);
      return { ...sharedResult, cached: true };
    }
  }

  const taskPromise = (async () => {
    let rawProducts = await fetchTikTokProductFeedsV2(cleanQuery, apiKey, options);

    // If full query returned 0 products, try one shorter fallback query
    if (rawProducts.length === 0) {
      const fallbackQuery = buildShorterFallbackQuery(cleanQuery);
      if (fallbackQuery) {
        rawProducts = await fetchTikTokProductFeedsV2(fallbackQuery, apiKey, options);
      }
    }

    const scored = [];
    const seenIds = new Set();
    for (const rawProd of rawProducts) {
      const id = String(rawProd?.id || '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const evaluation = scoreTikTokCandidate(shopeeTitle, safeShopeePrice, rawProd);
      if (!evaluation.eligible) continue;

      const item = buildComparableProduct(rawProd, {
        shopeeEffectivePrice,
        cashbackPercent,
        taxDeductPercent,
        matchScore: evaluation.score
      });
      scored.push(item);
    }

    // Sort by relevance first, then lowest effective price for close scores
    scored.sort((a, b) => {
      if (Math.abs(b.matchScore - a.matchScore) > 0.08) {
        return b.matchScore - a.matchScore;
      }
      return a.effectivePrice - b.effectivePrice;
    });

    const topItems = scored.slice(0, MAX_COMPARE_RESULTS);
    for (const item of topItems) {
      registerVerifiedTikTokProduct(item);
    }

    // Compute overall headline comparison against best TikTok effective price
    let bestComparison = null;
    if (topItems.length > 0 && shopeeEffectivePrice > 0) {
      const cheapestTikTok = topItems.reduce((best, cur) =>
        cur.effectivePrice < best.effectivePrice ? cur : best
      );
      bestComparison = {
        status: cheapestTikTok.comparisonStatus,
        label: cheapestTikTok.comparisonLabel,
        savingsVsShopee: cheapestTikTok.savingsVsShopee,
        bestTikTokEffectivePrice: cheapestTikTok.effectivePrice,
        bestTikTokProductId: cheapestTikTok.productId
      };
    }

    // Strip internal detailLink and gross margin metrics before returning to public frontend
    const publicItems = topItems.map(({ detailLink, grossCommission, commissionRate, ...publicFields }) => ({
      ...publicFields,
      matchQuality: publicFields.matchScore >= 0.65 ? 'exact' : 'similar'
    }));

    const result = {
      ok: true,
      found: publicItems.length > 0,
      query: cleanQuery,
      shopeePrice: safeShopeePrice,
      shopeeEstimatedCashback: safeShopeeCb,
      shopeeEffectivePrice,
      items: publicItems,
      bestComparison,
      disclaimer: TRANSPARENCY_DISCLAIMER,
      message:
        publicItems.length > 0
          ? ''
          : 'Chưa tìm thấy sản phẩm tương đương đủ độ chính xác trên TikTok Shop.',
      cached: false
    };

    if (useCache) {
      if (compareSearchCache.size >= COMPARE_CACHE_MAX) {
        const oldestKey = compareSearchCache.keys().next().value;
        if (oldestKey !== undefined) compareSearchCache.delete(oldestKey);
      }
      // Keep full items internally in cache only for re-registering verifiedTikTokProducts
      compareSearchCache.set(cacheKey, {
        expiresAt: Date.now() + COMPARE_CACHE_TTL_MS,
        value: result,
        verifiedItems: topItems
      });
    }

    logger.logLeave('searchComparableTikTokProducts', {
      found: result.found,
      count: publicItems.length,
      bestStatus: bestComparison?.status || 'none'
    });
    return result;
  })();

  if (useCache) {
    inFlightCompareSearches.set(cacheKey, taskPromise);
  }
  try {
    return await taskPromise;
  } finally {
    inFlightCompareSearches.delete(cacheKey);
  }
}

const verifiedShopeeProducts = new Map();

function isValidShopeeProductLink(rawUrl) {
  const safe = sanitizeHttpsUrl(rawUrl);
  if (!safe) return false;
  try {
    const u = new URL(safe);
    const host = u.hostname.toLowerCase();
    return host === 'shopee.vn' || host === 'www.shopee.vn' || host.endsWith('.shopee.vn');
  } catch (_) {
    return false;
  }
}

function registerVerifiedShopeeProduct(product) {
  if (!product?.itemId || !product?.productLink) return;
  if (verifiedShopeeProducts.size >= VERIFIED_PRODUCT_MAX) {
    const oldestKey = verifiedShopeeProducts.keys().next().value;
    if (oldestKey !== undefined) verifiedShopeeProducts.delete(oldestKey);
  }
  verifiedShopeeProducts.set(String(product.itemId), {
    itemId: String(product.itemId),
    shopId: String(product.shopId || ''),
    productLink: product.productLink,
    title: product.title,
    imageUrl: product.imageUrl,
    price: product.price,
    grossCommission: product.grossCommission,
    commissionRate: product.commissionRate,
    shopName: product.shopName,
    expiresAt: Date.now() + VERIFIED_PRODUCT_TTL_MS
  });
}

function getVerifiedShopeeProduct(itemId) {
  const cleanId = String(itemId || '').trim();
  if (!/^\d{4,30}$/.test(cleanId)) return null;
  const entry = verifiedShopeeProducts.get(cleanId);
  if (entry) {
    if (entry.expiresAt > Date.now()) {
      return entry;
    }
    verifiedShopeeProducts.delete(cleanId);
  }
  return null;
}

/**
 * Score how well a Shopee product candidate matches a TikTok Shop product.
 */
function scoreShopeeCandidate(tiktokTitle, tiktokPrice, rawNode) {
  const title = String(rawNode?.productName || rawNode?.title || '').trim();
  const itemId = String(rawNode?.itemId || '').trim();
  const shopId = String(rawNode?.shopId || '').trim();
  const rawLink = String(rawNode?.productLink || '').trim();
  const resolvedLink = isValidShopeeProductLink(rawLink)
    ? rawLink
    : shopId && itemId
    ? `https://shopee.vn/product/${shopId}/${itemId}`
    : '';

  if (!itemId || !/^\d{4,30}$/.test(itemId) || !title || !resolvedLink) {
    return { eligible: false, score: 0, reason: 'invalid_product_fields' };
  }

  const price = parseAccessTradeMoney(rawNode?.price) || parseAccessTradeMoney(rawNode?.priceMin) || 0;
  if (!Number.isFinite(price) || price <= 0) {
    return { eligible: false, score: 0, reason: 'invalid_price' };
  }

  const sourceTokens = tokenizeForMatching(tiktokTitle);
  const targetTokens = tokenizeForMatching(title);
  if (sourceTokens.length === 0 || targetTokens.length === 0) {
    return { eligible: false, score: 0, reason: 'empty_tokens' };
  }

  const sourceUnits = extractProductUnits(tiktokTitle);
  const targetUnits = extractProductUnits(title);
  const unitCheck = compareUnits(sourceUnits, targetUnits);
  if (unitCheck.status === 'mismatch') {
    return { eligible: false, score: 0, reason: 'unit_mismatch' };
  }

  const validSourcePrice = Number(tiktokPrice);
  if (Number.isFinite(validSourcePrice) && validSourcePrice > 0) {
    const ratio = price / validSourcePrice;
    if (ratio < 0.25 || ratio > 3.5) {
      return { eligible: false, score: 0, reason: 'price_outlier' };
    }
  }

  const targetSet = new Set(targetTokens);
  const sourceUnique = Array.from(new Set(sourceTokens));

  let matchedCount = 0;
  let weightedMatched = 0;
  let totalWeight = 0;
  let modelOrNumericMatched = 0;

  sourceUnique.forEach((tok, idx) => {
    const isModelOrNum = /\d/.test(tok);
    const isLeadingBrandToken = idx < 3;
    const weight = isModelOrNum ? 2.0 : isLeadingBrandToken ? 1.6 : 1.0;
    totalWeight += weight;

    if (targetSet.has(tok)) {
      matchedCount++;
      weightedMatched += weight;
      if (isModelOrNum) modelOrNumericMatched++;
    }
  });

  if (matchedCount < 2 && sourceUnique.length >= 2) {
    return { eligible: false, score: 0, reason: 'insufficient_keyword_overlap' };
  }

  const recall = totalWeight > 0 ? weightedMatched / totalWeight : 0;
  const precision = targetTokens.length > 0 ? matchedCount / new Set(targetTokens).size : 0;
  let score = recall * 0.72 + precision * 0.28;

  if (unitCheck.status === 'exact') score += 0.14;
  if (modelOrNumericMatched > 0) score += 0.06;

  const sales = Number(rawNode?.sales || 0);
  if (Number.isFinite(sales) && sales > 0) {
    score += Math.min(0.05, Math.log10(sales + 1) * 0.015);
  }

  const finalScore = Number(Math.min(1, score).toFixed(4));
  if (finalScore < MIN_MATCH_SCORE) {
    return { eligible: false, score: finalScore, reason: 'below_threshold' };
  }

  return { eligible: true, score: finalScore, unitMatch: unitCheck.status, productLink: resolvedLink };
}

/**
 * Compute comparison metrics for a matched Shopee product against TikTok effective price.
 */
function buildComparableShopeeProduct(rawNode, options = {}) {
  const {
    tiktokEffectivePrice = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    matchScore = 0,
    productLink = ''
  } = options;

  const price = parseAccessTradeMoney(rawNode?.price) || parseAccessTradeMoney(rawNode?.priceMin) || 0;
  const rawCommRate = Number(rawNode?.commissionRate || 0);
  const commissionRate =
    Number.isFinite(rawCommRate) && rawCommRate > 0
      ? Number((rawCommRate < 1 ? rawCommRate * 100 : rawCommRate).toFixed(2))
      : 0;
  const rawDirectComm = parseAccessTradeMoney(rawNode?.commission);
  const grossCommission =
    Number.isFinite(rawDirectComm) && rawDirectComm > 0
      ? Math.round(rawDirectComm)
      : commissionRate > 0 && price > 0
      ? Math.round((price * commissionRate) / 100)
      : 0;

  const split =
    grossCommission > 0
      ? calculateCommissionSplit(grossCommission, cashbackPercent, taxDeductPercent)
      : {
          grossCommission: 0,
          taxDeductPercent,
          taxAmount: 0,
          netCommission: 0,
          cashbackRate: cashbackPercent,
          userCashbackAmount: 0,
          adminShareAmount: 0
        };

  const estimatedCashback = split.userCashbackAmount;
  const effectivePrice = Math.max(0, price - estimatedCashback);

  let savingsVsTikTok = null;
  let comparisonStatus = 'no_source_price';
  let comparisonLabel = '';

  if (Number.isFinite(tiktokEffectivePrice) && tiktokEffectivePrice > 0 && effectivePrice > 0) {
    savingsVsTikTok = Math.round(tiktokEffectivePrice - effectivePrice);
    if (savingsVsTikTok >= PRICE_SIMILAR_THRESHOLD_VND) {
      comparisonStatus = 'target_cheaper';
      comparisonLabel = `Shopee rẻ hơn ${savingsVsTikTok.toLocaleString('vi-VN')}đ`;
    } else if (savingsVsTikTok <= -PRICE_SIMILAR_THRESHOLD_VND) {
      comparisonStatus = 'source_cheaper';
      comparisonLabel = `TikTok Shop rẻ hơn ${Math.abs(savingsVsTikTok).toLocaleString('vi-VN')}đ`;
    } else {
      comparisonStatus = 'similar';
      comparisonLabel = 'Giá tương đương';
    }
  }

  return {
    itemId: String(rawNode.itemId).trim(),
    shopId: String(rawNode.shopId || '').trim(),
    productId: String(rawNode.itemId).trim(),
    title: String(rawNode.productName || rawNode.title || '').trim(),
    shopName: String(rawNode.shopName || '').trim() || 'Shopee',
    imageUrl: sanitizeHttpsUrl(rawNode.imageUrl),
    productLink,
    price,
    grossCommission: split.grossCommission,
    commissionRate,
    estimatedCashback,
    effectivePrice,
    savingsVsSource: savingsVsTikTok,
    comparisonStatus,
    comparisonLabel,
    sales: Number(rawNode.sales || 0) || 0,
    matchScore
  };
}

/**
 * Reverse comparison entry point: TikTok Shop title & pricing -> top 1-3 matched Shopee products.
 */
async function searchComparableShopeeProducts(params = {}, options = {}) {
  const {
    tiktokTitle = '',
    tiktokPrice = 0,
    tiktokEstimatedCashback = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    appId = '',
    appSecret = '',
    addlivetagApiKey = ''
  } = params;

  logger.logEnter('searchComparableShopeeProducts', {
    hasTitle: Boolean(tiktokTitle),
    tiktokPrice: Number(tiktokPrice || 0)
  });

  const cleanQuery = cleanShopeeTitleForSearch(tiktokTitle);
  const safeTiktokPrice =
    Number.isFinite(Number(tiktokPrice)) && Number(tiktokPrice) > 0 ? Math.round(Number(tiktokPrice)) : 0;
  const safeTiktokCb =
    Number.isFinite(Number(tiktokEstimatedCashback)) && Number(tiktokEstimatedCashback) > 0
      ? Math.round(Number(tiktokEstimatedCashback))
      : 0;
  const tiktokEffectivePrice = safeTiktokPrice > 0 ? Math.max(0, safeTiktokPrice - safeTiktokCb) : 0;

  if (!cleanQuery || cleanQuery.length < 3) {
    logger.logLeave('searchComparableShopeeProducts', { found: false, reason: 'invalid_query' });
    return {
      ok: true,
      found: false,
      targetPlatform: 'shopee',
      query: cleanQuery,
      sourcePrice: safeTiktokPrice,
      sourceEstimatedCashback: safeTiktokCb,
      sourceEffectivePrice: tiktokEffectivePrice,
      items: [],
      bestComparison: null,
      disclaimer: TRANSPARENCY_DISCLAIMER,
      message: 'Chưa đủ thông tin tên sản phẩm TikTok Shop để tìm sản phẩm tương đương trên Shopee.',
      cached: false
    };
  }

  const cacheKey = `shopee:${getCacheKey(cleanQuery, safeTiktokPrice, safeTiktokCb, cashbackPercent, taxDeductPercent)}`;
  const useCache = options.bypassCache !== true;

  if (useCache) {
    const cached = compareSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      for (const item of cached.verifiedItems || []) {
        registerVerifiedShopeeProduct(item);
      }
      logger.logLeave('searchComparableShopeeProducts', { cached: true, count: cached.value.items.length });
      return { ...cached.value, cached: true };
    }
    if (cached) compareSearchCache.delete(cacheKey);
    if (inFlightCompareSearches.has(cacheKey)) {
      const shared = await inFlightCompareSearches.get(cacheKey);
      return { ...shared, cached: true };
    }
  }

  const hasOpenApi = Boolean(String(appId || '').trim() && String(appSecret || '').trim());
  const cleanAddlivetagKey = String(addlivetagApiKey || '').trim();

  const searchFn =
    options.searchShopeeFn ||
    (async (query, _appId, _appSecret, limit) => {
      if (hasOpenApi) {
        try {
          const openApiRows = await searchShopeeProductOffersByKeyword(query, appId, appSecret, limit);
          if (openApiRows.length > 0 || !cleanAddlivetagKey) {
            return openApiRows;
          }
        } catch (openApiErr) {
          if (!cleanAddlivetagKey) throw openApiErr;
          logger.warning('searchComparableShopeeProducts', 'Shopee Open API failed, falling back to AddLiveTag', {
            error: openApiErr.message
          });
        }
      }
      if (cleanAddlivetagKey) {
        return searchAddlivetagShopeeMarket(query, cleanAddlivetagKey, limit);
      }
      const err = new Error('Chưa cấu hình nguồn dữ liệu Shopee (Open API hoặc AddLiveTag API Key).');
      err.code = 'MISSING_API_KEY';
      throw err;
    });

  const taskPromise = (async () => {
    let rawNodes = await searchFn(cleanQuery, appId, appSecret, DEFAULT_SEARCH_LIMIT);

    if (rawNodes.length === 0) {
      const fallbackQuery = buildShorterFallbackQuery(cleanQuery);
      if (fallbackQuery) {
        rawNodes = await searchFn(fallbackQuery, appId, appSecret, DEFAULT_SEARCH_LIMIT);
      }
    }

    const scored = [];
    const seenIds = new Set();
    for (const rawNode of rawNodes) {
      const id = String(rawNode?.itemId || '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const evaluation = scoreShopeeCandidate(tiktokTitle, safeTiktokPrice, rawNode);
      if (!evaluation.eligible) continue;

      scored.push(
        buildComparableShopeeProduct(rawNode, {
          tiktokEffectivePrice,
          cashbackPercent,
          taxDeductPercent,
          matchScore: evaluation.score,
          productLink: evaluation.productLink
        })
      );
    }

    scored.sort((a, b) => {
      if (Math.abs(b.matchScore - a.matchScore) > 0.08) {
        return b.matchScore - a.matchScore;
      }
      return a.effectivePrice - b.effectivePrice;
    });

    const topItems = scored.slice(0, MAX_COMPARE_RESULTS);
    for (const item of topItems) {
      registerVerifiedShopeeProduct(item);
    }

    let bestComparison = null;
    if (topItems.length > 0 && tiktokEffectivePrice > 0) {
      const cheapest = topItems.reduce((best, cur) =>
        cur.effectivePrice < best.effectivePrice ? cur : best
      );
      bestComparison = {
        status: cheapest.comparisonStatus,
        label: cheapest.comparisonLabel,
        savingsVsSource: cheapest.savingsVsSource,
        bestEffectivePrice: cheapest.effectivePrice,
        bestProductId: cheapest.itemId
      };
    }

    // Strip internal productLink and gross margin metrics before returning to public frontend
    const publicItems = topItems.map(({ productLink, grossCommission, commissionRate, ...publicFields }) => ({
      ...publicFields,
      matchQuality: publicFields.matchScore >= 0.65 ? 'exact' : 'similar'
    }));

    const result = {
      ok: true,
      found: publicItems.length > 0,
      targetPlatform: 'shopee',
      query: cleanQuery,
      sourcePrice: safeTiktokPrice,
      sourceEstimatedCashback: safeTiktokCb,
      sourceEffectivePrice: tiktokEffectivePrice,
      items: publicItems,
      bestComparison,
      disclaimer: TRANSPARENCY_DISCLAIMER,
      message:
        publicItems.length > 0
          ? ''
          : 'Chưa tìm thấy sản phẩm tương đương đủ độ chính xác trên Shopee.',
      cached: false
    };

    if (useCache) {
      if (compareSearchCache.size >= COMPARE_CACHE_MAX) {
        const oldestKey = compareSearchCache.keys().next().value;
        if (oldestKey !== undefined) compareSearchCache.delete(oldestKey);
      }
      compareSearchCache.set(cacheKey, {
        expiresAt: Date.now() + COMPARE_CACHE_TTL_MS,
        value: result,
        verifiedItems: topItems
      });
    }

    logger.logLeave('searchComparableShopeeProducts', {
      found: result.found,
      count: publicItems.length,
      bestStatus: bestComparison?.status || 'none'
    });
    return result;
  })();

  if (useCache) inFlightCompareSearches.set(cacheKey, taskPromise);
  try {
    return await taskPromise;
  } finally {
    inFlightCompareSearches.delete(cacheKey);
  }
}

function clearCompareCaches() {
  compareSearchCache.clear();
  inFlightCompareSearches.clear();
  verifiedTikTokProducts.clear();
  verifiedShopeeProducts.clear();
}

module.exports = {
  ACCESSTRADE_TIKTOK_V2_PRODUCT_FEEDS,
  TRANSPARENCY_DISCLAIMER,
  cleanShopeeTitleForSearch,
  buildShorterFallbackQuery,
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
  clearCompareCaches
};
