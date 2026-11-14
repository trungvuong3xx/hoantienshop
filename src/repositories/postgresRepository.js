const logger = require('../utils/logger');
const { sanitizeUser, getPgPool } = require('../services/dbService');
const { buildVietQrImageUrl } = require('../utils/securityMiddleware');

/**
 * Normalize pagination parameters (page, limit, offset) safely.
 */
function normalizePagination({ page = 1, limit = 50, maxLimit = 200, defaultLimit = 50 } = {}) {
  const rawLimit = Number(limit);
  const safeLimit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(maxLimit, Math.round(rawLimit))
      : defaultLimit;
  const rawPage = Number(page);
  const safePage = Number.isFinite(rawPage) && rawPage > 0 ? Math.round(rawPage) : 1;
  const offset = (safePage - 1) * safeLimit;
  return { page: safePage, limit: safeLimit, offset };
}

/**
 * Compute pagination metadata summary.
 */
function buildPaginationMeta(total, page, limit) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(page, totalPages);
  return {
    page: clampedPage,
    limit,
    total,
    totalPages
  };
}

/**
 * Query orders with search, status/platform/user filtering, and server-side pagination.
 * Supports optional SQL query execution when PostgreSQL pool is active and preferSql=true.
 */
async function queryOrdersPaginated(db, opts = {}) {
  const { page, limit } = normalizePagination(opts);
  const q = String(opts.q || '').trim().toLowerCase();
  const status = String(opts.status || '').trim().toLowerCase();
  const platform = String(opts.platform || '').trim().toLowerCase();
  const userId = opts.userId ? String(opts.userId) : '';
  const userCode = opts.userCode ? String(opts.userCode).toUpperCase() : '';

  logger.logEnter('queryOrdersPaginated', { page, limit, hasQuery: Boolean(q), status, platform });

  const pool = opts.preferSql ? getPgPool() : null;
  if (pool) {
    try {
      const conditions = [];
      const params = [];
      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }
      if (status && ['pending', 'approved', 'cancelled'].includes(status)) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (platform && ['shopee', 'tiktok'].includes(platform)) {
        params.push(platform);
        conditions.push(`platform = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const pIdx = params.length;
        conditions.push(
          `(LOWER(order_sn) LIKE $${pIdx} OR LOWER(COALESCE(product_name, '')) LIKE $${pIdx} OR LOWER(COALESCE(user_code, '')) LIKE $${pIdx} OR LOWER(COALESCE(click_id, '')) LIKE $${pIdx})`
        );
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM orders ${whereClause}`, params);
      const total = Number(countRes.rows[0]?.total || 0);
      const meta = buildPaginationMeta(total, page, limit);
      const offset = (meta.page - 1) * meta.limit;

      const listRes = await pool.query(
        `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, meta.limit, offset]
      );
      const items = listRes.rows.map((row) => ({
        orderSn: row.order_sn,
        platform: row.platform || 'shopee',
        clickId: row.click_id || null,
        userId: row.user_id || null,
        userCode: row.user_code || 'GUEST',
        productName: row.product_name || '',
        orderAmount: Math.round(Number(row.order_amount || 0)),
        grossCommission: Math.round(Number(row.gross_commission || 0)),
        taxAmount: Math.round(Number(row.tax_amount || 0)),
        netCommission: Math.round(Number(row.net_commission || 0)),
        totalCommission: Math.round(Number(row.net_commission || 0)),
        cashbackRate: Number(row.cashback_rate || 70),
        userCashbackAmount: Math.round(Number(row.user_cashback_amount || 0)),
        adminShareAmount: Math.round(Number(row.admin_share_amount || 0)),
        status: row.status || 'pending',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      }));
      logger.logLeave('queryOrdersPaginated', { source: 'postgres', total, returned: items.length });
      return { items, pagination: meta };
    } catch (err) {
      logger.warning('queryOrdersPaginated', 'SQL fallback to in-memory state', { error: err.message });
    }
  }

  let filtered = Array.isArray(db?.orders) ? [...db.orders] : [];

  if (userId || userCode) {
    filtered = filtered.filter(
      (o) =>
        (userId && o.userId === userId) ||
        (userCode && o.userCode && String(o.userCode).toUpperCase() === userCode)
    );
  }
  if (status && ['pending', 'approved', 'cancelled'].includes(status)) {
    filtered = filtered.filter((o) => String(o.status || '').toLowerCase() === status);
  }
  if (platform && ['shopee', 'tiktok'].includes(platform)) {
    filtered = filtered.filter((o) => String(o.platform || '').toLowerCase() === platform);
  }
  if (q) {
    filtered = filtered.filter((o) => {
      const sn = String(o.orderSn || '').toLowerCase();
      const prod = String(o.productName || '').toLowerCase();
      const code = String(o.userCode || '').toLowerCase();
      const clk = String(o.clickId || '').toLowerCase();
      return sn.includes(q) || prod.includes(q) || code.includes(q) || clk.includes(q);
    });
  }

  filtered.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const total = filtered.length;
  const pagination = buildPaginationMeta(total, page, limit);
  const offset = (pagination.page - 1) * pagination.limit;
  const items = filtered.slice(offset, offset + pagination.limit);

  logger.logLeave('queryOrdersPaginated', { source: 'memory', total, returned: items.length });
  return { items, pagination };
}

/**
 * Query users with search and server-side pagination, sanitizing sensitive fields.
 */
function queryUsersPaginated(db, opts = {}) {
  const { page, limit } = normalizePagination(opts);
  const q = String(opts.q || '').trim().toLowerCase();
  const includeDeleted = Boolean(opts.includeDeleted);

  logger.logEnter('queryUsersPaginated', { page, limit, hasQuery: Boolean(q) });

  let filtered = Array.isArray(db?.users) ? [...db.users] : [];
  if (!includeDeleted) {
    filtered = filtered.filter((u) => !u.isDeleted);
  }
  if (q) {
    filtered = filtered.filter((u) => {
      const code = String(u.code || '').toLowerCase();
      const name = String(u.name || '').toLowerCase();
      const phone = String(u.phone || '').toLowerCase();
      const email = String(u.email || '').toLowerCase();
      return code.includes(q) || name.includes(q) || phone.includes(q) || email.includes(q);
    });
  }

  filtered.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const total = filtered.length;
  const pagination = buildPaginationMeta(total, page, limit);
  const offset = (pagination.page - 1) * pagination.limit;
  const items = filtered.slice(offset, offset + pagination.limit).map(sanitizeUser);

  logger.logLeave('queryUsersPaginated', { total, returned: items.length });
  return { items, pagination };
}

/**
 * Query withdrawals with search, status filtering, VietQR enrichment, and pagination.
 */
function queryWithdrawalsPaginated(db, opts = {}) {
  const { page, limit } = normalizePagination(opts);
  const q = String(opts.q || '').trim().toLowerCase();
  const status = String(opts.status || '').trim().toLowerCase();
  const userId = opts.userId ? String(opts.userId) : '';

  logger.logEnter('queryWithdrawalsPaginated', { page, limit, hasQuery: Boolean(q), status });

  let filtered = Array.isArray(db?.withdrawals) ? [...db.withdrawals] : [];
  if (userId) {
    filtered = filtered.filter((w) => w.userId === userId);
  }
  if (status && ['pending', 'paid', 'rejected'].includes(status)) {
    filtered = filtered.filter((w) => String(w.status || '').toLowerCase() === status);
  }
  if (q) {
    filtered = filtered.filter((w) => {
      const id = String(w.id || '').toLowerCase();
      const code = String(w.userCode || '').toLowerCase();
      const name = String(w.userName || '').toLowerCase();
      const phone = String(w.userPhone || '').toLowerCase();
      const bank = String(w.bankName || '').toLowerCase();
      const acc = String(w.bankAccount || '').toLowerCase();
      return id.includes(q) || code.includes(q) || name.includes(q) || phone.includes(q) || bank.includes(q) || acc.includes(q);
    });
  }

  filtered.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const total = filtered.length;
  const pagination = buildPaginationMeta(total, page, limit);
  const offset = (pagination.page - 1) * pagination.limit;
  const items = filtered.slice(offset, offset + pagination.limit).map((w) => ({
    ...w,
    vietQrUrl: buildVietQrImageUrl(
      w.bankName,
      w.bankAccount,
      w.amount,
      w.bankOwner,
      `Hoan tien ${w.userCode}`
    )
  }));

  logger.logLeave('queryWithdrawalsPaginated', { total, returned: items.length });
  return { items, pagination };
}

module.exports = {
  normalizePagination,
  queryOrdersPaginated,
  queryUsersPaginated,
  queryWithdrawalsPaginated
};
