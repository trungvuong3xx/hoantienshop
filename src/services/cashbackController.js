const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  initPostgresIfConfigured,
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  calculateCommissionSplit,
  recalculateUserWallet,
  recalculateAllWallets,
  executeAtomicWithdrawal,
  refundWithdrawal,
  appendLedgerEntry,
  auditLedgerIntegrity,
  createToken,
  verifyToken,
  sanitizeUser,
  getDatabaseStatus,
  reloadStateFromPostgres,
  withUserLock,
  recordAuditLog,
  normalizePhoneNumber
} = require('./dbService');
const { convertTextLinks } = require('./converterService');
const {
  fetchShopeeConversionReport,
  fetchShopeeProductOffer,
  fetchAddlivetagProductData,
  DEFAULT_ADDLIVETAG_API_KEY
} = require('./shopeeService');
const { fetchAccessTradeOrders } = require('./tiktokService');
const {
  isAllowedHost,
  isAllowedAffiliateRedirectUrl,
  safeResolve,
  detectPlatform,
  cleanShopeeUrl,
  cleanTikTokUrl,
  extractUrlsFromText
} = require('../utils/urlResolver');
const {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl,
  createCsrfGuard
} = require('../utils/securityMiddleware');
const { cleanExpiredClicks } = require('../utils/clickManager');
const {
  DEFAULT_ZALO_GROUP_URL,
  isValidZaloGroupUrl,
  normalizeZaloTarget,
  migrateZaloSettings
} = require('../utils/zalo');
const {
  ALLOWED_ORDER_TRANSITIONS,
  parseTimestamp,
  canTransitionOrderStatus,
  sanitizeOrderForUser,
  normalizeNetworkStatus,
  sanitizeFiniteNumber,
  parseShopeeReportNodes
} = require('./orderReconciliationService');
const {
  getConfiguredPostbackToken,
  verifyWebhookRequest
} = require('./webhookSecurityService');
const {
  queryOrdersPaginated,
  queryUsersPaginated,
  queryWithdrawalsPaginated
} = require('../repositories/postgresRepository');

class AppError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.name = 'AppError';
    this.status = status;
    this.httpStatus = status;
    this.publicMessage = publicMessage;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

let activeResolves = 0;
const MAX_CONCURRENT_RESOLVES = 5;
const resolveWaitQueue = [];

async function acquireResolveSlot() {
  if (activeResolves < MAX_CONCURRENT_RESOLVES) {
    activeResolves++;
    return () => {
      activeResolves--;
      if (resolveWaitQueue.length > 0) {
        const next = resolveWaitQueue.shift();
        next();
      }
    };
  }
  return new Promise((resolve) => {
    resolveWaitQueue.push(() => {
      activeResolves++;
      resolve(() => {
        activeResolves--;
        if (resolveWaitQueue.length > 0) {
          const next = resolveWaitQueue.shift();
          next();
        }
      });
    });
  });
}

function parseCookieToken(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)hts_auth=([^;]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return '';
  }
}

function setAuthCookie(res, token) {
  const isProd = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production');
  const securePart = isProd ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `hts_auth=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${3600 * 6}; SameSite=Lax${securePart}`
  );
}

function clearAuthCookie(res) {
  const isProd = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production');
  const securePart = isProd ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `hts_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${securePart}`
  );
}

function getAuthUser(req) {
  const cookieToken = parseCookieToken(req);
  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = cookieToken || headerToken;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const db = ensureDbLoaded();
  const user = db.users.find((u) => u.id === payload.id);
  if (!user) return null;
  if (Number(user.tokenVersion || 1) !== Number(payload.ver || 1)) {
    return null; // Token revoked after password change
  }
  if (user.accountLocked) {
    return null; // Account temporarily locked
  }
  return user;
}

function requireAdmin(req, res, next) {
  const user = getAuthUser(req);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Chỉ Quản trị viên mới có quyền truy cập.' });
    return null;
  }
  req.adminUser = user;
  if (typeof next === 'function') return next();
  return user;
}

function generateUserCode(phone, existingUsers) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-4) || '9999';
  for (let i = 0; i < 20; i++) {
    const rand = Math.floor(10 + Math.random() * 90);
    const candidate = `U${digits}${rand}`;
    if (!existingUsers.some((u) => u.code === candidate)) {
      return candidate;
    }
  }
  return `U${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function maskSecret(val) {
  if (!val || typeof val !== 'string' || !val.trim()) return '';
  return '***';
}

/**
 * Shared order upsert that automatically maps clickId (sub_id / sub1) -> userId,
 * preserves user-claimed orders, guards against out-of-order events, blocks invalid downgrades,
 * applies clawback on cancelled approved orders, and calculates post-tax 70/30 cashback split.
 */
function upsertNetworkOrder(db, {
  orderSn,
  rawSubId,
  grossCommission,
  orderAmount,
  status,
  platform,
  productName,
  eventTime,
  purchaseTime,
  commissionEstimated
}) {
  const cleanSn = String(orderSn || '').trim().toUpperCase();
  if (!cleanSn) return null;

  logger.logEnter('upsertNetworkOrder', { orderSn: cleanSn, status, eventTime });

  const cleanSub = String(rawSubId || '').split('-')[0].trim();
  const clickRecord = cleanSub
    ? db.clicks.find((c) => c.clickId === cleanSub)
    : null;

  const matchedUser = clickRecord?.userId
    ? db.users.find((u) => u.id === clickRecord.userId)
    : cleanSub
    ? db.users.find(
        (u) =>
          (u.code && String(u.code).toUpperCase() === cleanSub.toUpperCase()) ||
          String(u.phone || '').trim() === cleanSub ||
          (normalizePhoneNumber(u.phone) && normalizePhoneNumber(u.phone) === normalizePhoneNumber(cleanSub))
      )
    : null;

  const validGross = Number.isFinite(Number(grossCommission)) && Number(grossCommission) >= 0
    ? Number(grossCommission)
    : 0;

  const existing = db.orders.find((o) => String(o.orderSn || '').toUpperCase() === cleanSn);

  const cbRateToUse = existing?.lockedCashbackRate !== undefined && existing?.lockedCashbackRate !== null
    ? existing.lockedCashbackRate
    : db.settings.cashbackPercent;
  const taxRateToUse = existing?.lockedTaxRate !== undefined && existing?.lockedTaxRate !== null
    ? existing.lockedTaxRate
    : db.settings.taxDeductPercent;

  const split = calculateCommissionSplit(
    validGross,
    cbRateToUse,
    taxRateToUse
  );

  const normalizedPlatform =
    String(platform || clickRecord?.platform || '').toLowerCase() === 'tiktok'
      ? 'tiktok'
      : 'shopee';

  const incomingEventTime = parseTimestamp(eventTime) || parseTimestamp(purchaseTime);

  if (existing) {
    // 1. Guard against admin override if statusSource === 'admin'
    if (existing.statusSource === 'admin' && status === 'pending') {
      logger.log('upsertNetworkOrder', 'Bỏ qua đồng bộ trạng thái pending cho đơn đã được Quản trị viên duyệt', {
        orderSn: cleanSn,
        currentStatus: existing.status
      });
      logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, status: existing.status });
      return existing;
    }

    const existingEventTime = parseTimestamp(existing.eventTime);
    const existingStatusUpdatedAt = parseTimestamp(existing.statusUpdatedAt);
    const existingUpdatedAt = parseTimestamp(existing.updatedAt);

    // 2. Out-of-order network webhooks with older eventTime are ignored
    if (incomingEventTime > 0 && existingEventTime > 0 && incomingEventTime < existingEventTime) {
      logger.warning('upsertNetworkOrder', 'Bỏ qua sự kiện ngoài thứ tự do eventTime cũ hơn eventTime của đơn hàng', {
        orderSn: cleanSn,
        incomingEventTime,
        existingEventTime
      });
      logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, ignored: true, reason: 'older_eventTime' });
      return existing;
    }

    // 3. For approved orders:
    if (existing.status === 'approved') {
      // Reject any event attempting to downgrade status to pending
      if (status === 'pending') {
        logger.warning('canTransitionOrderStatus', 'Bỏ qua chuyển đổi trạng thái không hợp lệ', {
          from: existing.status,
          to: status
        });
        logger.warning('upsertNetworkOrder', 'Bỏ qua sự kiện trạng thái không hợp lệ', {
          orderSn: cleanSn,
          from: existing.status,
          to: status
        });
        logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, status: existing.status, blocked: 'approved_to_pending' });
        return existing;
      }

      // Reject/ignore any event with eventTime older than existing.eventTime (or existing.updatedAt / statusUpdatedAt)
      const existingApprovedTime = existingEventTime || existingStatusUpdatedAt || existingUpdatedAt;
      if (incomingEventTime > 0 && existingApprovedTime > 0 && incomingEventTime < existingApprovedTime) {
        logger.warning('upsertNetworkOrder', 'Bỏ qua sự kiện có eventTime cũ hơn trạng thái hiện tại của đơn đã duyệt', {
          orderSn: cleanSn,
          incomingEventTime,
          existingApprovedTime
        });
        logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, ignored: true, reason: 'stale_event_for_approved' });
        return existing;
      }
    }

    // 4. Validate general state transition BEFORE updating amounts or status
    const currentStatusTime = existingEventTime || existingStatusUpdatedAt || existingUpdatedAt;
    if (status && !canTransitionOrderStatus(existing.status, status, {
      fromEventTime: incomingEventTime,
      currentStatusUpdatedAt: currentStatusTime
    })) {
      logger.warning('upsertNetworkOrder', 'Bỏ qua sự kiện trạng thái không hợp lệ', {
        orderSn: cleanSn,
        from: existing.status,
        to: status
      });
      logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, status: existing.status, blocked: 'invalid_transition' });
      return existing;
    }

    // 5. Do not let pending sync overwrite finalized financial amounts of approved or cancelled orders
    if ((existing.status === 'approved' || existing.status === 'cancelled') && status === 'pending') {
      logger.warning('upsertNetworkOrder', 'Bỏ qua cập nhật số tiền từ sự kiện pending cho đơn đã duyệt/hủy', {
        orderSn: cleanSn,
        currentStatus: existing.status
      });
      logger.logLeave('upsertNetworkOrder', { orderSn: cleanSn, status: existing.status, blocked: 'pending_overwrite' });
      return existing;
    }

    // 6. Clawback Mechanism: if order was previously approved and valid network event updates it to cancelled
    if (existing.status === 'approved' && status === 'cancelled') {
      const targetUserId =
        existing.userId ||
        matchedUser?.id ||
        db.users.find(
          (u) =>
            existing.userCode &&
            String(u.code).toUpperCase() === String(existing.userCode).toUpperCase()
        )?.id;

      let creditedAmount = 0;
      if (targetUserId) {
        const orderLedgerEntries = db.ledger.filter(
          (e) =>
            e.userId === targetUserId &&
            (e.refId === `order_credit_${cleanSn}` ||
              (e.refId && e.refId.startsWith(`ord_adj_${cleanSn}_`)) ||
              (e.refId && e.refId.startsWith(`clawback_${cleanSn}`)))
        );
        const netCredited = orderLedgerEntries.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        if (netCredited > 0) {
          creditedAmount = netCredited;
        }
      }

      existing.status = 'cancelled';
      existing.statusUpdatedAt = new Date().toISOString();
      existing.clawbackAt = new Date().toISOString();
      if (incomingEventTime > 0) {
        existing.eventTime = eventTime || incomingEventTime;
      }

      const clawbackRefId = `clawback_${cleanSn}`;
      if (creditedAmount > 0 && targetUserId && !db.ledger.some((e) => e.refId === clawbackRefId)) {
        const clawbackAmt = -Math.abs(Math.round(creditedAmount));
        appendLedgerEntry(
          targetUserId,
          'order_clawback',
          clawbackAmt,
          clawbackRefId,
          `Thu hồi hoàn tiền đơn hàng bị hủy #${cleanSn} (${clawbackAmt.toLocaleString('vi-VN')} đ)`
        );
        recalculateUserWallet(targetUserId, { persist: false });
        logger.log('upsertNetworkOrder', 'Đã ghi nhận bút toán thu hồi hoàn tiền clawback', {
          orderSn: cleanSn,
          userId: targetUserId,
          amount: clawbackAmt,
          refId: clawbackRefId
        });
      }

      existing.updatedAt = new Date().toISOString();
      logger.logLeave('upsertNetworkOrder', {
        orderSn: cleanSn,
        status: existing.status,
        clawbackAt: existing.clawbackAt
      });
      return existing;
    }

    // 7. Update financial amounts and attribution
    if (existing.lockedCashbackRate === undefined || existing.lockedCashbackRate === null) {
      existing.lockedCashbackRate = split.cashbackRate;
    }
    if (existing.lockedTaxRate === undefined || existing.lockedTaxRate === null) {
      existing.lockedTaxRate = split.taxDeductPercent;
    }

    existing.grossCommission = split.grossCommission;
    existing.taxAmount = split.taxAmount;
    existing.netCommission = split.netCommission;
    existing.totalCommission = split.netCommission;
    existing.cashbackRate = existing.lockedCashbackRate;

    // Preserve custom cashback amount if previously customized by Admin
    if (!existing.hasCustomCashback) {
      existing.userCashbackAmount = split.userCashbackAmount;
      existing.adminShareAmount = split.adminShareAmount;
    } else {
      existing.adminShareAmount = Math.max(
        0,
        split.netCommission - Number(existing.userCashbackAmount || 0)
      );
    }

    const validOrderAmt = Number(orderAmount);
    if (Number.isFinite(validOrderAmt) && validOrderAmt > 0) {
      existing.orderAmount = validOrderAmt;
    }
    if (productName && (!existing.productName || existing.productName.startsWith('Đơn'))) {
      existing.productName = String(productName).slice(0, 150);
    }
    if (status && existing.status !== status) {
      existing.status = status;
      existing.statusUpdatedAt = new Date().toISOString();
    }
    if (incomingEventTime > 0) {
      existing.eventTime = eventTime || incomingEventTime;
    }
    if (!existing.clickId && cleanSub) {
      existing.clickId = cleanSub;
    }
    // Attribution resolution: Verified tracking click (matchedUser) takes precedence
    if (matchedUser) {
      if (!existing.userId || existing.submittedByUserId) {
        existing.userId = matchedUser.id;
        existing.userCode = matchedUser.code;
        if (existing.submittedByUserId) {
          if (existing.submittedByUserId === matchedUser.id) {
            existing.claimPending = false;
            existing.claimVerified = true;
          } else {
            existing.claimPending = false;
            existing.claimRejected = true;
            existing.claimRejectReason = 'Mã đơn đã được ghi nhận cho tài khoản mua hàng thực tế qua liên kết tiếp thị.';
          }
        }
      }
    } else if (existing.submittedByUserId && !existing.userId) {
      // Sàn báo đơn không có tracking click (GUEST purchase): giữ chờ Admin đối soát
      existing.claimPending = true;
    }
    existing.updatedAt = new Date().toISOString();
    logger.logLeave('upsertNetworkOrder', {
      orderSn: cleanSn,
      status: existing.status,
      userCashbackAmount: existing.userCashbackAmount
    });
    return existing;
  }

  const validOrderAmt = Number(orderAmount);
  const created = {
    id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    orderSn: cleanSn,
    platform: normalizedPlatform,
    clickId: clickRecord ? clickRecord.clickId : cleanSub || null,
    userCode: matchedUser ? matchedUser.code : cleanSub || 'GUEST',
    userId: matchedUser ? matchedUser.id : null,
    productName:
      (productName && String(productName).slice(0, 150)) ||
      `Đơn ${normalizedPlatform === 'tiktok' ? 'TikTok' : 'Shopee'} #${cleanSn}`,
    orderAmount: Number.isFinite(validOrderAmt) && validOrderAmt >= 0 ? validOrderAmt : 0,
    grossCommission: split.grossCommission,
    taxAmount: split.taxAmount,
    netCommission: split.netCommission,
    totalCommission: split.netCommission,
    cashbackRate: split.cashbackRate,
    lockedCashbackRate: split.cashbackRate,
    lockedTaxRate: split.taxDeductPercent,
    userCashbackAmount: split.userCashbackAmount,
    adminShareAmount: split.adminShareAmount,
    status,
    hasCustomCashback: false,
    commissionEstimated: Boolean(commissionEstimated),
    eventTime: eventTime || (incomingEventTime || null),
    createdAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.unshift(created);
  logger.logLeave('upsertNetworkOrder', {
    orderSn: cleanSn,
    created: true,
    status: created.status
  });
  return created;
}

