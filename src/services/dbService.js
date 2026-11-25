const { parseTimestamp } = require('./orderReconciliationService');
const { mapUserRow } = require('./userMapper');
const { mapOrderRow } = require('./orderMapper');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const logger = require('../utils/logger');
const { orderKey, orderId, migrateLegacyOrderIdentity, ledgerOrderKey, orderLedgerRef } = require('./orderIdentity');
const { cleanExpiredClicks } = require('../utils/clickManager');
const { encryptSettingsObject, decryptSettingsObject } = require('../utils/secretCrypto');

const IS_VERCEL = Boolean(process.env.VERCEL);
const IS_TEST_ENV = process.env.NODE_ENV === 'test';
const IS_PROD = IS_VERCEL || process.env.NODE_ENV === 'production';

const LOCAL_DB_PATH = IS_TEST_ENV
  ? path.join(os.tmpdir(), `hoantienshop_test_db_${process.pid}.json`)
  : IS_VERCEL
    ? path.join('/tmp', 'hoantienshop_db_v2.json')
    : path.join(__dirname, '..', '..', 'data', 'db.json');
const SEED_DB_PATH = path.join(__dirname, '..', 'data', 'seedDb.json');

if (IS_TEST_ENV) {
  process.on('exit', () => {
    try {
      if (fs.existsSync(LOCAL_DB_PATH)) fs.unlinkSync(LOCAL_DB_PATH);
      if (fs.existsSync(`${LOCAL_DB_PATH}.tmp`)) fs.unlinkSync(`${LOCAL_DB_PATH}.tmp`);
    } catch (_) {}
  });
}

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
const parsedFileEnv = IS_TEST_ENV ? {} : parseEnvFile(localEnvPath);
for (const [k, v] of Object.entries(parsedFileEnv)) {
  if (!process.env[k]) {
    process.env[k] = v;
  }
}

function getDatabaseUrl() {
  if (IS_TEST_ENV) {
    return (process.env.TEST_DATABASE_URL || '').trim();
  }
  return (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

let DATABASE_URL = getDatabaseUrl();
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

    let sslConfig = false;
    if (!isLocal) {
      if (process.env.PG_SSL_CA) {
        sslConfig = {
          rejectUnauthorized: true,
          ca: process.env.PG_SSL_CA.replace(/\\n/g, '\n')
        };
      } else {
        sslConfig = { rejectUnauthorized: true };
      }
    }

    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: sslConfig,
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

/**
 * Return active PostgreSQL connection pool if configured, or null.
 */
function getPgPool() {
  return pgPool;
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

function scryptPromise(pw, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, keylen, options, (err, derived) => {
      if (err) return reject(err);
      resolve(derived);
    });
  });
}

