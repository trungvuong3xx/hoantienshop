const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const logger = require('../utils/logger');

const IS_VERCEL = Boolean(process.env.VERCEL);
const IS_PROD = IS_VERCEL || process.env.NODE_ENV === 'production';

const LOCAL_DB_PATH = IS_VERCEL
  ? path.join('/tmp', 'hoantienshop_db_v2.json')
  : path.join(__dirname, '..', '..', 'data', 'db.json');
const SEED_DB_PATH = path.join(__dirname, '..', 'data', 'seedDb.json');

// ================= ENVIRONMENT PARSER (.env with quotes and export support) =================

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const k = line.slice(0, eqIdx).trim();
      let v = line.slice(eqIdx + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      result[k] = v;
    }
  }
  return result;
}

// Load .env fallback if not present in process.env
const localEnvPath = path.join(__dirname, '..', '..', '.env');
const parsedFileEnv = parseEnvFile(localEnvPath);
for (const [k, v] of Object.entries(parsedFileEnv)) {
  if (!process.env[k]) {
    process.env[k] = v;
  }
}

let DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
let pgPool = null;
let pgSchemaReady = false;
let dbInitPromise = null;

if (DATABASE_URL) {
  try {
    let isLocal = false;
    try {
      const parsedUrl = new URL(DATABASE_URL);
      isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
    } catch {
      isLocal = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
    }

    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000
    });

    pgPool.on('error', (err) => {
      logger.error('pgPool', 'Postgres idle client error', { error: err.message });
    });
  } catch (err) {
    logger.error('pgPool', 'Failed to configure Postgres pool', { error: err.message });
  }
}

// ================= CRYPTO & AUTH (scrypt + timingSafeEqual + exp) =================

function hashPassword(pw) {
  if (!pw || typeof pw !== 'string' || pw.length < 6) {
    throw new Error('Mật khẩu không hợp lệ, yêu cầu tối thiểu 6 ký tự.');
  }
  if (pw.length > 128) {
    throw new Error('Mật khẩu không được vượt quá 128 ký tự.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!pw || !stored || typeof stored !== 'string' || pw.length > 128) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, {
      N: 16384,
      r: 8,
      p: 1
    });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }
  // Legacy SHA-256 fallback (auto-upgrades upon successful login in controller)
  const legacyHash = crypto
    .createHash('sha256')
    .update(String(pw) + '_hoantienshop_salt')
    .digest('hex');
  const a = Buffer.from(legacyHash, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let cachedJwtSecret = null;
function getJwtSecret() {
  if (cachedJwtSecret) return cachedJwtSecret;
  const secret = (process.env.JWT_SECRET || process.env.AUTH_SECRET || '').trim();
  if (secret) {
    if (secret.length < 32) {
      cachedJwtSecret = crypto.createHash('sha256').update(secret).digest('hex');
      return cachedJwtSecret;
    }
    cachedJwtSecret = secret;
    return cachedJwtSecret;
  }
  if (IS_PROD) {
    throw new Error('Bắt buộc phải cấu hình biến môi trường JWT_SECRET (hoặc AUTH_SECRET) trên Production.');
  }
  // In development, generate an ephemeral unguessable random secret per process
  cachedJwtSecret = crypto.randomBytes(32).toString('hex');
  logger.warning('getJwtSecret', 'Chưa đặt JWT_SECRET trong .env, sử dụng secret ngẫu nhiên phiên làm việc.');
  return cachedJwtSecret;
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

/**
 * Whitelist sanitizer to avoid leaking internal or sensitive properties to clients/localStorage.
 */
function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id,
    code: user.code,
    name: user.name || '',
    phone: user.phone || '',
    email: user.email || '',
    role: user.role || 'user',
    balanceAvailable: Math.round(Number(user.balanceAvailable || 0)),
    balancePending: Math.round(Number(user.balancePending || 0)),
    totalEarned: Math.round(Number(user.totalEarned || 0)),
    totalWithdrawn: Math.round(Number(user.totalWithdrawn || 0)),
    bankName: user.bankName || '',
    bankAccount: user.bankAccount || '',
    bankOwner: user.bankOwner || '',
    accountLocked: Boolean(user.accountLocked),
    createdAt: user.createdAt || ''
  };
}

// ================= COMMISSION & TAX CALCULATION (10% PIT + CASHBACK SPLIT) =================

