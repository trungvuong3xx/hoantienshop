const crypto = require('crypto');
const logger = require('../utils/logger');
const { ensureDbLoaded } = require('./dbService');
const { parseTimestamp } = require('./orderReconciliationService');

/**
 * Resolve configured postback secret token from environment variables or DB settings.
 */
function getConfiguredPostbackToken(db) {
  const currentDb = db || (typeof ensureDbLoaded === 'function' ? ensureDbLoaded() : null);
  return String(
    process.env.POSTBACK_TOKEN ||
    process.env.POSTBACK_SECRET ||
    currentDb?.settings?.postbackToken ||
    ''
  ).trim();
}

/**
 * Authenticate incoming webhook/postback requests via HMAC-SHA256 signature, header token,
 * or GET-only AccessTrade query macro token with timestamp anti-replay enforcement.
 */
function verifyWebhookRequest(req, db) {
  const configuredToken = getConfiguredPostbackToken(db);
  if (!configuredToken) {
    logger.warning('verifyWebhookRequest', 'Postback token is not configured on server');
    return { status: 403, error: 'Postback webhook not configured.' };
  }

  const rawTs =
    req.headers['x-webhook-timestamp'] ||
    req.headers['x-postback-timestamp'] ||
    req.body?.timestamp;

  if (rawTs !== undefined && rawTs !== null && rawTs !== '') {
    const ts = parseTimestamp(rawTs);
    if (!ts || !Number.isFinite(ts)) {
      logger.warning('verifyWebhookRequest', 'Invalid webhook timestamp format', { rawTs });
      return { status: 401, error: 'Invalid webhook timestamp format.' };
    }
    const now = Date.now();
    const diffSec = (now - ts) / 1000;
    if (diffSec > 300) {
      logger.warning('verifyWebhookRequest', 'Webhook timestamp expired (>300s)', { ts, now, diffSec });
      return { status: 401, error: 'Webhook timestamp expired.' };
    }
    if (diffSec < -60) {
      logger.warning('verifyWebhookRequest', 'Webhook timestamp in the future (>60s)', { ts, now, diffSec });
      return { status: 401, error: 'Webhook timestamp in the future.' };
    }
  }

  const isWriteOp = req.method !== 'GET' && req.method !== 'HEAD';
  const headerSignature = req.headers['x-signature-sha256'] || req.headers['x-postback-signature'];
  const headerToken =
    req.headers['x-postback-token'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : '');

  if (headerSignature) {
    const cleanSig = String(headerSignature).trim().replace(/^sha256=/i, '');
    const rawBodyBuf = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : (typeof req.rawBody === 'string'
        ? Buffer.from(req.rawBody, 'utf8')
        : (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
          ? Buffer.from(JSON.stringify(req.body), 'utf8')
          : Buffer.alloc(0)));

    const expectedSig = crypto
      .createHmac('sha256', configuredToken)
      .update(rawBodyBuf)
      .digest('hex');

    const bufProvided = Buffer.from(cleanSig.toLowerCase());
    const bufExpected = Buffer.from(expectedSig.toLowerCase());

    if (bufProvided.length !== bufExpected.length || !crypto.timingSafeEqual(bufProvided, bufExpected)) {
      logger.warning('verifyWebhookRequest', 'Invalid postback signature', {
        providedLen: bufProvided.length,
        expectedLen: bufExpected.length
      });
      return { status: 401, error: 'Invalid postback signature.' };
    }

    return { valid: true };
  }

  if (headerToken) {
    const bufProvided = Buffer.from(headerToken);
    const bufExpected = Buffer.from(configuredToken);

    if (bufProvided.length !== bufExpected.length || !crypto.timingSafeEqual(bufProvided, bufExpected)) {
      logger.warning('verifyWebhookRequest', 'Invalid postback token in header');
      return { status: 401, error: 'Invalid postback token.' };
    }

    return { valid: true };
  }

  if (!isWriteOp && req.query?.token) {
    const queryToken = String(req.query.token).trim();
    const bufProvided = Buffer.from(queryToken);
    const bufExpected = Buffer.from(configuredToken);

    if (bufProvided.length !== bufExpected.length || !crypto.timingSafeEqual(bufProvided, bufExpected)) {
      logger.warning('verifyWebhookRequest', 'Invalid postback token in query parameter');
      return { status: 401, error: 'Invalid postback token.' };
    }

    return { valid: true };
  }

  if (isWriteOp && (req.query?.token || req.query?.sig)) {
    logger.warning('verifyWebhookRequest', 'Token or signature in query parameters rejected for write operation', {
      method: req.method
    });
    return {
      status: 401,
      error: 'Tokens or signatures in query parameters are not permitted for write operations.'
    };
  }

  logger.warning('verifyWebhookRequest', 'Missing postback authentication headers');
  return {
    status: 401,
    error: 'Missing postback token or signature in headers.'
  };
}

module.exports = {
  getConfiguredPostbackToken,
  verifyWebhookRequest
};
