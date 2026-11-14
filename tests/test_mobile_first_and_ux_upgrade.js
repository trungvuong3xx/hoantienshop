/**
 * Verification Suite 20: Mobile-First UX, Performance, Transparency & Technical SEO Upgrade
 * Covers Waves 1, 2 & 3: [PERF-01], [BIZ-01], [ADM-01], [MOB-01], [MOB-02], [MOB-03], [UI-01], [SEO-01]
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'public/styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public/app.js'), 'utf8');

function runTests() {
  console.log('=== Suite 20: Mobile-First UX, Performance & SEO Upgrade Verification ===');

  // 1. [PERF-01] Eliminate duplicate /api/user/me call in initBoot()
  const initBootMatch = appJs.match(/async function initBoot\(\) \{([\s\S]*?)^\}/m);
  assert.ok(initBootMatch, '[PERF-01] initBoot() function exists in public/app.js');
  const initBootBody = initBootMatch[1];
  assert.ok(
    !initBootBody.includes("apiFetch('/api/user/me')"),
    '[PERF-01] initBoot() does not make a separate redundant /api/user/me fetch before loadUserDashboard()'
  );
  assert.ok(
    initBootBody.includes('Promise.all') && initBootBody.includes('loadUserDashboard()'),
    '[PERF-01] initBoot() executes initPublicConfig() and loadUserDashboard() concurrently via Promise.all'
  );
  assert.ok(
    initBootBody.includes('skipReload'),
    '[PERF-01] initBoot() passes skipReload guard when initialHash === "wallet" to avoid double fetch'
  );

  // 2. [BIZ-01] Customer Wallet Orders: platform badge, date, search, pagination, refresh loading, Lưu đơn label
  assert.ok(html.includes('id="userOrderSearchInput"'), '[BIZ-01] #userOrderSearchInput exists in index.html');
  assert.ok(html.includes('id="userOrderSearchBtn"'), '[BIZ-01] #userOrderSearchBtn exists in index.html');
  assert.ok(html.includes('id="userOrdersPageInfo"'), '[BIZ-01] #userOrdersPageInfo exists in index.html');
  assert.ok(html.includes('id="userOrdersPrevBtn"'), '[BIZ-01] #userOrdersPrevBtn exists in index.html');
  assert.ok(html.includes('id="userOrdersNextBtn"'), '[BIZ-01] #userOrdersNextBtn exists in index.html');

  assert.ok(
    appJs.includes('function renderUserOrdersTable(orders)') &&
      appJs.includes('async function loadUserOrdersPage(') &&
      appJs.includes('/api/user/me?'),
    '[BIZ-01] renderUserOrdersTable & loadUserOrdersPage implemented calling /api/user/me pagination'
  );
  assert.ok(
    appJs.includes('plat-badge-inline tiktok') &&
      appJs.includes('plat-badge-inline shopee') &&
      appJs.includes('o.orderAmount'),
    '[BIZ-01] Customer orders rows render platform badge (Shopee / TikTok) and orderAmount'
  );
  assert.ok(
    appJs.includes("refreshBtn.textContent = 'Đang tải...'") &&
      appJs.includes("refreshBtn.textContent = 'Làm mới số dư'"),
    '[UX-01] #refreshWalletBtn toggles loading text and restores exact label'
  );
  assert.ok(
    html.includes('id="confirmActionModal"') &&
      appJs.includes('function askUserConfirm(') &&
      appJs.includes('await askUserConfirm('),
    '[UX-01] Custom WebView-friendly confirm modal (#confirmActionModal + askUserConfirm) implemented'
  );
  assert.ok(
    appJs.includes("btn.textContent = 'Lưu đơn'") && !appJs.includes("btn.textContent = 'Gửi Mã Đơn Hàng'"),
    '[BIZ-01] #submitOrderClaimBtn resets to "Lưu đơn" matching public/index.html'
  );

  // 3. [ADM-01] Admin Withdrawals search, status filter, pagination & API wiring
  assert.ok(html.includes('id="admWithdrawalSearchInput"'), '[ADM-01] #admWithdrawalSearchInput exists in index.html');
  assert.ok(html.includes('id="admWithdrawalStatusFilter"'), '[ADM-01] #admWithdrawalStatusFilter exists in index.html');
  assert.ok(html.includes('id="admWithdrawalSearchBtn"'), '[ADM-01] #admWithdrawalSearchBtn exists in index.html');
  assert.ok(html.includes('id="admWithdrawalsPageInfo"'), '[ADM-01] #admWithdrawalsPageInfo exists in index.html');
  assert.ok(html.includes('id="admWithdrawalsPrevBtn"'), '[ADM-01] #admWithdrawalsPrevBtn exists in index.html');
  assert.ok(html.includes('id="admWithdrawalsNextBtn"'), '[ADM-01] #admWithdrawalsNextBtn exists in index.html');
  assert.ok(
    appJs.includes('function renderAdminWithdrawalsTable(withdrawals)') &&
      appJs.includes('async function loadAdminWithdrawalsPage(') &&
      appJs.includes('/api/admin/withdrawals?'),
    '[ADM-01] renderAdminWithdrawalsTable & loadAdminWithdrawalsPage wired to /api/admin/withdrawals'
  );
  assert.ok(
    appJs.includes("on('admWithdrawalStatusFilter', 'change'") &&
      appJs.includes("on('admWithdrawalsPrevBtn', 'click'") &&
      appJs.includes("on('admWithdrawalsNextBtn', 'click'"),
    '[ADM-01] Admin withdrawals filter & pagination listeners attached'
  );

  // 4. [MOB-01] Fixed Mobile Bottom Navigation Bar & widget spacing
  assert.ok(html.includes('id="mobileBottomNav"'), '[MOB-01] #mobileBottomNav exists in index.html');
  assert.ok(html.includes('id="mobileNavAdminBtn"'), '[MOB-01] #mobileNavAdminBtn exists in index.html');
  assert.ok(
    appJs.includes("document.getElementById('mobileNavAdminBtn')"),
    '[MOB-01] syncAuthUi toggles #mobileNavAdminBtn based on admin role'
  );
  assert.ok(
    css.includes('.mobile-bottom-nav') &&
      css.includes('.mobile-nav-item') &&
      css.includes('safe-area-inset-bottom'),
    '[MOB-01] CSS defines .mobile-bottom-nav with safe-area-inset-bottom support'
  );

  // 5. [MOB-02] Mobile Card Tables + data-label attributes
  const mobileTableCount = (html.match(/class="data-table mobile-card-table"/g) || []).length;
  assert.strictEqual(
    mobileTableCount,
    4,
    '[MOB-02] All 4 customer wallet/referral tables carry mobile-card-table class'
  );
  assert.ok(
    appJs.includes('data-label="Mã đơn"') &&
      appJs.includes('data-label="Thời gian"') &&
      appJs.includes('data-label="Ngày"') &&
      appJs.includes('data-label="SĐT bạn bè"'),
    '[MOB-02] Wallet order, ledger, withdrawal, and referral rows include data-label attributes'
  );
  assert.ok(
    css.includes('table.mobile-card-table tbody td::before') && css.includes('content: attr(data-label)'),
    '[MOB-02] styles.css renders data-label pseudo-headers on <= 640px mobile view'
  );

  // 6. [MOB-03] Mobile Paste-to-Buy 1-tap auto-convert & smooth scroll
  assert.ok(
    appJs.includes("productUrlInput.addEventListener('paste'") &&
      appJs.includes('handleGetCashbackLink()') &&
      appJs.includes('conversionResultSection?.scrollIntoView'),
    '[MOB-03] Direct paste & pasteBtn auto-convert valid URLs and smoothly scroll to results'
  );

  // 7. [UI-01] Instant Preview & Design System classes
  const requiredDesignClasses = [
    '.ip-status-badge',
    '.ip-info',
    '.ip-meta',
    '.ip-auth-notice',
    '.ip-thumb-fallback',
    '.ref-stats-grid',
    '.modal-section-divider',
    '.cashback-calc-box'
  ];
  requiredDesignClasses.forEach((cls) => {
    assert.ok(css.includes(cls), `[UI-01] styles.css defines ${cls}`);
  });

  // 8. [SEO-01] Technical SEO: robots.txt, sitemap.xml, Open Graph/Twitter & JSON-LD
  const robotsPath = path.join(ROOT_DIR, 'public/robots.txt');
  const sitemapPath = path.join(ROOT_DIR, 'public/sitemap.xml');
  assert.ok(fs.existsSync(robotsPath), '[SEO-01] public/robots.txt exists');
  assert.ok(fs.existsSync(sitemapPath), '[SEO-01] public/sitemap.xml exists');

  const robotsTxt = fs.readFileSync(robotsPath, 'utf8');
  assert.ok(
    robotsTxt.includes('Disallow: /api/') &&
      robotsTxt.includes('Disallow: /go/') &&
      robotsTxt.includes('Sitemap: https://hoantiensan.online/sitemap.xml'),
    '[SEO-01] robots.txt disallows private API/redirect routes and links sitemap.xml'
  );

  const sitemapXml = fs.readFileSync(sitemapPath, 'utf8');
  assert.ok(
    sitemapXml.includes('<urlset') && sitemapXml.includes('https://hoantiensan.online/'),
    '[SEO-01] sitemap.xml declares canonical URL in valid XML urlset'
  );

  assert.ok(
    html.includes('property="og:url"') && html.includes('name="twitter:card"'),
    '[SEO-01] index.html includes og:url and Twitter Card meta tags'
  );

  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  assert.ok(jsonLdMatch, '[SEO-01] index.html includes application/ld+json script');
  const parsedJsonLd = JSON.parse(jsonLdMatch[1]);
  assert.ok(Array.isArray(parsedJsonLd['@graph']), '[SEO-01] JSON-LD contains valid @graph array');
  const graphTypes = parsedJsonLd['@graph'].map((item) => item['@type']);
  assert.ok(
    graphTypes.includes('WebApplication') && graphTypes.includes('FAQPage'),
    '[SEO-01] JSON-LD @graph declares both WebApplication and FAQPage schemas'
  );

  console.log('ALL SUITE 20 CHECKS PASSED!');
}

try {
  runTests();
  process.exit(0);
} catch (err) {
  console.error('SUITE 20 FAILED:', err);
  process.exit(1);
}