function calculateCommissionSplit(
  grossCommission,
  cashbackPercent = 70,
  taxDeductPercent = 10
) {
  const rawGross = Number(grossCommission);
  if (!Number.isFinite(rawGross) || rawGross < 0) {
    throw new Error(`Hoa hồng không hợp lệ: ${grossCommission}`);
  }
  const gross = Math.round(rawGross);

  const rawTax = Number(taxDeductPercent ?? 10);
  const taxRate = Number.isFinite(rawTax) ? Math.min(50, Math.max(0, rawTax)) : 10;
  const taxAmount = Math.round((gross * taxRate) / 100);
  const netCommission = Math.max(0, gross - taxAmount);

  const rawCb = Number(cashbackPercent ?? 70);
  const cbRate = Number.isFinite(rawCb) ? Math.min(100, Math.max(0, rawCb)) : 70;
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

// ================= INITIAL DATA & SETTINGS =================

function getDefaultPostbackToken() {
  if (process.env.POSTBACK_SECRET) return process.env.POSTBACK_SECRET.trim();
  if (process.env.AUTH_SECRET) {
    return crypto
      .createHmac('sha256', process.env.AUTH_SECRET.trim())
      .update('accesstrade-postback-token-v1')
      .digest('hex')
      .slice(0, 32);
  }
  if (IS_PROD) {
    throw new Error('Cần cấu hình POSTBACK_SECRET hoặc AUTH_SECRET trên Production.');
  }
  if (process.env.ALLOW_INSECURE_DEV === '1') {
    return 'local_dev_postback_token_secret';
  }
  throw new Error('Thiếu POSTBACK_SECRET! Hãy cấu hình trong .env hoặc bật ALLOW_INSECURE_DEV=1 cho local dev.');
}

let cachedDefaultSettings = null;
function getDefaultSettings() {
  if (cachedDefaultSettings) return { ...cachedDefaultSettings };
  const rawCb = Number(process.env.CASHBACK_PERCENT);
  const rawTax = Number(process.env.TAX_DEDUCT_PERCENT);
  const rawMinWd = Number(process.env.MIN_WITHDRAW);

  cachedDefaultSettings = {
    siteName: process.env.SITE_NAME || 'Hoàn Tiền Sàn',
    shopeeMode: process.env.SHOPEE_MODE || 'an_redir',
    shopeeAffiliateId: (process.env.SHOPEE_AFFILIATE_ID || '').trim(),
    tiktokMode: process.env.TIKTOK_MODE || 'deeplink',
    tiktokDeepLinkTemplate: (process.env.TIKTOK_DEEPLINK_TEMPLATE || '').trim(),
    cashbackPercent: Number.isFinite(rawCb) ? Math.min(100, Math.max(0, rawCb)) : 70,
    taxDeductPercent: Number.isFinite(rawTax) ? Math.min(50, Math.max(0, rawTax)) : 10,
    referralBonusPercent: 0,
    minWithdrawAmount: Number.isFinite(rawMinWd) && rawMinWd >= 0 ? rawMinWd : 50000,
    supportZalo: process.env.SUPPORT_ZALO || '',
    lastAutoSyncAt: null,
    shortenerProvider: process.env.SHORTENER_PROVIDER || 'none'
  };
  return { ...cachedDefaultSettings };
}

let cachedAdminPassword = null;
function getInitialData() {
  if (!cachedAdminPassword) {
    if (process.env.ADMIN_PASSWORD) {
      cachedAdminPassword = process.env.ADMIN_PASSWORD.trim();
    } else if (IS_PROD) {
      throw new Error('Bắt buộc phải cấu hình biến môi trường ADMIN_PASSWORD trên Production.');
    } else {
      if (process.env.ALLOW_INSECURE_DEV === '1') {
        cachedAdminPassword = 'devAdminPassword123!';
      } else {
        throw new Error('Thiếu ADMIN_PASSWORD! Hãy cấu hình trong .env hoặc bật ALLOW_INSECURE_DEV=1 cho local dev.');
      }
    }
  }

  return {
    settings: getDefaultSettings(),
    users: [
      {
        id: 'usr_admin',
        code: (process.env.ADMIN_CODE || 'TRUNGVUONG3X').trim().toUpperCase(),
        name: 'Quản Trị Viên',
        phone: (process.env.ADMIN_PHONE || 'trungvuong3x').trim(),
        email: (process.env.ADMIN_EMAIL || 'trungvuong3x@hoantiensan.online').trim(),
        passwordHash: hashPassword(cachedAdminPassword),
        role: 'admin',
        tokenVersion: 1,
        referredBy: null,
        balanceAvailable: 0,
        balancePending: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        bankName: 'MBBank',
        bankAccount: '',
        bankOwner: (process.env.ADMIN_BANK_OWNER || '').trim(),
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

function syncAdminCredentials(data) {
  if (!data || !Array.isArray(data.users)) return false;
  const admin = data.users.find((u) => u.role === 'admin');
  if (!admin) return false;

  const targetPhone = (process.env.ADMIN_PHONE || 'trungvuong3x').trim();
  const targetEmail = (process.env.ADMIN_EMAIL || 'trungvuong3x@hoantiensan.online').trim();
  const targetCode = (process.env.ADMIN_CODE || 'TRUNGVUONG3X').trim().toUpperCase();
  const targetPassword = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : null;

  let changed = false;
  if (admin.phone !== targetPhone) {
    admin.phone = targetPhone;
    changed = true;
  }
  if (admin.email !== targetEmail) {
    admin.email = targetEmail;
    changed = true;
  }
  if (admin.code !== targetCode) {
    admin.code = targetCode;
    changed = true;
  }
  if (targetPassword && !verifyPassword(targetPassword, admin.passwordHash)) {
    admin.passwordHash = hashPassword(targetPassword);
    admin.tokenVersion = Number(admin.tokenVersion || 1) + 1;
    changed = true;
  }
  return changed;
}

function normalizeState(raw, initial = null) {
  if (!raw || typeof raw !== 'object') {
    raw = {};
  }
  const defaultInit = initial || getInitialData();
  const state = {
    settings: { ...defaultInit.settings, ...(raw.settings || {}) },
    users: Array.isArray(raw.users) && raw.users.length > 0 ? raw.users : defaultInit.users,
    clicks: Array.isArray(raw.clicks) ? raw.clicks : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    withdrawals: Array.isArray(raw.withdrawals) ? raw.withdrawals : []
  };

  // Strip plaintext secrets from settings so they are never written to disk or Postgres
  delete state.settings.shopeeAppSecret;
  delete state.settings.tiktokAccessToken;
  delete state.settings.tiktokAppSecret;
  delete state.settings.addlivetagApiKey;
  delete state.settings.postbackToken;

  syncAdminCredentials(state);
  return state;
}

function ensureDbLoaded() {
  if (memoryCache) {
    // Sync active public environment variable overrides
    if (process.env.SHOPEE_AFFILIATE_ID) memoryCache.settings.shopeeAffiliateId = process.env.SHOPEE_AFFILIATE_ID.trim();
    if (process.env.TIKTOK_DEEPLINK_TEMPLATE) memoryCache.settings.tiktokDeepLinkTemplate = process.env.TIKTOK_DEEPLINK_TEMPLATE.trim();
    if (process.env.SUPPORT_ZALO) memoryCache.settings.supportZalo = process.env.SUPPORT_ZALO.trim();

    const adminChanged = syncAdminCredentials(memoryCache);
    if (adminChanged) {
      saveDb(memoryCache).catch((err) => {
        logger.warning('ensureDbLoaded', 'Lỗi lưu DB sau khi đồng bộ tài khoản admin', { error: err.message });
      });
    }
    return memoryCache;
  }

  let sourcePath = null;
  if (fs.existsSync(LOCAL_DB_PATH)) {
    sourcePath = LOCAL_DB_PATH;
  } else if (fs.existsSync(SEED_DB_PATH)) {
    sourcePath = SEED_DB_PATH;
  }

  if (sourcePath) {
    let raw;
    try {
      raw = fs.readFileSync(sourcePath, 'utf8');
    } catch (readErr) {
      logger.error('ensureDbLoaded', 'Không thể đọc file DB', { path: sourcePath, error: readErr.message });
      throw readErr;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // Protect corrupted file from truncation! Backup immediately!
      const corruptPath = `${sourcePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(sourcePath, corruptPath);
        logger.error('ensureDbLoaded', 'File DB bị lỗi JSON syntax! Đã đổi tên để bảo vệ dữ liệu.', {
          corruptPath,
          error: parseErr.message
        });
      } catch (renameErr) {
        logger.error('ensureDbLoaded', 'Không thể đổi tên file DB hỏng', { error: renameErr.message });
      }
      throw new Error(`File dữ liệu ${sourcePath} bị lỗi định dạng: ${parseErr.message}. Đã sao lưu sang ${corruptPath}`);
    }

    const initial = getInitialData();
    memoryCache = normalizeState(parsed, initial);

    if (sourcePath === SEED_DB_PATH && !pgPool) {
      saveDb(memoryCache).catch((err) => {
        logger.warning('ensureDbLoaded', 'Không thể lưu bản khởi tạo từ seed', { error: err.message });
      });
    }
    return ensureDbLoaded();
  }

  memoryCache = getInitialData();
  if (!pgPool) {
    saveDb(memoryCache).catch((err) => {
      logger.warning('ensureDbLoaded', 'Không thể lưu bản khởi tạo mới', { error: err.message });
    });
  }
  return memoryCache;
}

// ================= SERIALIZED SAVE QUEUE & ATOMIC FILE WRITES =================

let internalSaveQueue = Promise.resolve();
let pendingSavePromise = null;
let pendingSaveData = null;

async function performSaveDb(data) {
  if (!data) return;

  // Prune clicks buffer to prevent memory exhaustion
  if (Array.isArray(data.clicks) && data.clicks.length > 5000) {
    data.clicks = data.clicks.slice(-5000);
  }

  // 1. Atomic local file write
  let tmpPath = null;
  try {
    const dir = path.dirname(LOCAL_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    tmpPath = `${LOCAL_DB_PATH}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, LOCAL_DB_PATH);
    tmpPath = null;
  } catch (err) {
    logger.error('saveDb', 'Lỗi ghi đĩa local', { error: err.message });
    if (!pgPool) throw err;
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }

  // 2. Postgres sync (Only if pool exists AND schema was verified ready!)
  if (pgPool) {
    if (!pgSchemaReady) {
      logger.warning('saveDb', 'Postgres pool tồn tại nhưng schema chưa sẵn sàng. Tạm hoãn đồng bộ tránh ghi đè.');
    } else {
      await syncSnapshotToPostgres(data);
    }
  }
}

/**
 * Robust serialized save with internal queue error isolation and batch coalescing.
 * If a save fails, the caller receives the error, but the internal queue recovers immediately.
 */
function saveDb(data = memoryCache) {
  const targetData = data || memoryCache;
  if (!targetData) {
    return Promise.resolve();
  }

  // If a save is currently waiting in line, coalesce with it
  if (pendingSavePromise) {
    pendingSaveData = targetData;
    return pendingSavePromise;
  }

  let resolveCaller;
  let rejectCaller;
  const callerPromise = new Promise((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });

  pendingSavePromise = callerPromise;
  pendingSaveData = targetData;

  // Append to internal queue and ensure internal queue NEVER remains rejected
  internalSaveQueue = internalSaveQueue
    .then(async () => {
      const snapshot = pendingSaveData;
      pendingSavePromise = null;
      pendingSaveData = null;
      try {
        await performSaveDb(snapshot);
        resolveCaller();
      } catch (err) {
        logger.error('saveDb', 'Lỗi trong tác vụ lưu dữ liệu', { error: err.message });
        rejectCaller(err);
      }
    })
    .catch((queueErr) => {
      // Failsafe recovery to keep queue alive
      logger.error('saveDb', 'Lỗi bất thường trong chuỗi hàng đợi lưu', { error: queueErr.message });
      if (rejectCaller) rejectCaller(queueErr);
    });

  return callerPromise;
}

// ================= POSTGRES SCHEMA, APPEND-ONLY TRIGGER & SERIALIZATION =================

const userLocks = new Map();

/**
 * Per-user async mutex to serialize concurrent financial operations without memory leak.
 */
async function withUserLock(userId, fn) {
  const key = String(userId || 'global');
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => next);
  userLocks.set(key, tail);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === tail) {
      userLocks.delete(key);
    }
  }
}

async function initPostgresIfConfigured() {
  if (!pgPool || pgSchemaReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    logger.logEnter('initPostgresIfConfigured');
    const client = await pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS hoantienshop_state (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          version BIGINT DEFAULT 1,
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

        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_no_update') THEN
            CREATE TRIGGER ledger_no_update
            BEFORE UPDATE OR DELETE ON ledger
            FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_ledger_user_id ON ledger(user_id);
        CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
        CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
      `);

      // Relational-authoritative state synchronization from Postgres
      const loadedState = await loadAuthoritativeStateFromPostgres(client);
      memoryCache = loadedState;
      pgSchemaReady = true;

      // Update hoantienshop_state snapshot so it stays 100% consistent
      await client.query(
        `INSERT INTO hoantienshop_state (id, payload, updated_at) VALUES ('main', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [JSON.stringify(loadedState)]
      );

      // Persist authoritative state to disk cache
      try {
        const dir = path.dirname(LOCAL_DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${LOCAL_DB_PATH}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(loadedState), 'utf8');
        fs.renameSync(tmpPath, LOCAL_DB_PATH);
      } catch (_) {}

      logger.logLeave('initPostgresIfConfigured', {
        status: 'ready',
        usersCount: memoryCache.users.length,
        ordersCount: memoryCache.orders.length
      });
    } catch (err) {
      pgSchemaReady = false;
      dbInitPromise = null; // CRITICAL: Reset promise so subsequent requests can retry
      logger.error('initPostgresIfConfigured', 'Khởi tạo Postgres thất bại', { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  })();

  return dbInitPromise;
}

/**
 * Loads and reconstructs full state from relational Postgres tables.
 * Relational tables (users, orders, ledger, withdrawals, clicks) take absolute precedence
 * over the snapshot payload blob, preventing user loss on restarts.
 */
async function loadAuthoritativeStateFromPostgres(client) {
  const usersRes = await client.query('SELECT * FROM users ORDER BY created_at ASC');
  const ordersRes = await client.query('SELECT * FROM orders ORDER BY created_at DESC');
  const ledgerRes = await client.query('SELECT * FROM ledger ORDER BY created_at ASC');
  const withdrawalsRes = await client.query('SELECT * FROM withdrawals ORDER BY created_at DESC');
  const clicksRes = await client.query('SELECT * FROM clicks ORDER BY created_at DESC LIMIT 5000');
  const stateRes = await client.query("SELECT payload FROM hoantienshop_state WHERE id = 'main'");

  const initial = getInitialData();
  let settings = initial.settings;
  let payloadUsers = [];

  if (stateRes.rows.length > 0 && stateRes.rows[0].payload) {
    const p = stateRes.rows[0].payload;
    if (p.settings && typeof p.settings === 'object') {
      settings = { ...settings, ...p.settings };
    }
    if (Array.isArray(p.users)) {
      payloadUsers = p.users;
    }
  }

  let finalUsers = [];
  if (usersRes.rows.length > 0) {
    const tableUsers = usersRes.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name || '',
      phone: row.phone,
      email: row.email || '',
      passwordHash: row.password_hash,
      role: row.role || 'user',
      tokenVersion: Number(row.token_version || 1),
      referredBy: row.referred_by || null,
      balanceAvailable: Math.round(Number(row.balance_available || 0)),
      balancePending: Math.round(Number(row.balance_pending || 0)),
      totalEarned: Math.round(Number(row.total_earned || 0)),
      totalWithdrawn: Math.round(Number(row.total_withdrawn || 0)),
      bankName: row.bank_name || '',
      bankAccount: row.bank_account || '',
      bankOwner: row.bank_owner || '',
      accountLocked: Boolean(row.account_locked),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
    }));

    const userMap = new Map();
    for (const u of tableUsers) {
      userMap.set(u.id, u);
    }
    for (const u of payloadUsers) {
      if (u && u.id && !userMap.has(u.id)) {
        userMap.set(u.id, u);
      }
    }
    finalUsers = Array.from(userMap.values());
  } else if (payloadUsers.length > 0) {
    finalUsers = payloadUsers;
  } else {
    finalUsers = initial.users;
  }

  const finalOrders = ordersRes.rows.length > 0
    ? ordersRes.rows.map((row) => ({
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
        cashbackRate: Number(row.cashback_rate || 70),
        userCashbackAmount: Math.round(Number(row.user_cashback_amount || 0)),
        adminShareAmount: Math.round(Number(row.admin_share_amount || 0)),
        status: row.status || 'pending',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
      }))
    : (stateRes.rows[0]?.payload?.orders || []);

  const finalLedger = ledgerRes.rows.length > 0
    ? ledgerRes.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        type: row.type,
        amount: Math.round(Number(row.amount || 0)),
        refId: row.ref_id,
        note: row.note || '',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      }))
    : (stateRes.rows[0]?.payload?.ledger || []);

  const finalWithdrawals = withdrawalsRes.rows.length > 0
    ? withdrawalsRes.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        userCode: row.user_code || '',
        userName: row.user_name || '',
        userPhone: row.user_phone || '',
        amount: Math.round(Number(row.amount || 0)),
        method: row.method || 'bank',
        bankName: row.bank_name || '',
        bankAccount: row.bank_account || '',
        bankOwner: row.bank_owner || '',
        status: row.status || 'pending',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : (row.updated_at ? new Date(row.updated_at).toISOString() : null)
      }))
    : (stateRes.rows[0]?.payload?.withdrawals || []);

  const finalClicks = clicksRes.rows.length > 0
    ? clicksRes.rows.map((row) => ({
        clickId: row.click_id,
        userId: row.user_id || null,
        userCode: row.user_code || 'GUEST',
        platform: row.platform || 'shopee',
        originalUrl: row.original_url || '',
        cleanUrl: row.clean_url || '',
        productId: row.product_id || '',
        affiliateUrl: row.affiliate_url || '',
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
      }))
    : (stateRes.rows[0]?.payload?.clicks || memoryCache?.clicks || []);

  return {
    settings,
    users: finalUsers,
    clicks: finalClicks,
    orders: finalOrders,
    ledger: finalLedger,
    withdrawals: finalWithdrawals
  };
}

