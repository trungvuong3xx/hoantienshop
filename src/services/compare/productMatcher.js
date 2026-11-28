const {
  extractProductSignature,
  extractProductUnits,
  foldText
} = require('./productNormalizer');

// 4-tier confidence thresholds (calibrated against golden_dataset.json)
const TIER_THRESHOLDS = {
  EXACT: 0.75,
  HIGH: 0.60,
  SIMILAR: 0.48
};

const MIN_MATCH_SCORE = TIER_THRESHOLDS.SIMILAR;

/**
 * Lightweight Levenshtein distance for fuzzy token matching (only used for tokens >= 5 chars).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return 3;
  const prev = new Array(lb + 1);
  const curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }
  return prev[lb];
}

/**
 * Compare extracted units/specs between source and target.
 * Fixes pack vs count equivalence (e.g. "Set 10 Khăn" <-> "10 Khăn")
 * while strictly rejecting conflicting volumes, weights, storage, battery, power, SPF, dimension, or combo counts.
 */
function compareUnits(sourceUnits, targetUnits) {
  if (!sourceUnits.length && !targetUnits.length) {
    return { matched: false, mismatch: false };
  }

  // 1. Strict physical/technical unit checks
  const strictTypes = ['volume', 'weight', 'storage', 'battery', 'power', 'spf', 'dimension_inch'];
  let matched = false;

  for (const type of strictTypes) {
    const src = sourceUnits.filter((u) => u.type === type);
    const tgt = targetUnits.filter((u) => u.type === type);
    if (!src.length || !tgt.length) continue;

    // Tolerance: 15% for volume/weight, 5% for storage/battery/power/dimension, 0% for SPF
    const tolerance = type === 'spf' ? 0.01 : (type === 'volume' || type === 'weight') ? 0.15 : 0.05;
    const anyClose = src.some((s) =>
      tgt.some((t) => Math.abs(s.value - t.value) / Math.max(s.value, t.value) <= tolerance)
    );
    if (anyClose) {
      matched = true;
    } else {
      return { matched: false, mismatch: true, mismatchType: type };
    }
  }

  // 2. Pack / Combo / Count reconciliation
  const srcPacks = sourceUnits.filter((u) => u.type === 'pack');
  const tgtPacks = targetUnits.filter((u) => u.type === 'pack');
  const srcCounts = sourceUnits.filter((u) => u.type === 'count');
  const tgtCounts = targetUnits.filter((u) => u.type === 'count');

  // Helper: check if a pack value matches a count value (e.g. "Set 10 Khăn" <-> "10 Khăn")
  const hasMatchingCount = (packs, counts) =>
    packs.some((p) => !p.isComboWord && counts.some((c) => c.value === p.value));

  if (srcPacks.length || tgtPacks.length) {
    if (srcPacks.length && tgtPacks.length) {
      const samePack = srcPacks.some((s) => tgtPacks.some((t) => s.value === t.value));
      if (!samePack) {
        return { matched: false, mismatch: true, mismatchType: 'pack' };
      }
      matched = true;
    } else if (srcPacks.length && !tgtPacks.length) {
      // Source has "Set 10 Khăn" (pack:10) and target has "10 Khăn" (count:10) -> valid match!
      if (hasMatchingCount(srcPacks, tgtCounts)) {
        matched = true;
      } else {
        return { matched: false, mismatch: true, mismatchType: 'pack' };
      }
    } else if (!srcPacks.length && tgtPacks.length) {
      if (hasMatchingCount(tgtPacks, srcCounts)) {
        matched = true;
      } else {
        return { matched: false, mismatch: true, mismatchType: 'pack' };
      }
    }
  }

  // 3. Direct count comparison when both specify counts (e.g. 68 miếng vs 44 miếng)
  if (srcCounts.length && tgtCounts.length) {
    const sameCount = srcCounts.some((s) =>
      tgtCounts.some((t) => Math.abs(s.value - t.value) / Math.max(s.value, t.value) <= 0.1)
    );
    if (sameCount) {
      matched = true;
    } else {
      return { matched: false, mismatch: true, mismatchType: 'count' };
    }
  }

  return { matched, mismatch: false };
}

/**
 * Check for hard brand conflict between source and target signatures.
 */
