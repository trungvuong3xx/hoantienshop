const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');
const { isAllowedHost } = require('./urlResolver');

const SHOPEE_GRAPHQL_ENDPOINT = 'https://open-api.affiliate.shopee.vn/graphql';
const DEFAULT_ADDLIVETAG_API_KEY = (process.env.ADDLIVETAG_API_KEY || '').trim();

// Cache for Shopee Open API short links and product metadata to respect rate limits
const linkCache = new Map();
const productMetaCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCached(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    map.delete(key);
    return null;
  }
  return entry.val;
}

function setCached(map, key, val) {
  if (map.size > 500) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
}

function parseSubIds(subIdInput) {
  if (!subIdInput) return { subIdStr: '', subIdArr: [] };
  const rawParts = String(subIdInput)
    .split(/[-,\s]+/)
    .map((s) => s.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 50))
    .filter(Boolean)
    .slice(0, 5);

  return {
    subIdStr: rawParts.join('-'),
    subIdArr: rawParts
  };
}

/**
 * Build Shopee Universal Redirect Link (an_redir) - strictly validates origin_link host.
 */
function buildShopeeRedirectLink(cleanUrl, affiliateId, subIdStr = '') {
  logger.logEnter('buildShopeeRedirectLink', { cleanUrl, subIdStr });
  const parsed = new URL(cleanUrl);
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    throw new Error('Origin link không hợp lệ cho chuyển hướng Shopee.');
  }

  const affId = String(affiliateId || '').trim();
  if (!affId) {
    throw new Error('Hệ thống chưa cấu hình Shopee Affiliate ID.');
  }

  let redirectUrl = `https://s.shopee.vn/an_redir?origin_link=${encodeURIComponent(
    parsed.toString()
  )}&affiliate_id=${encodeURIComponent(affId)}`;
  if (subIdStr) {
    redirectUrl += `&sub_id=${encodeURIComponent(subIdStr)}`;
  }

  logger.logLeave('buildShopeeRedirectLink', { status: 'ok' });
  return redirectUrl;
}

/**
 * Generic helper to call Shopee Affiliate Open API GraphQL without logging secrets/signatures.
 */
async function callShopeeGraphql(query, appId, appSecret) {
  if (!appId || !appSecret) {
    throw new Error('Thiếu App ID hoặc Secret Key của Shopee Open API.');
  }
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const factor = `${appId.trim()}${timestamp}${payload}${appSecret.trim()}`;
  const signature = crypto.createHash('sha256').update(factor, 'utf8').digest('hex');
  const authHeader = `SHA256 Credential=${appId.trim()}, Timestamp=${timestamp}, Signature=${signature}`;

  const response = await fetch(SHOPEE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader
    },
    body: payload,
    signal: AbortSignal.timeout(6000)
  });

  const data = await response.json();
  console.log('[Shopee GraphQL raw]', response.status, JSON.stringify({
    errors: data.errors,
    dataKeys: data.data ? Object.keys(data.data) : null,
    nodesCount: data?.data?.productOfferV2?.nodes?.length,
    sample: data?.data?.productOfferV2?.nodes?.[0]
  }));

  if (data.errors && data.errors.length > 0) {
    const errMsg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`Shopee Open API: ${errMsg}`);
  }
  return data.data;
}

/**
 * Call Shopee Affiliate Open API to generate official s.shopee.vn shortLink (with caching).
 */
