/**
 * Test Suite: Zalo Community Safety & Anti-Fraud Guidelines in FAQ (Task 14)
 * Verifies:
 * 1. public/index.html contains dedicated FAQ item for Zalo Community safety.
 * 2. FAQ item is located within the Guide & FAQ section (#view-guide).
 * 3. Required warnings are explicitly present:
 *    - Group is a public community space.
 *    - Admins NEVER ask for passwords, OTPs, or bank deposit transfers via PM.
 *    - Withdrawals only occur on the official Hoàn Tiền Sàn website.
 *    - Guidance on reporting impostors and fraudulent contacts to CSKH hotline.
 * 4. HTML markup validity, balanced tags, and semantic structure.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runZaloSafetyFaqTests() {
  console.log('=== STARTING ZALO COMMUNITY SAFETY FAQ TEST SUITE ===');

  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
  assert.ok(fs.existsSync(indexHtmlPath), 'public/index.html must exist');

  const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

  // --- 1. Verify FAQ item presence in #view-guide ---
  console.log('\n--- 1. Testing Placement within Guide Section (#view-guide) ---');
  const viewGuideMatch = htmlContent.match(/<section id="view-guide"[\s\S]*?<\/section>/);
  assert.ok(viewGuideMatch, 'public/index.html must have a section with id="view-guide"');
  const viewGuideHtml = viewGuideMatch[0];

  assert.ok(
    viewGuideHtml.includes('faq-list'),
    '#view-guide must contain a .faq-list container'
  );

  assert.ok(
    viewGuideHtml.includes('Quy định an toàn khi tham gia Cộng đồng Zalo'),
    '#view-guide must contain the Zalo safety guidelines question'
  );
  console.log('  PASS: Zalo safety guidelines placed correctly inside #view-guide FAQ section.');

  // --- 2. Verify Semantic Markup & Structure ---
  console.log('\n--- 2. Testing Semantic Markup & HTML Tags ---');
  // Match the specific FAQ item block
  const faqItemMatch = viewGuideHtml.match(
    /<div class="faq-item"[^>]*>[\s\S]*?Quy định an toàn khi tham gia Cộng đồng Zalo[\s\S]*?<\/div>\s*<\/div>/
  ) || viewGuideHtml.match(
    /<div class="faq-item"[^>]*id="faq-zalo-safety"[^>]*>[\s\S]*?<\/ul>\s*<\/div>\s*<\/div>/
  ) || viewGuideHtml.match(
    /<div class="faq-item"[^>]*>[\s\S]*?(?:🛡️|<svg[\s\S]*?<\/svg>)[\s\S]*?<\/ul>\s*<\/div>\s*<\/div>/
  );

  assert.ok(faqItemMatch, 'Must find valid FAQ item markup containing Zalo community rules');
  const faqItemHtml = faqItemMatch[0];

  // Heading check
  assert.ok(
    /<h4[^>]*class="faq-question[^"]*"[^>]*>[\s\S]*?(?:🛡️|<svg[\s\S]*?<\/svg>)[\s\S]*?Quy định an toàn khi tham gia Cộng đồng Zalo[\s\S]*?<\/h4>/.test(faqItemHtml) ||
    /<h4[^>]*>[\s\S]*?(?:🛡️|<svg[\s\S]*?<\/svg>)[\s\S]*?Quy định an toàn khi tham gia Cộng đồng Zalo[\s\S]*?<\/h4>/.test(faqItemHtml),
    'FAQ item must have an <h4> heading with shield icon and safety title'
  );

  // Content wrapper check
  assert.ok(
    faqItemHtml.includes('class="faq-answer"') || faqItemHtml.includes('<div class="faq-answer">'),
    'FAQ item should have a .faq-answer wrapper'
  );

  // List structure check
  assert.ok(faqItemHtml.includes('<ul>'), 'FAQ item must contain an unordered list <ul>');
  assert.ok(faqItemHtml.includes('</ul>'), 'FAQ item list <ul> must be closed');
  const liMatches = faqItemHtml.match(/<li[\s\S]*?<\/li>/g);
  assert.ok(liMatches && liMatches.length >= 3, `Expected at least 3 <li> items, got ${liMatches ? liMatches.length : 0}`);
  console.log('  PASS: Semantic markup (h4, faq-answer, ul, li) verified.');

  // --- 3. Verify Specific Anti-Fraud Warning Content ---
  console.log('\n--- 3. Testing Required Content & Anti-Fraud Warnings ---');

  // Requirement 3a: Group is a public community space
  assert.ok(
    faqItemHtml.includes('không gian giao lưu') && faqItemHtml.includes('chia sẻ kinh nghiệm'),
    'Must explain that Zalo group is a public community space for shopping and cashback sharing'
  );
  console.log('  PASS: Public community space context verified.');

  // Requirement 3b: Admins NEVER ask for passwords, OTPs, or deposit transfers
  assert.ok(
    /KHÔNG BAO GIỜ[\s\S]*?(Mật khẩu|mật khẩu)[\s\S]*?(OTP|mã OTP)[\s\S]*?(chuyển tiền|tiền cọc)/i.test(faqItemHtml),
    'Must explicitly warn that Admins NEVER ask for passwords, OTPs, or transfer deposits'
  );
  // Must be wrapped in strong tags for emphasis
  assert.ok(
    /<strong>[^<]*KHÔNG BAO GIỜ[^<]*<\/strong>/.test(faqItemHtml),
    'Critical admin fraud warning must be strongly emphasized using <strong> tags'
  );
  console.log('  PASS: Admin impersonation & credential theft warning verified.');

  // Requirement 3c: Withdrawals exclusively on website
  assert.ok(
    faqItemHtml.includes('rút tiền chỉ diễn ra duy nhất trên website chính thức'),
    'Must specify that withdrawals occur ONLY on the official Hoàn Tiền Sàn website'
  );
  console.log('  PASS: Exclusive website withdrawal channel verified.');

  // Requirement 3d: Impostor reporting guidance
  assert.ok(
    /mạo danh[\s\S]*?(báo cáo|hotline CSKH)/i.test(faqItemHtml),
    'Must provide guidance on reporting impostors or suspicious contacts to CSKH hotline'
  );
  console.log('  PASS: Impostor reporting mechanism verified.');

  // --- 4. Tag Balance & Validity ---
  console.log('\n--- 4. Testing HTML Tag Balance & Validity ---');
  const countTag = (str, tag) => (str.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
  const countCloseTag = (str, tag) => (str.match(new RegExp(`</${tag}>`, 'g')) || []).length;

  const tagsToCheck = ['div', 'h4', 'p', 'ul', 'li', 'strong'];
  for (const tag of tagsToCheck) {
    const opens = countTag(faqItemHtml, tag);
    const closes = countCloseTag(faqItemHtml, tag);
    assert.strictEqual(
      opens,
      closes,
      `Tag <${tag}> has ${opens} openings but ${closes} closings in the FAQ item snippet`
    );
  }
  console.log('  PASS: All HTML tags within the FAQ item are properly balanced.');

  console.log('\n=== ALL ZALO COMMUNITY SAFETY FAQ TESTS PASSED CLEANLY! ===\n');
}

if (require.main === module) {
  runZaloSafetyFaqTests().catch((err) => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  });
}

module.exports = { runZaloSafetyFaqTests };
