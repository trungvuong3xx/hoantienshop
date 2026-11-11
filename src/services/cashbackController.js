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
  createToken,
  verifyToken,
  sanitizeUser,
  getDatabaseStatus
} = require('./dbService');
const { convertTextLinks } = require('./converterService');
const { fetchShopeeConversionReport } = require('./shopeeService');
const { fetchAccessTradeOrders } = require('./tiktokService');
const { isAllowedHost } = require('./urlResolver');
const {
  getClientIp,
  createRateLimiter,
  verifyTurnstileIfEnabled,
  buildVietQrImageUrl
} = require('../utils/securityMiddleware');

function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
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
        (u) => u.code.toUpperCase() === cleanSub.toUpperCase() || u.phone === cleanSub
      )
    : null;

  const split = calculateCommissionSplit(
    Number(grossCommission || 0),
    db.settings.cashbackPercent,
    db.settings.taxDeductPercent
  );

  const normalizedPlatform =
    String(platform || clickRecord?.platform || '').toLowerCase() === 'tiktok'
      ? 'tiktok'
      : 'shopee';

  const existing = db.orders.find((o) => o.orderSn.toUpperCase() === cleanSn);
  if (existing) {
    existing.grossCommission = split.grossCommission;
    existing.taxAmount = split.taxAmount;
    existing.netCommission = split.netCommission;
    existing.totalCommission = split.netCommission;
    existing.cashbackRate = split.cashbackRate;
    existing.userCashbackAmount = split.userCashbackAmount;
    existing.adminShareAmount = split.adminShareAmount;
    if (Number(orderAmount) > 0) {
      existing.orderAmount = Number(orderAmount);
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
    // Attach matchedUser if order was previously GUEST/unassigned; preserve existing userId if user claimed early
    if (!existing.userId && matchedUser) {
      existing.userId = matchedUser.id;
      existing.userCode = matchedUser.code;
    }
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

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
    orderAmount: Number(orderAmount || 0),
    grossCommission: split.grossCommission,
    taxAmount: split.taxAmount,
    netCommission: split.netCommission,
    totalCommission: split.netCommission,
    cashbackRate: split.cashbackRate,
    userCashbackAmount: split.userCashbackAmount,
    adminShareAmount: split.adminShareAmount,
    status: status || 'pending',
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
  saveDb(db);
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
  saveDb(db);
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

  db.settings.lastAutoSyncAt = new Date().toISOString();
  saveDb(db);
  const out = {
    shopeeSynced,
    accesstradeSynced,
    syncedCount: shopeeSynced + accesstradeSynced,
    errors,
    lastAutoSyncAt: db.settings.lastAutoSyncAt
  };
  logger.logLeave('runAutoSyncAll', out);
  return out;
}

let isAutoSyncInFlight = false;
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
  } catch {}
}

