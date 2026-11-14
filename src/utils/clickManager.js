const logger = require('./logger');

const CLICK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days retention
const MAX_CLICKS_HARD_LIMIT = 20000; // Safety upper bound against memory exhaustion

/**
 * Filter out clicks older than CLICK_TTL_MS (30 days) and cap at MAX_CLICKS_HARD_LIMIT.
 * @param {Array} clicks - Array of click objects
 * @param {number} [now=Date.now()] - Current epoch timestamp in ms (for testing)
 * @returns {Array} - Cleaned array of clicks
 */
function cleanExpiredClicks(clicks, now = Date.now()) {
  if (!Array.isArray(clicks)) {
    return [];
  }

  const cutoff = now - CLICK_TTL_MS;
  const initialCount = clicks.length;

  const cleaned = clicks.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    const time = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    return !Number.isNaN(time) && time > cutoff;
  }).slice(0, MAX_CLICKS_HARD_LIMIT);

  if (cleaned.length < initialCount) {
    logger.log('cleanExpiredClicks', 'Pruned expired or overflow clicks', {
      before: initialCount,
      after: cleaned.length,
      pruned: initialCount - cleaned.length
    });
  }

  return cleaned;
}

/**
 * Adds a new click record at the head of the clicks array and purges expired entries.
 * Mutates clicks in-place when possible, and returns the cleaned array.
 * @param {Array} clicks - Existing array of clicks
 * @param {Object} clickData - Click payload
 * @returns {Array} - Updated array of clicks
 */
function addClickRecord(clicks, clickData) {
  if (!Array.isArray(clicks)) {
    clicks = [];
  }

  if (!clickData || typeof clickData !== 'object' || !clickData.clickId) {
    return cleanExpiredClicks(clicks);
  }

  const record = {
    clickId: String(clickData.clickId),
    userId: clickData.userId || null,
    userCode: clickData.userCode || 'GUEST',
    platform: clickData.platform || 'shopee',
    originalUrl: clickData.originalUrl || '',
    cleanUrl: clickData.cleanUrl || '',
    productId: clickData.productId || null,
    affiliateUrl: clickData.affiliateUrl || '',
    createdAt: clickData.createdAt || new Date().toISOString()
  };

  clicks.unshift(record);

  const cleaned = cleanExpiredClicks(clicks);
  // Synchronize array contents in-place so references remain valid
  clicks.length = 0;
  for (let i = 0; i < cleaned.length; i++) {
    clicks.push(cleaned[i]);
  }

  return clicks;
}

module.exports = {
  CLICK_TTL_MS,
  MAX_CLICKS_HARD_LIMIT,
  cleanExpiredClicks,
  addClickRecord
};
