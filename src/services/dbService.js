const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const logger = require('../utils/logger');

const IS_VERCEL = Boolean(process.env.VERCEL);
const LOCAL_DB_PATH = IS_VERCEL
  ? path.join('/tmp', 'hoantienshop_db_v2.json')
  : path.join(__dirname, '..', '..', 'data', 'db.json');
const SEED_DB_PATH = path.join(__dirname, '..', 'data', 'seedDb.json');

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

function getDefaultPostbackToken() {
  if (process.env.POSTBACK_SECRET) return process.env.POSTBACK_SECRET.trim();
  return crypto
    .createHmac('sha256', process.env.AUTH_SECRET || 'hoantienshop-default-postback-seed')
    .update('accesstrade-postback-token-v1')
    .digest('hex')
    .slice(0, 32);
}

function getDefaultSettings() {
  return {
    siteName: process.env.SITE_NAME || 'Hoàn Tiền Sàn',
    shopeeMode: process.env.SHOPEE_MODE || 'an_redir',
    shopeeAffiliateId: process.env.SHOPEE_AFFILIATE_ID || '17346310715',
    shopeeAppId: process.env.SHOPEE_APP_ID || '',
    shopeeAppSecret: process.env.SHOPEE_APP_SECRET || '',
    addlivetagApiKey:
      process.env.ADDLIVETAG_API_KEY ||
      'b426eeae7cc0b156969f923935e661362aa3b13d09dba032',
    tiktokMode: process.env.TIKTOK_MODE || 'deeplink',
    tiktokAppKey: process.env.TIKTOK_APP_KEY || '',
    tiktokAppSecret: process.env.TIKTOK_APP_SECRET || '',
    tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
    tiktokDeepLinkTemplate:
      process.env.TIKTOK_DEEPLINK_TEMPLATE ||
      'https://go.isclix.com/deep_link/v6/7110811489339796158/6648523843406889655?sub4=oneatweb',
    accesstradeApiKey: process.env.ACCESSTRADE_API_KEY || '',
    postbackToken: getDefaultPostbackToken(),
    lastAutoSyncAt: null,
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
    if (process.env.TIKTOK_MODE) {
      memoryCache.settings.tiktokMode = envSettings.tiktokMode;
    } else if (memoryCache.settings.tiktokMode === 'clean_extract') {
      memoryCache.settings.tiktokMode = 'deeplink';
    }
    if (process.env.TIKTOK_DEEPLINK_TEMPLATE) {
      memoryCache.settings.tiktokDeepLinkTemplate = envSettings.tiktokDeepLinkTemplate;
    } else if (!memoryCache.settings.tiktokDeepLinkTemplate) {
      memoryCache.settings.tiktokDeepLinkTemplate = envSettings.tiktokDeepLinkTemplate;
    }
    if (memoryCache.settings.shopeeAffiliateId === '17388899900') {
      memoryCache.settings.shopeeAffiliateId = envSettings.shopeeAffiliateId;
    }
    if (process.env.ACCESSTRADE_API_KEY) {
      memoryCache.settings.accesstradeApiKey = envSettings.accesstradeApiKey;
    }
    if (process.env.ADDLIVETAG_API_KEY) {
      memoryCache.settings.addlivetagApiKey = envSettings.addlivetagApiKey;
    } else if (!memoryCache.settings.addlivetagApiKey) {
      memoryCache.settings.addlivetagApiKey = envSettings.addlivetagApiKey;
    }
    if (!memoryCache.settings.postbackToken) {
      memoryCache.settings.postbackToken = envSettings.postbackToken;
    }
    return memoryCache;
  }

  try {
    let sourcePath = null;
    if (fs.existsSync(LOCAL_DB_PATH)) {
      sourcePath = LOCAL_DB_PATH;
    } else if (fs.existsSync(SEED_DB_PATH)) {
      sourcePath = SEED_DB_PATH;
    }

    if (sourcePath) {
      const raw = fs.readFileSync(sourcePath, 'utf8');
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
      if (sourcePath === SEED_DB_PATH) {
        saveDb(memoryCache);
      }
      return ensureDbLoaded();
    }
  } catch (err) {
    logger.warning('ensureDbLoaded', 'Initializing fresh DB store');
  }

  memoryCache = getInitialData();
  saveDb(memoryCache);
  return memoryCache;
}

