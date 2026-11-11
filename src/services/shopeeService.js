const crypto = require('crypto');
const logger = require('../utils/logger');
const { shortenUrl } = require('./shortenerService');

const SHOPEE_GRAPHQL_ENDPOINT = 'https://open-api.affiliate.shopee.vn/graphql';

/**
 * Format subIds into Shopee's sub_id string (sub1-sub2-sub3-sub4-sub5) and array.
 */
function parseSubIds(subIdInput) {
  if (!subIdInput) return { subIdStr: '', subIdArr: [] };
  const rawParts = String(subIdInput)
    .split(/[-,\s]+/)
    .map((s) => s.trim().replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 5);

  return {
    subIdStr: rawParts.join('-'),
    subIdArr: rawParts
  };
}

/**
 * Build Shopee Universal Redirect Link (an_redir).
 */
function buildShopeeRedirectLink(cleanUrl, affiliateId, subIdStr = '') {
  logger.logEnter('buildShopeeRedirectLink', { cleanUrl, affiliateId, subIdStr });
  const affId = String(affiliateId || '').trim();
  if (!affId) {
    throw new Error('Chưa cấu hình Shopee Affiliate ID trong phần Cài đặt.');
  }

  let redirectUrl = `https://s.shopee.vn/an_redir?origin_link=${encodeURIComponent(cleanUrl)}&affiliate_id=${encodeURIComponent(affId)}`;
  if (subIdStr) {
    redirectUrl += `&sub_id=${encodeURIComponent(subIdStr)}`;
  }

  logger.logLeave('buildShopeeRedirectLink', { redirectUrl });
  return redirectUrl;
}

/**
 * Call Shopee Affiliate Open API (GraphQL) to generate official s.shopee.vn shortLink.
 */
async function generateShopeeOpenApiLink(cleanUrl, appId, appSecret, subIdArr = []) {
  logger.logEnter('generateShopeeOpenApiLink', { cleanUrl, appId });
  if (!appId || !appSecret) {
    throw new Error('Thiếu App ID hoặc Secret Key của Shopee Open API.');
  }

  const subIdsJson = subIdArr.length > 0 ? `, subIds: ${JSON.stringify(subIdArr)}` : '';
  const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(cleanUrl)}${subIdsJson} }) { shortLink } }`;
  const payload = JSON.stringify({ query });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const factor = `${appId}${timestamp}${payload}${appSecret}`;
  const signature = crypto.createHash('sha256').update(factor, 'utf8').digest('hex');
  const authHeader = `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;

  const response = await fetch(SHOPEE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader
    },
    body: payload,
    signal: AbortSignal.timeout(8000)
  });

  const data = await response.json();
  if (data.errors && data.errors.length > 0) {
    const errMsg = data.errors.map((e) => e.message).join('; ');
    logger.error('generateShopeeOpenApiLink', 'Shopee GraphQL returned errors', { errMsg });
    throw new Error(`Shopee Open API lỗi: ${errMsg}`);
  }

  const shortLink = data?.data?.generateShortLink?.shortLink;
  if (!shortLink) {
    throw new Error('Không nhận được shortLink từ Shopee Open API.');
  }

  logger.logLeave('generateShopeeOpenApiLink', { shortLink });
  return shortLink;
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
  const shortenerProvider = config.shortenerProvider || 'none';

  let affiliateUrl = '';
  let fullAffiliateUrl = '';
  let usedMethod = mode;
  let note = '';

  if (mode === 'openapi') {
    try {
      affiliateUrl = await generateShopeeOpenApiLink(
        cleanInfo.cleanUrl,
        config.shopeeAppId,
        config.shopeeAppSecret,
        subIdArr
      );
      fullAffiliateUrl = affiliateUrl;
      usedMethod = 'Shopee Open API (s.shopee.vn)';
    } catch (err) {
      logger.warning('convertShopeeLink', 'Open API failed, checking fallback to an_redir', {
        error: err.message
      });
      if (config.shopeeAffiliateId) {
        fullAffiliateUrl = buildShopeeRedirectLink(
          cleanInfo.cleanUrl,
          config.shopeeAffiliateId,
          subIdStr
        );
        affiliateUrl =
          shortenerProvider !== 'none'
            ? await shortenUrl(fullAffiliateUrl, shortenerProvider)
            : fullAffiliateUrl;
        usedMethod = 'an_redir (Dự phòng do lỗi Open API)';
        note = err.message;
      } else {
        throw err;
      }
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
    usedMethod =
      shortenerProvider !== 'none'
        ? `Universal Link + Rút gọn (${shortenerProvider})`
        : 'Universal Redirect (an_redir)';
  }

  logger.logLeave('convertShopeeLink', { affiliateUrl, usedMethod });
  return {
    affiliateUrl,
    fullAffiliateUrl,
    usedMethod,
    note
  };
}

module.exports = {
  convertShopeeLink,
  buildShopeeRedirectLink,
  generateShopeeOpenApiLink
};
