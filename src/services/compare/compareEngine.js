const logger = require('../../utils/logger');
const { calculateCommissionSplit } = require('../dbService');
const { buildSmartSearchQuery } = require('./productNormalizer');
const { evaluateProductMatch } = require('./productMatcher');
const { computeTrustSignals } = require('./trustSignals');
const {
  getCachedRawCandidates,
  setCachedRawCandidates,
  runSingleFlight,
  signVerifiedProductToken,
  registerVerifiedTikTokProduct,
  registerVerifiedShopeeProduct
} = require('./compareCache');

const MAX_RETURNED_ITEMS = 3;
const TOTAL_TIME_BUDGET_MS = 8000;
const MIN_FALLBACK_BUDGET_MS = 2500;
const SIMILAR_PRICE_DIFF_THRESHOLD = 3000;

const TRANSPARENCY_DISCLAIMER =
  'Giá bán và mức hoàn tiền là ước tính tối đa theo dữ liệu sàn tại thời điểm tra cứu, chưa bao gồm phí vận chuyển hoặc voucher sàn.';

function formatVndSimple(amount) {
  return `${Math.round(Math.abs(Number(amount) || 0)).toLocaleString('vi-VN')}đ`;
}

/**
 * Build a comparable item with dynamic cashback calculation & cross-platform price comparison.
 */
function buildUnifiedComparableItem(candidate, options = {}) {
  const {
    targetPlatform,
    sourceEffectivePrice = 0,
    cashbackPercent = 70,
    taxDeductPercent = 10,
    matchScore = 0,
    matchTier = 'similar',
    matchQuality = 'similar',
    unitMatched = false,
    fetchedAt = new Date().toISOString()
  } = options;

  const price = Number(candidate.price || 0);
  const priceMin = Number(candidate.priceMin || price);
  const priceMax = Number(candidate.priceMax || price);
  const hasPriceRange = Boolean(candidate.hasPriceRange || (price > 0 && priceMax > price * 1.25));
  const originalPrice = Number(candidate.originalPrice || priceMax || price);
  const grossCommission = Number(candidate.grossCommission || 0);
  const commissionRate = Number(candidate.commissionRate || 0);

  let estimatedCashback = 0;
  let netCommissionAfterTax = 0;
  if (grossCommission > 0) {
    const split = calculateCommissionSplit(grossCommission, cashbackPercent, taxDeductPercent);
    estimatedCashback = Math.max(0, Math.round(split.userCashbackAmount || 0));
    netCommissionAfterTax = Math.max(0, Math.round(split.netCommission || 0));
  }

  const effectivePrice = price > 0 ? Math.max(0, price - estimatedCashback) : 0;

  // Comparison status against source platform
  let comparisonStatus = 'similar';
  let comparisonLabel = 'Mức giá tương đương';
  let savingsAmount = 0;

  const isTargetTikTok = targetPlatform === 'tiktok';
  const targetCheaperStatus = isTargetTikTok ? 'tiktok_cheaper' : 'target_cheaper';
  const sourceCheaperStatus = isTargetTikTok ? 'shopee_cheaper' : 'source_cheaper';
  const targetLabel = isTargetTikTok ? 'TikTok Shop' : 'Shopee';
  const sourceLabel = isTargetTikTok ? 'Shopee' : 'TikTok Shop';

  if (sourceEffectivePrice > 0 && effectivePrice > 0) {
    savingsAmount = Math.round(sourceEffectivePrice - effectivePrice);
    if (savingsAmount > SIMILAR_PRICE_DIFF_THRESHOLD) {
      comparisonStatus = targetCheaperStatus;
      comparisonLabel = `${targetLabel} rẻ hơn ~${formatVndSimple(savingsAmount)}`;
    } else if (savingsAmount < -SIMILAR_PRICE_DIFF_THRESHOLD) {
      comparisonStatus = sourceCheaperStatus;
      comparisonLabel = `${sourceLabel} đang rẻ hơn ~${formatVndSimple(savingsAmount)}`;
    } else {
      comparisonStatus = 'similar';
      comparisonLabel = 'Mức giá tương đương';
    }
  } else if (estimatedCashback > 0) {
    comparisonLabel = `Hoàn tối đa ~${formatVndSimple(estimatedCashback)}`;
  }

  const verifyToken = signVerifiedProductToken({
    platform: targetPlatform,
    productId: candidate.id,
    shopId: candidate.shopId || '',
    detailLink: candidate.detailLink || ''
  });

  const trust = computeTrustSignals(
    {
      rating: candidate.rating,
      sales: candidate.sales,
      sold7d: candidate.sold7d,
      growth: candidate.growth,
      price,
      estimatedCashback
    },
    {
      platform: targetPlatform,
      sourcePrice: options.sourcePrice || 0
    }
  );

  const item = {
    productId: candidate.id,
    title: candidate.title,
    shopName: candidate.shopName || targetLabel,
    imageUrl: candidate.imageUrl || '',
    price,
    priceMin,
    priceMax,
    hasPriceRange,
    originalPrice,
    commissionRate,
    grossCommission,
    netCommissionAfterTax,
    estimatedCashback,
    effectivePrice,
    matchScore: Number(matchScore.toFixed(3)),
    matchTier,
    matchQuality,
    unitMatched: Boolean(unitMatched),
    sales: trust.sales,
    rating: trust.rating,
    sold7d: trust.sold7d,
    highlightBadge: trust.highlightBadge,
    trustWarning: trust.trustWarning,
    comparisonStatus,
    comparisonLabel,
    verifyToken,
    fetchedAt,
    detailLink: candidate.detailLink || ''
  };

  if (isTargetTikTok) {
    item.unitsSold = item.sales;
    item.savingsVsShopee = savingsAmount;
  } else {
    item.itemId = candidate.id;
    item.shopId = candidate.shopId || '';
    item.savingsVsTikTok = savingsAmount;
    item.productLink = candidate.detailLink || '';
  }

  return item;
}

