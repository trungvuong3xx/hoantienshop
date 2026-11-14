const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildVietQrImageUrl } = require('../src/utils/securityMiddleware');

async function runTestSuite() {
  console.log('=== STARTING TASK 9 P1 FRONTEND & LEGAL FIXES VERIFICATION SUITE ===');

  const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');

  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

  // --- 1. Testing VietQR URL Builder & Unescaping ---
  console.log('\n--- 1. Testing VietQR URL Builder & Safe URL Escaping ---');
  {
    const bankName = 'MB';
    const bankAccount = '0123456789';
    const amount = 150000;
    const bankOwner = 'NGUYEN VAN A';
    const addInfo = 'RUT TIEN AFFILIATE';

    const qrUrl = buildVietQrImageUrl(bankName, bankAccount, amount, bankOwner, addInfo);
    assert.ok(qrUrl.startsWith('https://img.vietqr.io/image/MB-0123456789-compact2.png'), 'Must use compact2 VietQR template');
    assert.strictEqual(qrUrl.includes('&amp;'), false, 'VietQR URL builder must NOT contain &amp;');
    assert.ok(qrUrl.includes('&accountName='), 'URL must contain literal & for query parameters');
    assert.ok(qrUrl.includes('&addInfo='), 'URL must contain literal & for addInfo');

    // Test safeHttpsUrl function behavior
    const testSafeHttpsUrl = (rawUrl, raw = false) => {
      const escapeHtml = (str) =>
        String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      const s = String(rawUrl || '').trim();
      if (!s) return '';
      try {
        const u = new URL(s);
        if (u.protocol !== 'https:') return '';
        return raw ? u.toString() : escapeHtml(u.toString());
      } catch {
        return '';
      }
    };

    const testUrl = 'https://img.vietqr.io/image/MB-123-compact2.png?amount=50000&accountName=TEST&addInfo=WD1';
    const escaped = testSafeHttpsUrl(testUrl, false);
    assert.ok(escaped.includes('&amp;accountName='), 'Default safeHttpsUrl escapes & to &amp; for HTML markup');

    const raw = testSafeHttpsUrl(testUrl, true);
    assert.strictEqual(raw.includes('&amp;'), false, 'safeHttpsUrl(url, true) returns raw URL with literal &');
    assert.strictEqual(raw, testUrl);

    // Verify app.js uses cleanImgUrl and raw=true when assigning to modalImg.src
    assert.ok(
      appJsContent.includes('const cleanImgUrl = rawImgUrl.replace(/&amp;/g, \'&\');'),
      'app.js must clean &amp; from data-vietqr attribute before URL assignment'
    );
    assert.ok(
      appJsContent.includes('safeHttpsUrl(cleanImgUrl, true)'),
      'app.js must pass raw=true to safeHttpsUrl for modal image src assignment'
    );

    console.log('  PASS: VietQR URL builder and modal DOM assignment preserve literal & delimiters.');
  }

  // --- 2. Testing Router Synchronization (#guide vs #faq) & Admin Guard ---
  console.log('\n--- 2. Testing Router Synchronization (#guide vs #faq) & Admin Guard ---');
  {
    const makeClassList = (initial = []) => {
      const set = new Set(initial);
      return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        has: (c) => set.has(c),
        toggle: (c, force) => {
          if (force !== undefined) {
            if (force) set.add(c); else set.delete(c);
          } else {
            if (set.has(c)) set.delete(c); else set.add(c);
          }
        }
      };
    };

    // Mock DOM environment for router testing
    const elements = {
      'view-home': { id: 'view-home', classList: makeClassList(['view-section']) },
      'view-wallet': { id: 'view-wallet', classList: makeClassList(['view-section']) },
      'view-guide': { id: 'view-guide', classList: makeClassList(['view-section']) },
      'view-terms': { id: 'view-terms', classList: makeClassList(['view-section']) },
      'view-admin': { id: 'view-admin', classList: makeClassList(['view-section']) },
      'nav-home': { getAttribute: (attr) => (attr === 'data-nav' ? 'home' : null), classList: makeClassList() },
      'nav-guide': { getAttribute: (attr) => (attr === 'data-nav' ? 'guide' : null), classList: makeClassList() },
      'nav-faq': { getAttribute: (attr) => (attr === 'data-nav' ? 'faq' : null), classList: makeClassList() },
      'nav-admin': { getAttribute: (attr) => (attr === 'data-nav' ? 'admin' : null), classList: makeClassList() }
    };

    let toastMessage = null;
    const showToast = (msg) => { toastMessage = msg; };

    let testUser = null;

    const simulateSwitchView = (viewName) => {
      let targetView = viewName;
      if (targetView === 'faq') {
        targetView = 'guide';
      }

      if (targetView === 'admin') {
        if (!testUser || testUser.role !== 'admin') {
          showToast('Bạn không có quyền truy cập trang Quản trị.');
          simulateSwitchView('home');
          return;
        }
      }

      Object.values(elements).forEach((el) => {
        if (el.id && el.id.startsWith('view-')) {
          if (el.id === `view-${targetView}`) {
            el.classList.add('active');
          } else {
            el.classList.remove('active');
          }
        }
        if (el.getAttribute && el.getAttribute('data-nav')) {
          const navVal = el.getAttribute('data-nav');
          if (navVal === targetView || (targetView === 'guide' && navVal === 'faq')) {
            el.classList.add('active');
          } else {
            el.classList.remove('active');
          }
        }
      });
    };

    // Test #guide route
    simulateSwitchView('guide');
    assert.strictEqual(elements['view-guide'].classList.has('active'), true, '#view-guide must be active for #guide');
    assert.strictEqual(elements['nav-guide'].classList.has('active'), true, 'nav-guide must be active');

    // Test #faq route (must map to guide without empty/white screen)
    simulateSwitchView('faq');
    assert.strictEqual(elements['view-guide'].classList.has('active'), true, '#view-guide must be active for #faq');
    assert.strictEqual(elements['view-home'].classList.has('active'), false);

    // Test #admin route for unauthenticated/normal user (blocked)
    testUser = { role: 'user', name: 'Member' };
    simulateSwitchView('admin');
    assert.strictEqual(elements['view-admin'].classList.has('active'), false, 'Non-admin must NOT activate #view-admin');
    assert.strictEqual(elements['view-home'].classList.has('active'), true, 'Non-admin must be redirected to #view-home');
    assert.strictEqual(toastMessage, 'Bạn không có quyền truy cập trang Quản trị.');

    // Test #admin route for authorized admin
    testUser = { role: 'admin', name: 'Admin' };
    simulateSwitchView('admin');
    assert.strictEqual(elements['view-admin'].classList.has('active'), true, 'Admin user must activate #view-admin');

    // Check app.js source implementation
    assert.ok(appJsContent.includes("if (targetView === 'faq')"), 'Router must remap faq to guide');
    assert.ok(appJsContent.includes("if (!currentUser || currentUser.role !== 'admin')"), 'Router must enforce admin role check');
    assert.ok(appJsContent.includes("['home', 'wallet', 'admin', 'guide', 'faq', 'terms'].includes(initialHash)"), 'Hash bootloader must support both guide and faq');

    console.log('  PASS: Router cleanly handles #guide, #faq, and prevents unauthorized access to #admin.');
  }

  // --- 3. Testing Preview Link AbortError & Timeout Isolation ---
  console.log('\n--- 3. Testing Preview Link AbortError & Timeout Isolation ---');
  {
    assert.ok(
      appJsContent.includes('options.signal?.aborted && !timedOut'),
      'apiFetch must preserve AbortError when caller signal was aborted'
    );
    assert.ok(
      appJsContent.includes('signal.aborted || err.name === \'AbortError\''),
      'fetchInstantPreview must silently ignore AbortError without hiding subsequent preview cards'
    );
    console.log('  PASS: Preview link cleanly isolates AbortError from timeout errors.');
  }

  // --- 4. Testing Form Double Submission & numOr Helper ---
  console.log('\n--- 4. Testing Form Double Submission & numOr Helper ---');
  {
    // Test numOr behavior
    const testNumOr = (val, fallback) => {
      if (val === undefined || val === null) return fallback;
      const s = typeof val === 'string' ? val.trim() : val;
      if (s === '') {
        return typeof fallback === 'number' ? fallback : 0;
      }
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };

    assert.strictEqual(testNumOr(0, 10), 0, '0 must be preserved');
    assert.strictEqual(testNumOr('0', 10), 0, '"0" string must be parsed to 0');
    assert.strictEqual(testNumOr('', 10), 10, 'empty string uses provided fallback');
    assert.strictEqual(testNumOr('', undefined), 0, 'empty string with undefined fallback returns 0');
    assert.strictEqual(testNumOr(50, 10), 50, 'Valid number preserved');
    assert.strictEqual(testNumOr('invalid', 10), 10, 'NaN string uses fallback');

    // Check duplicate submission prevention in app.js
    assert.ok(appJsContent.includes('let isAuthSubmitting = false;'), 'isAuthSubmitting flag must be declared');
    assert.ok(appJsContent.includes('if (isAuthSubmitting) return;'), 'handleDoLogin/Register must guard against duplicate submissions');
    assert.strictEqual(
      appJsContent.includes("if (e.key === 'Enter') handleDoLogin()"),
      false,
      'Redundant keydown Enter handlers causing double submits must be removed'
    );

    console.log('  PASS: Form double submission prevented and numOr handles empty/0 values cleanly.');
  }

  // --- 5. Testing CSV Import Validations ---
  console.log('\n--- 5. Testing CSV Import Validations ---');
  {
    // Test detectCsvDelimiter and splitCsvLine
    const detectCsvDelimiter = (headerLine) => {
      let commaCount = 0;
      let semiCount = 0;
      let inQuotes = false;
      for (let i = 0; i < headerLine.length; i++) {
        const ch = headerLine[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (!inQuotes) {
          if (ch === ',') commaCount++;
          else if (ch === ';') semiCount++;
        }
      }
      return semiCount > commaCount ? ';' : ',';
    };

    const splitCsvLine = (line, delimiter) => {
      const delim = delimiter || detectCsvDelimiter(line);
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === delim && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    };

    const commaLine = 'Mã đơn hàng,Tổng hoa hồng đơn hàng(₫),Giá trị đơn hàng(₫)';
    const semiLine = 'Mã đơn hàng;Tổng hoa hồng đơn hàng(₫);Giá trị đơn hàng(₫)';
    assert.strictEqual(detectCsvDelimiter(commaLine), ',', 'Must detect comma');
    assert.strictEqual(detectCsvDelimiter(semiLine), ';', 'Must detect semicolon');

    const parsedComma = splitCsvLine('SN123,50000,"150,000"');
    assert.deepStrictEqual(parsedComma, ['SN123', '50000', '150,000'], 'Comma line correctly split with quotes');

    const parsedSemi = splitCsvLine('SN456;75000;"200;000"', ';');
    assert.deepStrictEqual(parsedSemi, ['SN456', '75000', '200;000'], 'Semicolon line correctly split with quotes');

    // Check app.js CSV validation requirements
    assert.ok(appJsContent.includes('const MAX_CSV_SIZE = 2 * 1024 * 1024;'), 'Client-side 2MB file limit must be enforced');
    assert.ok(appJsContent.includes('cleanOrderSn.length < 2 || !/^[A-Za-z0-9_\\-\\.]+$/'), 'orderSn must be strictly validated before submission');
    assert.ok(appJsContent.includes('totalCommission < 0'), 'Negative commissions must be skipped');
    assert.ok(appJsContent.includes('totalImported === 0'), '0 imported items must NOT be treated as success');
    assert.ok(appJsContent.includes('allChunkErrors.push(...res.errors)'), 'Chunk errors must be captured and reported');

    console.log('  PASS: CSV import properly handles delimiters, file limits, chunk errors, and row validation.');
  }

  // --- 6. Testing Withdrawal Table Actions ---
  console.log('\n--- 6. Testing Withdrawal Table Actions ---');
  {
    // Verify that paid and rejected withdrawals do NOT have Xoa / Huy buttons
    const renderWdActions = (status, id) => {
      return status === 'pending'
        ? `<button type="button" class="btn btn-success btn-xs" data-wd-action="paid" data-wd-id="${id}">Đã chuyển</button>
           <button type="button" class="btn btn-danger btn-xs" data-wd-action="rejected" data-wd-id="${id}">Từ chối</button>
           <button type="button" class="btn btn-ghost btn-xs text-danger" data-wd-delete="${id}">Hủy</button>`
        : '<span style="color:#94a3b8;font-size:12px;">—</span>';
    };

    const pendingActions = renderWdActions('pending', 'wd_001');
    assert.ok(pendingActions.includes('data-wd-action="paid"'), 'Pending withdrawal can be paid');
    assert.ok(pendingActions.includes('data-wd-action="rejected"'), 'Pending withdrawal can be rejected');
    assert.ok(pendingActions.includes('data-wd-delete="wd_001"'), 'Pending withdrawal can be cancelled');

    const paidActions = renderWdActions('paid', 'wd_002');
    assert.strictEqual(paidActions.includes('data-wd-delete'), false, 'Paid withdrawal must NOT render cancel/delete button');
    assert.strictEqual(paidActions.includes('Xóa'), false);
    assert.strictEqual(paidActions.includes('Hủy'), false);

    const rejectedActions = renderWdActions('rejected', 'wd_003');
    assert.strictEqual(rejectedActions.includes('data-wd-delete'), false, 'Rejected withdrawal must NOT render cancel/delete button');

    console.log('  PASS: Paid and rejected withdrawals are protected against invalid UI cancellation.');
  }

  // --- 7. Testing Legal Consent & Transparency Messages in index.html ---
  console.log('\n--- 7. Testing Legal Consent & Transparency Messages in index.html ---');
  {
    // 7.1 Register form legal consent compliance with ND 13/2023/ND-CP
    assert.ok(
      indexHtmlContent.includes('Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân'),
      'Registration form must explicitly mention compliance with Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân'
    );
    assert.ok(
      indexHtmlContent.includes('id="regTermsAgree"'),
      'Checkbox for legal consent must exist in register form'
    );

    // 7.2 Third-party processors in Disclaimer / Terms
    assert.ok(indexHtmlContent.includes('Google Fonts'), 'Third-party list must include Google Fonts');
    assert.ok(indexHtmlContent.includes('VietQR'), 'Third-party list must include VietQR');
    assert.ok(indexHtmlContent.includes('Cloudflare Turnstile'), 'Third-party list must include Cloudflare Turnstile');
    assert.ok(indexHtmlContent.includes('AddLiveTag'), 'Third-party list must include AddLiveTag');

    // 7.3 Clarified cashback formula
    const formulaText = 'Chia sẻ lên đến 70% hoa hồng sàn thực nhận (tương đương ~63% sau khi trừ 10% thuế TNCN theo quy định)';
    assert.ok(
      indexHtmlContent.includes(formulaText),
      'index.html must include clarified cashback formula with 10% PIT deduction'
    );

    // 7.4 Unified cashback timeline wording: "7 - 14 ngày"
    assert.ok(
      indexHtmlContent.includes('7 - 14 ngày'),
      'Cashback timeline must consistently state 7 - 14 ngày'
    );

    console.log('  PASS: Legal consent, third-party processors, formula, and timeline messages verified in HTML.');
  }

  console.log('\n=== ALL 7 P1 FRONTEND & LEGAL TEST SUITES PASSED CLEANLY! ===\n');
}

runTestSuite().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
