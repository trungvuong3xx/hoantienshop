const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');

const TIKTOK_OPEN_API_HOST = 'https://open-api.tiktokglobalshop.com';
const TIKTOK_SHARE_LINK_PATH = '/affiliate_creator/202405/affiliate_sharing_links/generate_batch';

/**
 * Compute TikTok Shop Open API v2 HMAC-SHA256 signature.
 */
function signTikTokOpenApiRequest(appSecret, apiPath, queryParams, bodyString) {
  const sortedKeys = Object.keys(queryParams)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();

  const paramStr = sortedKeys.map((k) => `${k}${queryParams[k]}`).join('');
  const stringToSign = `${appSecret}${apiPath}${paramStr}${bodyString}${appSecret}`;

  return crypto.createHmac('sha256', appSecret).update(stringToSign, 'utf8').digest('hex');
}

/**
 * Mode 1: Call TikTok Shop Open API (Partner Center) to generate official vt.tiktok.com link.
 */
async function generateTikTokOpenApiLink(productId, config = {}) {
  logger.logEnter('generateTikTokOpenApiLink', { productId, appKey: config.tiktokAppKey });
  const { tiktokAppKey, tiktokAppSecret, tiktokAccessToken, subId } = config;

  if (!tiktokAppKey || !tiktokAppSecret || !tiktokAccessToken) {
    throw new Error('Thiếu App Key, App Secret hoặc Access Token của TikTok Shop Open API.');
  }
  if (!productId) {
    throw new Error('Không tìm thấy Product ID từ link TikTok này để gọi API.');
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const queryParams = {
    app_key: tiktokAppKey.trim(),
    timestamp
  };

  const tags = subId
    ? String(subId)
        .split(/[-,\s]+/)
        .map((s) => s.trim())
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
    signal: AbortSignal.timeout(8000)
  });

  const data = await response.json();
  if (data.code !== 0) {
    logger.error('generateTikTokOpenApiLink', 'TikTok Open API returned error code', {
      code: data.code,
      message: data.message
    });
    throw new Error(`TikTok Open API lỗi (${data.code}): ${data.message || 'Không xác định'}`);
  }

  const shareLinks = data?.data?.affiliate_sharing_links || [];
  const firstLink = shareLinks[0]?.affiliate_sharing_link || shareLinks[0]?.sharing_link;
  if (!firstLink) {
    throw new Error('TikTok Open API không trả về affiliate_sharing_link cho sản phẩm này.');
  }

  logger.logLeave('generateTikTokOpenApiLink', { firstLink });
  return firstLink;
}

/**
 * Mode 2: Try generating share link via TikTok Affiliate Creator Web Cookie.
 */
async function generateTikTokCookieLink(productId, cookieStr) {
  logger.logEnter('generateTikTokCookieLink', { productId });
  if (!cookieStr || !cookieStr.trim()) {
    throw new Error('Chưa nhập Cookie trang affiliate.tiktok.com trong Cài đặt.');
  }
  if (!productId) {
    throw new Error('Không bóc tách được Product ID từ link TikTok.');
  }

  const endpoint =
    'https://affiliate.tiktok.com/api/v1/oec/affiliate/creator/share_link/generate?aid=4331&shop_region=VN';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieStr.trim(),
      Origin: 'https://affiliate.tiktok.com',
      Referer: `https://affiliate.tiktok.com/connection/product/detail?product_id=${productId}&shop_region=VN`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      product_id: String(productId),
      material_type: 1
    }),
    signal: AbortSignal.timeout(8000)
  });

  const data = await response.json();
  const shareLink =
    data?.data?.share_link ||
    data?.data?.short_url ||
    data?.data?.affiliate_sharing_link;

  if (!shareLink) {
    throw new Error(
      data?.message ||
        'Cookie đã hết hạn hoặc TikTok yêu cầu xác thực trên trình duyệt. Hãy bấm nút "Mở TikTok Affiliate" bên dưới để lấy link trực tiếp.'
    );
  }

  logger.logLeave('generateTikTokCookieLink', { shareLink });
  return shareLink;
}

/**
 * Mode 3: Build DeepLink (Accesstrade / Ecomobi / Custom Template).
 */
