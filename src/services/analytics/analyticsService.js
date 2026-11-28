/**
 * LiLa First-Party Traffic & User Analytics Service (P0).
 *
 * Priorities:
 * - Track per-member product clicks (which product, exact timestamp, surface, traffic source, linked order status)
 * - Track website traffic (Visitors, Page Views, Unique Visitors, Sessions, VN WebView sources: Zalo/FB/TikTok/Google/UTM/Share)
 * - Anti-spam / bot filtering (Raw vs Valid vs Unique vs Affiliate Clicks; raw rows preserved)
 * - Safe Guest -> Member stitching (current session_id only, never merges historical shared-device sessions)
 * - 90-day raw retention policy; zero secrets/passwords/raw IPs stored
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { getPgPool, ensureDbLoaded } = require('../dbService');

const ANALYTICS_RETENTION_DAYS = 90;
const BOT_UA_REGEX = /bot|crawler|spider|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|postman/i;
const DUPLICATE_CLICK_WINDOW_MS = 30 * 1000;
const RATE_BURST_PER_MIN = 60;
const ADMIN_CACHE_TTL_MS = 30 * 1000;

// In-memory fallback stores (used in test mode or when Postgres is not configured)
const memSessions = new Map();
const memEvents = new Map();
const memDailyRollups = new Map();
const recentClickDedup = new Map();
const sessionBurstCounter = new Map();
const adminReadCache = new Map();

function clearAnalyticsCache() {
  adminReadCache.clear();
}

async function withAdminCache(cacheKey, fetcher, ttlMs = ADMIN_CACHE_TTL_MS) {
  const effectiveTtl = process.env.NODE_ENV === 'test' && ttlMs === ADMIN_CACHE_TTL_MS ? 0 : ttlMs;
  if (effectiveTtl > 0) {
    const cached = adminReadCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
  }
  const value = await fetcher();
  if (effectiveTtl > 0) {
    if (adminReadCache.size > 100) {
      const oldest = adminReadCache.keys().next().value;
      if (oldest) adminReadCache.delete(oldest);
    }
    adminReadCache.set(cacheKey, { value, expiresAt: Date.now() + effectiveTtl });
  }
  return value;
}

let pgAnalyticsSchemaReady = false;

async function ensureAnalyticsSchema(pool) {
  if (pgAnalyticsSchemaReady || !pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        session_id TEXT PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
        traffic_source TEXT NOT NULL DEFAULT 'direct',
        referrer_host TEXT,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        ref_code TEXT,
        landing_view TEXT,
        last_view TEXT,
        device_type TEXT DEFAULT 'mobile',
        browser TEXT,
        os TEXT,
        is_pwa BOOLEAN DEFAULT FALSE,
        ip_hash TEXT,
        is_bot BOOLEAN DEFAULT FALSE,
        page_views INT DEFAULT 0,
        click_count INT DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE analytics_sessions ADD COLUMN IF NOT EXISTS last_view TEXT;
      CREATE INDEX IF NOT EXISTS idx_as_last_seen ON analytics_sessions (last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_as_user_started ON analytics_sessions (user_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_as_source_started ON analytics_sessions (traffic_source, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_as_visitor ON analytics_sessions (visitor_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        user_id TEXT NULL,
        event_type TEXT NOT NULL,
        view_name TEXT,
        platform TEXT,
        product_id TEXT,
        product_name TEXT,
        product_category TEXT,
        source_surface TEXT,
        deal_group TEXT,
        click_id TEXT,
        is_valid BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ae_user_created ON analytics_events (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_type_created ON analytics_events (event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_created_type_valid ON analytics_events (created_at DESC, event_type, is_valid);
      CREATE INDEX IF NOT EXISTS idx_ae_product ON analytics_events (product_id, platform, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_click_id ON analytics_events (click_id);
      CREATE INDEX IF NOT EXISTS idx_ae_session ON analytics_events (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
        day_vn DATE NOT NULL,
        dimension_type TEXT NOT NULL,
        dimension_key TEXT NOT NULL,
        visitors INT NOT NULL DEFAULT 0,
        unique_users INT NOT NULL DEFAULT 0,
        sessions INT NOT NULL DEFAULT 0,
        page_views INT NOT NULL DEFAULT 0,
        raw_clicks INT NOT NULL DEFAULT 0,
        valid_clicks INT NOT NULL DEFAULT 0,
        affiliate_clicks INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day_vn, dimension_type, dimension_key)
      );
      CREATE INDEX IF NOT EXISTS idx_adr_day_type ON analytics_daily_rollups (day_vn DESC, dimension_type);
    `);
    pgAnalyticsSchemaReady = true;
  } catch (err) {
    logger.warning('ensureAnalyticsSchema', 'Failed to ensure analytics tables', { error: err?.message });
  }
}

function hashDailyIp(ip) {
  if (!ip) return '';
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.JWT_SECRET || process.env.AUTH_SECRET || 'lila_analytics_salt_v1';
  return crypto.createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex').slice(0, 24);
}

function parseUserAgentInfo(uaStr = '') {
  const ua = String(uaStr || '');
  const isBot = BOT_UA_REGEX.test(ua);

  let deviceType = 'desktop';
  if (/ipad|tablet|playbook|silk/i.test(ua)) deviceType = 'tablet';
  else if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) deviceType = 'mobile';

  let os = 'Other';
  if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Other';
  if (/Zalo/i.test(ua)) browser = 'Zalo WebView';
  else if (/FBAN|FBAV|FB_IAB/i.test(ua)) browser = 'Facebook WebView';
  else if (/BytedanceWebview|musical_ly|TikTok/i.test(ua)) browser = 'TikTok WebView';
  else if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';

  return { isBot, deviceType, os, browser };
}

/**
 * Classify Vietnamese traffic source accurately (handles in-app WebView stripped referrers).
 */
function classifyTrafficSource({ utmSource, refCode, referrerHost, userAgent }) {
  const utm = String(utmSource || '').trim().toLowerCase();
  const ref = String(refCode || '').trim();
  const host = String(referrerHost || '').trim().toLowerCase();
  const ua = String(userAgent || '');

  if (utm) {
    if (/zalo/.test(utm)) return 'zalo';
    if (/fb|facebook|meta/.test(utm)) return 'facebook';
    if (/tiktok|tt/.test(utm)) return 'tiktok';
    if (/google|gg/.test(utm)) return 'google';
    return 'utm';
  }
  if (ref) return 'share_link';

  if (host) {
    if (/google\./.test(host)) return 'google';
    if (/(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|messenger\.com)$/.test(host)) return 'facebook';
    if (/(?:^|\.)(?:tiktok\.com|vt\.tiktok\.com)$/.test(host)) return 'tiktok';
    if (/(?:^|\.)(?:zalo\.me|zalo\.vn|zaloapp\.com)$/.test(host)) return 'zalo';
    if (!/(?:hoantiensan\.online|hoantienshop\.vercel\.app|localhost|127\.0\.0\.1)/.test(host)) {
      return 'referral';
    }
  }

  // Fallback for Vietnamese in-app WebViews that strip Referer header
  if (/Zalo/i.test(ua)) return 'zalo';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  if (/BytedanceWebview|musical_ly|TikTok/i.test(ua)) return 'tiktok';

  return 'direct';
}

function cleanStr(val, maxLen = 120) {
  if (val == null) return null;
  const s = String(val).trim();
  return s ? s.slice(0, maxLen) : null;
}