async function hashPasswordAsync(pw) {
  if (!pw || typeof pw !== 'string' || pw.length < 6) {
    throw new Error('Mật khẩu không hợp lệ, yêu cầu tối thiểu 6 ký tự.');
  }
  if (pw.length > 128) {
    throw new Error('Mật khẩu không được vượt quá 128 ký tự.');
  }
  const salt = crypto.randomBytes(16);
  const hash = await scryptPromise(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPasswordAsync(pw, stored) {
  if (!pw || !stored || typeof stored !== 'string' || pw.length > 128) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptPromise(String(pw), Buffer.from(saltHex, 'hex'), 64, {
      N: 16384,
      r: 8,
      p: 1
    });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }
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
  const secret = (
    process.env.JWT_SECRET ||
    process.env.AUTH_SECRET ||
    ''
  ).trim();
  if (!secret) {
    if (IS_PROD) throw new Error('JWT_SECRET or AUTH_SECRET is required in production');
    cachedJwtSecret = crypto.randomBytes(48).toString('hex');
    return cachedJwtSecret;
  }
  if (IS_PROD && secret.length < 32) {
    throw new Error('Authentication secret must contain at least 32 characters');
  }
  if (secret.length < 32) {
    cachedJwtSecret = crypto.createHash('sha256').update(secret).digest('hex');
    return cachedJwtSecret;
  }
  cachedJwtSecret = secret;
  return cachedJwtSecret;
}

function getSettingsEncryptionSecret() {
  const explicit = (
    process.env.SETTINGS_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    process.env.AUTH_SECRET ||
    ''
  ).trim();
  if (explicit) return explicit;
  return IS_PROD ? getJwtSecret() : 'dev-local-lila-settings-key-v1';
}

if (IS_PROD) {
  getJwtSecret();
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required for secure bootstrap');
}

const REFRESH_MULTI_TAB_GRACE_MS = 15 * 1000;

function getSessionPolicy(user) {
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  if (isAdmin) {
    return {
      accessTtlSec: 1800,           // 30 minutes
      idleTtlSec: 7 * 24 * 3600,    // 7 days sliding idle window
      absTtlSec: 14 * 24 * 3600     // 14 days absolute max lifetime
    };
  }
  return {
    accessTtlSec: 3600,             // 1 hour
    idleTtlSec: 30 * 24 * 3600,     // 30 days sliding idle window
    absTtlSec: 90 * 24 * 3600       // 90 days absolute max lifetime
  };
}

function createToken(user, ttlSeconds) {
  const effectiveTtl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Number(ttlSeconds)
    : getSessionPolicy(user).accessTtlSec;
  const payload = {
    id: user.id,
    code: user.code,
    role: user.role,
    ver: Number(user.tokenVersion || 1),
    exp: Math.floor(Date.now() / 1000) + effectiveTtl
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
    referredBy: user.referredBy || null,
    balanceAvailable: Math.round(Number(user.balanceAvailable || 0)),
    balancePending: Math.round(Number(user.balancePending || 0)),
    totalEarned: Math.round(Number(user.totalEarned || 0)),
    totalWithdrawn: Math.round(Number(user.totalWithdrawn || 0)),
    bankName: user.bankName || '',
    bankAccount: user.bankAccount || '',
    bankOwner: user.bankOwner || '',
    accountLocked: Boolean(user.accountLocked),
    customCashbackPercent: user.customCashbackPercent !== null && user.customCashbackPercent !== undefined && Number.isFinite(Number(user.customCashbackPercent))
      ? Number(user.customCashbackPercent)
      : null,
    totalApprovedSpend: Math.max(0, Math.round(Number(user.totalApprovedSpend || 0))),
    vipTier: user.vipTier || 'bronze',
    createdAt: user.createdAt || ''
  };
}

const DEFAULT_VIP_TIERS = [
  { code: 'bronze', name: 'Thành viên Đồng', icon: '🥉', minSpend: 0, cashbackPercent: 70 },
  { code: 'silver', name: 'Thành viên Bạc', icon: '🥈', minSpend: 2000000, cashbackPercent: 73 },
  { code: 'gold', name: 'Thành viên Vàng', icon: '🥇', minSpend: 6000000, cashbackPercent: 76 },
  { code: 'diamond', name: 'Thành viên Kim Cương', icon: '💎', minSpend: 15000000, cashbackPercent: 80 }
];

let tierUpgradeListener = null;
function setTierUpgradeListener(fn) {
  tierUpgradeListener = typeof fn === 'function' ? fn : null;
}

function getNormalizedVipTiers(settings = {}) {
  const raw = Array.isArray(settings?.vipTiers) && settings.vipTiers.length > 0
    ? settings.vipTiers
    : DEFAULT_VIP_TIERS;
  const fallbackBase = Number(settings?.cashbackPercent ?? 70);
  return raw
    .map((t, idx) => ({
      code: String(t?.code || DEFAULT_VIP_TIERS[idx]?.code || `tier_${idx}`).trim().toLowerCase(),
      name: String(t?.name || DEFAULT_VIP_TIERS[idx]?.name || `Hạng ${idx + 1}`).trim(),
      icon: String(t?.icon || DEFAULT_VIP_TIERS[idx]?.icon || '🏅').trim(),
      minSpend: Math.max(0, Math.round(Number(t?.minSpend ?? 0))),
      cashbackPercent: Number.isFinite(Number(t?.cashbackPercent)) && Number(t?.cashbackPercent) >= 0
        ? Number(t.cashbackPercent)
        : (Number.isFinite(fallbackBase) && fallbackBase >= 0 ? fallbackBase : 70)
    }))
    .sort((a, b) => a.minSpend - b.minSpend);
}

function resolveVipTier(totalApprovedSpend = 0, settings = {}) {
  const tiers = getNormalizedVipTiers(settings);
  if (settings?.vipTiersEnabled === false) {
    return tiers[0];
  }
  const spend = Math.max(0, Math.round(Number(totalApprovedSpend || 0)));
  let matched = tiers[0];
  for (const tier of tiers) {
    if (spend >= tier.minSpend) {
      matched = tier;
    }
  }
  return matched;
}

/**
 * Resolve effective cashback percentage for a user:
 * 1. User-level customCashbackPercent (Admin Override, >= 0, no artificial cap)
 * 2. VIP Tier rate (if vipTiersEnabled !== false)
 * 3. Default global settings.cashbackPercent
 */
function resolveUserCashbackRate(user, settings = {}) {
  if (
    user &&
    user.customCashbackPercent !== null &&
    user.customCashbackPercent !== undefined &&
    user.customCashbackPercent !== ''
  ) {
    const customRate = Number(user.customCashbackPercent);
    if (Number.isFinite(customRate) && customRate >= 0) {
      return customRate;
    }
  }
  if (user && settings?.vipTiersEnabled !== false) {
    const tiers = getNormalizedVipTiers(settings);
    const byCode = user.vipTier
      ? tiers.find((t) => t.code === String(user.vipTier).toLowerCase())
      : null;
    const tier = byCode || resolveVipTier(user.totalApprovedSpend || 0, settings);
    if (tier && Number.isFinite(Number(tier.cashbackPercent)) && Number(tier.cashbackPercent) >= 0) {
      return Number(tier.cashbackPercent);
    }
  }
  const fallback = Number(settings?.cashbackPercent ?? 70);
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 70;
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
  return (process.env.POSTBACK_TOKEN || process.env.POSTBACK_SECRET || '').trim();
}

let cachedDefaultSettings = null;
function getDefaultSettings() {
  if (cachedDefaultSettings) return { ...cachedDefaultSettings };
  const rawCb = Number(process.env.CASHBACK_PERCENT);
  const rawTax = Number(process.env.TAX_DEDUCT_PERCENT);
  const rawMinWd = Number(process.env.MIN_WITHDRAW);
  const rawBounty = Number(process.env.REFERRAL_BOUNTY_AMOUNT);

  cachedDefaultSettings = {
    siteName: process.env.SITE_NAME || 'LiLa',
    shopeeMode: process.env.SHOPEE_MODE || 'an_redir',
    shopeeAffiliateId: (process.env.SHOPEE_AFFILIATE_ID || '').trim(),
    addlivetagApiKey: (process.env.ADDLIVETAG_API_KEY || '').trim(),
    tiktokMode: process.env.TIKTOK_MODE || 'deeplink',
    tiktokDeepLinkTemplate: (process.env.TIKTOK_DEEPLINK_TEMPLATE || '').trim(),
    cashbackPercent: Number.isFinite(rawCb) ? Math.min(100, Math.max(0, rawCb)) : 70,
    taxDeductPercent: Number.isFinite(rawTax) ? Math.min(50, Math.max(0, rawTax)) : 10,
    referralBonusPercent: 0,
    referralBountyAmount: Number.isFinite(rawBounty) && rawBounty >= 0 ? rawBounty : 10000,
    minWithdrawAmount: Number.isFinite(rawMinWd) && rawMinWd >= 0 ? rawMinWd : 50000,
    supportZalo: process.env.SUPPORT_ZALO || '',
    zaloGroupUrl: (process.env.ZALO_GROUP_URL || '').trim(),
    zaloWidgetEnabled: true,
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
    } else {
      cachedAdminPassword = crypto.randomBytes(48).toString('hex');
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
    withdrawals: [],
    auditLogs: []
  };
}

let memoryCache = null;
const stateContext = new AsyncLocalStorage();
let committedLocalState = null;
const discardedLocalStates = new WeakSet();
let cacheInvalid = false;
let saveGeneration = 0;

function cacheUnavailableError() {
  const error = new Error('Dữ liệu cần được tải lại sau lỗi lưu. Vui lòng thử lại.');
  error.status = 503;
  error.code = 'CACHE_UNAVAILABLE';
  return error;
}

function syncAdminCredentials(data) {
  if (!data || !Array.isArray(data.users)) return false;
  let admin = data.users.find((u) => u.role === 'admin');
  let changed = false;

  if (!admin) {
    const initial = getInitialData();
    const defaultAdmin = initial.users.find((u) => u.role === 'admin');
    if (defaultAdmin) {
      data.users.unshift(defaultAdmin);
      admin = defaultAdmin;
      changed = true;
    }
  }
  if (!admin) return false;

  const targetPhone = (process.env.ADMIN_PHONE || 'trungvuong3x').trim();
  const targetEmail = (process.env.ADMIN_EMAIL || 'trungvuong3x@hoantiensan.online').trim();
  const targetCode = (process.env.ADMIN_CODE || 'TRUNGVUONG3X').trim().toUpperCase();
  const envAdminPassword = (process.env.ADMIN_PASSWORD || '').trim();

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
  if (!admin.passwordHash) {
    admin.passwordHash = hashPassword(envAdminPassword || crypto.randomBytes(48).toString('hex'));
    changed = true;
  } else if (
    (process.env.FORCE_SYNC_ADMIN_PASSWORD === 'true' || process.env.RESET_ADMIN_PASSWORD === 'true') &&
    envAdminPassword &&
    !verifyPassword(envAdminPassword, admin.passwordHash)
  ) {
    admin.passwordHash = hashPassword(envAdminPassword);
    admin.tokenVersion = Number(admin.tokenVersion || 1) + 1;
    changed = true;
  }
  return changed;
}

/**
 * Migrates legacy default 5,000đ referral bounty to 10,000đ once without overriding subsequent admin edits.
 */
function migrateReferralBountySetting(settings) {
  if (!settings || typeof settings !== 'object') return;
  if (!settings.siteName || settings.siteName === 'Hoàn Tiền Sàn') {
    settings.siteName = 'LiLa';
  }
  if (!settings.referralBountyV2Migrated) {
    if (settings.referralBountyAmount === undefined || Number(settings.referralBountyAmount) === 5000) {
      settings.referralBountyAmount = 10000;
    }
    settings.referralBountyV2Migrated = true;
  }
}

function normalizeState(raw, initial = null) {
  if (!raw || typeof raw !== 'object') {
    raw = {};
  }
  const defaultInit = initial || getInitialData();
  const state = {
    webhookReceipts: Array.isArray(raw.webhookReceipts) ? raw.webhookReceipts : [],
    settings: decryptSettingsObject(
      { ...defaultInit.settings, ...(raw.settings || {}) },
      getSettingsEncryptionSecret()
    ),
    users: Array.isArray(raw.users) && raw.users.length > 0 ? raw.users : defaultInit.users,
    clicks: Array.isArray(raw.clicks) ? raw.clicks : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    withdrawals: Array.isArray(raw.withdrawals) ? raw.withdrawals : [],
    auditLogs: Array.isArray(raw.auditLogs) ? raw.auditLogs : []
  };

  syncAdminCredentials(state);
  if (
    typeof state.settings.supportZalo === 'string' &&
    state.settings.supportZalo.startsWith('https://zalo.me/g/') &&
    !state.settings.zaloGroupUrl
  ) {
    state.settings.zaloGroupUrl = state.settings.supportZalo.trim();
  }
  if (typeof state.settings.zaloGroupUrl !== 'string' || !state.settings.zaloGroupUrl.trim()) {
    state.settings.zaloGroupUrl = 'https://zalo.me/g/cl2cmiseoqienusnrbyr';
  }
  if (typeof state.settings.zaloWidgetEnabled !== 'boolean') {
    state.settings.zaloWidgetEnabled = true;
  }
  migrateReferralBountySetting(state.settings);
  return state;
}

function ensureDbLoaded() {
  const context = stateContext.getStore();
  if (context) {
    if (context.invalid) throw cacheUnavailableError();
    return context.data;
  }
  if (cacheInvalid) throw cacheUnavailableError();
  if (memoryCache) {
    // Sync active public environment variable overrides
    if (process.env.SHOPEE_AFFILIATE_ID) memoryCache.settings.shopeeAffiliateId = process.env.SHOPEE_AFFILIATE_ID.trim();
    if (process.env.TIKTOK_DEEPLINK_TEMPLATE) memoryCache.settings.tiktokDeepLinkTemplate = process.env.TIKTOK_DEEPLINK_TEMPLATE.trim();
    if (process.env.SUPPORT_ZALO) memoryCache.settings.supportZalo = process.env.SUPPORT_ZALO.trim();
    if (process.env.ZALO_GROUP_URL) memoryCache.settings.zaloGroupUrl = process.env.ZALO_GROUP_URL.trim();
    if (
      typeof memoryCache.settings.supportZalo === 'string' &&
      memoryCache.settings.supportZalo.startsWith('https://zalo.me/g/') &&
      !memoryCache.settings.zaloGroupUrl
    ) {
      memoryCache.settings.zaloGroupUrl = memoryCache.settings.supportZalo.trim();
    }
    if (process.env.ADDLIVETAG_API_KEY) {
      memoryCache.settings.addlivetagApiKey = process.env.ADDLIVETAG_API_KEY.trim();
    }

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
  } else if (!IS_TEST_ENV && fs.existsSync(SEED_DB_PATH)) {
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
    committedLocalState = structuredClone(memoryCache);

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
let currentDbVersion = 1;

// Each request owns its mutable state. Financial snapshots use the version
// captured with that state, never a version changed by a concurrent request.
async function runWithStateContext(fn, { incrementalOnly = false } = {}) {
  const base = ensureDbLoaded();
  const data = incrementalOnly
    ? { ...base, users: structuredClone(base.users), settings: structuredClone(base.settings) }
    : {
        ...structuredClone({ ...base, clicks: [] }),
        clicks: Array.isArray(base.clicks) ? base.clicks.slice() : []
      };
  const context = { data, version: stateContext.getStore()?.version ?? currentDbVersion, invalid: false, incrementalOnly };
  return stateContext.run(context, async () => {
    if (pgPool && !incrementalOnly) {
      const result = await pgPool.query("SELECT version FROM hoantienshop_state WHERE id='main'");
      if (Number(result.rows[0]?.version || 1) !== context.version) await reloadStateFromPostgres({ strict: true });
    }
    return fn();
  });
}

async function performSaveDb(data, expectedVersion, deletedOrders = []) {
  if (!data) return;

  // Retain attribution for the entire configured time window.
  data.clicks = cleanExpiredClicks(data.clicks);
  if (pgPool) {
    if (!pgSchemaReady) throw new Error('Postgres schema is not ready');
    await syncSnapshotToPostgres(data, expectedVersion, deletedOrders);
    return;
  }

  // 1. Atomic local file write (encrypts sensitive settings at rest before writing JSON)
  let tmpPath = null;
  try {
    const dir = path.dirname(LOCAL_DB_PATH);
    fs.mkdirSync(dir, { recursive: true });
    tmpPath = `${LOCAL_DB_PATH}.tmp.${process.pid}.${Date.now()}`;
    const diskPayload = {
      ...data,
      settings: encryptSettingsObject(data.settings, getSettingsEncryptionSecret())
    };
    fs.writeFileSync(tmpPath, JSON.stringify(diskPayload), 'utf8');
    fs.renameSync(tmpPath, LOCAL_DB_PATH);
    committedLocalState = structuredClone(data);
    tmpPath = null;
  } catch (err) {
    logger.error('saveDb', 'Lỗi ghi đĩa local', { error: err.message });
    if (!pgPool) throw err;
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }
}

/**
 * Robust serialized save with internal queue error isolation and batch coalescing.
 * If a save fails, the caller receives the error, but the internal queue recovers immediately.
 */
function saveDb(data = memoryCache, { deletedOrders = [] } = {}) {
  const deletionTargets = structuredClone(deletedOrders);
  if (deletionTargets.length && !stateContext.getStore()) return Promise.reject(new Error("Explicit deletion requires a request state context"));
  const context = stateContext.getStore();
  if (context) {
    if (context.invalid) return Promise.reject(cacheUnavailableError());
    if (context.incrementalOnly && pgPool) return Promise.reject(new Error('Snapshot writes are forbidden in incremental-only requests'));
    const snapshot = structuredClone(arguments.length ? data : context.data);
    const expectedVersion = context.version;
    const operation = internalSaveQueue.then(async () => {
      try {
        if (!pgPool && expectedVersion !== currentDbVersion) {
          const error = new Error('Dữ liệu đã thay đổi. Vui lòng tải lại và thử lại.');
          error.status = 409; error.code = 'STATE_CONFLICT'; throw error;
        }
        await performSaveDb(snapshot, expectedVersion, deletionTargets);
        if (!pgPool) currentDbVersion++;
        context.version = currentDbVersion;
        const published = structuredClone(snapshot);
        if (memoryCache) Object.assign(memoryCache, published);
        else memoryCache = published;
      } catch (error) {
        context.invalid = true;
        throw error;
      }
    });
    internalSaveQueue = operation.catch(() => {});
    return operation;
  }
  if (cacheInvalid) return Promise.reject(cacheUnavailableError());
  const generation = saveGeneration;
  const targetData = data || memoryCache;
  if (targetData && discardedLocalStates.has(targetData)) return Promise.reject(cacheUnavailableError());
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
        if (generation !== saveGeneration) throw cacheUnavailableError();
        await performSaveDb(snapshot);
        if (!pgPool) currentDbVersion++;
        resolveCaller();
      } catch (err) {
        logger.error('saveDb', 'Lỗi trong tác vụ lưu dữ liệu', { error: err.message });
        if (pgPool) {
          cacheInvalid = true;
          saveGeneration++;
          // Discard failed mutations; never turn a rejected operation into a
          // later successful snapshot. Queued saves from this generation fail.
          await reloadStateFromPostgres({ strict: true }).catch(reloadError => {
            logger.error('saveDb', 'Không thể khôi phục cache sau lỗi lưu', { error: reloadError.message });
          });
        } else {
          saveGeneration++;
          if (snapshot) discardedLocalStates.add(snapshot);
          if (committedLocalState) memoryCache = structuredClone(committedLocalState);
          else cacheInvalid = true;
        }
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
 * Provides resilient FIFO queueing that never hangs on preceding error rejections.
 */
async function withUserLock(userId, fn, { syncCache = false } = {}) {
  const key = String(userId || 'global');
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  // Ensure that tail always resolves when release() is invoked, even if prev rejected
  const tail = prev.catch(() => {}).then(() => next);
  userLocks.set(key, tail);

  try {
    await prev.catch(() => {});
    if (syncCache && pgPool && pgSchemaReady) {
      await reloadStateFromPostgres();
    }
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
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(18471203)');
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
        CREATE TABLE IF NOT EXISTS webhook_receipts (
          receipt_key TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          admin_id TEXT,
          admin_name TEXT,
          action TEXT,
          target_id TEXT,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          dedupe_key TEXT UNIQUE,
          metadata JSONB DEFAULT '{}'::jsonb,
          is_read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS notification_reads (
          notification_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          read_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (notification_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          family_id TEXT NOT NULL,
          token_hash TEXT UNIQUE NOT NULL,
          prev_token_hash TEXT NULL,
          prev_grace_until TIMESTAMPTZ NULL,
          user_agent TEXT DEFAULT '',
          expires_at TIMESTAMPTZ NOT NULL,
          absolute_expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ NULL,
          last_used_at TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_family_id ON user_sessions(family_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          email TEXT NOT NULL,
          otp_hash TEXT NOT NULL,
          attempts INT DEFAULT 0,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pwd_reset_user ON password_reset_tokens(user_id, created_at DESC);

        -- Safe idempotent schema migrations for OCC, orders, users, withdrawals & audit_logs
        ALTER TABLE hoantienshop_state ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 1;
        UPDATE hoantienshop_state SET version = 1 WHERE version IS NULL;
        ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
        ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
        ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_user_idempotency ON withdrawals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'withdrawals_amount_positive') THEN
            ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_amount_positive CHECK (amount > 0) NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_user_id') THEN
            ALTER TABLE orders ADD CONSTRAINT fk_orders_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_clicks_user_id') THEN
            ALTER TABLE clicks ADD CONSTRAINT fk_clicks_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_user_id') THEN
            ALTER TABLE ledger ADD CONSTRAINT fk_ledger_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_withdrawals_user_id') THEN
            ALTER TABLE withdrawals ADD CONSTRAINT fk_withdrawals_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_notifications_user_id') THEN
            ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_notification_reads_user_id') THEN
            ALTER TABLE notification_reads ADD CONSTRAINT fk_notification_reads_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
          END IF;
        END $$;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by_admin_id TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS has_negative_balance BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_cashback_percent NUMERIC NULL;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS total_approved_spend BIGINT DEFAULT 0;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_tier TEXT DEFAULT 'bronze';
        UPDATE orders SET platform = 'shopee' WHERE platform IS NULL OR platform = '';
        ALTER TABLE orders ALTER COLUMN platform SET DEFAULT 'shopee';
        ALTER TABLE orders ALTER COLUMN platform SET NOT NULL;
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='orders'::regclass AND contype='p' AND array_length(conkey,1)=1) THEN
            ALTER TABLE orders DROP CONSTRAINT orders_pkey;
            ALTER TABLE orders ADD PRIMARY KEY (platform, order_sn);
          END IF;
        END $$;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_rate NUMERIC DEFAULT 70;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS locked_cashback_rate NUMERIC;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS locked_tax_rate NUMERIC;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_custom_cashback BOOLEAN DEFAULT FALSE;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS claim_pending BOOLEAN DEFAULT FALSE;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS claim_verified BOOLEAN DEFAULT FALSE;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS claim_rejected BOOLEAN DEFAULT FALSE;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS claim_reject_reason TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS claimed_by_user_id TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_source TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_time BIGINT DEFAULT 0;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS clawback_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS reject_reason TEXT;

        -- Phase 4 Performance Composite Indexes (Idempotent)
        CREATE INDEX IF NOT EXISTS idx_orders_user_status_created ON orders(user_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status ON withdrawals(user_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
      `);

      // Relational-authoritative state synchronization from Postgres
      const loadedState = await loadAuthoritativeStateFromPostgres(client);
      // Bootstrap/fallback users must exist in SQL before marking them committed.
      const storedUsers = await client.query('SELECT id FROM users');
      const storedUserIds = new Set(storedUsers.rows.map(row => row.id));
      await batchSyncUsers(client, loadedState.users.filter(user => !storedUserIds.has(user.id)));
      memoryCache = loadedState;
      pgSchemaReady = true;

      // Update hoantienshop_state snapshot (lean encrypted settings envelope)
      const stateCheck = await client.query("SELECT version FROM hoantienshop_state WHERE id = 'main'");
      const encryptedStateEnvelope = {
        settings: encryptSettingsObject(loadedState.settings, getSettingsEncryptionSecret())
      };
      if (stateCheck.rows.length === 0) {
        await client.query(
          `INSERT INTO hoantienshop_state (id, payload, version, updated_at) VALUES ('main', $1, 1, NOW())`,
          [JSON.stringify(encryptedStateEnvelope)]
        );
        currentDbVersion = 1;
      } else {
        currentDbVersion = Number(stateCheck.rows[0].version || 1);
      }
      pgCommittedFingerprints = capturePgFingerprints(loadedState, currentDbVersion);

      await client.query('COMMIT');

      // Persist authoritative state to disk cache (with encrypted settings)
      try {
        const dir = path.dirname(LOCAL_DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${LOCAL_DB_PATH}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(
          tmpPath,
          JSON.stringify({
            ...loadedState,
            settings: encryptedStateEnvelope.settings
          }),
          'utf8'
        );
        fs.renameSync(tmpPath, LOCAL_DB_PATH);
      } catch (_) {}

      logger.logLeave('initPostgresIfConfigured', {
        status: 'ready',
        usersCount: memoryCache.users.length,
        ordersCount: memoryCache.orders.length
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
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
  const clicksRes = await client.query("SELECT * FROM clicks WHERE created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC");
  const auditLogsRes = await client.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000');
  const stateRes = await client.query("SELECT payload, version FROM hoantienshop_state WHERE id = 'main'");

  const initial = getInitialData();
  let settings = initial.settings;
  let payloadUsers = [];
  let payloadOrders = [];
  let payloadLedger = [];
  let payloadWithdrawals = [];
  let payloadAuditLogs = [];

  if (stateRes.rows.length > 0 && stateRes.rows[0].payload) {
    const p = stateRes.rows[0].payload;
    if (p.settings && typeof p.settings === 'object') {
      settings = decryptSettingsObject(
        { ...settings, ...p.settings },
        getSettingsEncryptionSecret()
      );
    }
    if (Array.isArray(p.users)) payloadUsers = p.users;
    if (Array.isArray(p.orders)) payloadOrders = p.orders;
    if (Array.isArray(p.ledger)) payloadLedger = p.ledger;
    if (Array.isArray(p.withdrawals)) payloadWithdrawals = p.withdrawals;
    if (Array.isArray(p.auditLogs)) payloadAuditLogs = p.auditLogs;
  }
  migrateReferralBountySetting(settings);

  let finalUsers = [];
  if (usersRes.rows.length > 0) {
    finalUsers = usersRes.rows.map(mapUserRow);
  } else if (payloadUsers.length > 0) {
    finalUsers = payloadUsers;
  } else {
    finalUsers = initial.users;
  }

  // Ensure admin user is always present even if relational table only contained non-admin users
  if (!finalUsers.some((u) => u.role === 'admin')) {
    const adminUser = payloadUsers.find((u) => u.role === 'admin') || initial.users.find((u) => u.role === 'admin');
    if (adminUser) finalUsers.unshift(adminUser);
  }

  const hasRelationalState = usersRes.rows.length > 0;

  const tableOrders = ordersRes.rows.map(mapOrderRow);

  let finalOrders = tableOrders;
  if (!hasRelationalState && finalOrders.length === 0 && payloadOrders.length > 0) {
    finalOrders = payloadOrders;
  }

  const tableLedger = ledgerRes.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amount: Math.round(Number(row.amount || 0)),
    refId: row.ref_id,
    note: row.note || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
  }));

  let finalLedger = tableLedger;
  if (!hasRelationalState && finalLedger.length === 0 && payloadLedger.length > 0) {
    finalLedger = payloadLedger;
  }

  const tableWithdrawals = withdrawalsRes.rows.map((row) => ({
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
    idempotencyKey: row.idempotency_key || null,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : (row.updated_at ? new Date(row.updated_at).toISOString() : null)
  }));

  let finalWithdrawals = tableWithdrawals;
  if (!hasRelationalState && finalWithdrawals.length === 0 && payloadWithdrawals.length > 0) {
    finalWithdrawals = payloadWithdrawals;
  }

  const finalClicks = clicksRes.rows
    .map((row) => ({
      clickId: row.click_id,
      userId: row.user_id || null,
      userCode: row.user_code || 'GUEST',
      platform: row.platform || 'shopee',
      originalUrl: row.original_url || '',
      cleanUrl: row.clean_url || '',
      productId: row.product_id || '',
      affiliateUrl: row.affiliate_url || '',
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
    }));

  const tableAuditLogs = (auditLogsRes?.rows || []).map((row) => ({
    id: row.id,
    adminId: row.admin_id || 'admin',
    adminName: row.admin_name || 'Quản Trị Viên',
    action: row.action || 'unknown',
    targetId: row.target_id || null,
    details: row.details || {},
    timestamp: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
  }));
  const finalAuditLogs = (
    tableAuditLogs.length > 0 || hasRelationalState ? tableAuditLogs : payloadAuditLogs
  ).slice(0, 1000);

  return {
    settings,
    webhookReceipts: [],
    users: finalUsers,
    clicks: finalClicks,
    orders: finalOrders,
    ledger: finalLedger,
    withdrawals: finalWithdrawals,
    auditLogs: finalAuditLogs
  };
}

// ================= MULTI-ROW BATCH POSTGRES SYNC HELPERS =================

let pgCommittedFingerprints = null;

function capturePgFingerprints(data, version) {
  const users = new Map();
  for (const u of data?.users || []) {
    if (u?.id) users.set(u.id, JSON.stringify(u));
  }
  const orders = new Map();
  for (const o of data?.orders || []) {
    if (o?.orderSn) orders.set(`${o.platform || 'shopee'}:${o.orderSn}`, JSON.stringify(o));
  }
  const withdrawals = new Map();
  for (const w of data?.withdrawals || []) {
    if (w?.id) withdrawals.set(w.id, JSON.stringify(w));
  }
  const ledgerRefs = new Set();
  for (const l of data?.ledger || []) {
    if (l?.refId) ledgerRefs.add(l.refId);
  }
  const clickIds = new Set();
  for (const c of data?.clicks || []) {
    if (c?.clickId) clickIds.add(c.clickId);
  }
  const auditIds = new Set();
  for (const a of data?.auditLogs || []) {
    if (a?.id) auditIds.add(a.id);
  }
  return { version, users, orders, withdrawals, ledgerRefs, clickIds, auditIds };
}

function chunkArray(items, size) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function batchSyncLedger(client, ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) return;
  const chunks = chunkArray(ledger, 50);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const l of chunk) {
      if (!l || !l.id || !l.refId) continue;
      valuePlaceholders.push(`($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6})`);
      params.push(
        l.id,
        l.userId,
        l.type,
        Math.round(Number(l.amount || 0)),
        l.refId,
        l.note || '',
        l.createdAt ? new Date(l.createdAt) : new Date()
      );
      pIdx += 7;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO ledger (id, user_id, type, amount, ref_id, note, created_at)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (ref_id) DO NOTHING
    `;
    await client.query(query, params);
  }
}

async function batchSyncUsers(client, users) {
  if (!Array.isArray(users) || users.length === 0) return;

  const chunks = chunkArray(users, 25);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const u of chunk) {
      if (!u || !u.id) continue;
      valuePlaceholders.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11}, $${pIdx + 12}, $${pIdx + 13}, $${pIdx + 14}, $${pIdx + 15}, $${pIdx + 16}, $${pIdx + 17}, $${pIdx + 18}, $${pIdx + 19}, $${pIdx + 20}, $${pIdx + 21}, $${pIdx + 22}, $${pIdx + 23}, $${pIdx + 24})`
      );
      params.push(
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
        Boolean(u.accountLocked),
        Boolean(u.isDeleted),
        u.deletedAt ? new Date(u.deletedAt) : null,
        u.deletedByAdminId || null,
        Boolean(u.hasNegativeBalance),
        u.customCashbackPercent !== null && u.customCashbackPercent !== undefined && Number.isFinite(Number(u.customCashbackPercent))
          ? Number(u.customCashbackPercent)
          : null,
        Math.max(0, Math.round(Number(u.totalApprovedSpend || 0))),
        String(u.vipTier || 'bronze'),
        u.createdAt ? new Date(u.createdAt) : new Date()
      );
      pIdx += 25;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO users (
        id, code, name, phone, email, password_hash, role, token_version,
        referred_by, balance_available, balance_pending, total_earned,
        total_withdrawn, bank_name, bank_account, bank_owner, account_locked,
        is_deleted, deleted_at, deleted_by_admin_id, has_negative_balance, custom_cashback_percent,
        total_approved_spend, vip_tier, created_at
      )
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        token_version = EXCLUDED.token_version,
        referred_by = EXCLUDED.referred_by,
        balance_available = (SELECT COALESCE(SUM(l.amount), 0) FROM ledger l WHERE l.user_id = users.id),
        balance_pending = EXCLUDED.balance_pending,
        total_earned = EXCLUDED.total_earned,
        total_withdrawn = EXCLUDED.total_withdrawn,
        bank_name = EXCLUDED.bank_name,
        bank_account = EXCLUDED.bank_account,
        bank_owner = EXCLUDED.bank_owner,
        account_locked = EXCLUDED.account_locked,
        is_deleted = EXCLUDED.is_deleted,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by_admin_id = EXCLUDED.deleted_by_admin_id,
        has_negative_balance = EXCLUDED.has_negative_balance,
        custom_cashback_percent = EXCLUDED.custom_cashback_percent,
        total_approved_spend = EXCLUDED.total_approved_spend,
        vip_tier = EXCLUDED.vip_tier
    `;
    await client.query(query, params);
  }
}

async function batchSyncWithdrawals(client, withdrawals) {
  if (!Array.isArray(withdrawals)) return;
  if (withdrawals.length === 0) return;

  const chunks = chunkArray(withdrawals, 30);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const w of chunk) {
      if (!w || !w.id) continue;
      valuePlaceholders.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11}, $${pIdx + 12})`
      );
      params.push(
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
        w.status || 'pending',
        w.idempotencyKey || null,
        w.createdAt ? new Date(w.createdAt) : new Date()
      );
      pIdx += 13;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO withdrawals (
        id, user_id, user_code, user_name, user_phone, amount,
        method, bank_name, bank_account, bank_owner, status, idempotency_key, created_at
      )
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        status = CASE 
          WHEN withdrawals.status IN ('paid', 'rejected') THEN withdrawals.status 
          ELSE EXCLUDED.status 
        END,
        idempotency_key = COALESCE(withdrawals.idempotency_key, EXCLUDED.idempotency_key),
        processed_at = CASE 
          WHEN withdrawals.status IN ('paid', 'rejected') THEN withdrawals.processed_at 
          WHEN EXCLUDED.status IN ('paid', 'rejected') THEN NOW() 
          ELSE withdrawals.processed_at 
        END
    `;
    await client.query(query, params);
  }
}

async function batchSyncOrders(client, orders) {
  if (!Array.isArray(orders)) return;
  if (orders.length === 0) return;

  const chunks = chunkArray(orders, 25);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const o of chunk) {
      if (!o || !o.orderSn) continue;
      valuePlaceholders.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10}, $${pIdx + 11}, $${pIdx + 12}, $${pIdx + 13}, $${pIdx + 14}, $${pIdx + 15}, $${pIdx + 16}, $${pIdx + 17}, $${pIdx + 18}, $${pIdx + 19}, $${pIdx + 20}, $${pIdx + 21}, $${pIdx + 22}, $${pIdx + 23}, $${pIdx + 24}, $${pIdx + 25}, $${pIdx + 26}, $${pIdx + 27}, $${pIdx + 28}, $${pIdx + 29})`
      );
      params.push(
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
        o.status || 'pending',
        Number(o.cashbackRate || 70),
        o.lockedCashbackRate != null ? Number(o.lockedCashbackRate) : null,
        o.lockedTaxRate != null ? Number(o.lockedTaxRate) : null,
        Boolean(o.hasCustomCashback),
        Boolean(o.claimPending),
        o.claimedByUserId || null,
        o.submittedByUserId || null,
        o.statusSource || null,
        parseTimestamp(o.eventTime),
        o.clawbackAt ? new Date(o.clawbackAt) : null,
        o.createdAt ? new Date(o.createdAt) : new Date(),
        o.updatedAt ? new Date(o.updatedAt) : new Date(),
        Boolean(o.claimVerified),
        Boolean(o.claimRejected),
        o.claimRejectReason || null,
        o.merchant || null,
        o.rejectReason || null
      );
      pIdx += 30;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO orders (
        order_sn, platform, click_id, user_id, user_code, product_name,
        order_amount, gross_commission, tax_amount, net_commission,
        user_cashback_amount, admin_share_amount, status,
        cashback_rate, locked_cashback_rate, locked_tax_rate, has_custom_cashback,
        claim_pending, claimed_by_user_id, submitted_by_user_id, status_source,
        event_time, clawback_at, created_at, updated_at, claim_verified, claim_rejected, claim_reject_reason,
        merchant, reject_reason
      )
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (platform, order_sn) DO UPDATE SET
        platform = COALESCE(NULLIF(EXCLUDED.platform, ''), orders.platform),
        product_name = CASE
          WHEN EXCLUDED.status_source = 'admin' AND EXCLUDED.product_name IS NOT NULL THEN EXCLUDED.product_name
          WHEN (orders.product_name IS NULL OR orders.product_name = '') AND EXCLUDED.product_name <> '' THEN EXCLUDED.product_name
          ELSE orders.product_name
        END,
        order_amount = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.order_amount
          WHEN EXCLUDED.order_amount > 0 THEN EXCLUDED.order_amount
          ELSE orders.order_amount
        END,
        user_id = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.user_id
          ELSE COALESCE(orders.user_id, EXCLUDED.user_id)
        END,
        user_code = CASE
          WHEN EXCLUDED.status_source = 'admin' AND EXCLUDED.user_code IS NOT NULL AND EXCLUDED.user_code <> '' THEN EXCLUDED.user_code
          WHEN orders.user_code = 'GUEST' THEN EXCLUDED.user_code
          ELSE orders.user_code
        END,
        gross_commission = EXCLUDED.gross_commission,
        tax_amount = EXCLUDED.tax_amount,
        net_commission = EXCLUDED.net_commission,
        user_cashback_amount = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.user_cashback_amount
          ELSE EXCLUDED.user_cashback_amount
        END,
        admin_share_amount = EXCLUDED.admin_share_amount,
        status = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.status
          WHEN orders.status IN ('approved', 'cancelled') AND EXCLUDED.status = 'pending' THEN orders.status
          ELSE EXCLUDED.status
        END,
        cashback_rate = COALESCE(EXCLUDED.cashback_rate, orders.cashback_rate),
        locked_cashback_rate = COALESCE(orders.locked_cashback_rate, EXCLUDED.locked_cashback_rate),
        locked_tax_rate = COALESCE(orders.locked_tax_rate, EXCLUDED.locked_tax_rate),
        has_custom_cashback = EXCLUDED.has_custom_cashback,
        claim_pending = EXCLUDED.claim_pending,
        claim_verified = EXCLUDED.claim_verified,
        claim_rejected = EXCLUDED.claim_rejected,
        claim_reject_reason = EXCLUDED.claim_reject_reason,
        claimed_by_user_id = COALESCE(EXCLUDED.claimed_by_user_id, orders.claimed_by_user_id),
        submitted_by_user_id = COALESCE(EXCLUDED.submitted_by_user_id, orders.submitted_by_user_id),
        status_source = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN 'admin'
          ELSE COALESCE(EXCLUDED.status_source, orders.status_source)
        END,
        event_time = GREATEST(COALESCE(orders.event_time, 0), COALESCE(EXCLUDED.event_time, 0)),
        clawback_at = COALESCE(orders.clawback_at, EXCLUDED.clawback_at),
        merchant = COALESCE(NULLIF(EXCLUDED.merchant, ''), orders.merchant),
        reject_reason = COALESCE(NULLIF(EXCLUDED.reject_reason, ''), orders.reject_reason),
        updated_at = NOW()
    `;
    await client.query(query, params);
  }
}

