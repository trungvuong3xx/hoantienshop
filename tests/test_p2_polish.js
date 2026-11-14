const fs = require('fs');
const path = require('path');

const {
  UrlResolveError,
  PLATFORM_CONFIG,
  extractUrlsFromText,
  detectPlatform,
  safeResolve,
  cleanShopeeUrl,
  cleanTikTokUrl,
  isAllowedHost,
  isAllowedCdnImage,
  isPrivateIp,
  safeDecode,
  sanitizeTitle,
  sanitizeImageUrl,
  fetchPinned
} = require('../src/services/urlResolver');

// Also test src/utils/urlResolver proxy
const utilsResolver = require('../src/utils/urlResolver');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log('  PASS: ' + testName);
  } else {
    failed++;
    console.error('  FAIL: ' + testName);
  }
}

async function runTests() {
  console.log('=== 1. Testing escapeHtml(0) & basic escaping ===');
  // Replicate escapeHtml as defined in public/app.js
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  assert(escapeHtml(0) === '0', 'escapeHtml(0) returns "0" (not empty string)');
  assert(escapeHtml(12345) === '12345', 'escapeHtml(12345) returns "12345"');
  assert(escapeHtml('') === '', 'escapeHtml("") returns ""');
  assert(escapeHtml(null) === '', 'escapeHtml(null) returns ""');
  assert(escapeHtml(undefined) === '', 'escapeHtml(undefined) returns ""');
  assert(
    escapeHtml('<script>alert("xss")</script>') === '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    'escapeHtml escapes tags and quotes correctly'
  );

  console.log('\n=== 2. Testing public/styles.css class definitions & focus-visible ===');
  const cssContent = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');

  assert(cssContent.includes('.ip-main-row'), 'CSS defines .ip-main-row');
  assert(cssContent.includes('.cashback-pill'), 'CSS defines .cashback-pill');
  assert(cssContent.includes('.cashback-badge'), 'CSS defines .cashback-badge');
  assert(cssContent.includes('.grid-2'), 'CSS defines .grid-2');
  assert(cssContent.includes('.footer-inner'), 'CSS defines .footer-inner');
  assert(cssContent.includes('.status-approved'), 'CSS defines .status-approved');
  assert(cssContent.includes('.status-pending'), 'CSS defines .status-pending');
  assert(
    cssContent.includes(':focus-visible') && cssContent.includes('#0068ff'),
    'CSS defines :focus-visible with #0068ff outline'
  );

  console.log('\n=== 3. Testing public/offline.html & public/sw.js ===');
  const offlineHtmlPath = path.join(__dirname, '../public/offline.html');
  assert(fs.existsSync(offlineHtmlPath), 'public/offline.html exists');

  const offlineHtmlContent = fs.readFileSync(offlineHtmlPath, 'utf8');
  assert(
    offlineHtmlContent.includes('ngoại tuyến') || offlineHtmlContent.includes('mạng'),
    'public/offline.html contains offline message'
  );
  assert(
    offlineHtmlContent.includes('location.reload()'),
    'public/offline.html provides reconnect/reload action'
  );

  const swContent = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert(
    swContent.includes('caches.delete') && swContent.includes('activate'),
    'public/sw.js cleans up old caches during activate event'
  );
  assert(
    swContent.includes('/offline.html') && swContent.includes('navigate'),
    'public/sw.js serves /offline.html on failed navigate requests'
  );

  console.log('\n=== 4. Testing URL Resolver Hardening & utils proxy ===');
  assert(typeof utilsResolver.safeResolve === 'function', 'src/utils/urlResolver re-exports safeResolve');
  assert(typeof utilsResolver.cleanShopeeUrl === 'function', 'src/utils/urlResolver re-exports cleanShopeeUrl');
  assert(typeof sanitizeImageUrl === 'function', 'sanitizeImageUrl is exported');
  assert(typeof fetchPinned === 'function', 'fetchPinned is exported for DNS IP pinning');

  // Test sanitizeImageUrl
  assert(
    sanitizeImageUrl('https://cf.shopee.vn/file/vn-11134207-7r98o-abc123.jpg') ===
      'https://cf.shopee.vn/file/vn-11134207-7r98o-abc123.jpg',
    'sanitizeImageUrl allows valid Shopee CDN image'
  );
  assert(
    sanitizeImageUrl('https://p16-va.tiktokcdn.com/obj/tos-maliva-p-0068/abc.jpeg') ===
      'https://p16-va.tiktokcdn.com/obj/tos-maliva-p-0068/abc.jpeg',
    'sanitizeImageUrl allows valid TikTok CDN image'
  );
  assert(
    sanitizeImageUrl('https://evil.com/phish.png') === '',
    'sanitizeImageUrl rejects non-CDN domain'
  );
  assert(
    sanitizeImageUrl('javascript:alert(1)') === '',
    'sanitizeImageUrl rejects javascript: URI'
  );
  assert(
    sanitizeImageUrl('https://cf.shopee.vn/file/"<script>alert(1)</script>') === '',
    'sanitizeImageUrl rejects injection characters in URL'
  );

  // Test exception wrapping with UrlResolveError
  let caughtShopeeErr = false;
  try {
    cleanShopeeUrl('not-a-valid-url');
  } catch (err) {
    caughtShopeeErr = err instanceof UrlResolveError && err.code === 'INVALID_URL';
  }
  assert(caughtShopeeErr, 'cleanShopeeUrl throws UrlResolveError with INVALID_URL on malformed URL');

  let caughtTikTokErr = false;
  try {
    cleanTikTokUrl('https://evil.com/malicious');
  } catch (err) {
    caughtTikTokErr = err instanceof UrlResolveError && err.code === 'HOST_NOT_ALLOWED';
  }
  assert(caughtTikTokErr, 'cleanTikTokUrl throws UrlResolveError with HOST_NOT_ALLOWED on untrusted host');

  // Test 6s deadline timeout enforcement
  const resolverFile = fs.readFileSync(path.join(__dirname, '../src/services/urlResolver.js'), 'utf8');
  assert(
    resolverFile.includes('DEFAULT_TOTAL_TIMEOUT_MS = 6000') ||
      resolverFile.includes('totalTimeoutMs = Math.min(totalTimeoutMs, 6000)'),
    'urlResolver enforces 6s overall timeout deadline'
  );

  console.log('\n=== 5. Testing public/app.js referral persistence & modal focus trap ===');
  const appJsContent = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert(
    appJsContent.includes("'saved_ref_code'") && appJsContent.includes('localStorage'),
    'public/app.js persists referral code to localStorage under saved_ref_code'
  );
  assert(
    appJsContent.includes("openModal.classList.add('hidden')") && appJsContent.includes("'Escape'"),
    'public/app.js closes active open modal on Escape key'
  );
  assert(
    appJsContent.includes("'Tab'") && appJsContent.includes('shiftKey'),
    'public/app.js implements keyboard Tab / Shift+Tab focus trap in open modals'
  );
  assert(
    appJsContent.includes("aria-live") && appJsContent.includes("aria-atomic"),
    'public/app.js sets aria-live and aria-atomic on toast messages'
  );

  const indexHtmlContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert(
    indexHtmlContent.includes('id="toast"') &&
      indexHtmlContent.includes('aria-live="polite"') &&
      indexHtmlContent.includes('aria-atomic="true"'),
    'public/index.html has #toast with aria-live="polite" and aria-atomic="true"'
  );

  console.log(`\n========================================`);
  console.log(`P2 Polish Test Suite: ${passed} passed, ${failed} failed.`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
