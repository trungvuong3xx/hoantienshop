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

module.exports = {
  convertTikTokLink,
  generateTikTokOpenApiLink,
  buildTikTokDeepLink
};
