const logger = require('../utils/logger');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const URL_REGEX = /https?:\/\/[^\s<>"')\]}]+/gi;

const SHOPEE_HOSTS = [
  'shopee.vn',
  'www.shopee.vn',
  's.shopee.vn',
  'vn.shp.ee',
  'shp.ee',
  'shope.ee'
];

const TIKTOK_HOSTS = [
  'tiktok.com',
  'www.tiktok.com',
  'vt.tiktok.com',
  'vm.tiktok.com',
  'shop.tiktok.com',
  'm.tiktok.com'
];

const SHORT_HOSTS = [
  's.shopee.vn',
  'vn.shp.ee',
  'shp.ee',
  'shope.ee',
  'vt.tiktok.com',
  'vm.tiktok.com',
  'is.gd',
  'tinyurl.com',
  'bit.ly',
  't.co',
  'go.isclix.com'
];

/**
 * Extract all URLs from input text while stripping trailing punctuation.
 */
function extractUrlsFromText(text) {
  logger.logEnter('extractUrlsFromText', { textLength: text ? text.length : 0 });
  if (!text || typeof text !== 'string') {
    logger.logLeave('extractUrlsFromText', { count: 0 });
    return [];
  }

  const rawMatches = text.match(URL_REGEX) || [];
  const cleaned = rawMatches.map((u) => u.replace(/[.,;!?]+$/, ''));
  const unique = Array.from(new Set(cleaned));

  logger.logLeave('extractUrlsFromText', { count: unique.length });
  return unique;
}

/**
 * Detect whether a URL belongs to Shopee, TikTok, or another shortener.
 */
function detectPlatform(urlStr) {
  logger.logEnter('detectPlatform', { url: urlStr });
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();

    if (SHOPEE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      logger.logLeave('detectPlatform', { platform: 'shopee' });
      return 'shopee';
    }
    if (TIKTOK_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      logger.logLeave('detectPlatform', { platform: 'tiktok' });
      return 'tiktok';
    }
    if (SHORT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      logger.logLeave('detectPlatform', { platform: 'shortener' });
      return 'shortener';
    }

    // Check if wrapped inside deep_link (e.g., Accesstrade url param)
    const innerUrl = parsed.searchParams.get('url') || parsed.searchParams.get('origin_link');
    if (innerUrl) {
      const innerPlatform = detectPlatform(innerUrl);
      logger.logLeave('detectPlatform', { platform: innerPlatform });
      return innerPlatform;
    }
  } catch (err) {
    logger.warning('detectPlatform', 'Invalid URL format', { url: urlStr, error: err.message });
  }
  logger.logLeave('detectPlatform', { platform: 'unknown' });
  return 'unknown';
}

/**
 * Check if a URL needs unshortening / redirect resolution.
 */
function needsUnshorten(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (SHORT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
      return true;
    }
    if (host.includes('tiktok.com') && parsed.pathname.startsWith('/t/')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Follow HTTP redirects and unwrap intermediate redirect parameters to find the destination URL.
 */
async function unshortenUrl(inputUrl, maxHops = 6) {
  logger.logEnter('unshortenUrl', { inputUrl });
  let currentUrl = inputUrl;
  let htmlSnippet = '';

  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const parsed = new URL(currentUrl);

      // 1. Check if the URL already contains an explicit target URL in query params (e.g. an_redir?origin_link=...)
      const embeddedOrigin =
        parsed.searchParams.get('origin_link') ||
        parsed.searchParams.get('url') ||
        parsed.searchParams.get('redirect');
      if (embeddedOrigin && /^https?:\/\//i.test(embeddedOrigin)) {
        logger.log('unshortenUrl', 'Extracted embedded origin URL from query param', {
          from: currentUrl,
          to: embeddedOrigin
        });
        currentUrl = embeddedOrigin;
        continue;
      }

      if (!needsUnshorten(currentUrl)) {
        break;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);

      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        const nextUrl = new URL(location, currentUrl).toString();
        logger.log('unshortenUrl', 'Followed HTTP redirect', { hop, from: currentUrl, to: nextUrl });
        currentUrl = nextUrl;
        continue;
      }

      // Some shortlinks (e.g. s.shopee.vn or vt.tiktok.com) may return 200 HTML with JS/meta redirect
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const body = await response.text();
        htmlSnippet = body.slice(0, 15000);

        // Look for Shopee/TikTok destination URL inside HTML
        const extractedFromHtml = extractDestinationFromHtml(htmlSnippet, currentUrl);
        if (extractedFromHtml && extractedFromHtml !== currentUrl) {
          logger.log('unshortenUrl', 'Extracted redirect URL from HTML body', {
            from: currentUrl,
            to: extractedFromHtml
          });
          currentUrl = extractedFromHtml;
          continue;
        }
      }

      break;
    } catch (err) {
      logger.warning('unshortenUrl', 'Redirect hop failed, stopping resolution', {
        hop,
        currentUrl,
        error: err.message
      });
      break;
    }
  }

  logger.logLeave('unshortenUrl', { resolvedUrl: currentUrl });
  return { resolvedUrl: currentUrl, htmlSnippet };
}