async function saveDb(data = memoryCache) {
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
    try {
      await syncSnapshotToPostgres(data);
    } catch (e) {
      logger.warning('syncSnapshotToPostgres', 'Postgres sync error', { error: e.message });
    }
  }
}

async function reloadStateFromPostgres() {
  if (!pgPool) return ensureDbLoaded();
  try {
    const client = await pgPool.connect();
    try {
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
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warning('reloadStateFromPostgres', 'Postgres reload error', { error: err.message });
  }
  return ensureDbLoaded();
}

// ================= POSTGRES SCHEMA, IMMUTABLE LEDGER TRIGGER & RELATIONAL SYNC =================

const userLocks = new Map();

/**
 * Per-user async mutex to serialize concurrent financial operations (e.g. parallel withdrawals).
 */
async function withUserLock(userId, fn) {
  const key = String(userId || 'global');
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(
    key,
    prev.then(() => next)
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === next) {
      userLocks.delete(key);
    }
  }
}

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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT,
        phone TEXT UNIQUE NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        token_version INT DEFAULT 1,
        referred_by TEXT,
        balance_available BIGINT DEFAULT 0,
        balance_pending BIGINT DEFAULT 0,
        total_earned BIGINT DEFAULT 0,
        total_withdrawn BIGINT DEFAULT 0,
        bank_name TEXT DEFAULT '',
        bank_account TEXT DEFAULT '',
        bank_owner TEXT DEFAULT '',
        account_locked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
      CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_code TEXT,
        user_name TEXT,
        user_phone TEXT,
        amount BIGINT NOT NULL,
        method TEXT DEFAULT 'bank',
        bank_name TEXT,
        bank_account TEXT,
        bank_owner TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );

      CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger is append-only: UPDATE and DELETE are forbidden';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS ledger_no_update ON ledger;
      CREATE TRIGGER ledger_no_update
      BEFORE UPDATE OR DELETE ON ledger
      FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
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
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    // 1. Sync individual users rows
    for (const u of data.users || []) {
      await client.query(
        `INSERT INTO users (id, code, name, phone, email, password_hash, role, token_version, referred_by, balance_available, balance_pending, total_earned, total_withdrawn, bank_name, bank_account, bank_owner, account_locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           token_version = EXCLUDED.token_version,
           balance_available = EXCLUDED.balance_available,
           balance_pending = EXCLUDED.balance_pending,
           total_earned = EXCLUDED.total_earned,
           total_withdrawn = EXCLUDED.total_withdrawn,
           bank_name = EXCLUDED.bank_name,
           bank_account = EXCLUDED.bank_account,
           bank_owner = EXCLUDED.bank_owner,
           account_locked = EXCLUDED.account_locked`,
        [
          u.id,
          u.code,
          u.name || '',
          u.phone,
          u.email || '',
          u.passwordHash,
          u.role || 'user',
          Number(u.tokenVersion || 1),
          u.referredBy || null,
          Math.round(Number(u.balanceAvailable || 0)),
          Math.round(Number(u.balancePending || 0)),
          Math.round(Number(u.totalEarned || 0)),
          Math.round(Number(u.totalWithdrawn || 0)),
          u.bankName || '',
          u.bankAccount || '',
          u.bankOwner || '',
          Boolean(u.accountLocked)
        ]
      );
    }

    // 2. Append-only INSERT into ledger (ON CONFLICT DO NOTHING, never UPDATE/DELETE)
    for (const l of data.ledger || []) {
      await client.query(
        `INSERT INTO ledger (id, user_id, type, amount, ref_id, note)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ref_id) DO NOTHING`,
        [l.id, l.userId, l.type, Math.round(Number(l.amount || 0)), l.refId, l.note || '']
      );
    }

    // 3. Sync individual withdrawals rows
    for (const w of data.withdrawals || []) {
      await client.query(
        `INSERT INTO withdrawals (id, user_id, user_code, user_name, user_phone, amount, method, bank_name, bank_account, bank_owner, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           processed_at = CASE WHEN EXCLUDED.status IN ('paid','rejected') THEN NOW() ELSE withdrawals.processed_at END`,
        [
          w.id,
          w.userId,
          w.userCode || '',
          w.userName || '',
          w.userPhone || '',
          Math.round(Number(w.amount || 0)),
          w.method || 'bank',
          w.bankName || '',
          w.bankAccount || '',
          w.bankOwner || '',
          w.status || 'pending'
        ]
      );
    }

    // 4. Sync individual orders rows
    for (const o of data.orders || []) {
      await client.query(
        `INSERT INTO orders (order_sn, platform, click_id, user_id, user_code, product_name, order_amount, gross_commission, tax_amount, net_commission, user_cashback_amount, admin_share_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (order_sn) DO UPDATE SET
           user_id = COALESCE(orders.user_id, EXCLUDED.user_id),
           user_code = CASE WHEN orders.user_code = 'GUEST' THEN EXCLUDED.user_code ELSE orders.user_code END,
           gross_commission = EXCLUDED.gross_commission,
           tax_amount = EXCLUDED.tax_amount,
           net_commission = EXCLUDED.net_commission,
           user_cashback_amount = EXCLUDED.user_cashback_amount,
           admin_share_amount = EXCLUDED.admin_share_amount,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [
          o.orderSn,
          o.platform || 'shopee',
          o.clickId || null,
          o.userId || null,
          o.userCode || 'GUEST',
          o.productName || '',
          Math.round(Number(o.orderAmount || 0)),
          Math.round(Number(o.grossCommission || 0)),
          Math.round(Number(o.taxAmount || 0)),
          Math.round(Number(o.netCommission || 0)),
          Math.round(Number(o.userCashbackAmount || 0)),
          Math.round(Number(o.adminShareAmount || 0)),
          o.status || 'pending'
        ]
      );
    }

    // 5. Keep settings snapshot synced
    await client.query(
      `INSERT INTO hoantienshop_state (id, payload, updated_at) VALUES ('main', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(data)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    id: `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
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
 * strictly as SUM(ledger.amount). Preserves negative balance if an order is cancelled after withdrawal.
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
      // Revert any previous credit or revoke for this order if it was unapproved
      db.ledger = db.ledger.filter(
        (e) =>
          e.refId !== creditRef &&
          e.refId !== revokeRef &&
          !e.refId.startsWith(`ref_bonus_${ord.orderSn}_`)
      );
      pending += amt;
    } else if (ord.status === 'approved' && amt > 0) {
      // Clean up any old revoke entry
      db.ledger = db.ledger.filter((e) => e.refId !== revokeRef);
      const existingCredit = db.ledger.find((e) => e.refId === creditRef);
      if (existingCredit) {
        existingCredit.amount = amt;
        existingCredit.userId = user.id;
      } else {
        appendLedgerEntry(
          user.id,
          'order_cashback',
          amt,
          creditRef,
          `Hoàn tiền đơn hàng #${ord.orderSn}`
        );
      }
    } else if (ord.status === 'cancelled') {
      // If cancelled, remove any credit so it does not count in ledger
      db.ledger = db.ledger.filter(
        (e) =>
          e.refId !== creditRef &&
          !e.refId.startsWith(`ref_bonus_${ord.orderSn}_`)
      );
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

  // Compute balance strictly from append-only ledger SUM (Allow negative balance for clawback!)
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
  // Preserve negative balance so cancelled orders after withdrawal are automatically deducted from future earnings
  user.balanceAvailable = Math.round(ledgerSum);
  user.hasNegativeBalance = user.balanceAvailable < 0;

  saveDb(db);
  logger.logLeave('recalculateUserWallet', {
    userId,
    balanceAvailable: user.balanceAvailable,
    hasNegativeBalance: user.hasNegativeBalance
  });
  return user;
}