function registerCashbackRoutes(app) {
  const authLimiter = createRateLimiter({ windowMs: 60000, max: 12, keyPrefix: 'auth' });
  const convertLimiter = createRateLimiter({ windowMs: 60000, max: 25, keyPrefix: 'convert' });
  const withdrawLimiter = createRateLimiter({ windowMs: 60000, max: 6, keyPrefix: 'withdraw' });

  // Ensure Postgres state is initialized on first request if DATABASE_URL is set
  app.use(async (req, res, next) => {
    try {
      await initPostgresIfConfigured();
    } catch {}
    next();
  });

  // Safe Outbound Redirect Route (/go/:clickId) - Whitelist enforced & Referrer stripped
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
      res.setHeader('Referrer-Policy', 'no-referrer');
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
      siteName: s.siteName || 'Hoàn Tiền Shop',
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
    saveDb(db);

    const token = createToken(newUser);
    logger.logLeave('POST /api/auth/register', { userCode: newUser.code });
    return res.json({ token, user: sanitizeUser(newUser) });
  });

  // 3. Auth: Login (timingSafeEqual + automatic upgrade to scrypt)
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
      saveDb(db);
    }

    recalculateUserWallet(user.id);
    const token = createToken(user);
    logger.logLeave('POST /api/auth/login', { userCode: user.code, role: user.role });
    return res.json({ token, user: sanitizeUser(user) });
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
  app.post('/api/user/profile', (req, res) => {
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

    saveDb();
    logger.logLeave('POST /api/user/profile', { userCode: user.code });
    return res.json({ user: sanitizeUser(user) });
  });

  // 6. User Submit Order Lookup / Tracking Request (Strictly status = 'pending', 0 commission until Affiliate Network confirms)
  app.post('/api/user/submit-order', (req, res) => {
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
    const existing = db.orders.find((o) => o.orderSn.toUpperCase() === cleanSn);
    if (existing) {
      // Auto-claim if order was already synced from network under GUEST (!existing.userId)
      if (!existing.userId || existing.userCode === 'GUEST') {
        existing.userId = user.id;
        existing.userCode = user.code;
        existing.updatedAt = new Date().toISOString();
        recalculateUserWallet(user.id);
        saveDb(db);
        logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn, autoClaimed: true });
        return res.json({
          order: existing,
          autoMatched: true,
          message: 'Đã khớp tự động đơn hàng từ sàn và cộng tiền hoàn vào ví của bạn!'
        });
      }
      if (existing.userId === user.id) {
        return res.json({
          order: existing,
          autoMatched: true,
          message: 'Đơn hàng này đã có trong tài khoản của bạn.'
        });
      }
      return res.status(400).json({
        error: 'Mã đơn hàng này đã được ghi nhận cho một tài khoản khác.'
      });
    }

    // Never trust client for orderAmount or commission; set 0 until network postback/report confirms
    const newOrd = {
      id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      orderSn: cleanSn,
      platform: platform === 'tiktok' ? 'tiktok' : 'shopee',
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.orders.unshift(newOrd);
    saveDb(db);
    logger.logLeave('POST /api/user/submit-order', { orderSn: cleanSn });
    return res.json({ order: newOrd });
  });

  // 7. User Request Withdrawal (Verifies password when changing bank account, locks balance in ledger)
  app.post('/api/user/withdraw', withdrawLimiter, (req, res) => {
    logger.logEnter('POST /api/user/withdraw');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });

    const db = ensureDbLoaded();
    recalculateUserWallet(user.id);

    const { amount, method, bankName, bankAccount, bankOwner, currentPassword } = req.body || {};
    const numAmount = Math.round(Number(amount || 0));
    const minWithdraw = Number(db.settings.minWithdrawAmount || 50000);

    if (!Number.isFinite(numAmount) || numAmount < minWithdraw) {
      return res.status(400).json({
        error: `Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ.`
      });
    }
    if (numAmount > user.balanceAvailable) {
      return res.status(400).json({
        error: 'Số dư khả dụng không đủ để thực hiện lệnh rút này.'
      });
    }

    const cleanAcc = String(bankAccount || '').trim().slice(0, 30);
    const cleanOwner = String(bankOwner || '').trim().toUpperCase().slice(0, 60);
    const cleanBank = String(bankName || (method === 'momo' ? 'MoMo' : '')).trim().slice(0, 40);

    if (!cleanAcc || !cleanOwner || !cleanBank) {
      return res.status(400).json({
        error: 'Vui lòng điền đầy đủ Ngân hàng, Số tài khoản và Tên chủ tài khoản.'
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

    user.bankName = cleanBank;
    user.bankAccount = cleanAcc;
    user.bankOwner = cleanOwner;

    const withdrawal = {
      id: `wd_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      userId: user.id,
      userCode: user.code,
      userName: user.name,
      userPhone: user.phone,
      amount: numAmount,
      method: method === 'momo' ? 'momo' : 'bank',
      bankName: user.bankName,
      bankAccount: user.bankAccount,
      bankOwner: user.bankOwner,
      status: 'pending',
      createdAt: new Date().toISOString(),
      processedAt: null
    };

    db.withdrawals.unshift(withdrawal);
    recalculateUserWallet(user.id);

    logger.logLeave('POST /api/user/withdraw', { amount: numAmount, userCode: user.code });
    return res.json({
      withdrawal,
      user: sanitizeUser(user)
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

        if (item.price > 0 && item.commissionRate > 0) {
          const estGross = Math.round((item.price * item.commissionRate) / 100);
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

  // Official AccessTrade Real-Time Postback (Supports both GET query macros and POST body)
  function handleAccessTradePostback(req, res) {
    logger.logEnter('AccessTradePostback', { method: req.method });
    const db = ensureDbLoaded();
    const expectedToken = String(process.env.POSTBACK_SECRET || db.settings.postbackToken || '').trim();
    const providedToken = String(
      req.query.token || req.headers['x-postback-token'] || req.body?.token || ''
    ).trim();

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
    const grossCommission = Number(
      src.pub_commission ?? src.reward ?? src.commission ?? src.grossCommission ?? 0
    );
    const orderAmount = Number(
      src.billing ?? src.total_amount ?? src.amount ?? src.orderAmount ?? 0
    );
    const status = normalizeNetworkStatus(src.status ?? src.approval_status);
    const merchantRaw = String(src.merchant || src.platform || 'tiktok').toLowerCase();
    const platform = merchantRaw.includes('shopee') ? 'shopee' : 'tiktok';
    const productName = src.product_name || src.productName || '';

    const order = upsertNetworkOrder(db, {
      orderSn,
      rawSubId,
      grossCommission,
      orderAmount,
      status,
      platform,
      productName
    });

    recalculateAllWallets();
    saveDb(db);
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
  }

  app.get('/api/webhooks/accesstrade', handleAccessTradePostback);
  app.post('/api/webhooks/accesstrade', handleAccessTradePostback);

  app.post('/api/webhooks/postback', (req, res) => {
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

    const order = upsertNetworkOrder(db, {
      orderSn,
      rawSubId: clickId || sub1 || sub_id || '',
      grossCommission: grossCommission ?? pub_commission ?? 0,
      orderAmount: orderAmount ?? billing ?? 0,
      status: normalizeNetworkStatus(status),
      platform,
      productName
    });

    recalculateAllWallets();
    saveDb(db);
    return res.json({ status: 'ok', orderSn: order?.orderSn });
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

  app.get('/api/admin/dashboard', (req, res) => {
    logger.logEnter('GET /api/admin/dashboard');
    if (!requireAdmin(req, res)) return;

    triggerLazyAutoSyncIfNeeded();
    const db = ensureDbLoaded();
    recalculateAllWallets();

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

  app.post('/api/admin/settings', (req, res) => {
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
      'accesstradeApiKey'
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

    saveDb(db);
    logger.logLeave('POST /api/admin/settings');
    return res.json({ status: 'ok' });
  });

  app.post('/api/admin/orders', (req, res) => {
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
      status
    } = req.body || {};

    if (!orderSn) {
      return res.status(400).json({ error: 'Thiếu Mã đơn hàng (orderSn).' });
    }

    const split = calculateCommissionSplit(
      totalCommission,
      db.settings.cashbackPercent,
      db.settings.taxDeductPercent
    );

    const rawCode = String(userCode || 'ADMIN').trim();
    // Match either by clickId in db.clicks OR by user code / phone
    const matchedClick = db.clicks.find((c) => c.clickId === rawCode);
    const matchedUser = matchedClick?.userId
      ? db.users.find((u) => u.id === matchedClick.userId)
      : db.users.find(
          (u) => u.code.toUpperCase() === rawCode.toUpperCase() || u.phone === rawCode
        );

    let targetOrder = db.orders.find(
      (o) =>
        (id && o.id === id) ||
        o.orderSn.toUpperCase() === String(orderSn).trim().toUpperCase()
    );

    if (targetOrder) {
      targetOrder.orderSn = String(orderSn).trim().toUpperCase();
      targetOrder.platform = platform || targetOrder.platform;
      targetOrder.userCode = matchedUser ? matchedUser.code : rawCode.toUpperCase();
      targetOrder.userId = matchedUser ? matchedUser.id : targetOrder.userId;
      targetOrder.productName = productName || targetOrder.productName;
      targetOrder.orderAmount = Number(orderAmount ?? targetOrder.orderAmount);
      targetOrder.grossCommission = split.grossCommission;
      targetOrder.taxAmount = split.taxAmount;
      targetOrder.netCommission = split.netCommission;
      targetOrder.totalCommission = split.netCommission;
      targetOrder.cashbackRate = split.cashbackRate;
      targetOrder.userCashbackAmount = split.userCashbackAmount;
      targetOrder.adminShareAmount = split.adminShareAmount;
      targetOrder.status = status || targetOrder.status;
      targetOrder.updatedAt = new Date().toISOString();
    } else {
      targetOrder = {
        id: `ord_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        orderSn: String(orderSn).trim().toUpperCase(),
        platform: platform === 'tiktok' ? 'tiktok' : 'shopee',
        clickId: matchedClick ? matchedClick.clickId : null,
        userCode: matchedUser ? matchedUser.code : rawCode.toUpperCase(),
        userId: matchedUser ? matchedUser.id : null,
        productName: productName || `Đơn hàng #${orderSn}`,
        orderAmount: Number(orderAmount || 0),
        grossCommission: split.grossCommission,
        taxAmount: split.taxAmount,
        netCommission: split.netCommission,
        totalCommission: split.netCommission,
        cashbackRate: split.cashbackRate,
        userCashbackAmount: split.userCashbackAmount,
        adminShareAmount: split.adminShareAmount,
        status: status || 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.orders.unshift(targetOrder);
    }

    recalculateAllWallets();
    saveDb(db);

    logger.logLeave('POST /api/admin/orders', { orderSn: targetOrder.orderSn });
    return res.json({ order: targetOrder });
  });

  // Admin CSV Import (Higher payload limit 200kb only on this route)
  app.post('/api/admin/import-orders', express.json({ limit: '200kb' }), (req, res) => {
    logger.logEnter('POST /api/admin/import-orders');
    if (!requireAdmin(req, res)) return;

    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Không có dữ liệu đơn hàng để nhập.' });
    }

    const db = ensureDbLoaded();
    let importedCount = 0;

    for (const r of rows) {
      const orderSn = String(r.orderSn || '').trim().toUpperCase();
      if (!orderSn) continue;

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
    }

    recalculateAllWallets();
    saveDb(db);
    logger.logLeave('POST /api/admin/import-orders', { importedCount });
    return res.json({ importedCount });
  });

  app.post('/api/admin/withdrawals/update', (req, res) => {
    logger.logEnter('POST /api/admin/withdrawals/update');
    if (!requireAdmin(req, res)) return;

    const { id, status } = req.body || {};
    const db = ensureDbLoaded();
    const wd = db.withdrawals.find((w) => w.id === id);
    if (!wd) {
      return res.status(404).json({ error: 'Không tìm thấy yêu cầu rút tiền.' });
    }

    wd.status = status;
    wd.processedAt = new Date().toISOString();
    recalculateUserWallet(wd.userId);
    saveDb(db);

    logger.logLeave('POST /api/admin/withdrawals/update', { id, status });
    return res.json({ withdrawal: wd });
  });

  // Periodic background auto-sync every 15 minutes on persistent server
  if (!process.env.VERCEL) {
    const syncTimer = setInterval(() => {
      triggerLazyAutoSyncIfNeeded();
    }, 15 * 60 * 1000);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
  }
}

module.exports = {
  registerCashbackRoutes
};
