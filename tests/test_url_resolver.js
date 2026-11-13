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
  sanitizeTitle
} = require('../src/services/urlResolver');

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
  console.log('--- 1. Testing safeDecode ---');
  assert(safeDecode('/%E0%A4%A') === '/%E0%A4%A', 'safeDecode malformed percent encoding does not throw');
  assert(safeDecode('/%C4%91i%E1%BB%87n-tho%E1%BA%A1i') === '/điện-thoại', 'safeDecode valid utf8 percent encoding');

  console.log('--- 2. Testing UrlResolveError ---');
  const err = new UrlResolveError('HOST_NOT_ALLOWED', 'Custom message', { host: 'evil.com' });
  assert(err instanceof Error && err.name === 'UrlResolveError', 'UrlResolveError is instance of Error');
  assert(err.code === 'HOST_NOT_ALLOWED' && err.message === 'Custom message', 'UrlResolveError code and message');

  console.log('--- 3. Testing isPrivateIp & net.BlockList ---');
  assert(isPrivateIp('127.0.0.1') === true, '127.0.0.1 blocked');
  assert(isPrivateIp('10.0.0.1') === true, '10.0.0.1 blocked');
  assert(isPrivateIp('169.254.169.254') === true, '169.254.169.254 blocked');
  assert(isPrivateIp('192.168.1.1') === true, '192.168.1.1 blocked');
  assert(isPrivateIp('192.0.0.1') === true, '192.0.0.1 blocked');
  assert(isPrivateIp('198.18.0.1') === true, '198.18.0.1 blocked');
  assert(isPrivateIp('224.0.0.1') === true, '224.0.0.1 blocked');
  assert(isPrivateIp('240.0.0.1') === true, '240.0.0.1 blocked');
  assert(isPrivateIp('255.255.255.255') === true, '255.255.255.255 blocked');
  assert(isPrivateIp('::1') === true, '::1 blocked');
  assert(isPrivateIp('fe80::1') === true, 'fe80::1 blocked');
  assert(isPrivateIp('fc00::1') === true, 'fc00::1 blocked');
  assert(isPrivateIp('::ffff:127.0.0.1') === true, '::ffff:127.0.0.1 blocked');
  assert(isPrivateIp('::ffff:7f00:1') === true, '::ffff:7f00:1 blocked');
  assert(isPrivateIp('8.8.8.8') === false, '8.8.8.8 allowed');
  assert(isPrivateIp('1.1.1.1') === false, '1.1.1.1 allowed');

  console.log('--- 4. Testing isAllowedHost ---');
  assert(isAllowedHost('shopee.vn') === true, 'shopee.vn allowed');
  assert(isAllowedHost('s.shopee.vn') === true, 's.shopee.vn allowed');
  assert(isAllowedHost('vn.shp.ee') === true, 'vn.shp.ee allowed');
  assert(isAllowedHost('tiktok.com') === true, 'tiktok.com allowed');
  assert(isAllowedHost('vt.tiktok.com') === true, 'vt.tiktok.com allowed');
  assert(isAllowedHost('evil.com') === false, 'evil.com blocked');
  assert(isAllowedHost('shopee.vn.evil.com') === false, 'dangling subdomain blocked');

  console.log('--- 5. Testing isAllowedCdnImage ---');
  assert(isAllowedCdnImage('https://cf.shopee.vn/file/abc.jpg') === true, 'Shopee cf CDN allowed');
  assert(isAllowedCdnImage('https://down-vn.img.susercontent.com/file/abc.jpg') === true, 'susercontent CDN allowed');
  assert(isAllowedCdnImage('https://p16-va.tiktokcdn.com/obj/abc.jpeg') === true, 'tiktokcdn allowed');
  assert(isAllowedCdnImage('https://attacker.com/tracker.png') === false, 'attacker.com blocked');
  assert(isAllowedCdnImage('http://cf.shopee.vn/file/abc.jpg') === false, 'insecure http CDN blocked');

  console.log('--- 6. Testing sanitizeTitle ---');
  assert(sanitizeTitle('Tai nghe Bluetooth &quot;Pro&quot; | Shopee') === 'Tai nghe Bluetooth "Pro"', 'HTML entities & Shopee suffix stripped');
  assert(sanitizeTitle('Shopee Verification') === '', 'Anti-bot title dropped');

  console.log('--- 7. Testing cleanShopeeUrl ---');
  const shopLink = cleanShopeeUrl('https://shopee.vn/shop/12345678');
  assert(shopLink.linkType === 'page' && shopLink.itemId === null, 'cleanShopeeUrl /shop/ does not mistake shopId as itemId');
  const prodLink = cleanShopeeUrl('https://shopee.vn/product/111/222');
  assert(prodLink.linkType === 'product' && prodLink.shopId === '111' && prodLink.itemId === '222', 'cleanShopeeUrl /product/ extracted');
  const badPercentLink = cleanShopeeUrl('https://shopee.vn/%E0%A4%A-i.111.222');
  assert(badPercentLink.linkType === 'product' && badPercentLink.itemId === '222', 'cleanShopeeUrl malformed % path handled safely');

  console.log('--- 8. Testing cleanTikTokUrl ---');
  const ttProd = cleanTikTokUrl('https://www.tiktok.com/view/product/172948291029384728?og_info=%7B%22title%22%3A%22Ao%20Thun%22%2C%22image%22%3A%22https%3A%2F%2Fattacker.com%2Ftrack.png%22%7D');
  assert(ttProd.productId === '172948291029384728', 'TikTok product ID extracted');
  assert(ttProd.imageUrl === '', 'Untrusted image host rejected in cleanTikTokUrl');
  assert(ttProd.cleanUrl === 'https://www.tiktok.com/view/product/172948291029384728', 'TikTok cleanUrl format standard');

  console.log('--- 9. Testing extractUrlsFromText ---');
  const textWithSchemeless = 'Xem link này: s.shopee.vn/AbCd123... hoặc vt.tiktok.com/ZyXw987, nhanh nhé!';
  const extracted = extractUrlsFromText(textWithSchemeless);
  assert(extracted.includes('https://s.shopee.vn/AbCd123'), 'Schemeless Shopee link extracted and punctuation stripped');
  assert(extracted.includes('https://vt.tiktok.com/ZyXw987'), 'Schemeless TikTok link extracted');

  console.log('--- 10. Testing safeResolve fast-path & SSRF rejection ---');
  const fast = await safeResolve('https://shopee.vn/product/123/456');
  assert(fast.resolvedUrl === 'https://shopee.vn/product/123/456', 'safeResolve direct product link returns fast without fetch');

  let caughtDisallowed = false;
  try {
    await safeResolve('https://attacker.com/steal');
  } catch (e) {
    caughtDisallowed = e.code === 'HOST_NOT_ALLOWED';
  }
  assert(caughtDisallowed, 'safeResolve rejects unauthorized domain with HOST_NOT_ALLOWED');

  let caughtInsecure = false;
  try {
    await safeResolve('ftp://shopee.vn/test');
  } catch (e) {
    caughtInsecure = e.code === 'INSECURE_PROTOCOL';
  }
  assert(caughtInsecure, 'safeResolve rejects non-http/https protocol with INSECURE_PROTOCOL');

  console.log('\nFinal Results: ' + passed + ' passed, ' + failed + ' failed.');
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