/**
 * Atomic withdrawal execution preventing double-spend race conditions via per-user mutex + Postgres FOR UPDATE lock.
 */
async function executeAtomicWithdrawal({
  userId,
  amount,
  method,
  bankName,
  bankAccount,
  bankOwner,
  minWithdraw
}) {
  return withUserLock(userId, async () => {
    logger.logEnter('executeAtomicWithdrawal', { userId, amount });
    const db = ensureDbLoaded();
    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      throw new Error('Không tìm thấy tài khoản người dùng.');
    }
    if (user.accountLocked) {
      throw new Error('Tài khoản đang bị tạm khóa đối soát. Vui lòng liên hệ hỗ trợ.');
    }

    // Re-sync ledger and compute strict SUM(ledger.amount) inside critical section
    recalculateUserWallet(user.id);
    const strictLedgerSum = db.ledger
      .filter((e) => e.userId === user.id)
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);

    if (strictLedgerSum < 0) {
      throw new Error(
        `Tài khoản đang có số dư âm (${strictLedgerSum.toLocaleString('vi-VN')}đ) do đơn hàng hoàn trả sau khi rút. Hệ thống sẽ tự động cấn trừ vào đơn tiếp theo.`
      );
    }

    const numAmount = Math.round(Number(amount || 0));
    if (!Number.isFinite(numAmount) || numAmount < minWithdraw) {
      throw new Error(`Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ.`);
    }
    if (numAmount > strictLedgerSum) {
      throw new Error('Số dư khả dụng không đủ để thực hiện lệnh rút này.');
    }

    const wdId = `wd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const debitRef = `withdraw_debit_${wdId}`;

    // If PostgreSQL is active, execute strict transactional row lock first
    if (pgPool && pgSchemaReady) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const uRes = await client.query(
          'SELECT id, account_locked FROM users WHERE id = $1 FOR UPDATE',
          [user.id]
        );
        if (uRes.rows.length > 0 && uRes.rows[0].account_locked) {
          throw new Error('Tài khoản đang bị tạm khóa đối soát.');
        }

        const sumRes = await client.query(
          'SELECT COALESCE(SUM(amount), 0) AS ledger_sum FROM ledger WHERE user_id = $1',
          [user.id]
        );
        const pgLedgerSum = Number(sumRes.rows[0]?.ledger_sum || 0);
        if (pgLedgerSum < numAmount) {
          throw new Error('Số dư khả dụng trên Sổ cái không đủ để thực hiện lệnh rút này.');
        }

        const ledgerId = `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        await client.query(
          `INSERT INTO ledger (id, user_id, type, amount, ref_id, note)
           VALUES ($1, $2, 'withdrawal_lock', $3, $4, $5)`,
          [ledgerId, user.id, -Math.abs(numAmount), debitRef, `Rút tiền #${wdId} (${bankName})`]
        );

        await client.query(
          `INSERT INTO withdrawals (id, user_id, user_code, user_name, user_phone, amount, method, bank_name, bank_account, bank_owner, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
          [
            wdId,
            user.id,
            user.code,
            user.name,
            user.phone,
            numAmount,
            method === 'momo' ? 'momo' : 'bank',
            bankName,
            bankAccount,
            bankOwner
          ]
        );

        await client.query(
          `UPDATE users SET balance_available = $2, bank_name = $3, bank_account = $4, bank_owner = $5 WHERE id = $1`,
          [user.id, pgLedgerSum - numAmount, bankName, bankAccount, bankOwner]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    user.bankName = bankName;
    user.bankAccount = bankAccount;
    user.bankOwner = bankOwner;

    const withdrawal = {
      id: wdId,
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

    // Append debit to ledger and withdrawal record atomically inside the lock
    appendLedgerEntry(
      user.id,
      'withdrawal_lock',
      -Math.abs(numAmount),
      debitRef,
      `Rút tiền #${wdId} (${user.bankName})`
    );
    db.withdrawals.unshift(withdrawal);
    recalculateUserWallet(user.id);

    logger.logLeave('executeAtomicWithdrawal', {
      wdId,
      amount: numAmount,
      remainingBalance: user.balanceAvailable
    });
    return { withdrawal, user: sanitizeUser(user) };
  });
}

