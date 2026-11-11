const dns = require('dns').promises;
const net = require('net');
const logger = require('../utils/logger');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const URL_REGEX = /https?:\/\/[^\s<>"')\]}]+/gi;

// Strict domain whitelist for SSRF & Open Redirect prevention
const ALLOWED_DOMAINS = ['shopee.vn', 'shp.ee', 'shope.ee', 'tiktok.com'];

function isAllowedHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase().trim();
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::' || /^(fc|fd|fe80)/i.test(norm)) return true;
    if (norm.startsWith('::ffff:')) {
      return isPrivateIp(norm.slice(7));
    }
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Read at most maxBytes from a response body stream to prevent memory exhaustion.
 */
async function readLimitedText(response, maxBytes = 16384) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Ignore stream cancellation errors
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function extractUrlsFromText(text) {
  logger.logEnter('extractUrlsFromText', { textLength: text ? text.length : 0 });
  if (!text || typeof text !== 'string') {
    logger.logLeave('extractUrlsFromText', { count: 0 });
    return [];
  }
  const rawMatches = text.match(URL_REGEX) || [];
  const cleaned = rawMatches.map((u) => u.replace(/[.,;!?]+$/, ''));
  const unique = Array.from(new Set(cleaned)).slice(0, 15);
  logger.logLeave('extractUrlsFromText', { count: unique.length });
  return unique;
}

function detectPlatform(urlStr) {
  logger.logEnter('detectPlatform', { url: urlStr });
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (!isAllowedHost(host)) {
      logger.logLeave('detectPlatform', { platform: 'unknown' });
      return 'unknown';
    }
    if (host.includes('shopee') || host.includes('shp.ee') || host.includes('shope.ee')) {
      logger.logLeave('detectPlatform', { platform: 'shopee' });
      return 'shopee';
    }
    if (host.includes('tiktok.com')) {
      logger.logLeave('detectPlatform', { platform: 'tiktok' });
      return 'tiktok';
    }
  } catch (err) {
    logger.warning('detectPlatform', 'Invalid URL', { error: err.message });
  }
  logger.logLeave('detectPlatform', { platform: 'unknown' });
  return 'unknown';
}

function needsUnshorten(urlObj) {
  const host = urlObj.hostname.toLowerCase();
  if (
    ['s.shopee.vn', 'vn.shp.ee', 'shp.ee', 'shope.ee', 'vt.tiktok.com', 'vm.tiktok.com'].some(
      (h) => host === h || host.endsWith('.' + h)
    )
  ) {
    return true;
  }
  if (host.includes('tiktok.com') && urlObj.pathname.startsWith('/t/')) {
    return true;
  }
  return false;
}

/**
 * SSRF-hardened URL resolver:
 * - Enforces HTTPS & strict domain whitelist at every single hop
 * - Resolves DNS and blocks private/loopback/metadata IPs at every hop
 * - Max 4 hops, 4000ms timeout per hop, 16KB stream limit
 */
async function safeResolve(inputUrl, maxHops = 4) {
  logger.logEnter('safeResolve', { inputUrl });
  let url = new URL(inputUrl);
  let htmlSnippet = '';

  for (let hop = 0; hop <= maxHops; hop++) {
    if (url.protocol !== 'https:' || !isAllowedHost(url.hostname)) {
      throw new Error('Tên miền không nằm trong danh sách hỗ trợ (Chỉ hỗ trợ Shopee & TikTok Shop).');
    }

    // Check embedded origin_link on s.shopee.vn/an_redir and re-validate in next loop iteration
    const originLink = url.searchParams.get('origin_link');
    if (originLink) {
      url = new URL(originLink);
      continue;
    }

    const addrs = await dns.lookup(url.hostname, { all: true });
    if (!addrs || addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error('Địa chỉ máy chủ đích bị từ chối vì lý do bảo mật (SSRF Blocked).');
    }

    if (!needsUnshorten(url)) {
      logger.logLeave('safeResolve', { resolvedUrl: url.toString(), hop });
      return { resolvedUrl: url.toString(), htmlSnippet };
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(4000)
    });

    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try {
        if (res.body) await res.body.cancel();
      } catch {}
      url = new URL(loc, url);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      htmlSnippet = await readLimitedText(res, 16384);
      const extracted = extractDestinationFromHtml(htmlSnippet, url.toString());
      if (extracted && extracted !== url.toString()) {
        url = new URL(extracted);
        continue;
      }
    } else {
      try {
        if (res.body) await res.body.cancel();
      } catch {}
    }

    logger.logLeave('safeResolve', { resolvedUrl: url.toString(), hop });
    return { resolvedUrl: url.toString(), htmlSnippet };
  }

  throw new Error('Liên kết chuyển hướng quá nhiều lần.');
}