function checkBurstSpam(sessionId) {
  const now = Date.now();
  const entry = sessionBurstCounter.get(sessionId);
  if (!entry || now - entry.windowStart > 60000) {
    sessionBurstCounter.set(sessionId, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_BURST_PER_MIN;
}

function isDuplicateRecentClick(sessionId, eventType, productId) {
  if (!productId || (eventType !== 'product_click' && eventType !== 'affiliate_click')) return false;
  const key = `${sessionId}|${eventType}|${productId}`;
  const now = Date.now();
  const prev = recentClickDedup.get(key);
  if (prev && now - prev < DUPLICATE_CLICK_WINDOW_MS) {
    return true;
  }
  if (recentClickDedup.size > 2000) {
    const oldest = recentClickDedup.keys().next().value;
    if (oldest) recentClickDedup.delete(oldest);
  }
  recentClickDedup.set(key, now);
  return false;
}

async function upsertSession(sessionData) {
  const pool = getPgPool();
  if (pool) {
    await ensureAnalyticsSchema(pool);
    await pool.query(
      `INSERT INTO analytics_sessions (
        session_id, visitor_id, user_id, traffic_source, referrer_host,
        utm_source, utm_medium, utm_campaign, ref_code, landing_view, last_view,
        device_type, browser, os, is_pwa, ip_hash, is_bot,
        page_views, click_count, started_at, last_seen_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, NOW(), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = COALESCE(analytics_sessions.user_id, EXCLUDED.user_id),
        traffic_source = CASE
          WHEN analytics_sessions.traffic_source = 'direct' AND EXCLUDED.traffic_source <> 'direct'
            THEN EXCLUDED.traffic_source
          ELSE analytics_sessions.traffic_source
        END,
        referrer_host = COALESCE(NULLIF(analytics_sessions.referrer_host, ''), EXCLUDED.referrer_host),
        utm_source = COALESCE(NULLIF(analytics_sessions.utm_source, ''), EXCLUDED.utm_source),
        utm_medium = COALESCE(NULLIF(analytics_sessions.utm_medium, ''), EXCLUDED.utm_medium),
        utm_campaign = COALESCE(NULLIF(analytics_sessions.utm_campaign, ''), EXCLUDED.utm_campaign),
        ref_code = COALESCE(NULLIF(analytics_sessions.ref_code, ''), EXCLUDED.ref_code),
        last_view = COALESCE(NULLIF(EXCLUDED.last_view, ''), analytics_sessions.last_view, analytics_sessions.landing_view),
        is_pwa = analytics_sessions.is_pwa OR EXCLUDED.is_pwa,
        page_views = analytics_sessions.page_views + EXCLUDED.page_views,
        click_count = analytics_sessions.click_count + EXCLUDED.click_count,
        last_seen_at = NOW()`,
      [
        sessionData.sessionId,
        sessionData.visitorId,
        sessionData.userId,
        sessionData.trafficSource,
        sessionData.referrerHost,
        sessionData.utmSource,
        sessionData.utmMedium,
        sessionData.utmCampaign,
        sessionData.refCode,
        sessionData.landingView,
        sessionData.lastView || sessionData.landingView || 'home',
        sessionData.deviceType,
        sessionData.browser,
        sessionData.os,
        Boolean(sessionData.isPwa),
        sessionData.ipHash,
        Boolean(sessionData.isBot),
        sessionData.pageViewsDelta || 0,
        sessionData.clicksDelta || 0
      ]
    );
    // Safe Guest -> Member stitching: link existing events of THIS session_id only
    if (sessionData.userId) {
      await pool.query(
        'UPDATE analytics_events SET user_id = $1 WHERE session_id = $2 AND user_id IS NULL',
        [sessionData.userId, sessionData.sessionId]
      );
    }
    return;
  }

  // Memory fallback
  const existing = memSessions.get(sessionData.sessionId);
  const nowIso = new Date().toISOString();
  if (existing) {
    if (!existing.userId && sessionData.userId) {
      existing.userId = sessionData.userId;
      for (const ev of memEvents.values()) {
        if (ev.sessionId === sessionData.sessionId && !ev.userId) {
          ev.userId = sessionData.userId;
        }
      }
    }
    // AN-01: Upgrade traffic_source if session was first created as 'direct' by fast server click
    if (existing.trafficSource === 'direct' && sessionData.trafficSource && sessionData.trafficSource !== 'direct') {
      existing.trafficSource = sessionData.trafficSource;
    }
    if (!existing.referrerHost && sessionData.referrerHost) existing.referrerHost = sessionData.referrerHost;
    if (!existing.utmSource && sessionData.utmSource) existing.utmSource = sessionData.utmSource;
    if (!existing.utmMedium && sessionData.utmMedium) existing.utmMedium = sessionData.utmMedium;
    if (!existing.utmCampaign && sessionData.utmCampaign) existing.utmCampaign = sessionData.utmCampaign;
    if (!existing.refCode && sessionData.refCode) existing.refCode = sessionData.refCode;
    if (sessionData.lastView) existing.lastView = sessionData.lastView;
    if (sessionData.isPwa) existing.isPwa = true;

    existing.pageViews += sessionData.pageViewsDelta || 0;
    existing.clickCount += sessionData.clicksDelta || 0;
    existing.lastSeenAt = nowIso;
  } else {
    memSessions.set(sessionData.sessionId, {
      ...sessionData,
      lastView: sessionData.lastView || sessionData.landingView || 'home',
      pageViews: sessionData.pageViewsDelta || 0,
      clickCount: sessionData.clicksDelta || 0,
      startedAt: nowIso,
      lastSeenAt: nowIso
    });
  }
}

async function insertEvents(eventsList) {
  if (!eventsList.length) return { accepted: 0, pageViewsDelta: 0, clicksDelta: 0 };
  const pool = getPgPool();
  if (pool) {
    await ensureAnalyticsSchema(pool);
    const payload = eventsList.map((e) => ({
      event_id: e.eventId,
      session_id: e.sessionId,
      visitor_id: e.visitorId,
      user_id: e.userId,
      event_type: e.eventType,
      view_name: e.viewName,
      platform: e.platform,
      product_id: e.productId,
      product_name: e.productName,
      product_category: e.productCategory,
      source_surface: e.sourceSurface,
      deal_group: e.dealGroup,
      click_id: e.clickId,
      is_valid: e.isValid,
      created_at: e.createdAt
    }));
    const res = await pool.query(
      `INSERT INTO analytics_events (
        event_id, session_id, visitor_id, user_id, event_type, view_name,
        platform, product_id, product_name, product_category,
        source_surface, deal_group, click_id, is_valid, created_at
      )
      SELECT
        event_id, session_id, visitor_id, user_id, event_type, view_name,
        platform, product_id, product_name, product_category,
        source_surface, deal_group, click_id, is_valid, created_at
      FROM jsonb_to_recordset($1::jsonb) AS e(
        event_id text, session_id text, visitor_id text, user_id text, event_type text, view_name text,
        platform text, product_id text, product_name text, product_category text,
        source_surface text, deal_group text, click_id text, is_valid boolean, created_at timestamptz
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_type, is_valid`,
      [JSON.stringify(payload)]
    );
    let pageViewsDelta = 0;
    let clicksDelta = 0;
    for (const row of res.rows || []) {
      if (!row.is_valid) continue;
      if (row.event_type === 'page_view') pageViewsDelta++;
      if (row.event_type === 'product_click' || row.event_type === 'affiliate_click') clicksDelta++;
    }
    return { accepted: res.rowCount || 0, pageViewsDelta, clicksDelta };
  }

  let accepted = 0;
  let pageViewsDelta = 0;
  let clicksDelta = 0;
  for (const e of eventsList) {
    if (!memEvents.has(e.eventId)) {
      memEvents.set(e.eventId, e);
      accepted++;
      if (e.isValid) {
        if (e.eventType === 'page_view') pageViewsDelta++;
        if (e.eventType === 'product_click' || e.eventType === 'affiliate_click') clicksDelta++;
      }
    }
  }
  return { accepted, pageViewsDelta, clicksDelta };
}

const ALLOWED_EVENT_TYPES = new Set([
  'page_view',
  'product_click',
  'affiliate_click',
  'compare_search',
  'cta_click'
]);

/**
 * Ingest a client-batched analytics payload (max 25 events per request).
 */
async function ingestAnalyticsBatch({ session = {}, events = [], authUser = null, ip = '', userAgent = '' }) {
  // AN-02: Never pollute customer analytics with Admin account activity
  if (authUser?.role === 'admin') {
    return { accepted: 0, skippedAdmin: true };
  }

  const sessionId = cleanStr(session.sessionId, 64);
  const visitorId = cleanStr(session.visitorId, 64);
  if (!sessionId || !visitorId) {
    return { accepted: 0 };
  }

  const uaInfo = parseUserAgentInfo(userAgent);
  const trafficSource = classifyTrafficSource({
    utmSource: session.utmSource,
    refCode: session.refCode,
    referrerHost: session.referrerHost,
    userAgent
  });

  const userId = authUser?.id || null;
  const safeEvents = (Array.isArray(events) ? events : []).slice(0, 25);
  const normalized = [];

  for (const raw of safeEvents) {
    const eventType = String(raw?.eventType || '').trim();
    if (!ALLOWED_EVENT_TYPES.has(eventType)) continue;
    const viewName = cleanStr(raw.viewName, 40);
    // AN-02: Never record admin view page_views
    if (eventType === 'page_view' && viewName === 'admin') continue;

    const eventId = cleanStr(raw.eventId, 64) || crypto.randomUUID();
    const productId = cleanStr(raw.productId, 64);
    const isBurst = checkBurstSpam(sessionId);
    const isDup = isDuplicateRecentClick(sessionId, eventType, productId);
    const isValid = !uaInfo.isBot && !isBurst && !isDup;

    normalized.push({
      eventId,
      sessionId,
      visitorId,
      userId,
      eventType,
      viewName,
      platform: raw.platform === 'shopee' || raw.platform === 'tiktok' ? raw.platform : null,
      productId,
      productName: cleanStr(raw.productName, 180),
      productCategory: cleanStr(raw.productCategory, 50),
      sourceSurface: cleanStr(raw.sourceSurface, 40),
      dealGroup: cleanStr(raw.dealGroup, 30),
      clickId: cleanStr(raw.clickId, 40),
      isValid,
      createdAt: new Date().toISOString()
    });
  }

  if (safeEvents.length > 0 && normalized.length === 0) {
    return { accepted: 0 };
  }

  // AN-02: Insert events FIRST so session counters only increment for newly inserted (non-duplicate) events
  const { accepted, pageViewsDelta, clicksDelta } = await insertEvents(normalized);
  // AN-07: Track latest non-empty view_name directly on analytics_sessions to avoid subquery in /realtime
  let lastView = null;
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (normalized[i].viewName) {
      lastView = normalized[i].viewName;
      break;
    }
  }

  await upsertSession({
    sessionId,
    visitorId,
    userId,
    trafficSource,
    referrerHost: cleanStr(session.referrerHost, 120),
    utmSource: cleanStr(session.utmSource, 60),
    utmMedium: cleanStr(session.utmMedium, 60),
    utmCampaign: cleanStr(session.utmCampaign, 80),
    refCode: cleanStr(session.refCode, 40),
    landingView: cleanStr(session.landingView, 40) || 'home',
    lastView,
    deviceType: uaInfo.deviceType,
    browser: uaInfo.browser,
    os: uaInfo.os,
    isPwa: Boolean(session.isPwa),
    ipHash: hashDailyIp(ip),
    isBot: uaInfo.isBot,
    pageViewsDelta,
    clicksDelta
  });

  return { accepted };
}

/**
 * Server-side authoritative affiliate click recorder (called by /api/convert & /api/compare/:platform/link).
 * Guarantees every affiliate click is captured with productName, clickId, platform & sourceSurface.
 */
async function recordServerAffiliateClick({
  req,
  authUser = null,
  platform,
  productId,
  productName = '',
  productCategory = '',
  sourceSurface = 'direct_convert',
  dealGroup = null,
  clickId
}) {
  if (!clickId || !platform) return;
  // AN-02: Do not record Admin testing clicks into customer analytics
  if (authUser?.role === 'admin') return;

  const sessionId = cleanStr(req?.headers?.['x-analytics-session'], 64) || `srv_${clickId}`;
  const visitorId = cleanStr(req?.headers?.['x-analytics-visitor'], 64) || (authUser?.id ? `usr_${authUser.id}` : sessionId);
  const ua = req?.headers?.['user-agent'] || '';
  const uaInfo = parseUserAgentInfo(ua);
  const ip = req?.ip || '';

  const { clicksDelta } = await insertEvents([
    {
      eventId: `aff_${clickId}`,
      sessionId,
      visitorId,
      userId: authUser?.id || null,
      eventType: 'affiliate_click',
      viewName: 'home',
      platform: platform === 'tiktok' ? 'tiktok' : 'shopee',
      productId: cleanStr(productId, 64),
      productName: cleanStr(productName, 180) || `Sản phẩm ${platform === 'tiktok' ? 'TikTok' : 'Shopee'} #${productId || ''}`,
      productCategory: cleanStr(productCategory, 50),
      sourceSurface: cleanStr(sourceSurface, 40),
      dealGroup: cleanStr(dealGroup, 30),
      clickId: cleanStr(clickId, 40),
      isValid: !uaInfo.isBot,
      createdAt: new Date().toISOString()
    }
  ]);

  await upsertSession({
    sessionId,
    visitorId,
    userId: authUser?.id || null,
    trafficSource: classifyTrafficSource({ userAgent: ua }),
    referrerHost: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    refCode: null,
    landingView: 'home',
    deviceType: uaInfo.deviceType,
    browser: uaInfo.browser,
    os: uaInfo.os,
    isPwa: false,
    ipHash: hashDailyIp(ip),
    isBot: uaInfo.isBot,
    pageViewsDelta: 0,
    clicksDelta
  });
}

const ALLOWED_SOURCES = new Set(['zalo', 'facebook', 'tiktok', 'google', 'share_link', 'utm', 'referral', 'direct']);
const ALLOWED_DEVICES = new Set(['mobile', 'desktop', 'tablet']);

function normalizeFilterOpts(rangeOrOpts) {
  if (rangeOrOpts && typeof rangeOrOpts === 'object') {
    const rawRange = rangeOrOpts.range != null ? rangeOrOpts.range : rangeOrOpts.rangeDays;
    const isYesterday = String(rawRange || '').toLowerCase() === 'yesterday';
    const rangeDays = isYesterday ? 1 : Math.min(90, Math.max(1, Number(rawRange) || 7));
    const source = ALLOWED_SOURCES.has(String(rangeOrOpts.source || '').trim()) ? String(rangeOrOpts.source).trim() : '';
    const device = ALLOWED_DEVICES.has(String(rangeOrOpts.device || '').trim()) ? String(rangeOrOpts.device).trim() : '';
    return { range: isYesterday ? 'yesterday' : String(rangeDays), rangeDays, isYesterday, source, device };
  }
  const isYesterday = String(rangeOrOpts || '').toLowerCase() === 'yesterday';
  const rangeDays = isYesterday ? 1 : Math.min(90, Math.max(1, Number(rangeOrOpts) || 7));
  return { range: isYesterday ? 'yesterday' : String(rangeDays), rangeDays, isYesterday, source: '', device: '' };
}

function getDateWindow(opts) {
  const vnOffset = 7 * 60 * 60 * 1000;
  const now = new Date();
  const vnNow = new Date(now.getTime() + vnOffset);
  vnNow.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(vnNow.getTime() - vnOffset);

  if (opts.isYesterday) {
    return {
      start: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000),
      end: todayStart
    };
  }
  if (opts.rangeDays === 1) {
    return { start: todayStart, end: null };
  }
  return { start: new Date(Date.now() - opts.rangeDays * 24 * 60 * 60 * 1000), end: null };
}