function tierRank(tier) {
  if (tier === 'exact') return 3;
  if (tier === 'high') return 2;
  if (tier === 'similar') return 1;
  return 0;
}

/**
 * Unified Cross-Platform Price Comparison Engine.
 * Decouples Raw Candidate Cache from dynamic cashback/scoring, uses Single-Flight,
 * enforces an 8s total latency budget, and emits structured telemetry.
 */
async function runCrossPlatformCompare({
  targetPlatform,
  sourceTitle,
  sourcePrice = 0,
  sourceEstimatedCashback = 0,
  cashbackPercent = 70,
  taxDeductPercent = 10,
  fetchCandidatesFn,
  useCache = true
}) {
  const startedAt = Date.now();
  const direction = targetPlatform === 'tiktok' ? 'shopee_to_tiktok' : 'tiktok_to_shopee';
  const targetName = targetPlatform === 'tiktok' ? 'TikTok Shop' : 'Shopee';

  const { primaryQuery, fallbackQuery } = buildSmartSearchQuery(sourceTitle);
  if (!primaryQuery || primaryQuery.length < 3) {
    return {
      ok: true,
      found: false,
      cached: false,
      cacheLayer: 'bypass',
      query: primaryQuery || '',
      fetchedAt: new Date().toISOString(),
      disclaimer: TRANSPARENCY_DISCLAIMER,
      bestComparison: null,
      items: [],
      message: `Không đủ thông tin tên sản phẩm để tìm kiếm trên ${targetName}.`
    };
  }

  const safeSourcePrice = Math.max(0, Math.round(Number(sourcePrice) || 0));
  const safeSourceCb = Math.max(0, Math.round(Number(sourceEstimatedCashback) || 0));
  const sourceEffectivePrice = safeSourcePrice > 0 ? Math.max(0, safeSourcePrice - safeSourceCb) : 0;

  let rawCandidates = [];
  let fetchedAt = new Date().toISOString();
  let cacheLayer = 'miss';
  let fallbackUsed = false;
  let queryUsed = primaryQuery;
  let provider = '';
  let upstreamMs = 0;

  // 1. Check Decoupled Raw Candidate Cache (shared across all VIP tiers & source prices!)
  const cachedHit = useCache ? await getCachedRawCandidates(targetPlatform, primaryQuery) : null;
  if (cachedHit) {
    rawCandidates = cachedHit.data.candidates || [];
    fetchedAt = cachedHit.data.fetchedAt || fetchedAt;
    queryUsed = cachedHit.data.queryUsed || primaryQuery;
    fallbackUsed = Boolean(cachedHit.data.fallbackUsed);
    provider = cachedHit.data.provider || '';
    cacheLayer = cachedHit.cacheLayer;
  } else {
    // 2. Single-Flight upstream fetch with total 8s time budget
    const fetchTask = async () => {
      const upStart = Date.now();
      const firstBudget = Math.min(5000, TOTAL_TIME_BUDGET_MS);
      const firstRes = await fetchCandidatesFn(primaryQuery, { timeoutMs: firstBudget });
      let list = Array.isArray(firstRes?.candidates) ? firstRes.candidates : [];
      let usedQ = primaryQuery;
      let usedFb = false;
      let prov = firstRes?.provider || '';

      // Check if we have any eligible match before deciding on fallback
      const hasAnyEligible = list.some((c) => evaluateProductMatch(sourceTitle, safeSourcePrice, c).eligible);
      const remainingMs = TOTAL_TIME_BUDGET_MS - (Date.now() - upStart);

      if ((list.length === 0 || !hasAnyEligible) && fallbackQuery && remainingMs >= MIN_FALLBACK_BUDGET_MS) {
        try {
          const fbRes = await fetchCandidatesFn(fallbackQuery, { timeoutMs: remainingMs });
          const fbList = Array.isArray(fbRes?.candidates) ? fbRes.candidates : [];
          if (fbList.length > 0) {
            // Merge unique candidates by id
            const seen = new Set(list.map((x) => x.id));
            for (const c of fbList) {
              if (!seen.has(c.id)) {
                seen.add(c.id);
                list.push(c);
              }
            }
            usedQ = fallbackQuery;
            usedFb = true;
            prov = fbRes?.provider || prov;
          }
        } catch (fbErr) {
          logger.warning('runCrossPlatformCompare', 'Fallback query failed, continuing with primary results', {
            direction,
            error: fbErr?.message
          });
        }
      }

      const payload = {
        candidates: list,
        fetchedAt: new Date().toISOString(),
        queryUsed: usedQ,
        fallbackUsed: usedFb,
        provider: prov,
        upstreamMs: Date.now() - upStart
      };

      if (useCache) {
        await setCachedRawCandidates(targetPlatform, primaryQuery, payload);
      }
      return payload;
    };

    const fetched = useCache
      ? await runSingleFlight(targetPlatform, primaryQuery, fetchTask)
      : await fetchTask();

    rawCandidates = fetched.candidates || [];
    fetchedAt = fetched.fetchedAt || fetchedAt;
    queryUsed = fetched.queryUsed || primaryQuery;
    fallbackUsed = Boolean(fetched.fallbackUsed);
    provider = fetched.provider || '';
    upstreamMs = fetched.upstreamMs || 0;
  }

  // 3. Dynamic Scoring, Cashback Calculation & Ranking (always fresh for current user's VIP rate!)
  const seenIds = new Set();
  const scoredItems = [];

  for (const cand of rawCandidates) {
    if (!cand || !cand.id || seenIds.has(cand.id)) continue;
    seenIds.add(cand.id);

    const match = evaluateProductMatch(sourceTitle, safeSourcePrice, cand);
    if (!match.eligible) continue;

    const item = buildUnifiedComparableItem(cand, {
      targetPlatform,
      sourcePrice: safeSourcePrice,
      sourceEffectivePrice,
      cashbackPercent,
      taxDeductPercent,
      matchScore: match.score,
      matchTier: match.matchTier,
      matchQuality: match.matchQuality,
      unitMatched: match.unitMatched,
      fetchedAt
    });

    if (item.price > 0) {
      scoredItems.push(item);
    }
  }

  // Sort: higher matchTier -> lower effectivePrice -> higher matchScore -> higher sales
  scoredItems.sort((a, b) => {
    const tDiff = tierRank(b.matchTier) - tierRank(a.matchTier);
    if (tDiff !== 0) return tDiff;
    if (a.effectivePrice !== b.effectivePrice) return a.effectivePrice - b.effectivePrice;
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return (b.sales || 0) - (a.sales || 0);
  });

  const topItems = scoredItems.slice(0, MAX_RETURNED_ITEMS);

  // Register in L1 verified maps (backward compat) & strip internal fields from public payload
  const publicItems = topItems.map((item) => {
    if (targetPlatform === 'tiktok') {
      registerVerifiedTikTokProduct(item);
    } else {
      registerVerifiedShopeeProduct(item);
    }
    const pub = { ...item };
    delete pub.detailLink;
    delete pub.productLink;
    delete pub.grossCommission;
    delete pub.netCommissionAfterTax;
    delete pub.commissionRate;
    return pub;
  });

  const best = publicItems[0] || null;
  const bestComparison = best
    ? {
        status: best.comparisonStatus,
        label: best.comparisonLabel,
        matchTier: best.matchTier,
        ...(targetPlatform === 'tiktok'
          ? {
              savingsVsShopee: best.savingsVsShopee,
              shopeeEffectivePrice: sourceEffectivePrice,
              bestTikTokEffectivePrice: best.effectivePrice
            }
          : {
              savingsVsTikTok: best.savingsVsTikTok,
              tiktokEffectivePrice: sourceEffectivePrice,
              bestShopeeEffectivePrice: best.effectivePrice
            })
      }
    : null;

  const durationMs = Date.now() - startedAt;

  // 4. Structured Telemetry Log
  logger.log('compare_telemetry', 'Cross-platform comparison completed', {
    direction,
    durationMs,
    upstreamMs,
    cacheLayer,
    provider,
    candidateCount: rawCandidates.length,
    returnedCount: publicItems.length,
    topScore: best ? best.matchScore : 0,
    topTier: best ? best.matchTier : 'none',
    fallbackUsed
  });

  return {
    ok: true,
    found: publicItems.length > 0,
    cached: cacheLayer !== 'miss',
    cacheLayer,
    query: queryUsed,
    fetchedAt,
    disclaimer: TRANSPARENCY_DISCLAIMER,
    bestComparison,
    items: publicItems,
    message:
      publicItems.length > 0
        ? ''
        : `Chưa tìm thấy sản phẩm tương đương chính xác trên ${targetName}.`
  };
}

module.exports = {
  MAX_RETURNED_ITEMS,
  TOTAL_TIME_BUDGET_MS,
  TRANSPARENCY_DISCLAIMER,
  buildUnifiedComparableItem,
  runCrossPlatformCompare
};
