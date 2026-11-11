const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const IS_VERCEL = Boolean(process.env.VERCEL);
const LOCAL_DB_PATH = IS_VERCEL
  ? path.join('/tmp', 'hoantienshop_db.json')
  : path.join(__dirname, '..', '..', 'data', 'db.json');

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password) + '_hoantienshop_salt').digest('hex');
}

function getInitialData() {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  return {
    settings: {
      siteName: 'Hoàn Tiền Shop',
      shopeeMode: process.env.SHOPEE_MODE || 'an_redir',
      shopeeAffiliateId: process.env.SHOPEE_AFFILIATE_ID || '17388899900',
      shopeeAppId: process.env.SHOPEE_APP_ID || '',
      shopeeAppSecret: process.env.SHOPEE_APP_SECRET || '',
      tiktokMode: process.env.TIKTOK_MODE || 'clean_extract',
      tiktokAppKey: process.env.TIKTOK_APP_KEY || '',
      tiktokAppSecret: process.env.TIKTOK_APP_SECRET || '',
      tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
      tiktokCookie: process.env.TIKTOK_COOKIE || '',
      tiktokDeepLinkTemplate: process.env.TIKTOK_DEEPLINK_TEMPLATE || '',
      shortenerProvider: process.env.SHORTENER_PROVIDER || 'isgd',
      cashbackPercent: Number(process.env.CASHBACK_PERCENT || 70),
      minWithdrawAmount: Number(process.env.MIN_WITHDRAW || 50000),
      supportZalo: process.env.SUPPORT_ZALO || '0900000000'
    },
    users: [
      {
        id: 'usr_admin',
        code: 'ADMIN',
        name: 'Quản Trị Viên (Chủ Shop)',
        phone: 'admin',
        email: 'admin@hoantienshop.vn',
        passwordHash: hashPassword(adminPassword),
        role: 'admin',
        balanceAvailable: 0,
        balancePending: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        bankName: 'MBBank',
        bankAccount: '',
        bankOwner: 'TRUNG VUONG',
        createdAt: new Date().toISOString()
      }
    ],
    orders: [
      {
        id: 'ord_demo_1',
        orderSn: '261111ABC8899',
        platform: 'shopee',
        userCode: 'ADMIN',
        userId: 'usr_admin',
        productName: 'Tai nghe Bluetooth Chống Ồn Hoco W35 Chính Hãng',
        orderAmount: 250000,
        totalCommission: 35000,
        cashbackRate: 70,
        userCashbackAmount: 24500,
        adminShareAmount: 10500,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    withdrawals: [],
    linkLogs: []
  };
}

let memoryCache = null;

function ensureDbLoaded() {
  if (memoryCache) return memoryCache;

  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      const initial = getInitialData();
      memoryCache = {
        settings: { ...initial.settings, ...(parsed.settings || {}) },
        users: Array.isArray(parsed.users) && parsed.users.length > 0 ? parsed.users : initial.users,
        orders: Array.isArray(parsed.orders) ? parsed.orders : initial.orders,
        withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : [],
        linkLogs: Array.isArray(parsed.linkLogs) ? parsed.linkLogs : []
      };
      // If ENV variable SHOPEE_AFFILIATE_ID is set, always prioritize it if DB still has placeholder
      if (
        process.env.SHOPEE_AFFILIATE_ID &&
        memoryCache.settings.shopeeAffiliateId === '17388899900'
      ) {
        memoryCache.settings.shopeeAffiliateId = process.env.SHOPEE_AFFILIATE_ID;
      }
      return memoryCache;
    }
  } catch (err) {
    logger.warning('ensureDbLoaded', 'Failed reading DB file, initializing fresh DB', {
      error: err.message
    });
  }

  memoryCache = getInitialData();
  saveDb(memoryCache);
  return memoryCache;
}

function saveDb(data = memoryCache) {
  try {
    const dir = path.dirname(LOCAL_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warning('saveDb', 'Could not write DB file to disk', { error: err.message });
  }
}

/**
 * Recalculate a user's wallet balances based on their orders and withdrawals.
 */
function recalculateUserWallet(userId) {
  logger.logEnter('recalculateUserWallet', { userId });
  const db = ensureDbLoaded();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;

  const userOrders = db.orders.filter(
    (o) => o.userId === user.id || (o.userCode && o.userCode.toUpperCase() === user.code.toUpperCase())
  );

  let pending = 0;
  let approvedTotal = 0;

  for (const ord of userOrders) {
    const amt = Number(ord.userCashbackAmount || 0);
    if (ord.status === 'pending') {
      pending += amt;
    } else if (ord.status === 'approved') {
      approvedTotal += amt;
    }
  }

  const userWithdrawals = db.withdrawals.filter((w) => w.userId === user.id);
  let withdrawnOrLocked = 0;
  let paidTotal = 0;

  for (const w of userWithdrawals) {
    const amt = Number(w.amount || 0);
    if (w.status === 'pending' || w.status === 'paid') {
      withdrawnOrLocked += amt;
    }
    if (w.status === 'paid') {
      paidTotal += amt;
    }
  }

  user.balancePending = Math.max(0, Math.round(pending));
  user.totalEarned = Math.max(0, Math.round(approvedTotal));
  user.totalWithdrawn = Math.max(0, Math.round(paidTotal));
  user.balanceAvailable = Math.max(0, Math.round(approvedTotal - withdrawnOrLocked));

  saveDb(db);
  logger.logLeave('recalculateUserWallet', {
    userId,
    balanceAvailable: user.balanceAvailable,
    balancePending: user.balancePending
  });
  return user;
}

function recalculateAllWallets() {
  const db = ensureDbLoaded();
  for (const u of db.users) {
    recalculateUserWallet(u.id);
  }
}

function createToken(user) {
  const payload = {
    id: user.id,
    code: user.code,
    role: user.role,
    iat: Date.now()
  };
  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'hoantienshop_secret_key_2026')
    .update(base64)
    .digest('base64url');
  return `${base64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [base64, sig] = token.split('.');
  const expectedSig = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'hoantienshop_secret_key_2026')
    .update(base64)
    .digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(base64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

module.exports = {
  ensureDbLoaded,
  saveDb,
  hashPassword,
  recalculateUserWallet,
  recalculateAllWallets,
  createToken,
  verifyToken,
  sanitizeUser
};