function getCutoffDate(rangeDays) {
  return getDateWindow(normalizeFilterOpts(rangeDays)).start;
}

/**
 * Admin API 1: Overview KPIs + Traffic Sources (30s L1 cache on PG).
 */
async function getAnalyticsOverview(rangeOrOpts = 7) {
  const opts = normalizeFilterOpts(rangeOrOpts);
  return withAdminCache(`overview:${opts.range}:${opts.source}:${opts.device}`, () => _computeAnalyticsOverview(opts));
}

async function _computeAnalyticsOverview(opts) {
  const { start, end } = getDateWindow(opts);
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const sessParams = [start];
    let sessWhere = 'is_bot = FALSE AND last_seen_at >= $1';
    if (end) {
      sessParams.push(end);
      sessWhere += ` AND last_seen_at < $${sessParams.length}`;
    }
    if (opts.source) {
      sessParams.push(opts.source);
      sessWhere += ` AND traffic_source = $${sessParams.length}`;
    }
    if (opts.device) {
      sessParams.push(opts.device);
      sessWhere += ` AND device_type = $${sessParams.length}`;
    }

    const evParams = [start];
    let evWhere = 'ae.created_at >= $1';
    let evJoin = '';
    if (end) {
      evParams.push(end);
      evWhere += ` AND ae.created_at < $${evParams.length}`;
    }
    if (opts.source || opts.device) {
      evJoin = 'JOIN analytics_sessions s ON s.session_id = ae.session_id';
      evWhere += ' AND s.is_bot = FALSE';
      if (opts.source) {
        evParams.push(opts.source);
        evWhere += ` AND s.traffic_source = $${evParams.length}`;
      }
      if (opts.device) {
        evParams.push(opts.device);
        evWhere += ` AND s.device_type = $${evParams.length}`;
      }
    }

    const [sessRes, evRes, srcRes] = await Promise.all([
      pool.query(
        `WITH active_sess AS (
          SELECT session_id, visitor_id, user_id
          FROM analytics_sessions
          WHERE ${sessWhere}
        ),
        logged_in_visitors AS (
          SELECT DISTINCT visitor_id
          FROM active_sess
          WHERE user_id IS NOT NULL
        )
        SELECT
          COUNT(*)::int AS sessions,
          COUNT(DISTINCT visitor_id)::int AS unique_visitors,
          COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS active_members,
          COUNT(DISTINCT visitor_id) FILTER (
            WHERE user_id IS NULL AND visitor_id NOT IN (SELECT visitor_id FROM logged_in_visitors)
          )::int AS anonymous_visitors
        FROM active_sess`,
        sessParams
      ),
      pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE ae.event_type = 'page_view' AND ae.is_valid = TRUE)::int AS page_views,
          COUNT(*) FILTER (WHERE ae.event_type IN ('product_click', 'affiliate_click'))::int AS raw_clicks,
          COUNT(*) FILTER (WHERE ae.event_type IN ('product_click', 'affiliate_click') AND ae.is_valid = TRUE)::int AS valid_clicks,
          COUNT(*) FILTER (WHERE ae.event_type = 'affiliate_click' AND ae.is_valid = TRUE)::int AS affiliate_clicks,
          COUNT(*) FILTER (WHERE ae.event_type IN ('product_click', 'affiliate_click') AND ae.is_valid = TRUE AND ae.platform = 'shopee')::int AS shopee_clicks,
          COUNT(*) FILTER (WHERE ae.event_type IN ('product_click', 'affiliate_click') AND ae.is_valid = TRUE AND ae.platform = 'tiktok')::int AS tiktok_clicks
        FROM analytics_events ae
        ${evJoin}
        WHERE ${evWhere}`,
        evParams
      ),
      pool.query(
        `WITH active_sess AS (
          SELECT session_id, visitor_id, traffic_source
          FROM analytics_sessions
          WHERE ${sessWhere}
        ),
        src_clicks AS (
          SELECT s.traffic_source, COUNT(*)::int AS clicks
          FROM analytics_events ae
          JOIN analytics_sessions s ON s.session_id = ae.session_id
          WHERE s.is_bot = FALSE
            AND ae.event_type IN ('product_click', 'affiliate_click')
            AND ae.is_valid = TRUE
            AND ae.created_at >= $1
            ${end ? 'AND ae.created_at < $2' : ''}
            ${opts.source ? `AND s.traffic_source = $${end ? 3 : 2}` : ''}
            ${opts.device ? `AND s.device_type = $${(end ? 2 : 1) + (opts.source ? 2 : 1)}` : ''}
          GROUP BY s.traffic_source
        )
        SELECT
          a.traffic_source AS source,
          COUNT(DISTINCT a.visitor_id)::int AS visitors,
          COUNT(*)::int AS sessions,
          COALESCE(sc.clicks, 0)::int AS clicks
        FROM active_sess a
        LEFT JOIN src_clicks sc ON sc.traffic_source = a.traffic_source
        GROUP BY a.traffic_source, sc.clicks
        ORDER BY visitors DESC, clicks DESC`,
        sessParams
      )
    ]);

    const s = sessRes.rows[0] || {};
    const e = evRes.rows[0] || {};
    return {
      range: opts.range,
      rangeDays: opts.rangeDays,
      kpis: {
        sessions: s.sessions || 0,
        uniqueVisitors: s.unique_visitors || 0,
        pageViews: e.page_views || 0,
        activeMembers: s.active_members || 0,
        anonymousVisitors: s.anonymous_visitors || 0,
        rawClicks: e.raw_clicks || 0,
        validClicks: e.valid_clicks || 0,
        affiliateClicks: e.affiliate_clicks || 0,
        shopeeClicks: e.shopee_clicks || 0,
        tiktokClicks: e.tiktok_clicks || 0
      },
      sources: srcRes.rows || []
    };
  }

  // Memory fallback
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Infinity;
  const sessList = [...memSessions.values()].filter((s) => {
    if (s.isBot) return false;
    const t = new Date(s.lastSeenAt).getTime();
    if (t < startMs || t >= endMs) return false;
    if (opts.source && s.trafficSource !== opts.source) return false;
    if (opts.device && s.deviceType !== opts.device) return false;
    return true;
  });
  const allowedSessionIds = opts.source || opts.device ? new Set(sessList.map((s) => s.sessionId)) : null;
  const evList = [...memEvents.values()].filter((e) => {
    const t = new Date(e.createdAt).getTime();
    if (t < startMs || t >= endMs) return false;
    if (allowedSessionIds && !allowedSessionIds.has(e.sessionId)) return false;
    return true;
  });
  const visitors = new Set(sessList.map((s) => s.visitorId));
  const members = new Set(sessList.filter((s) => s.userId).map((s) => s.userId));
  // AN-04: Exclude visitors who also have a logged-in session in this range so members + anon <= uniqueVisitors
  const loggedInVisitors = new Set(sessList.filter((s) => s.userId).map((s) => s.visitorId));
  const anon = new Set(sessList.filter((s) => !s.userId && !loggedInVisitors.has(s.visitorId)).map((s) => s.visitorId));
  // AN-03: Count pageViews strictly from analytics_events within the date window
  const pageViews = evList.filter((e) => e.eventType === 'page_view' && e.isValid).length;
  const clickEvs = evList.filter((e) => e.eventType === 'product_click' || e.eventType === 'affiliate_click');
  const validClicks = clickEvs.filter((e) => e.isValid);

  const srcClicksMap = new Map();
  for (const e of validClicks) {
    const sess = memSessions.get(e.sessionId);
    if (!sess || sess.isBot) continue;
    srcClicksMap.set(sess.trafficSource, (srcClicksMap.get(sess.trafficSource) || 0) + 1);
  }

  const srcMap = new Map();
  for (const s of sessList) {
    const cur = srcMap.get(s.trafficSource) || { source: s.trafficSource, visitors: new Set(), sessions: 0, clicks: 0 };
    cur.visitors.add(s.visitorId);
    cur.sessions++;
    cur.clicks = srcClicksMap.get(s.trafficSource) || 0;
    srcMap.set(s.trafficSource, cur);
  }

  return {
    range: opts.range,
    rangeDays: opts.rangeDays,
    kpis: {
      sessions: sessList.length,
      uniqueVisitors: visitors.size,
      pageViews,
      activeMembers: members.size,
      anonymousVisitors: anon.size,
      rawClicks: clickEvs.length,
      validClicks: validClicks.length,
      affiliateClicks: validClicks.filter((e) => e.eventType === 'affiliate_click').length,
      shopeeClicks: validClicks.filter((e) => e.platform === 'shopee').length,
      tiktokClicks: validClicks.filter((e) => e.platform === 'tiktok').length
    },
    sources: [...srcMap.values()]
      .map((x) => ({ source: x.source, visitors: x.visitors.size, sessions: x.sessions, clicks: x.clicks }))
      .sort((a, b) => b.visitors - a.visitors)
  };
}

/**
 * Admin API 2 (Priority #1): Member Activity Table (supports range/yesterday, source, device & pagination total).
 */
async function getAnalyticsMembers({ rangeDays = 30, range = null, source = '', device = '', sortBy = 'clicks', search = '', page = 1, limit = 20 }) {
  const opts = normalizeFilterOpts({ range: range != null ? range : rangeDays, source, device });
  const { start, end } = getDateWindow(opts);
  const safeLimit = Math.min(50, Math.max(5, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const searchTrim = String(search || '').trim().toLowerCase();
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const orderClause =
      sortBy === 'sessions'
        ? 'sessions_count DESC, total_clicks DESC'
        : sortBy === 'recent'
          ? 'last_seen_at DESC'
          : 'total_clicks DESC, last_seen_at DESC';

    const params = [start];
    let sessWhere = 'user_id IS NOT NULL AND is_bot = FALSE AND last_seen_at >= $1';
    let evWhere = 'user_id IS NOT NULL AND created_at >= $1';
    if (end) {
      params.push(end);
      sessWhere += ` AND last_seen_at < $${params.length}`;
      evWhere += ` AND created_at < $${params.length}`;
    }
    if (opts.source) {
      params.push(opts.source);
      sessWhere += ` AND traffic_source = $${params.length}`;
    }
    if (opts.device) {
      params.push(opts.device);
      sessWhere += ` AND device_type = $${params.length}`;
    }

    let searchSql = '';
    if (searchTrim) {
      params.push(`%${searchTrim}%`);
      searchSql = `AND (LOWER(u.name) LIKE $${params.length} OR LOWER(u.code) LIKE $${params.length} OR LOWER(COALESCE(u.phone, '')) LIKE $${params.length})`;
    }

    const q = `
      WITH member_sessions AS (
        SELECT
          user_id,
          COUNT(*)::int AS sessions_count,
          MAX(last_seen_at) AS last_seen_at,
          (ARRAY_AGG(traffic_source ORDER BY last_seen_at DESC))[1] AS last_source,
          (ARRAY_AGG(device_type ORDER BY last_seen_at DESC))[1] AS last_device
        FROM analytics_sessions
        WHERE ${sessWhere}
        GROUP BY user_id
      ),
      member_clicks AS (
        SELECT
          user_id,
          COUNT(*) FILTER (WHERE event_type = 'page_view' AND is_valid = TRUE)::int AS page_views,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE)::int AS total_clicks,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE AND platform = 'shopee')::int AS shopee_clicks,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE AND platform = 'tiktok')::int AS tiktok_clicks
        FROM analytics_events
        WHERE ${evWhere}
        GROUP BY user_id
      )
      SELECT
        COUNT(*) OVER()::int AS full_total,
        u.id AS user_id,
        u.code AS user_code,
        u.name AS user_name,
        u.phone AS user_phone,
        ms.sessions_count,
        COALESCE(mc.page_views, 0)::int AS page_views,
        ms.last_seen_at,
        ms.last_source,
        ms.last_device,
        COALESCE(mc.total_clicks, 0)::int AS total_clicks,
        COALESCE(mc.shopee_clicks, 0)::int AS shopee_clicks,
        COALESCE(mc.tiktok_clicks, 0)::int AS tiktok_clicks
      FROM member_sessions ms
      JOIN users u ON u.id = ms.user_id
      LEFT JOIN member_clicks mc ON mc.user_id = ms.user_id
      WHERE 1=1 ${searchSql}
      ORDER BY ${orderClause}
      LIMIT ${safeLimit} OFFSET ${offset}
    `;

    const { rows } = await pool.query(q, params);
    const total = rows[0]?.full_total || 0;
    return {
      page: safePage,
      limit: safeLimit,
      total,
      hasMore: offset + rows.length < total,
      items: rows.map((r) => ({
        userId: r.user_id,
        userCode: r.user_code || '',
        name: r.user_name || 'Thành viên',
        phone: r.user_phone || '',
        sessionsCount: r.sessions_count || 0,
        pageViews: r.page_views || 0,
        totalClicks: r.total_clicks || 0,
        shopeeClicks: r.shopee_clicks || 0,
        tiktokClicks: r.tiktok_clicks || 0,
        lastSource: r.last_source || 'direct',
        lastDevice: r.last_device || 'mobile',
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
        favoritePlatform:
          r.shopee_clicks > r.tiktok_clicks ? 'shopee' : r.tiktok_clicks > r.shopee_clicks ? 'tiktok' : r.total_clicks > 0 ? 'both' : 'none'
      }))
    };
  }

  // Memory fallback
  const db = ensureDbLoaded();
  const userMap = new Map((db.users || []).map((u) => [u.id, u]));
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Infinity;
  const agg = new Map();

  for (const s of memSessions.values()) {
    const t = new Date(s.lastSeenAt).getTime();
    if (!s.userId || s.isBot || t < startMs || t >= endMs) continue;
    if (opts.source && s.trafficSource !== opts.source) continue;
    if (opts.device && s.deviceType !== opts.device) continue;
    const cur = agg.get(s.userId) || {
      userId: s.userId,
      sessionsCount: 0,
      pageViews: 0,
      totalClicks: 0,
      shopeeClicks: 0,
      tiktokClicks: 0,
      lastSource: s.trafficSource,
      lastDevice: s.deviceType,
      lastSeenAt: s.lastSeenAt
    };
    cur.sessionsCount++;
    if (s.lastSeenAt >= cur.lastSeenAt) {
      cur.lastSeenAt = s.lastSeenAt;
      cur.lastSource = s.trafficSource;
      cur.lastDevice = s.deviceType;
    }
    agg.set(s.userId, cur);
  }

  for (const e of memEvents.values()) {
    const t = new Date(e.createdAt).getTime();
    if (!e.userId || !e.isValid || t < startMs || t >= endMs) continue;
    const cur = agg.get(e.userId);
    if (!cur) continue;
    if (e.eventType === 'page_view') {
      cur.pageViews++;
      continue;
    }
    if (e.eventType !== 'product_click' && e.eventType !== 'affiliate_click') continue;
    cur.totalClicks++;
    if (e.platform === 'shopee') cur.shopeeClicks++;
    if (e.platform === 'tiktok') cur.tiktokClicks++;
  }

  let list = [...agg.values()].map((r) => {
    const u = userMap.get(r.userId) || {};
    return {
      ...r,
      userCode: u.code || '',
      name: u.name || 'Thành viên',
      phone: u.phone || '',
      favoritePlatform:
        r.shopeeClicks > r.tiktokClicks ? 'shopee' : r.tiktokClicks > r.shopeeClicks ? 'tiktok' : r.totalClicks > 0 ? 'both' : 'none'
    };
  });

  if (searchTrim) {
    list = list.filter((x) => `${x.name} ${x.userCode} ${x.phone}`.toLowerCase().includes(searchTrim));
  }

  list.sort((a, b) =>
    sortBy === 'sessions'
      ? b.sessionsCount - a.sessionsCount
      : sortBy === 'recent'
        ? String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))
        : b.totalClicks - a.totalClicks
  );

  const pageItems = list.slice(offset, offset + safeLimit);
  return {
    page: safePage,
    limit: safeLimit,
    total: list.length,
    hasMore: offset + pageItems.length < list.length,
    items: pageItems
  };
}

/**
 * Admin API 3 (Priority #1 Core): Per-Member Click & Activity Timeline joined with Orders.
 */
async function getMemberActivityTimeline({ userId, rangeDays = 30, range = null, platform = '', page = 1, limit = 25 }) {
  const opts = normalizeFilterOpts({ range: range != null ? range : rangeDays });
  const { start, end } = getDateWindow(opts);
  const safeLimit = Math.min(50, Math.max(5, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const platFilter = platform === 'shopee' || platform === 'tiktok' ? platform : '';
  const pool = getPgPool();

  const db = ensureDbLoaded();
  const userObj = (db.users || []).find((u) => u.id === userId) || null;

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const sumParams = end ? [userId, start, end] : [userId, start];
    const sumEndSql = end ? 'AND last_seen_at < $3' : '';
    const pvEndSql = end ? 'AND created_at < $3' : '';
    const [summaryRes, pvRes] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS sessions_count,
          MAX(last_seen_at) AS last_seen_at,
          (ARRAY_AGG(traffic_source ORDER BY last_seen_at DESC))[1] AS last_source,
          (ARRAY_AGG(device_type ORDER BY last_seen_at DESC))[1] AS last_device,
          (ARRAY_AGG(browser ORDER BY last_seen_at DESC))[1] AS last_browser
        FROM analytics_sessions
        WHERE user_id = $1 AND is_bot = FALSE AND last_seen_at >= $2 ${sumEndSql}`,
        sumParams
      ),
      pool.query(
        `SELECT COUNT(*)::int AS page_views
        FROM analytics_events
        WHERE user_id = $1 AND event_type = 'page_view' AND is_valid = TRUE AND created_at >= $2 ${pvEndSql}`,
        sumParams
      )
    ]);

    const params = [userId, start];
    let endSql = '';
    if (end) {
      params.push(end);
      endSql = `AND ae.created_at < $${params.length}`;
    }
    let platSql = '';
    if (platFilter) {
      params.push(platFilter);
      platSql = `AND ae.platform = $${params.length}`;
    }

    const timelineRes = await pool.query(
      `SELECT
        COUNT(*) OVER()::int AS full_total,
        ae.event_id,
        ae.event_type,
        ae.view_name,
        ae.platform,
        ae.product_id,
        ae.product_name,
        ae.product_category,
        ae.source_surface,
        ae.deal_group,
        ae.click_id,
        ae.is_valid,
        ae.created_at,
        asess.traffic_source,
        asess.utm_campaign,
        asess.referrer_host,
        asess.device_type,
        o.order_sn,
        o.status AS order_status,
        o.user_cashback_amount
      FROM analytics_events ae
      LEFT JOIN analytics_sessions asess ON asess.session_id = ae.session_id
      LEFT JOIN orders o ON o.click_id IS NOT NULL AND o.click_id = ae.click_id
      WHERE ae.user_id = $1 AND ae.created_at >= $2 ${endSql} ${platSql}
      ORDER BY ae.created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}`,
      params
    );

    const s = summaryRes.rows[0] || {};
    const pvCount = pvRes.rows[0]?.page_views || 0;
    const total = timelineRes.rows[0]?.full_total || 0;
    return {
      member: {
        userId,
        userCode: userObj?.code || '',
        name: userObj?.name || 'Thành viên',
        phone: userObj?.phone || '',
        sessionsCount: s.sessions_count || 0,
        pageViews: pvCount,
        lastSeenAt: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
        lastSource: s.last_source || 'direct',
        lastDevice: s.last_device || 'mobile',
        lastBrowser: s.last_browser || ''
      },
      page: safePage,
      limit: safeLimit,
      total,
      hasMore: offset + timelineRes.rows.length < total,
      timeline: timelineRes.rows.map((r) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        viewName: r.view_name || '',
        platform: r.platform || '',
        productId: r.product_id || '',
        productName: r.product_name || '',
        productCategory: r.product_category || '',
        sourceSurface: r.source_surface || '',
        dealGroup: r.deal_group || '',
        clickId: r.click_id || '',
        isValid: r.is_valid !== false,
        trafficSource: r.traffic_source || 'direct',
        utmCampaign: r.utm_campaign || '',
        referrerHost: r.referrer_host || '',
        deviceType: r.device_type || '',
        orderSn: r.order_sn || null,
        orderStatus: r.order_status || null,
        orderCashback: Number(r.user_cashback_amount || 0),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
      }))
    };
  }

  // Memory fallback
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Infinity;
  const userSessions = [...memSessions.values()].filter((s) => {
    const t = new Date(s.lastSeenAt).getTime();
    return s.userId === userId && !s.isBot && t >= startMs && t < endMs;
  });
  const orderByClick = new Map((db.orders || []).filter((o) => o.clickId).map((o) => [o.clickId, o]));

  let events = [...memEvents.values()]
    .filter((e) => {
      const t = new Date(e.createdAt).getTime();
      return e.userId === userId && t >= startMs && t < endMs;
    })
    .filter((e) => !platFilter || e.platform === platFilter)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const lastSess = userSessions.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))[0];
  const memberPageViews = [...memEvents.values()].filter((e) => {
    const t = new Date(e.createdAt).getTime();
    return e.userId === userId && e.eventType === 'page_view' && e.isValid && t >= startMs && t < endMs;
  }).length;
  const pageEvents = events.slice(offset, offset + safeLimit);

  return {
    member: {
      userId,
      userCode: userObj?.code || '',
      name: userObj?.name || 'Thành viên',
      phone: userObj?.phone || '',
      sessionsCount: userSessions.length,
      pageViews: memberPageViews,
      lastSeenAt: lastSess?.lastSeenAt || null,
      lastSource: lastSess?.trafficSource || 'direct',
      lastDevice: lastSess?.deviceType || 'mobile',
      lastBrowser: lastSess?.browser || ''
    },
    page: safePage,
    limit: safeLimit,
    total: events.length,
    hasMore: offset + pageEvents.length < events.length,
    timeline: pageEvents.map((e) => {
      const sess = memSessions.get(e.sessionId) || {};
      const ord = e.clickId ? orderByClick.get(e.clickId) : null;
      return {
        ...e,
        trafficSource: sess.trafficSource || 'direct',
        utmCampaign: sess.utmCampaign || '',
        referrerHost: sess.referrerHost || '',
        deviceType: sess.deviceType || '',
        orderSn: ord?.orderSn || null,
        orderStatus: ord?.status || null,
        orderCashback: Number(ord?.userCashbackAmount || 0)
      };
    })
  };
}

