/**
 * LiLa First-Party Analytics Tracker (P0/Stage 1 — Lightweight, Zero Dependencies, CSP-Safe).
 * - Pseudonymous visitor_id (localStorage) + 30m sliding multi-tab session_id (localStorage)
 * - Captures UTM, ?ref= share links, document.referrer & PWA mode
 * - Fast initial flush (300ms) for accurate traffic_source + 5s / 10-event batching via keepalive fetch
 * - Excludes admin views & deduplicates rapid boot page_view duplicates
 */
(() => {
  const VISITOR_KEY = 'lila_an_vid_v1';
  const SESSION_KEY = 'lila_an_sid_v1';
  const SESSION_TS_KEY = 'lila_an_sts_v1';
  const SESSION_META_KEY = 'lila_an_smeta_v1';
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const INITIAL_FLUSH_MS = 300;
  const FLUSH_INTERVAL_MS = 5000;
  const MAX_BATCH_SIZE = 10;
  const VIEW_DEDUP_MS = 2000;

  let hasFlushedOnce = false;
  let lastTrackedView = '';
  let lastTrackedViewAt = 0;

  function genId(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function safeStorageGet(store, key) {
    try { return store.getItem(key) || ''; } catch { return ''; }
  }

  function safeStorageSet(store, key, val) {
    try { store.setItem(key, val); } catch { /* ignore quota */ }
  }

  function getVisitorId() {
    let vid = safeStorageGet(localStorage, VISITOR_KEY);
    if (!vid) {
      vid = genId('v');
      safeStorageSet(localStorage, VISITOR_KEY, vid);
    }
    return vid;
  }

  function extractLandingMeta() {
    const params = new URLSearchParams(window.location.search || '');
    let referrerHost = '';
    try {
      if (document.referrer) {
        referrerHost = new URL(document.referrer).hostname.toLowerCase();
      }
    } catch { /* ignore */ }

    const isPwa =
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      window.navigator?.standalone === true;

    return {
      referrerHost,
      utmSource: (params.get('utm_source') || '').trim().slice(0, 60),
      utmMedium: (params.get('utm_medium') || '').trim().slice(0, 60),
      utmCampaign: (params.get('utm_campaign') || '').trim().slice(0, 80),
      refCode: (params.get('ref') || '').trim().slice(0, 40),
      isPwa: Boolean(isPwa)
    };
  }

  function getOrCreateSession() {
    const now = Date.now();
    // AN-04: Use localStorage with 30m sliding timeout so multiple tabs share 1 session
    let sid = safeStorageGet(localStorage, SESSION_KEY);
    const lastTs = Number(safeStorageGet(localStorage, SESSION_TS_KEY) || 0);
    let meta = null;

    try {
      const rawMeta = safeStorageGet(localStorage, SESSION_META_KEY);
      if (rawMeta) meta = JSON.parse(rawMeta);
    } catch { meta = null; }

    const freshMeta = extractLandingMeta();
    const utmChanged = Boolean(freshMeta.utmSource && meta && freshMeta.utmSource !== meta.utmSource);

    if (!sid || !lastTs || now - lastTs > SESSION_TIMEOUT_MS || utmChanged) {
      sid = genId('s');
      meta = freshMeta;
      safeStorageSet(localStorage, SESSION_KEY, sid);
      safeStorageSet(localStorage, SESSION_META_KEY, JSON.stringify(meta));
    } else if (!meta) {
      meta = freshMeta;
      safeStorageSet(localStorage, SESSION_META_KEY, JSON.stringify(meta));
    }

    safeStorageSet(localStorage, SESSION_TS_KEY, String(now));
    return {
      sessionId: sid,
      visitorId: getVisitorId(),
      ...meta
    };
  }

  const queue = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    // AN-01: Flush initial landing event quickly (300ms) so real traffic_source lands before fast clicks
    const delay = hasFlushedOnce ? FLUSH_INTERVAL_MS : INITIAL_FLUSH_MS;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush(false);
    }, delay);
  }

  function flush(useKeepalive = false) {
    if (!queue.length) return;
    hasFlushedOnce = true;
    const batch = queue.splice(0, 20);
    const sess = getOrCreateSession();

    try {
      void fetch('/api/analytics/collect', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: Boolean(useKeepalive),
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({ session: sess, events: batch })
      }).catch(() => {});
    } catch { /* non-fatal */ }
  }

  function trackEvent(eventType, payload = {}) {
    if (!eventType) return;
    getOrCreateSession();
    queue.push({
      eventId: genId('e'),
      eventType,
      viewName: payload.viewName || null,
      platform: payload.platform || null,
      productId: payload.productId || null,
      productName: payload.productName || null,
      productCategory: payload.productCategory || null,
      sourceSurface: payload.sourceSurface || null,
      dealGroup: payload.dealGroup || null,
      clickId: payload.clickId || null
    });
    if (queue.length >= MAX_BATCH_SIZE) {
      flush(false);
    } else {
      scheduleFlush();
    }
  }

  function trackPageView(viewName = 'home') {
    const cleanView = String(viewName || 'home').trim() || 'home';
    // AN-02: Never track admin dashboard views
    if (cleanView === 'admin') return;
    // AN-02: Deduplicate double-fired boot/navigation views within 2s
    const now = Date.now();
    if (cleanView === lastTrackedView && now - lastTrackedViewAt < VIEW_DEDUP_MS) {
      return;
    }
    lastTrackedView = cleanView;
    lastTrackedViewAt = now;
    trackEvent('page_view', { viewName: cleanView });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush(true);
    }
  });
  window.addEventListener('pagehide', () => flush(true));

  window.lilaAnalytics = {
    getSessionId: () => getOrCreateSession().sessionId,
    getVisitorId: () => getVisitorId(),
    trackEvent,
    trackPageView,
    flush
  };

  // Track initial landing page view (skip if landing directly on #admin)
  const initialHash = String(window.location.hash || '').replace(/^#/, '').trim();
  if (initialHash !== 'admin') {
    trackPageView(initialHash || 'home');
  }
})();
