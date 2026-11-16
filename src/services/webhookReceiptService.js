const crypto = require('crypto');
const { getPgPool } = require('./dbService');
const { parseTimestamp } = require('./orderReconciliationService');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

async function acceptWebhookReceipt(db, provider, payload, existing, nextStatus) {
  const safe = { ...payload }; delete safe.token; delete safe.sig;
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonical(safe))).digest('hex');
  const eventId = payload.event_id || payload.eventId;
  const key = crypto.createHash('sha256').update(JSON.stringify([provider, eventId || hash])).digest('hex');
  const pool = getPgPool();
  const stored = pool
    ? (await pool.query('SELECT payload_hash FROM webhook_receipts WHERE receipt_key=$1', [key])).rows[0]?.payload_hash
    : (db.webhookReceipts || []).find(r => r.key === key)?.hash;
  if (stored && stored !== hash) {
    const error = new Error('Webhook event ID reused with a different payload'); error.status = 409; throw error;
  }
  if (stored) return false;
  const eventTime = parseTimestamp(payload.eventTime || payload.event_time || payload.update_time || payload.timestamp);
  if (existing && ['approved', 'cancelled'].includes(existing.status) && existing.status !== nextStatus && nextStatus !== 'pending' && !eventTime) {
    const error = new Error('A provider event time is required to change a finalized order; reconcile with provider API.');
    error.status = 409; throw error;
  }
  (db.webhookReceipts ||= []).push({ key, hash });
  return true;
}
module.exports = { acceptWebhookReceipt };
