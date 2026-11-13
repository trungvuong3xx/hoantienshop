const crypto = require('crypto');
const express = require('express');
const logger = require('../utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  initPostgresIfConfigured,
  hashPassword,
  verifyPassword,
  calculateCommissionSplit,
  recalculateUserWallet,
  recalculateAllWallets,
  executeAtomicWithdrawal,
  appendLedgerEntry,
  auditLedgerIntegrity,
  createToken,
  verifyToken,
  sanitizeUser,
  getDatabaseStatus,
  reloadStateFromPostgres
} = require('./dbService');
const { convertTextLinks } = require('./converterService');
const {
  fetchShopeeConversionReport,
  fetchShopeeProductOffer,
  fetchAddlivetagProductData
} = require('./shopeeService');
const { fetchAccessTradeOrders } = require('./tiktokService');
const {
  isAllowedHost,
  safeResolve,
  detectPlatform,
  cleanShopeeUrl,
  cleanTikTokUrl,
  extractUrlsFromText
} = require('./urlResolver');
const {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl
} = require('../utils/securityMiddleware');

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
  if (!val || typeof val !== 'string' || val.length < 4) return '';
  return '********';
}

function normalizeNetworkStatus(rawStatus) {
  const s = String(rawStatus ?? '').trim().toUpperCase();
  if (s === '1' || s === 'COMPLETED' || s === 'APPROVED' || s.includes('HOÀN THÀNH') || s.includes('ĐÃ DUYỆT')) {
    return 'approved';
  }
  if (
    s === '2' ||
    s === '-1' ||
    s === 'CANCELLED' ||
    s === 'INVALID' ||
    s === 'REJECTED' ||
    s.includes('HUỶ') ||
    s.includes('HỦY')
  ) {
    return 'cancelled';
  }
  return 'pending';
}

/**
 * Shared order upsert that automatically maps clickId (sub_id / sub1) -> userId,
 * preserves user-claimed orders, and calculates post-tax 70/30 cashback split.
 */
