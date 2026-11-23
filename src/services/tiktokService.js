const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');
const { isAllowedHost } = require('./urlResolver');

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

  if (mode === 'openapi') {
    affiliateUrl = await generateTikTokOpenApiLink(productId, config);
    fullAffiliateUrl = affiliateUrl;
    usedMethod = 'TikTok Shop Open API';
  } else if (mode === 'deeplink') {
    fullAffiliateUrl = buildTikTokDeepLink(cleanInfo.cleanUrl, productId, config);
    affiliateUrl =
      shortenerProvider !== 'none'
        ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
        : fullAffiliateUrl;
    usedMethod = 'TikTok DeepLink (AccessTrade)';
  } else {
    throw new Error('Tính năng hoàn tiền TikTok Shop hiện đang được nâng cấp, vui lòng sử dụng link Shopee.');
  }

  logger.logLeave('convertTikTokLink', { usedMethod, productId });
  return {
    affiliateUrl,
    fullAffiliateUrl,
    productId,
    usedMethod,
    note
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

module.exports = {
  convertTikTokLink,
  generateTikTokOpenApiLink,
  buildTikTokDeepLink,
  fetchAccessTradeOrders
};
