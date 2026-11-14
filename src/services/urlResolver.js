const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const http = require('http');
const { Readable } = require('stream');
const logger = require('../utils/logger');

// Top-level configurable constants
const DEFAULT_USER_AGENT =
  process.env.RESOLVER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_TOTAL_TIMEOUT_MS = 6000;
const DEFAULT_HOP_TIMEOUT_MS = 3500;
const DEFAULT_DNS_TIMEOUT_MS = 2000;
const DEFAULT_MAX_HOPS = 4;
const MAX_HTML_BYTES = 16384;
const MAX_TEXT_INPUT_LENGTH = 30000;
const MAX_EXTRACTED_URLS = 15;

const RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RESOLVE_CACHE_SIZE = 500;
const resolveCache = new Map();

// Platform domain & host configuration
const PLATFORM_CONFIG = {
  shopee: {
    canonicalHosts: new Set([
      'shopee.vn',
      'www.shopee.vn',
      'affiliate.shopee.vn'
    ]),
    shortenerHosts: new Set([
      's.shopee.vn',
      'vn.shp.ee',
      'shp.ee',
      'shope.ee'
    ]),
    cdnHosts: [
      'cf.shopee.vn',
      'susercontent.com',
      'shopeemobile.com'
    ]
  },
  tiktok: {
    canonicalHosts: new Set([
      'tiktok.com',
      'www.tiktok.com',
      'shop.tiktok.com',
      'm.tiktok.com'
    ]),
    shortenerHosts: new Set([
      'vt.tiktok.com',
      'vm.tiktok.com'
    ]),
    cdnHosts: [
      'tiktokcdn.com',
      'ibyteimg.com',
      'byteoversea.com'
    ]
  }
};

const ALL_ALLOWED_HOSTS = new Set([
  ...PLATFORM_CONFIG.shopee.canonicalHosts,
  ...PLATFORM_CONFIG.shopee.shortenerHosts,
  ...PLATFORM_CONFIG.tiktok.canonicalHosts,
  ...PLATFORM_CONFIG.tiktok.shortenerHosts
]);

// Custom Error Class
class UrlResolveError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'UrlResolveError';
    this.code = code;
    this.details = details;
  }
}

// Net BlockList for Private & Special IP ranges (SSRF prevention)
const blockList = new net.BlockList();

// IPv4 subnets
blockList.addSubnet('0.0.0.0', 8, 'ipv4');
blockList.addSubnet('10.0.0.0', 8, 'ipv4');
blockList.addSubnet('100.64.0.0', 10, 'ipv4');
blockList.addSubnet('127.0.0.0', 8, 'ipv4');
blockList.addSubnet('169.254.0.0', 16, 'ipv4');
blockList.addSubnet('172.16.0.0', 12, 'ipv4');
blockList.addSubnet('192.0.0.0', 24, 'ipv4');
blockList.addSubnet('192.0.2.0', 24, 'ipv4');
blockList.addSubnet('192.88.99.0', 24, 'ipv4');
blockList.addSubnet('192.168.0.0', 16, 'ipv4');
blockList.addSubnet('198.18.0.0', 15, 'ipv4');
blockList.addSubnet('198.51.100.0', 24, 'ipv4');
blockList.addSubnet('203.0.113.0', 24, 'ipv4');
blockList.addSubnet('224.0.0.0', 4, 'ipv4');
blockList.addSubnet('240.0.0.0', 4, 'ipv4');
blockList.addAddress('255.255.255.255', 'ipv4');

// IPv6 subnets & addresses
blockList.addAddress('::', 'ipv6');
blockList.addAddress('::1', 'ipv6');
blockList.addSubnet('64:ff9b::', 96, 'ipv6');
blockList.addSubnet('100::', 64, 'ipv6');
blockList.addSubnet('2001::', 23, 'ipv6');
blockList.addSubnet('2001:db8::', 32, 'ipv6');
blockList.addSubnet('2002::', 16, 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');
blockList.addSubnet('fec0::', 10, 'ipv6');
blockList.addSubnet('ff00::', 8, 'ipv6');

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const trimmed = ip.trim();

  // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    const rest = trimmed.slice(7);
    if (net.isIPv4(rest)) {
      return blockList.check(rest, 'ipv4');
    }
    const hexParts = rest.split(':');
    if (hexParts.length === 2) {
      const p1 = parseInt(hexParts[0], 16);
      const p2 = parseInt(hexParts[1], 16);
      if (!Number.isNaN(p1) && !Number.isNaN(p2)) {
        const v4 = `${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`;
        return blockList.check(v4, 'ipv4');
      }
    }
    return true; // Fail closed
  }

  if (net.isIPv4(trimmed)) {
    return blockList.check(trimmed, 'ipv4');
  }
  if (net.isIPv6(trimmed)) {
    return blockList.check(trimmed, 'ipv6');
  }

  return true; // Fail closed
}