// Clicks are immutable append-only records. Snapshot writes only INSERT ... DO NOTHING
// for this table, so independent inserts neither overwrite financial state nor need
// the financial snapshot version lock. Publish to memory only after database success.
let lastClickCachePruneAt = 0;
async function appendClickRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return;
  const valid = cleanExpiredClicks(records);
  if (valid.length !== records.length || valid.some(c => !c.clickId || !c.affiliateUrl)) {
    throw new Error('Invalid click records');
  }
  let inserted = valid;
  if (pgPool) {
    if (!pgSchemaReady) throw new Error('Postgres schema is not ready');
    const rows = valid.map(c => ({ click_id: c.clickId, user_id: c.userId || null,
      user_code: c.userCode || 'GUEST', platform: c.platform || 'shopee',
      original_url: c.originalUrl || '', clean_url: c.cleanUrl || '',
      product_id: c.productId || '', affiliate_url: c.affiliateUrl, created_at: c.createdAt }));
    const result = await pgPool.query(`
      INSERT INTO clicks (click_id, user_id, user_code, platform, original_url, clean_url, product_id, affiliate_url, created_at)
      SELECT click_id, user_id, user_code, platform, original_url, clean_url, product_id, affiliate_url, created_at
      FROM jsonb_to_recordset($1::jsonb) AS c(click_id text, user_id text, user_code text, platform text,
        original_url text, clean_url text, product_id text, affiliate_url text, created_at timestamptz)
      ON CONFLICT (click_id) DO NOTHING RETURNING click_id
    `, [JSON.stringify(rows)]);
    const ids = new Set(result.rows.map(c => c.click_id));
    inserted = valid.filter(c => ids.delete(c.clickId));
  }
  const db = ensureDbLoaded();
  // Local mode also supports replay without duplicating cache records.
  if (!pgPool) {
    const existing = new Set(db.clicks.map(c => c.clickId));
    inserted = valid.filter(c => {
      if (existing.has(c.clickId)) return false;
      existing.add(c.clickId);
      return true;
    });
  }
  db.clicks.unshift(...inserted);
  if (Date.now() - lastClickCachePruneAt >= 60000) {
    db.clicks = cleanExpiredClicks(db.clicks);
    lastClickCachePruneAt = Date.now();
  }
  if (!pgPool) {
    try { await saveDb(db); }
    catch (err) {
      const ids = new Set(inserted.map(c => c.clickId));
      db.clicks = db.clicks.filter(c => !ids.has(c.clickId));
      throw err;
    }
  }
}