function checkBrandCompatibility(srcSig, tgtSig) {
  const srcKnown = srcSig.knownBrands;
  const tgtKnown = tgtSig.knownBrands;

  if (srcKnown.size > 0 && tgtKnown.size > 0) {
    const overlap = [...srcKnown].some((b) => tgtKnown.has(b));
    return {
      compatible: overlap,
      matched: overlap,
      reason: overlap ? null : 'brand_mismatch'
    };
  }

  // If one side has a known brand and the other has NO known brand at all,
  // reject if the other side has a different distinctive brand or lacks the brand completely
  if (srcKnown.size > 0 && tgtKnown.size === 0) {
    return { compatible: false, matched: false, reason: 'brand_mismatch' };
  }

  // Fallback: neither side matched dictionary — check distinctive ASCII tokens >= 6 chars
  if (srcSig.fallbackBrands.size > 0) {
    const tgtFolded = foldText(tgtSig.raw);
    const hasMatch = [...srcSig.fallbackBrands].some((b) => tgtFolded.includes(b));
    if (!hasMatch) {
      return { compatible: false, matched: false, reason: 'brand_mismatch' };
    }
    return { compatible: true, matched: true, reason: null };
  }

  return { compatible: true, matched: false, reason: null };
}

/**
 * Check for hard model/generation conflicts (e.g. iPhone 15 vs 14, XM5 vs XM4, M331 vs M221, Go 4 vs Go 3).
 */
function checkModelCompatibility(srcModels, tgtModels) {
  let matched = false;

  // 1. Same product family with different version/generation -> hard reject
  for (const [family, srcVer] of srcModels.seriesVersions.entries()) {
    if (tgtModels.seriesVersions.has(family)) {
      const tgtVer = tgtModels.seriesVersions.get(family);
      if (srcVer !== tgtVer) {
        return { compatible: false, matched: false, reason: 'model_mismatch' };
      }
      matched = true;
    }
  }

  // 2. Both have specific alphanumeric model codes (e.g. M331 vs M221, WH1000XM5 vs WH1000XM4, A2670 vs A2643)
  if (srcModels.alnumCodes.size > 0 && tgtModels.alnumCodes.size > 0) {
    const overlap = [...srcModels.alnumCodes].some((code) => tgtModels.alnumCodes.has(code));
    if (overlap) {
      matched = true;
    } else {
      // Check if they look like competing model numbers (same prefix letter or both >= 4 chars alnum)
      const srcArr = [...srcModels.alnumCodes];
      const tgtArr = [...tgtModels.alnumCodes];
      const competing = srcArr.some((s) =>
        tgtArr.some((t) => {
          const sPrefix = s.replace(/\d.*/, '');
          const tPrefix = t.replace(/\d.*/, '');
          return (sPrefix && sPrefix === tPrefix) || (s.length >= 4 && t.length >= 4);
        })
      );
      if (competing) {
        return { compatible: false, matched: false, reason: 'model_mismatch' };
      }
    }
  }

  return { compatible: true, matched, reason: null };
}

/**
 * Unified product matching evaluator (used for BOTH Shopee->TikTok and TikTok->Shopee).
 * Accepts normalized candidate shape: { id, title, price, priceMin, priceMax, hasInventory, sales }
 */