function normalizeHost(host) {
  if (!host || typeof host !== 'string') return '';
  return host.toLowerCase().trim().replace(/:\d+$/, '');
}

const ALLOWED_AFFILIATE_REDIRECT_HOSTS = new Set([
  'go.isclix.com',
  'is.gd',
  'tinyurl.com',
  's.shopee.vn',
  'shp.ee',
  'vt.tiktok.com',
  'vm.tiktok.com'
]);

function isAllowedHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;
  return ALL_ALLOWED_HOSTS.has(h);
}

/**
 * Validates outbound /go/:clickId redirect URLs (Shopee/TikTok hosts, trusted shorteners & AccessTrade deeplinks).
 */
function isAllowedAffiliateRedirectUrl(rawUrl, customTemplateUrl = '') {
  logger.logEnter('isAllowedAffiliateRedirectUrl', { url: sanitizeUrlForLog(rawUrl) });
  if (!rawUrl || typeof rawUrl !== 'string') {
    logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: false, reason: 'empty' });
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: false, reason: 'protocol_or_auth' });
      return false;
    }
    const hostname = normalizeHost(parsed.hostname);
    if (!hostname) {
      logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: false, reason: 'empty_host' });
      return false;
    }

    if (isAllowedHost(hostname) || ALLOWED_AFFILIATE_REDIRECT_HOSTS.has(hostname)) {
      logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: true, host: hostname });
      return true;
    }

    if (customTemplateUrl && typeof customTemplateUrl === 'string') {
      try {
        const tplParsed = new URL(customTemplateUrl.trim());
        const tplHost = normalizeHost(tplParsed.hostname);
        if (tplParsed.protocol === 'https:' && tplHost && hostname === tplHost) {
          logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: true, customTemplateHost: tplHost });
          return true;
        }
      } catch {}
    }

    logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: false, host: hostname });
    return false;
  } catch {
    logger.logLeave('isAllowedAffiliateRedirectUrl', { allowed: false, reason: 'parse_error' });
    return false;
  }
}

