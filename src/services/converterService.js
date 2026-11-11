const crypto = require('crypto');
const logger = require('../utils/logger');
const {
  extractUrlsFromText,
  detectPlatform,
  safeResolve,
  cleanShopeeUrl,
  cleanTikTokUrl
} = require('./urlResolver');
const { convertShopeeLink } = require('./shopeeService');
const { convertTikTokLink } = require('./tiktokService');

function generateClickId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Process a single URL: safeResolve (SSRF-protected), detect platform, generate random click_id, convert.
 */
async function processSingleUrl(originalUrl, config = {}) {
  logger.logEnter('processSingleUrl', { originalUrl });
  try {
    const { resolvedUrl, htmlSnippet } = await safeResolve(originalUrl);
    let platform = detectPlatform(resolvedUrl);
    if (platform === 'unknown') {
      platform = detectPlatform(originalUrl);
    }

    // Generate unique opaque click_id (16 hex chars, alphanumeric for Shopee Sub_id compatibility)
    const clickId = generateClickId();
    const perClickConfig = {
      ...config,
      subId: clickId
    };

    if (platform === 'shopee') {
      const cleanInfo = cleanShopeeUrl(resolvedUrl, htmlSnippet);
      const conv = await convertShopeeLink(cleanInfo, perClickConfig);

      const meta = conv.productMeta || {};
      const itemResult = {
        originalUrl,
        resolvedUrl,
        cleanUrl: cleanInfo.cleanUrl,
        platform: 'shopee',
        linkType: cleanInfo.linkType,
        shopId: cleanInfo.shopId,
        itemId: cleanInfo.itemId,
        productId: cleanInfo.itemId,
        clickId,
        productName: meta.productName || cleanInfo.titleHint || 'Sản phẩm Shopee',
        imageUrl: meta.imageUrl || '',
        price: meta.price || 0,
        commissionRate: meta.commissionRate || 0,
        affiliateUrl: conv.affiliateUrl,
        fullAffiliateUrl: conv.fullAffiliateUrl,
        usedMethod: conv.usedMethod,
        note: conv.note || '',
        status: 'success'
      };
      logger.logLeave('processSingleUrl', { platform: 'shopee', clickId });
      return itemResult;
    }

    if (platform === 'tiktok') {
      const cleanInfo = cleanTikTokUrl(resolvedUrl, htmlSnippet);
      const conv = await convertTikTokLink(cleanInfo, perClickConfig);

      const itemResult = {
        originalUrl,
        resolvedUrl,
        cleanUrl: cleanInfo.cleanUrl,
        platform: 'tiktok',
        linkType: cleanInfo.linkType,
        productId: conv.productId,
        clickId,
        productName: cleanInfo.titleHint || 'Sản phẩm TikTok Shop',
        imageUrl: '',
        price: 0,
        commissionRate: 0,
        affiliateUrl: conv.affiliateUrl,
        fullAffiliateUrl: conv.fullAffiliateUrl,
        usedMethod: conv.usedMethod,
        note: conv.note || '',
        status: 'success'
      };
      logger.logLeave('processSingleUrl', { platform: 'tiktok', clickId });
      return itemResult;
    }

    return {
      originalUrl,
      resolvedUrl,
      cleanUrl: resolvedUrl,
      platform: 'other',
      affiliateUrl: originalUrl,
      usedMethod: 'Không hỗ trợ',
      status: 'skipped'
    };
  } catch (err) {
    logger.error('processSingleUrl', 'Error converting URL', { error: err.message });
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      cleanUrl: originalUrl,
      platform: 'unknown',
      affiliateUrl: originalUrl,
      usedMethod: 'Lỗi chuyển đổi',
      error: err.message,
      status: 'error'
    };
  }
}

async function convertTextLinks(inputText, config = {}) {
  logger.logEnter('convertTextLinks', { textLength: inputText ? inputText.length : 0 });

  const urls = extractUrlsFromText(inputText);
  if (urls.length === 0) {
    logger.logLeave('convertTextLinks', { totalFound: 0 });
    return {
      originalText: inputText,
      convertedText: inputText,
      items: [],
      summary: { total: 0, shopeeCount: 0, tiktokCount: 0, successCount: 0, errorCount: 0 }
    };
  }

  const items = await Promise.all(urls.map((u) => processSingleUrl(u, config)));

  let convertedText = inputText;
  const sortedItems = [...items].sort((a, b) => b.originalUrl.length - a.originalUrl.length);
  for (const item of sortedItems) {
    if (item.status === 'success' && item.affiliateUrl) {
      convertedText = convertedText.split(item.originalUrl).join(item.affiliateUrl);
    }
  }

  const summary = {
    total: items.length,
    shopeeCount: items.filter((i) => i.platform === 'shopee').length,
    tiktokCount: items.filter((i) => i.platform === 'tiktok').length,
    successCount: items.filter((i) => i.status === 'success').length,
    errorCount: items.filter((i) => i.status === 'error').length
  };

  logger.logLeave('convertTextLinks', summary);
  return {
    originalText: inputText,
    convertedText,
    items,
    summary
  };
}

module.exports = {
  processSingleUrl,
  convertTextLinks,
  generateClickId
};