function upsertNetworkOrder(db, {
  orderSn,
  rawSubId,
  grossCommission,
  orderAmount,
  status,
  platform,
  productName
}) {
  const cleanSn = String(orderSn || '').trim().toUpperCase();
  if (!cleanSn) return null;

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
          u.phone === cleanSub
      )
    : null;

  const validGross = Number.isFinite(Number(grossCommission)) && Number(grossCommission) >= 0
    ? Number(grossCommission)
    : 0;

  const split = calculateCommissionSplit(
    validGross,
    db.settings.cashbackPercent,
    db.settings.taxDeductPercent
  );

  const normalizedPlatform =
    String(platform || clickRecord?.platform || '').toLowerCase() === 'tiktok'
      ? 'tiktok'
      : 'shopee';

  const existing = db.orders.find((o) => String(o.orderSn || '').toUpperCase() === cleanSn);
  if (existing) {
    existing.grossCommission = split.grossCommission;
    existing.taxAmount = split.taxAmount;
    existing.netCommission = split.netCommission;
    existing.totalCommission = split.netCommission;
    existing.cashbackRate = split.cashbackRate;

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
      existing.productName = productName;
    }
    if (status) {
      existing.status = status;
    }
    if (!existing.clickId && cleanSub) {
      existing.clickId = cleanSub;
    }
    // Attach matchedUser if order was previously GUEST/unassigned; preserve existing userId if claimed
    if (!existing.userId && matchedUser) {
      existing.userId = matchedUser.id;
      existing.userCode = matchedUser.code;
    }
    existing.updatedAt = new Date().toISOString();
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
      productName ||
      `Đơn ${normalizedPlatform === 'tiktok' ? 'TikTok' : 'Shopee'} #${cleanSn}`,
    orderAmount: Number.isFinite(validOrderAmt) && validOrderAmt >= 0 ? validOrderAmt : 0,
    grossCommission: split.grossCommission,
    taxAmount: split.taxAmount,
    netCommission: split.netCommission,
    totalCommission: split.netCommission,
    cashbackRate: split.cashbackRate,
    userCashbackAmount: split.userCashbackAmount,
    adminShareAmount: split.adminShareAmount,
    status: status || 'pending',
    hasCustomCashback: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.unshift(created);
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
  let syncedCount = 0;

  for (const node of reportNodes) {
    const rawSubId = String(node.utmContent || '').split('-')[0].trim();
    const grossComm = Number(node.netCommission || node.totalCommission || 0);
    const subOrders = Array.isArray(node.orders) ? node.orders : [];

    for (const ord of subOrders) {
      const orderSn = String(ord.orderId || '').trim().toUpperCase();
      if (!orderSn) continue;

      const status = normalizeNetworkStatus(ord.orderStatus);
      const firstItem = ord.items?.[0];
      const productName = firstItem?.itemName || `Đơn Shopee #${orderSn}`;
      const orderAmount = Number(firstItem?.itemPrice || 0);

      upsertNetworkOrder(db, {
        orderSn,
        rawSubId,
        grossCommission: grossComm,
        orderAmount,
        status,
        platform: 'shopee',
        productName
      });
      syncedCount++;
    }
  }

  db.settings.lastAutoSyncAt = new Date().toISOString();
  recalculateAllWallets();
  await saveDb(db);
  logger.logLeave('runShopeeAutoSync', { syncedCount });
  return { syncedCount };
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
    const firstProd = Array.isArray(row.products) ? row.products[0] : null;
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
  const authLimiter = createRateLimiter({
    windowMs: 60000,
    max: 15,
    keyPrefix: 'auth',
    failClosed: true
  });
  const convertLimiter = createRateLimiter({ windowMs: 60000, max: 30, keyPrefix: 'convert' });
  const withdrawLimiter = createRateLimiter({
    windowMs: 60000,
    max: 30,
    keyPrefix: 'withdraw',
    failClosed: true
  });

  // Ensure Postgres state is initialized on first request if DATABASE_URL is set
  app.use(async (req, res, next) => {
    try {
      await initPostgresIfConfigured();
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
      return res.redirect(302, '/');
    }

    try {
      const target = new URL(click.affiliateUrl);
      if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
        return res.status(400).send('Liên kết đích không hợp lệ.');
      }
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, target.toString());
    } catch {
      return res.redirect(302, '/');
    }
  });

  // 1. Public Config (Never exposes secrets)
  app.get('/api/public-config', (req, res) => {
    logger.logEnter('GET /api/public-config');
    const db = ensureDbLoaded();
    const s = db.settings;
    res.json({
      siteName: s.siteName || 'Hoàn Tiền Sàn',
      cashbackPercent: Number(s.cashbackPercent || 70),
      taxDeductPercent: Number(s.taxDeductPercent ?? 10),
      referralBonusPercent: Number(s.referralBonusPercent ?? 5),
      minWithdrawAmount: Number(s.minWithdrawAmount || 50000),
      supportZalo: s.supportZalo || '',
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
      hasShopeeConfigured: Boolean(s.shopeeAffiliateId || s.shopeeAppId)
    });
    logger.logLeave('GET /api/public-config');
  });

  // 2. Auth: Register (scrypt + 1-level referral + Turnstile check)
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    logger.logEnter('POST /api/auth/register');
    const { name, phone, email, password, refCode, turnstileToken } = req.body || {};

    const turnstileOk = await verifyTurnstileIfEnabled(turnstileToken, getClientIp(req));
    if (!turnstileOk) {
      return res.status(400).json({ error: 'Xác thực chống bot không hợp lệ. Vui lòng thử lại.' });
    }

    const cleanPhone = String(phone || '').trim().replace(/\s+/g, '');
    if (!/^[0-9+]{8,15}$/.test(cleanPhone) || !password || String(password).length < 6) {
      return res.status(400).json({
        error: 'Vui lòng nhập Số điện thoại hợp lệ (8-15 số) và Mật khẩu tối thiểu 6 ký tự.'
      });
    }

    const db = ensureDbLoaded();
    const exists = db.users.find(
      (u) =>
        u.phone === cleanPhone ||
        (email && u.email && u.email.toLowerCase() === String(email).trim().toLowerCase())
    );
    if (exists) {
      return res.status(400).json({ error: 'Số điện thoại này đã được đăng ký.' });
    }

    // Validate 1-level referrer if provided
    let validReferrerCode = null;
    if (refCode && typeof refCode === 'string') {
      const refUser = db.users.find(
        (u) => u.code.toUpperCase() === refCode.trim().toUpperCase()
      );
      if (refUser) {
        validReferrerCode = refUser.code;
      }
    }

    const newUser = {
      id: `usr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      code: generateUserCode(cleanPhone, db.users),
      name: String(name || cleanPhone).trim().slice(0, 60),
      phone: cleanPhone,
      email: String(email || '').trim().slice(0, 80),
      passwordHash: hashPassword(password),
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
  });

  // 3. Auth: Login (timingSafeEqual + automatic upgrade to scrypt + HttpOnly cookie)
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    logger.logEnter('POST /api/auth/login');
    const { identifier, password, turnstileToken } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập Số điện thoại và Mật khẩu.' });
    }

    const turnstileOk = await verifyTurnstileIfEnabled(turnstileToken, getClientIp(req));
    if (!turnstileOk) {
      return res.status(400).json({ error: 'Xác thực chống bot không hợp lệ.' });
    }

    const cleanId = String(identifier).trim().toLowerCase();
    const db = ensureDbLoaded();

    const user = db.users.find(
      (u) =>
        u.phone.toLowerCase() === cleanId ||
        (u.email && u.email.toLowerCase() === cleanId) ||
        u.code.toLowerCase() === cleanId
    );

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Thông tin đăng nhập không chính xác.' });
    }

    // Automatically upgrade legacy hash to scrypt
    if (!String(user.passwordHash).startsWith('scrypt$')) {
      user.passwordHash = hashPassword(password);
      await saveDb(db);
    }

    recalculateUserWallet(user.id);
    const token = createToken(user);
    setAuthCookie(res, token);
    logger.logLeave('POST /api/auth/login', { userCode: user.code, role: user.role });
    return res.json({ token, user: sanitizeUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    logger.logEnter('POST /api/auth/logout');
    clearAuthCookie(res);
    logger.logLeave('POST /api/auth/logout');
    return res.json({ status: 'ok' });
  });

  // 4. Current User Dashboard (Includes Orders, Withdrawals, Immutable Ledger & Referral Count)
  app.get('/api/user/me', (req, res) => {
    logger.logEnter('GET /api/user/me');
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }

    triggerLazyAutoSyncIfNeeded();
    const db = ensureDbLoaded();
    recalculateUserWallet(user.id);

    const userOrders = db.orders
      .filter(
        (o) =>
          o.userId === user.id ||
          (o.userCode && o.userCode.toUpperCase() === user.code.toUpperCase())
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const userWithdrawals = db.withdrawals
      .filter((w) => w.userId === user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const userLedger = db.ledger
      .filter((l) => l.userId === user.id)
      .slice(0, 30);

    const referralCount = db.users.filter((u) => u.referredBy === user.code).length;

    logger.logLeave('GET /api/user/me', { userCode: user.code });
    return res.json({
      user: sanitizeUser(user),
      orders: userOrders,
      withdrawals: userWithdrawals,
      ledger: userLedger,
      referralCount
    });
  });

  // 5. Update User Profile / Bank Info (Requires password verification if changing existing bank account)
  app.post('/api/user/profile', async (req, res) => {
    logger.logEnter('POST /api/user/profile');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Chưa đăng nhập.' });

    const { name, bankName, bankAccount, bankOwner, currentPassword } = req.body || {};
    const newAcc = bankAccount !== undefined ? String(bankAccount).trim() : user.bankAccount;

    if (user.bankAccount && newAcc !== user.bankAccount) {
      if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
        return res.status(403).json({
          error: 'Để bảo mật, vui lòng nhập đúng mật khẩu hiện tại khi thay đổi Số tài khoản ngân hàng.'
        });
      }
    }

    if (name !== undefined) user.name = String(name).trim().slice(0, 60);
    if (bankName !== undefined) user.bankName = String(bankName).trim().slice(0, 40);
    if (bankAccount !== undefined) user.bankAccount = newAcc.slice(0, 30);
    if (bankOwner !== undefined) {
      user.bankOwner = String(bankOwner).trim().toUpperCase().slice(0, 60);
    }

    await saveDb();
    logger.logLeave('POST /api/user/profile', { userCode: user.code });
    return res.json({ user: sanitizeUser(user) });
  });

  // 6. User Submit Order Lookup / Tracking Request (Prevents unauthorized hijacking of GUEST orders)
  app.post('/api/user/submit-order', async (req, res) => {
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

    const db = ensureDbLoaded();
    const existing = db.orders.find((o) => String(o.orderSn || '').toUpperCase() === cleanSn);
    if (existing) {
      if (existing.userId === user.id) {
        return res.json({
          order: existing,
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
          order: existing,
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
        order: existing,
        claimPending: true,
        message: 'Đã tiếp nhận yêu cầu đối soát đơn hàng. Ban quản trị sẽ xác minh quyền sở hữu và duyệt hoàn tiền trong 24h.'
      });
    }

    // Never trust client for orderAmount or commission; set 0 until network postback/report confirms
    const newOrd = {
      id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      orderSn: cleanSn,
      platform: String(platform || '').toLowerCase() === 'tiktok' ? 'tiktok' : 'shopee',
      clickId: null,
      userCode: user.code,
      userId: user.id,
      productName: String(productName || `Đơn hàng #${cleanSn}`).trim().slice(0, 100),
      orderAmount: 0,
      grossCommission: 0,
      taxAmount: 0,
      netCommission: 0,
      totalCommission: 0,
      cashbackRate: Number(db.settings.cashbackPercent || 70),
      userCashbackAmount: 0,
      adminShareAmount: 0,
      status: 'pending',
      hasCustomCashback: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.orders.unshift(newOrd);
    await saveDb(db);
    logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn, created: true });
    return res.json({
      order: newOrd,
      autoMatched: false,
      message: 'Đã ghi nhận mã đơn hàng. Tiền hoàn sẽ tự động cập nhật khi sàn đối soát hoàn tất!'
    });
  });

  // 7. User Request Withdrawal (Atomic per-user lock + Postgres FOR UPDATE transaction)
  app.post('/api/user/withdraw', withdrawLimiter, async (req, res) => {
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

    // Security check: if user already had a different bank account saved, require password verification
    if (user.bankAccount && user.bankAccount !== cleanAcc) {
      if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
        return res.status(403).json({
          error: 'Bạn đang thay đổi Số tài khoản nhận tiền mới. Vui lòng nhập mật khẩu đăng nhập để xác nhận.'
        });
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
        minWithdraw
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
  });

  // 7.5. Instant Product Preview (Safe Resolve + GraphQL productOfferV2 metadata + Cashback estimate)
  const previewLimiter = createRateLimiter(60, 60000);
  app.post('/api/preview', previewLimiter, async (req, res) => {
    logger.logEnter('POST /api/preview');
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string' || !url.trim() || url.length > 2000) {
        return res.status(400).json({ found: false, error: 'Vui lòng cung cấp link sản phẩm hợp lệ.' });
      }

      const extracted = extractUrlsFromText(url);
      const targetUrl = extracted[0] || url.trim();

      // SSRF & Domain Whitelist resolution
      let resolvedUrl = targetUrl;
      let htmlSnippet = '';
      try {
        const resolved = await safeResolve(targetUrl, 4);
        resolvedUrl = resolved.resolvedUrl;
        htmlSnippet = resolved.htmlSnippet;
      } catch (err) {
        logger.warning('POST /api/preview', 'Resolve error', { error: err.message });
        return res.status(400).json({ found: false, error: err.message });
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
        const addlivetagKey =
          s.addlivetagApiKey ||
          process.env.ADDLIVETAG_API_KEY ||
          'b426eeae7cc0b156969f923935e661362aa3b13d09dba032';

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

        // Priority 2: AddLiveTag Data API (via user's provided API key)
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
          return res.json({
            found: true,
            platform: 'shopee',
            hasOffer: Boolean(grossCommission || commRate),
            productName: productMeta.productName || 'Đang cập nhật thông tin sản phẩm',
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
        const addlivetagKey =
          s.addlivetagApiKey ||
          process.env.ADDLIVETAG_API_KEY ||
          'b426eeae7cc0b156969f923935e661362aa3b13d09dba032';

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
          return res.json({
            found: true,
            platform: 'tiktok',
            hasOffer: Boolean(grossCommission || commRate),
            productName: productMeta.productName || cleanInfo.titleHint || 'Sản phẩm TikTok Shop',
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
        return res.json({
          found: true,
          platform: 'tiktok',
          hasOffer: Boolean(cleanInfo.imageUrl),
          productName: cleanInfo.titleHint || 'Sản phẩm TikTok Shop',
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
      return res.status(500).json({ found: false, error: err.message });
    }
  });

  // Diagnostic route for testing Shopee productOfferV2 directly
  app.get('/api/test-shopee-offer', async (req, res) => {
    logger.logEnter('GET /api/test-shopee-offer');
    const itemId = req.query.itemId || '15696940827';
    const shopId = req.query.shopId || '968599922';

    const db = ensureDbLoaded();
    const s = db.settings;
    const appId = s.shopeeAppId || process.env.SHOPEE_APP_ID || '';
    const appSecret = s.shopeeAppSecret || process.env.SHOPEE_APP_SECRET || '';
    const addlivetagKey =
      s.addlivetagApiKey ||
      process.env.ADDLIVETAG_API_KEY ||
      'b426eeae7cc0b156969f923935e661362aa3b13d09dba032';

    const hasAppId = Boolean(appId);
    const hasAppSecret = Boolean(appSecret);
    const hasAddlivetagKey = Boolean(addlivetagKey);

    let openApiResult = null;
    let openApiError = null;
    if (hasAppId && hasAppSecret) {
      try {
        openApiResult = await fetchShopeeProductOffer(itemId, appId, appSecret, shopId);
      } catch (err) {
        openApiError = err.message;
      }
    }

    let addlivetagResult = null;
    let addlivetagError = null;
    if (hasAddlivetagKey) {
      try {
        addlivetagResult = await fetchAddlivetagProductData({
          platform: 'shopee',
          itemId,
          apiKey: addlivetagKey
        });
      } catch (err) {
        addlivetagError = err.message;
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
  });

  // 8. Convert Link (Generates opaque random click_id -> maps to userId in db.clicks)
  app.post('/api/convert', convertLimiter, async (req, res) => {
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
        addlivetagApiKey:
          s.addlivetagApiKey ||
          process.env.ADDLIVETAG_API_KEY ||
          'b426eeae7cc0b156969f923935e661362aa3b13d09dba032',
        shortenerProvider: s.shortenerProvider || 'none'
      };

      const result = await convertTextLinks(text, effectiveConfig);
      const cashbackPercent = Number(s.cashbackPercent || 70);
      const taxDeductPercent = Number(s.taxDeductPercent ?? 10);

      for (const item of result.items) {
        item.cashbackPercent = cashbackPercent;
        item.qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
          item.affiliateUrl
        )}`;

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
          db.clicks.unshift({
            clickId: item.clickId,
            userId: authUser ? authUser.id : null,
            userCode: authUser ? authUser.code : 'GUEST',
            platform: item.platform,
            originalUrl: item.originalUrl,
            cleanUrl: item.cleanUrl,
            productId: item.productId || null,
            affiliateUrl: item.affiliateUrl,
            createdAt: new Date().toISOString()
          });
        }
      }

      db.clicks = db.clicks.slice(0, 1000);
      saveDb(db);

      logger.logLeave('POST /api/convert', { total: result.summary.total });
      return res.json({
        ...result,
        cashbackPercent,
        isLoggedIn: Boolean(authUser)
      });
    } catch (err) {
      logger.error('POST /api/convert', 'Convert error', { error: err.message });
      return res.status(500).json({ error: `Không thể chuyển đổi liên kết: ${err.message}` });
    }
  });

  // 9. Vercel Cron & Webhook Postback Endpoints
  app.get('/api/cron/sync-shopee', async (req, res) => {
    logger.logEnter('GET /api/cron/sync-shopee');
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || '';
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized Cron Request' });
    }
    try {
      const out = await runAutoSyncAll({ requireAtLeastOne: false });
      return res.json({ status: 'ok', ...out });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Official AccessTrade Real-Time Postback (Supports query macros, body, and header token)
  async function handleAccessTradePostback(req, res) {
    const db = ensureDbLoaded();
    const expectedToken = String(process.env.POSTBACK_SECRET || db.settings.postbackToken || '').trim();
    const providedToken = String(
      req.headers['x-postback-token'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '') ||
      req.body?.token ||
      req.query?.token ||
      ''
    ).trim();

    logger.logEnter('AccessTradePostback', { method: req.method, hasToken: Boolean(providedToken) });

    if (!expectedToken || !providedToken) {
      return res.status(401).json({ error: 'Missing postback token.' });
    }

    const a = Buffer.from(providedToken);
    const b = Buffer.from(expectedToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid postback token.' });
    }

    const src = req.method === 'GET' ? req.query : { ...(req.query || {}), ...(req.body || {}) };
    const orderSn =
      src.order_id || src.conversion_id || src.transaction_id || src.orderSn || '';
    if (!orderSn || String(orderSn).includes('{')) {
      // Respond 200 on AccessTrade test ping with literal macro placeholders
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

    try {
      const order = upsertNetworkOrder(db, {
        orderSn,
        rawSubId,
        grossCommission,
        orderAmount,
        status,
        platform,
        productName
      });

      recalculateAllWallets({ persist: false });
      await saveDb(db);
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

  app.get('/api/webhooks/accesstrade', handleAccessTradePostback);
  app.post('/api/webhooks/accesstrade', handleAccessTradePostback);

  app.post('/api/webhooks/postback', async (req, res) => {
    logger.logEnter('POST /api/webhooks/postback');
    const db = ensureDbLoaded();
    const secret = process.env.POSTBACK_SECRET || db.settings.postbackToken;
    if (!secret) {
      return res.status(503).json({ error: 'Postback webhook not configured.' });
    }

    const sig = String(req.headers['x-postback-signature'] || req.query.sig || '');
    const rawBody = JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Invalid postback signature.' });
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
      const order = upsertNetworkOrder(db, {
        orderSn,
        rawSubId: clickId || sub1 || sub_id || '',
        grossCommission: validComm,
        orderAmount: validBilling,
        status: normalizeNetworkStatus(status),
        platform,
        productName
      });

      recalculateAllWallets({ persist: false });
      await saveDb(db);
      return res.json({ status: 'ok', orderSn: order?.orderSn });
    } catch (err) {
      logger.error('POST /api/webhooks/postback', 'Error saving postback', { error: err.message });
      return res.status(500).json({ error: 'Failed to process postback order.' });
    }
  });

  // ================= ADMIN ENDPOINTS =================
  function requireAdmin(req, res) {
    const user = getAuthUser(req);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Chỉ Quản trị viên mới có quyền truy cập.' });
      return null;
    }
    return user;
  }

  app.get('/api/admin/dashboard', async (req, res) => {
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
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'hoantienshop.vercel.app';
    const postbackToken = process.env.POSTBACK_SECRET || db.settings.postbackToken;
    const postbackUrlTemplate = `${proto}://${host}/api/webhooks/accesstrade?token=${encodeURIComponent(
      postbackToken
    )}&order_id={order_id}&sub1={sub1}&pub_commission={pub_commission}&billing={billing}&status={status}&merchant={merchant}`;

    // Mask secrets before returning to client
    const safeSettings = {
      ...db.settings,
      shopeeAppSecret: maskSecret(db.settings.shopeeAppSecret),
      tiktokAppSecret: maskSecret(db.settings.tiktokAppSecret),
      tiktokAccessToken: maskSecret(db.settings.tiktokAccessToken),
      accesstradeApiKey: maskSecret(db.settings.accesstradeApiKey),
      addlivetagApiKey: maskSecret(db.settings.addlivetagApiKey),
      postbackUrlTemplate
    };

    const withdrawalsWithQr = db.withdrawals.map((w) => ({
      ...w,
      vietQrUrl: buildVietQrImageUrl(
        w.bankName,
        w.bankAccount,
        w.amount,
        w.bankOwner,
        `Hoan tien ${w.userCode}`
      )
    }));

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
      orders: db.orders,
      withdrawals: withdrawalsWithQr,
      users: db.users.map(sanitizeUser),
      clicks: db.clicks.slice(0, 50)
    });
  });

  app.post('/api/admin/sync-shopee', async (req, res) => {
    logger.logEnter('POST /api/admin/sync-shopee');
    if (!requireAdmin(req, res)) return;
    try {
      const out = await runAutoSyncAll({ requireAtLeastOne: true });
      return res.json(out);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/settings', async (req, res) => {
    logger.logEnter('POST /api/admin/settings');
    if (!requireAdmin(req, res)) return;

    const db = ensureDbLoaded();
    const body = req.body || {};

    const plainKeys = [
      'siteName',
      'shopeeMode',
      'shopeeAffiliateId',
      'shopeeAppId',
      'tiktokMode',
      'tiktokAppKey',
      'tiktokDeepLinkTemplate',
      'shortenerProvider',
      'cashbackPercent',
      'taxDeductPercent',
      'referralBonusPercent',
      'minWithdrawAmount',
      'supportZalo'
    ];

    for (const key of plainKeys) {
      if (body[key] !== undefined) {
        db.settings[key] = body[key];
      }
    }

    // Only update secret fields if not masked placeholder
    const secretKeys = [
      'shopeeAppSecret',
      'tiktokAppSecret',
      'tiktokAccessToken',
      'accesstradeApiKey',
      'addlivetagApiKey'
    ];
    for (const sKey of secretKeys) {
      if (body[sKey] && body[sKey] !== '********') {
        db.settings[sKey] = String(body[sKey]).trim();
      }
    }

    db.settings.cashbackPercent = Math.min(100, Math.max(1, Number(db.settings.cashbackPercent || 70)));
    db.settings.taxDeductPercent = Math.min(50, Math.max(0, Number(db.settings.taxDeductPercent ?? 10)));
    db.settings.minWithdrawAmount = Math.max(10000, Number(db.settings.minWithdrawAmount || 50000));

    if (body.newAdminPassword && String(body.newAdminPassword).trim().length >= 6) {
      const adminUser = db.users.find((u) => u.role === 'admin');
      if (adminUser) {
        adminUser.passwordHash = hashPassword(String(body.newAdminPassword).trim());
        adminUser.tokenVersion = Number(adminUser.tokenVersion || 1) + 1;
      }
    }

    await saveDb(db);
    logger.logLeave('POST /api/admin/settings');
    return res.json({ status: 'ok' });
  });

  app.post('/api/admin/orders', async (req, res) => {
    logger.logEnter('POST /api/admin/orders');
    if (!requireAdmin(req, res)) return;

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

    const validPlatform = String(platform || '').toLowerCase() === 'tiktok' ? 'tiktok' : 'shopee';
    const validStatus = ['pending', 'approved', 'cancelled'].includes(status) ? status : 'pending';

    const hasTotalCommission = totalCommission !== undefined && totalCommission !== null && totalCommission !== '';
    const hasCustomCashback = userCashbackAmount !== undefined && userCashbackAmount !== null && userCashbackAmount !== '';

    const rawComm = hasTotalCommission ? Number(totalCommission) : 0;
    const validComm = Number.isFinite(rawComm) && rawComm >= 0 ? rawComm : 0;
    const split = calculateCommissionSplit(
      validComm,
      db.settings.cashbackPercent,
      db.settings.taxDeductPercent
    );

    const rawCode = String(userCode || 'ADMIN').trim();
    // Match either by clickId in db.clicks OR by user code / phone
    const matchedClick = db.clicks.find((c) => c.clickId === rawCode);
    const matchedUser = matchedClick?.userId
      ? db.users.find((u) => u.id === matchedClick.userId)
      : db.users.find(
          (u) =>
            (u.code && String(u.code).toUpperCase() === rawCode.toUpperCase()) ||
            u.phone === rawCode
        );

    let targetOrder = db.orders.find(
      (o) =>
        (id && o.id === id) ||
        String(o.orderSn || '').toUpperCase() === cleanOrderSn
    );

    const rawOrderAmt = Number(orderAmount);
    const validOrderAmt = Number.isFinite(rawOrderAmt) && rawOrderAmt >= 0 ? rawOrderAmt : 0;

    if (targetOrder) {
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

      if (hasCustomCashback) {
        const rawCustom = Number(userCashbackAmount);
        targetOrder.userCashbackAmount = Number.isFinite(rawCustom) && rawCustom >= 0 ? Math.round(rawCustom) : 0;
        targetOrder.hasCustomCashback = true;
      } else if (hasTotalCommission) {
        targetOrder.userCashbackAmount = split.userCashbackAmount;
        targetOrder.hasCustomCashback = false;
      }

      targetOrder.adminShareAmount = Math.max(
        0,
        Number(targetOrder.netCommission || targetOrder.grossCommission || 0) - Number(targetOrder.userCashbackAmount || 0)
      );

      if (status) {
        targetOrder.status = validStatus;
      }
      targetOrder.updatedAt = new Date().toISOString();
    } else {
      let finalCashback = split.userCashbackAmount;
      let isCustom = false;
      if (hasCustomCashback) {
        const rawCustom = Number(userCashbackAmount);
        finalCashback = Number.isFinite(rawCustom) && rawCustom >= 0 ? Math.round(rawCustom) : 0;
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
        userCashbackAmount: finalCashback,
        adminShareAmount: Math.max(0, split.netCommission - finalCashback),
        status: validStatus,
        hasCustomCashback: isCustom,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.orders.unshift(targetOrder);
    }

    recalculateAllWallets({ persist: false });
    await saveDb(db);

    logger.logLeave('POST /api/admin/orders', { orderSn: targetOrder.orderSn, status: targetOrder.status, cashback: targetOrder.userCashbackAmount });
    return res.json({ order: targetOrder });
  });

  // Admin Delete Order
  app.post('/api/admin/orders/delete', async (req, res) => {
    logger.logEnter('POST /api/admin/orders/delete');
    if (!requireAdmin(req, res)) return;

    const { id, orderSn } = req.body || {};
    if (!id && !orderSn) {
      return res.status(400).json({ error: 'Thiếu ID hoặc Mã đơn hàng để xóa.' });
    }

    const db = ensureDbLoaded();
    const idx = db.orders.findIndex(
      (o) =>
        (id && o.id === id) ||
        (orderSn && String(o.orderSn || '').toUpperCase() === String(orderSn).trim().toUpperCase())
    );

    if (idx === -1) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng cần xóa.' });
    }

    const [deletedOrder] = db.orders.splice(idx, 1);
    recalculateAllWallets({ persist: false });
    await saveDb(db);

    logger.logLeave('POST /api/admin/orders/delete', { orderSn: deletedOrder.orderSn });
    return res.json({ status: 'ok', message: `Đã xóa đơn hàng #${deletedOrder.orderSn} thành công!` });
  });

  // Admin CSV Import (Payload limit 200kb, max 500 rows per batch)
  app.post('/api/admin/import-orders', express.json({ limit: '200kb' }), async (req, res) => {
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
  });

  app.post('/api/admin/withdrawals/update', async (req, res) => {
    logger.logEnter('POST /api/admin/withdrawals/update');
    if (!requireAdmin(req, res)) return;

    const { id, status } = req.body || {};
    const ALLOWED_WITHDRAWAL_STATUSES = ['pending', 'paid', 'rejected'];
    if (!ALLOWED_WITHDRAWAL_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Trạng thái rút tiền không hợp lệ. Chỉ chấp nhận: ${ALLOWED_WITHDRAWAL_STATUSES.join(', ')}.`
      });
    }

    const db = ensureDbLoaded();
    const wd = db.withdrawals.find((w) => w.id === id);
    if (!wd) {
      return res.status(404).json({ error: 'Không tìm thấy yêu cầu rút tiền.' });
    }

    wd.status = status;
    wd.processedAt = new Date().toISOString();
    recalculateUserWallet(wd.userId);
    await saveDb(db);

    logger.logLeave('POST /api/admin/withdrawals/update', { id, status });
    return res.json({ withdrawal: wd });
  });

  // Admin Delete Withdrawal
  app.post('/api/admin/withdrawals/delete', async (req, res) => {
    logger.logEnter('POST /api/admin/withdrawals/delete');
    if (!requireAdmin(req, res)) return;

    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: 'Thiếu ID lệnh rút tiền cần xóa.' });
    }

    const db = ensureDbLoaded();
    const idx = db.withdrawals.findIndex((w) => w.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Không tìm thấy lệnh rút tiền.' });
    }

    const [deletedWd] = db.withdrawals.splice(idx, 1);
    // Remove ledger debit & refund entries for this withdrawal so balance is unlocked/restored
    db.ledger = db.ledger.filter(
      (e) => !e.refId.startsWith(`withdraw_debit_${id}`) && !e.refId.startsWith(`withdraw_refund_${id}`)
    );
    recalculateUserWallet(deletedWd.userId);
    await saveDb(db);

    logger.logLeave('POST /api/admin/withdrawals/delete', { id });
    return res.json({ status: 'ok', message: `Đã xóa lệnh rút tiền #${id} thành công!` });
  });

  // Admin User Management Action (Reset password, Lock/Unlock, Adjust balance, Reset balance, Delete)
  app.post('/api/admin/users/action', async (req, res) => {
    logger.logEnter('POST /api/admin/users/action');
    if (!requireAdmin(req, res)) return;

    const { userId, action, newPassword, amount, note } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Thiếu ID người dùng.' });

    const db = ensureDbLoaded();
    const targetUser = db.users.find((u) => u.id === userId);
    if (!targetUser) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });

    if (action === 'reset_balance') {
      const currentAvailable = Number(targetUser.balanceAvailable || 0);
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
      recalculateUserWallet(targetUser.id);
      await saveDb(db);
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
      targetUser.passwordHash = hashPassword(String(newPassword).trim());
      targetUser.tokenVersion = Number(targetUser.tokenVersion || 1) + 1;
      await saveDb(db);
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
      const msg = targetUser.accountLocked
        ? `Đã khóa tài khoản ${targetUser.code} (chặn đăng nhập & rút tiền)!`
        : `Đã mở khóa tài khoản cho ${targetUser.code}!`;
      logger.logLeave('POST /api/admin/users/action', { action, locked: targetUser.accountLocked });
      return res.json({ status: 'ok', accountLocked: targetUser.accountLocked, message: msg });
    }

    if (action === 'adjust_balance') {
      const num = Math.round(Number(amount || 0));
      if (!num) return res.status(400).json({ error: 'Vui lòng nhập số tiền điều chỉnh khác 0.' });
      const refId = `admin_adj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      appendLedgerEntry(
        targetUser.id,
        'admin_adjustment',
        num,
        refId,
        String(note || 'Điều chỉnh từ Quản trị viên').trim().slice(0, 100)
      );
      recalculateUserWallet(targetUser.id);
      await saveDb(db);
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
      db.users = db.users.filter((u) => u.id !== userId);
      await saveDb(db);
      logger.logLeave('POST /api/admin/users/action', { action: 'delete', userId });
      return res.json({ status: 'ok', message: `Đã xóa tài khoản ${targetUser.code} thành công!` });
    }

    return res.status(400).json({ error: 'Thao tác không hợp lệ.' });
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
  registerCashbackRoutes
};