function isAllowedCdnImage(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const host = normalizeHost(parsed.hostname);

    for (const cdn of PLATFORM_CONFIG.shopee.cdnHosts) {
      if (host === cdn || host.endsWith('.' + cdn)) return true;
    }
    for (const cdn of PLATFORM_CONFIG.tiktok.cdnHosts) {
      if (host === cdn || host.endsWith('.' + cdn)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function safeDecode(str) {
  if (typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str);
  } catch {
    try {
      return decodeURI(str);
    } catch {
      return str;
    }
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    });
}

function sanitizeTitle(text, maxLength = 120) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.replace(/<[^>]*>/g, ' ');
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = cleaned.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  cleaned = cleaned
    .replace(/\s*\|\s*Shopee.*$/i, '')
    .replace(/\s*\|\s*TikTok\s*(?:Shop)?.*$/i, '')
    .replace(/\s*-\s*TikTok\s*(?:Shop)?.*$/i, '')
    .replace(/\s*-\s*Mua sắm trên Shopee.*$/i, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  const lower = cleaned.toLowerCase();
  if (
    lower.includes('shopee verification') ||
    lower.includes('robot check') ||
    lower.includes('security check') ||
    lower.includes('captcha') ||
    lower.includes('just a moment') ||
    lower.includes('attention required')
  ) {
    return '';
  }

  const chars = Array.from(cleaned);
  if (chars.length > maxLength) {
    return chars.slice(0, maxLength).join('').trim();
  }
  return cleaned;
}

function sanitizeImageUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const trimmed = urlStr.trim();
  if (/[\x00-\x1f\x7f-\x9f<>"'`\\]/.test(trimmed)) return '';
  if (!isAllowedCdnImage(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return '';
    const decodedHref = safeDecode(parsed.href);
    if (/[\x00-\x1f\x7f-\x9f<>"'`\\]/.test(decodedHref)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function sanitizeUrlForLog(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return urlStr.split('?')[0].slice(0, 100);
  }
}

async function discardBody(res) {
  if (!res || !res.body) return;
  try {
    if (typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {}
}

async function readLimitedText(response, maxBytes = MAX_HTML_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { stream: true });
  let result = '';
  let totalBytes = 0;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const remainingBytes = maxBytes - totalBytes;
      const chunk = value.byteLength > remainingBytes ? value.subarray(0, remainingBytes) : value;

      result += decoder.decode(chunk, { stream: true });
      totalBytes += chunk.byteLength;

      if (value.byteLength > remainingBytes) break;
    }
    result += decoder.decode();
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw err;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  return result;
}

async function resolveHostIps(hostname, timeoutMs = DEFAULT_DNS_TIMEOUT_MS) {
  if (net.isIP(hostname)) {
    return [hostname];
  }

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new UrlResolveError('TIMEOUT', 'Quá thời gian phân giải tên miền.', { hostname }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });

  const dnsPromise = (async () => {
    const results = [];
    const [ipv4Res, ipv6Res] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname)
    ]);

    if (ipv4Res.status === 'fulfilled' && Array.isArray(ipv4Res.value)) {
      results.push(...ipv4Res.value);
    }
    if (ipv6Res.status === 'fulfilled' && Array.isArray(ipv6Res.value)) {
      results.push(...ipv6Res.value);
    }

    if (results.length === 0) {
      try {
        const lookupRes = await dns.lookup(hostname, { all: true });
        if (Array.isArray(lookupRes)) {
          results.push(...lookupRes.map((r) => r.address));
        }
      } catch (err) {
        throw new UrlResolveError('NETWORK_ERROR', `Không thể phân giải tên miền: ${hostname}`, {
          hostname,
          error: err.message
        });
      }
    }

    if (results.length === 0) {
      throw new UrlResolveError('NETWORK_ERROR', `Không tìm thấy địa chỉ IP cho tên miền: ${hostname}`, {
        hostname
      });
    }

    return results;
  })();

  try {
    return await Promise.race([dnsPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

const URL_WITH_SCHEME_REGEX = /https?:\/\/[^\s<>"')\]}]+/gi;
const SCHEMELESS_SHORT_REGEX =
  /(?:^|[\s<>"'(\[])((?:s\.shopee\.vn|vn\.shp\.ee|shp\.ee|shope\.ee|vt\.tiktok\.com|vm\.tiktok\.com)\/[a-zA-Z0-9_\-/?=&#.]+)/gi;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?"'»`’”\)\]\}\…]+$/;

function extractUrlsFromText(text) {
  const textLen = text && typeof text === 'string' ? text.length : 0;
  logger.logEnter('extractUrlsFromText', { textLength: textLen });
  try {
    if (!text || typeof text !== 'string') {
      logger.logLeave('extractUrlsFromText', { count: 0 });
      return [];
    }

    const boundedText = text.slice(0, MAX_TEXT_INPUT_LENGTH);
    const candidates = [];

    const schemeMatches = boundedText.match(URL_WITH_SCHEME_REGEX) || [];
    for (const u of schemeMatches) {
      candidates.push(u);
    }

    let sm;
    while ((sm = SCHEMELESS_SHORT_REGEX.exec(boundedText)) !== null) {
      if (sm[1]) {
        candidates.push('https://' + sm[1]);
      }
    }

    const cleaned = [];
    for (const raw of candidates) {
      const trimmed = raw.replace(TRAILING_PUNCTUATION_REGEX, '').trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (isAllowedHost(parsed.hostname)) {
          cleaned.push(parsed.toString());
        }
      } catch {}
    }

    const unique = Array.from(new Set(cleaned)).slice(0, MAX_EXTRACTED_URLS);
    logger.logLeave('extractUrlsFromText', { count: unique.length });
    return unique;
  } catch (err) {
    logger.warning('extractUrlsFromText', 'Extraction error', { error: err.message });
    return [];
  }
}

function detectPlatform(urlStr) {
  const safeUrl = sanitizeUrlForLog(urlStr);
  logger.logEnter('detectPlatform', { url: safeUrl });
  try {
    const parsed = new URL(urlStr);
    const host = normalizeHost(parsed.hostname);

    if (
      PLATFORM_CONFIG.shopee.canonicalHosts.has(host) ||
      PLATFORM_CONFIG.shopee.shortenerHosts.has(host)
    ) {
      logger.logLeave('detectPlatform', { platform: 'shopee' });
      return 'shopee';
    }

    if (
      PLATFORM_CONFIG.tiktok.canonicalHosts.has(host) ||
      PLATFORM_CONFIG.tiktok.shortenerHosts.has(host)
    ) {
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
  const host = normalizeHost(urlObj.hostname);
  if (PLATFORM_CONFIG.shopee.shortenerHosts.has(host)) {
    return true;
  }
  if (PLATFORM_CONFIG.tiktok.shortenerHosts.has(host)) {
    return true;
  }
  if (PLATFORM_CONFIG.tiktok.canonicalHosts.has(host) && urlObj.pathname.startsWith('/t/')) {
    return true;
  }
  return false;
}

function extractDestinationFromHtml(html, baseUrl) {
  if (!html || typeof html !== 'string') return null;

  // 1. Meta refresh
  const refreshMatch =
    html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"'>\s]+)["']/i) ||
    html.match(/<meta[^>]+content=["']\d+;\s*url=([^"'>\s]+)["'][^>]+http-equiv=["']refresh["']/i);
  if (refreshMatch && refreshMatch[1]) {
    try {
      const candidate = new URL(decodeHtmlEntities(refreshMatch[1]), baseUrl);
      if (isAllowedHost(candidate.hostname)) {
        return candidate.toString();
      }
    } catch {}
  }

  // 2. OpenGraph og:url
  const ogUrlMatch =
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  if (ogUrlMatch && ogUrlMatch[1]) {
    try {
      const candidate = new URL(decodeHtmlEntities(ogUrlMatch[1]), baseUrl);
      if (isAllowedHost(candidate.hostname)) {
        return candidate.toString();
      }
    } catch {}
  }

  // 3. Link canonical
  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (canonicalMatch && canonicalMatch[1]) {
    try {
      const candidate = new URL(decodeHtmlEntities(canonicalMatch[1]), baseUrl);
      if (isAllowedHost(candidate.hostname)) {
        return candidate.toString();
      }
    } catch {}
  }

  // 4. Shopee product direct URL match
  const shopeeMatch = html.match(
    /https:\/\/(?:www\.)?shopee\.vn\/(?:product\/\d+\/\d+|[a-zA-Z0-9_.-]+-i\.\d+\.\d+)/i
  );
  if (shopeeMatch) {
    return decodeHtmlEntities(shopeeMatch[0]);
  }

  // 5. TikTok Shop direct product URL match
  const tiktokMatch = html.match(
    /https:\/\/(?:www|shop)\.tiktok\.com\/(?:view\/)?product\/(\d{15,22})/i
  );
  if (tiktokMatch && tiktokMatch[1]) {
    return `https://www.tiktok.com/view/product/${tiktokMatch[1]}`;
  }

  // 6. Embedded product_id in script/JSON
  const pidMatch =
    html.match(/"product_id"\s*:\s*"(\d{15,22})"/i) ||
    html.match(/"itemId"\s*:\s*"(\d{15,22})"/i);
  if (pidMatch && pidMatch[1]) {
    return `https://www.tiktok.com/view/product/${pidMatch[1]}`;
  }

  return null;
}

function extractProductTitleHint(rawUrl, htmlSnippet = '') {
  if (htmlSnippet && typeof htmlSnippet === 'string') {
    const ogTitleMatch =
      htmlSnippet.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      htmlSnippet.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogTitleMatch && ogTitleMatch[1]) {
      const sanitized = sanitizeTitle(ogTitleMatch[1]);
      if (sanitized) return sanitized;
    }

    const titleTagMatch = htmlSnippet.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleTagMatch && titleTagMatch[1]) {
      const sanitized = sanitizeTitle(titleTagMatch[1]);
      if (sanitized) return sanitized;
    }
  }

  try {
    const parsed = new URL(rawUrl);
    const decodedPath = safeDecode(parsed.pathname);
    const slugMatch = decodedPath.match(/^\/([^/]+)-i\.\d+\.\d+/);
    if (slugMatch && slugMatch[1]) {
      return sanitizeTitle(slugMatch[1].replace(/[-_]+/g, ' '));
    }
  } catch {}

  return '';
}

/**
 * Make an HTTP request with pinned IP to prevent DNS rebinding attacks.
 */
async function fetchPinned(urlStr, options = {}, pinnedIp = null) {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      servername: url.hostname
    };

    if (options.signal) {
      reqOptions.signal = options.signal;
    }

    if (pinnedIp) {
      const family = pinnedIp.includes(':') ? 6 : 4;
      reqOptions.lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') {
          cb = opts;
          opts = {};
        }
        if (opts && opts.all) {
          cb(null, [{ address: pinnedIp, family }]);
        } else {
          cb(null, pinnedIp, family);
        }
      };
    }

    const req = transport.request(reqOptions, (res) => {
      const webStream = Readable.toWeb(res);
      const webRes = new Response(webStream, {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers
      });
      resolve(webRes);
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * SSRF-hardened URL resolver:
 * - Strict domain allowlist per platform at every hop
 * - Pre-fetch DNS resolution & non-blocking c-ares IP checks against net.BlockList
 * - Overall deadline timeout (6s) + per-hop timeout (3.5s)
 * - Safe response streaming (16KB) with UTF-8 boundary preservation
 * - Fast-path return for direct product links without network resolution
 */
async function safeResolve(inputUrl, options = {}) {
  let maxHops = DEFAULT_MAX_HOPS;
  let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;
  let hopTimeoutMs = DEFAULT_HOP_TIMEOUT_MS;

  if (typeof options === 'number') {
    maxHops = options;
  } else if (typeof options === 'object' && options !== null) {
    if (Number.isFinite(options.maxHops) && options.maxHops > 0) maxHops = Math.min(options.maxHops, 10);
    if (Number.isFinite(options.totalTimeoutMs) && options.totalTimeoutMs > 0) {
      totalTimeoutMs = Math.min(options.totalTimeoutMs, 6000);
    }
    if (Number.isFinite(options.hopTimeoutMs) && options.hopTimeoutMs > 0) hopTimeoutMs = options.hopTimeoutMs;
  }
  totalTimeoutMs = Math.min(totalTimeoutMs, 6000);

  const safeLogUrl = sanitizeUrlForLog(inputUrl);
  logger.logEnter('safeResolve', { inputUrl: safeLogUrl });

  try {
    let url;
    try {
      url = new URL(inputUrl);
    } catch {
      throw new UrlResolveError('INVALID_URL', 'Định dạng liên kết không hợp lệ.', { inputUrl });
    }

    if (url.protocol === 'http:') {
      if (isAllowedHost(url.hostname)) {
        url.protocol = 'https:';
      } else {
        throw new UrlResolveError(
          'INSECURE_PROTOCOL',
          'Giao thức kết nối không an toàn (Chỉ hỗ trợ HTTPS).',
          { inputUrl }
        );
      }
    } else if (url.protocol !== 'https:') {
      throw new UrlResolveError(
        'INSECURE_PROTOCOL',
        'Giao thức kết nối không an toàn (Chỉ hỗ trợ HTTPS).',
        { inputUrl }
      );
    }

    if (!isAllowedHost(url.hostname)) {
      throw new UrlResolveError(
        'HOST_NOT_ALLOWED',
        'Tên miền không nằm trong danh sách hỗ trợ (Chỉ hỗ trợ Shopee & TikTok Shop).',
        { hostname: url.hostname }
      );
    }

    const cacheKey = url.toString();
    const cached = resolveCache.get(cacheKey);
    if (cached && Date.now() < cached.exp) {
      logger.logLeave('safeResolve', { resolvedUrl: cached.resolvedUrl, fromCache: true });
      return { resolvedUrl: cached.resolvedUrl, htmlSnippet: cached.htmlSnippet };
    }

    // Fast-path: if URL does not need unshortening, return directly without network fetch
    if (!needsUnshorten(url)) {
      logger.logLeave('safeResolve', { resolvedUrl: url.toString(), hops: 0 });
      return { resolvedUrl: url.toString(), htmlSnippet: '' };
    }

    const totalSignal = AbortSignal.timeout(totalTimeoutMs);
    let htmlSnippet = '';
    let originLinkFollowed = false;

    for (let hop = 0; hop < maxHops; hop++) {
      if (url.protocol !== 'https:' || !isAllowedHost(url.hostname)) {
        throw new UrlResolveError(
          'HOST_NOT_ALLOWED',
          'Tên miền không nằm trong danh sách hỗ trợ (Chỉ hỗ trợ Shopee & TikTok Shop).',
          { hostname: url.hostname }
        );
      }

      const originLink = url.searchParams.get('origin_link');
      if (originLink && !originLinkFollowed) {
        originLinkFollowed = true;
        try {
          const originParsed = new URL(originLink);
          if (originParsed.protocol === 'http:' && isAllowedHost(originParsed.hostname)) {
            originParsed.protocol = 'https:';
          }
          if (originParsed.protocol === 'https:' && isAllowedHost(originParsed.hostname)) {
            url = originParsed;
            if (!needsUnshorten(url)) {
              break;
            }
          }
        } catch {}
      }

      const ips = await resolveHostIps(url.hostname, DEFAULT_DNS_TIMEOUT_MS);
      if (!ips.length || ips.some((ip) => isPrivateIp(ip))) {
        throw new UrlResolveError(
          'SSRF_BLOCKED',
          'Địa chỉ máy chủ đích bị từ chối vì lý do bảo mật (SSRF Blocked).',
          { hostname: url.hostname, ips }
        );
      }

      if (!needsUnshorten(url)) {
        break;
      }

      const hopSignal = AbortSignal.timeout(hopTimeoutMs);
      const combinedSignal =
        typeof AbortSignal.any === 'function'
          ? AbortSignal.any([totalSignal, hopSignal])
          : hopSignal;

      const pinnedIp = ips[0];
      let res;
      try {
        res = await fetchPinned(
          url.toString(),
          {
            method: 'GET',
            headers: {
              'User-Agent': DEFAULT_USER_AGENT,
              Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
            },
            signal: combinedSignal
          },
          pinnedIp
        );
      } catch (fetchErr) {
        if (
          fetchErr.name === 'TimeoutError' ||
          fetchErr.name === 'AbortError' ||
          totalSignal.aborted
        ) {
          throw new UrlResolveError('TIMEOUT', 'Quá thời gian kết nối tới máy chủ đích.', {
            url: url.toString(),
            error: fetchErr.message
          });
        }
        throw new UrlResolveError('NETWORK_ERROR', 'Không thể kết nối tới máy chủ đích.', {
          url: url.toString(),
          error: fetchErr.message
        });
      }

      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await discardBody(res);
        let nextUrl;
        try {
          nextUrl = new URL(loc, url);
        } catch {
          throw new UrlResolveError('INVALID_URL', 'Địa chỉ chuyển hướng không hợp lệ.', { location: loc });
        }

        if (nextUrl.protocol === 'http:' && isAllowedHost(nextUrl.hostname)) {
          nextUrl.protocol = 'https:';
        }
        if (nextUrl.protocol !== 'https:' || !isAllowedHost(nextUrl.hostname)) {
          throw new UrlResolveError(
            'HOST_NOT_ALLOWED',
            'Tên miền chuyển hướng không nằm trong danh sách hỗ trợ.',
            { hostname: nextUrl.hostname }
          );
        }

        url = nextUrl;
        if (!needsUnshorten(url)) {
          break;
        }
        continue;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        try {
          htmlSnippet = await readLimitedText(res, MAX_HTML_BYTES);
        } catch (readErr) {
          if (readErr.name === 'TimeoutError' || totalSignal.aborted) {
            throw new UrlResolveError('TIMEOUT', 'Quá thời gian tải nội dung trang web.', {
              url: url.toString()
            });
          }
        }

        const extracted = extractDestinationFromHtml(htmlSnippet, url.toString());
        if (extracted && extracted !== url.toString()) {
          try {
            const nextUrl = new URL(extracted);
            if (nextUrl.protocol === 'http:' && isAllowedHost(nextUrl.hostname)) {
              nextUrl.protocol = 'https:';
            }
            if (nextUrl.protocol === 'https:' && isAllowedHost(nextUrl.hostname)) {
              url = nextUrl;
              if (!needsUnshorten(url)) {
                break;
              }
              continue;
            }
          } catch {}
        }
      } else {
        await discardBody(res);
      }

      break;
    }

    if (needsUnshorten(url)) {
      throw new UrlResolveError(
        'UNRESOLVED',
        'Không thể giải mã liên kết rút gọn (link có thể đã hết hạn hoặc bị chặn).',
        { finalUrl: url.toString() }
      );
    }

    const result = { resolvedUrl: url.toString(), htmlSnippet };

    if (resolveCache.size >= MAX_RESOLVE_CACHE_SIZE) {
      const firstKey = resolveCache.keys().next().value;
      resolveCache.delete(firstKey);
    }
    resolveCache.set(cacheKey, { ...result, exp: Date.now() + RESOLVE_CACHE_TTL_MS });

    logger.logLeave('safeResolve', { resolvedUrl: result.resolvedUrl });
    return result;
  } catch (err) {
    if (err instanceof UrlResolveError) {
      logger.warning('safeResolve', `Resolve failed (${err.code})`, { error: err.message, details: err.details });
      throw err;
    }
    logger.warning('safeResolve', 'Unexpected error', { error: err.message });
    throw new UrlResolveError('NETWORK_ERROR', err.message || 'Lỗi không xác định khi giải mã URL.');
  }
}

function cleanShopeeUrl(rawUrl, htmlSnippet = '') {
  const safeLogUrl = sanitizeUrlForLog(rawUrl);
  logger.logEnter('cleanShopeeUrl', { rawUrl: safeLogUrl });
  try {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UrlResolveError('INVALID_URL', 'Link Shopee không hợp lệ.', { rawUrl });
    }

    if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
      throw new UrlResolveError('HOST_NOT_ALLOWED', 'Link Shopee không hợp lệ.', { rawUrl });
    }

    const pathname = safeDecode(parsed.pathname);
    let shopId = null;
    let itemId = null;

    const productPathMatch = pathname.match(/\/(?:product|opaanlp)\/(\d+)\/(\d+)/i);
    const slugItemMatch = pathname.match(/-i\.(\d+)\.(\d+)/i);
    const usernameItemMatch = pathname.match(/^\/([a-zA-Z0-9_.-]+)\/(\d{8,15})$/);

    const EXCLUDED_PAGE_PREFIXES = new Set([
      'product', 'opaanlp', 'm', 'search', 'buyer', 'universal-link', 'an_redir',
      'shop', 'user', 'portal', 'daily_discover', 'flash_sale', 'cart'
    ]);

    if (productPathMatch) {
      shopId = productPathMatch[1];
      itemId = productPathMatch[2];
    } else if (slugItemMatch) {
      shopId = slugItemMatch[1];
      itemId = slugItemMatch[2];
    } else if (usernameItemMatch && !EXCLUDED_PAGE_PREFIXES.has(usernameItemMatch[1].toLowerCase())) {
      itemId = usernameItemMatch[2];
    }

    let titleHint = extractProductTitleHint(rawUrl, htmlSnippet);
    if (titleHint) {
      titleHint = sanitizeTitle(titleHint, 140);
    }

    let imageUrl = '';
    if (htmlSnippet && typeof htmlSnippet === 'string') {
      const imgMatch =
        htmlSnippet.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        htmlSnippet.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (imgMatch && imgMatch[1]) {
        imageUrl = sanitizeImageUrl(imgMatch[1]);
      }
    }

    if (shopId && itemId) {
      const cleanUrl = `https://shopee.vn/product/${shopId}/${itemId}`;
      logger.logLeave('cleanShopeeUrl', { cleanUrl, shopId, itemId, linkType: 'product' });
      return {
        cleanUrl,
        shopId,
        itemId,
        titleHint: titleHint || `Sản phẩm Shopee #${itemId}`,
        imageUrl,
        linkType: 'product'
      };
    }

    if (itemId) {
      const cleanUrl = `https://shopee.vn/product/0/${itemId}`;
      logger.logLeave('cleanShopeeUrl', { cleanUrl, itemId, linkType: 'product' });
      return {
        cleanUrl,
        shopId: null,
        itemId,
        titleHint: titleHint || `Sản phẩm Shopee #${itemId}`,
        imageUrl,
        linkType: 'product'
      };
    }

    const cleanParsed = new URL('https://shopee.vn' + parsed.pathname.replace(/^\/universal-link\//, '/'));
    const allowedParams = ['keyword', 'page', 'sortBy', 'promotionId', 'evcode', 'catid', 'shop'];
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
      itemId: null,
      titleHint: titleHint || 'Cửa hàng / Sự kiện Shopee',
      imageUrl,
      linkType: 'page'
    };
  } catch (err) {
    if (err instanceof UrlResolveError) throw err;
    throw new UrlResolveError('PARSE_ERROR', err.message || 'Lỗi khi phân tích liên kết Shopee.', { rawUrl });
  } finally {
    // ensure pairing
  }
}

function cleanTikTokUrl(rawUrl, htmlSnippet = '') {
  const safeLogUrl = sanitizeUrlForLog(rawUrl);
  logger.logEnter('cleanTikTokUrl', { rawUrl: safeLogUrl });
  try {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UrlResolveError('INVALID_URL', 'Link TikTok không hợp lệ.', { rawUrl });
    }

    if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
      throw new UrlResolveError('HOST_NOT_ALLOWED', 'Link TikTok không hợp lệ.', { rawUrl });
    }

    const decodedPath = safeDecode(parsed.pathname);
    let productId = null;

    const productMatch = decodedPath.match(/\/product\/(\d{15,22})/i);
    const searchParamId =
      parsed.searchParams.get('product_id') ||
      parsed.searchParams.get('item_id') ||
      parsed.searchParams.get('share_item_id');

    if (productMatch) {
      productId = productMatch[1];
    } else if (searchParamId && /^\d{15,22}$/.test(searchParamId)) {
      productId = searchParamId;
    } else if (htmlSnippet && typeof htmlSnippet === 'string') {
      const htmlMatch =
        htmlSnippet.match(/"product_id"\s*:\s*"(\d{15,22})"/) ||
        htmlSnippet.match(/\/product\/(\d{15,22})/);
      if (htmlMatch) productId = htmlMatch[1];
    }

    let titleHint = extractProductTitleHint(rawUrl, htmlSnippet);
    let imageUrl = '';

    const ogInfoRaw = parsed.searchParams.get('og_info');
    if (ogInfoRaw) {
      try {
        const ogObj = JSON.parse(ogInfoRaw);
        if (ogObj && typeof ogObj === 'object') {
          if (ogObj.title) {
            const sanitized = sanitizeTitle(String(ogObj.title), 140);
            if (sanitized) titleHint = sanitized;
          }
          if (ogObj.image) {
            imageUrl = sanitizeImageUrl(ogObj.image);
          }
        }
      } catch {}
    }

    if (!imageUrl && htmlSnippet && typeof htmlSnippet === 'string') {
      const imgMatch =
        htmlSnippet.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
        htmlSnippet.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (imgMatch && imgMatch[1]) {
        imageUrl = sanitizeImageUrl(imgMatch[1]);
      }
    }

    if (productId) {
      const cleanUrl = `https://www.tiktok.com/view/product/${productId}`;
      logger.logLeave('cleanTikTokUrl', { cleanUrl, productId, linkType: 'product' });
      return {
        cleanUrl,
        productId,
        titleHint: titleHint || `Sản phẩm TikTok Shop #${productId}`,
        imageUrl,
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
      imageUrl,
      linkType: 'content'
    };
  } catch (err) {
    if (err instanceof UrlResolveError) throw err;
    throw new UrlResolveError('PARSE_ERROR', err.message || 'Lỗi khi phân tích liên kết TikTok.', { rawUrl });
  } finally {
    // ensure pairing
  }
}

async function resolveUrlsBatch(urls, concurrency = 4) {
  if (!Array.isArray(urls)) return [];
  const results = [];
  const executing = new Set();

  for (const url of urls) {
    const p = Promise.resolve().then(() => safeResolve(url));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

module.exports = {
  UrlResolveError,
  PLATFORM_CONFIG,
  extractUrlsFromText,
  detectPlatform,
  safeResolve,
  unshortenUrl: safeResolve,
  resolveUrlsBatch,
  cleanShopeeUrl,
  cleanTikTokUrl,
  isAllowedHost,
  isAllowedAffiliateRedirectUrl,
  isAllowedCdnImage,
  isPrivateIp,
  safeDecode,
  sanitizeTitle,
  sanitizeImageUrl,
  fetchPinned
};