async function syncSnapshotToPostgres(data) {
  if (!pgPool || !pgSchemaReady) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Sync users
    for (const u of data.users || []) {
      await client.query(
        `INSERT INTO users (id, code, name, phone, email, password_hash, role, token_version, referred_by, balance_available, balance_pending, total_earned, total_withdrawn, bank_name, bank_account, bank_owner, account_locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
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

    // 2. Append-only INSERT into ledger (never UPDATE/DELETE)
    for (const l of data.ledger || []) {
      await client.query(
        `INSERT INTO ledger (id, user_id, type, amount, ref_id, note)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ref_id) DO NOTHING`,
        [l.id, l.userId, l.type, Math.round(Number(l.amount || 0)), l.refId, l.note || '']
      );
    }

    // 3. Sync withdrawals
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

    // 4. Sync orders
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

    // 5. Sync clicks (keep latest 500)
    for (const c of (data.clicks || []).slice(-500)) {
      if (!c.clickId) continue;
      await client.query(
        `INSERT INTO clicks (click_id, user_id, user_code, platform, original_url, clean_url, product_id, affiliate_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (click_id) DO NOTHING`,
        [
          c.clickId,
          c.userId || null,
          c.userCode || 'GUEST',
          c.platform || 'shopee',
          c.originalUrl || '',
          c.cleanUrl || '',
          c.productId || '',
          c.affiliateUrl || '',
          c.createdAt || new Date().toISOString()
        ]
      );
    }

    // 6. Update state snapshot with timestamp
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

async function reloadStateFromPostgres() {
  if (!pgPool) return ensureDbLoaded();
  try {
    const client = await pgPool.connect();
    try {
      const fresh = await loadAuthoritativeStateFromPostgres(client);
      if (memoryCache) {
        Object.assign(memoryCache.settings, fresh.settings);
        memoryCache.users = fresh.users;
        memoryCache.clicks = fresh.clicks;
        memoryCache.orders = fresh.orders;
        memoryCache.ledger = fresh.ledger;
        memoryCache.withdrawals = fresh.withdrawals;
      } else {
        memoryCache = fresh;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warning('reloadStateFromPostgres', 'Postgres reload error', { error: err.message });
  }
  return ensureDbLoaded();
}

// ================= TRUE APPEND-ONLY LEDGER & WALLET ACCOUNTING =================

/**
 * Append an immutable entry into the ledger (Idempotent via unique refId).
 * Positive amount = credit, Negative amount = debit.
 * NEVER deletes or mutates existing ledger entries.
 */
function appendLedgerEntry(userId, type, amount, refId, note = '', { forcedId = null } = {}) {
  if (!userId || !refId) {
    logger.error('appendLedgerEntry', 'Thiếu userId hoặc refId bắt buộc', { userId, refId });
    return null;
  }
  const rawAmt = Number(amount);
  if (!Number.isFinite(rawAmt) || rawAmt === 0) return null;

  const db = ensureDbLoaded();
  const cleanRefId = String(refId).trim();

  // Idempotency check: never insert duplicate refId
  const exists = db.ledger.find((e) => e.refId === cleanRefId);
  if (exists) return exists;

  const entry = {
    id: forcedId || `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    userId,
    type,
    amount: Math.round(rawAmt),
    refId: cleanRefId,
    note: String(note || ''),
    createdAt: new Date().toISOString()
  };

  db.ledger.push(entry);
  return entry;
}

/**
 * Synchronize ledger entries via strictly compensatory Delta Reconciler.
 * Balance is computed purely as SUM(ledger.amount).
 * Supports unlimited cycles of approval, cancellation, re-approval, and amount adjustment.
 */
function recalculateUserWallet(userId, { persist = false } = {}) {
  logger.logEnter('recalculateUserWallet', { userId });
  const db = ensureDbLoaded();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;

  const userCodeUpper = String(user.code || '').toUpperCase();
  const userOrders = db.orders.filter(
    (o) =>
      o.userId === user.id ||
      (o.userCode && String(o.userCode).toUpperCase() === userCodeUpper)
  );

  // 1. Build Map Index for O(1) lookups
  const userLedger = db.ledger.filter((e) => e.userId === user.id);
  const ledgerByOrderSn = new Map();
  const ledgerByRefId = new Map();

  for (const entry of userLedger) {
    if (entry.refId) {
      ledgerByRefId.set(entry.refId, entry);

      let sn = null;
      if (entry.refId.startsWith('ord_adj_')) {
        const parts = entry.refId.slice(8).split('_');
        parts.pop();
        sn = parts.join('_');
      } else if (entry.refId.startsWith('order_credit_')) {
        sn = entry.refId.slice(13);
      } else if (entry.refId.startsWith('order_revoke_')) {
        sn = entry.refId.slice(13);
      } else if (entry.refId.startsWith('order_recredit_')) {
        sn = entry.refId.slice(15);
      } else if (entry.refId.startsWith('order_cancellation_')) {
        sn = entry.refId.slice(19);
      }

      if (sn) {
        if (!ledgerByOrderSn.has(sn)) ledgerByOrderSn.set(sn, []);
        ledgerByOrderSn.get(sn).push(entry);
      }
    }
  }

  let pending = 0;

  // 2. Delta Reconciler: calculate exact difference between expected and current ledger
  for (const ord of userOrders) {
    const cleanSn = String(ord.orderSn || '').trim();
    if (!cleanSn) continue;

    const cashbackAmt = Math.round(Number(ord.userCashbackAmount || 0));
    const expectedApprovedAmt = (ord.status === 'approved' && cashbackAmt > 0) ? cashbackAmt : 0;

    if (ord.status === 'pending') {
      pending += cashbackAmt;
    }

    const existingEntries = ledgerByOrderSn.get(cleanSn) || [];
    const currentSum = existingEntries.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const delta = expectedApprovedAmt - currentSum;

    if (delta !== 0) {
      const seq = existingEntries.length + 1;
      const refId = (seq === 1 && delta > 0)
        ? `order_credit_${cleanSn}`
        : `ord_adj_${cleanSn}_${seq}`;

      const type = delta > 0 ? 'order_cashback' : 'order_revocation';
      const note = delta > 0
        ? `Hoàn tiền đơn hàng #${cleanSn} (+${delta.toLocaleString('vi-VN')} đ)`
        : `Điều chỉnh hoàn tiền đơn #${cleanSn} (${delta.toLocaleString('vi-VN')} đ)`;

      const newEntry = appendLedgerEntry(user.id, type, delta, refId, note);
      if (newEntry) {
        existingEntries.push(newEntry);
        userLedger.push(newEntry);
        ledgerByRefId.set(refId, newEntry);
        if (!ledgerByOrderSn.has(cleanSn)) ledgerByOrderSn.set(cleanSn, existingEntries);
      }
    }
  }

  // 3. Reconcile withdrawals
  const userWithdrawals = db.withdrawals.filter((w) => w.userId === user.id);
  for (const w of userWithdrawals) {
    const amt = Math.round(Number(w.amount || 0));
    const debitRef = `withdraw_debit_${w.id}`;
    const refundRef = `withdraw_refund_${w.id}`;

    if (w.status === 'pending' || w.status === 'paid') {
      if (!ledgerByRefId.has(debitRef)) {
        const entry = appendLedgerEntry(
          user.id,
          'withdrawal_lock',
          -Math.abs(amt),
          debitRef,
          `Rút tiền #${w.id} (${w.bankName || 'Ngân hàng'})`
        );
        if (entry) {
          userLedger.push(entry);
          ledgerByRefId.set(debitRef, entry);
        }
      }
    } else if (w.status === 'rejected') {
      const hadDebit = ledgerByRefId.get(debitRef);
      const hadRefund = ledgerByRefId.get(refundRef);
      if (hadDebit && !hadRefund) {
        const entry = appendLedgerEntry(
          user.id,
          'withdrawal_refund',
          Math.abs(amt),
          refundRef,
          `Hoàn lại lệnh rút tiền bị từ chối #${w.id}`
        );
        if (entry) {
          userLedger.push(entry);
          ledgerByRefId.set(refundRef, entry);
        }
      }
    }
  }

  // 4. Compute balance strictly from append-only ledger SUM & net earned
  let ledgerSum = 0;
  let earnedNetSum = 0;

  for (const entry of userLedger) {
    const entryAmt = Number(entry.amount || 0);
    ledgerSum += entryAmt;
    if (
      entry.type === 'order_cashback' ||
      entry.type === 'referral_bonus' ||
      entry.type === 'order_revocation' ||
      entry.type === 'order_cancellation'
    ) {
      earnedNetSum += entryAmt;
    }
  }

  const paidWithdrawn = userWithdrawals
    .filter((w) => w.status === 'paid')
    .reduce((acc, w) => acc + Number(w.amount || 0), 0);

  user.balancePending = Math.max(0, Math.round(pending));
  user.totalEarned = Math.max(0, Math.round(earnedNetSum));
  user.totalWithdrawn = Math.max(0, Math.round(paidWithdrawn));
  user.balanceAvailable = Math.round(ledgerSum);
  user.hasNegativeBalance = user.balanceAvailable < 0;

  if (persist) {
    saveDb(db).catch((err) => {
      logger.warning('recalculateUserWallet', 'Lỗi lưu ví người dùng', { error: err.message });
    });
  }

  logger.logLeave('recalculateUserWallet', {
    userId,
    balanceAvailable: user.balanceAvailable,
    totalEarned: user.totalEarned,
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

    // Input sanitization and validation
    const cleanBankName = String(bankName || '').trim();
    const cleanBankAccount = String(bankAccount || '').replace(/\s+/g, '');
    const cleanBankOwner = String(bankOwner || '').trim().toUpperCase();

    if (!cleanBankName || cleanBankName.length > 100) {
      throw new Error('Tên ngân hàng không hợp lệ.');
    }
    if (!cleanBankAccount || cleanBankAccount.length < 4 || cleanBankAccount.length > 30) {
      throw new Error('Số tài khoản ngân hàng không hợp lệ.');
    }
    if (!cleanBankOwner || cleanBankOwner.length < 2 || cleanBankOwner.length > 100) {
      throw new Error('Tên chủ tài khoản không hợp lệ.');
    }

    const rawMin = Number(minWithdraw);
    const effectiveMin = Number.isFinite(rawMin) && rawMin > 0
      ? Math.max(Number(db.settings.minWithdrawAmount ?? 50000), rawMin)
      : Number(db.settings.minWithdrawAmount ?? 50000);

    const numAmount = Math.round(Number(amount || 0));
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      throw new Error('Số tiền rút phải lớn hơn 0đ.');
    }
    if (numAmount < effectiveMin) {
      throw new Error(`Số tiền rút tối thiểu là ${effectiveMin.toLocaleString('vi-VN')}đ.`);
    }

    // Re-calculate user wallet strictly inside critical section
    recalculateUserWallet(user.id, { persist: false });
    const strictLedgerSum = db.ledger
      .filter((e) => e.userId === user.id)
      .reduce((acc, e) => acc + Number(e.amount || 0), 0);

    if (strictLedgerSum < 0) {
      throw new Error(
        `Tài khoản đang có số dư âm (${strictLedgerSum.toLocaleString('vi-VN')}đ) do đơn hàng hoàn trả sau khi rút. Hệ thống sẽ tự động cấn trừ vào đơn tiếp theo.`
      );
    }
    if (numAmount > strictLedgerSum) {
      throw new Error('Số dư khả dụng trên Sổ cái không đủ để thực hiện lệnh rút này.');
    }

    const wdId = `wd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ledgerId = `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const debitRef = `withdraw_debit_${wdId}`;

    // If PostgreSQL is configured, enforce strict transactional row lock & ledger balance
    if (pgPool) {
      if (!pgSchemaReady) {
        throw new Error('Hệ thống cơ sở dữ liệu đám mây đang đồng bộ, vui lòng thử lại sau giây lát.');
      }
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');

        // Upsert user to ensure row exists for locking
        await client.query(
          `INSERT INTO users (id, code, phone, password_hash, role)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [user.id, user.code, user.phone, user.passwordHash, user.role || 'user']
        );

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

        await client.query(
          `INSERT INTO ledger (id, user_id, type, amount, ref_id, note)
           VALUES ($1, $2, 'withdrawal_lock', $3, $4, $5)`,
          [ledgerId, user.id, -Math.abs(numAmount), debitRef, `Rút tiền #${wdId} (${cleanBankName})`]
        );

        await client.query(
          `INSERT INTO withdrawals (id, user_id, user_code, user_name, user_phone, amount, method, bank_name, bank_account, bank_owner, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
          [
            wdId,
            user.id,
            user.code,
            user.name || '',
            user.phone,
            numAmount,
            method === 'momo' ? 'momo' : 'bank',
            cleanBankName,
            cleanBankAccount,
            cleanBankOwner
          ]
        );

        await client.query(
          `UPDATE users SET balance_available = $2, bank_name = $3, bank_account = $4, bank_owner = $5 WHERE id = $1`,
          [user.id, pgLedgerSum - numAmount, cleanBankName, cleanBankAccount, cleanBankOwner]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    user.bankName = cleanBankName;
    user.bankAccount = cleanBankAccount;
    user.bankOwner = cleanBankOwner;

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

    appendLedgerEntry(
      user.id,
      'withdrawal_lock',
      -Math.abs(numAmount),
      debitRef,
      `Rút tiền #${wdId} (${user.bankName})`,
      { forcedId: ledgerId }
    );
    db.withdrawals.unshift(withdrawal);

    recalculateUserWallet(user.id, { persist: false });
    await saveDb(db);

    logger.logLeave('executeAtomicWithdrawal', {
      wdId,
      amount: numAmount,
      remainingBalance: user.balanceAvailable
    });
    return { withdrawal, user: sanitizeUser(user) };
  });
}

/**
 * Pure read-only integrity audit by default (Side-effect free for status checks).
 * Auto-healing is only enabled when explicitly passed { autoRepair: true }.
 */
function auditLedgerIntegrity({ autoRepair = false } = {}) {
  logger.logEnter('auditLedgerIntegrity', { autoRepair });
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
      if (autoRepair) {
        u.balanceAvailable = roundedSum;
      }
    }

    if (roundedSum < 0) {
      negativeUsers.push({
        userId: u.id,
        userCode: u.code,
        balanceAvailable: roundedSum
      });
    }
  }

  if (autoRepair && mismatches.length > 0) {
    saveDb(db).catch((err) => {
      logger.error('auditLedgerIntegrity', 'Lỗi lưu tự động sửa số dư', { error: err.message });
    });
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

/**
 * Fast wallet recalculation with Map index and single save at completion.
 */
function recalculateAllWallets({ persist = true } = {}) {
  const db = ensureDbLoaded();

  for (const u of db.users) {
    recalculateUserWallet(u.id, { persist: false });
  }

  if (persist) {
    saveDb(db).catch((err) => {
      logger.warning('recalculateAllWallets', 'Lỗi lưu dữ liệu', { error: err.message });
    });
  }

  return auditLedgerIntegrity({ autoRepair: false });
}

function getDatabaseStatus() {
  const audit = auditLedgerIntegrity({ autoRepair: false });
  return {
    mode: pgPool ? 'postgres' : IS_VERCEL ? 'ephemeral_tmp' : 'local_json',
    isPersistentOnCloud: Boolean(pgPool && pgSchemaReady),
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
  reloadStateFromPostgres,
  getDefaultPostbackToken,
  withUserLock
};