function evaluateProductMatch(sourceTitle, sourcePrice, targetCandidate) {
  if (!targetCandidate || !targetCandidate.id || !targetCandidate.title) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'invalid_product_fields' };
  }

  if (targetCandidate.hasInventory === false) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'out_of_stock' };
  }

  const targetPrice = Number(targetCandidate.price || 0);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'invalid_price' };
  }

  // Gate 1: Price outlier guard (0.25x - 3.5x)
  const srcPrice = Number(sourcePrice || 0);
  if (srcPrice > 0) {
    const ratio = targetPrice / srcPrice;
    if (ratio < 0.25 || ratio > 3.5) {
      return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'price_outlier' };
    }
  }

  const srcSig = extractProductSignature(sourceTitle);
  const tgtSig = extractProductSignature(targetCandidate.title);

  if (!srcSig.tokens.length || !tgtSig.tokens.length) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'empty_tokens' };
  }

  // Gate 2: Refill / Replacement head / Mini vs Fullsize guard
  if (srcSig.isRefillOrMini !== tgtSig.isRefillOrMini) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'refill_mismatch' };
  }

  // Gate 3: Brand compatibility guard (supports short & multi-word brands)
  const brandCheck = checkBrandCompatibility(srcSig, tgtSig);
  if (!brandCheck.compatible) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: brandCheck.reason };
  }

  // Gate 4: Unit & Spec compatibility guard
  const unitCheck = compareUnits(srcSig.units, tgtSig.units);
  if (unitCheck.mismatch) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'unit_mismatch' };
  }

  // Gate 5: Model / Generation compatibility guard
  const modelCheck = checkModelCompatibility(srcSig.models, tgtSig.models);
  if (!modelCheck.compatible) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: modelCheck.reason };
  }

  // Weighted Token Similarity with Fuzzy fallback for tokens >= 5 chars
  const srcSet = new Set(srcSig.tokens);
  const tgtSet = new Set(tgtSig.tokens);
  const tgtList = [...tgtSet];

  const tokenWeight = (tok) => {
    if (tok.startsWith('syn_')) return 1.8;
    if (/\d/.test(tok)) return 2.2;
    if (tok.length >= 6) return 1.5;
    return 1.0;
  };

  let srcTotalW = 0;
  let matchedSrcW = 0;
  let exactMatchedCount = 0;

  for (const tok of srcSet) {
    const w = tokenWeight(tok);
    srcTotalW += w;

    if (tgtSet.has(tok)) {
      matchedSrcW += w;
      exactMatchedCount++;
    } else if (tok.length >= 5 && !/\d/.test(tok) && !tok.startsWith('syn_')) {
      // Lightweight fuzzy match (edit distance <= 1 for length >= 5, <= 2 for length >= 8)
      const maxDist = tok.length >= 8 ? 2 : 1;
      const fuzzyHit = tgtList.some((t) => t.length >= 5 && !/\d/.test(t) && levenshtein(tok, t) <= maxDist);
      if (fuzzyHit) {
        matchedSrcW += w * 0.85;
        exactMatchedCount++;
      }
    }
  }

  let tgtTotalW = 0;
  let matchedTgtW = 0;
  const srcList = [...srcSet];
  for (const tok of tgtSet) {
    const w = tokenWeight(tok);
    tgtTotalW += w;
    if (srcSet.has(tok)) {
      matchedTgtW += w;
    } else if (tok.length >= 5 && !/\d/.test(tok) && !tok.startsWith('syn_')) {
      const maxDist = tok.length >= 8 ? 2 : 1;
      if (srcList.some((s) => s.length >= 5 && !/\d/.test(s) && levenshtein(tok, s) <= maxDist)) {
        matchedTgtW += w * 0.85;
      }
    }
  }

  if (exactMatchedCount === 0) {
    return { eligible: false, score: 0, matchTier: 'reject', matchQuality: 'similar', reason: 'no_token_overlap' };
  }

  const recall = srcTotalW > 0 ? matchedSrcW / srcTotalW : 0;
  const precision = tgtTotalW > 0 ? matchedTgtW / tgtTotalW : 0;

  // Composite score
  let score = recall * 0.65 + precision * 0.35;

  // Structured attribute boosts
  if (brandCheck.matched) score += 0.08;
  if (modelCheck.matched) score += 0.14;
  if (unitCheck.matched) score += 0.10;

  // Penalty if same brand + same unit, yet core non-brand tokens overlap very poorly
  // (prevents matching La Roche Posay Cicaplast B5 50ml with La Roche Posay Anthelios UVMune 400 50ml)
  if (brandCheck.matched && recall < 0.42 && !modelCheck.matched) {
    score -= 0.22;
  }

  // Slight tie-breaker boost for verified sales volume
  const sales = Number(targetCandidate.sales || 0);
  if (sales > 50) score += 0.02;

  score = Math.max(0, Math.min(1, Number(score.toFixed(4))));

  if (score < MIN_MATCH_SCORE) {
    return { eligible: false, score, matchTier: 'reject', matchQuality: 'similar', reason: 'low_similarity' };
  }

  const matchTier =
    score >= TIER_THRESHOLDS.EXACT
      ? 'exact'
      : score >= TIER_THRESHOLDS.HIGH
        ? 'high'
        : 'similar';

  // Backward-compatible 2-level quality ('exact' | 'similar') + 4-tier matchTier
  const matchQuality = matchTier === 'exact' || matchTier === 'high' ? 'exact' : 'similar';

  return {
    eligible: true,
    score,
    matchTier,
    matchQuality,
    unitMatched: unitCheck.matched,
    brandMatched: brandCheck.matched,
    modelMatched: modelCheck.matched
  };
}

module.exports = {
  TIER_THRESHOLDS,
  MIN_MATCH_SCORE,
  compareUnits,
  evaluateProductMatch,
  extractProductUnits
};