async function findClickById(clickId, { forAttribution = false } = {}) {
  // Link expiry is not an attribution deadline: reports can arrive after settlement.
  // Old PostgreSQL records remain authoritative; do not extend public redirect TTL.
  const cutoff = Date.now() - 30 * 86400000;
  const cached = ensureDbLoaded().clicks.find(c => c.clickId === clickId && (forAttribution || new Date(c.createdAt).getTime() > cutoff));
  if (cached || !pgPool) return cached || null;
  const result = await pgPool.query(forAttribution
    ? 'SELECT * FROM clicks WHERE click_id = $1'
    : "SELECT * FROM clicks WHERE click_id = $1 AND created_at > NOW() - INTERVAL '30 days'", [clickId]);
  const row = result.rows[0];
  if (!row) return null;
  const click = { clickId: row.click_id, userId: row.user_id, userCode: row.user_code,
    platform: row.platform, originalUrl: row.original_url, cleanUrl: row.clean_url,
    productId: row.product_id, affiliateUrl: row.affiliate_url, createdAt: row.created_at };
  const db = ensureDbLoaded();
  if (!db.clicks.some(c => c.clickId === clickId)) db.clicks.unshift(click);
  return click;
}

async function batchSyncClicks(client, clicks) {
  if (!Array.isArray(clicks) || clicks.length === 0) return;
  // Persist every unexpired click; count caps silently lose attribution.
  const recentClicks = cleanExpiredClicks(clicks);
  const chunks = chunkArray(recentClicks, 50);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const c of chunk) {
      if (!c || !c.clickId) continue;
      valuePlaceholders.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8})`
      );
      params.push(
        c.clickId,
        c.userId || null,
        c.userCode || 'GUEST',
        c.platform || 'shopee',
        c.originalUrl || '',
        c.cleanUrl || '',
        c.productId || '',
        c.affiliateUrl || '',
        c.createdAt ? new Date(c.createdAt) : new Date()
      );
      pIdx += 9;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO clicks (
        click_id, user_id, user_code, platform, original_url,
        clean_url, product_id, affiliate_url, created_at
      )
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (click_id) DO NOTHING
    `;
    await client.query(query, params);
  }
}

async function batchSyncAuditLogs(client, auditLogs) {
  if (!Array.isArray(auditLogs) || auditLogs.length === 0) return;
  const recentLogs = auditLogs.slice(0, 200);
  const chunks = chunkArray(recentLogs, 50);
  for (const chunk of chunks) {
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const a of chunk) {
      if (!a || !a.id) continue;
      valuePlaceholders.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}::jsonb, $${pIdx + 6})`
      );
      params.push(
        a.id,
        a.adminId || 'admin',
        a.adminName || 'Quản Trị Viên',
        a.action || 'unknown',
        a.targetId || null,
        JSON.stringify(a.details || {}),
        a.timestamp ? new Date(a.timestamp) : new Date()
      );
      pIdx += 7;
    }

    if (valuePlaceholders.length === 0) continue;

    const query = `
      INSERT INTO audit_logs (id, admin_id, admin_name, action, target_id, details, created_at)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;
    await client.query(query, params);
  }
}

// ================= GRANULAR POSTGRES PERSISTENCE (NON-OVERWRITING) =================

async function persistOrderToPostgres(order, customClient = null) {
  if (!pgPool || !pgSchemaReady || !order || !order.orderSn) return null;
  const client = customClient || (await pgPool.connect());
  try {
    const query = `
      INSERT INTO orders (
        order_sn, platform, click_id, user_id, user_code, product_name,
        order_amount, gross_commission, tax_amount, net_commission,
        user_cashback_amount, admin_share_amount, status,
        cashback_rate, locked_cashback_rate, locked_tax_rate, has_custom_cashback,
        claim_pending, claimed_by_user_id, submitted_by_user_id, status_source,
        event_time, clawback_at, created_at, updated_at, claim_verified, claim_rejected, claim_reject_reason,
        merchant, reject_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
      ON CONFLICT (platform, order_sn) DO UPDATE SET
        platform = COALESCE(NULLIF(EXCLUDED.platform, ''), orders.platform),
        product_name = CASE
          WHEN EXCLUDED.status_source = 'admin' AND EXCLUDED.product_name IS NOT NULL THEN EXCLUDED.product_name
          WHEN (orders.product_name IS NULL OR orders.product_name = '') AND EXCLUDED.product_name <> '' THEN EXCLUDED.product_name
          ELSE orders.product_name
        END,
        order_amount = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.order_amount
          WHEN EXCLUDED.order_amount > 0 THEN EXCLUDED.order_amount
          ELSE orders.order_amount
        END,
        user_id = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.user_id
          ELSE COALESCE(orders.user_id, EXCLUDED.user_id)
        END,
        user_code = CASE
          WHEN EXCLUDED.status_source = 'admin' AND EXCLUDED.user_code IS NOT NULL AND EXCLUDED.user_code <> '' THEN EXCLUDED.user_code
          WHEN orders.user_code = 'GUEST' THEN EXCLUDED.user_code
          ELSE orders.user_code
        END,
        gross_commission = EXCLUDED.gross_commission,
        tax_amount = EXCLUDED.tax_amount,
        net_commission = EXCLUDED.net_commission,
        user_cashback_amount = CASE 
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.user_cashback_amount
          ELSE EXCLUDED.user_cashback_amount 
        END,
        admin_share_amount = EXCLUDED.admin_share_amount,
        status = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN EXCLUDED.status
          WHEN orders.status IN ('approved', 'cancelled') AND EXCLUDED.status = 'pending' THEN orders.status
          ELSE EXCLUDED.status
        END,
        cashback_rate = COALESCE(EXCLUDED.cashback_rate, orders.cashback_rate),
        locked_cashback_rate = COALESCE(orders.locked_cashback_rate, EXCLUDED.locked_cashback_rate),
        locked_tax_rate = COALESCE(orders.locked_tax_rate, EXCLUDED.locked_tax_rate),
        has_custom_cashback = EXCLUDED.has_custom_cashback,
        claim_pending = EXCLUDED.claim_pending,
        claim_verified = EXCLUDED.claim_verified,
        claim_rejected = EXCLUDED.claim_rejected,
        claim_reject_reason = EXCLUDED.claim_reject_reason,
        claimed_by_user_id = COALESCE(EXCLUDED.claimed_by_user_id, orders.claimed_by_user_id),
        submitted_by_user_id = COALESCE(orders.submitted_by_user_id, EXCLUDED.submitted_by_user_id),
        status_source = CASE
          WHEN EXCLUDED.status_source = 'admin' THEN 'admin'
          ELSE COALESCE(EXCLUDED.status_source, orders.status_source)
        END,
        event_time = GREATEST(COALESCE(orders.event_time, 0), COALESCE(EXCLUDED.event_time, 0)),
        clawback_at = COALESCE(orders.clawback_at, EXCLUDED.clawback_at),
        merchant = COALESCE(NULLIF(EXCLUDED.merchant, ''), orders.merchant),
        reject_reason = COALESCE(NULLIF(EXCLUDED.reject_reason, ''), orders.reject_reason),
        updated_at = NOW()
      RETURNING *;
    `;
    const params = [
      order.orderSn,
      order.platform || 'shopee',
      order.clickId || null,
      order.userId || null,
      order.userCode || 'GUEST',
      order.productName || '',
      Math.round(Number(order.orderAmount || 0)),
      Math.round(Number(order.grossCommission || 0)),
      Math.round(Number(order.taxAmount || 0)),
      Math.round(Number(order.netCommission || 0)),
      Math.round(Number(order.userCashbackAmount || 0)),
      Math.round(Number(order.adminShareAmount || 0)),
      order.status || 'pending',
      Number(order.cashbackRate || 70),
      order.lockedCashbackRate != null ? Number(order.lockedCashbackRate) : null,
      order.lockedTaxRate != null ? Number(order.lockedTaxRate) : null,
      Boolean(order.hasCustomCashback),
      Boolean(order.claimPending),
      order.claimedByUserId || null,
      order.submittedByUserId || null,
      order.statusSource || null,
      parseTimestamp(order.eventTime),
      order.clawbackAt ? new Date(order.clawbackAt) : null,
      order.createdAt ? new Date(order.createdAt) : new Date(),
      order.updatedAt ? new Date(order.updatedAt) : new Date(),
      Boolean(order.claimVerified),
      Boolean(order.claimRejected),
      order.claimRejectReason || null,
      order.merchant || null,
      order.rejectReason || null
    ];
    const res = await client.query(query, params);
    return res.rows[0];
  } finally {
    if (!customClient) client.release();
  }
}