/**
 * Admin API 4: Top Clicked Products (supports range/yesterday, source, device, platform).
 */
async function getAnalyticsTopProducts({ rangeDays = 30, range = null, source = '', device = '', platform = '', limit = 20 }) {
  const opts = normalizeFilterOpts({ range: range != null ? range : rangeDays, source, device });
  const { start, end } = getDateWindow(opts);
  const safeLimit = Math.min(50, Math.max(5, Number(limit) || 20));
  const platFilter = platform === 'shopee' || platform === 'tiktok' ? platform : '';
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const params = [start];
    let whereSql = `ae.event_type IN ('product_click', 'affiliate_click') AND ae.product_id IS NOT NULL AND ae.created_at >= $1`;
    let sessJoin = '';
    if (end) {
      params.push(end);
      whereSql += ` AND ae.created_at < $${params.length}`;
    }
    if (platFilter) {
      params.push(platFilter);
      whereSql += ` AND ae.platform = $${params.length}`;
    }
    if (opts.source || opts.device) {
      sessJoin = 'JOIN analytics_sessions s ON s.session_id = ae.session_id';
      whereSql += ' AND s.is_bot = FALSE';
      if (opts.source) {
        params.push(opts.source);
        whereSql += ` AND s.traffic_source = $${params.length}`;
      }
      if (opts.device) {
        params.push(opts.device);
        whereSql += ` AND s.device_type = $${params.length}`;
      }
    }

    const { rows } = await pool.query(
      `SELECT
        ae.product_id,
        ae.platform,
        MAX(ae.product_name) AS product_name,
        COUNT(*)::int AS raw_clicks,
        COUNT(*) FILTER (WHERE ae.is_valid = TRUE)::int AS valid_clicks,
        COUNT(DISTINCT COALESCE(ae.user_id, ae.visitor_id)) FILTER (WHERE ae.is_valid = TRUE)::int AS unique_clickers,
        COUNT(*) FILTER (WHERE ae.source_surface = 'home_deal_shelf' AND ae.is_valid = TRUE)::int AS deal_clicks,
        COUNT(*) FILTER (WHERE ae.source_surface IN ('compare_sp_to_tt', 'compare_tt_to_sp') AND ae.is_valid = TRUE)::int AS compare_clicks,
        COUNT(DISTINCT o.order_sn)::int AS orders_count,
        MAX(ae.created_at) AS last_clicked_at
      FROM analytics_events ae
      ${sessJoin}
      LEFT JOIN orders o ON o.click_id IS NOT NULL AND o.click_id = ae.click_id
      WHERE ${whereSql}
      GROUP BY ae.product_id, ae.platform
      ORDER BY valid_clicks DESC, unique_clickers DESC
      LIMIT ${safeLimit}`,
      params
    );

    return {
      items: rows.map((r) => ({
        productId: r.product_id,
        platform: r.platform || 'shopee',
        productName: r.product_name || `SP #${r.product_id}`,
        rawClicks: r.raw_clicks || 0,
        validClicks: r.valid_clicks || 0,
        uniqueClickers: r.unique_clickers || 0,
        dealClicks: r.deal_clicks || 0,
        compareClicks: r.compare_clicks || 0,
        ordersCount: r.orders_count || 0,
        lastClickedAt: r.last_clicked_at ? new Date(r.last_clicked_at).toISOString() : null
      }))
    };
  }

  // Memory fallback
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Infinity;
  const map = new Map();
  for (const e of memEvents.values()) {
    if (e.eventType !== 'product_click' && e.eventType !== 'affiliate_click') continue;
    const t = new Date(e.createdAt).getTime();
    if (!e.productId || t < startMs || t >= endMs) continue;
    if (platFilter && e.platform !== platFilter) continue;
    if (opts.source || opts.device) {
      const sess = memSessions.get(e.sessionId);
      if (!sess || sess.isBot) continue;
      if (opts.source && sess.trafficSource !== opts.source) continue;
      if (opts.device && sess.deviceType !== opts.device) continue;
    }
    const key = `${e.platform}:${e.productId}`;
    const cur = map.get(key) || {
      productId: e.productId,
      platform: e.platform || 'shopee',
      productName: e.productName || `SP #${e.productId}`,
      rawClicks: 0,
      validClicks: 0,
      clickers: new Set(),
      dealClicks: 0,
      compareClicks: 0,
      ordersCount: 0,
      lastClickedAt: e.createdAt
    };
    cur.rawClicks++;
    if (e.isValid) {
      cur.validClicks++;
      cur.clickers.add(e.userId || e.visitorId);
      if (e.sourceSurface === 'home_deal_shelf') cur.dealClicks++;
      if (e.sourceSurface === 'compare_sp_to_tt' || e.sourceSurface === 'compare_tt_to_sp') cur.compareClicks++;
    }
    if (e.productName && cur.productName.startsWith('SP #')) cur.productName = e.productName;
    if (e.createdAt > cur.lastClickedAt) cur.lastClickedAt = e.createdAt;
    map.set(key, cur);
  }

  return {
    items: [...map.values()]
      .map((x) => ({
        productId: x.productId,
        platform: x.platform,
        productName: x.productName,
        rawClicks: x.rawClicks,
        validClicks: x.validClicks,
        uniqueClickers: x.clickers.size,
        dealClicks: x.dealClicks,
        compareClicks: x.compareClicks,
        ordersCount: x.ordersCount,
        lastClickedAt: x.lastClickedAt
      }))
      .sort((a, b) => b.validClicks - a.validClicks)
      .slice(0, safeLimit)
  };
}

