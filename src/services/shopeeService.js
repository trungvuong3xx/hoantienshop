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
 * Scrapes Shopee product Open Graph metadata (title & image) by streaming HTML using Mobile Safari UA.
 * Operates without requiring Shopee Open API approval.
 */
const ogMetadataCache = new Map();

async function fetchShopeeOgMetadata(shopId, itemId) {
  logger.logEnter('fetchShopeeOgMetadata', { shopId: shopId || undefined, itemId });
  if (!itemId) {
    logger.logLeave('fetchShopeeOgMetadata', { status: 'skipped_no_itemId' });
    return null;
  }
  const cacheKey = `${shopId || '0'}:${itemId}`;
  const cached = getCached(ogMetadataCache, cacheKey);
  if (cached) {
    logger.logLeave('fetchShopeeOgMetadata', { cached: true, itemId });
    return cached;
  }

  const targetUrl = shopId
    ? `https://shopee.vn/product/${shopId}/${itemId}`
    : `https://shopee.vn/product/0/${itemId}`;

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      logger.warning('fetchShopeeOgMetadata', 'Shopee HTTP non-200', { status: res.status });
      return null;
    }

    const reader = res.body?.getReader();
    if (!reader) return null;

    let chunks = '';
    let ogTitle = null;
    let ogImage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += Buffer.from(value).toString('utf8');

      if (!ogTitle) {
        const tm =
          chunks.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
          chunks.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);
        if (tm && tm[1]) ogTitle = tm[1];
      }
      if (!ogImage) {
        const im =
          chunks.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
          chunks.match(/content=["']([^"']+)["']\s+property=["']og:image["']/i);
        if (im && im[1]) ogImage = im[1];
      }

      if (ogTitle && ogImage) {
        await reader.cancel().catch(() => {});
        break;
      }

      if (chunks.length > 400000) {
        await reader.cancel().catch(() => {});
        break;
      }
    }

    if (ogTitle || ogImage) {
      const cleanedTitle = ogTitle
        ? ogTitle.replace(/\s*\|\s*Shopee.*$/i, '').trim().slice(0, 160)
        : '';
      const result = {
        productName: cleanedTitle,
        imageUrl: ogImage || ''
      };
      setCached(ogMetadataCache, cacheKey, result);
      logger.logLeave('fetchShopeeOgMetadata', {
        status: 'found',
        hasImage: Boolean(ogImage),
        titleSnippet: cleanedTitle.slice(0, 30)
      });
      return result;
    }
  } catch (err) {
    logger.warning('fetchShopeeOgMetadata', 'Failed to fetch OG metadata', {
      error: err.message
    });
  }

  logger.logLeave('fetchShopeeOgMetadata', { status: 'not_found' });
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
      config.shopeeAppSecret,
      cleanInfo.shopId
    );
  }

  // Fallback: If Open API is inactive or product not found, scrape real product image & title via OG metadata
  if (!productMeta && cleanInfo.itemId) {
    const ogMeta = await fetchShopeeOgMetadata(cleanInfo.shopId, cleanInfo.itemId);
    if (ogMeta) {
      productMeta = {
        itemId: cleanInfo.itemId,
        productName: ogMeta.productName || cleanInfo.titleHint,
        imageUrl: ogMeta.imageUrl || '',
        price: 0,
        priceMin: 0,
        priceMax: 0,
        commissionRate: 0,
        sales: 0
      };
    }
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
  fetchShopeeOgMetadata,
  fetchShopeeConversionReport
};
