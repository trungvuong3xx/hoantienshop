const logger = require('../utils/logger');
const {
  ensureDbLoaded,
  saveDb,
  hashPassword,
  recalculateUserWallet,
  recalculateAllWallets,
  createToken,
  verifyToken,
  sanitizeUser
} = require('./dbService');
const { convertTextLinks } = require('./converterService');

function getAuthUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const db = ensureDbLoaded();
  return db.users.find((u) => u.id === payload.id) || null;
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
  return `U${Date.now().toString().slice(-6)}`;
}

/**
 * Register all Cashback Platform API routes onto an Express app.
 */
function registerCashbackRoutes(app) {
  // 1. Public Config
  app.get('/api/public-config', (req, res) => {
    logger.logEnter('GET /api/public-config');
    const db = ensureDbLoaded();
    const s = db.settings;
    res.json({
      siteName: s.siteName || 'Hoàn Tiền Shop',
      cashbackPercent: Number(s.cashbackPercent || 70),
      adminPercent: 100 - Number(s.cashbackPercent || 70),
      minWithdrawAmount: Number(s.minWithdrawAmount || 50000),
      supportZalo: s.supportZalo || '',
      hasShopeeConfigured: Boolean(s.shopeeAffiliateId || s.shopeeAppId)
    });
    logger.logLeave('GET /api/public-config');
  });

  // 2. Auth: Register
  app.post('/api/auth/register', (req, res) => {
    logger.logEnter('POST /api/auth/register');
    const { name, phone, email, password } = req.body || {};
    if (!phone || !password || String(password).length < 4) {
      return res.status(400).json({
        error: 'Vui lòng nhập Số điện thoại và Mật khẩu (tối thiểu 4 ký tự).'
      });
    }

    const cleanPhone = String(phone).trim();
    const db = ensureDbLoaded();

    const exists = db.users.find(
      (u) => u.phone === cleanPhone || (email && u.email && u.email.toLowerCase() === String(email).toLowerCase())
    );
    if (exists) {
      return res.status(400).json({
        error: 'Số điện thoại hoặc Email này đã được đăng ký.'
      });
    }

    const newUser = {
      id: `usr_${Date.now()}`,
      code: generateUserCode(cleanPhone, db.users),
      name: (name || cleanPhone).trim(),
      phone: cleanPhone,
      email: (email || '').trim(),
      passwordHash: hashPassword(password),
      role: 'user',
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
    return res.json({
      token,
      user: sanitizeUser(newUser)
    });
  });

  // 3. Auth: Login
  app.post('/api/auth/login', (req, res) => {
    logger.logEnter('POST /api/auth/login');
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({
        error: 'Vui lòng nhập Số điện thoại/Tài khoản và Mật khẩu.'
      });
    }

    const cleanId = String(identifier).trim().toLowerCase();
    const db = ensureDbLoaded();
    const passHash = hashPassword(password);

    const user = db.users.find(
      (u) =>
        (u.phone.toLowerCase() === cleanId ||
          (u.email && u.email.toLowerCase() === cleanId) ||
          u.code.toLowerCase() === cleanId) &&
        u.passwordHash === passHash
    );

    if (!user) {
      return res.status(401).json({
        error: 'Sai tài khoản hoặc mật khẩu.'
      });
    }

    recalculateUserWallet(user.id);
    const token = createToken(user);
    logger.logLeave('POST /api/auth/login', { userCode: user.code, role: user.role });
    return res.json({
      token,
      user: sanitizeUser(user)
    });
  });

  // 4. Current User Dashboard Data
  app.get('/api/user/me', (req, res) => {
    logger.logEnter('GET /api/user/me');
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' });
    }

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

    const recentLinks = db.linkLogs
      .filter((l) => l.userId === user.id)
      .slice(0, 15);

    logger.logLeave('GET /api/user/me', { userCode: user.code });
    return res.json({
      user: sanitizeUser(user),
      orders: userOrders,
      withdrawals: userWithdrawals,
      recentLinks
    });
  });

  // 5. Update User Bank / Profile
  app.post('/api/user/profile', (req, res) => {
    logger.logEnter('POST /api/user/profile');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Chưa đăng nhập.' });

    const { name, bankName, bankAccount, bankOwner } = req.body || {};
    if (name !== undefined) user.name = String(name).trim();
    if (bankName !== undefined) user.bankName = String(bankName).trim();
    if (bankAccount !== undefined) user.bankAccount = String(bankAccount).trim();
    if (bankOwner !== undefined) user.bankOwner = String(bankOwner).trim().toUpperCase();

    saveDb();
    logger.logLeave('POST /api/user/profile', { userCode: user.code });
    return res.json({ user: sanitizeUser(user) });
  });

  // 6. User Submit Order SN (Báo mã đơn hàng để đối soát nhanh)
  app.post('/api/user/submit-order', (req, res) => {
    logger.logEnter('POST /api/user/submit-order');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập để lưu mã đơn hàng.' });

    const { orderSn, platform, productName, orderAmount } = req.body || {};
    if (!orderSn || String(orderSn).trim().length < 5) {
      return res.status(400).json({ error: 'Vui lòng nhập Mã đơn hàng hợp lệ.' });
    }

    const db = ensureDbLoaded();
    const cleanSn = String(orderSn).trim().toUpperCase();
    const existing = db.orders.find((o) => o.orderSn.toUpperCase() === cleanSn);
    if (existing) {
      return res.status(400).json({ error: 'Mã đơn hàng này đã tồn tại trên hệ thống.' });
    }

    const newOrd = {
      id: `ord_${Date.now()}`,
      orderSn: cleanSn,
      platform: platform === 'tiktok' ? 'tiktok' : 'shopee',
      userCode: user.code,
      userId: user.id,
      productName: (productName || `Đơn hàng ${cleanSn}`).trim(),
      orderAmount: Number(orderAmount || 0),
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

  // 7. User Request Withdrawal
  app.post('/api/user/withdraw', (req, res) => {
    logger.logEnter('POST /api/user/withdraw');
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });

    const db = ensureDbLoaded();
    recalculateUserWallet(user.id);

    const { amount, method, bankName, bankAccount, bankOwner } = req.body || {};
    const numAmount = Math.round(Number(amount || 0));
    const minWithdraw = Number(db.settings.minWithdrawAmount || 50000);

    if (numAmount < minWithdraw) {
      return res.status(400).json({
        error: `Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ.`
      });
    }
    if (numAmount > user.balanceAvailable) {
      return res.status(400).json({
        error: 'Số dư khả dụng không đủ để thực hiện lệnh rút này.'
      });
    }
    if (!bankAccount || !bankOwner) {
      return res.status(400).json({
        error: 'Vui lòng điền đầy đủ Số tài khoản / SĐT MoMo và Tên chủ tài khoản.'
      });
    }

    // Save payout info to user profile for convenience
    user.bankName = bankName || (method === 'momo' ? 'MoMo' : user.bankName);
    user.bankAccount = String(bankAccount).trim();
    user.bankOwner = String(bankOwner).trim().toUpperCase();

    const withdrawal = {
      id: `wd_${Date.now()}`,
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

  // 8. Convert Link (Uses Admin's Affiliate Credentials + Attaches Customer's UserCode as Sub_ID)
  app.post('/api/convert', async (req, res) => {
    logger.logEnter('POST /api/convert');
    try {
      const { text, customSubId } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({
          error: 'Vui lòng dán link sản phẩm Shopee hoặc TikTok Shop vào ô tìm kiếm.'
        });
      }

      const db = ensureDbLoaded();
      const s = db.settings;
      const authUser = getAuthUser(req);

      // Determine tracking sub_id: logged-in customer code -> customSubId -> GUEST
      const trackingSubId = authUser
        ? authUser.code
        : customSubId
        ? String(customSubId).replace(/[^a-zA-Z0-9_]/g, '')
        : 'GUEST';

      const effectiveConfig = {
        shopeeMode: s.shopeeMode || 'an_redir',
        shopeeAffiliateId: s.shopeeAffiliateId || '17388899900',
        shopeeAppId: s.shopeeAppId || '',
        shopeeAppSecret: s.shopeeAppSecret || '',
        tiktokMode: s.tiktokMode || 'clean_extract',
        tiktokAppKey: s.tiktokAppKey || '',
        tiktokAppSecret: s.tiktokAppSecret || '',
        tiktokAccessToken: s.tiktokAccessToken || '',
        tiktokCookie: s.tiktokCookie || '',
        tiktokDeepLinkTemplate: s.tiktokDeepLinkTemplate || '',
        shortenerProvider: s.shortenerProvider || 'isgd',
        subId: trackingSubId
      };

      const result = await convertTextLinks(text, effectiveConfig);
      const cashbackPercent = Number(s.cashbackPercent || 70);

      // Attach cashback metadata & log links
      for (const item of result.items) {
        item.trackingSubId = trackingSubId;
        item.cashbackPercent = cashbackPercent;
        item.qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
          item.affiliateUrl
        )}`;

        if (item.status === 'success') {
          db.linkLogs.unshift({
            id: `lnk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            userId: authUser ? authUser.id : null,
            userCode: trackingSubId,
            platform: item.platform,
            originalUrl: item.originalUrl,
            cleanUrl: item.cleanUrl,
            productId: item.productId || null,
            affiliateUrl: item.affiliateUrl,
            createdAt: new Date().toISOString()
          });
        }
      }

      db.linkLogs = db.linkLogs.slice(0, 200);
      saveDb(db);

      logger.logLeave('POST /api/convert', {
        total: result.summary.total,
        trackingSubId
      });

      return res.json({
        ...result,
        trackingSubId,
        cashbackPercent,
        isLoggedIn: Boolean(authUser)
      });
    } catch (err) {
      logger.error('POST /api/convert', 'Convert error', { error: err.message });
      return res.status(500).json({ error: `Lỗi xử lý link: ${err.message}` });
    }
  });

  // ================= ADMIN ENDPOINTS =================
  function requireAdmin(req, res) {
    const user = getAuthUser(req);
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Chỉ Quản trị viên (Admin) mới có quyền truy cập mục này.' });
      return null;
    }
    return user;
  }

  app.get('/api/admin/dashboard', (req, res) => {
    logger.logEnter('GET /api/admin/dashboard');
    if (!requireAdmin(req, res)) return;

    const db = ensureDbLoaded();
    recalculateAllWallets();

    let totalCommission = 0;
    let totalUserCashback = 0;
    let totalAdminProfit = 0;

    for (const o of db.orders) {
      if (o.status !== 'cancelled') {
        totalCommission += Number(o.totalCommission || 0);
        totalUserCashback += Number(o.userCashbackAmount || 0);
        totalAdminProfit += Number(o.adminShareAmount || 0);
      }
    }

    return res.json({
      stats: {
        totalUsers: db.users.length,
        totalOrders: db.orders.length,
        totalCommission: Math.round(totalCommission),
        totalUserCashback: Math.round(totalUserCashback),
        totalAdminProfit: Math.round(totalAdminProfit),
        pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').length
      },
      settings: db.settings,
      orders: db.orders,
      withdrawals: db.withdrawals,
      users: db.users.map(sanitizeUser),
      linkLogs: db.linkLogs.slice(0, 50)
    });
  });

  app.post('/api/admin/settings', (req, res) => {
    logger.logEnter('POST /api/admin/settings');
    if (!requireAdmin(req, res)) return;

    const db = ensureDbLoaded();
    const body = req.body || {};

    const allowedKeys = [
      'siteName',
      'shopeeMode',
      'shopeeAffiliateId',
      'shopeeAppId',
      'shopeeAppSecret',
      'tiktokMode',
      'tiktokAppKey',
      'tiktokAppSecret',
      'tiktokAccessToken',
      'tiktokCookie',
      'tiktokDeepLinkTemplate',
      'shortenerProvider',
      'cashbackPercent',
      'minWithdrawAmount',
      'supportZalo'
    ];

    for (const key of allowedKeys) {
      if (body[key] !== undefined) {
        db.settings[key] = body[key];
      }
    }

    db.settings.cashbackPercent = Math.min(100, Math.max(1, Number(db.settings.cashbackPercent || 70)));
    db.settings.minWithdrawAmount = Math.max(0, Number(db.settings.minWithdrawAmount || 50000));

    if (body.newAdminPassword && String(body.newAdminPassword).trim().length >= 4) {
      const adminUser = db.users.find((u) => u.role === 'admin');
      if (adminUser) {
        adminUser.passwordHash = hashPassword(String(body.newAdminPassword).trim());
      }
    }

    saveDb(db);
    logger.logLeave('POST /api/admin/settings', {
      shopeeAffiliateId: db.settings.shopeeAffiliateId,
      cashbackPercent: db.settings.cashbackPercent
    });
    return res.json({ settings: db.settings });
  });

  // Create or Update Order (Calculates 70% User / 30% Admin automatically)
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

    const rate = Number(db.settings.cashbackPercent || 70);
    const comm = Math.round(Number(totalCommission || 0));
    const userShare = Math.round((comm * rate) / 100);
    const adminShare = comm - userShare;

    const cleanCode = String(userCode || 'ADMIN').trim().toUpperCase();
    const matchedUser = db.users.find(
      (u) => u.code.toUpperCase() === cleanCode || u.phone === cleanCode
    );

    let targetOrder = db.orders.find(
      (o) => (id && o.id === id) || o.orderSn.toUpperCase() === String(orderSn).trim().toUpperCase()
    );

    if (targetOrder) {
      targetOrder.orderSn = String(orderSn).trim().toUpperCase();
      targetOrder.platform = platform || targetOrder.platform;
      targetOrder.userCode = matchedUser ? matchedUser.code : cleanCode;
      targetOrder.userId = matchedUser ? matchedUser.id : targetOrder.userId;
      targetOrder.productName = productName || targetOrder.productName;
      targetOrder.orderAmount = Number(orderAmount ?? targetOrder.orderAmount);
      targetOrder.totalCommission = comm;
      targetOrder.cashbackRate = rate;
      targetOrder.userCashbackAmount = userShare;
      targetOrder.adminShareAmount = adminShare;
      targetOrder.status = status || targetOrder.status;
      targetOrder.updatedAt = new Date().toISOString();
    } else {
      targetOrder = {
        id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        orderSn: String(orderSn).trim().toUpperCase(),
        platform: platform === 'tiktok' ? 'tiktok' : 'shopee',
        userCode: matchedUser ? matchedUser.code : cleanCode,
        userId: matchedUser ? matchedUser.id : null,
        productName: productName || `Đơn hàng ${orderSn}`,
        orderAmount: Number(orderAmount || 0),
        totalCommission: comm,
        cashbackRate: rate,
        userCashbackAmount: userShare,
        adminShareAmount: adminShare,
        status: status || 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.orders.unshift(targetOrder);
    }

    recalculateAllWallets();
    saveDb(db);

    logger.logLeave('POST /api/admin/orders', {
      orderSn: targetOrder.orderSn,
      userShare,
      adminShare
    });
    return res.json({ order: targetOrder });
  });

  // Bulk Import Orders from Shopee Affiliate Conversion Report CSV
  app.post('/api/admin/import-orders', (req, res) => {
    logger.logEnter('POST /api/admin/import-orders');
    if (!requireAdmin(req, res)) return;

    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Không có dữ liệu đơn hàng để nhập.' });
    }

    const db = ensureDbLoaded();
    const rate = Number(db.settings.cashbackPercent || 70);
    let importedCount = 0;

    for (const r of rows) {
      const orderSn = String(r.orderSn || '').trim().toUpperCase();
      if (!orderSn) continue;

      const comm = Math.round(Number(r.totalCommission || 0));
      const userShare = Math.round((comm * rate) / 100);
      const adminShare = comm - userShare;
      const cleanCode = String(r.userCode || 'GUEST').trim().toUpperCase();
      const matchedUser = db.users.find(
        (u) => u.code.toUpperCase() === cleanCode || u.phone === cleanCode
      );

      const existing = db.orders.find((o) => o.orderSn.toUpperCase() === orderSn);
      if (existing) {
        existing.totalCommission = comm;
        existing.cashbackRate = rate;
        existing.userCashbackAmount = userShare;
        existing.adminShareAmount = adminShare;
        if (r.orderAmount) existing.orderAmount = Number(r.orderAmount);
        if (r.productName) existing.productName = r.productName;
        if (r.status) existing.status = r.status;
        if (matchedUser) {
          existing.userId = matchedUser.id;
          existing.userCode = matchedUser.code;
        }
        existing.updatedAt = new Date().toISOString();
      } else {
        db.orders.unshift({
          id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          orderSn,
          platform: r.platform === 'tiktok' ? 'tiktok' : 'shopee',
          userCode: matchedUser ? matchedUser.code : cleanCode,
          userId: matchedUser ? matchedUser.id : null,
          productName: r.productName || `Đơn hàng ${orderSn}`,
          orderAmount: Number(r.orderAmount || 0),
          totalCommission: comm,
          cashbackRate: rate,
          userCashbackAmount: userShare,
          adminShareAmount: adminShare,
          status: r.status || 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      importedCount++;
    }

    recalculateAllWallets();
    saveDb(db);
    logger.logLeave('POST /api/admin/import-orders', { importedCount });
    return res.json({ importedCount });
  });

  // Update Withdrawal Status
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
}

module.exports = {
  registerCashbackRoutes
};