/**
 * 90-day retention cleanup (wired into daily Vercel Cron).
 */
async function pruneOldAnalyticsRecords(retentionDays = ANALYTICS_RETENTION_DAYS) {
  const days = Math.max(7, Number(retentionDays) || ANALYTICS_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const [evRes, sessRes] = await Promise.all([
      pool.query('DELETE FROM analytics_events WHERE created_at < $1', [cutoff]),
      pool.query('DELETE FROM analytics_sessions WHERE last_seen_at < $1', [cutoff])
    ]);
    return { deletedEvents: evRes.rowCount || 0, deletedSessions: sessRes.rowCount || 0 };
  }

  const cutoffMs = cutoff.getTime();
  let deletedEvents = 0;
  let deletedSessions = 0;
  for (const [k, v] of memEvents.entries()) {
    if (new Date(v.createdAt).getTime() < cutoffMs) {
      memEvents.delete(k);
      deletedEvents++;
    }
  }
  for (const [k, v] of memSessions.entries()) {
    if (new Date(v.lastSeenAt).getTime() < cutoffMs) {
      memSessions.delete(k);
      deletedSessions++;
    }
  }
  return { deletedEvents, deletedSessions };
}

/**
 * P1 API 1: Real-time Analytics (active in last 5 minutes + latest 15 clicks).
 */
