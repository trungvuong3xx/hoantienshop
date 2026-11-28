const { BRAND_ALIAS_LIST, PHRASE_SYNONYMS, REFILL_PATTERNS } = require('./brandDictionary');

const PROMO_PHRASES = [
  'chinh hang', 'chính hãng', 'gia re', 'giá rẻ', 'gia soc', 'giá sốc',
  'deal soc', 'deal sốc', 'sieu re', 'siêu rẻ', 'freeship', 'free ship',
  'mien phi van chuyen', 'miễn phí vận chuyển', 'hoan xu', 'hoàn xu',
  'giam gia', 'giảm giá', 'flash sale', 'flashsale', 'sale soc', 'sale sốc',
  'hoa toc', 'hỏa tốc', 'giao nhanh', 'sieu toc', 'siêu tốc', 'gia si', 'giá sỉ',
  'hang san', 'hàng sẵn', 'co san', 'có sẵn', 'hang moi', 'hàng mới',
  'moi nhat', 'mới nhất', 'ban chay', 'bán chạy', 'top 1', 'chuan auth',
  'chuẩn auth', 'hang auth', 'hàng auth', 'auth 100', 'cam ket', 'cam kết',
  'bao hanh', 'bảo hành', 'tang kem', 'tặng kèm', 'qua tang', 'quà tặng',
  'fullbox', 'full box', 'nguyễn seal', 'nguyen seal', 'nguyên seal',
  'tem phu', 'tem phụ', 'nhap khau', 'nhập khẩu', 'noi dia', 'nội địa',
  'cao cap', 'cao cấp', 'gia tot', 'giá tốt', 'date moi', 'date mới',
  'sieu mem', 'siêu mềm', 'mem min', 'mềm mịn', 'chong truot', 'chống trượt',
  'chong soc', 'chống sốc', 'chinh hang vn/a', 'live', 'livestream'
];

const STOPWORDS = new Set([
  'va', 'cua', 'cho', 'voi', 'tu', 'tai', 'den', 'cac', 'mot', 'nhung', 'duoc',
  'la', 'co', 'khong', 'trong', 'ngoai', 'tren', 'duoi', 'loai', 'mau', 'size',
  'hang', 'san', 'pham', 'sp', 'shop', 'mall', 'official', 'store', 'vn', 'chinh',
  'gia', 're', 'tot', 'dep', 'moi', 'cao', 'cap', 'sieu', 'cuc', 'rat', 'nhieu',
  'the', 'for', 'with', 'and', 'new', 'hot', 'best', 'sale', 'off', 'free', 'ship',
  'da', 'nhay', 'cam', 'dau', 'kho', 'tu', 'nhien', 'ben', 'sau', 'toan', 'dien',
  'chong', 'nuoc', 'dung', 'the', 'he', 'ban', 'chuan', 'cong', 'suat', 'dai', 'sang'
]);

const GENERIC_NON_BRAND_ASCII = new Set([
  'official', 'store', 'authentic', 'original', 'premium', 'quality', 'fashion',
  'beauty', 'skincare', 'cosmetic', 'cosmetics', 'natural', 'organic', 'classic',
  'modern', 'simple', 'korean', 'japanese', 'vietnam', 'import', 'export',
  'freeship', 'flashsale', 'voucher', 'shopee', 'tiktok', 'lazada', 'edition',
  'limited', 'special', 'version', 'series', 'collection', 'design', 'style',
  'cotton', 'silicon', 'silicone', 'plastic', 'ceramic', 'stainless', 'leather',
  'waterproof', 'wireless', 'bluetooth', 'charging', 'charger', 'cable', 'adapter',
  'protect', 'protector', 'screen', 'camera', 'battery', 'speaker', 'headphone',
  'earphone', 'keyboard', 'gaming', 'office', 'laptop', 'tablet', 'mobile', 'phone',
  'sunscreen', 'cleanser', 'serum', 'lotion', 'cream', 'powder', 'lipstick', 'makeup',
  'vitamin', 'collagen', 'hyaluronic', 'retinol', 'niacinamide', 'salicylic', 'centella',
  'sensitive', 'bright', 'brightening', 'whitening', 'moisture', 'moisturizing', 'repair',
  'control', 'invisible', 'fluid', 'velvet', 'matte', 'gloss', 'tint', 'cushion',
  'perfect', 'whip', 'extra', 'super', 'ultra', 'compact', 'quick', 'digital', 'display',
  'silent', 'portable', 'quietcomfort', 'active', 'crossaction', 'vitality', 'muslin',
  'growing', 'formula', 'magsafe', 'lightning', 'sneaker', 'pijama', 'satin', 'healthy',
  'deeply', 'nourishing', 'advanced', 'nourish', 'micellar', 'cleansing', 'water',
  'facial', 'foaming', 'gentle', 'fresh', 'clean', 'smooth', 'soft', 'mini', 'fullsize',
  'refill', 'combo', 'sample', 'tester', 'travel', 'family', 'medium', 'large', 'small'
]);