async function persistUserToPostgres(user, customClient = null) {
  if (!pgPool || !pgSchemaReady || !user || !user.id) return null;
  const client = customClient || (await pgPool.connect());
  try {
    const query = `
      INSERT INTO users (
        id, code, name, phone, email, password_hash, role, token_version,
        referred_by, balance_available, balance_pending, total_earned,
        total_withdrawn, bank_name, bank_account, bank_owner, account_locked,
        is_deleted, deleted_at, deleted_by_admin_id, has_negative_balance, custom_cashback_percent,
        total_approved_spend, vip_tier, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      ON CONFLICT (id) DO UPDATE SET
        code = EXCLUDED.code,
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        token_version = EXCLUDED.token_version,
        referred_by = EXCLUDED.referred_by,
        balance_available = (SELECT COALESCE(SUM(l.amount), 0) FROM ledger l WHERE l.user_id = users.id),
        balance_pending = EXCLUDED.balance_pending,
        total_earned = EXCLUDED.total_earned,
        total_withdrawn = EXCLUDED.total_withdrawn,
        bank_name = EXCLUDED.bank_name,
        bank_account = EXCLUDED.bank_account,
        bank_owner = EXCLUDED.bank_owner,
        account_locked = EXCLUDED.account_locked,
        is_deleted = EXCLUDED.is_deleted,
        deleted_at = EXCLUDED.deleted_at,
        deleted_by_admin_id = EXCLUDED.deleted_by_admin_id,
        has_negative_balance = EXCLUDED.has_negative_balance,
        custom_cashback_percent = EXCLUDED.custom_cashback_percent,
        total_approved_spend = EXCLUDED.total_approved_spend,
        vip_tier = EXCLUDED.vip_tier
      RETURNING *;
    `;
    const params = [
      user.id,
      user.code,
      user.name || '',
      user.phone,
      user.email || '',
      user.passwordHash,
      user.role || 'user',
      Number(user.tokenVersion || 1),
      user.referredBy || null,
      Math.round(Number(user.balanceAvailable || 0)),
      Math.round(Number(user.balancePending || 0)),
      Math.round(Number(user.totalEarned || 0)),
      Math.round(Number(user.totalWithdrawn || 0)),
      user.bankName || '',
      user.bankAccount || '',
      user.bankOwner || '',
      Boolean(user.accountLocked),
      Boolean(user.isDeleted),
      user.deletedAt ? new Date(user.deletedAt) : null,
      user.deletedByAdminId || null,
      Boolean(user.hasNegativeBalance),
      user.customCashbackPercent !== null && user.customCashbackPercent !== undefined && Number.isFinite(Number(user.customCashbackPercent))
        ? Number(user.customCashbackPercent)
        : null,
      Math.max(0, Math.round(Number(user.totalApprovedSpend || 0))),
      String(user.vipTier || 'bronze'),
      user.createdAt ? new Date(user.createdAt) : new Date()
    ];
    const res = await client.query(query, params);
    return res.rows[0];
  } finally {
    if (!customClient) client.release();
  }
}

async function persistLedgerToPostgres(entry, customClient = null) {
  if (!pgPool || !pgSchemaReady || !entry || !entry.refId) return null;
  const client = customClient || (await pgPool.connect());
  try {
    const query = `
      INSERT INTO ledger (id, user_id, type, amount, ref_id, note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (ref_id) DO NOTHING
      RETURNING *;
    `;
    const params = [
      entry.id,
      entry.userId,
      entry.type,
      Math.round(Number(entry.amount || 0)),
      entry.refId,
      entry.note || '',
      entry.createdAt ? new Date(entry.createdAt) : new Date()
    ];
    const res = await client.query(query, params);
    return res.rows[0] || null;
  } finally {
    if (!customClient) client.release();
  }
}

async function persistWithdrawalToPostgres(withdrawal, customClient = null) {
  if (!pgPool || !pgSchemaReady || !withdrawal || !withdrawal.id) return null;
  const client = customClient || (await pgPool.connect());
  try {
    const query = `
      INSERT INTO withdrawals (
        id, user_id, user_code, user_name, user_phone, amount,
        method, bank_name, bank_account, bank_owner, status, idempotency_key, created_at, processed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        status = CASE 
          WHEN withdrawals.status IN ('paid', 'rejected') THEN withdrawals.status 
          ELSE EXCLUDED.status 
        END,
        idempotency_key = COALESCE(withdrawals.idempotency_key, EXCLUDED.idempotency_key),
        processed_at = CASE 
          WHEN withdrawals.status IN ('paid', 'rejected') THEN withdrawals.processed_at 
          WHEN EXCLUDED.status IN ('paid', 'rejected') THEN NOW() 
          ELSE withdrawals.processed_at 
        END
      RETURNING *;
    `;
    const params = [
      withdrawal.id,
      withdrawal.userId,
      withdrawal.userCode || '',
      withdrawal.userName || '',
      withdrawal.userPhone || '',
      Math.round(Number(withdrawal.amount || 0)),
      withdrawal.method || 'bank',
      withdrawal.bankName || '',
      withdrawal.bankAccount || '',
      withdrawal.bankOwner || '',
      withdrawal.status || 'pending',
      withdrawal.idempotencyKey || null,
      withdrawal.createdAt ? new Date(withdrawal.createdAt) : new Date(),
      withdrawal.processedAt ? new Date(withdrawal.processedAt) : null
    ];
    const res = await client.query(query, params);
    return res.rows[0];
  } finally {
    if (!customClient) client.release();
  }
}

/**
 * High-performance batched state synchronization with Optimistic Concurrency Control (OCC).
 * Serializes batches and rejects stale versions. The caller must reload and retry
 * the complete business operation; replaying a fresh snapshot would lose its intent.
 */