function extractDestinationFromHtml(html, baseUrl) {
  if (!html) return null;
  const metaMatch = html.match(/content=["']\d+;\s*url=([^"'>\s]+)["']/i);
  if (metaMatch && metaMatch[1]) {
    try {
      const candidate = new URL(metaMatch[1].replace(/&amp;/g, '&'), baseUrl);
      if (candidate.protocol === 'https:' && isAllowedHost(candidate.hostname)) {
        return candidate.toString();
      }
    } catch {}
  }

  const shopeeMatch = html.match(
    /https:\/\/(?:www\.)?shopee\.vn\/(?:product\/\d+\/\d+|[^\s"'<>]+-i\.\d+\.\d+)/i
  );
  if (shopeeMatch) return shopeeMatch[0].replace(/&amp;/g, '&');

  const tiktokMatch = html.match(/https:\/\/(?:shop|www)\.tiktok\.com\/view\/product\/\d+/i);
  if (tiktokMatch) return tiktokMatch[0];

  const tiktokPidMatch =
    html.match(/"product_id"\s*:\s*"(\d{15,22})"/) || html.match(/product\/(\d{15,22})/);
  if (tiktokPidMatch && tiktokPidMatch[1]) {
    return `https://shop.tiktok.com/view/product/${tiktokPidMatch[1]}`;
  }
  return null;
}

/**
 * Extract human-friendly product title from URL slug or HTML snippet.
 */
function extractProductTitleHint(rawUrl, htmlSnippet = '') {
  if (htmlSnippet) {
    const ogTitle =
      htmlSnippet.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
      htmlSnippet.match(/<title>([^<]+)<\/title>/i);
    if (ogTitle && ogTitle[1]) {
      return ogTitle[1].replace(/\s*\|\s*Shopee.*$/i, '').trim().slice(0, 120);
    }
  }
  try {
    const parsed = new URL(rawUrl);
    const decoded = decodeURIComponent(parsed.pathname);
    const slugMatch = decoded.match(/^\/([^/]+)-i\.\d+\.\d+/);
    if (slugMatch && slugMatch[1]) {
      return slugMatch[1].replace(/-/g, ' ').trim().slice(0, 120);
    }
  } catch {}
  return '';
}

function cleanShopeeUrl(rawUrl, htmlSnippet = '') {
  logger.logEnter('cleanShopeeUrl', { rawUrl });
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    throw new Error('Link Shopee không hợp lệ.');
  }

  const pathname = decodeURIComponent(parsed.pathname);
  let shopId = null;
  let itemId = null;

  const p1 = pathname.match(/\/(?:product|opaanlp)\/(\d+)\/(\d+)/i);
  const p2 = pathname.match(/-i\.(\d+)\.(\d+)/i);
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
    itemId = p3[2];
  }

  const titleHint = extractProductTitleHint(rawUrl, htmlSnippet);

  if (shopId && itemId) {
    const cleanUrl = `https://shopee.vn/product/${shopId}/${itemId}`;
    logger.logLeave('cleanShopeeUrl', { cleanUrl, shopId, itemId });
    return {
      cleanUrl,
      shopId,
      itemId,
      titleHint: titleHint || `Sản phẩm Shopee #${itemId}`,
      linkType: 'product'
    };
  }

  const cleanParsed = new URL('https://shopee.vn' + parsed.pathname.replace(/^\/universal-link\//, '/'));
  const allowedParams = ['keyword', 'page', 'sortBy', 'promotionId', 'evcode', 'catid'];
  for (const key of allowedParams) {
    if (parsed.searchParams.has(key)) {
      cleanParsed.searchParams.set(key, parsed.searchParams.get(key));
    }
  }

  const cleanUrl = cleanParsed.toString();
  logger.logLeave('cleanShopeeUrl', { cleanUrl, linkType: 'page' });
  return {
    cleanUrl,
    shopId: null,
    itemId,
    titleHint: titleHint || 'Cửa hàng / Sự kiện Shopee',
    linkType: 'page'
  };
}

function cleanTikTokUrl(rawUrl, htmlSnippet = '') {
  logger.logEnter('cleanTikTokUrl', { rawUrl });
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    throw new Error('Link TikTok không hợp lệ.');
  }

  const decodedPath = decodeURIComponent(parsed.pathname);
  let productId = null;

  const p1 = decodedPath.match(/\/(?:view\/)?product\/(\d{15,22})/i);
  const p2 =
    parsed.searchParams.get('product_id') ||
    parsed.searchParams.get('item_id') ||
    parsed.searchParams.get('share_item_id');

  if (p1) {
    productId = p1[1];
  } else if (p2 && /^\d{15,22}$/.test(p2)) {
    productId = p2;
  } else if (htmlSnippet) {
    const htmlMatch =
      htmlSnippet.match(/"product_id"\s*:\s*"(\d{15,22})"/) ||
      htmlSnippet.match(/\/product\/(\d{15,22})/);
    if (htmlMatch) productId = htmlMatch[1];
  }

  const titleHint = extractProductTitleHint(rawUrl, htmlSnippet);

  if (productId) {
    const cleanUrl = `https://shop.tiktok.com/view/product/${productId}`;
    logger.logLeave('cleanTikTokUrl', { cleanUrl, productId });
    return {
      cleanUrl,
      productId,
      titleHint: titleHint || `Sản phẩm TikTok Shop #${productId}`,
      linkType: 'product'
    };
  }

  const cleanParsed = new URL(parsed.origin + parsed.pathname);
  const cleanUrl = cleanParsed.toString();
  logger.logLeave('cleanTikTokUrl', { cleanUrl, linkType: 'content' });
  return {
    cleanUrl,
    productId: null,
    titleHint: titleHint || 'Sản phẩm TikTok Shop',
    linkType: 'content'
  };
}

module.exports = {
  extractUrlsFromText,
  detectPlatform,
  safeResolve,
  unshortenUrl: safeResolve,
  cleanShopeeUrl,
  cleanTikTokUrl,
  isAllowedHost,
  isPrivateIp
};
