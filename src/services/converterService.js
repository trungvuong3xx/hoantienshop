const logger = require('../utils/logger');
const {
  extractUrlsFromText,
  detectPlatform,
  unshortenUrl,
  cleanShopeeUrl,
  cleanTikTokUrl
} = require('./urlResolver');
const { convertShopeeLink } = require('./shopeeService');
const { convertTikTokLink } = require('./tiktokService');

/**
 * Process a single URL: resolve redirects, detect platform, clean tracking, and convert to affiliate link.
 */
async function processSingleUrl(originalUrl, config = {}) {
  logger.logEnter('processSingleUrl', { originalUrl });
  try {
    // Step 1: Unshorten / resolve redirects
    const { resolvedUrl, htmlSnippet } = await unshortenUrl(originalUrl);

    // Step 2: Detect platform on the resolved URL (or original URL)
    let platform = detectPlatform(resolvedUrl);
    if (platform === 'unknown' || platform === 'shortener') {
      platform = detectPlatform(originalUrl);
    }

    if (platform === 'shopee') {
      const cleanInfo = cleanShopeeUrl(resolvedUrl);
      const conv = await convertShopeeLink(cleanInfo, config);

      const itemResult = {
        originalUrl,
        resolvedUrl,
        cleanUrl: cleanInfo.cleanUrl,
        platform: 'shopee',
        linkType: cleanInfo.linkType,
        shopId: cleanInfo.shopId,
        itemId: cleanInfo.itemId,
        productId: cleanInfo.itemId,
        affiliateUrl: conv.affiliateUrl,
        fullAffiliateUrl: conv.fullAffiliateUrl,
        usedMethod: conv.usedMethod,
        note: conv.note || '',
        status: 'success'
      };
      logger.logLeave('processSingleUrl', {
        originalUrl,
        platform: 'shopee',
        affiliateUrl: itemResult.affiliateUrl
      });
      return itemResult;
    }

    if (platform === 'tiktok') {
      const cleanInfo = cleanTikTokUrl(resolvedUrl, htmlSnippet);
      const conv = await convertTikTokLink(cleanInfo, config);

      const itemResult = {
        originalUrl,
        resolvedUrl,
        cleanUrl: cleanInfo.cleanUrl,
        platform: 'tiktok',
        linkType: cleanInfo.linkType,
        productId: conv.productId,
        affiliateCenterUrl: conv.affiliateCenterUrl,
        affiliateUrl: conv.affiliateUrl,
        fullAffiliateUrl: conv.fullAffiliateUrl,
        usedMethod: conv.usedMethod,
        note: conv.note || '',
        status: 'success'
      };
      logger.logLeave('processSingleUrl', {
        originalUrl,
        platform: 'tiktok',
        affiliateUrl: itemResult.affiliateUrl
      });
      return itemResult;
    }

    // Unsupported / non-affiliate URL: keep as-is
    logger.warning('processSingleUrl', 'URL is neither Shopee nor TikTok', {
      originalUrl,
      resolvedUrl
    });
    return {
      originalUrl,
      resolvedUrl,
      cleanUrl: resolvedUrl,
      platform: 'other',
      affiliateUrl: originalUrl,
      usedMethod: 'Giữ nguyên (Không phải link Shopee/TikTok)',
      status: 'skipped'
    };
  } catch (err) {
    logger.error('processSingleUrl', 'Error converting URL', {
      originalUrl,
      error: err.message
    });
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      cleanUrl: originalUrl,
      platform: detectPlatform(originalUrl),
      affiliateUrl: originalUrl,
      usedMethod: 'Lỗi chuyển đổi',
      error: err.message,
      status: 'error'
    };
  }
}

/**
 * Process an entire text block containing one or multiple Shopee / TikTok links.
 */
async function convertTextLinks(inputText, config = {}) {
  logger.logEnter('convertTextLinks', { textLength: inputText ? inputText.length : 0 });

  const urls = extractUrlsFromText(inputText);
  if (urls.length === 0) {
    logger.logLeave('convertTextLinks', { totalFound: 0 });
    return {
      originalText: inputText,
      convertedText: inputText,
      items: [],
      summary: {
        total: 0,
        shopeeCount: 0,
        tiktokCount: 0,
        successCount: 0,
        errorCount: 0
      }
    };
  }

  // Process all unique URLs concurrently
  const items = await Promise.all(urls.map((u) => processSingleUrl(u, config)));

  // Replace URLs in the original text (sort by length descending to prevent partial prefix replacements)
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
  convertTextLinks
};
