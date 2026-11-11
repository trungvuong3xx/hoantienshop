const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');
const { isAllowedHost } = require('./urlResolver');

const SHOPEE_GRAPHQL_ENDPOINT = 'https://open-api.affiliate.shopee.vn/graphql';

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
async function fetchShopeeProductOffer(itemId, appId, appSecret) {
  if (!itemId || !appId || !appSecret) return null;
  const cached = getCached(productMetaCache, String(itemId));
  if (cached) return cached;

  try {
    const query = `{ productOfferV2(itemId: ${Number(
      itemId
    )}, limit: 1) { nodes { itemId productName imageUrl priceMin commissionRate sellerCommissionRate shopeeCommissionRate } } }`;
    const data = await callShopeeGraphql(query, appId, appSecret);
    const node = data?.productOfferV2?.nodes?.[0];
    if (node) {
      const meta = {
        productName: node.productName || '',
        imageUrl: node.imageUrl || '',
        price: Number(node.priceMin || 0),
        commissionRate: Number(node.commissionRate || 0) * 100
      };
      setCached(productMetaCache, String(itemId), meta);
      return meta;
    }
  } catch (err) {
    logger.warning('fetchShopeeProductOffer', 'Could not fetch productOfferV2 metadata', {
      itemId
    });
  }
  return null;
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
      config.shopeeAppSecret
    );
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
  fetchShopeeConversionReport
};