/**
 * Shared logic to synchronize orders from Shopee Open API conversionReport.
 */
async function runShopeeAutoSync() {
  logger.logEnter('runShopeeAutoSync');
  const db = ensureDbLoaded();
  const s = db.settings;
  const appId = process.env.SHOPEE_APP_ID || s.shopeeAppId;
  const appSecret = process.env.SHOPEE_APP_SECRET || s.shopeeAppSecret;

  if (!appId || !appSecret) {
    throw new Error('Chưa cấu hình Shopee Open API (App ID & Secret) để đồng bộ tự động.');
  }

  const reportNodes = await fetchShopeeConversionReport(appId, appSecret, 50);
  const parsedOrders = parseShopeeReportNodes(reportNodes);
  let syncedCount = 0;

  for (const parsed of parsedOrders) {
    try {
      upsertNetworkOrder(db, parsed);
      syncedCount++;
    } catch (itemErr) {
      logger.warning('runShopeeAutoSync', 'Bỏ qua đơn Shopee hỏng định dạng', { error: itemErr.message });
    }
  }

  db.settings.lastAutoSyncAt = new Date().toISOString();
  recalculateAllWallets();
  await saveDb(db);
  logger.logLeave('runShopeeAutoSync', { syncedCount });
  return { syncedCount, orders: parsedOrders };
}

/**
 * Shared logic to synchronize orders from AccessTrade Publisher API (/v1/orders).
 */
async function runAccessTradeAutoSync() {
  logger.logEnter('runAccessTradeAutoSync');
  const db = ensureDbLoaded();
  const s = db.settings;
  const apiKey = process.env.ACCESSTRADE_API_KEY || s.accesstradeApiKey;

  if (!apiKey) {
    throw new Error('Chưa cấu hình AccessTrade API Key để đồng bộ đơn TikTok/AccessTrade tự động.');
  }

  const rows = await fetchAccessTradeOrders(apiKey, 30);
  let syncedCount = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    try {
      const orderSn = String(
        row.order_id || row.conversion_id || row.transaction_id || ''
      )
        .trim()
        .toUpperCase();
      if (!orderSn) continue;

      const rawSubId = String(row.sub1 || row.utm_source || '').trim();
      const grossComm = Number(
        row.pub_commission ?? row.reward ?? row.commission ?? 0
      );
      const orderAmount = Number(
        row.billing ?? row.total_amount ?? row.amount ?? 0
      );
      const status = normalizeNetworkStatus(
        row.status ?? row.order_status ?? row.approval_status
      );
      const merchantRaw = String(row.merchant || '').toLowerCase();
      const platform = merchantRaw.includes('shopee') ? 'shopee' : 'tiktok';
      const firstProd = Array.isArray(row.products) && row.products.length > 0 ? row.products[0] : null;
      const productName =
        firstProd?.name ||
        row.product_name ||
        `Đơn ${platform === 'tiktok' ? 'TikTok' : 'Shopee'} #${orderSn}`;

      upsertNetworkOrder(db, {
        orderSn,
        rawSubId,
        grossCommission: grossComm,
        orderAmount,
        status,
        platform,
        productName
      });
      syncedCount++;
    } catch (rowErr) {
      logger.warning('runAccessTradeAutoSync', 'Bỏ qua bản ghi AccessTrade hỏng định dạng', { error: rowErr.message });
    }
  }

  db.settings.lastAutoSyncAt = new Date().toISOString();
  recalculateAllWallets();
  await saveDb(db);
  logger.logLeave('runAccessTradeAutoSync', { syncedCount });
  return { syncedCount };
}

/**
 * Run all configured auto-sync providers (Shopee Open API + AccessTrade API).
 */
async function runAutoSyncAll({ requireAtLeastOne = false } = {}) {
  logger.logEnter('runAutoSyncAll');
  const db = ensureDbLoaded();
  const s = db.settings;
  const hasShopee = Boolean((process.env.SHOPEE_APP_ID || s.shopeeAppId) && (process.env.SHOPEE_APP_SECRET || s.shopeeAppSecret));
  const hasAccessTrade = Boolean(process.env.ACCESSTRADE_API_KEY || s.accesstradeApiKey);

  if (requireAtLeastOne && !hasShopee && !hasAccessTrade) {
    throw new Error(
      'Chưa cấu hình AccessTrade API Key hoặc Shopee Open API. Lưu ý: Bạn vẫn nhận đơn tự động qua Link Postback AccessTrade bên dưới!'
    );
  }

  let shopeeSynced = 0;
  let accesstradeSynced = 0;
  const errors = [];

  if (hasShopee) {
    try {
      const r = await runShopeeAutoSync();
      shopeeSynced = r.syncedCount;
    } catch (err) {
      errors.push(`Shopee: ${err.message}`);
    }
  }

  if (hasAccessTrade) {
    try {
      const r = await runAccessTradeAutoSync();
      accesstradeSynced = r.syncedCount;
    } catch (err) {
      errors.push(`AccessTrade: ${err.message}`);
    }
  }

  const nowIso = new Date().toISOString();
  db.settings.lastSyncAttemptAt = nowIso;

  // Only update lastAutoSyncAt if at least one configured network succeeded without 100% failure
  const totalConfigured = Number(hasShopee) + Number(hasAccessTrade);
  if (totalConfigured > 0 && errors.length < totalConfigured) {
    db.settings.lastAutoSyncAt = nowIso;
    db.settings.syncFailureCount = 0;
  } else if (totalConfigured > 0) {
    db.settings.syncFailureCount = Number(db.settings.syncFailureCount || 0) + 1;
  }
  await saveDb(db);
  const out = {
    shopeeSynced,
    accesstradeSynced,
    syncedCount: shopeeSynced + accesstradeSynced,
    errors,
    lastAutoSyncAt: db.settings.lastAutoSyncAt,
    lastSyncAttemptAt: db.settings.lastSyncAttemptAt
  };
  logger.logLeave('runAutoSyncAll', out);
  return out;
}

let isAutoSyncInFlight = false;
let globalSyncTimer = null;
function triggerLazyAutoSyncIfNeeded() {
  if (isAutoSyncInFlight) return;
  try {
    const db = ensureDbLoaded();
    const s = db.settings;
    const hasShopee = Boolean((process.env.SHOPEE_APP_ID || s.shopeeAppId) && (process.env.SHOPEE_APP_SECRET || s.shopeeAppSecret));
    const hasAccessTrade = Boolean(process.env.ACCESSTRADE_API_KEY || s.accesstradeApiKey);
    if (!hasShopee && !hasAccessTrade) return;

    // Exponential backoff check if sync failed recently
    const failCount = Number(s.syncFailureCount || 0);
    const lastAttemptMs = s.lastSyncAttemptAt ? new Date(s.lastSyncAttemptAt).getTime() : 0;
    if (failCount > 0 && lastAttemptMs > 0) {
      const backoffMs = Math.min(60 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, failCount - 1));
      if (Date.now() - lastAttemptMs < backoffMs) {
        return;
      }
    }

    const lastMs = s.lastAutoSyncAt ? new Date(s.lastAutoSyncAt).getTime() : 0;
    if (Date.now() - lastMs < 10 * 60 * 1000) return; // Synced within last 10 mins

    isAutoSyncInFlight = true;
    runAutoSyncAll({ requireAtLeastOne: false })
      .catch((err) => {
        logger.warning('triggerLazyAutoSyncIfNeeded', 'Background sync warning', { error: err.message });
      })
      .finally(() => {
        isAutoSyncInFlight = false;
      });
  } catch (err) {
    logger.warning('triggerLazyAutoSyncIfNeeded', 'Trigger error', { error: err.message });
  }
}