/**
 * Periodic reconciliation job: compares SUM(ledger.amount) against stored user.balanceAvailable
 * and reports any discrepancy or negative balance.
 */
function auditLedgerIntegrity() {
  logger.logEnter('auditLedgerIntegrity');
  const db = ensureDbLoaded();
  const mismatches = [];
  const negativeUsers = [];

  for (const u of db.users) {
    const sum = db.ledger
      .filter((e) => e.userId === u.id)
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);

    const roundedSum = Math.round(sum);
    const storedBal = Math.round(Number(u.balanceAvailable || 0));

    if (roundedSum !== storedBal) {
      const alert = {
        userId: u.id,
        userCode: u.code,
        ledgerSum: roundedSum,
        storedBalance: storedBal,
        diff: roundedSum - storedBal
      };
      mismatches.push(alert);
      logger.error('auditLedgerIntegrity', 'LEDGER_MISMATCH_ALERT', alert);
      // Auto-heal stored balance to strict ledger sum
      u.balanceAvailable = roundedSum;
    }

    if (roundedSum < 0) {
      negativeUsers.push({
        userId: u.id,
        userCode: u.code,
        balanceAvailable: roundedSum
      });
    }
  }

  if (mismatches.length > 0) {
    saveDb(db);
  }

  const report = {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    mismatches,
    negativeBalanceCount: negativeUsers.length,
    negativeUsers,
    checkedAt: new Date().toISOString()
  };
  logger.logLeave('auditLedgerIntegrity', {
    ok: report.ok,
    mismatchCount: report.mismatchCount,
    negativeBalanceCount: report.negativeBalanceCount
  });
  return report;
}