/**
 * Parse HTML body for meta refresh, canonical link, or embedded product URLs.
 */
function extractDestinationFromHtml(html, baseUrl) {
  if (!html) return null;

  // 1. Meta refresh
  const metaMatch = html.match(/content=["']\d+;\s*url=([^"'>\s]+)["']/i);
  if (metaMatch && metaMatch[1]) {
    try {
      return new URL(metaMatch[1].replace(/&amp;/g, '&'), baseUrl).toString();
    } catch {}
  }

  // 2. Shopee product link inside JS/HTML
  const shopeeMatch = html.match(
    /https?:\/\/(?:www\.)?shopee\.vn\/(?:product\/\d+\/\d+|[^\s"'<>]+-i\.\d+\.\d+)/i
  );
  if (shopeeMatch) {
    return shopeeMatch[0].replace(/&amp;/g, '&');
  }

  // 3. TikTok product link inside JS/HTML
  const tiktokMatch = html.match(
    /https?:\/\/(?:shop|www)\.tiktok\.com\/view\/product\/\d+/i
  );
  if (tiktokMatch) {
    return tiktokMatch[0];
  }

  // 4. TikTok product_id in JSON state
  const tiktokPidMatch =
    html.match(/"product_id"\s*:\s*"(\d{15,22})"/) ||
    html.match(/product\/(\d{15,22})/);
  if (tiktokPidMatch && tiktokPidMatch[1]) {
    return `https://shop.tiktok.com/view/product/${tiktokPidMatch[1]}`;
  }

  return null;
}

/**
 * Clean a Shopee URL and extract shopId / itemId if it is a product link.
 */
function cleanShopeeUrl(rawUrl) {
  logger.logEnter('cleanShopeeUrl', { rawUrl });
  try {
    let targetUrl = rawUrl;
    let parsed = new URL(targetUrl);

    // If it's an an_redir or universal-link with origin_link
    const originLink = parsed.searchParams.get('origin_link');
    if (originLink) {
      targetUrl = originLink;
      parsed = new URL(targetUrl);
    }

    const pathname = decodeURIComponent(parsed.pathname);

    let shopId = null;
    let itemId = null;

    // Pattern 1: /product/{shopId}/{itemId} or /opaanlp/{shopId}/{itemId} or /universal-link/product/{shopId}/{itemId}
    const p1 = pathname.match(/\/(?:product|opaanlp)\/(\d+)\/(\d+)/i);
    // Pattern 2: /{slug}-i.{shopId}.{itemId}
    const p2 = pathname.match(/-i\.(\d+)\.(\d+)/i);
    // Pattern 3: /{shopUsername}/{itemId} (where shopUsername is not a system prefix)
    const p3 = pathname.match(/^\/([a-zA-Z0-9_.-]+)\/(\d{8,15})$/);

    if (p1) {
      shopId = p1[1];
      itemId = p1[2];
    } else if (p2) {
      shopId = p2[1];
      itemId = p2[2];
    } else if (
      p3 &&
      !['product', 'opaanlp', 'm', 'search', 'buyer', 'universal-link', 'an_redir'].includes(
        p3[1].toLowerCase()
      )
    ) {
      // Some links are https://shopee.vn/shopname/23456789012?sp_atk=...
      itemId = p3[2];
    }

    if (shopId && itemId) {
      const cleanUrl = `https://shopee.vn/product/${shopId}/${itemId}`;
      logger.logLeave('cleanShopeeUrl', { cleanUrl, shopId, itemId, linkType: 'product' });
      return {
        cleanUrl,
        shopId,
        itemId,
        linkType: 'product'
      };
    }

    // For shop / campaign / voucher pages, strip all tracking & affiliate query params
    const cleanParsed = new URL(parsed.origin + parsed.pathname);
    // Keep only essential non-tracking params (like categoryId, page, keyword, promotionId, signature)
    const allowedParams = ['keyword', 'page', 'sortBy', 'promotionId', 'signature', 'evcode', 'catid'];
    for (const key of allowedParams) {
      if (parsed.searchParams.has(key)) {
        cleanParsed.searchParams.set(key, parsed.searchParams.get(key));
      }
    }

    // Remove universal-link prefix if present
    cleanParsed.pathname = cleanParsed.pathname.replace(/^\/universal-link\//, '/');
    cleanParsed.hostname = 'shopee.vn';

    const cleanUrl = cleanParsed.toString();
    logger.logLeave('cleanShopeeUrl', { cleanUrl, linkType: 'page' });
    return {
      cleanUrl,
      shopId: null,
      itemId,
      linkType: 'page'
    };
  } catch (err) {
    logger.error('cleanShopeeUrl', 'Failed to clean Shopee URL', { rawUrl, error: err.message });
    return {
      cleanUrl: rawUrl,
      shopId: null,
      itemId: null,
      linkType: 'raw'
    };
  }
}

/**
 * Clean a TikTok URL and extract productId if available.
 */
function cleanTikTokUrl(rawUrl, htmlSnippet = '') {
  logger.logEnter('cleanTikTokUrl', { rawUrl });
  try {
    let targetUrl = rawUrl;
    let parsed = new URL(targetUrl);

    // Unwrap if inside deep link query param
    const innerUrl = parsed.searchParams.get('url') || parsed.searchParams.get('origin_link');
    if (innerUrl && /^https?:\/\//i.test(innerUrl)) {
      targetUrl = innerUrl;
      parsed = new URL(targetUrl);
    }

    const decodedPath = decodeURIComponent(parsed.pathname);
    let productId = null;

    // Pattern 1: /view/product/{productId} or /product/{productId}
    const p1 = decodedPath.match(/\/(?:view\/)?product\/(\d{15,22})/i);
    // Pattern 2: query parameter product_id={productId} or item_id={productId}
    const p2 =
      parsed.searchParams.get('product_id') ||
      parsed.searchParams.get('item_id') ||
      parsed.searchParams.get('share_item_id');
    // Pattern 3: inside og_info or redirect params
    const ogInfo = parsed.searchParams.get('og_info');

    if (p1) {
      productId = p1[1];
    } else if (p2 && /^\d{15,22}$/.test(p2)) {
      productId = p2;
    } else if (ogInfo) {
      const ogMatch = ogInfo.match(/(\d{17,20})/);
      if (ogMatch) productId = ogMatch[1];
    }

    // Fallback: check HTML snippet if available
    if (!productId && htmlSnippet) {
      const htmlMatch =
        htmlSnippet.match(/"product_id"\s*:\s*"(\d{15,22})"/) ||
        htmlSnippet.match(/\/product\/(\d{15,22})/);
      if (htmlMatch) {
        productId = htmlMatch[1];
      }
    }

    if (productId) {
      const cleanUrl = `https://shop.tiktok.com/view/product/${productId}`;
      logger.logLeave('cleanTikTokUrl', { cleanUrl, productId, linkType: 'product' });
      return {
        cleanUrl,
        productId,
        linkType: 'product'
      };
    }

    // If it's a video or profile link, strip all tracking query parameters
    const cleanParsed = new URL(parsed.origin + parsed.pathname);
    const cleanUrl = cleanParsed.toString();
    logger.logLeave('cleanTikTokUrl', { cleanUrl, productId: null, linkType: 'content' });
    return {
      cleanUrl,
      productId: null,
      linkType: 'content'
    };
  } catch (err) {
    logger.error('cleanTikTokUrl', 'Failed to clean TikTok URL', { rawUrl, error: err.message });
    return {
      cleanUrl: rawUrl,
      productId: null,
      linkType: 'raw'
    };
  }
}

module.exports = {
  extractUrlsFromText,
  detectPlatform,
  unshortenUrl,
  cleanShopeeUrl,
  cleanTikTokUrl
};