async function syncSnapshotToPostgres(data, expectedVersion = currentDbVersion, deletedOrders = []) {
  if (!pgPool || !pgSchemaReady) return;
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // Lock the shared version before touching any financial rows (consistent lock order).
    const stateLock = await client.query("SELECT version FROM hoantienshop_state WHERE id = 'main' FOR UPDATE");
    if (stateLock.rows.length && Number(stateLock.rows[0].version) !== expectedVersion) {
      const err = new Error('Dữ liệu đã thay đổi. Vui lòng tải lại và thử lại thao tác.');
      err.status = 409;
      err.code = 'STATE_CONFLICT';
      throw err;
    }

    const baseFp =
      pgCommittedFingerprints && pgCommittedFingerprints.version === expectedVersion
        ? pgCommittedFingerprints
        : null;

    // 1. Sync webhook receipts & delta ledger first so users balance recalculation subquery sees latest entries
    for (const receipt of data.webhookReceipts || []) {
      const inserted = await client.query(`INSERT INTO webhook_receipts (receipt_key, payload_hash) VALUES ($1,$2)
        ON CONFLICT (receipt_key) DO UPDATE SET payload_hash=webhook_receipts.payload_hash
        RETURNING payload_hash`, [receipt.key, receipt.hash]);
      if (inserted.rows[0].payload_hash !== receipt.hash) throw new Error('Webhook receipt payload conflict');
    }
    const ledgerToSync = baseFp
      ? (data.ledger || []).filter((l) => l?.refId && !baseFp.ledgerRefs.has(l.refId))
      : data.ledger;
    await batchSyncLedger(client, ledgerToSync);

    // 2. Sync dirty users with calculated balance from authoritative ledger
    const usersToSync = baseFp
      ? (data.users || []).filter((u) => u?.id && baseFp.users.get(u.id) !== JSON.stringify(u))
      : data.users;
    await batchSyncUsers(client, usersToSync);

    // Missing records never authorize deletion. Only the explicit admin operation can delete orders.
    await batchSyncWithdrawals(client, baseFp
      ? (data.withdrawals || []).filter(w => w?.id && baseFp.withdrawals.get(w.id) !== JSON.stringify(w))
      : data.withdrawals);
    await batchSyncOrders(client, baseFp
      ? (data.orders || []).filter(o => o?.orderSn && baseFp.orders.get(`${o.platform || 'shopee'}:${o.orderSn}`) !== JSON.stringify(o))
      : data.orders);
    for (const target of deletedOrders) {
      if (!target.sn || !target.platform || (data.orders || []).some(o => o.orderSn === target.sn && (o.platform || 'shopee') === target.platform)) {
        throw new Error('Invalid explicit order deletion');
      }
      await client.query('DELETE FROM orders WHERE platform=$1 AND order_sn=$2', [target.platform, target.sn]);
    }

    // 5. Sync new clicks only (append-only)
    const clicksToSync = baseFp
      ? (data.clicks || []).filter((c) => c?.clickId && !baseFp.clickIds.has(c.clickId))
      : data.clicks;
    await batchSyncClicks(client, clicksToSync);

    // 5.5 Sync new audit logs only (append-only)
    const auditsToSync = baseFp
      ? (data.auditLogs || []).slice(0, 200).filter((a) => a?.id && !baseFp.auditIds.has(a.id))
      : data.auditLogs;
    await batchSyncAuditLogs(client, auditsToSync);

    // 6. Optimistic Concurrency Control on hoantienshop_state (lean encrypted settings envelope instead of O(N) full DB blob)
    const statePayloadJson = JSON.stringify({
      settings: encryptSettingsObject(data.settings, getSettingsEncryptionSecret())
    });
    const updateRes = await client.query(
      `UPDATE hoantienshop_state
       SET payload = $1, version = version + 1, updated_at = NOW()
       WHERE id = 'main' AND version = $2
       RETURNING version`,
      [statePayloadJson, expectedVersion]
    );

    if (updateRes.rowCount === 0) {
      const checkRes = await client.query("SELECT version FROM hoantienshop_state WHERE id = 'main'");
      if (checkRes.rows.length === 0) {
        const insertRes = await client.query(
          `INSERT INTO hoantienshop_state (id, payload, version, updated_at)
           VALUES ('main', $1, 1, NOW())
           RETURNING version`,
          [statePayloadJson]
        );
        currentDbVersion = Number(insertRes.rows[0]?.version || 1);
        await client.query('COMMIT');
        pgCommittedFingerprints = capturePgFingerprints(data, currentDbVersion);
        return;
      }

      const dbVersion = Number(checkRes.rows[0].version);
      logger.warning('syncSnapshotToPostgres', 'Xung đột phiên bản DB (Optimistic Concurrency Conflict)', {
        localVersion: currentDbVersion,
        dbVersion,
        expectedVersion
      });

      await client.query('ROLLBACK');

      const conflict = new Error('Dữ liệu đã thay đổi. Vui lòng tải lại và thử lại thao tác.');
      conflict.status = 409;
      conflict.code = 'STATE_CONFLICT';
      throw conflict;
    }

    await client.query('COMMIT');
    currentDbVersion = Number(updateRes.rows[0].version);
    pgCommittedFingerprints = capturePgFingerprints(data, currentDbVersion);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function reloadStateFromPostgres({ strict = false } = {}) {
  if (!pgPool) {
    const context = stateContext.getStore();
    if (context) { Object.assign(context.data, structuredClone(memoryCache)); context.version = currentDbVersion; context.invalid = false; }
    return ensureDbLoaded();
  }
  try {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const fresh = await loadAuthoritativeStateFromPostgres(client);
      const version = await client.query("SELECT version FROM hoantienshop_state WHERE id = 'main'");
      await client.query('COMMIT');
      const loadedVer = Number(version.rows[0]?.version || 1);
      pgCommittedFingerprints = capturePgFingerprints(fresh, loadedVer);
      const context = stateContext.getStore();
      if (context) {
        Object.assign(context.data, fresh);
        context.version = loadedVer;
        context.invalid = false;
        return context.data;
      }
      currentDbVersion = loadedVer;
      if (memoryCache) {
        memoryCache.settings = fresh.settings;
        memoryCache.users = fresh.users;
        memoryCache.clicks = fresh.clicks;
        memoryCache.orders = fresh.orders;
        memoryCache.ledger = fresh.ledger;
        memoryCache.withdrawals = fresh.withdrawals;
        memoryCache.auditLogs = fresh.auditLogs || [];
      } else {
        memoryCache = fresh;
      }
      cacheInvalid = false;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warning('reloadStateFromPostgres', 'Postgres reload error', { error: err.message });
    if (strict) throw err;
  }
  return ensureDbLoaded();
}

const memorySessions = new Map();

function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

function resolveSessionUser(userId) {
  const db = ensureDbLoaded();
  return db.users.find((u) => u.id === userId) || null;
}

async function createRefreshSession(user, { userAgent = '', nowMs = Date.now() } = {}) {
  const policy = getSessionPolicy(user);
  const rawRefreshToken = crypto.randomBytes(48).toString('base64url');
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const id = `sess_${crypto.randomUUID()}`;
  const familyId = `fam_${crypto.randomUUID()}`;
  const absoluteExpiresAt = nowMs + policy.absTtlSec * 1000;
  const expiresAt = Math.min(absoluteExpiresAt, nowMs + policy.idleTtlSec * 1000);
  const cleanUa = String(userAgent || '').slice(0, 240);

  if (!pgPool) {
    memorySessions.set(id, {
      id,
      userId: user.id,
      familyId,
      tokenHash,
      prevTokenHash: null,
      prevGraceUntil: null,
      userAgent: cleanUa,
      expiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      lastUsedAt: nowMs,
      createdAt: nowMs
    });
    return { sessionId: id, familyId, rawRefreshToken, expiresAt, absoluteExpiresAt, policy };
  }

  await pgPool.query(
    `INSERT INTO user_sessions (
      id, user_id, family_id, token_hash, user_agent, expires_at, absolute_expires_at, last_used_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, user.id, familyId, tokenHash, cleanUa, new Date(expiresAt), new Date(absoluteExpiresAt), new Date(nowMs)]
  );
  return { sessionId: id, familyId, rawRefreshToken, expiresAt, absoluteExpiresAt, policy };
}

function mapPgSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    prevTokenHash: row.prev_token_hash || null,
    prevGraceUntil: row.prev_grace_until ? new Date(row.prev_grace_until).getTime() : null,
    userAgent: row.user_agent || '',
    expiresAt: new Date(row.expires_at).getTime(),
    absoluteExpiresAt: new Date(row.absolute_expires_at).getTime(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null
  };
}

async function revokeSessionFamily(familyId, nowMs = Date.now()) {
  if (!familyId) return;
  if (!pgPool) {
    for (const s of memorySessions.values()) {
      if (s.familyId === familyId && !s.revokedAt) s.revokedAt = nowMs;
    }
    return;
  }
  await pgPool.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [
    familyId,
    new Date(nowMs)
  ]);
}

async function rotateRefreshSession(rawToken, { nowMs = Date.now(), userAgent = '' } = {}) {
  if (!rawToken || typeof rawToken !== 'string') return { ok: false, reason: 'MISSING' };
  const presentedHash = hashRefreshToken(rawToken);
  const cleanUa = String(userAgent || '').slice(0, 240);

  let session = null;
  let user = null;

  if (!pgPool) {
    for (const s of memorySessions.values()) {
      if (s.tokenHash === presentedHash || s.prevTokenHash === presentedHash) {
        session = s;
        break;
      }
    }
    if (!session) return { ok: false, reason: 'NOT_FOUND' };
    if (session.revokedAt) return { ok: false, reason: 'REVOKED' };
    if (nowMs >= session.absoluteExpiresAt || nowMs >= session.expiresAt) {
      session.revokedAt = nowMs;
      return { ok: false, reason: 'EXPIRED' };
    }
    user = resolveSessionUser(session.userId);
    if (!user || user.accountLocked || user.isDeleted) {
      await revokeSessionFamily(session.familyId, nowMs);
      return { ok: false, reason: 'USER_INVALID' };
    }
    const policy = getSessionPolicy(user);
    if (session.prevTokenHash === presentedHash) {
      if (session.prevGraceUntil && nowMs <= session.prevGraceUntil) {
        return {
          ok: true,
          graceReuse: true,
          user,
          policy,
          sessionId: session.id,
          maxAgeSec: Math.max(1, Math.floor((session.expiresAt - nowMs) / 1000))
        };
      }
      await revokeSessionFamily(session.familyId, nowMs);
      return { ok: false, reason: 'REUSE_DETECTED' };
    }

    const nextRawToken = crypto.randomBytes(48).toString('base64url');
    const nextHash = hashRefreshToken(nextRawToken);
    const nextExpiresAt = Math.min(session.absoluteExpiresAt, nowMs + policy.idleTtlSec * 1000);
    session.prevTokenHash = session.tokenHash;
    session.prevGraceUntil = nowMs + REFRESH_MULTI_TAB_GRACE_MS;
    session.tokenHash = nextHash;
    session.expiresAt = nextExpiresAt;
    session.lastUsedAt = nowMs;
    if (cleanUa) session.userAgent = cleanUa;
    return {
      ok: true,
      graceReuse: false,
      user,
      policy,
      sessionId: session.id,
      rawRefreshToken: nextRawToken,
      maxAgeSec: Math.max(1, Math.floor((nextExpiresAt - nowMs) / 1000))
    };
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const foundRes = await client.query(
      'SELECT * FROM user_sessions WHERE token_hash = $1 OR prev_token_hash = $1 LIMIT 1 FOR UPDATE',
      [presentedHash]
    );
    session = mapPgSessionRow(foundRes.rows[0]);
    if (!session) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (session.revokedAt) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'REVOKED' };
    }
    if (nowMs >= session.absoluteExpiresAt || nowMs >= session.expiresAt) {
      await client.query('UPDATE user_sessions SET revoked_at = $2 WHERE id = $1', [session.id, new Date(nowMs)]);
      await client.query('COMMIT');
      return { ok: false, reason: 'EXPIRED' };
    }

    const userRes = await client.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [session.userId]);
    const userRow = userRes.rows[0];
    if (!userRow || userRow.account_locked || userRow.is_deleted) {
      await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [
        session.familyId,
        new Date(nowMs)
      ]);
      await client.query('COMMIT');
      return { ok: false, reason: 'USER_INVALID' };
    }
    user = mapUserRow(userRow);
    const db = ensureDbLoaded();
    const memIdx = db.users.findIndex((u) => u.id === user.id);
    if (memIdx >= 0) Object.assign(db.users[memIdx], user);
    else db.users.push(user);

    const policy = getSessionPolicy(user);
    if (session.prevTokenHash === presentedHash) {
      if (session.prevGraceUntil && nowMs <= session.prevGraceUntil) {
        await client.query('COMMIT');
        return {
          ok: true,
          graceReuse: true,
          user,
          policy,
          sessionId: session.id,
          maxAgeSec: Math.max(1, Math.floor((session.expiresAt - nowMs) / 1000))
        };
      }
      await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1', [
        session.familyId,
        new Date(nowMs)
      ]);
      await client.query('COMMIT');
      return { ok: false, reason: 'REUSE_DETECTED' };
    }

    const nextRawToken = crypto.randomBytes(48).toString('base64url');
    const nextHash = hashRefreshToken(nextRawToken);
    const nextExpiresAt = Math.min(session.absoluteExpiresAt, nowMs + policy.idleTtlSec * 1000);
    const graceUntil = nowMs + REFRESH_MULTI_TAB_GRACE_MS;

    await client.query(
      `UPDATE user_sessions
       SET prev_token_hash = token_hash,
           prev_grace_until = $2,
           token_hash = $3,
           expires_at = $4,
           last_used_at = $5,
           user_agent = CASE WHEN $6 <> '' THEN $6 ELSE user_agent END
       WHERE id = $1`,
      [session.id, new Date(graceUntil), nextHash, new Date(nextExpiresAt), new Date(nowMs), cleanUa]
    );
    await client.query('COMMIT');
    return {
      ok: true,
      graceReuse: false,
      user,
      policy,
      sessionId: session.id,
      rawRefreshToken: nextRawToken,
      maxAgeSec: Math.max(1, Math.floor((nextExpiresAt - nowMs) / 1000))
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function revokeSessionByRefreshToken(rawToken, nowMs = Date.now()) {
  if (!rawToken || typeof rawToken !== 'string') return false;
  const presentedHash = hashRefreshToken(rawToken);
  if (!pgPool) {
    let found = false;
    for (const s of memorySessions.values()) {
      if (s.tokenHash === presentedHash || s.prevTokenHash === presentedHash) {
        if (!s.revokedAt) s.revokedAt = nowMs;
        found = true;
      }
    }
    return found;
  }
  const res = await pgPool.query(
    'UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1 OR prev_token_hash = $1',
    [presentedHash, new Date(nowMs)]
  );
  return res.rowCount > 0;
}

async function revokeUserSessions(userId) {
  const nowMs = Date.now();
  for (const s of memorySessions.values()) {
    if (s.userId === userId && !s.revokedAt) s.revokedAt = nowMs;
  }
  if (!pgPool) {
    const db = ensureDbLoaded();
    const user = db.users.find(u => u.id === userId);
    if (user) { user.tokenVersion = Number(user.tokenVersion || 1) + 1; await saveDb(db); }
    return;
  }
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT version FROM hoantienshop_state WHERE id='main' FOR UPDATE");
    await client.query('UPDATE users SET token_version=COALESCE(token_version,1)+1 WHERE id=$1', [userId]);
    await client.query('UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, NOW()) WHERE user_id=$1', [userId]);
    await client.query("UPDATE hoantienshop_state SET version=version+1, updated_at=NOW() WHERE id='main'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  await reloadStateFromPostgres({ strict: true });
}

const memoryResetTokens = new Map();
const MAX_RESET_OTP_ATTEMPTS = 5;

function hashResetOtp(userId, rawOtp) {
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(`pwd_reset:${userId}:${String(rawOtp || '').trim()}`)
    .digest('hex');
}

async function createPasswordResetOtp(user, { ttlSec = 600, nowMs = Date.now() } = {}) {
  const otpCode = String(crypto.randomInt(100000, 1000000));
  const id = `prt_${crypto.randomUUID()}`;
  const otpHash = hashResetOtp(user.id, otpCode);
  const expiresAt = nowMs + ttlSec * 1000;
  const email = String(user.email || '').trim().toLowerCase();

  if (!pgPool) {
    for (const tok of memoryResetTokens.values()) {
      if (tok.userId === user.id && !tok.usedAt) tok.usedAt = nowMs;
    }
    memoryResetTokens.set(id, {
      id,
      userId: user.id,
      email,
      otpHash,
      attempts: 0,
      expiresAt,
      usedAt: null,
      createdAt: nowMs
    });
    return { id, otpCode, expiresAt, ttlMinutes: Math.round(ttlSec / 60) };
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE password_reset_tokens SET used_at = COALESCE(used_at, $2) WHERE user_id = $1 AND used_at IS NULL', [
      user.id,
      new Date(nowMs)
    ]);
    await client.query(
      `INSERT INTO password_reset_tokens (id, user_id, email, otp_hash, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6)`,
      [id, user.id, email, otpHash, new Date(expiresAt), new Date(nowMs)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { id, otpCode, expiresAt, ttlMinutes: Math.round(ttlSec / 60) };
}

async function verifyAndConsumePasswordResetOtp(userId, rawOtp, { nowMs = Date.now() } = {}) {
  const cleanOtp = String(rawOtp || '').trim();
  if (!/^\d{6}$/.test(cleanOtp)) return { ok: false, reason: 'INVALID_FORMAT' };
  const candidateHash = hashResetOtp(userId, cleanOtp);

  if (!pgPool) {
    let latest = null;
    for (const tok of memoryResetTokens.values()) {
      if (tok.userId === userId && !tok.usedAt) {
        if (!latest || tok.createdAt > latest.createdAt) latest = tok;
      }
    }
    if (!latest) return { ok: false, reason: 'NOT_FOUND' };
    if (nowMs > latest.expiresAt) {
      latest.usedAt = nowMs;
      return { ok: false, reason: 'EXPIRED' };
    }
    if (latest.attempts >= MAX_RESET_OTP_ATTEMPTS) {
      latest.usedAt = nowMs;
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    }
    const a = Buffer.from(candidateHash, 'hex');
    const b = Buffer.from(latest.otpHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      latest.attempts += 1;
      if (latest.attempts >= MAX_RESET_OTP_ATTEMPTS) latest.usedAt = nowMs;
      return { ok: false, reason: latest.attempts >= MAX_RESET_OTP_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'MISMATCH' };
    }
    latest.usedAt = nowMs;
    return { ok: true };
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      'SELECT * FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [userId]
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (nowMs > new Date(row.expires_at).getTime()) {
      await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [row.id, new Date(nowMs)]);
      await client.query('COMMIT');
      return { ok: false, reason: 'EXPIRED' };
    }
    if (Number(row.attempts || 0) >= MAX_RESET_OTP_ATTEMPTS) {
      await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [row.id, new Date(nowMs)]);
      await client.query('COMMIT');
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    }
    const a = Buffer.from(candidateHash, 'hex');
    const b = Buffer.from(String(row.otp_hash || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const nextAttempts = Number(row.attempts || 0) + 1;
      await client.query(
        'UPDATE password_reset_tokens SET attempts = $2, used_at = CASE WHEN $2 >= $3 THEN $4 ELSE used_at END WHERE id = $1',
        [row.id, nextAttempts, MAX_RESET_OTP_ATTEMPTS, new Date(nowMs)]
      );
      await client.query('COMMIT');
      return { ok: false, reason: nextAttempts >= MAX_RESET_OTP_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'MISMATCH' };
    }
    await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [row.id, new Date(nowMs)]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  if (!Number.isFinite(rawAmt) || rawAmt === 0) {
    logger.warning('appendLedgerEntry', 'Bỏ qua ghi sổ cái do số tiền không hợp lệ hoặc bằng 0', {
      userId,
      type,
      amount,
      refId
    });
    return null;
  }

  const db = ensureDbLoaded();
  const cleanRefId = String(refId).trim();

  // Idempotency check: never insert duplicate refId
  const exists = db.ledger.find((e) => e.refId === cleanRefId);
  if (exists) {
    if (exists.userId !== userId || Number(exists.amount) !== Math.round(rawAmt) || exists.type !== type) {
      const error = new Error('Ledger reference reused with a different financial operation');
      error.code = 'LEDGER_REFERENCE_CONFLICT'; error.status = 409; throw error;
    }
    return exists;
  }

  const roundedAmt = Math.round(rawAmt);
  if (!Number.isFinite(roundedAmt) || roundedAmt === 0) return null;

  const entry = {
    id: forcedId || `led_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    userId,
    type,
    amount: roundedAmt,
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

  migrateLegacyOrderIdentity(db);
  const userCodeUpper = String(user.code || '').toUpperCase();
  const userOrders = db.orders.filter(
    (o) =>
      o.userId === user.id ||
      (!o.userId && o.userCode && String(o.userCode).toUpperCase() === userCodeUpper)
  );

  // 1. Build Map Index for O(1) lookups
  const userLedger = db.ledger.filter((e) => e.userId === user.id);
  const ledgerByOrderSn = new Map();
  const ledgerByRefId = new Map();

  for (const entry of userLedger) {
    if (entry.refId) {
      ledgerByRefId.set(entry.refId, entry);

      const sn = ledgerOrderKey(entry, db);

      if (sn) {
        if (!ledgerByOrderSn.has(sn)) ledgerByOrderSn.set(sn, []);
        ledgerByOrderSn.get(sn).push(entry);
      }
    }
  }

  let pending = 0;

  // 2. Delta Reconciler: calculate exact difference between expected and current ledger
  const activeOrderSns = new Set();
  for (const ord of userOrders) {
    const cleanSn = String(ord.orderSn || '').trim();
    if (!cleanSn) continue;
    const key = orderKey(ord);
    activeOrderSns.add(key);

    const cashbackAmt = Math.round(Number(ord.userCashbackAmount || 0));
    const expectedApprovedAmt = (ord.status === 'approved' && cashbackAmt > 0) ? cashbackAmt : 0;

    if (ord.status === 'pending') {
      pending += cashbackAmt;
    }

    const existingEntries = ledgerByOrderSn.get(key) || [];
    const currentSum = existingEntries.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const delta = expectedApprovedAmt - currentSum;

    if (delta !== 0) {
      const seq = existingEntries.length + 1;
      const refId = orderLedgerRef(key, user.id, seq);

      const type = delta > 0 ? 'order_cashback' : 'order_revocation';
      const note = delta > 0
        ? `Hoàn tiền đơn hàng #${cleanSn} (+${delta.toLocaleString('vi-VN')} đ)`
        : `Điều chỉnh hoàn tiền đơn #${cleanSn} (${delta.toLocaleString('vi-VN')} đ)`;

      const newEntry = appendLedgerEntry(user.id, type, delta, refId, note);
      if (newEntry) {
        existingEntries.push(newEntry);
        userLedger.push(newEntry);
        ledgerByRefId.set(refId, newEntry);
        if (!ledgerByOrderSn.has(key)) ledgerByOrderSn.set(key, existingEntries);
      }
    }
  }

  // 2.5 Orphan Order Revocation: if an approved order was deleted, revoke remaining net credit in ledger
  for (const [orphanSn, entries] of ledgerByOrderSn.entries()) {
    if (activeOrderSns.has(orphanSn)) continue;
    const netCredited = Math.round(
      entries.reduce((sum, e) => sum + (Number.isFinite(Number(e.amount)) ? Number(e.amount) : 0), 0)
    );
    if (netCredited > 0) {
      const revokeRefId = orderLedgerRef(orphanSn, user.id, entries.length + 1);
      const revEntry = appendLedgerEntry(
        user.id,
        'order_revocation',
        -netCredited,
        revokeRefId,
        `Thu hồi hoàn tiền từ đơn hàng đã xóa #${orphanSn} (-${netCredited.toLocaleString('vi-VN')} đ)`
      );
      if (revEntry) {
        entries.push(revEntry);
        userLedger.push(revEntry);
        ledgerByRefId.set(revokeRefId, revEntry);
      }
    }
  }

  // 3. Reconcile withdrawals
  const userWithdrawals = db.withdrawals.filter((w) => w.userId === user.id);
  for (const w of userWithdrawals) {
    const debitRef = `withdraw_debit_${w.id}`;
    const refundRef = `withdraw_refund_${w.id}`;
    const hadDebit = ledgerByRefId.get(debitRef);
    const hadRefund = ledgerByRefId.get(refundRef);

    const rawAmt = Number(w.amount);
    const validAmount = Number.isFinite(rawAmt) && rawAmt > 0 ? Math.round(rawAmt) : null;

    if (w.status === 'pending' || w.status === 'paid') {
      if (!validAmount) {
        logger.warning('recalculateUserWallet', 'Bỏ qua lệnh rút tiền có số tiền không hợp lệ', {
          wdId: w.id,
          amount: w.amount
        });
        continue;
      }
      if (!hadDebit) {
        const entry = appendLedgerEntry(
          user.id,
          'withdrawal_lock',
          -Math.abs(validAmount),
          debitRef,
          `Rút tiền #${w.id} (${w.bankName || 'Ngân hàng'})`
        );
        if (entry) {
          userLedger.push(entry);
          ledgerByRefId.set(debitRef, entry);
        }
      }
    } else if (w.status === 'rejected') {
      // Idempotent refund: only credit if previously debited AND not yet refunded
      if (hadDebit && !hadRefund) {
        const refundAmt = Math.abs(Number(hadDebit.amount)) || (validAmount ? Math.abs(validAmount) : 0);
        if (Number.isFinite(refundAmt) && refundAmt > 0) {
          const entry = appendLedgerEntry(
            user.id,
            'withdrawal_refund',
            refundAmt,
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
  }

  // 3.5. Reconcile referral bounties (10.000đ when an invited friend completes their 1st approved order)
  const bountyAmount = Math.max(0, Math.round(Number(db.settings.referralBountyAmount ?? 10000)));
  if (bountyAmount > 0 && user.code) {
    const refereeUsers = db.users.filter(
      (u) => u.referredBy && String(u.referredBy).toUpperCase() === userCodeUpper && u.id !== user.id
    );

    for (const referee of refereeUsers) {
      const refereeOrders = db.orders.filter(
        (o) =>
          (o.userId === referee.id ||
            (!o.userId && o.userCode && String(o.userCode).toUpperCase() === String(referee.code).toUpperCase())) &&
          o.status === 'approved'
      );
      const hasApprovedOrder = refereeOrders.length > 0;
      const bountyRefId = `ref_bounty_${referee.id}`;
      const revokeRefId = `ref_bounty_revoke_${referee.id}`;

      const bountyEntries = userLedger.filter(
        (e) =>
          e.refId === bountyRefId ||
          e.refId === revokeRefId ||
          (e.refId && e.refId.startsWith(`ref_bounty_adj_${referee.id}_`))
      );
      const currentBountySum = Math.round(
        bountyEntries.reduce((sum, e) => sum + (Number.isFinite(Number(e.amount)) ? Number(e.amount) : 0), 0)
      );
      const expectedBountyAmt = hasApprovedOrder ? bountyAmount : 0;
      const bountyDelta = expectedBountyAmt - currentBountySum;

      if (bountyDelta !== 0) {
        let nextRefId;
        if (bountyEntries.length === 0 && bountyDelta > 0 && !ledgerByRefId.has(bountyRefId)) {
          nextRefId = bountyRefId;
        } else if (bountyEntries.length === 1 && bountyDelta < 0 && !ledgerByRefId.has(revokeRefId)) {
          nextRefId = revokeRefId;
        } else {
          nextRefId = `ref_bounty_adj_${referee.id}_${bountyEntries.length + 1}`;
        }

        const refereeDisplay = referee.phone
          ? `${referee.phone.slice(0, 3)}***${referee.phone.slice(-3)}`
          : referee.code;
        const entryType = bountyDelta > 0 ? 'referral_bonus' : 'order_revocation';
        const entryNote =
          bountyDelta > 0
            ? `Thưởng giới thiệu bạn bè (${refereeDisplay} hoàn tất đơn đầu tiên) (+${bountyDelta.toLocaleString('vi-VN')} đ)`
            : `Thu hồi thưởng giới thiệu (Đơn hàng bạn bè bị hủy/đổi trả) (${bountyDelta.toLocaleString('vi-VN')} đ)`;

        const entry = appendLedgerEntry(user.id, entryType, bountyDelta, nextRefId, entryNote);
        if (entry) {
          userLedger.push(entry);
          ledgerByRefId.set(nextRefId, entry);
        }
      }
    }
  }

  // 4. Compute balance strictly from append-only ledger SUM & net earned
  let ledgerSum = 0;
  let earnedNetSum = 0;

  for (const entry of userLedger) {
    const entryAmt = Number(entry.amount);
    if (!Number.isFinite(entryAmt)) continue;
    ledgerSum += entryAmt;
    if (
      entry.type === 'order_cashback' ||
      entry.type === 'referral_bonus' ||
      entry.type === 'order_revocation' ||
      entry.type === 'order_cancellation' ||
      entry.type === 'order_clawback'
    ) {
      earnedNetSum += entryAmt;
    }
  }

  const paidWithdrawn = userWithdrawals
    .filter((w) => w.status === 'paid')
    .reduce((acc, w) => {
      const a = Math.round(Number(w.amount));
      return acc + (Number.isFinite(a) && a > 0 ? a : 0);
    }, 0);

  user.balancePending = Math.max(0, Math.round(Number.isFinite(pending) ? pending : 0));
  user.totalEarned = Math.max(0, Math.round(Number.isFinite(earnedNetSum) ? earnedNetSum : 0));
  user.totalWithdrawn = Math.max(0, Math.round(Number.isFinite(paidWithdrawn) ? paidWithdrawn : 0));
  user.balanceAvailable = Math.round(Number.isFinite(ledgerSum) ? ledgerSum : 0);
  user.hasNegativeBalance = user.balanceAvailable < 0;

  // 5. Recompute VIP Tier from approved order spend (handles clawbacks automatically)
  const approvedSpend = Math.max(
    0,
    Math.round(
      userOrders
        .filter((o) => o.status === 'approved')
        .reduce((sum, o) => sum + (Number.isFinite(Number(o.orderAmount)) ? Number(o.orderAmount) : 0), 0)
    )
  );
  const tiers = getNormalizedVipTiers(db.settings);
  const prevTierCode = String(user.vipTier || tiers[0].code).toLowerCase();
  const prevTierIdx = Math.max(0, tiers.findIndex((t) => t.code === prevTierCode));
  const nextTier = resolveVipTier(approvedSpend, db.settings);
  const nextTierIdx = Math.max(0, tiers.findIndex((t) => t.code === nextTier.code));

  user.totalApprovedSpend = approvedSpend;
  user.vipTier = nextTier.code;

  if (
    db.settings?.vipTiersEnabled !== false &&
    nextTierIdx > prevTierIdx &&
    tierUpgradeListener
  ) {
    try {
      tierUpgradeListener(user, nextTier);
    } catch (err) {
      logger.warning('recalculateUserWallet', 'Tier upgrade listener error', { error: err.message });
    }
  }

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
  minWithdraw,
  idempotencyKey
}) {
  return withUserLock(userId, async () => {
    logger.logEnter('executeAtomicWithdrawal', { userId, amount, idempotencyKey });
    const db = ensureDbLoaded();
    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      throw new Error('Không tìm thấy tài khoản người dùng.');
    }
    if (user.accountLocked) {
      throw new Error('Tài khoản đang bị tạm khóa đối soát. Vui lòng liên hệ hỗ trợ.');
    }

    const cleanIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : null;
    if (cleanIdempotencyKey && cleanIdempotencyKey.length > 200) throw new Error('Idempotency key quá dài.');
    if (cleanIdempotencyKey && !pgPool) {
      const existing = db.withdrawals.find(
        (w) =>
          w.userId === user.id &&
          w.idempotencyKey === cleanIdempotencyKey
      );
      if (existing) {
        if (existing.amount !== Math.round(Number(amount)) || existing.bankAccount !== String(bankAccount || '').replace(/\s+/g, '') || existing.bankName !== String(bankName || '').trim() || existing.bankOwner !== String(bankOwner || '').trim().toUpperCase()) {
          throw new Error('Idempotency key đã được sử dụng cho yêu cầu khác.');
        }
        logger.logLeave('executeAtomicWithdrawal', {
          wdId: existing.id,
          amount: existing.amount,
          idempotentReplay: true
        });
        return { withdrawal: existing, user: sanitizeUser(user), idempotent: true };
      }
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

    const numAmount = Math.round(Number(amount));
    if (!Number.isSafeInteger(numAmount) || numAmount <= 0) {
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

    if (!pgPool && strictLedgerSum < 0) {
      throw new Error(
        `Tài khoản đang có số dư âm (${strictLedgerSum.toLocaleString('vi-VN')}đ) do đơn hàng hoàn trả sau khi rút. Hệ thống sẽ tự động cấn trừ vào đơn tiếp theo.`
      );
    }
    if (!pgPool && numAmount > strictLedgerSum) {
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
        // All direct financial writes participate in snapshot concurrency control.
        await client.query("UPDATE hoantienshop_state SET version = version + 1 WHERE id = 'main'");

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

        if (cleanIdempotencyKey) {
          const replay = await client.query('SELECT * FROM withdrawals WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1', [user.id, cleanIdempotencyKey]);
          if (replay.rows.length) {
            const row = replay.rows[0];
            if (Number(row.amount) !== numAmount || row.bank_account !== cleanBankAccount || row.bank_name !== cleanBankName || row.bank_owner !== cleanBankOwner) {
              throw new Error('Idempotency key đã được sử dụng cho yêu cầu khác.');
            }
            await client.query('ROLLBACK');
            return { withdrawal: { id: row.id, userId: row.user_id, amount: Number(row.amount), status: row.status, bankName: row.bank_name, bankAccount: row.bank_account, bankOwner: row.bank_owner, idempotencyKey: row.idempotency_key, createdAt: row.created_at }, user: sanitizeUser(user), idempotent: true };
          }
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
          `INSERT INTO withdrawals (id, user_id, user_code, user_name, user_phone, amount, method, bank_name, bank_account, bank_owner, status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)`,
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
            cleanBankOwner,
            cleanIdempotencyKey
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
      idempotencyKey: cleanIdempotencyKey,
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
    if (pgPool) {
      await reloadStateFromPostgres();
    } else {
      await saveDb(db);
    }

    logger.logLeave('executeAtomicWithdrawal', {
      wdId,
      amount: numAmount,
      remainingBalance: user.balanceAvailable
    });
    return { withdrawal, user: sanitizeUser(user) };
  });
}

/**
 * Idempotently refund a withdrawal, restoring user's balance exactly once.
 * Rejects invalid/NaN amounts and paid withdrawals.
 */
async function archiveWithdrawal(id, adminUser = {}) {
  if (pgPool) {
    if (!pgSchemaReady) throw new Error('Postgres schema is not ready');
    const result = await require('../repositories/withdrawalRepository').settleWithdrawal(pgPool, id, 'rejected', adminUser, { archive: true });
    await reloadStateFromPostgres();
    return result;
  }
  const db = ensureDbLoaded();
  const wd = db.withdrawals.find(w => w.id === id);
  if (!wd) { const error = new Error('Không tìm thấy lệnh rút.'); error.status = 404; throw error; }
  return withUserLock(wd.userId, async () => {
    if (wd.status === 'paid') { const error = new Error('Không thể lưu trữ lệnh đã chi trả.'); error.status = 409; throw error; }
    if (wd.archivedAt) return wd;
    wd.status = 'rejected';
    wd.processedAt = wd.processedAt || new Date().toISOString();
    wd.archivedAt = new Date().toISOString();
    recalculateUserWallet(wd.userId, { persist: false });
    recordAuditLog(db, { adminId: adminUser.id, adminName: adminUser.name, action: 'archive_withdrawal', targetId: id, details: { status: wd.status, amount: wd.amount } });
    await saveDb(db);
    return wd;
  });
}

async function settleWithdrawal(id, status, adminUser = {}) {
  if (pgPool) {
    if (!pgSchemaReady) throw new Error('Postgres schema is not ready');
    const result = await require('../repositories/withdrawalRepository').settleWithdrawal(pgPool, id, status, adminUser);
    await reloadStateFromPostgres();
    return result;
  }
  const db = ensureDbLoaded();
  const wd = db.withdrawals.find(w => w.id === id);
  if (!wd || !['paid', 'rejected'].includes(status)) {
    const error = new Error('Lệnh rút tiền hoặc trạng thái không hợp lệ.');
    error.status = wd ? 400 : 404;
    throw error;
  }
  if (status === 'rejected') return refundWithdrawal(db, wd, adminUser);
  return withUserLock(wd.userId, async () => {
    if (wd.status === 'paid') return wd;
    if (wd.status !== 'pending') {
      const error = new Error('Lệnh rút tiền đã xử lý, không thể đổi trạng thái.');
      error.status = 409;
      throw error;
    }
    wd.status = 'paid';
    wd.processedAt = new Date().toISOString();
    recalculateUserWallet(wd.userId, { persist: false });
    recordAuditLog(db, { adminId: adminUser.id, adminName: adminUser.name, action: 'update_withdrawal', targetId: id, details: { status, amount: wd.amount } });
    await saveDb(db);
    return wd;
  });
}

async function refundWithdrawal(db, wd, adminUser = {}) {
  if (pgPool && wd?.id) {
    const result = await settleWithdrawal(wd.id, 'rejected', adminUser);
    Object.assign(wd, result);
    return wd;
  }
  logger.logEnter('refundWithdrawal', { wdId: wd?.id, userId: wd?.userId, amount: wd?.amount });
  if (!wd || typeof wd !== 'object') {
    const err = new Error('Invalid withdrawal object');
    err.status = 400;
    throw err;
  }

  const numAmount = Math.round(Number(wd.amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    const err = new Error('Invalid withdrawal amount');
    err.status = 400;
    throw err;
  }

  if (wd.status === 'paid') {
    const err = new Error('Không thể hoàn tiền lệnh rút đã chi trả thành công.');
    err.status = 400;
    throw err;
  }

  if (!wd.userId) {
    const err = new Error('Thiếu userId trong lệnh rút tiền.');
    err.status = 400;
    throw err;
  }

  const database = db || ensureDbLoaded();

  return withUserLock(wd.userId, async () => {
    if (wd.status === 'paid') {
      const err = new Error('Không thể hoàn tiền lệnh rút đã chi trả thành công.');
      err.status = 400;
      throw err;
    }

    // Idempotency: if already rejected, ensure recalculateUserWallet does not duplicate and return wd
    if (wd.status === 'rejected') {
      logger.warning('refundWithdrawal', 'Lệnh rút tiền đã bị từ chối trước đó, bảo đảm không hoàn tiền trùng lặp', {
        wdId: wd.id,
        userId: wd.userId
      });
      recalculateUserWallet(wd.userId, { persist: false });
      await saveDb(database);
      logger.logLeave('refundWithdrawal', { wdId: wd.id, status: 'rejected', idempotent: true });
      return wd;
    }

    wd.status = 'rejected';
    wd.processedAt = new Date().toISOString();
    wd.processedByAdminId = adminUser?.id || null;
    wd.processedByAdmin = adminUser?.username || 'admin';

    // recalculateUserWallet detects wd.status === 'rejected' and creates a single withdrawal_refund entry
    recalculateUserWallet(wd.userId, { persist: false });
    recordAuditLog(database, { adminId: adminUser.id, adminName: adminUser.name, action: 'update_withdrawal', targetId: wd.id, details: { status: 'rejected', amount: wd.amount } });
    await saveDb(database);

    logger.logLeave('refundWithdrawal', { wdId: wd.id, status: 'rejected' });
    return wd;
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
      .reduce((acc, e) => {
        const a = Number(e.amount);
        return acc + (Number.isFinite(a) ? a : 0);
      }, 0);

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

/**
 * Targeted O(K) wallet recalculation for only the users (and their 1-level referrers)
 * affected by an order sync, webhook postback, CSV import, or admin order edit/delete.
 */
function recalculateAffectedWallets(identifiers = [], { persist = false } = {}) {
  logger.logEnter('recalculateAffectedWallets');
  const db = ensureDbLoaded();
  const rawList = Array.isArray(identifiers) ? identifiers : [...identifiers];
  const idSet = new Set();
  const codeSet = new Set();

  for (const item of rawList) {
    if (!item || typeof item !== 'string') continue;
    const trimmed = item.trim();
    const upper = trimmed.toUpperCase();
    if (!trimmed || upper === 'GUEST' || upper === 'PENDING_VERIFY') continue;
    idSet.add(trimmed);
    codeSet.add(upper);
  }

  const targetUserIds = new Set();
  const referrerCodes = new Set();

  for (const u of db.users) {
    if (!u?.id) continue;
    if (idSet.has(u.id) || (u.code && codeSet.has(String(u.code).toUpperCase()))) {
      targetUserIds.add(u.id);
      if (u.referredBy) {
        referrerCodes.add(String(u.referredBy).trim().toUpperCase());
      }
    }
  }

  if (referrerCodes.size > 0) {
    for (const u of db.users) {
      if (u?.id && u.code && referrerCodes.has(String(u.code).toUpperCase())) {
        targetUserIds.add(u.id);
      }
    }
  }

  for (const uid of targetUserIds) {
    recalculateUserWallet(uid, { persist: false });
  }

  if (persist) {
    saveDb(db).catch((err) => {
      logger.warning('recalculateAffectedWallets', 'Lỗi lưu dữ liệu ví mục tiêu', { error: err.message });
    });
  }

  logger.logLeave('recalculateAffectedWallets', { count: targetUserIds.size });
  return { recalculatedCount: targetUserIds.size, userIds: [...targetUserIds] };
}

function getCurrentDbVersion() {
  return stateContext.getStore()?.version ?? currentDbVersion;
}

function getDatabaseStatus() {
  const audit = auditLedgerIntegrity({ autoRepair: false });
  return {
    mode: pgPool ? 'postgres' : IS_VERCEL ? 'ephemeral_tmp' : 'local_json',
    isPersistentOnCloud: Boolean(pgPool && pgSchemaReady),
    version: currentDbVersion,
    ledgerAudit: audit
  };
}

function normalizePhoneNumber(phone) {
  if (!phone) return '';
  let str = String(phone).replace(/[\s\-_.\(\)]/g, '').trim();
  if (str.startsWith('+84')) {
    str = '0' + str.slice(3);
  } else if (str.startsWith('84') && str.length >= 10 && !str.startsWith('840')) {
    str = '0' + str.slice(2);
  }
  return str;
}

function recordAuditLog(db, { adminId, adminName, action, targetId, details } = {}) {
  logger.logEnter('recordAuditLog', { action, targetId });
  if (!db) return null;
  if (!Array.isArray(db.auditLogs)) {
    db.auditLogs = [];
  }
  const entry = {
    id: `audit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    adminId: String(adminId || 'admin'),
    adminName: String(adminName || 'Quản Trị Viên'),
    action: String(action || 'unknown'),
    targetId: targetId ? String(targetId) : null,
    details: details || {},
    timestamp: new Date().toISOString()
  };
  db.auditLogs.unshift(entry);
  logger.logLeave('recordAuditLog', { id: entry.id, action: entry.action });
  return entry;
}

function isTestUserRecord(u) {
  if (!u || typeof u !== 'object') return false;
  if (u.id === 'usr_admin') return false;
  const id = String(u.id || '');
  const code = String(u.code || '');
  const name = String(u.name || '').trim();
  const email = String(u.email || '').trim().toLowerCase();
  const phone = String(u.phone || '').trim();

  if (
    /^(usr_test_|usr_fin_test_|usr_claim_test_|usr_u_test_|usr_adm_test_|usr_active_|usr_p23_|usr_sync_|usr_concurrency_test_|usr_crit05_|admin_test_)/i.test(
      id
    ) ||
    id.includes('_test_')
  ) {
    return true;
  }
  if (/^(U108899|U_TEST|ADM_TEST|ADMIN_P03)$/i.test(code) || /^(USR|ADM)_\d{10,}$/i.test(code)) {
    return true;
  }
  if (u.role === 'admin') return false;
  if (email && (/@example\.com$/i.test(email) || /@test\.com$/i.test(email))) {
    return true;
  }
  if (
    /^(Referee User Test|Referrer User Test|Self Referral Test|Test P03 User|Test Withdrawal User|User Test|Admin Test|Nguyen Van (User|Admin|Test|Wallet))$/i.test(
      name
    ) ||
    /^Test[\s_]/i.test(name)
  ) {
    return true;
  }
  if (/^DELETED_\d+_/.test(phone) && /test/i.test(`${name}_${id}`)) {
    return true;
  }
  return false;
}

function isTestOrderRecord(o, testUserIds) {
  if (!o || typeof o !== 'object') return false;
  const sn = String(o.orderSn || '').trim().toUpperCase();
  const id = String(o.id || '');
  if (testUserIds && o.userId && testUserIds.has(o.userId)) return true;
  if (
    /^(ORD_LOCK_|SN_APPROVED_|SN_CONCURR_|ORD_HMAC_|ORD_VALID_TS_|ORD_AT_REALTIME_|SN_REF_TEST_|P23SN_|SN_TEST5_|SN_LEAK_TEST|SN_INVALID_|ORD_GQL_|ORD_MULTI_|ORD_EMPTY_|ORD_MALFORMED_|TEST_)/i.test(
      sn
    ) ||
    sn === '261111ABC8899'
  ) {
    return true;
  }
  if (/^(ord_test_|ord_p23_|ord_crit05_|ord_leak_test)/i.test(id)) {
    return true;
  }
  return false;
}

/** Heuristics are hints for review only, never authorization to delete financial data. */
function inspectTestArtifacts(db = ensureDbLoaded()) {
  const users = db.users.filter(isTestUserRecord);
  const userIds = new Set(users.map(u => u.id));
  const orders = db.orders.filter(o => isTestOrderRecord(o, userIds));
  const withdrawals = db.withdrawals.filter(w => userIds.has(w.userId) || /test/i.test(`${w.id || ''} ${w.userName || ''}`));
  return {
    previewOnly: true,
    candidates: {
      userIds: users.map(u => u.id),
      orderSns: orders.map(o => o.orderSn),
      withdrawalIds: withdrawals.map(w => w.id)
    },
    counts: { users: users.length, orders: orders.length, withdrawals: withdrawals.length }
  };
}

module.exports = {
  revokeUserSessions,
  runWithStateContext,
  ensureDbLoaded,
  saveDb,
  initPostgresIfConfigured,
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  calculateCommissionSplit,
  appendLedgerEntry,
  recalculateUserWallet,
  recalculateAllWallets,
  recalculateAffectedWallets,
  executeAtomicWithdrawal,
  archiveWithdrawal,
  refundWithdrawal,
  settleWithdrawal,
  auditLedgerIntegrity,
  createToken,
  verifyToken,
  getSessionPolicy,
  createRefreshSession,
  rotateRefreshSession,
  revokeSessionByRefreshToken,
  createPasswordResetOtp,
  verifyAndConsumePasswordResetOtp,
  sanitizeUser,
  getDatabaseStatus,
  reloadStateFromPostgres,
  getDefaultPostbackToken,
  withUserLock,
  getCurrentDbVersion,
  persistOrderToPostgres,
  persistUserToPostgres,
  persistLedgerToPostgres,
  persistWithdrawalToPostgres,
  inspectTestArtifacts,
  recordAuditLog,
  normalizePhoneNumber,
  getPgPool,
  appendClickRecords,
  findClickById,
  resolveUserCashbackRate,
  DEFAULT_VIP_TIERS,
  getNormalizedVipTiers,
  resolveVipTier,
  setTierUpgradeListener
};
