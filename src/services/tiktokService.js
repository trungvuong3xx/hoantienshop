const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');
const { isAllowedHost, isAllowedAffiliateRedirectUrl } = require('./urlResolver');

const ACCESSTRADE_TIKTOK_V2_CREATE_LINK = 'https://api.accesstrade.vn/v2/tiktokshop_product_feeds/create_link';

const TIKTOK_OPEN_API_HOST = 'https://open-api.tiktokglobalshop.com';
const TIKTOK_SHARE_LINK_PATH = '/affiliate_creator/202405/affiliate_sharing_links/generate_batch';

function signTikTokOpenApiRequest(appSecret, apiPath, queryParams, bodyString) {
  const sortedKeys = Object.keys(queryParams)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();

  const paramStr = sortedKeys.map((k) => `${k}${queryParams[k]}`).join('');
  const stringToSign = `${appSecret}${apiPath}${paramStr}${bodyString}${appSecret}`;

  return crypto.createHmac('sha256', appSecret).update(stringToSign, 'utf8').digest('hex');
}

/**
 * Mode 1: Official TikTok Shop Open API (Partner Center).
 */
async function generateTikTokOpenApiLink(productId, config = {}) {
  logger.logEnter('generateTikTokOpenApiLink', { productId });
  const { tiktokAppKey, tiktokAppSecret, tiktokAccessToken, subId } = config;

  if (!tiktokAppKey || !tiktokAppSecret || !tiktokAccessToken) {
    throw new Error('Thiếu cấu hình TikTok Shop Open API (App Key / Secret / Access Token).');
  }
  if (!productId) {
    throw new Error('Không tìm thấy Product ID hợp lệ từ link TikTok.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const queryParams = {
    app_key: tiktokAppKey.trim(),
    timestamp
  };

  const tags = subId
    ? String(subId)
        .split(/[-,\s]+/)
        .map((s) => s.trim().replace(/[^a-zA-Z0-9_]/g, ''))
        .filter(Boolean)
        .slice(0, 5)
    : undefined;

  const bodyObj = {
    material: {
      material_ids: [String(productId)],
      type: 'PRODUCT'
    },
    ...(tags && tags.length > 0 ? { tags } : {})
  };
  const bodyString = JSON.stringify(bodyObj);

  const sign = signTikTokOpenApiRequest(
    tiktokAppSecret.trim(),
    TIKTOK_SHARE_LINK_PATH,
    queryParams,
    bodyString
  );

  const url = `${TIKTOK_OPEN_API_HOST}${TIKTOK_SHARE_LINK_PATH}?app_key=${encodeURIComponent(
    queryParams.app_key
  )}&timestamp=${timestamp}&sign=${sign}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tts-access-token': tiktokAccessToken.trim()
    },
    body: bodyString,
    signal: AbortSignal.timeout(6000)
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`TikTok Open API lỗi (${data.code}): ${data.message || 'Không xác định'}`);
  }

  const shareLinks = data?.data?.affiliate_sharing_links || [];
  const firstLink = shareLinks[0]?.affiliate_sharing_link || shareLinks[0]?.sharing_link;
  if (!firstLink) {
    throw new Error('TikTok Open API không trả về link chia sẻ cho sản phẩm này.');
  }

  logger.logLeave('generateTikTokOpenApiLink', { status: 'ok' });
  return firstLink;
}

/**
 * Mode 2: Build DeepLink (AccessTrade v6 url_enc / Standard DeepLink / Custom) - validates cleanUrl domain first.
 */
function buildTikTokDeepLink(cleanUrl, productId, config = {}) {
  logger.logEnter('buildTikTokDeepLink', { cleanUrl, productId });
  const parsedClean = new URL(cleanUrl);
  if (parsedClean.protocol !== 'https:' || !isAllowedHost(parsedClean.hostname)) {
    throw new Error('Link đích TikTok không hợp lệ.');
  }

  const template = (config.tiktokDeepLinkTemplate || '').trim();
  const subId = String(config.subId || '').replace(/[^a-zA-Z0-9_]/g, '');

  if (!template) {
    throw new Error('Chưa cấu hình mẫu DeepLink (AccessTrade / Ecomobi) cho TikTok.');
  }

  const targetUrlStr = parsedClean.toString();
  const base64Url = Buffer.from(targetUrlStr, 'utf8').toString('base64');

  // If template uses explicit placeholders
  if (
    template.includes('{url}') ||
    template.includes('{encoded_url}') ||
    template.includes('{base64_url}')
  ) {
    const result = template
      .replace(/\{base64_url\}/g, encodeURIComponent(base64Url))
      .replace(/\{encoded_url\}/g, encodeURIComponent(targetUrlStr))
      .replace(/\{url\}/g, targetUrlStr)
      .replace(/\{product_id\}/g, String(productId || ''))
      .replace(/\{sub_id\}/g, encodeURIComponent(subId));

    logger.logLeave('buildTikTokDeepLink', { status: 'ok', format: 'placeholder' });
    return result;
  }

  const parsed = new URL(template);
  const isAccessTradeV6 =
    parsed.pathname.includes('/deep_link/v6/') || parsed.searchParams.has('url_enc');

  // Remove old target params to avoid conflicting redirects
  parsed.searchParams.delete('url');
  parsed.searchParams.delete('url_enc');

  if (isAccessTradeV6) {
    parsed.searchParams.set('url_enc', base64Url);
    if (subId) {
      parsed.searchParams.set('sub1', subId);
    }
  } else {
    parsed.searchParams.set('url', targetUrlStr);
    if (subId) {
      parsed.searchParams.set('utm_source', subId);
    }
  }

  const finalUrl = parsed.toString();
  logger.logLeave('buildTikTokDeepLink', { status: 'ok', format: isAccessTradeV6 ? 'v6' : 'legacy' });
  return finalUrl;
}

function parseAccessTradeMoney(rawVal) {
  if (rawVal == null || rawVal === '') return 0;
  if (typeof rawVal === 'number') return Number.isFinite(rawVal) && rawVal > 0 ? Math.round(rawVal) : 0;
  const s = String(rawVal).trim().replace(/,/g, '');
  if (!s) return 0;
  // Handle Vietnamese thousand-dot format like "3.000" or "1.250.000"
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    const n = Number(s.replace(/\./g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function parseAccessTradeCommissionRate(rawRate, commissionAmount = 0, priceAmount = 0) {
  const rateNum = Number(rawRate);
  if (Number.isFinite(rateNum) && rateNum > 0) {
    if (rateNum < 1) {
      return Number((rateNum * 100).toFixed(2));
    }
    if (rateNum >= 100) {
      return Number((rateNum / 100).toFixed(2));
    }
    return Number(rateNum.toFixed(2));
  }
  if (commissionAmount > 0 && priceAmount > 0) {
    return Number(((commissionAmount / priceAmount) * 100).toFixed(2));
  }
  return 0;
}

function sanitizeHttpsImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Mode 2A: Official AccessTrade TikTok Shop API v2 (/v2/tiktokshop_product_feeds/create_link).
 * Returns affiliate short/full links + product metadata (name, image, price, commission).
 */
async function generateTikTokAccessTradeLink(cleanUrl, productId, config = {}) {
  logger.logEnter('generateTikTokAccessTradeLink', { cleanUrl, productId });
  const apiKey = String(config.accesstradeApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Thiếu AccessTrade API Key.');
  }

  const subId = String(config.subId || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
  const body = { product_url: cleanUrl };
  if (productId) body.product_id = String(productId);
  if (subId) {
    body.sub1 = subId;
    body.utm_source = subId;
  }

  const fetchFn = config.fetchFn || fetch;
  const response = await fetchFn(ACCESSTRADE_TIKTOK_V2_CREATE_LINK, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000)
  });

  if (!response.ok) {
    throw new Error(`AccessTrade TikTok v2 API trả về HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const data = payload?.data;
  if (!payload?.status || !data || (!data.aff_short_url && !data.aff_url)) {
    throw new Error(payload?.message || 'AccessTrade TikTok v2 API không trả về link affiliate.');
  }

  const affUrl = String(data.aff_url || '').trim();
  const affShortUrl = String(data.aff_short_url || '').trim();

  if (subId && affUrl && !affUrl.includes(subId)) {
    throw new Error('AccessTrade TikTok v2 aff_url thiếu tham số tracking subId.');
  }

  const affiliateUrl = affShortUrl || affUrl;
  const fullAffiliateUrl = affUrl || affShortUrl;

  if (!isAllowedAffiliateRedirectUrl(affiliateUrl, config.tiktokDeepLinkTemplate)) {
    throw new Error('Domain link trả về từ AccessTrade TikTok v2 không nằm trong danh sách cho phép.');
  }

  const priceObj = data.product_price || {};
  const price = parseAccessTradeMoney(
    priceObj.minimum_amount ?? priceObj.amount ?? priceObj.maximum_amount
  );
  const commObj = data.product_commission || {};
  const commission = parseAccessTradeMoney(commObj.amount);
  const commissionRate = parseAccessTradeCommissionRate(commObj.rate, commission, price);
  const resolvedProductId = String(data.product_id || productId || '').trim() || null;

  const result = {
    affiliateUrl,
    fullAffiliateUrl,
    productId: resolvedProductId,
    productName: String(data.product_name || '').trim(),
    imageUrl: sanitizeHttpsImageUrl(data.product_image),
    price,
    commission,
    commissionRate,
    hasMeta: Boolean(data.product_name || data.product_image || price > 0 || commission > 0)
  };

  logger.logLeave('generateTikTokAccessTradeLink', {
    status: 'ok',
    productId: result.productId,
    hasMeta: result.hasMeta
  });
  return result;
}

/**
 * Main TikTok Shop link conversion entry point (Cookie mode removed for security).
 */
async function convertTikTokLink(cleanInfo, config = {}) {
  logger.logEnter('convertTikTokLink', {
    cleanUrl: cleanInfo.cleanUrl,
    productId: cleanInfo.productId,
    mode: config.tiktokMode || 'deeplink'
  });

  const mode = config.tiktokMode || 'deeplink';
  const shortenerProvider = config.shortenerProvider || 'none';
  const productId = cleanInfo.productId;

  let affiliateUrl = '';
  let fullAffiliateUrl = '';
  let usedMethod = '';
  let note = '';
  let productName = '';
  let imageUrl = '';
  let price = 0;
  let commission = 0;
  let commissionRate = 0;
  let hasMeta = false;
  let resolvedProductId = productId;

  if (mode === 'openapi') {
    affiliateUrl = await generateTikTokOpenApiLink(productId, config);
    fullAffiliateUrl = affiliateUrl;
    usedMethod = 'TikTok Shop Open API';
  } else if (mode === 'deeplink') {
    const hasAtKey = Boolean(String(config.accesstradeApiKey || '').trim());
    let usedAtV2 = false;

    if (hasAtKey) {
      try {
        const atRes = await generateTikTokAccessTradeLink(cleanInfo.cleanUrl, productId, config);
        affiliateUrl = atRes.affiliateUrl;
        fullAffiliateUrl = atRes.fullAffiliateUrl;
        resolvedProductId = atRes.productId || productId;
        productName = atRes.productName;
        imageUrl = atRes.imageUrl;
        price = atRes.price;
        commission = atRes.commission;
        commissionRate = atRes.commissionRate;
        hasMeta = atRes.hasMeta;
        usedMethod = 'TikTok Shop API v2 (AccessTrade)';
        usedAtV2 = true;
      } catch (atErr) {
        logger.warning('convertTikTokLink', 'AccessTrade TikTok v2 failed, falling back to deeplink template', {
          error: atErr.message
        });
      }
    }

    if (!usedAtV2) {
      fullAffiliateUrl = buildTikTokDeepLink(cleanInfo.cleanUrl, productId, config);
      affiliateUrl =
        shortenerProvider !== 'none'
          ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
          : fullAffiliateUrl;
      usedMethod = 'TikTok DeepLink (AccessTrade)';
    }
  } else {
    throw new Error('Tính năng hoàn tiền TikTok Shop hiện đang được nâng cấp, vui lòng sử dụng link Shopee.');
  }

  logger.logLeave('convertTikTokLink', { usedMethod, productId: resolvedProductId, hasMeta });
  return {
    affiliateUrl,
    fullAffiliateUrl,
    productId: resolvedProductId,
    usedMethod,
    note,
    productName,
    imageUrl,
    price,
    commission,
    commissionRate,
    hasMeta
  };
}

const DEFAULT_RETRY_BACKOFFS_MS = [1000, 2000];
const MAX_RETRY_WAIT_MS = 3000;

function parseRetryAfterMs(response, data) {
  const retryHeader = response?.headers?.get?.('retry-after');
  if (retryHeader != null && retryHeader !== '') {
    const num = Number(retryHeader);
    if (Number.isFinite(num) && num >= 0) {
      return Math.min(MAX_RETRY_WAIT_MS, Math.round(num * 1000));
    }
  }
  const bodyRetry = Number(data?.retry_after);
  if (Number.isFinite(bodyRetry) && bodyRetry >= 0) {
    return Math.min(MAX_RETRY_WAIT_MS, Math.round(bodyRetry * 1000));
  }
  return null;
}

function isRetryableAccessTradeStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function fetchAccessTradePageWithRetry(urlStr, cleanKey, deadline, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = DEFAULT_RETRY_BACKOFFS_MS.length;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1000) {
      throw new Error('AccessTrade report vượt quá giới hạn thời gian tác vụ; cần chạy lại.');
    }

    try {
      const response = await fetchFn(urlStr, {
        headers: { Authorization: `Token ${cleanKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(8000, remainingMs - 500)))
      });

      if (response.ok) {
        const data = await response.json();
        if (data?.success === false) {
          const msg = String(data.message || 'AccessTrade API trả về success=false');
          const retryAfterMs = parseRetryAfterMs(response, data);
          const isTransientMsg = /rate\s*limit|maximum\s*execution\s*time|timeout|overload/i.test(msg);
          if (isTransientMsg && attempt < maxRetries) {
            const waitMs = retryAfterMs ?? DEFAULT_RETRY_BACKOFFS_MS[attempt];
            if (Date.now() + waitMs + 1500 < deadline) {
              logger.warning('fetchAccessTradeOrders', 'Transient AccessTrade API error, retrying', {
                attempt: attempt + 1,
                waitMs,
                message: msg
              });
              await sleepFn(waitMs);
              continue;
            }
          }
          throw new Error(`AccessTrade API lỗi: ${msg}`);
        }
        return data;
      }

      let errData = null;
      try {
        errData = await response.json();
      } catch (_) {
        errData = null;
      }

      if (isRetryableAccessTradeStatus(response.status) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfterMs(response, errData);
        const waitMs = retryAfterMs ?? DEFAULT_RETRY_BACKOFFS_MS[attempt];
        if (Date.now() + waitMs + 1500 < deadline) {
          logger.warning('fetchAccessTradeOrders', 'AccessTrade HTTP error, retrying', {
            status: response.status,
            attempt: attempt + 1,
            waitMs
          });
          await sleepFn(waitMs);
          continue;
        }
      }

      const detail = errData?.message ? ` (${errData.message})` : '';
      throw new Error(`AccessTrade API trả về HTTP ${response.status}${detail}.`);
    } catch (err) {
      const isNetworkOrTimeout =
        err?.name === 'AbortError' ||
        err?.name === 'TimeoutError' ||
        /fetch failed|network|timeout/i.test(String(err?.message || ''));

      if (isNetworkOrTimeout && attempt < maxRetries) {
        const waitMs = DEFAULT_RETRY_BACKOFFS_MS[attempt];
        if (Date.now() + waitMs + 1500 < deadline) {
          logger.warning('fetchAccessTradeOrders', 'AccessTrade network/timeout error, retrying', {
            attempt: attempt + 1,
            waitMs,
            error: err.message
          });
          await sleepFn(waitMs);
          continue;
        }
      }
      throw err;
    }
  }
}

/**
 * Fetch conversion orders from AccessTrade Publisher API v1 (/v1/order-list).
 */
async function fetchAccessTradeOrders(apiKey, days = 30, options = {}) {
  logger.logEnter('fetchAccessTradeOrders', { days });
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('Chưa cấu hình AccessTrade API Key để đồng bộ đơn tự động.');
  }

  const now = new Date();
  const since = new Date(now.getTime() - Number(days || 30) * 24 * 60 * 60 * 1000);
  // Official order-list API: page starts at 1, limit <= 300, total is explicit.
  const url = new URL('https://api.accesstrade.vn/v1/order-list');
  url.searchParams.set('since', since.toISOString());
  url.searchParams.set('until', now.toISOString());
  url.searchParams.set('limit', '300');
  const rows = [];
  const seen = new Set();
  let expectedTotal = null;
  const deadlineMs = Number(options.deadlineMs) > 0 ? Number(options.deadlineMs) : 22000;
  const deadline = Date.now() + deadlineMs;

  for (let page = 1; page <= 10 && Date.now() < deadline; page++) {
    url.searchParams.set('page', String(page));
    const data = await fetchAccessTradePageWithRetry(url.toString(), cleanKey, deadline, options);
    if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.total) || data.total < 0) {
      throw new Error('AccessTrade report thiếu data/total hợp lệ.');
    }
    if (expectedTotal !== null && expectedTotal !== data.total) {
      throw new Error('AccessTrade report thay đổi trong lúc phân trang; cần chạy lại.');
    }
    expectedTotal = data.total;
    for (const row of data.data) {
      const key = JSON.stringify([row.merchant, row.order_id]);
      if (!row.order_id || seen.has(key)) throw new Error('AccessTrade report thiếu mã đơn hoặc lặp trang.');
      seen.add(key);
      rows.push(row);
    }
    if (rows.length === expectedTotal) {
      logger.logLeave('fetchAccessTradeOrders', { count: rows.length });
      return rows;
    }
    if (!data.data.length || rows.length > expectedTotal) {
      throw new Error('AccessTrade report không khớp tổng số đơn.');
    }
  }
  throw new Error('AccessTrade report chưa lấy đủ trang trong giới hạn tác vụ; chưa đánh dấu thành công.');
}

/**
 * Fetch item-level details and rejection reasons for an order from AccessTrade (/v1/order-products).
 */
async function fetchAccessTradeOrderProducts(apiKey, orderSn, merchant, options = {}) {
  logger.logEnter('fetchAccessTradeOrderProducts', { orderSn, merchant });
  const cleanKey = String(apiKey || '').trim();
  const cleanOrderSn = String(orderSn || '').trim();
  const cleanMerchant = String(merchant || '').trim();

  if (!cleanKey) {
    throw new Error('Chưa cấu hình AccessTrade API Key để tra cứu chi tiết đơn hàng.');
  }
  if (!cleanOrderSn || !cleanMerchant) {
    throw new Error('Thiếu mã đơn hàng hoặc tên merchant AccessTrade.');
  }

  const url = new URL('https://api.accesstrade.vn/v1/order-products');
  url.searchParams.set('order_id', cleanOrderSn);
  url.searchParams.set('merchant', cleanMerchant);
  url.searchParams.set('limit', '100');

  const fetchFn = options.fetchFn || fetch;
  const response = await fetchFn(url.toString(), {
    headers: { Authorization: `Token ${cleanKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(6000)
  });

  if (!response.ok) {
    throw new Error(`AccessTrade Order Products API trả về HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (data?.success === false) {
    throw new Error(String(data.message || 'AccessTrade Order Products API trả về success=false.'));
  }

  const rawItems = Array.isArray(data?.data) ? data.data : [];
  const products = rawItems.map((item) => ({
    productId: String(item?._id || item?.product_id || '').trim(),
    price: Number(item?.product_price || 0),
    quantity: Number(item?.product_quantity || 1),
    billing: item?.billing || null,
    commission: item?.commission || null,
    reasonRejected: String(item?.reason_rejected || item?.reason_reject || '').trim()
  }));

  const uniqueReasons = Array.from(
    new Set(
      products
        .map((p) => p.reasonRejected)
        .filter((r) => r && !/^(n\/a|null|undefined|-)$/i.test(r))
    )
  );
  const rejectReason = uniqueReasons.length
    ? uniqueReasons.join('; ').slice(0, 500)
    : '';

  logger.logLeave('fetchAccessTradeOrderProducts', {
    orderSn: cleanOrderSn,
    count: products.length,
    hasRejectReason: Boolean(rejectReason)
  });
  return { products, rejectReason };
}

module.exports = {
  convertTikTokLink,
  generateTikTokOpenApiLink,
  generateTikTokAccessTradeLink,
  buildTikTokDeepLink,
  fetchAccessTradeOrders,
  fetchAccessTradeOrderProducts,
  parseAccessTradeMoney,
  parseAccessTradeCommissionRate
};