function buildTikTokDeepLink(cleanUrl, productId, config = {}) {
  logger.logEnter('buildTikTokDeepLink', { cleanUrl, productId });
  const template = (config.tiktokDeepLinkTemplate || '').trim();
  const subId = (config.subId || '').trim();

  if (!template) {
    throw new Error(
      'Chưa cấu hình mẫu DeepLink (Accesstrade / Custom) cho TikTok trong phần Cài đặt.'
    );
  }

  // If user pasted an Accesstrade base URL like https://go.isclix.com/deep_link/xxx/yyy
  if (!template.includes('{url}') && !template.includes('{encoded_url}')) {
    const parsed = new URL(template);
    parsed.searchParams.set('url', cleanUrl);
    if (subId) {
      parsed.searchParams.set('utm_source', subId);
    }
    const result = parsed.toString();
    logger.logLeave('buildTikTokDeepLink', { result });
    return result;
  }

  // Replace placeholders
  const result = template
    .replace(/\{encoded_url\}/g, encodeURIComponent(cleanUrl))
    .replace(/\{url\}/g, cleanUrl)
    .replace(/\{product_id\}/g, productId || '')
    .replace(/\{sub_id\}/g, encodeURIComponent(subId));

  logger.logLeave('buildTikTokDeepLink', { result });
  return result;
}

/**
 * Main TikTok Shop link conversion entry point.
 */
async function convertTikTokLink(cleanInfo, config = {}) {
  logger.logEnter('convertTikTokLink', {
    cleanUrl: cleanInfo.cleanUrl,
    productId: cleanInfo.productId,
    mode: config.tiktokMode || 'clean_extract'
  });

  const mode = config.tiktokMode || 'clean_extract';
  const shortenerProvider = config.shortenerProvider || 'none';
  const productId = cleanInfo.productId;

  const affiliateCenterUrl = productId
    ? `https://affiliate.tiktok.com/connection/product/detail?product_id=${productId}&shop_region=VN`
    : 'https://affiliate.tiktok.com/connection/product?shop_region=VN';

  let affiliateUrl = cleanInfo.cleanUrl;
  let fullAffiliateUrl = cleanInfo.cleanUrl;
  let usedMethod = '';
  let note = '';

  if (mode === 'openapi') {
    try {
      affiliateUrl = await generateTikTokOpenApiLink(productId, config);
      fullAffiliateUrl = affiliateUrl;
      usedMethod = 'TikTok Shop Open API (vt.tiktok.com)';
    } catch (err) {
      logger.warning('convertTikTokLink', 'TikTok Open API failed, falling back to clean link', {
        error: err.message
      });
      note = err.message;
      usedMethod = 'Link sạch + Product ID (Dự phòng do lỗi Open API)';
    }
  } else if (mode === 'cookie') {
    try {
      affiliateUrl = await generateTikTokCookieLink(productId, config.tiktokCookie);
      fullAffiliateUrl = affiliateUrl;
      usedMethod = 'TikTok Affiliate Cookie (vt.tiktok.com)';
    } catch (err) {
      logger.warning('convertTikTokLink', 'TikTok Cookie mode failed, falling back to clean link', {
        error: err.message
      });
      note = err.message;
      usedMethod = 'Link sạch + Mở nhanh TikTok Affiliate Center';
    }
  } else if (mode === 'deeplink') {
    fullAffiliateUrl = buildTikTokDeepLink(cleanInfo.cleanUrl, productId, config);
    affiliateUrl =
      shortenerProvider !== 'none'
        ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
        : fullAffiliateUrl;
    usedMethod =
      shortenerProvider !== 'none'
        ? `DeepLink + Rút gọn (${shortenerProvider})`
        : 'TikTok DeepLink (Accesstrade/Custom)';
  } else {
    // Mode: clean_extract (Default for Creator accounts without API keys yet)
    fullAffiliateUrl = cleanInfo.cleanUrl;
    affiliateUrl =
      shortenerProvider !== 'none'
        ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
        : fullAffiliateUrl;
    usedMethod = productId
      ? `Đã xoá mã aff cũ (Product ID: ${productId})`
      : 'Đã làm sạch link TikTok';
  }

  logger.logLeave('convertTikTokLink', { affiliateUrl, usedMethod, productId });
  return {
    affiliateUrl,
    fullAffiliateUrl,
    productId,
    affiliateCenterUrl,
    usedMethod,
    note
  };
}

module.exports = {
  convertTikTokLink,
  generateTikTokOpenApiLink,
  buildTikTokDeepLink
};