function registerCashbackRoutes(app) {
  try {
    const startupDb = ensureDbLoaded();
    migrateZaloSettings(startupDb);
  } catch (err) {
    logger.warning('registerCashbackRoutes', 'Initial db load migration warning', { error: err.message });
  }

  // Enforce CSRF checks on cookie-authenticated API mutations
  app.use(createCsrfGuard());

  const authLimiter = createRateLimiter({
    windowMs: 60000,
    max: 15,
    keyPrefix: 'auth',
    failClosed: true
  });
  const convertLimiter = createRateLimiter({ windowMs: 60000, max: 30, keyPrefix: 'convert' });
  const withdrawLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyPrefix: 'withdraw',
    failClosed: true
  });

  // Ensure Postgres state is initialized on first request if DATABASE_URL is set
  app.use(async (req, res, next) => {
    try {
      await initPostgresIfConfigured();
      const activeDb = ensureDbLoaded();
      migrateZaloSettings(activeDb);
      next();
    } catch (err) {
      logger.error('initMiddleware', 'Postgres startup error', { error: err.message });
      if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
        return res.status(503).json({
          error: 'Cơ sở dữ liệu đang đồng bộ hoặc khởi động. Vui lòng tải lại trang sau vài giây.'
        });
      }
      next();
    }
  });

  // Safe Outbound Redirect Route (/go/:clickId) - Whitelist enforced & strict-origin-when-cross-origin
  app.get('/go/:clickId', (req, res) => {
    logger.logEnter('GET /go/:clickId', { clickId: req.params.clickId });
    const db = ensureDbLoaded();
    const click = db.clicks.find((c) => c.clickId === req.params.clickId);
    if (!click || !click.affiliateUrl) {
      logger.logLeave('GET /go/:clickId', { redirect: 'home_missing' });
      return res.redirect(302, '/');
    }

    try {
      const customTpl = db?.settings?.tiktokDeepLinkTemplate || '';
      if (!isAllowedAffiliateRedirectUrl(click.affiliateUrl, customTpl)) {
        logger.warning('GET /go/:clickId', 'Chặn chuyển hướng tới tên miền không nằm trong allowlist', {
          clickId: req.params.clickId
        });
        logger.logLeave('GET /go/:clickId', { blocked: true });
        return res.status(400).send('Liên kết đích không hợp lệ.');
      }
      const target = new URL(click.affiliateUrl);
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Cache-Control', 'no-store');
      logger.logLeave('GET /go/:clickId', { host: target.hostname });
      return res.redirect(302, target.toString());
    } catch {
      logger.logLeave('GET /go/:clickId', { redirect: 'home_error' });
      return res.redirect(302, '/');
    }
  });

  // 1. Public Config (Never exposes secrets)
  app.get('/api/public-config', (req, res) => {
    logger.logEnter('GET /api/public-config');
    const db = ensureDbLoaded();
    migrateZaloSettings(db);
    const s = db.settings;
    res.json({
      siteName: s.siteName || 'Hoàn Tiền Sàn',
      cashbackPercent: Number(s.cashbackPercent || 70),
      taxDeductPercent: Number(s.taxDeductPercent ?? 10),
      referralBonusPercent: Number(s.referralBonusPercent ?? 5),
      referralBountyAmount: Number(s.referralBountyAmount ?? 5000),
      minWithdrawAmount: Number(s.minWithdrawAmount || 50000),
      supportZalo: s.supportZalo || '',
      zaloGroupUrl: s.zaloGroupUrl || DEFAULT_ZALO_GROUP_URL,
      zaloWidgetEnabled: s.zaloWidgetEnabled ?? true,
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || s.turnstileSiteKey || '',
      hasShopeeConfigured: Boolean(s.shopeeAffiliateId || s.shopeeAppId)
    });
    logger.logLeave('GET /api/public-config');
  });

  app.get('/api/settings', (req, res) => {
    logger.logEnter('GET /api/settings');
    const db = ensureDbLoaded();
    migrateZaloSettings(db);
    const s = db.settings;
    res.json({
      siteName: s.siteName || 'Hoàn Tiền Sàn',
      cashbackPercent: Number(s.cashbackPercent || 70),
      taxDeductPercent: Number(s.taxDeductPercent ?? 10),
      referralBonusPercent: Number(s.referralBonusPercent ?? 5),
      referralBountyAmount: Number(s.referralBountyAmount ?? 5000),
      minWithdrawAmount: Number(s.minWithdrawAmount || 50000),
      supportZalo: s.supportZalo || '',
      zaloGroupUrl: s.zaloGroupUrl || DEFAULT_ZALO_GROUP_URL,
      zaloWidgetEnabled: s.zaloWidgetEnabled ?? true,
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || s.turnstileSiteKey || '',
      hasShopeeConfigured: Boolean(s.shopeeAffiliateId || s.shopeeAppId)
    });
    logger.logLeave('GET /api/settings');
  });

  // 2. Auth: Register (scrypt + 1-level referral + Turnstile check)
  app.post('/api/auth/register', authLimiter, async (req, res, next) => {
    logger.logEnter('POST /api/auth/register');
    try {
      const { name, phone, email, password, refCode, turnstileToken } = req.body || {};
      const db = ensureDbLoaded();

      const turnstileOk = await verifyTurnstileIfEnabled(turnstileToken, getClientIp(req), {
        settings: db?.settings
      });
      if (!turnstileOk) {
        return res.status(400).json({ error: 'Xác thực chống bot không hợp lệ. Vui lòng thử lại.' });
      }

      const rawPhone = String(phone || '').trim();
      const cleanPhone = normalizePhoneNumber(rawPhone) || rawPhone.replace(/\s+/g, '');
      if (!/^[0-9+]{8,15}$/.test(cleanPhone) || !password || String(password).length < 6) {
        return res.status(400).json({
          error: 'Vui lòng nhập Số điện thoại hợp lệ (8-15 số) và Mật khẩu tối thiểu 6 ký tự.'
        });
      }

      const exists = db.users.find(
        (u) =>
          (u.phone && (String(u.phone).trim() === cleanPhone || normalizePhoneNumber(u.phone) === cleanPhone)) ||
          (email && u.email && String(u.email).toLowerCase() === String(email).trim().toLowerCase())
      );
      if (exists) {
        return res.status(400).json({ error: 'Số điện thoại này đã được đăng ký.' });
      }

      // Validate 1-level referrer if provided (prevent self-referral)
      let validReferrerCode = null;
      if (refCode && typeof refCode === 'string' && refCode.trim()) {
        const cleanRefCode = refCode.trim().toUpperCase();
        const refUser = db.users.find(
          (u) => u.code && String(u.code).toUpperCase() === cleanRefCode
        );
        if (
          refUser &&
          refUser.phone !== cleanPhone &&
          (!email || !refUser.email || refUser.email.toLowerCase() !== String(email).trim().toLowerCase())
        ) {
          validReferrerCode = refUser.code;
        }
      }

      const passwordHash = await hashPasswordAsync(password);
      const newUser = {
        id: `usr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        code: generateUserCode(cleanPhone, db.users),
        name: String(name || cleanPhone).trim().slice(0, 60),
        phone: cleanPhone,
        email: String(email || '').trim().slice(0, 80),
        passwordHash,
        role: 'user',
        tokenVersion: 1,
        referredBy: validReferrerCode,
        balanceAvailable: 0,
        balancePending: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        bankName: '',
        bankAccount: '',
        bankOwner: '',
        createdAt: new Date().toISOString()
      };

      db.users.push(newUser);
      await saveDb(db);

      const token = createToken(newUser);
      setAuthCookie(res, token);
      logger.logLeave('POST /api/auth/register', { userCode: newUser.code });
      return res.json({ token, user: sanitizeUser(newUser) });
    } catch (err) {
      logger.error('POST /api/auth/register', 'Lỗi đăng ký tài khoản', { error: err.message });
      next(err);
    }
  });

  // 3. Auth: Login (timingSafeEqual + automatic upgrade to scrypt + HttpOnly cookie)
  app.post('/api/auth/login', authLimiter, async (req, res, next) => {
    logger.logEnter('POST /api/auth/login');
    try {
      const { identifier, password, turnstileToken } = req.body || {};
      if (!identifier || !password) {
        return res.status(400).json({ error: 'Vui lòng nhập Số điện thoại và Mật khẩu.' });
      }

      const db = ensureDbLoaded();
      const turnstileOk = await verifyTurnstileIfEnabled(turnstileToken, getClientIp(req), {
        settings: db?.settings
      });
      if (!turnstileOk) {
        return res.status(400).json({ error: 'Xác thực chống bot không hợp lệ.' });
      }

      const cleanId = String(identifier).trim().toLowerCase();
      const normId = normalizePhoneNumber(cleanId);

      const user = db.users.find(
        (u) =>
          (u.phone && (String(u.phone).toLowerCase() === cleanId || (normId && normalizePhoneNumber(u.phone) === normId))) ||
          (u.email && String(u.email).toLowerCase() === cleanId) ||
          (u.code && String(u.code).toLowerCase() === cleanId)
      );

      if (!user || !(await verifyPasswordAsync(password, user.passwordHash))) {
        return res.status(401).json({ error: 'Thông tin đăng nhập không chính xác.' });
      }

      // Automatically upgrade legacy hash to scrypt
      if (!String(user.passwordHash).startsWith('scrypt$')) {
        user.passwordHash = await hashPasswordAsync(password);
        await saveDb(db);
      }

      recalculateUserWallet(user.id);
      const token = createToken(user);
      setAuthCookie(res, token);
      logger.logLeave('POST /api/auth/login', { userCode: user.code, role: user.role });
      return res.json({ token, user: sanitizeUser(user) });
    } catch (err) {
      logger.error('POST /api/auth/login', 'Lỗi đăng nhập', { error: err.message });
      next(err);
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    logger.logEnter('POST /api/auth/logout');
    const user = getAuthUser(req);
    if (user) {
      user.tokenVersion = Number(user.tokenVersion || 1) + 1;
      const db = ensureDbLoaded();
      await saveDb(db);
    }
    clearAuthCookie(res);
    logger.logLeave('POST /api/auth/logout');
    return res.json({ status: 'ok' });
  });

  // 4. Current User Dashboard (Includes Orders, Withdrawals, Immutable Ledger & Referral Count)
  app.get('/api/user/me', asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/user/me');
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }

    triggerLazyAutoSyncIfNeeded();
    const db = ensureDbLoaded();
    recalculateUserWallet(user.id);

    const { items: userOrders, pagination: ordersPagination } = await queryOrdersPaginated(db, {
      userId: user.id,
      userCode: user.code,
      page: req.query.orderPage || req.query.page || 1,
      limit: req.query.orderLimit || req.query.limit || 200,
      q: req.query.q || '',
      status: req.query.orderStatus || req.query.status || ''
    });

    const userWithdrawals = db.withdrawals
      .filter((w) => w.userId === user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const userLedger = db.ledger
      .filter((l) => l.userId === user.id)
      .slice(0, 30);

    const userCodeUpper = String(user.code || '').toUpperCase();
    const referralCount = db.users.filter(
      (u) => u.referredBy && String(u.referredBy).toUpperCase() === userCodeUpper && u.id !== user.id
    ).length;
    const referralBountyAmount = Math.max(0, Math.round(Number(db.settings?.referralBountyAmount ?? 5000)));

    logger.logLeave('GET /api/user/me', { userCode: user.code, referralCount, referralBountyAmount });
    return res.json({
      user: sanitizeUser(user),
      orders: userOrders.map(sanitizeOrderForUser),
      ordersPagination,
      withdrawals: userWithdrawals,
      ledger: userLedger,
      referralCount,
      referralBountyAmount
    });
  }));

  // 4.1. User Referral Network & Bounty Stats (5.000đ on referee 1st approved order)
  app.get('/api/user/referrals', (req, res) => {
    logger.logEnter('GET /api/user/referrals');
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }

    const db = ensureDbLoaded();
    recalculateUserWallet(user.id);

    const bountyAmount = Math.max(0, Math.round(Number(db.settings.referralBountyAmount ?? 5000)));
    const userCodeUpper = String(user.code || '').toUpperCase();

    const refereeUsers = db.users.filter(
      (u) => u.referredBy && String(u.referredBy).toUpperCase() === userCodeUpper && u.id !== user.id
    );

    let completedFriends = 0;
    let pendingFriends = 0;
    let totalBountyEarned = 0;

    const friends = refereeUsers
      .map((r) => {
        const refereeOrders = db.orders.filter(
          (o) =>
            (o.userId === r.id ||
              (o.userCode && String(o.userCode).toUpperCase() === String(r.code).toUpperCase())) &&
            o.status === 'approved'
        );
        const isCompleted = refereeOrders.length > 0;
        if (isCompleted) {
          completedFriends++;
          totalBountyEarned += bountyAmount;
        } else {
          pendingFriends++;
        }

        const maskedPhone =
          r.phone && r.phone.length >= 7
            ? `${r.phone.slice(0, 3)}***${r.phone.slice(-3)}`
            : r.phone || r.code;

        return {
          id: r.id,
          code: r.code,
          maskedPhone,
          name: r.name ? (r.name.length > 3 ? r.name.slice(0, 1) + '***' : r.name) : 'Bạn mới',
          createdAt: r.createdAt,
          status: isCompleted ? 'completed' : 'pending',
          orderCount: refereeOrders.length,
          bonusEarned: isCompleted ? bountyAmount : 0
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    logger.logLeave('GET /api/user/referrals', {
      userCode: user.code,
      totalFriends: refereeUsers.length,
      completedFriends,
      totalBountyEarned
    });

    return res.json({
      referrals: friends,
      referralCount: refereeUsers.length,
      referralBountyAmount: bountyAmount,
      completedFriends,
      pendingFriends,
      totalBountyEarned,
      referralCode: user.code,
      bountyAmount,
      friends,
      stats: {
        totalFriends: refereeUsers.length,
        completedFriends,
        pendingFriends,
        totalBountyEarned
      }
    });
  });

  const profileLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyPrefix: 'profile',
    failClosed: false
  });
  // 5. Update User Profile / Bank Info (Requires password verification if changing bankAccount or bankName)
  app.post('/api/user/profile', profileLimiter, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/user/profile');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Chưa đăng nhập.' });

    const { name, bankName, bankAccount, bankOwner, currentPassword, password } = req.body || {};
    const newAcc = bankAccount !== undefined ? String(bankAccount).trim() : undefined;
    const newBank = bankName !== undefined ? String(bankName).trim() : undefined;

    const isAccChanged = newAcc !== undefined && newAcc !== (user.bankAccount || '');
    const isBankChanged = newBank !== undefined && newBank !== (user.bankName || '');

    if (isAccChanged || isBankChanged) {
      const pwd = password || currentPassword;
      if (!pwd || !(await verifyPasswordAsync(pwd, user.passwordHash))) {
        return res.status(400).json({
          error: 'Vui lòng nhập đúng mật khẩu hiện tại khi thay đổi thông tin ngân hàng.'
        });
      }
    }

    if (name !== undefined) user.name = String(name).trim().slice(0, 60);
    if (newBank !== undefined) user.bankName = newBank.slice(0, 40);
    if (newAcc !== undefined) user.bankAccount = newAcc.slice(0, 30);
    if (bankOwner !== undefined) {
      user.bankOwner = String(bankOwner).trim().toUpperCase().slice(0, 60);
    }

    const db = ensureDbLoaded();
    await saveDb(db);
    logger.logLeave('POST /api/user/profile', { userCode: user.code });
    return res.json({ user: sanitizeUser(user) });
  }));

  // 6. User Submit Order Lookup / Tracking Request (Prevents unauthorized hijacking of GUEST orders)
  app.post('/api/user/submit-order', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/user/submit-order');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập để tra cứu đơn hàng.' });

    const { orderSn, platform, productName } = req.body || {};
    const cleanSn = String(orderSn || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    if (cleanSn.length < 6 || cleanSn.length > 32) {
      return res.status(400).json({ error: 'Mã đơn hàng không hợp lệ (6-32 ký tự chữ/số).' });
    }

    return withUserLock(user.id, async () => {
      const db = ensureDbLoaded();
      const existing = db.orders.find((o) => String(o.orderSn || '').toUpperCase() === cleanSn);
      if (existing) {
        if (existing.userId === user.id) {
          return res.json({
            order: sanitizeOrderForUser(existing),
            autoMatched: true,
            message: 'Đơn hàng này đã có trong tài khoản của bạn.'
          });
        }
        if (existing.userId && existing.userCode !== 'GUEST') {
          return res.status(400).json({
            error: 'Mã đơn hàng này đã được ghi nhận cho một tài khoản khác.'
          });
        }

        // Order was previously GUEST or unassigned: Check verifiable ownership attribution proof
        const isAttributedToUser =
          (existing.clickId &&
            db.clicks.some(
              (c) =>
                c.clickId === existing.clickId &&
                (c.userId === user.id ||
                  (c.userCode && String(c.userCode).toUpperCase() === String(user.code).toUpperCase()))
            )) ||
          (existing.userCode &&
            String(existing.userCode).toUpperCase() === String(user.code).toUpperCase());

        if (isAttributedToUser) {
          // Direct click tracking attribution verified: auto-claim into wallet
          existing.userId = user.id;
          existing.userCode = user.code;
          existing.updatedAt = new Date().toISOString();
          recalculateUserWallet(user.id);
          await saveDb(db);
          logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn, autoClaimed: true });
          return res.json({
            order: sanitizeOrderForUser(existing),
            autoMatched: true,
            message: 'Đã khớp tự động đơn hàng từ sàn và cộng tiền hoàn vào ví của bạn!'
          });
        }

        // No direct tracking attribution proof: queue for manual admin verification to prevent hijacking
        existing.claimPending = true;
        existing.claimedByUserId = user.id;
        existing.claimedByUserCode = user.code;
        existing.claimRequestedAt = new Date().toISOString();
        existing.updatedAt = new Date().toISOString();
        await saveDb(db);
        logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn, claimPending: true });
        return res.json({
          order: sanitizeOrderForUser(existing),
          claimPending: true,
          message: 'Đã tiếp nhận yêu cầu đối soát đơn hàng. Ban quản trị sẽ xác minh quyền sở hữu và duyệt hoàn tiền trong 24h.'
        });
      }

      // Never trust client for orderAmount or commission; set 0 until network postback/report confirms
      // Secure attribution: Keep userId null and mark claimPending so a user cannot hijack other buyers' orders
      const newOrd = {
        id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        orderSn: cleanSn,
        platform: String(platform || '').toLowerCase() === 'tiktok' ? 'tiktok' : 'shopee',
        clickId: null,
        userCode: 'PENDING_VERIFY',
        userId: null,
        submittedByUserId: user.id,
        submittedByUserCode: user.code,
        claimPending: true,
        claimRequestedAt: new Date().toISOString(),
        productName: String(productName || `Đơn hàng #${cleanSn}`).trim().slice(0, 100),
        orderAmount: 0,
        grossCommission: 0,
        taxAmount: 0,
        netCommission: 0,
        totalCommission: 0,
        cashbackRate: Number(db.settings.cashbackPercent || 70),
        lockedCashbackRate: Number(db.settings.cashbackPercent || 70),
        lockedTaxRate: Number(db.settings.taxDeductPercent || 10),
        userCashbackAmount: 0,
        adminShareAmount: 0,
        status: 'pending',
        hasCustomCashback: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      db.orders.unshift(newOrd);
      await saveDb(db);
      logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn, created: true, claimPending: true });
      return res.json({
        order: sanitizeOrderForUser(newOrd),
        autoMatched: false,
        claimPending: true,
        message: 'Đã ghi nhận mã đơn hàng. Tiền hoàn sẽ tự động cập nhật khi sàn đối soát hoàn tất và xác nhận liên kết tiếp thị!'
      });
    });
  }));

  // 7. User Request Withdrawal (Atomic per-user lock + Postgres FOR UPDATE transaction)
  app.post('/api/user/withdraw', withdrawLimiter, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/user/withdraw');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });

    const db = ensureDbLoaded();
    const { amount, method, bankName, bankAccount, bankOwner, currentPassword } = req.body || {};
    const rawAmt = Number(amount);
    if (!Number.isFinite(rawAmt) || rawAmt <= 0) {
      return res.status(400).json({ error: 'Số tiền rút không hợp lệ, vui lòng nhập số nguyên dương lớn hơn 0.' });
    }
    const numAmount = Math.round(rawAmt);
    const minWithdraw = Number(db.settings.minWithdrawAmount || 50000);
    if (numAmount < minWithdraw) {
      return res.status(400).json({ error: `Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ.` });
    }

    const cleanAcc = String(bankAccount || '').replace(/\s+/g, '').slice(0, 30);
    const cleanOwner = String(bankOwner || '').trim().toUpperCase().slice(0, 60);
    const validMethod = method === 'momo' ? 'momo' : 'bank';
    const cleanBank = String(bankName || (validMethod === 'momo' ? 'MoMo' : '')).trim().slice(0, 40);

    if (!cleanAcc || cleanAcc.length < 4 || !cleanOwner || cleanOwner.length < 2 || !cleanBank) {
      return res.status(400).json({
        error: 'Vui lòng điền đầy đủ và chính xác Tên ngân hàng, Số tài khoản (tối thiểu 4 ký tự) và Tên chủ tài khoản.'
      });
    }

    // Security check: if user already had a different bank account saved OR has no bank account saved yet,
    // require password verification to bind or alter payout coordinates
    if (!user.bankAccount || user.bankAccount !== cleanAcc) {
      if (!currentPassword || !(await verifyPasswordAsync(currentPassword, user.passwordHash))) {
        return res.status(403).json({
          error: 'Vui lòng nhập mật khẩu đăng nhập để xác nhận thông tin nhận tiền rút.'
        });
      }
    }

    const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    const idempotencyKey = rawIdempotencyKey ? String(rawIdempotencyKey).trim() : null;

    if (idempotencyKey) {
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      const existing = db.withdrawals.find(
        (w) =>
          w.userId === user.id &&
          w.idempotencyKey === idempotencyKey &&
          new Date(w.createdAt).getTime() >= tenMinutesAgo
      );
      if (existing) {
        logger.log('POST /api/user/withdraw', 'Idempotent request returning existing withdrawal', {
          wdId: existing.id,
          idempotencyKey
        });
        return res.json({ withdrawal: existing, user: sanitizeUser(user), idempotent: true });
      }
    }

    try {
      const result = await executeAtomicWithdrawal({
        userId: user.id,
        amount: numAmount,
        method: validMethod,
        bankName: cleanBank,
        bankAccount: cleanAcc,
        bankOwner: cleanOwner,
        minWithdraw,
        idempotencyKey
      });
      logger.logLeave('POST /api/user/withdraw', { amount: numAmount, userCode: user.code });
      return res.json(result);
    } catch (err) {
      logger.warning('POST /api/user/withdraw', 'Withdrawal rejected', {
        userCode: user.code,
        error: err.message
      });
      return res.status(400).json({ error: err.message });
    }
  }));

  // 7.5. Instant Product Preview (Safe Resolve + GraphQL productOfferV2 metadata + Cashback estimate)
  const previewLimiter = createRateLimiter({
    windowMs: 60000,
    max: 20,
    keyPrefix: 'preview',
    failClosed: true
  });
  app.post('/api/preview', previewLimiter, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/preview');
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string' || !url.trim() || url.length > 2000) {
        return res.status(400).json({ found: false, error: 'Vui lòng cung cấp link sản phẩm hợp lệ.' });
      }

      const extracted = extractUrlsFromText(url);
      const targetUrl = extracted[0] || url.trim();

      // SSRF & Domain Whitelist resolution with concurrency limit
      let resolvedUrl = targetUrl;
      let htmlSnippet = '';
      const releaseResolveSlot = await acquireResolveSlot();
      try {
        const resolved = await safeResolve(targetUrl, 4);
        resolvedUrl = resolved.resolvedUrl;
        htmlSnippet = resolved.htmlSnippet;
      } catch (err) {
        logger.warning('POST /api/preview', 'Resolve error', { error: err.message });
        return res.status(400).json({ found: false, error: err.message });
      } finally {
        releaseResolveSlot();
      }

      const platform = detectPlatform(resolvedUrl);
      if (platform !== 'shopee' && platform !== 'tiktok') {
        return res.status(400).json({
          found: false,
          error: 'Chỉ hỗ trợ xem trước sản phẩm Shopee và TikTok Shop.'
        });
      }

      const db = ensureDbLoaded();
      const s = db.settings;
      const cbPct = Number(s.cashbackPercent || 70);
      const taxRate = Number(s.taxDeductPercent ?? 10);

      if (platform === 'shopee') {
        const cleanInfo = cleanShopeeUrl(resolvedUrl, htmlSnippet);
        const appId = s.shopeeAppId || process.env.SHOPEE_APP_ID || '';
        const appSecret = s.shopeeAppSecret || process.env.SHOPEE_APP_SECRET || '';
        const addlivetagKey = (s.addlivetagApiKey || process.env.ADDLIVETAG_API_KEY || DEFAULT_ADDLIVETAG_API_KEY).trim();

        let productMeta = null;
        // Priority 1: Official Shopee Open API if credentials configured
        if (cleanInfo.itemId && appId && appSecret) {
          productMeta = await fetchShopeeProductOffer(
            cleanInfo.itemId,
            appId,
            appSecret,
            cleanInfo.shopId
          );
        }

        // Priority 2: AddLiveTag Data API (via user's provided API key or system default)
        if (!productMeta && addlivetagKey) {
          productMeta = await fetchAddlivetagProductData({
            platform: 'shopee',
            itemId: cleanInfo.itemId,
            url: cleanInfo.cleanUrl || resolvedUrl,
            apiKey: addlivetagKey
          });
        }

        if (productMeta) {
          const price = Number(productMeta.price || productMeta.priceMin || 0);
          const commRate = Number(productMeta.commissionRate || 0);
          const grossCommission =
            productMeta.commission > 0
              ? Number(productMeta.commission)
              : (price * commRate) / 100;
          const split = calculateCommissionSplit(grossCommission, cbPct, taxRate);

          logger.logLeave('POST /api/preview', {
            platform: 'shopee',
            hasOffer: Boolean(grossCommission || commRate),
            source: productMeta.dataSource || 'openapi'
          });
          const title = productMeta.productName || 'Đang cập nhật thông tin sản phẩm';
          return res.json({
            found: true,
            platform: 'shopee',
            hasOffer: Boolean(grossCommission || commRate),
            productName: title,
            title,
            imageUrl: productMeta.imageUrl || '',
            price,
            priceMin: productMeta.priceMin || price,
            priceMax: productMeta.priceMax || price,
            commissionRate: commRate,
            estimatedCashback: split.userCashbackAmount,
            shopName: productMeta.shopName || '',
            ratingStar: productMeta.ratingStar || 5,
            sales: productMeta.sales || 0,
            cashbackPercent: cbPct,
            cleanUrl: cleanInfo.cleanUrl,
            dataSource: productMeta.dataSource || 'shopee'
          });
        }

        logger.logLeave('POST /api/preview', { platform: 'shopee', hasOffer: false });
        const safeTitle =
          cleanInfo.titleHint && !cleanInfo.titleHint.startsWith('Sản phẩm Shopee #')
            ? cleanInfo.titleHint
            : 'Đang cập nhật thông tin sản phẩm';
        return res.json({
          found: true,
          platform: 'shopee',
          hasOffer: false,
          productName: safeTitle,
          title: safeTitle,
          imageUrl: '',
          price: 0,
          estimatedCashback: 0,
          cashbackPercent: cbPct,
          note: `Mức hoàn tùy đơn hàng (hoàn ${cbPct}% hoa hồng sàn khi đơn thành công)`,
          cleanUrl: cleanInfo.cleanUrl
        });
      }

      if (platform === 'tiktok') {
        const cleanInfo = cleanTikTokUrl(resolvedUrl, htmlSnippet);
        const addlivetagKey = (s.addlivetagApiKey || process.env.ADDLIVETAG_API_KEY || DEFAULT_ADDLIVETAG_API_KEY).trim();

        let productMeta = null;
        if (addlivetagKey) {
          productMeta = await fetchAddlivetagProductData({
            platform: 'tiktok',
            url: resolvedUrl,
            apiKey: addlivetagKey
          });
        }

        if (productMeta) {
          const price = Number(productMeta.price || 0);
          const commRate = Number(productMeta.commissionRate || 0);
          const grossCommission =
            productMeta.commission > 0
              ? Number(productMeta.commission)
              : (price * commRate) / 100;
          const split = calculateCommissionSplit(grossCommission, cbPct, taxRate);

          logger.logLeave('POST /api/preview', {
            platform: 'tiktok',
            hasOffer: Boolean(grossCommission || commRate),
            source: 'addlivetag'
          });
          const title = productMeta.productName || cleanInfo.titleHint || 'Sản phẩm TikTok Shop';
          return res.json({
            found: true,
            platform: 'tiktok',
            hasOffer: Boolean(grossCommission || commRate),
            productName: title,
            title,
            imageUrl: productMeta.imageUrl || cleanInfo.imageUrl || '',
            price,
            commissionRate: commRate,
            estimatedCashback: split.userCashbackAmount,
            shopName: productMeta.shopName || '',
            cashbackPercent: cbPct,
            cleanUrl: cleanInfo.cleanUrl,
            dataSource: 'addlivetag'
          });
        }

        logger.logLeave('POST /api/preview', { platform: 'tiktok' });
        const safeTitle = cleanInfo.titleHint || 'Sản phẩm TikTok Shop';
        return res.json({
          found: true,
          platform: 'tiktok',
          hasOffer: Boolean(cleanInfo.imageUrl),
          productName: safeTitle,
          title: safeTitle,
          imageUrl: cleanInfo.imageUrl || '',
          price: 0,
          estimatedCashback: 0,
          cashbackPercent: cbPct,
          note: `Hoàn ${cbPct}% hoa hồng sàn (tự động cộng ví khi hoàn tất đơn hàng)`,
          cleanUrl: cleanInfo.cleanUrl
        });
      }
    } catch (err) {
      logger.error('POST /api/preview', 'Preview error', { error: err.message });
      return res.status(500).json({ found: false, error: 'Đã có lỗi xảy ra trên hệ thống.' });
    }
  }));

  // Diagnostic route for testing Shopee productOfferV2 directly (Admin only)
  app.get('/api/test-shopee-offer', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/test-shopee-offer');
    const { itemId, shopId } = req.query || {};
    if (!itemId || typeof itemId !== 'string' || !itemId.trim()) {
      return res.status(400).json({ error: 'Vui lòng cung cấp tham số itemId hợp lệ.' });
    }
    const cleanItemId = itemId.trim();
    const cleanShopId = shopId ? String(shopId).trim() : '';

    const db = ensureDbLoaded();
    const s = db.settings;
    const appId = s.shopeeAppId || process.env.SHOPEE_APP_ID || '';
    const appSecret = s.shopeeAppSecret || process.env.SHOPEE_APP_SECRET || '';
    const addlivetagKey = (s.addlivetagApiKey || process.env.ADDLIVETAG_API_KEY || '').trim();

    const hasAppId = Boolean(appId);
    const hasAppSecret = Boolean(appSecret);
    const hasAddlivetagKey = Boolean(addlivetagKey);

    let openApiResult = null;
    let openApiError = null;
    if (hasAppId && hasAppSecret) {
      try {
        openApiResult = await fetchShopeeProductOffer(cleanItemId, appId, appSecret, cleanShopId);
      } catch (err) {
        openApiError = 'Không thể kết nối hoặc truy vấn Shopee Open API.';
      }
    }

    let addlivetagResult = null;
    let addlivetagError = null;
    if (hasAddlivetagKey) {
      try {
        addlivetagResult = await fetchAddlivetagProductData({
          platform: 'shopee',
          itemId: cleanItemId,
          apiKey: addlivetagKey
        });
      } catch (err) {
        addlivetagError = 'Không thể kết nối hoặc truy vấn AddLiveTag API.';
      }
    }

    logger.logLeave('GET /api/test-shopee-offer', {
      hasOpenApi: Boolean(openApiResult),
      hasAddlivetag: Boolean(addlivetagResult)
    });

    return res.json({
      ok: Boolean(openApiResult || addlivetagResult),
      hasAppId,
      hasAppSecret,
      hasAddlivetagKey,
      openApi: {
        status: openApiResult
          ? 'found'
          : hasAppId && hasAppSecret
          ? 'not_found'
          : 'no_credentials',
        meta: openApiResult,
        error: openApiError
      },
      addlivetag: {
        status: addlivetagResult ? 'found' : 'not_found',
        meta: addlivetagResult,
        error: addlivetagError
      },
      testedItem: { itemId, shopId }
    });
  }));

  // 8. Convert Link (Generates opaque random click_id -> maps to userId in db.clicks)
  app.post('/api/convert', convertLimiter, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/convert');
    try {
      const { text } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim() || text.length > 4000) {
        return res.status(400).json({
          error: 'Vui lòng dán link sản phẩm hợp lệ (tối đa 4000 ký tự).'
        });
      }

      const db = ensureDbLoaded();
      const s = db.settings;
      const authUser = getAuthUser(req);

      const DEFAULT_TIKTOK_DEEPLINK =
        'https://go.isclix.com/deep_link/v6/7110811489339796158/6648523843406889655?sub4=oneatweb';

      const effectiveConfig = {
        shopeeMode: process.env.SHOPEE_MODE || s.shopeeMode || 'an_redir',
        shopeeAffiliateId: process.env.SHOPEE_AFFILIATE_ID || s.shopeeAffiliateId || '17346310715',
        shopeeAppId: process.env.SHOPEE_APP_ID || s.shopeeAppId || '',
        shopeeAppSecret: process.env.SHOPEE_APP_SECRET || s.shopeeAppSecret || '',
        tiktokMode:
          process.env.TIKTOK_MODE ||
          (s.tiktokMode === 'clean_extract' ? 'deeplink' : s.tiktokMode) ||
          'deeplink',
        tiktokAppKey: process.env.TIKTOK_APP_KEY || s.tiktokAppKey || '',
        tiktokAppSecret: process.env.TIKTOK_APP_SECRET || s.tiktokAppSecret || '',
        tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || s.tiktokAccessToken || '',
        tiktokDeepLinkTemplate:
          process.env.TIKTOK_DEEPLINK_TEMPLATE ||
          s.tiktokDeepLinkTemplate ||
          DEFAULT_TIKTOK_DEEPLINK,
        addlivetagApiKey: (
          s.addlivetagApiKey ||
          process.env.ADDLIVETAG_API_KEY ||
          DEFAULT_ADDLIVETAG_API_KEY
        ).trim(),
        shortenerProvider: s.shortenerProvider || 'none'
      };

      const result = await convertTextLinks(text, effectiveConfig);
      const cashbackPercent = Number(s.cashbackPercent || 70);
      const taxDeductPercent = Number(s.taxDeductPercent ?? 10);

      for (const item of result.items) {
        item.cashbackPercent = cashbackPercent;
        // Never leak affiliateUrl + user sub_id to third-party QR image servers
        item.qrUrl = null;

        if (item.commission > 0 || (item.price > 0 && item.commissionRate > 0)) {
          const estGross =
            item.commission > 0
              ? Number(item.commission)
              : Math.round((item.price * item.commissionRate) / 100);
          const estSplit = calculateCommissionSplit(estGross, cashbackPercent, taxDeductPercent);
          item.estimatedCashback = estSplit.userCashbackAmount;
        } else {
          item.estimatedCashback = 0;
        }

        if (item.status === 'success' && item.clickId) {
          if (!Array.isArray(db.clicks)) {
            db.clicks = [];
          }
          const clickRecord = {
            clickId: item.clickId,
            userId: authUser ? authUser.id : null,
            userCode: authUser ? authUser.code : 'GUEST',
            platform: item.platform,
            originalUrl: item.originalUrl,
            cleanUrl: item.cleanUrl,
            productId: item.productId || null,
            affiliateUrl: item.affiliateUrl,
            createdAt: new Date().toISOString()
          };
          db.clicks.unshift(clickRecord);
          logger.log('POST /api/convert', 'Click recorded', {
            clickId: item.clickId,
            userCode: clickRecord.userCode,
            platform: item.platform
          });
        }
      }

      db.clicks = cleanExpiredClicks(db.clicks);
      await saveDb(db);

      logger.logLeave('POST /api/convert', { total: result.summary.total });
      return res.json({
        ...result,
        cashbackPercent,
        isLoggedIn: Boolean(authUser)
      });
    } catch (err) {
      logger.error('POST /api/convert', 'Convert error', { error: err.message });
      return res.status(500).json({ error: 'Đã có lỗi xảy ra trên hệ thống.' });
    }
  }));

  // 9. Vercel Cron & Webhook Postback Endpoints
  app.get('/api/cron/sync-shopee', asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/cron/sync-shopee');
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized Cron Request' });
    }
    if (isAutoSyncInFlight) {
      return res.status(429).json({ error: 'Đồng bộ đang được thực hiện (sync already in progress).' });
    }
    isAutoSyncInFlight = true;
    try {
      const out = await runAutoSyncAll({ requireAtLeastOne: false });
      return res.json({ status: 'ok', ...out });
    } catch (err) {
      logger.error('GET /api/cron/sync-shopee', 'Cron sync error', { error: err.message });
      return res.status(500).json({ error: 'Đã có lỗi xảy ra trên hệ thống.' });
    } finally {
      isAutoSyncInFlight = false;
    }
  }));

  // Official AccessTrade Real-Time Postback (Supports query macros, body, and header token)
  async function handleAccessTradePostback(req, res) {
    logger.logEnter('AccessTradePostback', { method: req.method });
    const db = ensureDbLoaded();

    const authResult = verifyWebhookRequest(req, db);
    if (!authResult.valid) {
      logger.warning('AccessTradePostback', 'Authentication failed', { error: authResult.error, status: authResult.status });
      return res.status(authResult.status).json({ error: authResult.error });
    }

    const src = req.method === 'GET' ? req.query : { ...(req.query || {}), ...(req.body || {}) };
    const orderSn =
      src.order_id || src.conversion_id || src.transaction_id || src.orderSn || '';
    if (!orderSn || String(orderSn).includes('{')) {
      // Respond 200 on AccessTrade test ping with literal macro placeholders
      logger.logLeave('AccessTradePostback', { testPing: true });
      return res.json({ status: 'ok', testPing: true });
    }

    const rawSubId = src.sub1 || src.utm_source || src.clickId || src.sub_id || '';
    const rawComm = Number(
      src.pub_commission ?? src.reward ?? src.commission ?? src.grossCommission ?? 0
    );
    const grossCommission = Number.isFinite(rawComm) && rawComm >= 0 ? rawComm : 0;

    const rawAmount = Number(
      src.billing ?? src.total_amount ?? src.amount ?? src.orderAmount ?? 0
    );
    const orderAmount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;

    const status = normalizeNetworkStatus(src.status ?? src.approval_status);
    const merchantRaw = String(src.merchant || src.platform || 'tiktok').toLowerCase();
    const platform = merchantRaw.includes('shopee') ? 'shopee' : 'tiktok';
    const productName = src.product_name || src.productName || '';

    const cleanSn = String(orderSn).trim().toUpperCase();
    const existing = db.orders.find((o) => String(o.orderSn || '').toUpperCase() === cleanSn);
    if (
      existing &&
      existing.status === status &&
      Math.round(Number(existing.grossCommission || 0)) === Math.round(grossCommission) &&
      Math.round(Number(existing.orderAmount || 0)) === Math.round(orderAmount)
    ) {
      logger.logLeave('AccessTradePostback', { orderSn: cleanSn, idempotent: true });
      return res.json({ status: 'ok', orderSn: cleanSn, idempotent: true });
    }

    try {
      let order;
      const cleanSub = String(rawSubId || '').split('-')[0].trim();
      const clickRecord = cleanSub ? db.clicks.find((c) => c.clickId === cleanSub) : null;
      const matchedUserId = clickRecord?.userId || db.users.find((u) => (u.code && String(u.code).toUpperCase() === cleanSub.toUpperCase()) || u.phone === cleanSub)?.id;
      const lockKey = matchedUserId || 'global';

      await withUserLock(lockKey, async () => {
        order = upsertNetworkOrder(db, {
          orderSn: cleanSn,
          rawSubId,
          grossCommission,
          orderAmount,
          status,
          platform,
          productName,
          eventTime: src.event_time || src.eventTime || src.timestamp,
          purchaseTime: src.purchase_time || src.purchaseTime
        });

        if (order?.userId) {
          recalculateUserWallet(order.userId, { persist: false });
        } else {
          recalculateAllWallets({ persist: false });
        }
        await saveDb(db);
      });

      logger.logLeave('AccessTradePostback', {
        orderSn: order?.orderSn,
        userCode: order?.userCode,
        status: order?.status
      });
      return res.json({
        status: 'ok',
        orderSn: order?.orderSn,
        userCode: order?.userCode
      });
    } catch (err) {
      logger.error('AccessTradePostback', 'Error processing postback', { error: err.message });
      return res.status(500).json({ error: 'Failed to process postback order.' });
    }
  }

  app.get('/api/webhooks/accesstrade', asyncHandler(handleAccessTradePostback));
  app.post('/api/webhooks/accesstrade', asyncHandler(handleAccessTradePostback));

  app.post('/api/webhooks/postback', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/webhooks/postback');
    const db = ensureDbLoaded();

    const authResult = verifyWebhookRequest(req, db);
    if (!authResult.valid) {
      logger.warning('POST /api/webhooks/postback', 'Authentication failed', { error: authResult.error, status: authResult.status });
      return res.status(authResult.status).json({ error: authResult.error });
    }

    const {
      orderSn,
      clickId,
      sub1,
      sub_id,
      grossCommission,
      pub_commission,
      status,
      platform,
      productName,
      orderAmount,
      billing
    } = req.body || {};
    if (!orderSn) return res.status(400).json({ error: 'Missing orderSn' });

    const rawComm = Number(grossCommission ?? pub_commission ?? 0);
    const validComm = Number.isFinite(rawComm) && rawComm >= 0 ? rawComm : 0;
    const rawBilling = Number(orderAmount ?? billing ?? 0);
    const validBilling = Number.isFinite(rawBilling) && rawBilling >= 0 ? rawBilling : 0;

    try {
      const cleanSub = String(clickId || sub1 || sub_id || '').split('-')[0].trim();
      const clickRecord = cleanSub ? db.clicks.find((c) => c.clickId === cleanSub) : null;
      const matchedUserId = clickRecord?.userId || db.users.find((u) => (u.code && String(u.code).toUpperCase() === cleanSub.toUpperCase()) || u.phone === cleanSub)?.id;
      const lockKey = matchedUserId || 'global';

      let order;
      await withUserLock(lockKey, async () => {
        order = upsertNetworkOrder(db, {
          orderSn,
          rawSubId: clickId || sub1 || sub_id || '',
          grossCommission: validComm,
          orderAmount: validBilling,
          status: normalizeNetworkStatus(status),
          platform,
          productName,
          eventTime: req.body?.eventTime || req.body?.event_time || req.body?.timestamp,
          purchaseTime: req.body?.purchaseTime || req.body?.purchase_time
        });

        if (order?.userId) {
          recalculateUserWallet(order.userId, { persist: false });
        } else {
          recalculateAllWallets({ persist: false });
        }
        await saveDb(db);
      });

      logger.logLeave('POST /api/webhooks/postback', { orderSn: order?.orderSn, status: order?.status });
      return res.json({ status: 'ok', orderSn: order?.orderSn });
    } catch (err) {
      logger.error('POST /api/webhooks/postback', 'Error saving postback', { error: err.message });
      return res.status(500).json({ error: 'Failed to process postback order.' });
    }
  }));

  // ================= ADMIN ENDPOINTS =================

  app.get('/api/admin/dashboard', asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/admin/dashboard');
    if (!requireAdmin(req, res)) return;

    await reloadStateFromPostgres();
    triggerLazyAutoSyncIfNeeded();
    const db = ensureDbLoaded();

    let totalGrossCommission = 0;
    let totalNetCommission = 0;
    let totalUserCashback = 0;
    let totalAdminProfit = 0;

    for (const o of db.orders) {
      if (o.status !== 'cancelled') {
        totalGrossCommission += Number(o.grossCommission || o.totalCommission || 0);
        totalNetCommission += Number(o.netCommission || o.totalCommission || 0);
        totalUserCashback += Number(o.userCashbackAmount || 0);
        totalAdminProfit += Number(o.adminShareAmount || 0);
      }
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.APP_HOST || 'hoantiensan.online';
    const postbackToken = getConfiguredPostbackToken(db);
    const postbackUrlTemplate = `${proto}://${host}/api/webhooks/accesstrade?token={SECRET_POSTBACK_TOKEN}&order_id={order_id}&sub1={sub1}&pub_commission={pub_commission}&billing={billing}&status={status}&merchant={merchant}`;

    // Allowlist safe settings before returning to client (including masked secrets)
    const SAFE_SETTING_KEYS = [
      'cashbackPercent',
      'taxDeductPercent',
      'minWithdrawAmount',
      'shopeeMode',
      'shopeeAffiliateId',
      'shopeeAppId',
      'tiktokMode',
      'tiktokAppKey',
      'tiktokDeepLinkTemplate',
      'shortenerProvider',
      'brandName',
      'contactPhone',
      'supportZalo',
      'supportFacebook',
      'announcementBanner',
      'lastAutoSyncAt'
    ];

    const safeSettings = {};
    for (const key of SAFE_SETTING_KEYS) {
      if (db.settings[key] !== undefined) {
        safeSettings[key] = db.settings[key];
      }
    }

    const isSuperAdmin = req.adminUser?.role === 'admin';
    const revealRequested = Boolean(
      req.query?.reveal === 'true' ||
      req.query?.revealSecrets === 'true' ||
      req.headers['x-reveal-secrets'] === 'true'
    );
    const shouldReveal = isSuperAdmin && revealRequested;

    safeSettings.postbackToken = shouldReveal ? (db.settings.postbackToken || postbackToken) : '***';
    safeSettings.shopeeAppSecret = shouldReveal ? (db.settings.shopeeAppSecret || process.env.SHOPEE_APP_SECRET || '') : '***';
    safeSettings.tiktokAppSecret = shouldReveal ? (db.settings.tiktokAppSecret || process.env.TIKTOK_APP_SECRET || '') : '***';
    safeSettings.turnstileSecretKey = shouldReveal ? (db.settings.turnstileSecretKey || process.env.TURNSTILE_SECRET_KEY || '') : '***';
    safeSettings.tiktokAccessToken = shouldReveal ? (db.settings.tiktokAccessToken || '') : '***';
    safeSettings.accesstradeApiKey = shouldReveal ? (db.settings.accesstradeApiKey || '') : '***';
    safeSettings.addlivetagApiKey = shouldReveal ? (db.settings.addlivetagApiKey || '') : '***';
    safeSettings.postbackUrlTemplate = postbackUrlTemplate;

    const ordersPageResult = await queryOrdersPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || '',
      status: req.query.orderStatus || '',
      platform: req.query.platform || ''
    });
    const withdrawalsPageResult = queryWithdrawalsPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || '',
      status: req.query.withdrawalStatus || ''
    });
    const usersPageResult = queryUsersPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || ''
    });

    return res.json({
      dbStatus: getDatabaseStatus(),
      stats: {
        totalUsers: db.users.length,
        totalOrders: db.orders.length,
        totalGrossCommission: Math.round(totalGrossCommission),
        totalCommission: Math.round(totalNetCommission),
        totalUserCashback: Math.round(totalUserCashback),
        totalAdminProfit: Math.round(totalAdminProfit),
        pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').length
      },
      settings: safeSettings,
      orders: ordersPageResult.items,
      withdrawals: withdrawalsPageResult.items,
      users: usersPageResult.items,
      clicks: db.clicks.slice(0, 50),
      pagination: {
        page: ordersPageResult.pagination.page,
        limit: ordersPageResult.pagination.limit,
        totalOrders: ordersPageResult.pagination.total,
        totalUsers: usersPageResult.pagination.total,
        totalWithdrawals: withdrawalsPageResult.pagination.total,
        ordersTotalPages: ordersPageResult.pagination.totalPages,
        usersTotalPages: usersPageResult.pagination.totalPages,
        withdrawalsTotalPages: withdrawalsPageResult.pagination.totalPages
      }
    });
  }));

  // Dedicated server-side paginated & searchable admin endpoints
  app.get('/api/admin/orders', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/admin/orders');
    await reloadStateFromPostgres();
    const db = ensureDbLoaded();
    const result = await queryOrdersPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || '',
      status: req.query.status || '',
      platform: req.query.platform || '',
      preferSql: req.query.preferSql === 'true'
    });
    logger.logLeave('GET /api/admin/orders', {
      page: result.pagination.page,
      total: result.pagination.total
    });
    return res.json({ orders: result.items, pagination: result.pagination });
  }));

  app.get('/api/admin/users', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/admin/users');
    await reloadStateFromPostgres();
    const db = ensureDbLoaded();
    const result = queryUsersPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || '',
      includeDeleted: req.query.includeDeleted === 'true'
    });
    logger.logLeave('GET /api/admin/users', {
      page: result.pagination.page,
      total: result.pagination.total
    });
    return res.json({ users: result.items, pagination: result.pagination });
  }));

  app.get('/api/admin/withdrawals', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/admin/withdrawals');
    await reloadStateFromPostgres();
    const db = ensureDbLoaded();
    const result = queryWithdrawalsPaginated(db, {
      page: req.query.page || 1,
      limit: req.query.limit || 50,
      q: req.query.q || '',
      status: req.query.status || ''
    });
    logger.logLeave('GET /api/admin/withdrawals', {
      page: result.pagination.page,
      total: result.pagination.total
    });
    return res.json({ withdrawals: result.items, pagination: result.pagination });
  }));

  // Reveal raw postback URL on explicit admin request
  app.get('/api/admin/reveal-postback-url', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const db = ensureDbLoaded();
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'hoantienshop.vercel.app';
    const postbackToken = getConfiguredPostbackToken(db);
    const fullUrl = `${proto}://${host}/api/webhooks/accesstrade?token=${encodeURIComponent(
      postbackToken
    )}&order_id={order_id}&sub1={sub1}&pub_commission={pub_commission}&billing={billing}&status={status}&merchant={merchant}`;
    return res.json({ postbackUrl: fullUrl });
  });

  app.post('/api/admin/sync-shopee', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/sync-shopee');
    if (!requireAdmin(req, res)) return;
    try {
      const out = await runAutoSyncAll({ requireAtLeastOne: true });
      return res.json(out);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }));

  app.get('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('GET /api/admin/settings');
    const db = ensureDbLoaded();
    migrateZaloSettings(db);
    const postbackToken = getConfiguredPostbackToken(db);
    const isSuperAdmin = req.adminUser?.role === 'admin';
    const revealRequested = Boolean(
      req.query?.reveal === 'true' ||
      req.query?.revealSecrets === 'true' ||
      req.headers['x-reveal-secrets'] === 'true'
    );
    const shouldReveal = isSuperAdmin && revealRequested;

    const safeSettings = { ...db.settings };
    safeSettings.zaloGroupUrl = db.settings.zaloGroupUrl || DEFAULT_ZALO_GROUP_URL;
    safeSettings.zaloWidgetEnabled = db.settings.zaloWidgetEnabled ?? true;
    safeSettings.postbackToken = shouldReveal ? (db.settings.postbackToken || postbackToken) : '***';
    safeSettings.shopeeAppSecret = shouldReveal ? (db.settings.shopeeAppSecret || process.env.SHOPEE_APP_SECRET || '') : '***';
    safeSettings.tiktokAppSecret = shouldReveal ? (db.settings.tiktokAppSecret || process.env.TIKTOK_APP_SECRET || '') : '***';
    safeSettings.turnstileSecretKey = shouldReveal ? (db.settings.turnstileSecretKey || process.env.TURNSTILE_SECRET_KEY || '') : '***';

    logger.logLeave('GET /api/admin/settings');
    return res.json({ settings: safeSettings });
  }));

  app.post('/api/admin/settings', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/settings');
    if (!requireAdmin(req, res)) return;

    const db = ensureDbLoaded();
    const body = req.body || {};

    const textKeys = [
      'siteName',
      'shopeeMode',
      'shopeeAffiliateId',
      'shopeeAppId',
      'tiktokMode',
      'tiktokAppKey',
      'tiktokDeepLinkTemplate',
      'shortenerProvider',
      'supportZalo'
    ];

    for (const key of textKeys) {
      if (body[key] !== undefined) {
        db.settings[key] = String(body[key] || '').trim();
      }
    }

    if (body.zaloGroupUrl !== undefined) {
      const rawZalo = String(body.zaloGroupUrl || '').trim();
      if (rawZalo) {
        if (!isValidZaloGroupUrl(rawZalo)) {
          return res.status(400).json({ error: 'Đường dẫn nhóm Zalo không hợp lệ. Phải là đường dẫn HTTPS đến zalo.me.' });
        }
        db.settings.zaloGroupUrl = normalizeZaloTarget(rawZalo);
      } else {
        db.settings.zaloGroupUrl = '';
      }
    }

    if (body.zaloWidgetEnabled !== undefined) {
      db.settings.zaloWidgetEnabled = Boolean(body.zaloWidgetEnabled);
    }

    if (body.zaloGroupUrl === undefined) {
      migrateZaloSettings(db);
    }

    // Strict finite numeric validation to prevent NaN contamination
    if (body.cashbackPercent !== undefined) {
      const v = Number(body.cashbackPercent);
      if (!Number.isFinite(v) || v < 1 || v > 100) {
        return res.status(400).json({ error: 'Tỷ lệ hoàn tiền (cashbackPercent) phải là số từ 1% đến 100%.' });
      }
      db.settings.cashbackPercent = Math.round(v);
    }

    if (body.taxDeductPercent !== undefined) {
      const v = Number(body.taxDeductPercent);
      if (!Number.isFinite(v) || v < 0 || v > 50) {
        return res.status(400).json({ error: 'Thuế khấu trừ (taxDeductPercent) phải là số từ 0% đến 50%.' });
      }
      db.settings.taxDeductPercent = Math.round(v);
    }

    if (body.minWithdrawAmount !== undefined) {
      const v = Number(body.minWithdrawAmount);
      if (!Number.isFinite(v) || v < 10000 || v > 100000000) {
        return res.status(400).json({ error: 'Hạn mức rút tiền tối thiểu phải là số từ 10.000đ đến 100.000.000đ.' });
      }
      db.settings.minWithdrawAmount = Math.round(v);
    }

    if (body.referralBonusPercent !== undefined) {
      const v = Number(body.referralBonusPercent);
      if (!Number.isFinite(v) || v < 0 || v > 20) {
        return res.status(400).json({ error: 'Thưởng giới thiệu (referralBonusPercent) phải là số từ 0% đến 20%.' });
      }
      db.settings.referralBonusPercent = Math.round(v);
    }

    if (body.referralBountyAmount !== undefined) {
      const v = Number(body.referralBountyAmount);
      if (!Number.isFinite(v) || v < 0 || v > 1000000) {
        return res.status(400).json({ error: 'Thưởng giới thiệu đơn đầu (referralBountyAmount) phải từ 0đ đến 1.000.000đ.' });
      }
      db.settings.referralBountyAmount = Math.round(v);
    }

    // Only update secret fields if not masked placeholder
    const secretKeys = [
      'shopeeAppSecret',
      'tiktokAppSecret',
      'tiktokAccessToken',
      'accesstradeApiKey',
      'addlivetagApiKey',
      'turnstileSecretKey',
      'postbackToken'
    ];
    for (const sKey of secretKeys) {
      if (body[sKey] && body[sKey] !== '********' && body[sKey] !== '***' && !body[sKey].startsWith('***')) {
        db.settings[sKey] = String(body[sKey]).trim();
      }
    }

    if (body.newAdminPassword) {
      const cleanNewPass = String(body.newAdminPassword).trim();
      if (cleanNewPass.length < 6) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
      }
      const adminUser = req.adminUser || db.users.find((u) => u.role === 'admin');
      if (!adminUser) {
        return res.status(400).json({ error: 'Không tìm thấy tài khoản quản trị viên.' });
      }
      if (!body.currentPassword || !(await verifyPasswordAsync(body.currentPassword, adminUser.passwordHash))) {
        return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng hoặc chưa được cung cấp.' });
      }
      adminUser.passwordHash = await hashPasswordAsync(cleanNewPass);
      adminUser.tokenVersion = Number(adminUser.tokenVersion || 1) + 1;
    }

    recordAuditLog(db, {
      adminId: req.adminUser?.id || 'admin',
      adminName: req.adminUser?.name || 'Quản Trị Viên',
      action: 'update_settings',
      targetId: 'settings',
      details: {
        keysUpdated: Object.keys(body).filter((k) => k !== 'currentPassword' && k !== 'newAdminPassword'),
        passwordChanged: Boolean(body.newAdminPassword)
      }
    });

    await saveDb(db);
    logger.logLeave('POST /api/admin/settings');
    return res.json({ status: 'ok' });
  }));

  app.post('/api/admin/orders', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/orders');
    const admin = req.adminUser;

    const db = ensureDbLoaded();
    const {
      id,
      orderSn,
      platform,
      userCode,
      productName,
      orderAmount,
      totalCommission,
      userCashbackAmount,
      status
    } = req.body || {};

    if (!orderSn) {
      return res.status(400).json({ error: 'Thiếu Mã đơn hàng (orderSn).' });
    }

    const cleanOrderSn = String(orderSn).trim().toUpperCase();
    if (cleanOrderSn.length < 4 || cleanOrderSn.length > 64) {
      return res.status(400).json({ error: 'Mã đơn hàng không hợp lệ (từ 4 đến 64 ký tự).' });
    }

    if (platform !== undefined && platform !== null && platform !== '') {
      const p = String(platform).toLowerCase();
      if (p !== 'shopee' && p !== 'tiktok') {
        return res.status(400).json({ error: 'Nền tảng đơn hàng không hợp lệ (shopee hoặc tiktok).' });
      }
    }
    const validPlatform = String(platform || '').toLowerCase() === 'tiktok' ? 'tiktok' : 'shopee';

    if (status !== undefined && status !== null && status !== '') {
      if (!['pending', 'approved', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Trạng thái đơn hàng không hợp lệ (pending, approved, cancelled).' });
      }
    }
    const validStatus = ['pending', 'approved', 'cancelled'].includes(status) ? status : 'pending';

    if (orderAmount !== undefined && orderAmount !== null && orderAmount !== '') {
      const rawOrderAmt = Number(orderAmount);
      if (!Number.isFinite(rawOrderAmt) || rawOrderAmt < 0) {
        return res.status(400).json({ error: 'Giá trị đơn hàng (orderAmount) phải là số hữu hạn không âm.' });
      }
    }
    const rawOrderAmt = Number(orderAmount);
    const validOrderAmt = Number.isFinite(rawOrderAmt) && rawOrderAmt >= 0 ? rawOrderAmt : 0;

    const hasTotalCommission = totalCommission !== undefined && totalCommission !== null && totalCommission !== '';
    if (hasTotalCommission) {
      const rawComm = Number(totalCommission);
      if (!Number.isFinite(rawComm) || rawComm < 0) {
        return res.status(400).json({ error: 'Hoa hồng (totalCommission) phải là số hữu hạn không âm.' });
      }
    }
    const rawComm = hasTotalCommission ? Number(totalCommission) : 0;
    const validComm = Number.isFinite(rawComm) && rawComm >= 0 ? rawComm : 0;

    let targetOrder = db.orders.find(
      (o) =>
        (id && o.id === id) ||
        String(o.orderSn || '').toUpperCase() === cleanOrderSn
    );
    const targetOrderExisted = Boolean(targetOrder);

    const cbRateToUse = targetOrder?.lockedCashbackRate ?? db.settings.cashbackPercent;
    const taxRateToUse = targetOrder?.lockedTaxRate ?? db.settings.taxDeductPercent;
    const split = calculateCommissionSplit(
      validComm,
      cbRateToUse,
      taxRateToUse
    );

    const rawCode = String(userCode || 'ADMIN').trim();
    // Match either by clickId in db.clicks OR by user code / phone
    const matchedClick = db.clicks.find((c) => c.clickId === rawCode);
    const matchedUser = matchedClick?.userId
      ? db.users.find((u) => u.id === matchedClick.userId)
      : db.users.find(
          (u) =>
            (u.code && String(u.code).toUpperCase() === rawCode.toUpperCase()) ||
            String(u.phone || '').trim() === rawCode ||
            (normalizePhoneNumber(u.phone) && normalizePhoneNumber(u.phone) === normalizePhoneNumber(rawCode))
        );

    // Validation phase BEFORE any mutation to targetOrder
    const isProvidedCustom = userCashbackAmount !== undefined && userCashbackAmount !== null && String(userCashbackAmount).trim() !== '';
    let isExplicitPositiveCustom = false;
    let finalCustomVal = null;

    if (isProvidedCustom) {
      const rawCustom = Number(userCashbackAmount);
      if (!Number.isFinite(rawCustom) || rawCustom < 0) {
        return res.status(400).json({ error: 'Tiền hoàn tùy chỉnh phải là số hợp lệ không âm.' });
      }
      if (rawCustom > 0) {
        const effectiveNet = hasTotalCommission
          ? split.netCommission
          : Number(targetOrder?.netCommission || targetOrder?.grossCommission || 0);
        if (rawCustom > effectiveNet) {
          return res.status(400).json({
            error: `Tiền hoàn tùy chỉnh (${Math.round(rawCustom).toLocaleString('vi-VN')}đ) không được vượt quá hoa hồng thực nhận sau thuế (${effectiveNet.toLocaleString('vi-VN')}đ).`
          });
        }
        isExplicitPositiveCustom = true;
        finalCustomVal = Math.round(rawCustom);
      }
    }

    if (targetOrder) {
      if (targetOrder.lockedCashbackRate === undefined || targetOrder.lockedCashbackRate === null) {
        targetOrder.lockedCashbackRate = targetOrder.cashbackRate ?? split.cashbackRate;
      }
      if (targetOrder.lockedTaxRate === undefined || targetOrder.lockedTaxRate === null) {
        targetOrder.lockedTaxRate = split.taxDeductPercent;
      }

      targetOrder.orderSn = cleanOrderSn;
      targetOrder.platform = validPlatform;
      if (userCode) {
        targetOrder.userCode = matchedUser ? matchedUser.code : rawCode.toUpperCase();
        targetOrder.userId = matchedUser ? matchedUser.id : targetOrder.userId;
      }
      if (productName) targetOrder.productName = String(productName).slice(0, 150);
      if (orderAmount !== undefined && orderAmount !== null && orderAmount !== '') {
        targetOrder.orderAmount = validOrderAmt;
      }

      if (hasTotalCommission) {
        targetOrder.grossCommission = split.grossCommission;
        targetOrder.taxAmount = split.taxAmount;
        targetOrder.netCommission = split.netCommission;
        targetOrder.totalCommission = split.netCommission;
        targetOrder.cashbackRate = split.cashbackRate;
      }

      if (isExplicitPositiveCustom) {
        targetOrder.userCashbackAmount = finalCustomVal;
        targetOrder.hasCustomCashback = true;
      } else if (!isProvidedCustom) {
        // Modal order edit: if userCashbackAmount is undefined, null, or empty string,
        // do NOT set hasCustomCashback = true and do not reset cashback to 0!
        if (hasTotalCommission && !targetOrder.hasCustomCashback) {
          targetOrder.userCashbackAmount = split.userCashbackAmount;
        }
      } else {
        // Explicitly 0: do not set custom cashback
        if (hasTotalCommission) {
          targetOrder.userCashbackAmount = split.userCashbackAmount;
          targetOrder.hasCustomCashback = false;
        }
      }

      targetOrder.adminShareAmount = Math.max(
        0,
        Number(targetOrder.netCommission || targetOrder.grossCommission || 0) - Number(targetOrder.userCashbackAmount || 0)
      );

      if (status) {
        targetOrder.status = validStatus;
        targetOrder.statusSource = 'admin';
        targetOrder.statusUpdatedAt = new Date().toISOString();
      }
      targetOrder.updatedAt = new Date().toISOString();
    } else {
      let finalCashback = split.userCashbackAmount;
      let isCustom = false;
      if (isExplicitPositiveCustom) {
        finalCashback = finalCustomVal;
        isCustom = true;
      }

      targetOrder = {
        id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        orderSn: cleanOrderSn,
        platform: validPlatform,
        clickId: matchedClick ? matchedClick.clickId : null,
        userCode: matchedUser ? matchedUser.code : rawCode.toUpperCase(),
        userId: matchedUser ? matchedUser.id : null,
        productName: productName ? String(productName).slice(0, 150) : `Đơn hàng #${cleanOrderSn}`,
        orderAmount: validOrderAmt,
        grossCommission: split.grossCommission,
        taxAmount: split.taxAmount,
        netCommission: split.netCommission,
        totalCommission: split.netCommission,
        cashbackRate: split.cashbackRate,
        lockedCashbackRate: split.cashbackRate,
        lockedTaxRate: split.taxDeductPercent,
        userCashbackAmount: finalCashback,
        adminShareAmount: Math.max(0, split.netCommission - finalCashback),
        status: validStatus,
        statusSource: 'admin',
        hasCustomCashback: isCustom,
        createdAt: new Date().toISOString(),
        statusUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.orders.unshift(targetOrder);
    }

    recordAuditLog(db, {
      adminId: admin?.id || 'admin',
      adminName: admin?.name || admin?.phone || admin?.code || 'Admin',
      action: targetOrderExisted ? 'update_order' : 'create_order',
      targetId: targetOrder.id,
      details: {
        orderSn: targetOrder.orderSn,
        status: targetOrder.status,
        userCashbackAmount: targetOrder.userCashbackAmount,
        hasCustomCashback: targetOrder.hasCustomCashback
      }
    });

    const lockKey = targetOrder?.userId || matchedUser?.id || 'global';
    await withUserLock(lockKey, async () => {
      recalculateAllWallets({ persist: false });
      await saveDb(db);
    });

    logger.logLeave('POST /api/admin/orders', { orderSn: targetOrder.orderSn, status: targetOrder.status, cashback: targetOrder.userCashbackAmount });
    return res.json({ order: targetOrder });
  }));

  // Admin Delete Order
  app.post('/api/admin/orders/delete', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/orders/delete');
    if (!requireAdmin(req, res)) return;

    const { id, orderSn } = req.body || {};
    if (!id && !orderSn) {
      return res.status(400).json({ error: 'Thiếu ID hoặc Mã đơn hàng để xóa.' });
    }

    const db = ensureDbLoaded();
    const preliminary = db.orders.find(
      (o) =>
        (id && o.id === id) ||
        (orderSn && String(o.orderSn || '').toUpperCase() === String(orderSn).trim().toUpperCase())
    );
    if (!preliminary) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng cần xóa.' });
    }

    const lockKey = preliminary.userId || 'global';
    const deletedOrder = await withUserLock(lockKey, async () => {
      const idx = db.orders.findIndex(
        (o) =>
          (id && o.id === id) ||
          (orderSn && String(o.orderSn || '').toUpperCase() === String(orderSn).trim().toUpperCase())
      );
      if (idx === -1) return null;

      const [removed] = db.orders.splice(idx, 1);
      recordAuditLog(db, {
        adminId: req.adminUser?.id || 'admin',
        adminName: req.adminUser?.name || 'Quản Trị Viên',
        action: 'delete_order',
        targetId: removed.id,
        details: { orderSn: removed.orderSn, previousStatus: removed.status, userId: removed.userId || null }
      });
      if (removed.userId) {
        recalculateUserWallet(removed.userId, { persist: false });
      }
      recalculateAllWallets({ persist: false });
      await saveDb(db);
      return removed;
    });

    if (!deletedOrder) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng cần xóa.' });
    }

    logger.logLeave('POST /api/admin/orders/delete', { orderSn: deletedOrder.orderSn });
    return res.json({ status: 'ok', message: `Đã xóa đơn hàng #${deletedOrder.orderSn} thành công!` });
  }));

  // Admin CSV Import (Payload limit 200kb, max 500 rows per batch)
  app.post('/api/admin/import-orders', express.json({ limit: '200kb' }), asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/import-orders');
    if (!requireAdmin(req, res)) return;

    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Không có dữ liệu đơn hàng để nhập.' });
    }

    if (rows.length > 500) {
      return res.status(400).json({ error: 'Mỗi lần nhập tối đa 500 dòng để đảm bảo hiệu năng máy chủ.' });
    }

    const db = ensureDbLoaded();
    let importedCount = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r !== 'object') {
        errors.push(`Dòng ${i + 1}: Dữ liệu không hợp lệ.`);
        continue;
      }
      const orderSn = String(r.orderSn || '').trim().toUpperCase();
      if (!orderSn) {
        errors.push(`Dòng ${i + 1}: Thiếu mã đơn hàng.`);
        continue;
      }

      try {
        upsertNetworkOrder(db, {
          orderSn,
          rawSubId: r.userCode || r.sub1 || '',
          grossCommission: r.totalCommission,
          orderAmount: r.orderAmount,
          status: normalizeNetworkStatus(r.status),
          platform: r.platform,
          productName: r.productName
        });
        importedCount++;
      } catch (err) {
        errors.push(`Đơn #${orderSn}: ${err.message}`);
      }
    }

    recalculateAllWallets({ persist: false });
    await saveDb(db);
    logger.logLeave('POST /api/admin/import-orders', { importedCount, errorCount: errors.length });
    return res.json({ importedCount, errors });
  }));

  app.post('/api/admin/withdrawals/update', requireAdmin, asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/withdrawals/update');
    const admin = req.adminUser;

    const { id, status } = req.body || {};
    const ALLOWED_WITHDRAWAL_STATUSES = ['paid', 'rejected'];
    if (!ALLOWED_WITHDRAWAL_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Trạng thái rút tiền không hợp lệ. Chỉ chấp nhận duyệt: paid hoặc rejected.`
      });
    }

    const db = ensureDbLoaded();
    const wd = db.withdrawals.find((w) => w.id === id);
    if (!wd) {
      return res.status(404).json({ error: 'Không tìm thấy yêu cầu rút tiền.' });
    }

    if (wd.status === 'paid') {
      return res.status(400).json({ error: 'Lệnh rút tiền đã chi trả thành công, không thể thay đổi trạng thái.' });
    }
    if (wd.status === 'rejected') {
      return res.status(400).json({ error: 'Lệnh rút tiền đã bị từ chối trước đó, không thể thay đổi lại.' });
    }

    if (status === 'rejected') {
      await refundWithdrawal(db, wd, admin);
      recordAuditLog(db, {
        adminId: admin?.id || 'admin',
        adminName: admin?.name || admin?.phone || admin?.code || 'Admin',
        action: 'update_withdrawal',
        targetId: wd.id,
        details: { status: 'rejected', amount: wd.amount, userCode: wd.userCode }
      });
      logger.logLeave('POST /api/admin/withdrawals/update', { id, status: 'rejected' });
      return res.json({ withdrawal: wd });
    }

    await withUserLock(wd.userId, async () => {
      if (wd.status === 'paid') {
        const err = new Error('Lệnh rút tiền đã chi trả thành công, không thể thay đổi trạng thái.');
        err.status = 400;
        throw err;
      }
      if (wd.status === 'rejected') {
        const err = new Error('Lệnh rút tiền đã bị từ chối trước đó, không thể thay đổi lại.');
        err.status = 400;
        throw err;
      }
      wd.status = 'paid';
      wd.processedAt = new Date().toISOString();
      wd.processedByAdminId = admin?.id || null;
      wd.processedByAdmin = admin?.username || 'admin';
      recalculateUserWallet(wd.userId, { persist: false });
      await saveDb(db);
    });

    recordAuditLog(db, {
      adminId: admin?.id || 'admin',
      adminName: admin?.name || admin?.phone || admin?.code || 'Admin',
      action: 'update_withdrawal',
      targetId: wd.id,
      details: { status: 'paid', amount: wd.amount, userCode: wd.userCode }
    });

    logger.logLeave('POST /api/admin/withdrawals/update', { id, status: 'paid' });
    return res.json({ withdrawal: wd });
  }));

  // Admin Cancel Withdrawal (Unified refund handler, only allows cancelling pending withdrawals)
  const handleCancelWithdrawal = asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/withdrawals/cancel');
    const admin = req.adminUser;

    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: 'Thiếu ID lệnh rút tiền cần hủy.' });
    }

    const db = ensureDbLoaded();
    const wd = db.withdrawals.find((w) => w.id === id);
    if (!wd) {
      return res.status(404).json({ error: 'Không tìm thấy lệnh rút tiền.' });
    }

    if (wd.status === 'paid') {
      return res.status(400).json({
        error: 'Không thể hủy lệnh rút tiền đã chi trả thành công để bảo toàn sổ cái tài chính.'
      });
    }

    if (wd.status !== 'pending') {
      return res.status(400).json({
        error: `Chỉ có thể hủy lệnh rút tiền đang ở trạng thái pending (chờ duyệt). Trạng thái hiện tại: ${wd.status}.`
      });
    }

    await refundWithdrawal(db, wd, admin);

    recordAuditLog(db, {
      adminId: admin?.id || 'admin',
      adminName: admin?.name || admin?.phone || admin?.code || 'Admin',
      action: 'cancel_withdrawal',
      targetId: wd.id,
      details: { status: 'cancelled', amount: wd.amount, userCode: wd.userCode }
    });

    logger.logLeave('POST /api/admin/withdrawals/cancel', { id });
    return res.json({ status: 'ok', message: `Đã hủy và hoàn tiền lệnh rút #${id} thành công!`, withdrawal: wd });
  });

  app.post('/api/admin/withdrawals/cancel', requireAdmin, handleCancelWithdrawal);
  app.post('/api/admin/withdrawals/delete', requireAdmin, handleCancelWithdrawal);

  // Admin User Management Action (Reset password, Lock/Unlock, Adjust balance, Reset balance, Delete)
  app.post('/api/admin/users/action', asyncHandler(async (req, res) => {
    logger.logEnter('POST /api/admin/users/action');
    if (!requireAdmin(req, res)) return;

    const { userId, action, newPassword, amount, note } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Thiếu ID người dùng.' });

    const admin = req.adminUser || getAuthUser(req);
    const adminId = admin?.id || 'admin';
    const adminName = admin?.name || admin?.phone || admin?.code || 'Admin';

    const db = ensureDbLoaded();
    const targetUser = db.users.find((u) => u.id === userId);
    if (!targetUser) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });

    if (action === 'reset_balance') {
      let currentAvailable = 0;
      await withUserLock(targetUser.id, async () => {
        recalculateUserWallet(targetUser.id, { persist: false });
        currentAvailable = Number(targetUser.balanceAvailable || 0);
        if (currentAvailable !== 0) {
          const refId = `admin_reset_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          appendLedgerEntry(
            targetUser.id,
            'admin_adjustment',
            -currentAvailable,
            refId,
            'Quản trị viên đặt lại số dư về 0đ'
          );
        }
        recalculateUserWallet(targetUser.id, { persist: false });
        await saveDb(db);
      });
      recordAuditLog(db, {
        adminId,
        adminName,
        action: 'reset_balance',
        targetId: targetUser.id,
        details: { userCode: targetUser.code, previousBalance: currentAvailable }
      });
      logger.logLeave('POST /api/admin/users/action', { action, userCode: targetUser.code });
      return res.json({
        status: 'ok',
        message: `Đã đặt số dư khả dụng của ${targetUser.code} về 0đ thành công!`
      });
    }

    if (action === 'reset_password') {
      if (!newPassword || String(newPassword).trim().length < 6) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' });
      }
      targetUser.passwordHash = await hashPasswordAsync(String(newPassword).trim());
      targetUser.tokenVersion = Number(targetUser.tokenVersion || 1) + 1;
      await saveDb(db);
      recordAuditLog(db, {
        adminId,
        adminName,
        action: 'reset_password',
        targetId: targetUser.id,
        details: { userCode: targetUser.code }
      });
      logger.logLeave('POST /api/admin/users/action', { action, userCode: targetUser.code });
      return res.json({ status: 'ok', message: `Đã đổi mật khẩu cho ${targetUser.code} thành công!` });
    }

    if (action === 'toggle_lock') {
      if (targetUser.role === 'admin') {
        return res.status(400).json({ error: 'Không thể khóa tài khoản Quản trị viên tối cao.' });
      }
      targetUser.accountLocked = !targetUser.accountLocked;
      targetUser.tokenVersion = Number(targetUser.tokenVersion || 1) + 1;
      await saveDb(db);
      recordAuditLog(db, {
        adminId,
        adminName,
        action: 'toggle_lock',
        targetId: targetUser.id,
        details: { userCode: targetUser.code, accountLocked: targetUser.accountLocked }
      });
      const msg = targetUser.accountLocked
        ? `Đã khóa tài khoản ${targetUser.code} (chặn đăng nhập & rút tiền)!`
        : `Đã mở khóa tài khoản cho ${targetUser.code}!`;
      logger.logLeave('POST /api/admin/users/action', { action, locked: targetUser.accountLocked });
      return res.json({ status: 'ok', accountLocked: targetUser.accountLocked, message: msg });
    }

    if (action === 'adjust_balance') {
      const rawAmt = Number(amount);
      if (!Number.isFinite(rawAmt) || isNaN(rawAmt) || rawAmt === Infinity || rawAmt === -Infinity || rawAmt === 0 || Math.abs(rawAmt) > 1000000000) {
        return res.status(400).json({
          error: 'Số tiền điều chỉnh không hợp lệ (phải là số hữu hạn, khác 0 và trong khoảng ±1 tỷ đ).'
        });
      }
      const num = Math.round(rawAmt);

      await withUserLock(targetUser.id, async () => {
        const refId = `admin_adj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        appendLedgerEntry(
          targetUser.id,
          'admin_adjustment',
          num,
          refId,
          String(note || `Điều chỉnh từ Quản trị viên (${adminName})`).trim().slice(0, 100)
        );
        recalculateUserWallet(targetUser.id, { persist: false });
        await saveDb(db);
      });

      recordAuditLog(db, {
        adminId,
        adminName,
        action: 'adjust_balance',
        targetId: targetUser.id,
        details: { userCode: targetUser.code, amount: num, note }
      });

      logger.log('admin_audit', `Admin ${adminName} adjusted balance of ${targetUser.code} by ${num}`, {
        adminId,
        targetUserId: targetUser.id,
        amount: num
      });
      logger.logLeave('POST /api/admin/users/action', { action, amount: num });
      return res.json({
        status: 'ok',
        message: `Đã ghi nhận ${num > 0 ? '+' : ''}${num.toLocaleString('vi-VN')}đ vào Sổ cái của ${targetUser.code}!`
      });
    }

    if (action === 'delete') {
      if (targetUser.role === 'admin') {
        return res.status(400).json({ error: 'Không thể xóa tài khoản Quản trị viên tối cao.' });
      }

      // Check if user has financial history (orders, withdrawals, ledger)
      const hasOrders = db.orders.some((o) => o.userId === userId);
      const hasWithdrawals = db.withdrawals.some((w) => w.userId === userId);
      const hasLedger = db.ledger.some((l) => l.userId === userId);

      const adminCode = admin?.phone || admin?.code || 'admin';

      if (hasOrders || hasWithdrawals || hasLedger) {
        // Soft-delete to preserve ledger immutability and financial accounting audit trails
        targetUser.accountLocked = true;
        targetUser.isDeleted = true;
        targetUser.deletedAt = new Date().toISOString();
        targetUser.deletedByAdminId = adminId;
        targetUser.tokenVersion = Number(targetUser.tokenVersion || 1) + 1;
        targetUser.phone = `DELETED_${Date.now()}_${String(targetUser.phone || '')}`;
        await saveDb(db);
        recordAuditLog(db, {
          adminId,
          adminName,
          action: 'soft_delete',
          targetId: targetUser.id,
          details: { userCode: targetUser.code, reason: 'Has financial records' }
        });
        logger.log('admin_audit', `Admin ${adminCode} soft-deleted user ${targetUser.code} (retained for ledger audit)`, {
          adminId,
          targetUserId: targetUser.id
        });
        logger.logLeave('POST /api/admin/users/action', { action: 'soft_delete', userId });
        return res.json({
          status: 'ok',
          message: `Đã vô hiệu hóa và chuyển tài khoản ${targetUser.code} vào lưu trữ bảo toàn sổ cái kiểm toán!`
        });
      }

      // If user has zero financial records, safe to hard delete
      db.users = db.users.filter((u) => u.id !== userId);
      await saveDb(db);
      recordAuditLog(db, {
        adminId,
        adminName,
        action: 'delete',
        targetId: userId,
        details: { userCode: targetUser.code }
      });
      logger.log('admin_audit', `Admin ${adminCode} permanently deleted empty user ${targetUser.code}`, {
        adminId,
        targetUserId: targetUser.id
      });
      logger.logLeave('POST /api/admin/users/action', { action: 'delete', userId });
      return res.json({ status: 'ok', message: `Đã xóa tài khoản ${targetUser.code} thành công!` });
    }

    return res.status(400).json({ error: 'Thao tác không hợp lệ.' });
  }));

  // Centralized express error handler
  app.use((err, req, res, _next) => {
    logger.error('express', 'Lỗi xử lý request chưa bắt', {
      path: req.path,
      method: req.method,
      error: err.message
    });
    if (res.headersSent) return;
    const status = err.httpStatus || err.status || 500;
    const message = status >= 500
      ? 'Đã có lỗi xảy ra trên hệ thống.'
      : (err.publicMessage || err.message);
    return res.status(status).json({ error: message });
  });

  // Periodic background auto-sync every 15 minutes on persistent server (Singleton timer)
  if (!process.env.VERCEL && !globalSyncTimer) {
    globalSyncTimer = setInterval(() => {
      triggerLazyAutoSyncIfNeeded();
    }, 15 * 60 * 1000);
    if (typeof globalSyncTimer.unref === 'function') globalSyncTimer.unref();
  }
}

module.exports = {
  registerCashbackRoutes,
  refundWithdrawal,
  AppError,
  upsertNetworkOrder,
  canTransitionOrderStatus,
  normalizeNetworkStatus,
  verifyWebhookRequest,
  getConfiguredPostbackToken,
  parseShopeeReportNodes,
  runShopeeAutoSync,
  sanitizeFiniteNumber,
  sanitizeOrderForUser,
  triggerLazyAutoSyncIfNeeded,
  normalizePhoneNumber
};