async function getAnalyticsRealtime({ filter = 'all' } = {}) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const safeFilter = filter === 'members' || filter === 'anonymous' ? filter : 'all';
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const filterSql =
      safeFilter === 'members'
        ? 'AND s.user_id IS NOT NULL'
        : safeFilter === 'anonymous'
          ? 'AND s.user_id IS NULL'
          : '';

    const [countsRes, activeRes, clicksRes] = await Promise.all([
      pool.query(
        `WITH online_sess AS (
          SELECT visitor_id, user_id
          FROM analytics_sessions
          WHERE is_bot = FALSE AND last_seen_at >= $1
        ),
        online_logged_in AS (
          SELECT DISTINCT visitor_id FROM online_sess WHERE user_id IS NOT NULL
        )
        SELECT
          COUNT(DISTINCT visitor_id)::int AS total_online,
          COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS members_online,
          COUNT(DISTINCT visitor_id) FILTER (
            WHERE user_id IS NULL AND visitor_id NOT IN (SELECT visitor_id FROM online_logged_in)
          )::int AS anonymous_online
        FROM online_sess`,
        [cutoff]
      ),
      pool.query(
        `SELECT
          s.session_id,
          s.visitor_id,
          s.user_id,
          u.name AS user_name,
          u.code AS user_code,
          s.traffic_source,
          s.device_type,
          s.browser,
          s.landing_view,
          s.last_view,
          s.last_seen_at
        FROM analytics_sessions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.is_bot = FALSE AND s.last_seen_at >= $1 ${filterSql}
        ORDER BY s.last_seen_at DESC
        LIMIT 25`,
        [cutoff]
      ),
      pool.query(
        `SELECT
          ae.event_id,
          ae.user_id,
          ae.visitor_id,
          u.name AS user_name,
          u.code AS user_code,
          ae.platform,
          ae.product_id,
          ae.product_name,
          ae.source_surface,
          ae.created_at
        FROM analytics_events ae
        LEFT JOIN users u ON u.id = ae.user_id
        WHERE ae.event_type IN ('product_click', 'affiliate_click') AND ae.is_valid = TRUE
        ORDER BY ae.created_at DESC
        LIMIT 15`
      )
    ]);

    const c = countsRes.rows[0] || {};
    return {
      online: {
        total: c.total_online || 0,
        members: c.members_online || 0,
        anonymous: c.anonymous_online || 0
      },
      activeSessions: activeRes.rows.map((r) => ({
        sessionId: r.session_id,
        visitorTag: r.visitor_id ? `#${String(r.visitor_id).slice(-5)}` : '#guest',
        isMember: Boolean(r.user_id),
        userId: r.user_id || null,
        name: r.user_id ? r.user_name || 'Thành viên' : `Khách ẩn danh #${String(r.visitor_id || '').slice(-4)}`,
        userCode: r.user_code || '',
        trafficSource: r.traffic_source || 'direct',
        deviceType: r.device_type || 'mobile',
        browser: r.browser || '',
        currentView: r.last_view || r.landing_view || 'home',
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null
      })),
      recentClicks: clicksRes.rows.map((r) => ({
        eventId: r.event_id,
        userId: r.user_id || null,
        actorName: r.user_id ? `${r.user_name || 'Thành viên'} (${r.user_code || ''})` : `Khách #${String(r.visitor_id || '').slice(-4)}`,
        platform: r.platform || 'shopee',
        productId: r.product_id || '',
        productName: r.product_name || `SP #${r.product_id || ''}`,
        sourceSurface: r.source_surface || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
      }))
    };
  }

  // Memory fallback
  const db = ensureDbLoaded();
  const userMap = new Map((db.users || []).map((u) => [u.id, u]));
  const cutoffMs = cutoff.getTime();
  const onlineSess = [...memSessions.values()].filter((s) => !s.isBot && new Date(s.lastSeenAt).getTime() >= cutoffMs);
  const filteredSess = onlineSess.filter((s) =>
    safeFilter === 'members' ? Boolean(s.userId) : safeFilter === 'anonymous' ? !s.userId : true
  );

  const recentClicks = [...memEvents.values()]
    .filter((e) => (e.eventType === 'product_click' || e.eventType === 'affiliate_click') && e.isValid)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 15)
    .map((e) => {
      const u = e.userId ? userMap.get(e.userId) : null;
      return {
        eventId: e.eventId,
        userId: e.userId || null,
        actorName: u ? `${u.name} (${u.code})` : `Khách #${String(e.visitorId || '').slice(-4)}`,
        platform: e.platform || 'shopee',
        productId: e.productId || '',
        productName: e.productName || `SP #${e.productId || ''}`,
        sourceSurface: e.sourceSurface || '',
        createdAt: e.createdAt
      };
    });

  const onlineLoggedInVisitors = new Set(onlineSess.filter((s) => s.userId).map((s) => s.visitorId));
  return {
    online: {
      total: new Set(onlineSess.map((s) => s.visitorId)).size,
      members: new Set(onlineSess.filter((s) => s.userId).map((s) => s.userId)).size,
      anonymous: new Set(onlineSess.filter((s) => !s.userId && !onlineLoggedInVisitors.has(s.visitorId)).map((s) => s.visitorId)).size
    },
    activeSessions: filteredSess.slice(0, 25).map((s) => {
      const u = s.userId ? userMap.get(s.userId) : null;
      return {
        sessionId: s.sessionId,
        visitorTag: `#${String(s.visitorId || '').slice(-5)}`,
        isMember: Boolean(s.userId),
        userId: s.userId || null,
        name: u ? u.name : `Khách ẩn danh #${String(s.visitorId || '').slice(-4)}`,
        userCode: u?.code || '',
        trafficSource: s.trafficSource || 'direct',
        deviceType: s.deviceType || 'mobile',
        browser: s.browser || '',
        currentView: s.lastView || s.landingView || 'home',
        lastSeenAt: s.lastSeenAt
      };
    }),
    recentClicks
  };
}

