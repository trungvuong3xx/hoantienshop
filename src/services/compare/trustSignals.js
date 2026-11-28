/**
 * Product Trust Signals & Highlight Badge Evaluator (P0/P1).
 * Combines real API popularity/quality metrics with cashback value into
 * 1 clear highlight badge and smart, non-alarmist risk warnings.
 *
 * Security & Privacy rule:
 * - Never expose raw percentage rates, growth %, or internal revenue numbers to the UI.
 */

function computeTrustSignals(item, options = {}) {
  const platform = options.platform || 'shopee';
  const sourcePrice = Number(options.sourcePrice || 0);

  const rating = Number(item?.rating || 0);
  const sales = Number(item?.sales || item?.unitsSold || 0);
  const sold7d = Number(item?.sold7d || 0);
  const growth = Number(item?.growth || 0);
  const price = Number(item?.price || 0);
  const estimatedCashback = Number(item?.estimatedCashback || 0);

  // 1. Smart Warning (distinguish missing data vs actual low-trust evidence)
  let trustWarning = null;
  if (rating > 0 && rating < 4.2) {
    trustWarning = {
      code: 'low_rating',
      message: `Đánh giá thấp (⭐ ${rating.toFixed(1)}) — bạn nên xem kỹ nhận xét shop.`
    };
  } else if (
    sourcePrice > 0 &&
    price > 0 &&
    price <= sourcePrice * 0.7 &&
    sales > 0 &&
    sales < 10
  ) {
    trustWarning = {
      code: 'low_sales_cheap',
      message: 'Giá rẻ bất thường & ít lượt bán — nên kiểm tra kỹ phân loại và shop.'
    };
  }

  // 2. Single highest-priority Highlight Badge (never stack 3-4 badges on mobile)
  // Priority: 🔥 Đang tăng trưởng -> ⭐ Bán chạy -> 💰 Hoàn tiền cao -> 💎 Đánh giá tốt
  let highlightBadge = null;

  if (!trustWarning) {
    const isTrending = platform === 'shopee' && (sold7d >= 50 || (sold7d >= 20 && growth > 0));
    const isBestSeller =
      (platform === 'shopee' && sales >= 1000 && (rating === 0 || rating >= 4.5)) ||
      (platform === 'tiktok' && sales >= 500);
    const effectiveCashbackRatio = price > 0 ? estimatedCashback / price : 0;
    const isHighCashback =
      estimatedCashback >= 20000 ||
      (estimatedCashback >= 5000 && effectiveCashbackRatio >= 0.06);
    const isTopRated = rating >= 4.8 && sales >= 50;

    if (isTrending) {
      highlightBadge = { type: 'trending', label: '🔥 Đang tăng trưởng' };
    } else if (isBestSeller) {
      highlightBadge = { type: 'bestseller', label: '⭐ Bán chạy' };
    } else if (isHighCashback) {
      highlightBadge = { type: 'high_cashback', label: '💰 Hoàn tiền cao' };
    } else if (isTopRated) {
      highlightBadge = { type: 'top_rated', label: '💎 Đánh giá tốt' };
    }
  }

  return {
    rating: rating > 0 ? Number(rating.toFixed(1)) : 0,
    sales: sales > 0 ? Math.round(sales) : 0,
    sold7d: sold7d > 0 ? Math.round(sold7d) : 0,
    highlightBadge,
    trustWarning
  };
}

module.exports = {
  computeTrustSignals
};