function foldText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fix Vietnamese e-commerce obfuscated words like "N.ú.m" -> "Núm", "K.e.m" -> "Kem"
 * without damaging decimal numbers like "1.5L" or "15.6 inch".
 */
function normalizeObfuscatedWords(text) {
  return String(text || '').replace(
    /(?:^|(?<=[\s(\[\-/,]))([A-Za-zÀ-ỹ](?:[.\-_]\s*[A-Za-zÀ-ỹ]){1,8})(?=$|[\s)\]\-/,!?:;])/g,
    (match) => match.replace(/[.\-_\s]/g, '')
  );
}

/**
 * Normalize glued/spaced units & common compound tokens so matching is consistent:
 * e.g. "50 ml" -> "50ml", "3.6 kg" -> "3.6kg", "iPhone15" -> "iPhone 15", "3-in-1" -> "3in1"
 */
function normalizeTechnicalSpacing(text) {
  let s = String(text || '');
  // Normalize 3-in-1 / 2-in-1 -> 3in1
  s = s.replace(/\b(\d)\s*[- ]\s*in\s*[- ]\s*(\d)\b/gi, '$1in$2');
  // Normalize "50 ml" -> "50ml", "3.6 kg" -> "3.6kg", "5.2 lít" -> "5.2l", "10000 mah" -> "10000mah", "20 w" -> "20w", "15.6 inch" -> "15.6inch"
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(ml|lít|lit|l|mg|gr|gram|gam|g|kg|gb|tb|mah|w|inch|cm|mm)\b/gi, '$1$2');
  // Normalize "SPF 50+" -> "SPF50+"
  s = s.replace(/\bspf\s*(\d+\+?)\b/gi, 'spf$1');
  // Split glued brand/model number like "iPhone15" -> "iPhone 15" (only for common series words)
  s = s.replace(/\b(iphone|ipad|galaxy|redmi|pixel|airpods|watch|mi|note|gen)\s*(\d{1,2})\b/gi, '$1 $2');
  return s;
}

/**
 * Clean Shopee/TikTok product title into a clean search query while preserving
 * brand, model, product type, and key capacity/spec units.
 */
