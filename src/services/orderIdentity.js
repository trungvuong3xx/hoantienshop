const platformOf = value => String(value || 'shopee').trim().toLowerCase();
const orderKey = order => JSON.stringify([platformOf(order.platform), String(order.orderSn || '').trim().toUpperCase()]);
const orderId = order => 'ord2:' + Buffer.from(orderKey(order)).toString('base64url');
const sameOrder = (order, sn, platform) => orderKey(order) === orderKey({ orderSn: sn, platform });

function legacyOrderSn(ref = '') {
  for (const prefix of ['order_credit_', 'order_revoke_', 'order_recredit_', 'order_cancellation_', 'clawback_']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  if (ref.startsWith('ord_adj_')) return ref.slice(8, ref.lastIndexOf('_'));
  if (ref.startsWith('order_revocation_') && ref.includes('_deleted_')) return ref.slice(17, ref.lastIndexOf('_deleted_'));
  return null;
}

// Freeze the platform of legacy references before accepting a second platform
// with the same order number. Never rewrite the append-only financial ledger.
function migrateLegacyOrderIdentity(db) {
  const platforms = db.settings.legacyOrderPlatforms ||= {};
  for (const entry of db.ledger || []) {
    const sn = legacyOrderSn(entry.refId);
    if (!sn || Object.hasOwn(platforms, sn)) continue;
    const matches = db.orders.filter(order => String(order.orderSn).toUpperCase() === sn.toUpperCase());
    const unique = [...new Set(matches.map(order => platformOf(order.platform)))];
    if (unique.length > 1) throw new Error('Ambiguous legacy ledger order: ' + sn);
    Object.defineProperty(platforms, sn, { value: unique[0] || 'shopee', enumerable: true, writable: true, configurable: true });
  }
}

function ledgerOrderKey(entry, db) {
  if (entry.refId?.startsWith('ord2:')) {
    const encoded = entry.refId.split(':')[1];
    const [platform, orderSn, userId] = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (userId !== entry.userId) throw new Error('Ledger identity does not match its owner');
    return orderKey({ platform, orderSn });
  }
  const sn = legacyOrderSn(entry.refId);
  return sn ? orderKey({ platform: db.settings.legacyOrderPlatforms?.[sn] || 'shopee', orderSn: sn }) : null;
}

function orderLedgerRef(key, userId, sequence) {
  return 'ord2:' + Buffer.from(JSON.stringify([...JSON.parse(key), userId])).toString('base64url') + ':' + sequence;
}

module.exports = { platformOf, orderKey, orderId, sameOrder, migrateLegacyOrderIdentity, ledgerOrderKey, orderLedgerRef };