/**
 * P1 API 2: 7-Step Conversion Funnel (30s L1 cache on PG).
 */
async function getAnalyticsFunnel(rangeOrOpts = 30) {
  const opts = normalizeFilterOpts(rangeOrOpts);
  return withAdminCache(`funnel:${opts.range}:${opts.source}:${opts.device}`, () => _computeAnalyticsFunnel(opts));
}

async function _computeAnalyticsFunnel(opts) {
  const { start, end } = getDateWindow(opts);
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const sessParams = [start];
    let sessWhere = 'is_bot = FALSE AND last_seen_at >= $1';
    if (end) {
      sessParams.push(end);
      sessWhere += ` AND last_seen_at < $${sessParams.length}`;
    }
    if (opts.source) {
      sessParams.push(opts.source);
      sessWhere += ` AND traffic_source = $${sessParams.length}`;
    }
    if (opts.device) {
      sessParams.push(opts.device);
      sessWhere += ` AND device_type = $${sessParams.length}`;
    }
    const timeParams = end ? [start, end] : [start];
    const timeEndSql = end ? 'AND created_at < $2' : '';

    const [sessRes, evRes, clickRes, ordRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT visitor_id)::int AS visitors, COUNT(*)::int AS sessions
         FROM analytics_sessions WHERE ${sessWhere}`,
        sessParams
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE)::int AS valid_clicks
         FROM analytics_events WHERE created_at >= $1 ${timeEndSql}`,
        timeParams
      ),
      pool.query(`SELECT COUNT(*)::int AS affiliate_links FROM clicks WHERE created_at >= $1 ${timeEndSql}`, timeParams),
      pool.query(
        `SELECT
          COUNT(*)::int AS orders_created,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS orders_approved,
          COALESCE(SUM(user_cashback_amount) FILTER (WHERE status = 'approved'), 0)::bigint AS approved_cashback
        FROM orders WHERE created_at >= $1 ${timeEndSql}`,
        timeParams
      )
    ]);

    const s = sessRes.rows[0] || {};
    const e = evRes.rows[0] || {};
    const c = clickRes.rows[0] || {};
    const o = ordRes.rows[0] || {};

    return {
      range: opts.range,
      rangeDays: opts.rangeDays,
      steps: [
        { key: 'visitors', label: '1. Người truy cập (Unique)', value: s.visitors || 0 },
        { key: 'sessions', label: '2. Phiên truy cập', value: s.sessions || 0 },
        { key: 'valid_clicks', label: '3. Click sản phẩm hợp lệ', value: e.valid_clicks || 0 },
        { key: 'affiliate_links', label: '4. Link Affiliate đã tạo', value: c.affiliate_links || 0 },
        { key: 'orders_created', label: '5. Đơn hàng phát sinh (thực tế)', value: o.orders_created || 0 },
        { key: 'orders_approved', label: '6. Đơn duyệt Cashback', value: o.orders_approved || 0 }
      ],
      approvedCashback: Number(o.approved_cashback || 0)
    };
  }

  // Memory fallback
  const db = ensureDbLoaded();
  const startMs = start.getTime();
  const endMs = end ? end.getTime() : Infinity;
  const sessList = [...memSessions.values()].filter((s) => {
    const t = new Date(s.lastSeenAt).getTime();
    if (s.isBot || t < startMs || t >= endMs) return false;
    if (opts.source && s.trafficSource !== opts.source) return false;
    if (opts.device && s.deviceType !== opts.device) return false;
    return true;
  });
  const validClicks = [...memEvents.values()].filter((e) => {
    const t = new Date(e.createdAt).getTime();
    return (e.eventType === 'product_click' || e.eventType === 'affiliate_click') && e.isValid && t >= startMs && t < endMs;
  }).length;
  const affLinks = (db.clicks || []).filter((c) => {
    const t = new Date(c.createdAt || 0).getTime();
    return t >= startMs && t < endMs;
  }).length;
  const ords = (db.orders || []).filter((o) => {
    const t = new Date(o.createdAt || 0).getTime();
    return t >= startMs && t < endMs;
  });
  const approved = ords.filter((o) => o.status === 'approved');

  return {
    range: opts.range,
    rangeDays: opts.rangeDays,
    steps: [
      { key: 'visitors', label: '1. Người truy cập (Unique)', value: new Set(sessList.map((s) => s.visitorId)).size },
      { key: 'sessions', label: '2. Phiên truy cập', value: sessList.length },
      { key: 'valid_clicks', label: '3. Click sản phẩm hợp lệ', value: validClicks },
      { key: 'affiliate_links', label: '4. Link Affiliate đã tạo', value: affLinks },
      { key: 'orders_created', label: '5. Đơn hàng phát sinh (thực tế)', value: ords.length },
      { key: 'orders_approved', label: '6. Đơn duyệt Cashback', value: approved.length }
    ],
    approvedCashback: approved.reduce((acc, o) => acc + Number(o.userCashbackAmount || 0), 0)
  };
}

/**
 * P1 API 3: Daily Trend Series (Visitors & Valid Clicks per day in VN UTC+7).
 * Hybrid read (AN-05): Reads finalized historical days from `analytics_daily_rollups` (survives 90d raw prune)
 * and merges live raw tables for today (and any unrolled days). Cached 30s on PG.
 */
async function getAnalyticsDailyTrend(rangeDays = 7) {
  const days = Math.min(90, Math.max(1, Number(rangeDays) || 7));
  return withAdminCache(`trend:${days}`, () => _computeAnalyticsDailyTrend(days));
}

async function _computeAnalyticsDailyTrend(days = 7) {
  const cutoff = getCutoffDate(days);
  const vnOffset = 7 * 60 * 60 * 1000;
  const todayVn = new Date(Date.now() + vnOffset).toISOString().slice(0, 10);
  const startVn = new Date(Date.now() + vnOffset - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pool = getPgPool();

  if (pool) {
    await ensureAnalyticsSchema(pool);
    const [rollupRes, sessRes, clickRes] = await Promise.all([
      pool.query(
        `SELECT
          TO_CHAR(day_vn, 'YYYY-MM-DD') AS day_vn,
          visitors,
          sessions,
          page_views,
          valid_clicks
        FROM analytics_daily_rollups
        WHERE dimension_type = 'overview'
          AND dimension_key = 'all'
          AND day_vn >= $1::date
          AND day_vn < $2::date
        ORDER BY day_vn ASC`,
        [startVn, todayVn]
      ),
      pool.query(
        `SELECT
          TO_CHAR((last_seen_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day_vn,
          COUNT(DISTINCT visitor_id)::int AS visitors,
          COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE is_bot = FALSE AND last_seen_at >= $1
        GROUP BY 1
        ORDER BY 1 ASC`,
        [cutoff]
      ),
      pool.query(
        `SELECT
          TO_CHAR((created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS day_vn,
          COUNT(*) FILTER (WHERE event_type = 'page_view' AND is_valid = TRUE)::int AS page_views,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE)::int AS valid_clicks
        FROM analytics_events
        WHERE created_at >= $1
        GROUP BY 1
        ORDER BY 1 ASC`,
        [cutoff]
      )
    ]);

    const rawByDay = new Map();
    for (const r of sessRes.rows) {
      rawByDay.set(r.day_vn, { day: r.day_vn, visitors: r.visitors || 0, sessions: r.sessions || 0, pageViews: 0, clicks: 0 });
    }
    for (const r of clickRes.rows) {
      const cur = rawByDay.get(r.day_vn) || { day: r.day_vn, visitors: 0, sessions: 0, pageViews: 0, clicks: 0 };
      cur.pageViews = r.page_views || 0;
      cur.clicks = r.valid_clicks || 0;
      rawByDay.set(r.day_vn, cur);
    }

    const rollupByDay = new Map();
    for (const r of rollupRes.rows) {
      rollupByDay.set(r.day_vn, {
        day: r.day_vn,
        visitors: r.visitors || 0,
        sessions: r.sessions || 0,
        pageViews: r.page_views || 0,
        clicks: r.valid_clicks || 0
      });
    }

    // Fill missing days so chart is continuous; prefer rollup for past finalized days, live raw for today/unrolled
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() + vnOffset - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const entry =
        (key < todayVn ? rollupByDay.get(key) : null) ||
        rawByDay.get(key) || { day: key, visitors: 0, sessions: 0, pageViews: 0, clicks: 0 };
      series.push(entry);
    }
    return { rangeDays: days, series };
  }

  // Memory fallback (also supports hybrid rollup + raw for unit tests)
  const rawByDay = new Map();
  for (const s of memSessions.values()) {
    if (s.isBot) continue;
    const key = new Date(new Date(s.lastSeenAt).getTime() + vnOffset).toISOString().slice(0, 10);
    const cur = rawByDay.get(key) || { day: key, visitors: new Set(), sessions: 0, pageViews: 0, clicks: 0 };
    cur.visitors.add(s.visitorId);
    cur.sessions++;
    rawByDay.set(key, cur);
  }
  for (const e of memEvents.values()) {
    if (!e.isValid) continue;
    const key = new Date(new Date(e.createdAt).getTime() + vnOffset).toISOString().slice(0, 10);
    const cur = rawByDay.get(key) || { day: key, visitors: new Set(), sessions: 0, pageViews: 0, clicks: 0 };
    if (e.eventType === 'page_view') cur.pageViews++;
    if (e.eventType === 'product_click' || e.eventType === 'affiliate_click') cur.clicks++;
    rawByDay.set(key, cur);
  }

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() + vnOffset - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rolled = key < todayVn ? memDailyRollups.get(key) : null;
    if (rolled) {
      series.push({
        day: key,
        visitors: rolled.visitors,
        sessions: rolled.sessions,
        pageViews: rolled.pageViews,
        clicks: rolled.validClicks
      });
    } else {
      const row = rawByDay.get(key);
      series.push({
        day: key,
        visitors: row ? row.visitors.size : 0,
        sessions: row ? row.sessions : 0,
        pageViews: row ? row.pageViews : 0,
        clicks: row ? row.clicks : 0
      });
    }
  }
  return { rangeDays: days, series };
}

