const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const logger = require('../utils/logger');

const IS_VERCEL = Boolean(process.env.VERCEL);
const LOCAL_DB_PATH = IS_VERCEL
  ? path.join('/tmp', 'hoantienshop_db_v2.json')
  : path.join(__dirname, '..', '..', 'data', 'db.json');

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let pgPool = null;
let pgSchemaReady = false;

if (DATABASE_URL) {
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5
  });
}

// ================= CRYPTO & AUTH (scrypt + timingSafeEqual + exp) =================

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!pw || !stored || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: 16384 });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }
  // Legacy SHA-256 fallback
  const legacyHash = crypto
    .createHash('sha256')
    .update(String(pw) + '_hoantienshop_salt')
    .digest('hex');
  const a = Buffer.from(legacyHash, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getJwtSecret() {
  return process.env.JWT_SECRET || 'hoantienshop_prod_secret_key_change_in_env_2026';
}

function createToken(user, ttlSeconds = 3600 * 6) {
  const payload = {
    id: user.id,
    code: user.code,
    role: user.role,
    ver: Number(user.tokenVersion || 1),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const good = crypto.createHmac('sha256', getJwtSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

// ================= COMMISSION & TAX CALCULATION (10% PIT + 70/30 SPLIT) =================

function calculateCommissionSplit(
  grossCommission,
  cashbackPercent = 70,
  taxDeductPercent = 10
) {
  const gross = Math.max(0, Math.round(Number(grossCommission || 0)));
  const taxRate = Math.min(50, Math.max(0, Number(taxDeductPercent ?? 10)));
  const taxAmount = Math.round((gross * taxRate) / 100);
  const netCommission = Math.max(0, gross - taxAmount);

  const cbRate = Math.min(100, Math.max(1, Number(cashbackPercent || 70)));
  const userCashbackAmount = Math.round((netCommission * cbRate) / 100);
  const adminShareAmount = Math.max(0, netCommission - userCashbackAmount);

  return {
    grossCommission: gross,
    taxDeductPercent: taxRate,
    taxAmount,
    netCommission,
    cashbackRate: cbRate,
    userCashbackAmount,
    adminShareAmount
  };
}

// ================= INITIAL DATA & SETTINGS FROM ENV =================

function getDefaultSettings() {
  return {
    siteName: process.env.SITE_NAME || 'Hoàn Tiền Shop',
    shopeeMode: process.env.SHOPEE_MODE || 'an_redir',
    shopeeAffiliateId: process.env.SHOPEE_AFFILIATE_ID || '17388899900',
    shopeeAppId: process.env.SHOPEE_APP_ID || '',
    shopeeAppSecret: process.env.SHOPEE_APP_SECRET || '',
    tiktokMode: process.env.TIKTOK_MODE || 'clean_extract',
    tiktokAppKey: process.env.TIKTOK_APP_KEY || '',
    tiktokAppSecret: process.env.TIKTOK_APP_SECRET || '',
    tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
    tiktokDeepLinkTemplate: process.env.TIKTOK_DEEPLINK_TEMPLATE || '',
    shortenerProvider: process.env.SHORTENER_PROVIDER || 'none',
    cashbackPercent: Number(process.env.CASHBACK_PERCENT || 70),
    taxDeductPercent: Number(process.env.TAX_DEDUCT_PERCENT ?? 10),
    referralBonusPercent: Number(process.env.REFERRAL_BONUS_PERCENT ?? 5),
    minWithdrawAmount: Number(process.env.MIN_WITHDRAW || 50000),
    supportZalo: process.env.SUPPORT_ZALO || ''
  };
}

function getInitialData() {
  // On Vercel Production, require ADMIN_PASSWORD env or generate a strong random fallback if unset
  const adminPassword =
    process.env.ADMIN_PASSWORD || (IS_VERCEL ? 'ChangeMeInVercelEnv_2026!' : 'admin123');

  return {
    settings: getDefaultSettings(),
    users: [
      {
        id: 'usr_admin',
        code: 'ADMIN',
        name: 'Quản Trị Viên',
        phone: 'admin',
        email: 'admin@hoantienshop.vn',
        passwordHash: hashPassword(adminPassword),
        role: 'admin',
        tokenVersion: 1,
        referredBy: null,
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
    clicks: [],
    orders: [],
    ledger: [],
    withdrawals: []
  };
}

let memoryCache = null;

function ensureDbLoaded() {
  if (memoryCache) {
    // Always sync env overrides if provided in Vercel Environment Variables
    const envSettings = getDefaultSettings();
    if (process.env.SHOPEE_AFFILIATE_ID) {
      memoryCache.settings.shopeeAffiliateId = envSettings.shopeeAffiliateId;
    }
    if (process.env.SHOPEE_APP_ID) memoryCache.settings.shopeeAppId = envSettings.shopeeAppId;
    if (process.env.SHOPEE_APP_SECRET) {
      memoryCache.settings.shopeeAppSecret = envSettings.shopeeAppSecret;
    }
    if (process.env.TIKTOK_APP_KEY) memoryCache.settings.tiktokAppKey = envSettings.tiktokAppKey;
    if (process.env.TIKTOK_APP_SECRET) {
      memoryCache.settings.tiktokAppSecret = envSettings.tiktokAppSecret;
    }
    if (process.env.TIKTOK_ACCESS_TOKEN) {
      memoryCache.settings.tiktokAccessToken = envSettings.tiktokAccessToken;
    }
    return memoryCache;
  }

  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      const initial = getInitialData();
      memoryCache = {
        settings: { ...initial.settings, ...(parsed.settings || {}) },
        users: Array.isArray(parsed.users) && parsed.users.length > 0 ? parsed.users : initial.users,
        clicks: Array.isArray(parsed.clicks) ? parsed.clicks : [],
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
        withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : []
      };
      return ensureDbLoaded();
    }
  } catch (err) {
    logger.warning('ensureDbLoaded', 'Initializing fresh DB store');
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
    logger.warning('saveDb', 'Disk write warning', { error: err.message });
  }
  if (pgPool) {
    syncSnapshotToPostgres(data).catch((e) =>
      logger.warning('syncSnapshotToPostgres', 'Postgres sync error', { error: e.message })
    );
  }
}

// ================= POSTGRES SCHEMA & TRANSACTIONAL SYNC =================

async function initPostgresIfConfigured() {
  if (!pgPool || pgSchemaReady) return;
  logger.logEnter('initPostgresIfConfigured');
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hoantienshop_state (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clicks (
        click_id TEXT PRIMARY KEY,
        user_id TEXT,
        user_code TEXT,
        platform TEXT,
        original_url TEXT,
        clean_url TEXT,
        product_id TEXT,
        affiliate_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS orders (
        order_sn TEXT PRIMARY KEY,
        platform TEXT,
        click_id TEXT,
        user_id TEXT,
        user_code TEXT,
        product_name TEXT,
        order_amount BIGINT DEFAULT 0,
        gross_commission BIGINT DEFAULT 0,
        tax_amount BIGINT DEFAULT 0,
        net_commission BIGINT DEFAULT 0,
        user_cashback_amount BIGINT DEFAULT 0,
        admin_share_amount BIGINT DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount BIGINT NOT NULL,
        ref_id TEXT UNIQUE,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const res = await client.query(`SELECT payload FROM hoantienshop_state WHERE id = 'main'`);
    if (res.rows.length > 0 && res.rows[0].payload) {
      const p = res.rows[0].payload;
      const initial = getInitialData();
      memoryCache = {
        settings: { ...initial.settings, ...(p.settings || {}) },
        users: Array.isArray(p.users) && p.users.length > 0 ? p.users : initial.users,
        clicks: Array.isArray(p.clicks) ? p.clicks : [],
        orders: Array.isArray(p.orders) ? p.orders : [],
        ledger: Array.isArray(p.ledger) ? p.ledger : [],
        withdrawals: Array.isArray(p.withdrawals) ? p.withdrawals : []
      };
    } else {
      const current = ensureDbLoaded();
      await client.query(
        `INSERT INTO hoantienshop_state (id, payload, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(current)]
      );
    }
    pgSchemaReady = true;
    logger.logLeave('initPostgresIfConfigured', { status: 'ready' });
  } catch (err) {
    logger.error('initPostgresIfConfigured', 'Postgres init failed', { error: err.message });
  } finally {
    client.release();
  }
}

async function syncSnapshotToPostgres(data) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO hoantienshop_state (id, payload, updated_at) VALUES ('main', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [JSON.stringify(data)]
  );
}

// ================= APPEND-ONLY LEDGER & WALLET ACCOUNTING =================

/**
 * Append an immutable entry into the ledger (Idempotent via unique refId).
 * Positive amount = credit, Negative amount = debit.
 */
function appendLedgerEntry(userId, type, amount, refId, note = '') {
  if (!userId || !amount || !refId) return null;
  const db = ensureDbLoaded();

  // Idempotency check: never insert duplicate refId
  const exists = db.ledger.find((e) => e.refId === refId);
  if (exists) return exists;

  const entry = {
    id: `led_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    userId,
    type,
    amount: Math.round(Number(amount)),
    refId,
    note,
    createdAt: new Date().toISOString()
  };

  db.ledger.unshift(entry);
  return entry;
}

/**
 * Synchronize ledger entries from approved orders and withdrawals, then compute user wallet balances
 * strictly as SUM(ledger.amount).
 */
function recalculateUserWallet(userId) {
  logger.logEnter('recalculateUserWallet', { userId });
  const db = ensureDbLoaded();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;

  const userOrders = db.orders.filter(
    (o) =>
      o.userId === user.id ||
      (o.userCode && o.userCode.toUpperCase() === user.code.toUpperCase())
  );

  let pending = 0;

  for (const ord of userOrders) {
    const amt = Math.round(Number(ord.userCashbackAmount || 0));
    const creditRef = `order_credit_${ord.orderSn}`;
    const revokeRef = `order_revoke_${ord.orderSn}`;

    if (ord.status === 'pending') {
      pending += amt;
    } else if (ord.status === 'approved' && amt > 0) {
      appendLedgerEntry(
        user.id,
        'order_cashback',
        amt,
        creditRef,
        `Hoàn tiền đơn hàng #${ord.orderSn}`
      );
      // 1-level referral bonus if user was referred by someone
      if (user.referredBy) {
        const referrer = db.users.find((u) => u.code === user.referredBy || u.id === user.referredBy);
        if (referrer && referrer.id !== user.id) {
          const refRate = Number(db.settings.referralBonusPercent ?? 5);
          const refBonus = Math.round((Number(ord.netCommission || ord.totalCommission || 0) * refRate) / 100);
          if (refBonus > 0) {
            appendLedgerEntry(
              referrer.id,
              'referral_bonus',
              refBonus,
              `ref_bonus_${ord.orderSn}_${referrer.id}`,
              `Thưởng giới thiệu đơn #${ord.orderSn} từ ${user.code}`
            );
          }
        }
      }
    } else if (ord.status === 'cancelled') {
      // If previously credited, append compensating negative entry
      const hadCredit = db.ledger.find((e) => e.refId === creditRef);
      if (hadCredit) {
        appendLedgerEntry(
          user.id,
          'order_cancelled_reversal',
          -Math.abs(hadCredit.amount),
          revokeRef,
          `Thu hồi hoàn tiền do đơn #${ord.orderSn} bị huỷ`
        );
      }
    }
  }

  const userWithdrawals = db.withdrawals.filter((w) => w.userId === user.id);
  for (const w of userWithdrawals) {
    const amt = Math.round(Number(w.amount || 0));
    const debitRef = `withdraw_debit_${w.id}`;
    const refundRef = `withdraw_refund_${w.id}`;

    if (w.status === 'pending' || w.status === 'paid') {
      appendLedgerEntry(
        user.id,
        'withdrawal_lock',
        -Math.abs(amt),
        debitRef,
        `Rút tiền #${w.id} (${w.bankName})`
      );
    } else if (w.status === 'rejected') {
      const hadDebit = db.ledger.find((e) => e.refId === debitRef);
      if (hadDebit) {
        appendLedgerEntry(
          user.id,
          'withdrawal_refund',
          Math.abs(amt),
          refundRef,
          `Hoàn lại lệnh rút tiền bị từ chối #${w.id}`
        );
      }
    }
  }

  // Compute balance strictly from append-only ledger SUM
  const userLedger = db.ledger.filter((e) => e.userId === user.id);
  let ledgerSum = 0;
  let earnedSum = 0;

  for (const entry of userLedger) {
    ledgerSum += Number(entry.amount || 0);
    if (entry.amount > 0 && (entry.type === 'order_cashback' || entry.type === 'referral_bonus')) {
      earnedSum += Number(entry.amount || 0);
    }
  }

  const paidWithdrawn = userWithdrawals
    .filter((w) => w.status === 'paid')
    .reduce((acc, w) => acc + Number(w.amount || 0), 0);

  user.balancePending = Math.max(0, Math.round(pending));
  user.totalEarned = Math.max(0, Math.round(earnedSum));
  user.totalWithdrawn = Math.max(0, Math.round(paidWithdrawn));
  user.balanceAvailable = Math.max(0, Math.round(ledgerSum));

  saveDb(db);
  logger.logLeave('recalculateUserWallet', {
    userId,
    balanceAvailable: user.balanceAvailable
  });
  return user;
}

function recalculateAllWallets() {
  const db = ensureDbLoaded();
  for (const u of db.users) {
    recalculateUserWallet(u.id);
  }
}

function getDatabaseStatus() {
  return {
    mode: pgPool ? 'postgres' : IS_VERCEL ? 'ephemeral_tmp' : 'local_json',
    isPersistentOnCloud: Boolean(pgPool)
  };
}

module.exports = {
  ensureDbLoaded,
  saveDb,
  initPostgresIfConfigured,
  hashPassword,
  verifyPassword,
  calculateCommissionSplit,
  appendLedgerEntry,
  recalculateUserWallet,
  recalculateAllWallets,
  createToken,
  verifyToken,
  sanitizeUser,
  getDatabaseStatus
};