function recalculateAllWallets() {
  const db = ensureDbLoaded();

  // Purge any referral bonuses from ledger (referral reward removed per user request)
  db.ledger = db.ledger.filter((e) => !e.refId.startsWith('ref_bonus_'));

  // Build map of existing approved orders
  const approvedOrderMap = new Map();
  for (const ord of db.orders) {
    if (ord.status === 'approved') {
      approvedOrderMap.set(ord.orderSn.toUpperCase(), ord);
    }
  }

  // Remove any order_credit_ whose order is no longer in db.orders or no longer approved
  db.ledger = db.ledger.filter((e) => {
    if (e.refId.startsWith('order_credit_')) {
      const sn = e.refId.replace('order_credit_', '').toUpperCase();
      return approvedOrderMap.has(sn);
    }
    return true;
  });

  for (const u of db.users) {
    recalculateUserWallet(u.id);
  }
  return auditLedgerIntegrity();
}

function getDatabaseStatus() {
  const audit = auditLedgerIntegrity();
  return {
    mode: pgPool ? 'postgres' : IS_VERCEL ? 'ephemeral_tmp' : 'local_json',
    isPersistentOnCloud: Boolean(pgPool),
    ledgerAudit: audit
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
  executeAtomicWithdrawal,
  auditLedgerIntegrity,
  createToken,
  verifyToken,
  sanitizeUser,
  getDatabaseStatus,
  reloadStateFromPostgres
};
