/**
 * Zalo Utility Module & URL Validator
 * Enforces strict allowlist validation for Zalo group URLs and targets.
 */

const DEFAULT_ZALO_GROUP_URL = 'https://zalo.me/g/cl2cmiseoqienusnrbyr';

/**
 * Validates whether a given URL string is a safe and valid Zalo group URL.
 *
 * Requirements:
 * - Must be a valid string, trimmed length <= 255.
 * - Must parse as URL with protocol `https:`.
 * - Hostname must be strictly `zalo.me` or subdomain ending with `.zalo.me`.
 * - Reject http, javascript:, data:, credentials, non-standard ports, and spoof domains
 *   (e.g., zalo.me.evil.com, evil.com/zalo.me, zalo.me@evil.com).
 *
 * @param {string} urlStr
 * @returns {boolean}
 */
function isValidZaloGroupUrl(urlStr) {
  if (typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed || trimmed.length > 255) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  // Strict HTTPS protocol enforcement
  if (parsed.protocol !== 'https:') {
    return false;
  }

  // Reject embedded credentials (e.g. https://zalo.me@evil.com or https://user:pass@zalo.me)
  if (parsed.username || parsed.password) {
    return false;
  }

  // Disallow non-standard ports
  if (parsed.port && parsed.port !== '443') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    return false;
  }

  // Hostname must be strictly 'zalo.me' or a valid subdomain ending with '.zalo.me'
  const isZaloHost = hostname === 'zalo.me' || /^([a-z0-9-]+(\.[a-z0-9-]+)*\.)?zalo\.me$/.test(hostname);
  if (!isZaloHost) {
    return false;
  }

  return true;
}

/**
 * Normalizes a Zalo target URL.
 * Returns valid trimmed URL if isValidZaloGroupUrl passes, else empty string ''.
 *
 * @param {string} urlStr
 * @returns {string}
 */
function normalizeZaloTarget(urlStr) {
  if (!isValidZaloGroupUrl(urlStr)) {
    return '';
  }
  return String(urlStr).trim();
}

/**
 * Performs auto-migration of legacy supportZalo group links to zaloGroupUrl if not already set.
 *
 * @param {object} db - Database object containing settings
 */
function migrateZaloSettings(db) {
  if (!db || !db.settings) return;
  if (
    typeof db.settings.supportZalo === 'string' &&
    db.settings.supportZalo.startsWith('https://zalo.me/g/') &&
    !db.settings.zaloGroupUrl
  ) {
    db.settings.zaloGroupUrl = db.settings.supportZalo.trim();
  }
}

module.exports = {
  DEFAULT_ZALO_GROUP_URL,
  isValidZaloGroupUrl,
  normalizeZaloTarget,
  migrateZaloSettings
};