async function generateShopeeOpenApiLink(cleanUrl, appId, appSecret, subIdArr = []) {
  logger.logEnter('generateShopeeOpenApiLink', { cleanUrl });
  const cacheKey = `${cleanUrl}|${subIdArr.join('-')}`;
  const cached = getCached(linkCache, cacheKey);
  if (cached) {
    logger.logLeave('generateShopeeOpenApiLink', { cached: true });
    return cached;
  }

  const subIdsJson = subIdArr.length > 0 ? `, subIds: ${JSON.stringify(subIdArr)}` : '';
  const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(
    cleanUrl
  )}${subIdsJson} }) { shortLink } }`;

  const data = await callShopeeGraphql(query, appId, appSecret);
  const shortLink = data?.generateShortLink?.shortLink;
  if (!shortLink) {
    throw new Error('Không nhận được shortLink từ Shopee Open API.');
  }

  setCached(linkCache, cacheKey, shortLink);
  logger.logLeave('generateShopeeOpenApiLink', { cached: false });
  return shortLink;
}

/**
 * Fetch real product title, image, price & commission rate via Shopee Open API productOfferV2.
 */
async function fetchShopeeProductOffer(itemId, appId, appSecret, shopId = null) {
  logger.logEnter('fetchShopeeProductOffer', { itemId, shopId: shopId || undefined });
  if (!itemId || !appId || !appSecret) {
    console.warn('[productOfferV2] Bỏ qua: Chưa cấu hình SHOPEE_APP_ID hoặc SHOPEE_APP_SECRET!', {
      hasItemId: Boolean(itemId),
      hasAppId: Boolean(appId),
      hasAppSecret: Boolean(appSecret)
    });
    logger.logLeave('fetchShopeeProductOffer', { status: 'skipped_no_credentials' });
    return null;
  }
  const cacheKey = shopId ? `${itemId}:${shopId}` : String(itemId);
  const cached = getCached(productMetaCache, cacheKey);
  if (cached) {
    logger.logLeave('fetchShopeeProductOffer', { cached: true, itemId });
    return cached;
  }

  // Safe minimal fields query to prevent schema validation errors on optional fields
  const safeFields = 'itemId productName imageUrl price priceMin priceMax commissionRate';
  const tryQueries = [];
  if (shopId && Number(shopId) > 0) {
    tryQueries.push(
      `{ productOfferV2(itemId: ${Number(itemId)}, shopId: ${Number(shopId)}, limit: 1) { nodes { ${safeFields} } } }`
    );
  }
  tryQueries.push(
    `{ productOfferV2(itemId: ${Number(itemId)}, limit: 1) { nodes { ${safeFields} } } }`
  );

  for (const query of tryQueries) {
    try {
      const data = await callShopeeGraphql(query, appId, appSecret);
      const node = data?.productOfferV2?.nodes?.[0];
      if (node) {
        const rawPrice = Number(node.priceMin || node.price || node.priceMax || 0);
        const rawCommRate = Number(node.commissionRate || 0);
        // Normalize commissionRate: handle both decimal (0.0912 -> 9.12%) and already percentage (9.12)
        const commPercentage = rawCommRate > 0 && rawCommRate < 1 ? rawCommRate * 100 : rawCommRate;

        const meta = {
          itemId: String(node.itemId || itemId),
          productName: node.productName || '',
          imageUrl: node.imageUrl || '',
          price: rawPrice,
          priceMin: Number(node.priceMin || rawPrice),
          priceMax: Number(node.priceMax || rawPrice),
          commissionRate: commPercentage,
          shopName: node.shopName || '',
          sales: Number(node.sales || 0)
        };

        // Only cache when we actually have a valid product name or image
        if (meta.productName || meta.imageUrl) {
          setCached(productMetaCache, cacheKey, meta);
        }
        logger.logLeave('fetchShopeeProductOffer', {
          status: 'found',
          productName: meta.productName.slice(0, 30),
          commissionRate: commPercentage
        });
        return meta;
      }
    } catch (err) {
      console.error('[productOfferV2 Error]', err.message);
      logger.warning('fetchShopeeProductOffer', 'GraphQL query failed', {
        itemId,
        error: err.message
      });
    }
  }

  logger.logLeave('fetchShopeeProductOffer', { status: 'not_found' });
  return null;
}

/**
 * Query data.addlivetag.com API for product details, image, price & commission.
 * Supports both Shopee (item_id or url) and TikTok Shop (url).
 */
async function fetchAddlivetagProductData({ platform, itemId, url, apiKey }) {
  const key = String(apiKey || process.env.ADDLIVETAG_API_KEY || '').trim();
  if (!key) return null;

  const cacheKey = `addlivetag:${platform}:${itemId || url}`;
  const cached = getCached(productMetaCache, cacheKey);
  if (cached) {
    logger.logLeave('fetchAddlivetagProductData', { cached: true, platform, itemId });
    return cached;
  }

  logger.logEnter('fetchAddlivetagProductData', { platform, itemId, hasKey: Boolean(key) });

  try {
    let endpoint = '';
    if (platform === 'shopee') {
      const param = itemId
        ? `item_id=${encodeURIComponent(itemId)}`
        : `url=${encodeURIComponent(url)}`;
      endpoint = `https://data.addlivetag.com/product-data/product-data.php?${param}`;
    } else if (platform === 'tiktok') {
      endpoint = `https://data.addlivetag.com/tiktok/product.php?url=${encodeURIComponent(url)}`;
    } else {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'X-API-Key': key,
        'User-Agent': 'HoanTienShop/1.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[AddLiveTag API] HTTP ${res.status} from ${endpoint}`);
      logger.warning('fetchAddlivetagProductData', 'HTTP Error', { status: res.status });
      return null;
    }

    const json = await res.json();
    if (json.status !== 'success' || !json.productInfo) {
      return null;
    }

    const info = json.productInfo;
    const price = Number(info.price || 0);
    const commRate = Number(
      info.totalRatePercent || info.commissionRatePercent || info.shopeeRatePercent || 0
    );
    const commission = Number(info.commission || (price * commRate) / 100);

    const result = {
      itemId: String(info.itemId || info.productId || itemId || ''),
      productName: info.productName || '',
      imageUrl: info.imageUrl || '',
      price: price,
      priceMin: Number(info?.priceStats?.minPrice || price),
      priceMax: Number(info?.priceStats?.maxPrice || price),
      commissionRate: commRate,
      commission: commission,
      shopName: info.shopName || info.storeName || '',
      sales: Number(info.sales || 0),
      ratingStar: Number(info.rating || 5),
      dataSource: 'addlivetag'
    };

    if (result.productName || result.imageUrl) {
      setCached(productMetaCache, cacheKey, result);
    }
    logger.logLeave('fetchAddlivetagProductData', {
      status: 'found',
      title: result.productName.slice(0, 30),
      price: result.price,
      commission: result.commission
    });
    return result;
  } catch (err) {
    console.error('[AddLiveTag API Error]', err.message);
    logger.warning('fetchAddlivetagProductData', 'Request failed', { error: err.message });
    return null;
  }
}