function cleanShopeeTitleForSearch(rawTitle) {
  let text = String(rawTitle || '').trim();
  if (!text) return '';

  text = normalizeObfuscatedWords(text);
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  text = text.replace(/\[([^\]]{1,40})\]/g, (_, inner) => {
    const folded = foldText(inner).trim();
    const isPromo = PROMO_PHRASES.some((p) => folded.includes(foldText(p)));
    return isPromo ? ' ' : ` ${inner} `;
  });
  text = text.replace(/\(([^)]{1,40})\)/g, (_, inner) => {
    const folded = foldText(inner).trim();
    const isPromo = PROMO_PHRASES.some((p) => folded.includes(foldText(p)));
    return isPromo ? ' ' : ` ${inner} `;
  });

  text = text.replace(/[|•·★☆🔥⚡💥✨🎁✅💯❤️🧡💛💚💙💜🖤🤍🤎👉👈👇👆➡️⬅️⬇️⬆️]/g, ' ');
  text = text.replace(/[!?;:"""''`~^=*_\\]+/g, ' ');

  const sortedPromo = [...PROMO_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of sortedPromo) {
    const rx = new RegExp(`(^|\\s)${escapeRegex(phrase)}(?=\\s|$)`, 'gi');
    text = text.replace(rx, ' ');
  }

  text = text.replace(/\s+/g, ' ').trim();

  const words = text.split(' ').filter(Boolean);
  const kept = [];
  const seen = new Set();
  for (const w of words) {
    const key = foldText(w);
    if (!key || key.length < 1) continue;
    if (seen.has(key) && !/\d/.test(w)) continue;
    seen.add(key);
    kept.push(w);
    if (kept.length >= 12) break;
  }

  return kept.join(' ').trim().slice(0, 90);
}

/**
 * Build a shorter fallback search query (3-5 key words) when full query returns 0 hits.
 */
function buildShorterFallbackQuery(cleanedQuery) {
  const words = String(cleanedQuery || '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= 4) return '';

  const priority = [];
  const secondary = [];
  for (const w of words) {
    const f = foldText(w);
    if (STOPWORDS.has(f)) continue;
    if (/\d/.test(w) || /^[A-Z][a-zA-Z0-9&-]{2,}$/.test(w)) {
      priority.push(w);
    } else {
      secondary.push(w);
    }
  }

  const combined = [...priority.slice(0, 3), ...secondary.slice(0, 3)];
  const unique = [];
  const seen = new Set();
  for (const w of combined) {
    const f = foldText(w);
    if (seen.has(f)) continue;
    seen.add(f);
    unique.push(w);
    if (unique.length >= 5) break;
  }

  const result = unique.join(' ').trim();
  if (!result || foldText(result) === foldText(cleanedQuery)) return '';
  return result;
}

/**
 * Detect canonical brands from the curated Vietnamese e-commerce brand dictionary.
 */
function extractKnownBrands(text) {
  const normalized = normalizeTechnicalSpacing(normalizeObfuscatedWords(text));
  const folded = foldText(normalized);
  const brands = new Set();

  for (const { alias, canonicalId } of BRAND_ALIAS_LIST) {
    // Word-boundary aware match (handles hyphens, apostrophes, ampersands inside alias)
    const rx = new RegExp(`(?:^|[\\s(\\[,/|])${escapeRegex(alias)}(?=$|[\\s)\\],/|.:;!?-])`, 'i');
    if (rx.test(folded)) {
      brands.add(canonicalId);
    }
  }
  return brands;
}

/**
 * Backward-compatible distinctive brand token extractor.
 * Returns canonical known brands if found, plus distinctive ASCII tokens (>= 6 chars).
 */
function extractDistinctiveBrandTokens(text) {
  const known = extractKnownBrands(text);
  const set = new Set(known);

  const rawWords = normalizeObfuscatedWords(text)
    .replace(/[\[\]()|•·,.;:!?"'\\/+]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (const w of rawWords) {
    if (!/^[A-Za-z]{6,}$/.test(w)) continue;
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower) || GENERIC_NON_BRAND_ASCII.has(lower)) continue;
    set.add(lower);
  }
  return set;
}

/**
 * Extract structured units/specs: volume, weight, storage, battery (mAh),
 * power (W), spf, dimension (inch/cm/mm), pack, count.
 */
function extractProductUnits(text) {
  const folded = foldText(normalizeObfuscatedWords(text));
  const units = [];

  // Volume: ml, l, lit
  const volRegex = /(\d+(?:[.,]\d+)?)\s*(ml|lit|l)\b/g;
  let m;
  while ((m = volRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    const unit = m[2];
    const normalizedMl = unit === 'l' || unit === 'lit' ? rawVal * 1000 : rawVal;
    units.push({ type: 'volume', value: normalizedMl, raw: m[0] });
  }

  // Weight: mg, g, gr, gram, gam, kg
  const weightRegex = /(\d+(?:[.,]\d+)?)\s*(kg|gr|gram|gam|mg|g)\b/g;
  while ((m = weightRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    const unit = m[2];
    let normalizedG = rawVal;
    if (unit === 'kg') normalizedG = rawVal * 1000;
    else if (unit === 'mg') normalizedG = rawVal / 1000;
    units.push({ type: 'weight', value: normalizedG, raw: m[0] });
  }

  // Storage: gb, tb
  const storageRegex = /(\d+(?:[.,]\d+)?)\s*(tb|gb)\b/g;
  while ((m = storageRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    const normalizedGb = m[2] === 'tb' ? rawVal * 1024 : rawVal;
    units.push({ type: 'storage', value: normalizedGb, raw: m[0] });
  }

  // Battery capacity: mAh
  const batteryRegex = /(\d+(?:[.,]\d+)?)\s*mah\b/g;
  while ((m = batteryRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    units.push({ type: 'battery', value: rawVal, raw: m[0] });
  }

  // Power wattage: W (e.g., 20W, 45W, 1000W)
  const powerRegex = /(\d+(?:[.,]\d+)?)\s*w\b/g;
  while ((m = powerRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    units.push({ type: 'power', value: rawVal, raw: m[0] });
  }

  // SPF rating: SPF50+, SPF30, SPF15
  const spfRegex = /\bspf\s*(\d+)\+?/g;
  while ((m = spfRegex.exec(folded)) !== null) {
    const rawVal = parseInt(m[1], 10);
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    units.push({ type: 'spf', value: rawVal, raw: m[0] });
  }

  // Screen / Product Dimension: inch (e.g. 15.6 inch, 14 inch)
  const inchRegex = /(\d+(?:[.,]\d+)?)\s*(?:inch|")\b/g;
  while ((m = inchRegex.exec(folded)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
    units.push({ type: 'dimension_inch', value: rawVal, raw: m[0] });
  }

  // Pack/Combo multiplier: "combo 2", "combo 3 bo", "set 10", "bo 3", "loc 6", "x2"
  const packRegex = /\b(?:combo|set|bo|loc)\s*(\d+)\b|\b(\d+)\s*(?:bo|set)\b|\bx\s*([2-9]|1[0-9]|20)\b/g;
  while ((m = packRegex.exec(folded)) !== null) {
    const rawVal = parseInt(m[1] || m[2] || m[3], 10);
    if (!Number.isFinite(rawVal) || rawVal <= 1) continue;
    units.push({ type: 'pack', value: rawVal, raw: m[0], isComboWord: /\b(?:combo|loc)\b/i.test(m[0]) });
  }

  // Countable item quantity: "68 mieng", "10 khan", "30 vien", "2 chai"
  const countRegex = /\b(\d+)\s*(vien|mieng|goi|chai|hop|cai|chiec|tui|cap|doi|tam|cuon|khan|hu|lon|ong|tuyp|to|dau)\b/g;
  while ((m = countRegex.exec(folded)) !== null) {
    const rawVal = parseInt(m[1], 10);
    if (!Number.isFinite(rawVal) || rawVal <= 1) continue;
    units.push({ type: 'count', value: rawVal, itemUnit: m[2], raw: m[0] });
  }

  // Compact diaper/item size+count like "L68", "M74", "XL54"
  const diaperCountRegex = /\b(?:nb|s|m|l|xl|xxl)(\d{2,3})\b/g;
  while ((m = diaperCountRegex.exec(folded)) !== null) {
    const rawVal = parseInt(m[1], 10);
    if (!Number.isFinite(rawVal) || rawVal < 10) continue;
    units.push({ type: 'count', value: rawVal, itemUnit: 'mieng', raw: m[0] });
  }

  return units;
}

/**
 * Extract structured model & generation identifiers to prevent matching
 * e.g. iPhone 15 vs iPhone 14, WH-1000XM5 vs WH-1000XM4, M331 vs M221, JBL Go 4 vs Go 3, AirPods Pro 2 vs AirPods 3.
 */
function extractModelIdentifiers(text) {
  const spaced = normalizeTechnicalSpacing(normalizeObfuscatedWords(text));
  const folded = foldText(spaced);
  const models = {
    alnumCodes: new Set(),   // e.g. wh1000xm5, m331, a2670, ejf357blk, lhc4267, ehnd11, a64, t7
    seriesVersions: new Map() // family -> version string, e.g. iphone -> "15", go -> "4", airpods -> "pro_2"
  };

  // 1. Series + generation patterns (high-precision family-version pairs)
  const seriesPatterns = [
    { family: 'iphone', rx: /\biphone\s*(\d{1,2}(?:\s*(?:pro\s*max|pro|plus|mini))?)\b/g },
    { family: 'ipad', rx: /\bipad\s*(?:(pro|air|mini)\s*)?(\d{1,2}|m[1-4])?\b/g },
    { family: 'airpods', rx: /\bairpods\s*((?:pro\s*(?:gen\s*)?\d|pro|max|\d))\b/g },
    { family: 'jbl_go', rx: /\bgo\s*(\d)\b/g },
    { family: 'jbl_flip', rx: /\bflip\s*(\d)\b/g },
    { family: 'jbl_charge', rx: /\bcharge\s*(\d)\b/g },
    { family: 'anker_series', rx: /\banker\s*(\d{3})\b/g },
    { family: 'uvmune', rx: /\buvmune\s*(\d{3})\b/g },
    { family: 'galaxy_s', rx: /\b(?:galaxy\s*)?s(2[0-9])\s*(ultra|plus|fe)?\b/g },
    { family: 'galaxy_a', rx: /\b(?:galaxy\s*)?a([0-9]{2})\b/g },
    { family: 'number_stage', rx: /\bso\s*([1-6])\b/g }
  ];

  for (const { family, rx } of seriesPatterns) {
    let m;
    while ((m = rx.exec(folded)) !== null) {
      const val = [m[1], m[2]]
        .filter(Boolean)
        .join(' ')
        .replace(/\bgen\s*/g, '')
        .replace(/\s+/g, '_')
        .trim();
      if (val) {
        models.seriesVersions.set(family, val);
      }
    }
  }

  // 2. Hyphenated or glued alphanumeric model codes (e.g., WH-1000XM5 -> wh1000xm5, EH-ND11 -> ehnd11, M331, A2670, EJF357BLK, A64, T7)
  // First normalize hyphenated model codes like "WH-1000XM5" or "EH-ND11" into "wh1000xm5", "ehnd11"
  const compactHyphen = folded.replace(/\b([a-z]{1,4})-([a-z0-9]{2,10})\b/g, '$1$2');
  const tokens = compactHyphen.split(/[^a-z0-9]+/).filter(Boolean);

  // Exclude unit tokens (50ml, 20w, 10000mah, spf50, 3in1, 100%, size+count like l68) and known brand tokens (3ce, skin1004)
  const unitTokenRx = /^(?:\d+(?:ml|l|g|gr|kg|mg|gb|tb|mah|w|cm|mm|inch|in\d)|spf\d+|pa|v\d|x\d|(?:nb|s|m|l|xl|xxl)\d{2,3}|3ce|skin1004|h2o|b3|b5|b12|c\d+)$/;

  for (const tok of tokens) {
    if (tok.length < 2 || tok.length > 16) continue;
    if (!(/[a-z]/.test(tok) && /\d/.test(tok))) continue;
    if (unitTokenRx.test(tok)) continue;
    // Skip pure dimension/promo codes like "100%" or "24h"
    if (/^\d+(?:h|d|k|m)$/.test(tok)) continue;
    models.alnumCodes.add(tok);
  }

  return models;
}

/**
 * Detect if product title indicates a refill, replacement head, or sample/mini.
 */
function detectRefillOrMini(text) {
  const folded = foldText(normalizeObfuscatedWords(text));
  return REFILL_PATTERNS.some((rx) => rx.test(folded));
}

/**
 * Tokenize text with synonym canonicalization for scoring.
 */
function tokenizeForScoring(text) {
  let folded = foldText(normalizeTechnicalSpacing(normalizeObfuscatedWords(text)));

  // Normalize hyphenated model codes so WH-1000XM5 matches WH1000XM5
  folded = folded.replace(/\b([a-z]{1,4})-([a-z0-9]{2,10})\b/g, '$1$2');

  // Apply phrase synonyms
  for (const [phrase, canonical] of PHRASE_SYNONYMS) {
    if (folded.includes(phrase)) {
      const rx = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(phrase)}(?=$|[^a-z0-9])`, 'g');
      folded = folded.replace(rx, ` ${canonical} `);
    }
  }

  return folded
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Extract full structured signature for a product title.
 */
function extractProductSignature(rawTitle) {
  const cleaned = cleanShopeeTitleForSearch(rawTitle);
  const knownBrands = extractKnownBrands(rawTitle);
  const fallbackBrands = knownBrands.size === 0 ? extractDistinctiveBrandTokens(rawTitle) : new Set();
  const units = extractProductUnits(rawTitle);
  const models = extractModelIdentifiers(rawTitle);
  const isRefillOrMini = detectRefillOrMini(rawTitle);
  // Score against the full rawTitle (cleaned is capped at 12 words for search APIs only)
  const tokens = tokenizeForScoring(rawTitle);

  return {
    raw: String(rawTitle || ''),
    cleaned,
    knownBrands,
    fallbackBrands,
    units,
    models,
    isRefillOrMini,
    tokens
  };
}

/**
 * Build smart primary + fallback search queries prioritizing Brand + Model + Core Noun + Unit.
 */
function buildSmartSearchQuery(rawTitle) {
  const primaryQuery = cleanShopeeTitleForSearch(rawTitle);
  const fallbackQuery = buildShorterFallbackQuery(primaryQuery);
  return {
    primaryQuery,
    fallbackQuery
  };
}

module.exports = {
  PROMO_PHRASES,
  STOPWORDS,
  foldText,
  normalizeObfuscatedWords,
  normalizeTechnicalSpacing,
  cleanShopeeTitleForSearch,
  buildShorterFallbackQuery,
  buildSmartSearchQuery,
  extractKnownBrands,
  extractDistinctiveBrandTokens,
  extractProductUnits,
  extractModelIdentifiers,
  detectRefillOrMini,
  tokenizeForScoring,
  extractProductSignature
};