/**
 * Daily Rollup Job (AN-05): Populates ALL metrics (visitors, unique_users, sessions, page_views,
 * raw_clicks, valid_clicks, affiliate_clicks) so historical trends survive 90-day raw prune.
 */
async function rollupDailyAnalytics(daysBack = 3) {
  const safeDays = Math.min(90, Math.max(1, Number(daysBack) || 3));
  const pool = getPgPool();
  if (pool) {
    await ensureAnalyticsSchema(pool);
    const res = await pool.query(
      `WITH sess_daily AS (
        SELECT
          (last_seen_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day_vn,
          COUNT(DISTINCT visitor_id)::int AS visitors,
          COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS unique_users,
          COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE is_bot = FALSE AND last_seen_at >= NOW() - ($1::int || ' days')::interval
        GROUP BY 1
      ),
      ev_daily AS (
        SELECT
          (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day_vn,
          COUNT(*) FILTER (WHERE event_type = 'page_view' AND is_valid = TRUE)::int AS page_views,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click'))::int AS raw_clicks,
          COUNT(*) FILTER (WHERE event_type IN ('product_click', 'affiliate_click') AND is_valid = TRUE)::int AS valid_clicks,
          COUNT(*) FILTER (WHERE event_type = 'affiliate_click' AND is_valid = TRUE)::int AS affiliate_clicks
        FROM analytics_events
        WHERE created_at >= NOW() - ($1::int || ' days')::interval
        GROUP BY 1
      )
      INSERT INTO analytics_daily_rollups (
        day_vn, dimension_type, dimension_key,
        visitors, unique_users, sessions, page_views,
        raw_clicks, valid_clicks, affiliate_clicks, updated_at
      )
      SELECT
        COALESCE(s.day_vn, e.day_vn) AS day_vn,
        'overview' AS dimension_type,
        'all' AS dimension_key,
        COALESCE(s.visitors, 0)::int,
        COALESCE(s.unique_users, 0)::int,
        COALESCE(s.sessions, 0)::int,
        COALESCE(e.page_views, 0)::int,
        COALESCE(e.raw_clicks, 0)::int,
        COALESCE(e.valid_clicks, 0)::int,
        COALESCE(e.affiliate_clicks, 0)::int,
        NOW()
      FROM sess_daily s
      FULL OUTER JOIN ev_daily e ON e.day_vn = s.day_vn
      ON CONFLICT (day_vn, dimension_type, dimension_key) DO UPDATE SET
        visitors = EXCLUDED.visitors,
        unique_users = EXCLUDED.unique_users,
        sessions = EXCLUDED.sessions,
        page_views = EXCLUDED.page_views,
        raw_clicks = EXCLUDED.raw_clicks,
        valid_clicks = EXCLUDED.valid_clicks,
        affiliate_clicks = EXCLUDED.affiliate_clicks,
        updated_at = NOW()`,
      [safeDays]
    );
    clearAnalyticsCache();
    return { rolledUp: res.rowCount || 0 };
  }

  // Memory fallback rollup
  const vnOffset = 7 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;
  const byDay = new Map();
  const ensureDay = (key) => {
    if (!byDay.has(key)) {
      byDay.set(key, {
        visitors: new Set(),
        users: new Set(),
        sessions: 0,
        pageViews: 0,
        rawClicks: 0,
        validClicks: 0,
        affiliateClicks: 0
      });
    }
    return byDay.get(key);
  };

  for (const s of memSessions.values()) {
    if (s.isBot || new Date(s.lastSeenAt).getTime() < cutoffMs) continue;
    const key = new Date(new Date(s.lastSeenAt).getTime() + vnOffset).toISOString().slice(0, 10);
    const d = ensureDay(key);
    d.visitors.add(s.visitorId);
    if (s.userId) d.users.add(s.userId);
    d.sessions++;
  }
  for (const e of memEvents.values()) {
    if (new Date(e.createdAt).getTime() < cutoffMs) continue;
    const key = new Date(new Date(e.createdAt).getTime() + vnOffset).toISOString().slice(0, 10);
    const d = ensureDay(key);
    if (e.eventType === 'page_view' && e.isValid) d.pageViews++;
    if (e.eventType === 'product_click' || e.eventType === 'affiliate_click') {
      d.rawClicks++;
      if (e.isValid) {
        d.validClicks++;
        if (e.eventType === 'affiliate_click') d.affiliateClicks++;
      }
    }
  }

  for (const [dayKey, d] of byDay.entries()) {
    memDailyRollups.set(dayKey, {
      day: dayKey,
      visitors: d.visitors.size,
      uniqueUsers: d.users.size,
      sessions: d.sessions,
      pageViews: d.pageViews,
      rawClicks: d.rawClicks,
      validClicks: d.validClicks,
      affiliateClicks: d.affiliateClicks
    });
  }
  clearAnalyticsCache();
  return { rolledUp: byDay.size };
}

function escapeCsvCell(val) {
  let s = String(val ?? '').replace(/\r?\n/g, ' ');
  // Guard against CSV formula injection in Excel
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * P1 API 4: Safe UTF-8 BOM CSV Exporter for Members or Top Products.
 */
async function buildAnalyticsCsv({ type = 'members', rangeDays = 30, range = null, source = '', device = '' }) {
  if (type === 'products') {
    const data = await getAnalyticsTopProducts({ rangeDays, range, source, device, limit: 100 });
    const header = ['Product ID', 'Tên sản phẩm', 'Sàn', 'Valid Clicks', 'Raw Clicks', 'Người click', 'Kệ Deal', 'So sánh', 'Đơn khớp'];
    const lines = [header.join(',')];
    for (const p of data.items) {
      lines.push(
        [p.productId, p.productName, p.platform, p.validClicks, p.rawClicks, p.uniqueClickers, p.dealClicks, p.compareClicks, p.ordersCount]
          .map(escapeCsvCell)
          .join(',')
      );
    }
    return `\uFEFF${lines.join('\r\n')}`;
  }

  const data = await getAnalyticsMembers({ rangeDays, range, source, device, sortBy: 'clicks', limit: 200 });
  const header = ['Mã thành viên', 'Tên', 'SĐT', 'Nguồn gần nhất', 'Thiết bị', 'Tổng phiên', 'Tổng Click', 'Click Shopee', 'Click TikTok', 'Hoạt động gần nhất'];
  const lines = [header.join(',')];
  for (const m of data.items) {
    lines.push(
      [m.userCode, m.name, m.phone, m.lastSource, m.lastDevice, m.sessionsCount, m.totalClicks, m.shopeeClicks, m.tiktokClicks, m.lastSeenAt || '']
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

function clearMemoryAnalytics() {
  memSessions.clear();
  memEvents.clear();
  memDailyRollups.clear();
  recentClickDedup.clear();
  sessionBurstCounter.clear();
  adminReadCache.clear();
}

module.exports = {
  ANALYTICS_RETENTION_DAYS,
  classifyTrafficSource,
  parseUserAgentInfo,
  ingestAnalyticsBatch,
  recordServerAffiliateClick,
  getAnalyticsOverview,
  getAnalyticsMembers,
  getMemberActivityTimeline,
  getAnalyticsTopProducts,
  getAnalyticsRealtime,
  getAnalyticsFunnel,
  getAnalyticsDailyTrend,
  rollupDailyAnalytics,
  buildAnalyticsCsv,
  pruneOldAnalyticsRecords,
  clearAnalyticsCache,
  withAdminCache,
  clearMemoryAnalytics
};