/**
 * Fetch conversion report from Shopee Open API for Cron auto-sync.
 */
async function fetchShopeeConversionReport(appId, appSecret, limit = 50) {
  logger.logEnter('fetchShopeeConversionReport', { limit });
  const query = `{ conversionReport(limit: ${Number(
    limit
  )}) { nodes { conversionId purchaseTime totalCommission netCommission utmContent orders { orderId orderStatus items { itemId itemName itemPrice itemCommission } } } } }`;
  const data = await callShopeeGraphql(query, appId, appSecret);
  const nodes = data?.conversionReport?.nodes || [];
  logger.logLeave('fetchShopeeConversionReport', { count: nodes.length });
  return nodes;
}

/**
 * Main Shopee link conversion entry point.
 */
async function convertShopeeLink(cleanInfo, config = {}) {
  logger.logEnter('convertShopeeLink', {
    cleanUrl: cleanInfo.cleanUrl,
    mode: config.shopeeMode || 'an_redir'
  });

  const mode = config.shopeeMode || 'an_redir';
  const { subIdStr, subIdArr } = parseSubIds(config.subId);
  // Default to 'none' so s.shopee.vn Universal Links open the Shopee App directly on mobile!
  const shortenerProvider = config.shortenerProvider || 'none';

  let affiliateUrl = '';
  let fullAffiliateUrl = '';
  let usedMethod = mode;
  let note = '';

  const hasOpenApi = Boolean(config.shopeeAppId && config.shopeeAppSecret);

  if (mode === 'openapi' && hasOpenApi) {
    try {
      affiliateUrl = await generateShopeeOpenApiLink(
        cleanInfo.cleanUrl,
        config.shopeeAppId,
        config.shopeeAppSecret,
        subIdArr
      );
      fullAffiliateUrl = affiliateUrl;
      usedMethod = 'Shopee Open API';
    } catch (err) {
      logger.warning('convertShopeeLink', 'Open API fallback to an_redir');
      fullAffiliateUrl = buildShopeeRedirectLink(
        cleanInfo.cleanUrl,
        config.shopeeAffiliateId,
        subIdStr
      );
      affiliateUrl =
        shortenerProvider !== 'none'
          ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
          : fullAffiliateUrl;
      usedMethod = 'Universal Redirect';
      note = err.message;
    }
  } else {
    fullAffiliateUrl = buildShopeeRedirectLink(
      cleanInfo.cleanUrl,
      config.shopeeAffiliateId,
      subIdStr
    );
    affiliateUrl =
      shortenerProvider !== 'none'
        ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
        : fullAffiliateUrl;
    usedMethod = 'Universal Redirect';
  }

  // Try fetching rich product info if Open API keys are available
  let productMeta = null;
  if (cleanInfo.itemId && hasOpenApi) {
    productMeta = await fetchShopeeProductOffer(
      cleanInfo.itemId,
      config.shopeeAppId,
      config.shopeeAppSecret,
      cleanInfo.shopId
    );
  }

  // Fallback to AddLiveTag Data API
  const addlivetagKey = (config.addlivetagApiKey || process.env.ADDLIVETAG_API_KEY || DEFAULT_ADDLIVETAG_API_KEY).trim();
  if (!productMeta && addlivetagKey) {
    productMeta = await fetchAddlivetagProductData({
      platform: 'shopee',
      itemId: cleanInfo.itemId,
      url: cleanInfo.cleanUrl,
      apiKey: addlivetagKey
    });
  }

  logger.logLeave('convertShopeeLink', { usedMethod });
  return {
    affiliateUrl,
    fullAffiliateUrl,
    usedMethod,
    note,
    productMeta
  };
}

module.exports = {
  convertShopeeLink,
  buildShopeeRedirectLink,
  generateShopeeOpenApiLink,
  fetchShopeeProductOffer,
  fetchAddlivetagProductData,
  fetchShopeeConversionReport,
  DEFAULT_ADDLIVETAG_API_KEY
};
