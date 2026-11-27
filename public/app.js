// Safe storage helper with try/catch to protect against private browsing restrictions
const safeStorage = {
  get(key, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  set(key, val, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
      if (storage) storage.setItem(key, String(val));
      return true;
    } catch {
      return false;
    }
  },
  remove(key, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
      if (storage) storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
};

const TOKEN_KEY = 'hoantienshop_token_v1';
const USER_KEY = 'hoantienshop_user_v1';

// Purge any legacy token from localStorage; auth now uses HttpOnly cookie (hts_auth)
safeStorage.remove(TOKEN_KEY);

let currentUser = null;
const savedUser = safeStorage.get(USER_KEY);
if (savedUser) {
  try {
    currentUser = JSON.parse(savedUser);
  } catch {}
}
let authToken = currentUser ? 'httponly_cookie_session' : '';

// Helper with guard for safe event listener attachment
const on = (idOrEl, ev, fn) => {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  el?.addEventListener(ev, fn);
  return el;
};

// Helper for numeric input values that avoids treating 0 as falsy or forcing fallbacks on empty/0 inputs
function numOr(val, fallback) {
  if (val === undefined || val === null) return fallback;
  const s = typeof val === 'string' ? val.trim() : val;
  if (s === '') {
    return typeof fallback === 'number' ? fallback : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

let publicConfig = {
  siteName: 'LiLa',
  cashbackPercent: 70,
  taxDeductPercent: 10,
  referralBountyAmount: 10000,
  minWithdrawAmount: 50000,
  zaloGroupUrl: 'https://zalo.me/g/cl2cmiseoqienusnrbyr',
  zaloWidgetEnabled: true
};

// Capture ?ref=... referral code from URL if present
try {
  const urlParams = new URLSearchParams(window.location.search);
  const urlRefCode = urlParams.get('ref');
  if (urlRefCode) {
    const cleanRef = urlRefCode.trim().toUpperCase();
    safeStorage.set('hoantienshop_ref', cleanRef, sessionStorage);
    safeStorage.set('saved_ref_code', cleanRef, localStorage);
  }
} catch {}

function fmtVnd(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpsUrl(rawUrl, raw = false) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return '';
    return raw ? u.toString() : escapeHtml(u.toString());
  } catch {
    return '';
  }
}

function safeAppOrWebUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (['https:', 'http:', 'shopee:', 'snssdk1180:'].includes(u.protocol)) {
      return escapeHtml(s);
    }
    return '';
  } catch {
    if (s.startsWith('https://') || s.startsWith('shopee://') || s.startsWith('snssdk1180://')) {
      return escapeHtml(s);
    }
    return '';
  }
}

const UI_ICONS = {
  eye: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  checkCircle: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alertCircle: '<svg class="svg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  infoCircle: '<svg class="svg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  alertTriangle: '<svg class="svg-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  clock: '<svg class="svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  loader: '<svg class="svg-icon svg-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  sparkles: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>',
  shoppingBagLg: '<svg class="svg-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  shoppingCart: '<svg class="svg-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
  link: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  copy: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  refresh: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
  landmark: '<svg class="svg-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>',
  shareIos: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
  plusSquare: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  smartphone: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
  confirmAlert: '<svg class="svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  confirmCheck: '<svg class="svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  lock: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock: '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  trophy: '<svg class="svg-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
  award: '<svg class="svg-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>'
};

function renderVipBadgeSvg(tierCodeOrIcon, onDark = false) {
  const key = String(tierCodeOrIcon || '').toLowerCase();
  // Diamond — faceted duotone gem
  if (key.includes('diamond') || key.includes('kim') || key.includes('💎')) {
    const stroke = onDark ? '#93c5fd' : '#2563eb';
    const fill = onDark ? 'rgba(147,197,253,0.28)' : 'rgba(37,99,235,0.16)';
    return `<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M6.5 4h11L21 9.5 12 20 3 9.5 6.5 4Z" fill="${fill}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/><path d="M3 9.5h18M8.5 9.5 12 20l3.5-10.5M8.5 9.5 12 4l3.5 5.5" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
  // Gold — modern duotone crown
  if (key.includes('gold') || key.includes('vàng') || key.includes('🥇')) {
    const stroke = onDark ? '#fde047' : '#d97706';
    const fill = onDark ? 'rgba(253,224,71,0.28)' : 'rgba(245,158,11,0.2)';
    return `<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M3.5 17.5 5 8l4.5 3.5L12 6l2.5 5.5L19 8l1.5 9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" fill="${fill}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/></svg>`;
  }
  // Silver — modern duotone star shield
  if (key.includes('silver') || key.includes('bạc') || key.includes('🥈')) {
    const stroke = onDark ? '#e2e8f0' : '#475569';
    const fill = onDark ? 'rgba(226,232,240,0.24)' : 'rgba(100,116,139,0.16)';
    return `<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M12 3 19 6v5.5c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8V6l7-3Z" fill="${fill}" stroke="${stroke}" stroke-width="1.9" stroke-linejoin="round"/><path d="m12 8.2 1.1 2.2 2.4.35-1.75 1.7.42 2.4L12 13.7l-2.17 1.15.42-2.4-1.75-1.7 2.4-.35L12 8.2Z" fill="${stroke}"/></svg>`;
  }
  // Bronze — modern duotone rosette medal
  const stroke = onDark ? '#fdba74' : '#b45309';
  const fill = onDark ? 'rgba(253,186,116,0.24)' : 'rgba(217,119,6,0.16)';
  return `<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><circle cx="12" cy="9.5" r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="1.9"/><path d="m8.8 14.3-1.3 6.2 4.5-2.2 4.5 2.2-1.3-6.2" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const STATUS_CLASS_MAP = {
  pending: 'st-pending',
  approved: 'st-approved',
  paid: 'st-paid',
  cancelled: 'st-cancelled',
  rejected: 'st-rejected'
};

function getStatusClass(status) {
  return STATUS_CLASS_MAP[String(status).toLowerCase()] || 'st-pending';
}

function showToast(msg, type = 'auto') {
  const t = document.getElementById('toast');
  if (!t) return;
  const text = String(msg || '');
  let resolvedType = type;
  if (resolvedType === 'auto') {
    if (/lỗi|không thể|vui lòng|chưa đủ|tối thiểu|hết hạn|từ chối|vượt quá|trống|sai|không hợp lệ|thất bại|cần đăng nhập|đã bị khóa/i.test(text)) {
      resolvedType = 'error';
    } else if (/đang tải|đang cài|đã đăng xuất|đã hủy thao tác/i.test(text)) {
      resolvedType = 'info';
    } else {
      resolvedType = 'success';
    }
  }
  const iconSvg =
    resolvedType === 'error'
      ? UI_ICONS.alertCircle
      : resolvedType === 'info'
      ? UI_ICONS.infoCircle
      : UI_ICONS.checkCircle;

  t.classList.remove('toast-success', 'toast-error', 'toast-info', 'hidden');
  t.classList.add(`toast-${resolvedType}`);
  t.innerHTML = `<span class="toast-icon" aria-hidden="true">${iconSvg}</span><span class="toast-text">${escapeHtml(text)}</span>`;
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.setAttribute('aria-atomic', 'true');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function copyText(text, msg = 'Đã sao chép thành công!') {
  if (!text) return;
  let copied = false;
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {}
  }
  if (!copied) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {}
  }
  if (copied) {
    showToast(msg);
  } else {
    showToast('Không thể tự động sao chép. Vui lòng sao chép thủ công!');
  }
}

function showConnectionNotice(message) {
  let notice = document.getElementById('connectionNotice');
  if (!notice) {
    notice = document.createElement('aside');
    notice.id = 'connectionNotice';
    notice.className = 'connection-notice';
    notice.setAttribute('role', 'alert');
    const text = document.createElement('span');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Tải lại trang';
    retry.addEventListener('click', () => window.location.reload());
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Đóng';
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(text, retry, dismiss);
    document.body.prepend(notice);
  }
  notice.firstChild.textContent = message;
}

let refreshInFlight = null;

async function refreshAuthSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: '{}'
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data && data.user) {
        authToken = 'httponly_cookie_session';
        currentUser = data.user;
        safeStorage.set(
          USER_KEY,
          JSON.stringify({
            code: data.user.code,
            name: data.user.name,
            role: data.user.role
          })
        );
        syncAuthUi();
        return data.user;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {})
  };

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25000);

  let signal;
  if (options.signal) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([controller.signal, options.signal]);
    } else {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      signal = controller.signal;
    }
  } else {
    signal = controller.signal;
  }

  try {
    const res = await fetch(url, {
      ...options,
      signal,
      headers,
      credentials: 'same-origin'
    });
    const data = await res.json().catch((err) => {
      if (err.name === 'AbortError' || timedOut) throw err;
      return {};
    });
    if (res.status === 401 && !url.includes('/api/auth/') && !options._retriedAfterRefresh) {
      const refreshedUser = await refreshAuthSession();
      if (refreshedUser) {
        clearTimeout(timeoutId);
        return apiFetch(url, { ...options, _retriedAfterRefresh: true });
      }
      if (authToken) {
        await clearSession({ skipLogoutApi: true });
      }
    } else if (res.status === 401 && authToken && !url.includes('/api/auth/')) {
      await clearSession({ skipLogoutApi: true });
    }
    if (!res.ok) {
      if (res.status >= 500) {
        showConnectionNotice('Máy chủ đang gặp lỗi. Vui lòng thử lại sau vài phút.');
      }
      throw new Error(data.error || `Lỗi kết nối (${res.status})`);
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' || timedOut) {
      // If caller intentionally aborted via signal, preserve AbortError without masking as timeout
      if (options.signal?.aborted && !timedOut) {
        throw err;
      }
      const message = 'Kết nối quá lâu. Hãy kiểm tra Wi-Fi/4G/5G rồi tải lại trang. Nếu vừa gửi yêu cầu, hãy kiểm tra kết quả trước khi gửi lại.';
      showConnectionNotice(message);
      throw new Error(message);
    }
    if (err instanceof TypeError || String(err.message).includes('Failed to fetch')) {
      const message = navigator.onLine === false
        ? 'Thiết bị đang mất mạng. Hãy bật Wi-Fi hoặc 4G/5G, tắt chế độ máy bay rồi tải lại trang.'
        : 'Không thể kết nối đến máy chủ. Hãy thử đổi Wi-Fi/4G/5G hoặc thử lại sau vài phút.';
      showConnectionNotice(message);
      throw new Error(message);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Lazy-load Admin CSS & JS bundles only when an Admin session is active
let adminAssetsPromise = null;

function ensureAdminAssetsLoaded() {
  if (typeof document === 'undefined' || !document.head) return Promise.resolve();
  if (adminAssetsPromise) return adminAssetsPromise;

  const loadStyle = (href) =>
    new Promise((resolve) => {
      if (document.querySelector(`link[href="${href}"]`)) return resolve();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });

  const loadScript = (src) =>
    new Promise((resolve) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });

  adminAssetsPromise = Promise.all([
    loadStyle('/adminMobile.css?v=2'),
    loadScript('/csvImport.js?v=2.3.3'),
    loadScript('/tiktokReply.js?v=2'),
    loadScript('/adminMobile.js?v=3')
  ]).then(() => true);

  return adminAssetsPromise;
}

// Track latest seen order/wallet watermarks for mobile bottom-nav notification dots
let latestUserActivitySnapshot = null;

function syncUserActivityNotifications(data) {
  if (!currentUser?.id || !data) return;
  const uid = currentUser.id;
  const ordTotal = Number(data.orderStatusCounts?.all ?? data.ordersPagination?.total ?? 0);
  const ordApproved = Number(data.orderStatusCounts?.approved ?? 0);
  const ledTotal = Number(data.ledgerPagination?.total ?? (data.ledger || []).length);
  const balAvail = Number(currentUser.balanceAvailable || 0);

  latestUserActivitySnapshot = { ordTotal, ordApproved, ledTotal, balAvail };

  const ordKey = `hts_seen_orders_${uid}`;
  const walKey = `hts_seen_wallet_${uid}`;
  const isViewingOrders = document.getElementById('view-orders')?.classList.contains('active');
  const isViewingWallet = document.getElementById('view-wallet')?.classList.contains('active');

  let seenOrders = null;
  let seenWallet = null;
  try {
    const rawOrd = safeStorage.get(ordKey);
    if (rawOrd) seenOrders = JSON.parse(rawOrd);
    const rawWal = safeStorage.get(walKey);
    if (rawWal) seenWallet = JSON.parse(rawWal);
  } catch {}

  const ordDot = document.getElementById('mobileOrdersNotifyDot');
  if (!seenOrders || isViewingOrders) {
    safeStorage.set(ordKey, JSON.stringify({ ordTotal, ordApproved }));
    ordDot?.classList.add('hidden');
  } else {
    const hasNewApproved = ordApproved > Number(seenOrders.ordApproved || 0);
    const hasNewOrders = ordTotal > Number(seenOrders.ordTotal || 0) || hasNewApproved;
    ordDot?.classList.toggle('hidden', !hasNewOrders);
    if (hasNewOrders && typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      const shibaNotifySig = `${uid}:${ordTotal}:${ordApproved}`;
      if (window.__lilaLastShibaOrderSig !== shibaNotifySig) {
        window.__lilaLastShibaOrderSig = shibaNotifySig;
        window.dispatchEvent(new CustomEvent(hasNewApproved ? 'lila:cashback-confirmed' : 'lila:order-update'));
      }
    }
  }

  const walDot = document.getElementById('mobileWalletNotifyDot');
  if (!seenWallet || isViewingWallet) {
    safeStorage.set(walKey, JSON.stringify({ ledTotal, balAvail }));
    walDot?.classList.add('hidden');
  } else {
    const hasNewWallet = ledTotal > Number(seenWallet.ledTotal || 0) || balAvail > Number(seenWallet.balAvail || 0);
    walDot?.classList.toggle('hidden', !hasNewWallet);
  }
}

function markViewActivitySeen(viewName) {
  if (!currentUser?.id || !latestUserActivitySnapshot) return;
  const uid = currentUser.id;
  const { ordTotal, ordApproved, ledTotal, balAvail } = latestUserActivitySnapshot;
  if (viewName === 'orders') {
    safeStorage.set(`hts_seen_orders_${uid}`, JSON.stringify({ ordTotal, ordApproved }));
    document.getElementById('mobileOrdersNotifyDot')?.classList.add('hidden');
  } else if (viewName === 'wallet') {
    safeStorage.set(`hts_seen_wallet_${uid}`, JSON.stringify({ ledTotal, balAvail }));
    document.getElementById('mobileWalletNotifyDot')?.classList.add('hidden');
  }
}

function closeAllAppSheets() {
  if (typeof closeOrderDetailSheet === 'function') closeOrderDetailSheet();
  if (typeof setReferralSheetOpen === 'function') setReferralSheetOpen(false);
  if (typeof setWithdrawSheetOpen === 'function') setWithdrawSheetOpen(false);
  document.body?.classList?.remove('sheet-lock');
}

// Navigation & History API
function switchView(viewName, updateHistory = true, options = {}) {
  closeAllAppSheets();
  let targetView = viewName;
  if (targetView === 'faq') {
    targetView = 'guide';
  }

  // Admin navigation guard: only authorized admin can activate view-admin
  if (targetView === 'admin') {
    if (!currentUser || currentUser.role !== 'admin') {
      showToast('Bạn không có quyền truy cập trang Quản trị.');
      switchView('home', true);
      return;
    }
  }

  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${targetView}`);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const navVal = btn.getAttribute('data-nav');
    btn.classList.toggle('active', navVal === targetView || (targetView === 'guide' && navVal === 'faq'));
  });

  if (updateHistory) {
    try {
      history.pushState({ view: targetView }, '', `#${targetView}`);
    } catch {}
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      try {
        window.scrollTo({ top: 0, behavior: 'auto' });
      } catch {}
    }
  }

  if (['wallet', 'orders'].includes(targetView)) {
    markViewActivitySeen(targetView);
  }
  if (['wallet', 'orders', 'account'].includes(targetView) && authToken && !options.skipReload) {
    loadUserDashboard();
  }
  if (targetView === 'admin' && authToken && currentUser?.role === 'admin' && !options.skipReload) {
    loadAdminDashboard();
  }
  if (targetView === 'leaderboard') {
    loadPublicLeaderboard();
  }
}

window.addEventListener('popstate', (e) => {
  const v = e.state?.view || window.location.hash.replace('#', '') || 'home';
  switchView(v, false);
});

// Event delegation for clicks across the app
document.body.addEventListener('click', (e) => {
  const navEl = e.target.closest('[data-nav]');
  if (navEl) {
    e.preventDefault();
    switchView(navEl.getAttribute('data-nav'));
    return;
  }

  const hbTabBtn = e.target.closest('[data-hb-tab]');
  if (hbTabBtn) {
    const tab = hbTabBtn.getAttribute('data-hb-tab');
    document.querySelectorAll('.hb-tab').forEach((btn) => {
      const isActive = btn.getAttribute('data-hb-tab') === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.hb-panel').forEach((panel) => {
      const isMatch = panel.id === `hb-panel-${tab}`;
      panel.classList.toggle('active', isMatch);
      panel.classList.toggle('hidden', !isMatch);
    });
    return;
  }

  const walletTabBtn = e.target.closest('[data-wallet-tab]');
  if (walletTabBtn) {
    const tab = walletTabBtn.getAttribute('data-wallet-tab');
    document.querySelectorAll('[data-wallet-tab]').forEach((btn) => {
      const isActive = btn.getAttribute('data-wallet-tab') === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.getElementById('walletTabWithdrawals')?.classList.toggle('hidden', tab !== 'withdrawals');
    document.getElementById('walletTabLedger')?.classList.toggle('hidden', tab !== 'ledger');
    return;
  }

  const orderStatusBtn = e.target.closest('[data-order-status]');
  if (orderStatusBtn) {
    activeOrderStatusFilter = orderStatusBtn.getAttribute('data-order-status') || 'all';
    document.querySelectorAll('[data-order-status]').forEach((btn) => {
      const isActive = btn.getAttribute('data-order-status') === activeOrderStatusFilter;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    if (authToken) {
      userOrdersPage = 1;
      loadUserOrdersPage(1);
    } else {
      renderUserOrdersTable(userOrdersCache);
    }
    return;
  }

  const orderPlatBtn = e.target.closest('[data-order-platform]');
  if (orderPlatBtn) {
    activeOrderPlatformFilter = orderPlatBtn.getAttribute('data-order-platform') || 'all';
    document.querySelectorAll('[data-order-platform]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-order-platform') === activeOrderPlatformFilter);
    });
    if (authToken) {
      userOrdersPage = 1;
      loadUserOrdersPage(1);
    } else {
      renderUserOrdersTable(userOrdersCache);
    }
    return;
  }

  const copyOrdSnBtn = e.target.closest('[data-copy-order-sn]');
  if (copyOrdSnBtn) {
    e.stopPropagation();
    const sn = copyOrdSnBtn.getAttribute('data-copy-order-sn') || '';
    if (sn) {
      copyText(sn, `Đã sao chép mã đơn #${sn}`);
    }
    return;
  }

  if (e.target.closest('#resetOrderFiltersBtn')) {
    resetUserOrderFilters();
    return;
  }

  if (e.target.closest('#retryOrdersLoadBtn')) {
    loadUserOrdersPage(userOrdersPage || 1);
    return;
  }

  if (e.target.closest('#closeOrderDetailSheetBtn') || e.target === document.getElementById('orderDetailSheetOverlay')) {
    closeOrderDetailSheet();
    return;
  }

  const detailNavBtn = e.target.closest('#orderDetailSheetOverlay [data-nav]');
  if (detailNavBtn) {
    closeOrderDetailSheet();
    // let the normal [data-nav] handler switch views right below
  }

  const detailRow = e.target.closest('[data-order-detail-id]');
  if (detailRow) {
    openOrderDetailSheet(detailRow.getAttribute('data-order-detail-id'));
    return;
  }

  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const copyMsg = copyBtn.getAttribute('data-copy-msg') || 'Đã sao chép thành công!';
    copyText(copyBtn.getAttribute('data-copy'), copyMsg);
    return;
  }

  const openAuthEl = e.target.closest('[data-open-auth]');
  if (openAuthEl) {
    openAuthModal(openAuthEl.getAttribute('data-open-auth') || 'login');
    return;
  }

  // Click on affiliate single input auto-selects text without inline onclick
  const affInput = e.target.closest('.aff-single-input');
  if (affInput) {
    affInput.select();
    return;
  }

  const qrBtn = e.target.closest('[data-vietqr]');
  if (qrBtn) {
    const rawImgUrl = qrBtn.getAttribute('data-vietqr') || '';
    const info = qrBtn.getAttribute('data-vietqr-info') || '';
    // Use raw unescaped URL with literal '&' for direct element.src property assignment
    const cleanImgUrl = rawImgUrl.replace(/&amp;/g, '&');
    const safeQr = safeHttpsUrl(cleanImgUrl, true);
    if (
      safeQr &&
      (safeQr.startsWith('https://img.vietqr.io/') || safeQr.startsWith('https://api.vietqr.io/'))
    ) {
      const modalImg = document.getElementById('vietQrModalImg');
      const modalInfo = document.getElementById('vietQrModalInfo');
      const modal = document.getElementById('vietQrModal');
      if (modalImg) modalImg.src = safeQr;
      if (modalInfo) modalInfo.textContent = info;
      modal?.classList.remove('hidden');
    } else {
      showToast('Đường dẫn VietQR không hợp lệ.');
    }
  }
});

on('closeVietQrModalBtn', 'click', () => {
  document.getElementById('vietQrModal')?.classList.add('hidden');
});

// Modal close on backdrop click & Escape key
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      backdrop.classList.add('hidden');
    }
  });
});

// Modal a11y: Escape to close topmost dialog & Tab / Shift+Tab focus trap cycling
window.addEventListener('keydown', (e) => {
  const openModal =
    document.querySelector('#confirmActionModal:not(.hidden)') ||
    document.querySelector('.modal-backdrop:not(.hidden)');
  if (!openModal) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (openModal.id === 'confirmActionModal') {
      document.getElementById('confirmModalCancelBtn')?.click();
    } else {
      openModal.classList.add('hidden');
    }
    return;
  }

  if (e.key === 'Tab') {
    const focusableSelectors =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(openModal.querySelectorAll(focusableSelectors)).filter(
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
    );

    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }

    const firstEl = focusables[0];
    const lastEl = focusables[focusables.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === firstEl || !openModal.contains(document.activeElement)) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl || !openModal.contains(document.activeElement)) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  }
});

let isBalanceHidden = safeStorage.get('hts_hide_balance') === '1';

function updateBalancePrivacyDisplay() {
  const maskText = '••••••đ';
  const avail = currentUser ? fmtVnd(currentUser.balanceAvailable) : '0đ';
  const pend = currentUser ? fmtVnd(currentUser.balancePending) : '0đ';
  const earned = currentUser ? fmtVnd(currentUser.totalEarned) : '0đ';
  const withdrawn = currentUser ? fmtVnd(currentUser.totalWithdrawn) : '0đ';

  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };

  setTxt('headerUserBalance', isBalanceHidden ? '••••đ' : avail);
  setTxt('statAvailable', isBalanceHidden ? maskText : avail);
  setTxt('statPending', isBalanceHidden ? maskText : pend);
  setTxt('statTotalEarned', isBalanceHidden ? maskText : earned);
  setTxt('statWithdrawn', isBalanceHidden ? maskText : withdrawn);
  setTxt('userOrdSummaryPending', isBalanceHidden ? maskText : pend);
  setTxt('userOrdSummaryApproved', isBalanceHidden ? maskText : earned);

  const privacyBtn = document.getElementById('toggleBalancePrivacyBtn');
  if (privacyBtn) {
    privacyBtn.innerHTML = isBalanceHidden
      ? `${UI_ICONS.eye}<span>Hiện số dư</span>`
      : `${UI_ICONS.eyeOff}<span>Ẩn số dư</span>`;
    privacyBtn.setAttribute('aria-pressed', isBalanceHidden ? 'true' : 'false');
  }
}

function updateWithdrawProgressBar() {
  const barBox = document.getElementById('withdrawThresholdBar');
  const textEl = document.getElementById('withdrawProgressText');
  const pctEl = document.getElementById('withdrawProgressPercent');
  const fillEl = document.getElementById('withdrawProgressFill');
  if (!barBox || !textEl || !pctEl || !fillEl) return;

  const minAmount = numOr(publicConfig.minWithdrawAmount, 50000);
  const available = Number(currentUser?.balanceAvailable || 0);
  const pct = minAmount > 0 ? Math.min(100, Math.max(0, Math.round((available / minAmount) * 100))) : 100;

  fillEl.style.width = `${pct}%`;
  pctEl.textContent = `${pct}%`;

  if (available >= minAmount) {
    barBox.classList.add('eligible');
    textEl.innerHTML = `<span class="inline-icon-row">${UI_ICONS.checkCircle}<span>Bạn đã đủ điều kiện rút tiền ngay!</span></span>`;
  } else {
    barBox.classList.remove('eligible');
    const remaining = Math.max(0, minAmount - available);
    textEl.textContent = `Cần thêm ${fmtVnd(remaining)} để đạt hạn mức tối thiểu (${fmtVnd(minAmount)})`;
  }
}

const walletPayoutState = { lastBank: '' };
const accountPayoutState = { lastBank: '' };

function isInAppWebView() {
  if (typeof navigator === 'undefined' || !navigator.userAgent) return false;
  return /\b(Zalo|FBAN|FBAV|FB_IAB|Instagram|Line|MicroMessenger|BytedanceWebview|musical_ly|TikTok)\b/i.test(
    navigator.userAgent
  );
}

function syncPayoutMethodFields({
  methodSelectId,
  bankGroupId,
  bankSelectId,
  accLabelId,
  accInputId,
  ownerLabelId,
  stateObj,
  preferredMethod = null
}) {
  const methodEl = document.getElementById(methodSelectId);
  const bankGroupEl = document.getElementById(bankGroupId);
  const bankSelectEl = document.getElementById(bankSelectId);
  const accLabelEl = document.getElementById(accLabelId);
  const accInputEl = document.getElementById(accInputId);
  const ownerLabelEl = document.getElementById(ownerLabelId);
  if (!methodEl || !bankSelectEl) return;

  if (preferredMethod === 'momo' || preferredMethod === 'bank') {
    methodEl.value = preferredMethod;
  }

  const isMomo = methodEl.value === 'momo';
  if (isMomo) {
    if (bankSelectEl.value && bankSelectEl.value !== 'MoMo') {
      stateObj.lastBank = bankSelectEl.value;
    }
    bankSelectEl.value = 'MoMo';
    bankGroupEl?.classList.add('hidden');
    if (accLabelEl) accLabelEl.textContent = 'Số điện thoại ví MoMo';
    if (accInputEl) accInputEl.placeholder = 'Nhập SĐT đăng ký ví MoMo (VD: 0912345678)...';
    if (ownerLabelEl) ownerLabelEl.textContent = 'Họ tên chủ ví MoMo (Không dấu)';
  } else {
    bankGroupEl?.classList.remove('hidden');
    if (bankSelectEl.value === 'MoMo') {
      bankSelectEl.value = stateObj.lastBank && stateObj.lastBank !== 'MoMo' ? stateObj.lastBank : '';
    }
    if (accLabelEl) accLabelEl.textContent = 'Số tài khoản ngân hàng';
    if (accInputEl) accInputEl.placeholder = 'Nhập chính xác số tài khoản ngân hàng...';
    if (ownerLabelEl) ownerLabelEl.textContent = 'Tên chủ tài khoản (Không dấu)';
  }
}

function syncAccountBankPasswordRequirement() {
  const savedAcc = String(currentUser?.bankAccount || '').replace(/\s+/g, '');
  const savedBank = String(currentUser?.bankName || '').trim();
  const savedEmail = String(currentUser?.email || '').trim().toLowerCase();
  const newAcc = String(document.getElementById('accBankAccount')?.value || '').replace(/\s+/g, '');
  const newBank = String(document.getElementById('accBankName')?.value || '').trim();
  const newEmail = String(document.getElementById('accProfileEmail')?.value || '').trim().toLowerCase();
  const isBankEdited = Boolean(newAcc || newBank);
  const isEmailChanged = document.getElementById('accProfileEmail') && newEmail !== savedEmail;
  const required =
    Boolean(isEmailChanged) ||
    (isBankEdited &&
      ((newAcc && newAcc !== savedAcc) || (newBank && newBank !== savedBank)));
  const pwdGroup = document.getElementById('accBankPasswordGroup');
  const pwdInput = document.getElementById('accBankCurrentPassword');
  pwdGroup?.classList.toggle('hidden', !required);
  if (pwdInput) pwdInput.required = required;
  return required;
}

function isSafeAvatarUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed.startsWith('/api/avatars/') || trimmed.startsWith('https://');
}

function renderAvatarEl(el, avatarUrl, fallbackInitial, altText = 'Ảnh đại diện') {
  if (!el) return;
  const safeInitial = String(fallbackInitial || 'U').trim().charAt(0).toUpperCase() || 'U';
  if (isSafeAvatarUrl(avatarUrl)) {
    const existingImg = el.querySelector('img');
    if (existingImg && existingImg.getAttribute('src') === avatarUrl) return;
    el.textContent = '';
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = altText;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => {
      el.textContent = safeInitial;
    };
    el.appendChild(img);
  } else {
    el.textContent = safeInitial;
  }
}

function syncUserAvatarEverywhere(user) {
  const displayName = user?.name || 'Thành viên';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'U';
  const avatarUrl = user && isSafeAvatarUrl(user.avatarUrl) ? user.avatarUrl : '';

  renderAvatarEl(document.getElementById('accountAvatarInitial'), avatarUrl, initial, displayName);
  renderAvatarEl(document.getElementById('headerUserAvatar'), avatarUrl, initial, displayName);

  const mobileAvatarEl = document.getElementById('mobileNavAccountAvatar');
  const mobileIconSvg = document.getElementById('mobileNavAccountIconSvg');
  if (mobileAvatarEl && mobileIconSvg) {
    if (user && avatarUrl) {
      renderAvatarEl(mobileAvatarEl, avatarUrl, initial, displayName);
      mobileAvatarEl.classList.remove('hidden');
      mobileIconSvg.classList.add('hidden');
    } else {
      mobileAvatarEl.textContent = '';
      mobileAvatarEl.classList.add('hidden');
      mobileIconSvg.classList.remove('hidden');
    }
  }
}

function syncAccountProfileUi({ populateForm = false } = {}) {
  if (!currentUser) return;
  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  const displayName = currentUser.name || 'Thành viên';
  syncUserAvatarEverywhere(currentUser);
  setTxt('accountUserName', displayName);
  setTxt('accountUserPhone', currentUser.phone || 'Chưa cập nhật SĐT');
  setTxt('accountUserCode', currentUser.code || '...');

  const bankSummaryEl = document.getElementById('accountBankSummary');
  if (bankSummaryEl) {
    if (currentUser.bankName && currentUser.bankAccount) {
      const ownerPart = currentUser.bankOwner ? ` • ${escapeHtml(currentUser.bankOwner)}` : '';
      bankSummaryEl.innerHTML = `${UI_ICONS.landmark}<span>Tài khoản nhận tiền: ${escapeHtml(currentUser.bankName)} — ${escapeHtml(currentUser.bankAccount)}${ownerPart}</span>`;
    } else {
      bankSummaryEl.innerHTML = `${UI_ICONS.landmark}<span>Chưa lưu thông tin nhận tiền (bấm Hồ sơ &amp; Ngân hàng bên dưới để thiết lập)</span>`;
    }
  }

  const profilePanel = document.getElementById('accProfilePanel');
  const isEditingProfile =
    profilePanel &&
    !profilePanel.classList.contains('hidden') &&
    profilePanel.contains(document.activeElement);

  if (populateForm || !isEditingProfile) {
    const nameInput = document.getElementById('accProfileName');
    const emailInput = document.getElementById('accProfileEmail');
    const accBankSelect = document.getElementById('accBankName');
    const accBankAccInput = document.getElementById('accBankAccount');
    const accBankOwnerInput = document.getElementById('accBankOwner');
    if (nameInput) nameInput.value = currentUser.name || '';
    if (emailInput) emailInput.value = currentUser.email || '';
    if (accBankSelect) accBankSelect.value = currentUser.bankName || '';
    if (accBankAccInput) accBankAccInput.value = currentUser.bankAccount || '';
    if (accBankOwnerInput) accBankOwnerInput.value = currentUser.bankOwner || '';
    const inferredMethod = currentUser.bankName === 'MoMo' ? 'momo' : 'bank';
    if (currentUser.bankName && currentUser.bankName !== 'MoMo') {
      accountPayoutState.lastBank = currentUser.bankName;
    }
    syncPayoutMethodFields({
      methodSelectId: 'accBankMethod',
      bankGroupId: 'accBankNameGroup',
      bankSelectId: 'accBankName',
      accLabelId: 'accBankAccountLabel',
      accInputId: 'accBankAccount',
      ownerLabelId: 'accBankOwnerLabel',
      stateObj: accountPayoutState,
      preferredMethod: inferredMethod
    });
    syncAccountBankPasswordRequirement();
  }
}

// Sync Auth UI
function syncAuthUi() {
  const navAuthArea = document.getElementById('navAuthArea');
  const navUserArea = document.getElementById('navUserArea');
  const navAdminBtn = document.getElementById('navAdminBtn');
  const mobileNavAdminBtn = document.getElementById('mobileNavAdminBtn');
  const accountAdminMenuBtn = document.getElementById('accountAdminMenuBtn');
  const walletGuestPrompt = document.getElementById('walletGuestPrompt');
  const walletAuthenticatedContent = document.getElementById('walletAuthenticatedContent');
  const ordersGuestPrompt = document.getElementById('ordersGuestPrompt');
  const ordersAuthenticatedContent = document.getElementById('ordersAuthenticatedContent');
  const accountGuestPrompt = document.getElementById('accountGuestPrompt');
  const accountAuthenticatedContent = document.getElementById('accountAuthenticatedContent');

  if (authToken && currentUser) {
    document.body.classList.add('is-authenticated');
    navAuthArea?.classList.add('hidden');
    navUserArea?.classList.remove('hidden');
    walletGuestPrompt?.classList.add('hidden');
    walletAuthenticatedContent?.classList.remove('hidden');
    ordersGuestPrompt?.classList.add('hidden');
    ordersAuthenticatedContent?.classList.remove('hidden');
    accountGuestPrompt?.classList.add('hidden');
    accountAuthenticatedContent?.classList.remove('hidden');

    const headerNameEl = document.getElementById('headerUserName');
    if (headerNameEl) headerNameEl.textContent = currentUser.name || '';
    updateBalancePrivacyDisplay();
    updateWithdrawProgressBar();
    syncAccountProfileUi();

    const isAdmin = currentUser.role === 'admin';
    navAdminBtn?.classList.toggle('hidden', !isAdmin);
    mobileNavAdminBtn?.classList.toggle('hidden', !isAdmin);
    accountAdminMenuBtn?.classList.toggle('hidden', !isAdmin);
    if (isAdmin) {
      ensureAdminAssetsLoaded();
    }
  } else {
    document.body.classList.remove('is-authenticated');
    syncUserAvatarEverywhere(null);
    navAuthArea?.classList.remove('hidden');
    navUserArea?.classList.add('hidden');
    navAdminBtn?.classList.add('hidden');
    mobileNavAdminBtn?.classList.add('hidden');
    accountAdminMenuBtn?.classList.add('hidden');
    document.getElementById('mobileOrdersNotifyDot')?.classList.add('hidden');
    document.getElementById('mobileWalletNotifyDot')?.classList.add('hidden');
    walletGuestPrompt?.classList.remove('hidden');
    walletAuthenticatedContent?.classList.add('hidden');
    ordersGuestPrompt?.classList.remove('hidden');
    ordersAuthenticatedContent?.classList.add('hidden');
    accountGuestPrompt?.classList.remove('hidden');
    accountAuthenticatedContent?.classList.add('hidden');
  }
}

function setSession(_token, user) {
  authToken = 'httponly_cookie_session';
  currentUser = user;
  safeStorage.remove(TOKEN_KEY);
  // Only store minimal non-sensitive identity in localStorage; balance/account loaded from /api/user/me
  safeStorage.set(
    USER_KEY,
    JSON.stringify({
      code: user.code,
      name: user.name,
      role: user.role
    })
  );
  syncAuthUi();
  loadUserDashboard();
  refreshGuestConversionAfterAuth(user);
}

async function clearSession({ skipLogoutApi = false } = {}) {
  authToken = '';
  currentUser = null;
  lastConvertedGuestText = '';
  lastPreviewedGuestUrl = '';
  walletPayoutState.lastBank = '';
  accountPayoutState.lastBank = '';
  userOrderStatusCountsCache = null;
  latestUserActivitySnapshot = null;
  activeOrderStatusFilter = 'all';
  activeOrderPlatformFilter = 'all';
  safeStorage.remove(TOKEN_KEY);
  safeStorage.remove(USER_KEY);
  if (conversionResultSection) conversionResultSection.classList.add('hidden');
  if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
  if (resultCardsList) resultCardsList.innerHTML = '';
  document.getElementById('accProfilePanel')?.classList.add('hidden');
  document.getElementById('accPasswordPanel')?.classList.add('hidden');
  document.getElementById('toggleAccProfileBtn')?.classList.remove('active');
  document.getElementById('toggleAccPasswordBtn')?.classList.remove('active');
  if (!skipLogoutApi) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
    } catch (err) {
      console.warn('Logout network notice:', err);
    }
  }
  syncAuthUi();
  switchView('home');
}

// Floating Zalo Community Widget
function applyZaloWidget(cfg) {
  const box = document.getElementById('floatingZaloWidget');
  const link = document.getElementById('floatingZaloLink');
  if (!box || !link) return;

  const groupUrl = cfg?.zaloGroupUrl || '';
  const isEnabled = cfg?.zaloWidgetEnabled !== false;
  // Chỉ kích hoạt nếu server xác nhận bật và URL bắt đầu bằng https://zalo.me/
  const ok = isEnabled && /^https:\/\/zalo\.me\//.test(groupUrl);

  box.classList.toggle('hidden', !ok);
  if (ok) {
    link.href = groupUrl;
  }
}

// Public Settings & Config Application
function applyPublicSettings(data) {
  if (!data) return;
  publicConfig = { ...publicConfig, ...data };
  const navSiteNameEl = document.getElementById('navSiteName');
  if (navSiteNameEl && publicConfig.siteName) navSiteNameEl.textContent = publicConfig.siteName;
  const minLabel = document.getElementById('minWithdrawLabel');
  if (minLabel) minLabel.textContent = fmtVnd(publicConfig.minWithdrawAmount);
  document.querySelectorAll('[data-config="cashbackPercent"]').forEach((el) => {
    el.textContent = `${publicConfig.cashbackPercent}%`;
  });
  document.querySelectorAll('[data-config="minWithdrawAmount"]').forEach((el) => {
    el.textContent = fmtVnd(publicConfig.minWithdrawAmount);
  });
  document.querySelectorAll('[data-config="referralBountyAmount"]').forEach((el) => {
    el.textContent = fmtVnd(publicConfig.referralBountyAmount ?? 10000);
  });

  applyZaloWidget(publicConfig);
  updateWithdrawProgressBar();
}

// Public Config
async function initPublicConfig() {
  try {
    const data = await apiFetch('/api/public-config');
    applyPublicSettings(data);
  } catch (err) {
    console.warn('Init public config notice:', err);
  }
}

// Auth Modal Logic
const authModal = document.getElementById('authModal');
function getForgotZaloHref() {
  const rawSupport = String(publicConfig?.supportZalo || '').trim();
  if (/^https?:\/\//i.test(rawSupport)) return rawSupport;
  const digits = rawSupport.replace(/\D/g, '');
  if (digits.length >= 8) return `https://zalo.me/${digits}`;
  return publicConfig?.zaloGroupUrl || 'https://zalo.me/g/cl2cmiseoqienusnrbyr';
}

function openAuthModal(tab = 'login') {
  if (!authModal) return;
  authModal.classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-auth-tab') === tab);
  });
  document.getElementById('loginFormBox')?.classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerFormBox')?.classList.toggle('hidden', tab !== 'register');
  document.getElementById('forgotPasswordBox')?.classList.toggle('hidden', tab !== 'forgot');
  const titleEl = document.getElementById('authModalTitle');
  if (titleEl) {
    titleEl.textContent =
      tab === 'forgot'
        ? 'Quên mật khẩu'
        : tab === 'login'
          ? 'Đăng nhập tài khoản'
          : 'Đăng ký tài khoản';
  }
  if (tab === 'forgot') {
    document.getElementById('forgotStep1Form')?.classList.remove('hidden');
    document.getElementById('forgotStep2Form')?.classList.add('hidden');
    const zaloBtn = document.getElementById('forgotZaloSupportBtn');
    if (zaloBtn) zaloBtn.href = getForgotZaloHref();
    const loginId = document.getElementById('loginIdentifier')?.value?.trim() || '';
    const forgotId = document.getElementById('forgotIdentifier');
    if (forgotId && loginId && !forgotId.value) forgotId.value = loginId;
  }

  const savedRef =
    safeStorage.get('saved_ref_code', localStorage) ||
    safeStorage.get('hoantienshop_ref', sessionStorage);
  const regRefInput = document.getElementById('regRefCode');
  const regRefNotice = document.getElementById('regRefNotice');
  if (savedRef && regRefInput && !regRefInput.value) {
    regRefInput.value = savedRef.toUpperCase();
    regRefNotice?.classList.remove('hidden');
  }
}

on('openForgotPwdBtn', 'click', () => openAuthModal('forgot'));
on('backToLoginBtn', 'click', () => openAuthModal('login'));

let forgotOtpCooldownTimer = null;
function startForgotOtpCooldown(sec = 60) {
  const resendBtn = document.getElementById('resendForgotOtpBtn');
  if (!resendBtn) return;
  if (forgotOtpCooldownTimer) clearInterval(forgotOtpCooldownTimer);
  let left = sec;
  resendBtn.disabled = true;
  resendBtn.textContent = `Gửi lại mã sau ${left}s`;
  forgotOtpCooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(forgotOtpCooldownTimer);
      forgotOtpCooldownTimer = null;
      resendBtn.disabled = false;
      resendBtn.textContent = 'Gửi lại mã xác nhận';
    } else {
      resendBtn.textContent = `Gửi lại mã sau ${left}s`;
    }
  }, 1000);
}

async function requestForgotPasswordOtp() {
  const identifier = document.getElementById('forgotIdentifier')?.value?.trim() || '';
  if (!identifier) {
    showToast('Vui lòng nhập Số điện thoại hoặc Email đã đăng ký.');
    return;
  }
  const btn = document.getElementById('sendForgotOtpBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang gửi mã...';
  }
  try {
    const turnstileToken = getTurnstileToken('loginTurnstile');
    const payload = { identifier };
    if (turnstileToken) payload.turnstileToken = turnstileToken;
    const res = await apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const hint = document.getElementById('forgotOtpHint');
    if (hint && res?.message) hint.textContent = res.message;
    document.getElementById('forgotStep1Form')?.classList.add('hidden');
    document.getElementById('forgotStep2Form')?.classList.remove('hidden');
    startForgotOtpCooldown(60);
    document.getElementById('forgotOtpInput')?.focus();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Gửi Mã Xác Nhận (OTP)';
    }
  }
}

on('forgotStep1Form', 'submit', async (e) => {
  e.preventDefault();
  await requestForgotPasswordOtp();
});
on('resendForgotOtpBtn', 'click', requestForgotPasswordOtp);

on('forgotStep2Form', 'submit', async (e) => {
  e.preventDefault();
  const identifier = document.getElementById('forgotIdentifier')?.value?.trim() || '';
  const otp = document.getElementById('forgotOtpInput')?.value?.trim() || '';
  const newPassword = document.getElementById('forgotNewPassword')?.value || '';
  const confirmPassword = document.getElementById('forgotConfirmPassword')?.value || '';

  if (!/^\d{6}$/.test(otp)) {
    showToast('Vui lòng nhập đúng mã xác nhận gồm 6 chữ số.');
    return;
  }
  if (newPassword.length < 6) {
    showToast('Mật khẩu mới phải có tối thiểu 6 ký tự.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('Mật khẩu xác nhận không khớp.');
    return;
  }
  const btn = document.getElementById('confirmResetPwdBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang đặt lại...';
  }
  try {
    const res = await apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ identifier, otp, newPassword })
    });
    showToast(res?.message || 'Đặt lại mật khẩu thành công!');
    if (document.getElementById('forgotOtpInput')) document.getElementById('forgotOtpInput').value = '';
    if (document.getElementById('forgotNewPassword')) document.getElementById('forgotNewPassword').value = '';
    if (document.getElementById('forgotConfirmPassword')) document.getElementById('forgotConfirmPassword').value = '';
    if (document.getElementById('loginIdentifier')) document.getElementById('loginIdentifier').value = identifier;
    openAuthModal('login');
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Đặt Lại Mật Khẩu';
    }
  }
});

on('openLoginBtn', 'click', () => openAuthModal('login'));
on('openRegisterBtn', 'click', () => openAuthModal('register'));
on('walletLoginBtn', 'click', () => openAuthModal('login'));
on('walletRegisterBtn', 'click', () => openAuthModal('register'));
on('closeAuthModalBtn', 'click', () => {
  resetPasswordVisibility(authModal);
  authModal?.classList.add('hidden');
});

document.querySelectorAll('.auth-tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => openAuthModal(tabBtn.getAttribute('data-auth-tab')));
});

// Helper to extract Cloudflare Turnstile token from DOM or Turnstile API if present
function getTurnstileToken(containerId) {
  try {
    if (containerId) {
      const container = document.getElementById(containerId);
      const tokenInContainer = container?.querySelector?.('[name="cf-turnstile-response"]')?.value;
      if (tokenInContainer) return tokenInContainer;
    }
    const tokenInput = document.querySelector('[name="cf-turnstile-response"]');
    if (tokenInput && tokenInput.value) {
      return tokenInput.value;
    }
    if (typeof window !== 'undefined' && window.turnstile && typeof window.turnstile.getResponse === 'function') {
      const resp = window.turnstile.getResponse();
      if (resp) return resp;
    }
  } catch (_) {}
  return '';
}

let isAuthSubmitting = false;

// Login execution with button lock & duplicate submit guard
async function handleDoLogin() {
  if (isAuthSubmitting) return;
  const btn = document.getElementById('doLoginBtn');
  const identifier = document.getElementById('loginIdentifier')?.value?.trim() || '';
  const password = document.getElementById('loginPassword')?.value || '';

  if (!identifier || !password) {
    showToast('Vui lòng nhập đầy đủ tài khoản và mật khẩu!');
    return;
  }

  isAuthSubmitting = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang đăng nhập...';
  }

  try {
    const turnstileToken = getTurnstileToken('loginTurnstile');
    const payload = { identifier, password };
    if (turnstileToken) payload.turnstileToken = turnstileToken;

    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setSession(data.token, data.user);
    authModal?.classList.add('hidden');
    showToast(`Xin chào ${data.user.name}!`);
    if (data.user.role === 'admin') {
      switchView('admin');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    isAuthSubmitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Đăng Nhập';
    }
  }
}

on('doLoginBtn', 'click', handleDoLogin);

// Register execution with button lock & duplicate submit guard
async function handleDoRegister() {
  if (isAuthSubmitting) return;
  const btn = document.getElementById('doRegisterBtn');
  const name = document.getElementById('regName')?.value?.trim() || '';
  const phone = document.getElementById('regPhone')?.value?.trim() || '';
  const email = document.getElementById('regEmail')?.value?.trim() || '';
  const password = document.getElementById('regPassword')?.value || '';
  const refCode = document.getElementById('regRefCode')?.value?.trim() || '';

  if (!name || !phone || !password) {
    showToast('Vui lòng điền đầy đủ họ tên, SĐT và mật khẩu!');
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Địa chỉ Email không hợp lệ.');
    return;
  }
  if (password.length < 6) {
    showToast('Mật khẩu phải có tối thiểu 6 ký tự.');
    return;
  }

  const agree = document.getElementById('regTermsAgree');
  if (!agree || !agree.checked) {
    showToast('Vui lòng đồng ý với Điều khoản dịch vụ & Chính sách bảo mật.');
    return;
  }

  isAuthSubmitting = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang tạo tài khoản...';
  }

  try {
    const turnstileToken = getTurnstileToken('registerTurnstile');
    const payload = { name, phone, password, refCode };
    if (email) payload.email = email;
    if (turnstileToken) payload.turnstileToken = turnstileToken;

    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setSession(data.token, data.user);
    authModal?.classList.add('hidden');
    showToast('Đăng ký tài khoản thành công!');
  } catch (err) {
    showToast(err.message);
  } finally {
    isAuthSubmitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Đăng Ký Tài Khoản';
    }
  }
}

on('doRegisterBtn', 'click', handleDoRegister);

// Form submit listeners handle both button click and Enter key without duplicate invocation
on('loginFormBox', 'submit', (e) => {
  e.preventDefault();
  handleDoLogin();
});
on('registerFormBox', 'submit', (e) => {
  e.preventDefault();
  handleDoRegister();
});
on('withdrawFormBox', 'submit', handleSubmitWithdrawal);

const regRefCodeInput = document.getElementById('regRefCode');
if (regRefCodeInput) {
  regRefCodeInput.addEventListener('input', () => {
    regRefCodeInput.value = regRefCodeInput.value.toUpperCase();
    const notice = document.getElementById('regRefNotice');
    if (regRefCodeInput.value.trim()) {
      notice?.classList.remove('hidden');
    } else {
      notice?.classList.add('hidden');
    }
  });
}

on('logoutBtn', 'click', () => {
  clearSession();
  showToast('Đã đăng xuất tài khoản.');
});

on('accountLogoutBtn', 'click', () => {
  clearSession();
  showToast('Đã đăng xuất tài khoản.');
});

on('copyAccountCodeBtn', 'click', () => {
  const code = currentUser?.code || document.getElementById('accountUserCode')?.textContent?.trim();
  if (code && code !== '...') {
    copyText(code, `Đã sao chép mã tài khoản: ${code}`);
  }
});

on('toggleBalancePrivacyBtn', 'click', () => {
  isBalanceHidden = !isBalanceHidden;
  safeStorage.set('hts_hide_balance', isBalanceHidden ? '1' : '0');
  updateBalancePrivacyDisplay();
});

on('refreshOrdersBtn', 'click', () => loadUserDashboard());

// ================= HOME CONVERTER (CUSTOMER VIEW) =================
const productUrlInput = document.getElementById('productUrlInput');
const getCashbackLinkBtn = document.getElementById('getCashbackLinkBtn');
const clearInputBtn = document.getElementById('clearInputBtn');
const conversionResultSection = document.getElementById('conversionResultSection');
const resultCardsList = document.getElementById('resultCardsList');
const instantPreviewArea = document.getElementById('instantPreviewArea');
const instantPreviewCard = document.getElementById('instantPreviewCard');

let previewDebounceTimer = null;
let previewAbortController = null;
let isConverting = false;
let lastConvertedGuestText = '';
let lastPreviewedGuestUrl = '';

function extractConvertibleUrlCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const schemeMatch = rawText.match(/https?:\/\/[^\s<>"')\]}]+/i);
  if (schemeMatch) return schemeMatch[0];
  const shortMatch = rawText.match(
    /(?:^|[\s<>"'(\[])((?:s\.shopee\.vn|vn\.shp\.ee|shp\.ee|shope\.ee|vt\.tiktok\.com|vm\.tiktok\.com)\/[a-zA-Z0-9_\-/?=&#.]+)/i
  );
  return shortMatch && shortMatch[1] ? 'https://' + shortMatch[1] : '';
}

if (productUrlInput) {
  productUrlInput.addEventListener('input', () => {
    const val = productUrlInput.value.trim();
    clearInputBtn?.classList.toggle('hidden', !val);
    clearTimeout(previewDebounceTimer);
    if (conversionResultSection) {
      conversionResultSection.classList.add('hidden');
    }
    const candidate = extractConvertibleUrlCandidate(val);
    if (candidate) {
      previewDebounceTimer = setTimeout(() => {
        fetchInstantPreview(candidate);
      }, 450);
    } else {
      lastConvertedGuestText = '';
      lastPreviewedGuestUrl = '';
      if (previewAbortController) previewAbortController.abort();
      if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
    }
  });

  productUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGetCashbackLink();
    }
  });

  productUrlInput.addEventListener('paste', () => {
    setTimeout(() => {
      const val = productUrlInput.value.trim();
      clearInputBtn?.classList.toggle('hidden', !val);
      if (extractConvertibleUrlCandidate(val)) {
        clearTimeout(previewDebounceTimer);
        if (previewAbortController) previewAbortController.abort();
        handleGetCashbackLink();
      }
    }, 60);
  });
}

on('pasteBtn', 'click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && productUrlInput) {
      productUrlInput.value = text;
      clearInputBtn?.classList.remove('hidden');
      if (conversionResultSection) {
        conversionResultSection.classList.add('hidden');
      }
      clearTimeout(previewDebounceTimer);
      if (previewAbortController) previewAbortController.abort();
      if (extractConvertibleUrlCandidate(text)) {
        handleGetCashbackLink();
      }
    }
  } catch {
    productUrlInput?.focus();
    showToast('Hãy nhấn giữ hoặc Ctrl+V vào ô nhập để dán link.');
  }
});

if (clearInputBtn) {
  clearInputBtn.addEventListener('click', () => {
    clearTimeout(previewDebounceTimer);
    if (previewAbortController) previewAbortController.abort();
    lastConvertedGuestText = '';
    lastPreviewedGuestUrl = '';
    if (productUrlInput) productUrlInput.value = '';
    clearInputBtn.classList.add('hidden');
    if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
    if (conversionResultSection) conversionResultSection.classList.add('hidden');
    productUrlInput?.focus();
  });
}

async function fetchInstantPreview(rawText) {
  if (!instantPreviewArea || !instantPreviewCard || !rawText || isConverting) return;
  if (conversionResultSection && !conversionResultSection.classList.contains('hidden')) return;
  const url = extractConvertibleUrlCandidate(rawText);
  if (!url) return;

  if (previewAbortController) {
    previewAbortController.abort();
  }
  previewAbortController = new AbortController();
  const signal = previewAbortController.signal;

  instantPreviewArea.classList.remove('hidden');
  instantPreviewCard.classList.add('loading');
  instantPreviewCard.innerHTML = `
    <div class="preview-skeleton" aria-label="Đang tra cứu sản phẩm">
      <div class="preview-skeleton-thumb"></div>
      <div class="preview-skeleton-body">
        <div class="skeleton-line w-80"></div>
        <div class="skeleton-line w-50"></div>
      </div>
    </div>
  `;

  try {
    const res = await apiFetch('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ url }),
      signal
    });

    if (signal.aborted) return;
    if (!res || !res.found) {
      lastPreviewedGuestUrl = '';
      if (res && res.error) {
        instantPreviewArea.classList.remove('hidden');
        const isWarn = Boolean(res.isVideoLink);
        const bg = isWarn ? '#fffbeb' : '#fef2f2';
        const border = isWarn ? '#fcd34d' : '#fecaca';
        const color = isWarn ? '#92400e' : '#991b1b';
        instantPreviewCard.innerHTML = `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:12px;background:${bg};border:1px solid ${border};color:${color};font-size:13.5px;line-height:1.5;">
            <span style="flex-shrink:0;margin-top:2px;">${UI_ICONS.alertCircle || '⚠️'}</span>
            <span>${escapeHtml(res.error)}</span>
          </div>
        `;
        instantPreviewCard.setAttribute('role', 'alert');
      } else {
        instantPreviewArea.classList.add('hidden');
      }
      return;
    }
    lastPreviewedGuestUrl = !authToken ? url : '';
    renderInstantPreviewCard(res);
  } catch (err) {
    if (signal.aborted || err.name === 'AbortError') {
      // Previous preview request was aborted by subsequent input; silently ignore without altering subsequent state
      return;
    }
    instantPreviewArea.classList.remove('hidden');
    instantPreviewCard.textContent = 'Chưa tải được thông tin sản phẩm. Bạn có thể thử lại hoặc tiếp tục tạo link.';
    instantPreviewCard.setAttribute('role', 'status');
  } finally {
    if (!signal.aborted) {
      instantPreviewCard.classList.remove('loading');
    }
  }
}

function renderInstantPreviewCard(data) {
  if (!instantPreviewCard) return;

  const isShopee = data.platform === 'shopee';
  const isTikTok = data.platform === 'tiktok';

  const platBadge = isShopee
    ? `<span class="plat-badge-inline shopee">Shopee</span>`
    : isTikTok
    ? `<span class="plat-badge-inline tiktok">TikTok Shop</span>`
    : '<span>Sàn TMĐT</span>';

  const title = escapeHtml(data.productName || data.title || 'Sản phẩm hoàn tiền');
  const price = data.price > 0 ? fmtVnd(data.price) : 'Đang cập nhật';
  const estCashback = data.estimatedCashback > 0 ? `+${fmtVnd(data.estimatedCashback)}` : null;

  const safeThumbUrl = safeHttpsUrl(data.imageUrl);
  const thumbHtml = safeThumbUrl
    ? `<img src="${safeThumbUrl}" alt="${title}" class="ip-thumb" referrerpolicy="no-referrer" />`
    : `<div class="ip-thumb ip-thumb-fallback">${UI_ICONS.shoppingBagLg}</div>`;

  const cashbackPill = estCashback
    ? `<span class="cashback-pill">Hoàn tối đa: <strong>${estCashback}</strong></span>`
    : `<span class="cashback-pill" style="background:#f1f5f9;color:#475569;">Có hoàn tiền</span>`;

  const authNotice = !authToken
    ? `<div class="ip-auth-notice">
         <span class="inline-icon-wrap" aria-hidden="true">${UI_ICONS.alertTriangle}</span>
         <span>Bạn chưa đăng nhập. Nhấn Tạo link để nhận liên kết mua hàng, hoặc <button type="button" class="inline-link" data-open-auth="login">Đăng nhập ngay</button> để tích lũy tiền vào ví!</span>
       </div>`
    : '';

  instantPreviewCard.innerHTML = `
    <div class="ip-top-row">
      <span class="ip-status-badge inline-icon-row">${UI_ICONS.sparkles}<span>Đã tìm thấy sản phẩm</span></span>
      ${platBadge}
    </div>
    <div class="ip-main-row">
      ${thumbHtml}
      <div class="ip-info">
        <h4 class="ip-title">${title}</h4>
        <div class="ip-meta">
          <span class="ip-price">Giá bán: <strong>${price}</strong></span>
          ${cashbackPill}
        </div>
      </div>
    </div>
    <div class="ip-footer-row">
      ${authNotice}
      <button type="button" class="btn btn-primary btn-sm" id="btnTriggerConvertFromPreview">
        Tạo Link Hoàn Tiền Ngay
      </button>
    </div>
  `;

  on('btnTriggerConvertFromPreview', 'click', () => {
    handleGetCashbackLink();
  });
}

async function refreshGuestConversionAfterAuth(user) {
  if (!authToken || !user) return;
  if (user.role === 'admin') {
    lastConvertedGuestText = '';
    lastPreviewedGuestUrl = '';
    conversionResultSection?.classList.add('hidden');
    instantPreviewArea?.classList.add('hidden');
    return;
  }

  const hasVisibleGuestConversion =
    Boolean(lastConvertedGuestText) &&
    conversionResultSection &&
    !conversionResultSection.classList.contains('hidden');

  if (hasVisibleGuestConversion) {
    const targetText = lastConvertedGuestText;
    if (resultCardsList) {
      resultCardsList.querySelectorAll('.btn-open-aff').forEach((linkEl) => {
        linkEl.removeAttribute('href');
        linkEl.setAttribute('aria-disabled', 'true');
        linkEl.classList.add('is-refreshing-aff');
      });
      resultCardsList.querySelectorAll('[data-copy]').forEach((copyEl) => {
        copyEl.removeAttribute('data-copy');
        copyEl.classList.add('is-refreshing-aff');
        if (copyEl.tagName === 'INPUT') {
          copyEl.value = 'Đang gắn tài khoản hoàn tiền...';
        }
      });
      resultCardsList.querySelectorAll('.guest-card-note').forEach((noteEl) => {
        noteEl.classList.remove('is-error-note');
        noteEl.textContent = 'Đang gắn tài khoản của bạn vào liên kết mua sắm hoàn tiền...';
      });
    }
    if (productUrlInput && !productUrlInput.value.trim()) {
      productUrlInput.value = targetText;
      clearInputBtn?.classList.remove('hidden');
    }
    await handleGetCashbackLink({ refreshAfterAuth: true, sourceText: targetText });
    return;
  }

  const hasVisibleGuestPreview =
    instantPreviewArea && !instantPreviewArea.classList.contains('hidden');
  const candidatePreviewText = (productUrlInput?.value || lastPreviewedGuestUrl || '').trim();
  if (hasVisibleGuestPreview && extractConvertibleUrlCandidate(candidatePreviewText)) {
    instantPreviewCard?.querySelector('.ip-auth-notice')?.remove();
    await handleGetCashbackLink({ refreshAfterAuth: true, sourceText: candidatePreviewText });
  }
}

async function handleGetCashbackLink(rawOptions) {
  const opts =
    rawOptions &&
    typeof rawOptions === 'object' &&
    !('target' in rawOptions) &&
    !(typeof Event !== 'undefined' && rawOptions instanceof Event)
      ? rawOptions
      : {};
  const isRefreshAfterAuth = Boolean(opts.refreshAfterAuth);

  if (isConverting && !isRefreshAfterAuth) return;
  const text = String(opts.sourceText || productUrlInput?.value || '').trim();
  if (!text) {
    showToast('Vui lòng dán link sản phẩm Shopee hoặc TikTok Shop!');
    productUrlInput?.focus();
    return;
  }

  clearTimeout(previewDebounceTimer);
  if (previewAbortController) {
    previewAbortController.abort();
  }
  isConverting = true;
  if (getCashbackLinkBtn) {
    getCashbackLinkBtn.disabled = true;
    getCashbackLinkBtn.textContent = isRefreshAfterAuth
      ? 'Đang gắn tài khoản...'
      : 'Đang tạo link...';
  }

  try {
    const data = await apiFetch('/api/convert', {
      method: 'POST',
      body: JSON.stringify({ text })
    });

    const items = (data.items || []).filter((i) => i.status === 'success');
    if (items.length === 0) {
      const firstErr = data.items?.[0]?.error;
      if (isRefreshAfterAuth && resultCardsList) {
        renderAuthRefreshRetryNote();
      }
      showToast(firstErr || 'Không tìm thấy link sản phẩm Shopee hoặc TikTok Shop hợp lệ.');
      if (!isRefreshAfterAuth && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('lila:convert-error'));
      }
      return;
    }

    lastConvertedGuestText = !authToken ? text : '';
    lastPreviewedGuestUrl = '';

    if (instantPreviewArea) {
      instantPreviewArea.classList.add('hidden');
    }
    conversionResultSection?.classList.remove('hidden');
    if (!isRefreshAfterAuth) {
      conversionResultSection?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }

    const cardFooterNoticeHtml = !authToken
      ? `<div class="guest-card-note">
           Bạn chưa đăng nhập. Bạn có thể nhấn mua hàng nhưng sẽ không được cộng tiền hoàn vào ví.
           <button type="button" class="inline-link" data-open-auth="login">Đăng nhập ngay</button>
         </div>`
      : isRefreshAfterAuth
      ? `<div class="auth-linked-card-note">
           ${UI_ICONS.checkCircle}
           <span>Đã gắn tài khoản <strong>${escapeHtml(
             currentUser?.code || currentUser?.name || ''
           )}</strong> — nhấn mua hàng để tích lũy tiền hoàn vào ví!</span>
         </div>`
      : '';

    if (resultCardsList) {
      if (items[0] && items[0].originalUrl) {
        saveRecentConvertedLink({
          url: items[0].originalUrl,
          title: items[0].productName || (items[0].platform === 'tiktok' ? 'Sản phẩm TikTok' : 'Sản phẩm Shopee'),
          platform: items[0].platform || 'shopee'
        });
      }
      resultCardsList.innerHTML = items
        .map((item) => {
          const isShopee = item.platform === 'shopee';
          const isTikTok = item.platform === 'tiktok';
          const openAppBtnText = isShopee ? 'Mở Shopee' : isTikTok ? 'Mở TikTok' : 'Mở Mua Hàng';

          const platLabel = isShopee
            ? `<span class="plat-badge-inline shopee">
                <svg class="plat-svg-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M19 7h-3V6a4 4 0 0 0-8 0v1H5a1 1 0 0 0-1 1v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V8a1 1 0 0 0-1-1zm-9-1a2 2 0 0 1 4 0v1h-4V6zm8 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9h2v1.5a1 1 0 0 0 2 0V9h4v1.5a1 1 0 0 0 2 0V9h2v10z"/>
                  <path d="M13.5 13.5c-.3-.2-.7-.3-1.1-.4-.6-.2-.9-.3-.9-.6 0-.3.3-.5.7-.5.5 0 .9.2 1.2.4a.5.5 0 1 0 .6-.8c-.5-.3-1.1-.6-1.8-.6-1 0-1.7.6-1.7 1.5 0 .6.4 1.1 1.2 1.3.6.2.8.3.8.6 0 .3-.3.5-.8.5-.6 0-1.1-.3-1.4-.6a.5.5 0 1 0-.7.7c.5.5 1.2.8 2.1.8 1.1 0 1.8-.6 1.8-1.5 0-.7-.4-1.1-1.1-1.3z"/>
                </svg> Shopee
              </span>`
            : isTikTok
            ? `<span class="plat-badge-inline tiktok">
                <svg class="plat-svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.34 0 .67.06.98.17V8.89a6.45 6.45 0 0 0-.98-.07A6.33 6.33 0 0 0 3 15.16 6.33 6.33 0 0 0 9.34 21.5a6.33 6.33 0 0 0 6.33-6.34V8.47a8.28 8.28 0 0 0 4.81 1.53V6.69h-.89z"/>
                </svg> TikTok Shop
              </span>`
            : `<span class="inline-icon-row">${UI_ICONS.link}<span>Liên kết</span></span>`;

          const safeThumbUrl = safeHttpsUrl(item.imageUrl);
          const safeAffUrl = safeAppOrWebUrl(item.affiliateUrl);

          const thumbHtml = safeThumbUrl
            ? `<img src="${safeThumbUrl}" alt="Sản phẩm" class="product-thumb" referrerpolicy="no-referrer" />`
            : `<div class="product-thumb product-thumb-fallback">${UI_ICONS.shoppingBagLg}</div>`;

          const priceInfoHtml =
            item.price > 0
              ? `<span class="prod-price-tag">Giá bán: <strong>${fmtVnd(item.price)}</strong></span>`
              : `<span class="prod-price-tag">Giá bán: <strong>Đang cập nhật</strong></span>`;

          const estCashbackStripHtml =
            item.estimatedCashback > 0
              ? `<div class="cp-cashback-strip">
                   <span class="cp-cashback-label">Hoàn tối đa</span>
                   <strong class="cp-cashback-value">+ ${fmtVnd(item.estimatedCashback)}</strong>
                 </div>`
              : `<div class="cp-cashback-strip">
                   <span class="cp-cashback-label">Trạng thái hoàn tiền</span>
                   <strong class="cp-cashback-value">Có hoàn tiền</strong>
                 </div>`;

          const rawTitle = item.productName || item.title || '';
          const displayItemTitle =
            rawTitle && !rawTitle.match(/^Sản phẩm (Shopee|TikTok)/i)
              ? rawTitle
              : isShopee
              ? 'Sản phẩm Shopee'
              : 'Sản phẩm TikTok Shop';

          const ctaButtonHtml = safeAffUrl
            ? `<a href="${safeAffUrl}" target="_blank" rel="noopener" class="btn btn-cta btn-open-aff btn-icon-svg">
                 ${UI_ICONS.shoppingCart}
                 <span>${openAppBtnText} (Mua ngay)</span>
               </a>`
            : `<div style="color:#dc2626;font-size:13px;padding:8px 0;">Không thể tạo liên kết mở app cho sản phẩm này.</div>`;

          const webviewHintHtml =
            safeAffUrl && isInAppWebView()
              ? `<div class="webview-open-hint">
                   ${UI_ICONS.alertTriangle}
                   <span>Nếu đang mở trong Zalo / Messenger mà chưa tự chuyển sang App sàn, hãy nhấn nút <strong>•••</strong> góc trên chọn <strong>Mở bằng trình duyệt</strong> hoặc bấm Sao chép link bên dưới.</span>
                 </div>`
              : '';

          return `
            <div class="cashback-product-card">
              <div class="cp-top">
                <span class="valid-badge inline-icon-row">${UI_ICONS.checkCircle}<span>Sẵn sàng mua nhận hoàn tiền</span></span>
                ${platLabel}
              </div>

              <div class="cp-body">
                <!-- Product Details Row -->
                <div class="product-meta-row">
                  ${thumbHtml}
                  <div class="product-meta-info">
                    <h4>${escapeHtml(displayItemTitle)}</h4>
                    <div class="product-meta-sub">
                      ${priceInfoHtml}
                    </div>
                  </div>
                </div>

                ${estCashbackStripHtml}

                <!-- Nút Mua Hàng to rõ -->
                <div class="cp-cta-block">
                  ${ctaButtonHtml}
                  ${webviewHintHtml}
                </div>

                <!-- Rút gọn link aff thành 1 ô ngang duy nhất (Bỏ hoàn toàn mã QR) -->
                <div class="cp-link-single-row">
                  <div class="aff-input-box" title="Bấm để sao chép link">
                    <span class="aff-link-icon">${UI_ICONS.link}</span>
                    <input
                      type="text"
                      class="aff-single-input"
                      value="${safeAffUrl}"
                      readonly
                      data-copy="${safeAffUrl}"
                      data-copy-msg="Đã sao chép link mua hàng hoàn tiền!"
                    />
                  </div>
                  <button
                    type="button"
                    class="btn btn-copy-inline btn-icon-svg"
                    data-copy="${safeAffUrl}"
                    data-copy-msg="Đã sao chép link mua hàng hoàn tiền!"
                    title="Sao chép link mua hàng"
                  >
                    ${UI_ICONS.copy}
                    <span>Sao chép</span>
                  </button>
                </div>

                ${cardFooterNoticeHtml}
              </div>
            </div>
          `;
        })
        .join('');
    }

    if (isRefreshAfterAuth) {
      showToast('Đã tự động gắn tài khoản hoàn tiền vào liên kết mua sắm!');
    } else if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lila:convert-success', { detail: { count: items.length } }));
    }
  } catch (err) {
    if (isRefreshAfterAuth) {
      renderAuthRefreshRetryNote();
    }
    if (!isRefreshAfterAuth && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lila:convert-error'));
    }
    showToast(err.message);
  } finally {
    isConverting = false;
    if (getCashbackLinkBtn) {
      getCashbackLinkBtn.disabled = false;
      getCashbackLinkBtn.textContent = 'Lấy Link Hoàn Tiền';
    }
  }
}

function renderAuthRefreshRetryNote() {
  if (!resultCardsList) return;
  const notes = resultCardsList.querySelectorAll('.guest-card-note');
  if (notes.length > 0) {
    notes.forEach((noteEl) => {
      noteEl.classList.add('is-error-note');
      noteEl.innerHTML =
        'Chưa cập nhật được liên kết theo tài khoản vừa đăng nhập do lỗi mạng. <button type="button" class="inline-link retry-auth-convert-btn">Bấm để tạo lại link hoàn tiền</button>';
    });
    resultCardsList.querySelectorAll('.retry-auth-convert-btn').forEach((btnEl) => {
      btnEl.addEventListener('click', () => {
        refreshGuestConversionAfterAuth(currentUser);
      });
    });
  }
}

on('getCashbackLinkBtn', 'click', () => handleGetCashbackLink());

// ================= USER WALLET & ORDERS =================
const wdBankAccountInput = document.getElementById('wdBankAccount');
const wdPasswordConfirmGroup = document.getElementById('wdPasswordConfirmGroup');

function syncWithdrawalMethodUi(preferredMethod = null) {
  syncPayoutMethodFields({
    methodSelectId: 'wdMethod',
    bankGroupId: 'wdBankNameGroup',
    bankSelectId: 'wdBankName',
    accLabelId: 'wdBankAccountLabel',
    accInputId: 'wdBankAccount',
    ownerLabelId: 'wdBankOwnerLabel',
    stateObj: walletPayoutState,
    preferredMethod
  });
  syncWithdrawalPasswordRequirement();
}

function syncWithdrawalPasswordRequirement() {
  const savedAcc = String(currentUser?.bankAccount || '').replace(/\s+/g, '');
  const savedBank = String(currentUser?.bankName || '').trim();
  const newAcc = String(wdBankAccountInput?.value || '').replace(/\s+/g, '');
  const newBank = String(document.getElementById('wdBankName')?.value || '').trim();
  const required =
    !savedAcc ||
    newAcc !== savedAcc ||
    Boolean(savedBank && newBank && newBank !== savedBank);
  wdPasswordConfirmGroup?.classList.toggle('hidden', !required);
  const input = document.getElementById('wdCurrentPassword');
  if (input) input.required = required;
  return required;
}
wdBankAccountInput?.addEventListener('input', syncWithdrawalPasswordRequirement);

on('wdMethod', 'change', () => {
  syncWithdrawalMethodUi();
});
on('wdBankName', 'change', () => {
  const val = document.getElementById('wdBankName')?.value || '';
  if (val === 'MoMo') {
    requestAnimationFrame(() => {
      syncWithdrawalMethodUi('momo');
      wdBankAccountInput?.focus();
    });
  } else {
    if (val) walletPayoutState.lastBank = val;
    syncWithdrawalPasswordRequirement();
  }
});

// Self-Service Account Profile & Password Settings
on('toggleAccProfileBtn', 'click', () => {
  const profilePanel = document.getElementById('accProfilePanel');
  const pwdPanel = document.getElementById('accPasswordPanel');
  const profileBtn = document.getElementById('toggleAccProfileBtn');
  const pwdBtn = document.getElementById('toggleAccPasswordBtn');
  if (!profilePanel || !profileBtn) return;
  const willOpen = profilePanel.classList.contains('hidden');
  profilePanel.classList.toggle('hidden', !willOpen);
  profileBtn.classList.toggle('active', willOpen);
  profileBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (willOpen) {
    pwdPanel?.classList.add('hidden');
    pwdBtn?.classList.remove('active');
    pwdBtn?.setAttribute('aria-expanded', 'false');
    syncAccountProfileUi({ populateForm: true });
  }
});

on('toggleAccPasswordBtn', 'click', () => {
  const profilePanel = document.getElementById('accProfilePanel');
  const pwdPanel = document.getElementById('accPasswordPanel');
  const profileBtn = document.getElementById('toggleAccProfileBtn');
  const pwdBtn = document.getElementById('toggleAccPasswordBtn');
  if (!pwdPanel || !pwdBtn) return;
  const willOpen = pwdPanel.classList.contains('hidden');
  pwdPanel.classList.toggle('hidden', !willOpen);
  pwdBtn.classList.toggle('active', willOpen);
  pwdBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (willOpen) {
    profilePanel?.classList.add('hidden');
    profileBtn?.classList.remove('active');
    profileBtn?.setAttribute('aria-expanded', 'false');
  }
});

on('accBankMethod', 'change', () => {
  syncPayoutMethodFields({
    methodSelectId: 'accBankMethod',
    bankGroupId: 'accBankNameGroup',
    bankSelectId: 'accBankName',
    accLabelId: 'accBankAccountLabel',
    accInputId: 'accBankAccount',
    ownerLabelId: 'accBankOwnerLabel',
    stateObj: accountPayoutState
  });
  syncAccountBankPasswordRequirement();
});
on('accBankName', 'change', () => {
  const val = document.getElementById('accBankName')?.value || '';
  if (val === 'MoMo') {
    requestAnimationFrame(() => {
      syncPayoutMethodFields({
        methodSelectId: 'accBankMethod',
        bankGroupId: 'accBankNameGroup',
        bankSelectId: 'accBankName',
        accLabelId: 'accBankAccountLabel',
        accInputId: 'accBankAccount',
        ownerLabelId: 'accBankOwnerLabel',
        stateObj: accountPayoutState,
        preferredMethod: 'momo'
      });
      syncAccountBankPasswordRequirement();
      document.getElementById('accBankAccount')?.focus();
    });
  } else {
    if (val) accountPayoutState.lastBank = val;
    syncAccountBankPasswordRequirement();
  }
});
on('accBankAccount', 'input', syncAccountBankPasswordRequirement);
on('accProfileEmail', 'input', syncAccountBankPasswordRequirement);

on('accProfileForm', 'submit', async (e) => {
  e.preventDefault();
  if (!authToken) return;
  const name = document.getElementById('accProfileName')?.value?.trim() || '';
  const email = document.getElementById('accProfileEmail')?.value?.trim() || '';
  const method = document.getElementById('accBankMethod')?.value || 'bank';
  const bankName =
    method === 'momo'
      ? 'MoMo'
      : document.getElementById('accBankName')?.value?.trim() || '';
  const bankAccount =
    document.getElementById('accBankAccount')?.value?.replace(/\s+/g, '') || '';
  const bankOwner =
    document.getElementById('accBankOwner')?.value?.trim().toUpperCase() || '';
  const currentPassword =
    document.getElementById('accBankCurrentPassword')?.value || '';

  if (name.length < 2) {
    showToast('Vui lòng nhập Họ và tên hợp lệ (tối thiểu 2 ký tự).');
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Địa chỉ Email không hợp lệ.');
    return;
  }
  if ((bankAccount || bankOwner) && !bankName) {
    showToast('Vui lòng chọn Ngân hàng nhận tiền.');
    return;
  }
  if (bankName && (!bankAccount || bankAccount.length < 4 || !bankOwner || bankOwner.length < 2)) {
    showToast('Vui lòng nhập đầy đủ Số tài khoản (tối thiểu 4 số) và Tên chủ tài khoản.');
    return;
  }

  const saveBtn = document.getElementById('saveAccProfileBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Đang lưu...';
  }
  try {
    const payload = { name, email, bankName, bankAccount, bankOwner };
    if (currentPassword) payload.currentPassword = currentPassword;
    const res = await apiFetch('/api/user/profile', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (res?.user) {
      currentUser = res.user;
      safeStorage.set(
        USER_KEY,
        JSON.stringify({
          code: currentUser.code,
          name: currentUser.name,
          role: currentUser.role
        })
      );
      const pwdInput = document.getElementById('accBankCurrentPassword');
      if (pwdInput) pwdInput.value = '';
      syncAuthUi();
      if (document.getElementById('wdBankName')) {
        document.getElementById('wdBankName').value = currentUser.bankName || '';
      }
      if (document.getElementById('wdBankAccount')) {
        document.getElementById('wdBankAccount').value = currentUser.bankAccount || '';
      }
      if (document.getElementById('wdBankOwner')) {
        document.getElementById('wdBankOwner').value = currentUser.bankOwner || '';
      }
      syncWithdrawalMethodUi(currentUser.bankName === 'MoMo' ? 'momo' : 'bank');
      document.getElementById('accProfilePanel')?.classList.add('hidden');
      const profileBtn = document.getElementById('toggleAccProfileBtn');
      profileBtn?.classList.remove('active');
      profileBtn?.setAttribute('aria-expanded', 'false');
    }
    showToast('Đã lưu thông tin hồ sơ & tài khoản nhận tiền!');
  } catch (err) {
    showToast(err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Lưu Thông Tin Hồ Sơ';
    }
  }
});

on('accPasswordForm', 'submit', async (e) => {
  e.preventDefault();
  if (!authToken) return;
  const currentPassword = document.getElementById('accOldPassword')?.value || '';
  const newPassword = document.getElementById('accNewPassword')?.value || '';
  const confirmPassword = document.getElementById('accConfirmPassword')?.value || '';

  if (!currentPassword || !newPassword) {
    showToast('Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới.');
    return;
  }
  if (newPassword.length < 6) {
    showToast('Mật khẩu mới phải có tối thiểu 6 ký tự.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('Mật khẩu xác nhận không khớp với mật khẩu mới!');
    return;
  }

  const saveBtn = document.getElementById('saveAccPasswordBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Đang cập nhật...';
  }
  try {
    const res = await apiFetch('/api/user/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    ['accOldPassword', 'accNewPassword', 'accConfirmPassword'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('accPasswordPanel')?.classList.add('hidden');
    const pwdBtn = document.getElementById('toggleAccPasswordBtn');
    pwdBtn?.classList.remove('active');
    pwdBtn?.setAttribute('aria-expanded', 'false');
    showToast(res?.message || 'Đổi mật khẩu thành công!');
  } catch (err) {
    showToast(err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Cập Nhật Mật Khẩu Mới';
    }
  }
});

const USER_ORDERS_LIMIT = 10;
let userOrdersPage = 1;
let userLedgerPage = 1;
let userOrdersTotalPages = 1;
let userOrdersCache = [];
let activeOrderStatusFilter = 'all';
let activeOrderPlatformFilter = 'all';
let userOrderStatusCountsCache = null;

const ORD_COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ORD_CHEVRON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
const ORD_STATUS_ICONS = {
  pending: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  approved: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  cancelled: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};

function renderUserOrdersSkeleton() {
  const ordBody = document.getElementById('userOrdersTableBody');
  if (!ordBody) return;
  const rowHtml = `
    <tr class="ord-skeleton-row">
      <td colspan="4">
        <div class="ord-skeleton-box">
          <div class="ord-skel-line w-40"></div>
          <div class="ord-skel-line w-85"></div>
          <div class="ord-skel-line w-55"></div>
        </div>
      </td>
    </tr>`;
  ordBody.innerHTML = rowHtml + rowHtml + rowHtml;
}

function renderUserOrdersError(message) {
  const ordBody = document.getElementById('userOrdersTableBody');
  if (!ordBody) return;
  ordBody.innerHTML = `
    <tr>
      <td colspan="4" class="text-center">
        <div class="orders-error-box">
          <strong>Không thể tải danh sách đơn hàng</strong>
          <p>${escapeHtml(message || 'Kết nối đang gián đoạn. Vui lòng thử lại sau giây lát.')}</p>
          <button type="button" class="btn btn-primary btn-sm" id="retryOrdersLoadBtn">Thử lại</button>
        </div>
      </td>
    </tr>`;
}

function resetUserOrderFilters() {
  activeOrderStatusFilter = 'all';
  activeOrderPlatformFilter = 'all';
  const searchInp = document.getElementById('userOrderSearchInput');
  if (searchInp) searchInp.value = '';
  document.getElementById('clearOrderSearchBtn')?.classList.add('hidden');
  document.querySelectorAll('[data-order-status]').forEach((btn) => {
    const isAll = btn.getAttribute('data-order-status') === 'all';
    btn.classList.toggle('active', isAll);
    btn.setAttribute('aria-selected', isAll ? 'true' : 'false');
  });
  document.querySelectorAll('[data-order-platform]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-order-platform') === 'all');
  });
  if (authToken) {
    userOrdersPage = 1;
    loadUserOrdersPage(1);
  } else {
    renderUserOrdersTable(userOrdersCache);
  }
}

function closeOrderDetailSheet() {
  const overlay = document.getElementById('orderDetailSheetOverlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-lock');
}

function openOrderDetailSheet(orderIdOrSn) {
  const overlay = document.getElementById('orderDetailSheetOverlay');
  const body = document.getElementById('orderDetailSheetBody');
  if (!overlay || !body) return;
  const order = (userOrdersCache || []).find(
    (o) => String(o.id || '') === String(orderIdOrSn) || String(o.orderSn || '') === String(orderIdOrSn)
  );
  if (!order) return;

  const isApproved = order.status === 'approved';
  const isCancelled = order.status === 'cancelled';
  const stCls = getStatusClass(order.status);
  const stIcon = isApproved ? ORD_STATUS_ICONS.approved : isCancelled ? ORD_STATUS_ICONS.cancelled : ORD_STATUS_ICONS.pending;
  const stLabel = isApproved ? 'Đã cộng vào ví' : isCancelled ? 'Đã huỷ' : 'Đang đối soát';
  const plat = String(order.platform || '').toLowerCase();
  const platBadge = plat === 'tiktok'
    ? '<span class="plat-badge-inline tiktok">TikTok Shop</span>'
    : '<span class="plat-badge-inline shopee">Shopee</span>';
  const cbToneCls = isApproved ? 'is-approved' : isCancelled ? 'is-cancelled' : 'is-pending';
  const cbPrefix = isCancelled ? '' : '+';
  const cbSubLabel = isApproved
    ? 'Tiền hoàn đã cộng vào số dư khả dụng'
    : isCancelled
    ? 'Đơn không đủ điều kiện nhận hoàn tiền'
    : 'Tiền hoàn dự kiến (chờ sàn xác nhận)';

  const createdShort = order.createdAt ? new Date(order.createdAt).toLocaleDateString('vi-VN') : '—';
  const createdFull = order.createdAt ? new Date(order.createdAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const updatedFull = order.updatedAt ? new Date(order.updatedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : createdFull;
  const updatedShort = order.updatedAt ? new Date(order.updatedAt).toLocaleDateString('vi-VN') : '';

  const step2Cls = isApproved ? 'is-done' : isCancelled ? 'is-cancelled' : 'is-active';
  const step2Dot = isApproved ? '✓' : isCancelled ? '×' : '2';
  const step2Label = isCancelled ? 'Đơn bị huỷ' : 'Sàn đối soát';
  const step3Cls = isApproved ? 'is-done' : '';
  const step3Dot = isApproved ? '✓' : '3';

  const noteCls = isApproved ? 'is-approved' : isCancelled ? 'is-cancelled' : 'is-pending';
  const noteText = isApproved
    ? 'Tiền hoàn đã được cộng vào số dư khả dụng trong Ví LiLa. Bạn có thể kiểm tra biến động số dư hoặc tạo lệnh rút khi đủ hạn mức.'
    : isCancelled
    ? escapeHtml(order.rejectReason || order.claimRejectReason || 'Đơn hàng bị hủy, hoàn trả hoặc không đủ điều kiện đối soát từ sàn.')
    : 'Đơn hàng đã được ghi nhận thành công. Sàn đang xác nhận đơn hoàn tất và không phát sinh trả hàng trước khi cộng tiền vào ví.';

  const orderAmtRow = Number(order.orderAmount) > 0
    ? `<div class="ord-detail-row"><span>Giá trị đơn hàng</span><strong>${fmtVnd(order.orderAmount)}</strong></div>`
    : '';
  const rateRow = Number(order.cashbackRate) > 0
    ? `<div class="ord-detail-row"><span>Tỷ lệ chia sẻ hoàn</span><strong>${Math.round(Number(order.cashbackRate))}% hoa hồng sàn</strong></div>`
    : '';

  const actionBtn = isApproved
    ? '<button type="button" class="btn btn-primary" data-nav="wallet">Đi tới Ví của tôi</button>'
    : '<button type="button" class="btn btn-outline" data-nav="guide">Xem quy trình đối soát</button>';

  const snEsc = escapeHtml(order.orderSn || '');
  body.innerHTML = `
    <div class="ord-detail-hero">
      <div class="ord-detail-hero-top">
        ${platBadge}
        <span class="status-badge ${stCls}"><span class="ord-status-icon">${stIcon}</span>${stLabel}</span>
      </div>
      <div class="ord-detail-amount ${cbToneCls}">${cbPrefix}${fmtVnd(order.userCashbackAmount)}</div>
      <div class="ord-detail-amount-sub">${cbSubLabel}</div>
    </div>

    <div class="ord-timeline" aria-label="Tiến trình đối soát">
      <div class="ord-step is-done">
        <span class="ord-step-dot">✓</span>
        <span class="ord-step-label">Ghi nhận đơn</span>
        <span class="ord-step-date">${createdShort}</span>
      </div>
      <div class="ord-step ${step2Cls}">
        <span class="ord-step-dot">${step2Dot}</span>
        <span class="ord-step-label">${step2Label}</span>
        <span class="ord-step-date">${isCancelled && updatedShort ? updatedShort : ''}</span>
      </div>
      <div class="ord-step ${step3Cls}">
        <span class="ord-step-dot">${step3Dot}</span>
        <span class="ord-step-label">Cộng vào ví</span>
        <span class="ord-step-date">${isApproved && updatedShort ? updatedShort : ''}</span>
      </div>
    </div>

    <div>
      <div class="ord-detail-section-title">Sản phẩm</div>
      <div class="ord-detail-product">${escapeHtml(order.productName || 'Đơn hàng mua sắm')}</div>
    </div>

    <div class="ord-detail-meta">
      <div class="ord-detail-row">
        <span>Mã đơn hàng</span>
        <strong class="ord-detail-sn-val">
          <span>#${snEsc}</span>
          <button type="button" class="ord-copy-sn-btn" data-copy-order-sn="${snEsc}" aria-label="Sao chép mã đơn ${snEsc}" title="Sao chép mã đơn">${ORD_COPY_SVG}</button>
        </strong>
      </div>
      <div class="ord-detail-row"><span>Ngày ghi nhận</span><strong>${createdFull}</strong></div>
      <div class="ord-detail-row"><span>Cập nhật gần nhất</span><strong>${updatedFull}</strong></div>
      ${orderAmtRow}
      ${rateRow}
    </div>

    <div class="ord-detail-note-box ${noteCls}">${noteText}</div>

    <div class="ord-detail-actions">
      ${actionBtn}
    </div>
  `;

  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-lock');
}

function syncOrderStatusCounts(orders, serverCounts = null) {
  let counts;
  if (serverCounts && typeof serverCounts === 'object') {
    counts = {
      all: Number(serverCounts.all || 0),
      pending: Number(serverCounts.pending || 0),
      approved: Number(serverCounts.approved || 0),
      cancelled: Number(serverCounts.cancelled || 0)
    };
    userOrderStatusCountsCache = counts;
  } else if (userOrderStatusCountsCache) {
    counts = userOrderStatusCountsCache;
  } else {
    const list = Array.isArray(orders) ? orders : [];
    counts = { all: list.length, pending: 0, approved: 0, cancelled: 0 };
    for (const o of list) {
      const st = String(o.status || 'pending').toLowerCase();
      if (st === 'approved') counts.approved += 1;
      else if (st === 'cancelled') counts.cancelled += 1;
      else counts.pending += 1;
    }
  }
  const setCnt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  setCnt('ordCountAll', counts.all);
  setCnt('ordCountPending', counts.pending);
  setCnt('ordCountApproved', counts.approved);
  setCnt('ordCountCancelled', counts.cancelled);
}

function renderUserOrdersTable(orders, serverCounts = null) {
  const ordBody = document.getElementById('userOrdersTableBody');
  if (!ordBody) return;
  const sourceOrders = Array.isArray(orders) ? orders : [];
  userOrdersCache = sourceOrders;
  syncOrderStatusCounts(sourceOrders, serverCounts);

  const filteredOrders =
    serverCounts || (activeOrderStatusFilter === 'all' && activeOrderPlatformFilter === 'all')
      ? sourceOrders
      : sourceOrders.filter((o) => {
          const st = String(o.status || 'pending').toLowerCase();
          const stOk =
            activeOrderStatusFilter === 'all'
              ? true
              : activeOrderStatusFilter === 'pending'
              ? st !== 'approved' && st !== 'cancelled'
              : st === activeOrderStatusFilter;
          const plat = String(o.platform || 'shopee').toLowerCase();
          const platOk = activeOrderPlatformFilter === 'all' || plat === activeOrderPlatformFilter;
          return stOk && platOk;
        });

  if (filteredOrders.length === 0) {
    const searchQuery = document.getElementById('userOrderSearchInput')?.value?.trim() || '';
    const isFilterEmpty =
      activeOrderStatusFilter !== 'all' || activeOrderPlatformFilter !== 'all' || Boolean(searchQuery);
    const emptyTitle = isFilterEmpty
      ? 'Không tìm thấy đơn hàng phù hợp'
      : 'Chưa có đơn hàng nào được ghi nhận';
    const emptyDesc = isFilterEmpty
      ? searchQuery
        ? `Không có đơn nào khớp với "${escapeHtml(searchQuery)}". Thử từ khóa khác hoặc xóa bộ lọc.`
        : 'Không có đơn hàng nào ở bộ lọc hiện tại.'
      : 'Đơn hàng đặt qua liên kết LiLa sẽ tự động đồng bộ lên hệ thống sau 12h–24h.';
    const emptyCta = isFilterEmpty
      ? '<button type="button" class="btn btn-outline btn-sm" id="resetOrderFiltersBtn">Xóa bộ lọc</button>'
      : '<button type="button" class="btn btn-primary btn-sm" data-nav="home">Dán link mua sắm ngay</button>';
    ordBody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center">
          <div class="table-empty-state">
            <span class="table-empty-icon" aria-hidden="true">${UI_ICONS.shoppingBagLg}</span>
            <strong>${emptyTitle}</strong>
            <p>${emptyDesc}</p>
            ${emptyCta}
          </div>
        </td>
      </tr>`;
    return;
  }
  ordBody.innerHTML = filteredOrders
    .map((o) => {
      const stCls = getStatusClass(o.status);
      const isApproved = o.status === 'approved';
      const isCancelled = o.status === 'cancelled';
      const stIcon = isApproved
        ? ORD_STATUS_ICONS.approved
        : isCancelled
        ? ORD_STATUS_ICONS.cancelled
        : ORD_STATUS_ICONS.pending;
      const stLabel = isApproved
        ? 'Đã cộng ví'
        : isCancelled
        ? 'Đã huỷ'
        : 'Đang đối soát';
      const plat = String(o.platform || '').toLowerCase();
      const platBadge =
        plat === 'tiktok'
          ? '<span class="plat-badge-inline tiktok">TikTok</span>'
          : '<span class="plat-badge-inline shopee">Shopee</span>';
      const dt = o.createdAt ? new Date(o.createdAt).toLocaleDateString('vi-VN') : '—';
      const orderAmtStr = Number(o.orderAmount) > 0 ? ` • ${fmtVnd(o.orderAmount)}` : '';
      const cbToneCls = isApproved ? 'is-approved' : isCancelled ? 'is-cancelled' : 'is-pending';
      const cbPrefix = isCancelled ? '' : '+';
      const snEsc = escapeHtml(o.orderSn || '');
      const ordIdEsc = escapeHtml(o.id || o.orderSn || '');
      const rejectNote = isCancelled && (o.rejectReason || o.claimRejectReason)
        ? `<div class="ord-context-note is-cancelled">${escapeHtml(o.rejectReason || o.claimRejectReason)}</div>`
        : '';
      return `
        <tr class="order-row-${stCls} order-card-clickable" data-order-detail-id="${ordIdEsc}">
          <td class="ord-col-id" data-label="Mã đơn">
            <div class="ord-top-meta">
              ${platBadge}
              <span class="ord-meta-sub">${dt}${orderAmtStr}</span>
            </div>
            <div class="ord-id-row">
              <strong>#${snEsc}</strong>
              <button type="button" class="ord-copy-sn-btn" data-copy-order-sn="${snEsc}" aria-label="Sao chép mã đơn ${snEsc}" title="Sao chép mã đơn">${ORD_COPY_SVG}</button>
            </div>
          </td>
          <td class="ord-col-product" data-label="Sản phẩm">
            <div class="ord-product-name">${escapeHtml(o.productName || 'Đơn hàng mua sắm')}</div>
            <div class="ord-sn-bar">
              <span class="ord-sn-code">#${snEsc}</span>
              <button type="button" class="ord-copy-sn-btn" data-copy-order-sn="${snEsc}" aria-label="Sao chép mã đơn ${snEsc}" title="Sao chép mã đơn">${ORD_COPY_SVG}</button>
            </div>
            ${rejectNote}
          </td>
          <td class="ord-col-cashback" data-label="Tiền hoàn">
            <span class="ord-cashback-right">
              <strong class="ord-cashback-val ${cbToneCls}">${cbPrefix}${fmtVnd(o.userCashbackAmount)}</strong>
              <span class="ord-chevron" aria-hidden="true">${ORD_CHEVRON_SVG}</span>
            </span>
          </td>
          <td class="ord-col-status" data-label="Trạng thái">
            <span class="status-badge ${stCls}"><span class="ord-status-icon">${stIcon}</span>${stLabel}</span>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadUserOrdersPage(page = 1) {
  if (!authToken) return;
  renderUserOrdersSkeleton();
  try {
    const q = document.getElementById('userOrderSearchInput')?.value?.trim() || '';
    const params = new URLSearchParams({
      orderPage: String(Math.max(1, Number(page) || 1)),
      orderLimit: String(USER_ORDERS_LIMIT)
    });
    if (q) params.set('q', q);
    if (activeOrderStatusFilter && activeOrderStatusFilter !== 'all') {
      params.set('orderStatus', activeOrderStatusFilter);
    }
    if (activeOrderPlatformFilter && activeOrderPlatformFilter !== 'all') {
      params.set('orderPlatform', activeOrderPlatformFilter);
    }
    const data = await apiFetch('/api/user/me?' + params.toString());
    if (data.user) {
      currentUser = data.user;
      updateBalancePrivacyDisplay();
    }
    const orders = data.orders || [];
    renderUserOrdersTable(orders, data.orderStatusCounts || null);
    const state = updateAdminPaginationUi({
      infoId: 'userOrdersPageInfo',
      prevBtnId: 'userOrdersPrevBtn',
      nextBtnId: 'userOrdersNextBtn',
      pagination: data.ordersPagination,
      fallbackTotal: orders.length,
      itemLabel: 'đơn'
    });
    userOrdersPage = state.page;
    userOrdersTotalPages = state.totalPages;
  } catch (err) {
    renderUserOrdersError(err.message);
    showToast(err.message);
  }
}

async function loadUserDashboard(prefetchedData = null) {
  if (!authToken) return;
  const refreshBtn = document.getElementById('refreshWalletBtn');
  const refreshOrdersBtn = document.getElementById('refreshOrdersBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Đang tải...';
  }
  if (refreshOrdersBtn) {
    refreshOrdersBtn.disabled = true;
    refreshOrdersBtn.classList.add('is-spinning');
  }
  try {
    const q = document.getElementById('userOrderSearchInput')?.value?.trim() || '';
    const params = new URLSearchParams({
      orderPage: String(userOrdersPage),
      ledgerPage: String(userLedgerPage),
      orderLimit: String(USER_ORDERS_LIMIT)
    });
    if (q) params.set('q', q);
    if (activeOrderStatusFilter && activeOrderStatusFilter !== 'all') {
      params.set('orderStatus', activeOrderStatusFilter);
    }
    if (activeOrderPlatformFilter && activeOrderPlatformFilter !== 'all') {
      params.set('orderPlatform', activeOrderPlatformFilter);
    }
    const data =
      prefetchedData && prefetchedData.user
        ? prefetchedData
        : await apiFetch('/api/user/me?' + params.toString());
    currentUser = data.user;
    updateNotificationBadge(data.unreadNotificationCount ?? 0);
    renderUserVipProgress(data.vipInfo, data.effectiveCashbackPercent);
    safeStorage.set(
      USER_KEY,
      JSON.stringify({
        code: currentUser.code,
        name: currentUser.name,
        role: currentUser.role
      })
    );
    syncAuthUi();

    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    setTxt('walletUserName', currentUser.name || '');
    updateBalancePrivacyDisplay();
    updateWithdrawProgressBar();
    syncAccountProfileUi();
    setTxt('userRefCount', data.referralCount || 0);

    const refInputEl = document.getElementById('userReferralLinkInput');
    if (refInputEl && currentUser.code) {
      refInputEl.value = `${window.location.origin}/?ref=${encodeURIComponent(currentUser.code)}`;
    }

    if (document.getElementById('view-account')?.classList.contains('active')) loadUserReferrals();

    if (currentUser.bankName && document.getElementById('wdBankName')) {
      if (currentUser.bankName !== 'MoMo') {
        walletPayoutState.lastBank = currentUser.bankName;
      }
      document.getElementById('wdBankName').value = currentUser.bankName;
    }
    if (currentUser.bankAccount && document.getElementById('wdBankAccount')) {
      document.getElementById('wdBankAccount').value = currentUser.bankAccount;
    }
    if (currentUser.bankOwner && document.getElementById('wdBankOwner')) {
      document.getElementById('wdBankOwner').value = currentUser.bankOwner;
    }
    if (currentUser.bankName === 'MoMo') {
      syncWithdrawalMethodUi('momo');
    } else {
      syncWithdrawalPasswordRequirement();
    }

    // Orders Table
    const orders = data.orders || [];
    renderUserOrdersTable(orders, data.orderStatusCounts || null);
    const ordPagState = updateAdminPaginationUi({
      infoId: 'userOrdersPageInfo',
      prevBtnId: 'userOrdersPrevBtn',
      nextBtnId: 'userOrdersNextBtn',
      pagination: data.ordersPagination,
      fallbackTotal: orders.length,
      itemLabel: 'đơn'
    });
    userOrdersPage = ordPagState.page;
    userOrdersTotalPages = ordPagState.totalPages;
    syncUserActivityNotifications(data);

    // Balance History Table
    const ledBody = document.getElementById('userLedgerTableBody');
    const ledger = data.ledger || [];
    const ledgerState = updateAdminPaginationUi({ infoId: 'userLedgerPageInfo', prevBtnId: 'userLedgerPrevBtn', nextBtnId: 'userLedgerNextBtn', pagination: data.ledgerPagination, fallbackTotal: ledger.length, itemLabel: 'giao dịch' });
    userLedgerPage = ledgerState.page;
    if (ledBody) {
      if (ledger.length === 0) {
        ledBody.innerHTML = `
          <tr>
            <td colspan="3" class="text-center">
              <div class="table-empty-state">
                <strong>Chưa có biến động số dư</strong>
                <p>Tiền hoàn từ các đơn hàng thành công và thưởng giới thiệu sẽ được ghi nhận chi tiết tại đây.</p>
              </div>
            </td>
          </tr>`;
      } else {
        ledBody.innerHTML = ledger
          .map((l) => {
            const isPos = Number(l.amount) >= 0;
            const color = isPos ? '#059669' : '#dc2626';
            const prefix = isPos ? '+' : '';
            const dt = l.createdAt ? new Date(l.createdAt).toLocaleDateString('vi-VN') : '—';
            return `
              <tr>
                <td data-label="Thời gian">${dt}</td>
                <td data-label="Nội dung">${escapeHtml(l.note)}</td>
                <td data-label="Số tiền"><strong style="color:${color};">${prefix}${fmtVnd(l.amount)}</strong></td>
              </tr>
            `;
          })
          .join('');
      }
    }

    // Withdrawals Table
    const wdBody = document.getElementById('userWithdrawalsTableBody');
    const wds = data.withdrawals || [];
    if (wdBody) {
      if (wds.length === 0) {
        wdBody.innerHTML = `
          <tr>
            <td colspan="4" class="text-center">
              <div class="table-empty-state">
                <strong>Chưa có lịch sử rút tiền</strong>
                <p>Khi số dư khả dụng đạt từ 50.000đ, bạn có thể gửi yêu cầu rút miễn phí về Ngân hàng hoặc MoMo.</p>
              </div>
            </td>
          </tr>`;
      } else {
        wdBody.innerHTML = wds
          .map((w) => {
            const stCls = getStatusClass(w.status);
            const stLabel =
              w.status === 'paid'
                ? 'Đã chuyển khoản'
                : w.status === 'rejected'
                ? 'Từ chối'
                : 'Chờ thanh toán';
            const dt = w.createdAt ? new Date(w.createdAt).toLocaleDateString('vi-VN') : '—';
            return `
              <tr>
                <td data-label="Ngày">${dt}</td>
                <td data-label="Số tiền"><strong>${fmtVnd(w.amount)}</strong></td>
                <td data-label="Tài khoản">${escapeHtml(w.bankName)} - ${escapeHtml(w.bankAccount)}</td>
                <td data-label="Trạng thái"><span class="status-badge ${stCls}">${stLabel}</span></td>
              </tr>
            `;
          })
          .join('');
      }
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Làm mới số dư';
    }
    if (refreshOrdersBtn) {
      refreshOrdersBtn.disabled = false;
      refreshOrdersBtn.classList.remove('is-spinning');
    }
  }
}

// ================= REFERRAL PROGRAM =================
async function loadUserReferrals() {
  if (!authToken || !currentUser) return;
  try {
    const data = await apiFetch('/api/user/referrals');
    if (!data) return;

    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    const myCode = (data.referralCode || currentUser.code || '').toUpperCase();
    setTxt('userMyRefCodeDisplay', myCode || '...');

    const refLink = `${window.location.origin}/?ref=${encodeURIComponent(myCode)}`;
    const refInput = document.getElementById('userReferralLinkInput');
    if (refInput) refInput.value = refLink;

    const totalCount = data.referralCount ?? data.stats?.totalFriends ?? 0;
    const completedCount = data.completedFriends ?? data.stats?.completedFriends ?? 0;
    const pendingCount = data.pendingFriends ?? data.stats?.pendingFriends ?? 0;
    const totalBonus = data.totalBountyEarned ?? data.stats?.totalBountyEarned ?? 0;

    setTxt('userRefCount', totalCount);
    setTxt('refTotalFriends', `${totalCount} người`);
    setTxt('refCompletedFriends', `${completedCount} người`);
    setTxt('refPendingFriends', `${pendingCount} người`);
    setTxt('refBonusEarned', fmtVnd(totalBonus));

    const tbody = document.getElementById('refFriendsTableBody');
    if (tbody) {
      const list = data.referrals || data.friends || [];
      if (list.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="5" class="text-center" style="padding:14px;color:#64748b;">Chưa có bạn bè nào đăng ký qua link của bạn. Hãy sao chép link và chia sẻ ngay!</td></tr>';
      } else {
        tbody.innerHTML = list
          .map((f, i) => {
            const isDone = f.status === 'completed';
            const badge = isDone
              ? `<span class="status-badge status-approved inline-icon-badge">${UI_ICONS.checkCircle}<span>Đã có đơn</span></span>`
              : `<span class="status-badge status-pending inline-icon-badge">${UI_ICONS.clock}<span>Chờ đơn đầu</span></span>`;
            const bonusText = isDone
              ? `<strong style="color:#16a34a;">+${fmtVnd(f.bonusEarned)}</strong>`
              : '<span style="color:#94a3b8;">0đ</span>';
            const dStr = f.createdAt ? new Date(f.createdAt).toLocaleDateString('vi-VN') : '-';
            return `
            <tr>
              <td data-label="STT">${i + 1}</td>
              <td data-label="SĐT bạn bè"><strong>${escapeHtml(f.maskedPhone)}</strong></td>
              <td data-label="Ngày tham gia">${dStr}</td>
              <td data-label="Trạng thái">${badge}</td>
              <td data-label="Tiền thưởng">${bonusText}</td>
            </tr>
          `;
          })
          .join('');
      }
    }
  } catch (err) {
    console.warn('loadUserReferrals error:', err);
  }
}

on('copyRefCodeBtn', 'click', () => {
  const code = document.getElementById('userMyRefCodeDisplay')?.textContent?.trim() || currentUser?.code;
  if (code && code !== '...') {
    copyText(code, `Đã sao chép mã giới thiệu: ${code}!`);
  }
});

on('copyRefLinkBtn', 'click', () => {
  const val = document.getElementById('userReferralLinkInput')?.value;
  const bountyText = fmtVnd(publicConfig.referralBountyAmount ?? 10000);
  if (val) copyText(val, `Đã sao chép link giới thiệu! Nhận ${bountyText} khi bạn bè hoàn thành đơn đầu tiên.`);
});

on('shareZaloBtn', 'click', () => {
  const refLink = document.getElementById('userReferralLinkInput')?.value;
  if (!refLink) return;
  const title = 'Mua Shopee & TikTok nhận tiền hoàn';
  const text = `Tớ đang dùng LiLa để nhận tiền hoàn khi mua sắm trên Shopee & TikTok! Bấm vào đây đăng ký cùng tớ nhé: ${refLink}`;

  if (navigator.share) {
    navigator.share({ title, text, url: refLink }).catch(() => {});
  } else {
    const zaloUrl = `https://zalo.me/share?url=${encodeURIComponent(refLink)}&title=${encodeURIComponent(text)}`;
    window.open(zaloUrl, '_blank', 'noopener,noreferrer');
  }
});

on('showRefQrBtn', 'click', () => {
  const refLink = document.getElementById('userReferralLinkInput')?.value;
  if (!refLink) return;
  const qrModal = document.getElementById('refQrModal');
  const qrImg = document.getElementById('refQrImg');
  const qrCodeText = document.getElementById('refQrCodeText');

  document.getElementById('refQrOfflineFallback')?.remove();
  if (qrImg) {
    qrImg.classList.remove('hidden');
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(refLink)}`;
  }
  if (qrCodeText && currentUser) {
    qrCodeText.textContent = currentUser.code || '';
  }
  qrModal?.classList.remove('hidden');
});

on('closeRefQrModalBtn', 'click', () => {
  document.getElementById('refQrModal')?.classList.add('hidden');
});
on('closeRefQrModalActionBtn', 'click', () => {
  document.getElementById('refQrModal')?.classList.add('hidden');
});

on('toggleRefFriendsBtn', 'click', () => {
  const panel = document.getElementById('refFriendsPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
});

function setReferralSheetOpen(isOpen) {
  const overlay = document.getElementById('referralSheetOverlay');
  const trigger = document.getElementById('openReferralSheetBtn');
  if (!overlay) return;
  overlay.classList.toggle('is-open', Boolean(isOpen));
  overlay.setAttribute('aria-modal', isOpen ? 'true' : 'false');
  if (trigger) {
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
  document.body.classList.toggle('sheet-lock', Boolean(isOpen));
}

on('openReferralSheetBtn', 'click', () => setReferralSheetOpen(true));
on('closeReferralSheetBtn', 'click', () => setReferralSheetOpen(false));
on('referralSheetOverlay', 'click', (e) => {
  if (e.target && e.target.id === 'referralSheetOverlay') {
    setReferralSheetOpen(false);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const refOverlay = document.getElementById('referralSheetOverlay');
    if (refOverlay && refOverlay.classList.contains('is-open')) {
      setReferralSheetOpen(false);
    }
    const wdOverlay = document.getElementById('withdrawSheetOverlay');
    if (wdOverlay && wdOverlay.classList.contains('is-open')) {
      setWithdrawSheetOpen(false);
    }
    const ordDetailOverlay = document.getElementById('orderDetailSheetOverlay');
    if (ordDetailOverlay && ordDetailOverlay.classList.contains('is-open')) {
      closeOrderDetailSheet();
    }
  }
});

on('refreshWalletBtn', 'click', () => { userLedgerPage = 1; loadUserDashboard(); });
on('userLedgerPrevBtn', 'click', () => { userLedgerPage = Math.max(1, userLedgerPage - 1); loadUserDashboard(); });
on('userLedgerNextBtn', 'click', () => { userLedgerPage++; loadUserDashboard(); });
on('userOrderSearchBtn', 'click', () => {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches) {
    document.getElementById('userOrderSearchInput')?.blur();
  }
  loadUserOrdersPage(1);
});
on('userOrderSearchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches) {
      e.target?.blur?.();
    }
    loadUserOrdersPage(1);
  }
});
on('userOrdersPrevBtn', 'click', () => {
  if (userOrdersPage > 1) loadUserOrdersPage(userOrdersPage - 1);
});
on('userOrdersNextBtn', 'click', () => {
  if (userOrdersPage < userOrdersTotalPages) loadUserOrdersPage(userOrdersPage + 1);
});

function askUserConfirm(message, title = 'Xác Nhận Yêu Cầu', options = {}) {
  const modal = document.getElementById('confirmActionModal');
  const titleEl = document.getElementById('confirmModalTitle');
  const iconEl = document.getElementById('confirmModalIcon');
  const msgEl = document.getElementById('confirmModalMessage');
  const okBtn = document.getElementById('confirmModalOkBtn');
  const cancelBtn = document.getElementById('confirmModalCancelBtn');
  const closeBtn = document.getElementById('closeConfirmModalBtn');

  if (!modal || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  const combinedText = `${title || ''} ${message || ''}`;
  let variant = options.variant || 'auto';
  if (variant === 'auto') {
    if (/xóa|hủy|từ chối|khóa|dọn rác|đặt lại số dư|reset/i.test(combinedText) && !/mở khóa/i.test(combinedText)) {
      variant = 'danger';
    } else if (/cảnh báo|chú ý|mở khóa/i.test(combinedText)) {
      variant = 'warning';
    } else {
      variant = 'success';
    }
  }

  if (iconEl) {
    iconEl.classList.remove('is-danger', 'is-warning', 'is-success', 'is-brand', 'is-info', 'is-indigo');
    if (variant === 'danger') {
      iconEl.classList.add('is-danger');
      iconEl.innerHTML = UI_ICONS.confirmAlert;
    } else if (variant === 'warning') {
      iconEl.classList.add('is-warning');
      iconEl.innerHTML = UI_ICONS.confirmAlert;
    } else {
      iconEl.classList.add('is-success');
      iconEl.innerHTML = UI_ICONS.confirmCheck;
    }
  }

  okBtn.classList.remove('btn-success', 'btn-danger', 'btn-warning', 'btn-primary');
  if (variant === 'danger') {
    okBtn.classList.add('btn-danger');
    okBtn.textContent = options.okText || (/xóa|dọn rác/i.test(combinedText) ? 'Xác nhận xóa' : 'Xác nhận');
  } else if (variant === 'warning') {
    okBtn.classList.add('btn-warning');
    okBtn.textContent = options.okText || 'Xác nhận';
  } else {
    okBtn.classList.add('btn-success');
    okBtn.textContent = options.okText || 'Xác nhận';
  }
  cancelBtn.textContent = options.cancelText || 'Hủy bỏ';

  return new Promise((resolve) => {
    if (titleEl) titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.remove('hidden');

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document?.removeEventListener('keydown', onEsc);
      resolve(result);
    };

    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => {
      if (e.target === modal) finish(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') finish(false);
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document?.addEventListener('keydown', onEsc);
    okBtn.focus?.();
  });
}

let isWithdrawalSubmitting = false;

async function handleSubmitWithdrawal(event) {
  event?.preventDefault();
  if (isWithdrawalSubmitting) return;
  if (!currentUser?.id) { showToast('Vui lòng đăng nhập trước khi rút tiền.'); return; }
  const submittingUserId = currentUser.id;
  const method = document.getElementById('wdMethod')?.value || 'bank';
  const bankName = document.getElementById('wdBankName')?.value?.trim() || '';
  const bankAccount = document.getElementById('wdBankAccount')?.value?.trim() || '';
  const bankOwner = document.getElementById('wdBankOwner')?.value?.trim() || '';
  const amountStr = (document.getElementById('withdrawAmountInput') || document.getElementById('wdAmount'))?.value?.trim() || '';
  const currentPassword = document.getElementById('wdCurrentPassword')?.value || '';

  const amount = Number(amountStr);
  const minAmount = numOr(publicConfig.minWithdrawAmount, 50000);
  const available = currentUser?.balanceAvailable || 0;

  const intentStorageKey = `hts_withdraw_intents_${submittingUserId}`;
  const fingerprint = JSON.stringify([method, bankName.trim(), bankAccount.replace(/\s+/g, ''), bankOwner.trim().toUpperCase(), amount]);
  let pendingIntentKey;
  try {
    pendingIntentKey = JSON.parse(safeStorage.get(intentStorageKey, sessionStorage) || '{}')?.[fingerprint];
  } catch { /* Storage is checked again before any request is sent. */ }

  if (!amountStr || isNaN(amount) || !Number.isInteger(amount) || amount <= 0) {
    showToast('Vui lòng nhập số tiền rút hợp lệ (số nguyên dương)!');
    return;
  }
  if (amount < minAmount) {
    showToast(`Số tiền rút tối thiểu là ${fmtVnd(minAmount)}.`);
    return;
  }
  if (amount > available && !pendingIntentKey) {
    showToast(`Số dư khả dụng (${fmtVnd(available)}) không đủ để rút ${fmtVnd(amount)}.`);
    return;
  }
  if (!bankName || !bankAccount || !bankOwner) {
    showToast('Vui lòng nhập đầy đủ thông tin tài khoản ngân hàng nhận tiền.');
    return;
  }

  if (syncWithdrawalPasswordRequirement() && !currentPassword) {
    showToast('Vui lòng nhập mật khẩu đăng nhập để xác nhận tài khoản nhận tiền.');
    document.getElementById('wdCurrentPassword')?.focus();
    return;
  }

  const btn = document.getElementById('submitWithdrawBtn');
  isWithdrawalSubmitting = true;
  if (btn) btn.disabled = true;
  // Each unresolved payload keeps its key across retries and reloads in this tab.
  // Passwords are never stored. Account identity isolates different logins.
  let intents;
  try {
    const ok = await askUserConfirm(
      `• Số tiền: ${fmtVnd(amount)}\n• Ngân hàng: ${bankName}\n• Số tài khoản: ${bankAccount}\n• Chủ tài khoản: ${bankOwner}\n\nBạn có chắc chắn muốn gửi yêu cầu rút tiền này không?`,
      'Xác Nhận Yêu Cầu Rút Tiền'
    );
    if (!ok || currentUser?.id !== submittingUserId || !authToken) return;
    intents = JSON.parse(safeStorage.get(intentStorageKey, sessionStorage) || '{}');
    if (!intents || typeof intents !== 'object' || Array.isArray(intents)) throw new Error('Không thể đọc trạng thái yêu cầu rút tiền.');
    const idempotencyKey = intents[fingerprint] || (
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    );
    intents[fingerprint] = idempotencyKey;
    if (!safeStorage.set(intentStorageKey, JSON.stringify(intents), sessionStorage)) {
      throw new Error('Không thể lưu trạng thái chống gửi trùng. Vui lòng cho phép lưu trữ trong trình duyệt rồi thử lại.');
    }
    if (btn) btn.textContent = 'Đang gửi yêu cầu...';
    const result = await apiFetch('/api/user/withdraw', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        method,
        bankName,
        bankAccount,
        bankOwner,
        amount,
        currentPassword
      })
    });
    if (!result?.withdrawal?.id) throw new Error('Chưa xác nhận được kết quả rút tiền. Vui lòng kiểm tra lịch sử hoặc gửi lại cùng thông tin.');
    // Only release the key after an acknowledged result. Network/HTTP errors keep it.
    delete intents[fingerprint];
    safeStorage.set(intentStorageKey, JSON.stringify(intents), sessionStorage);
    if (currentUser?.id !== submittingUserId || !authToken) return;
    const amtInput = document.getElementById('withdrawAmountInput') || document.getElementById('wdAmount');
    if (amtInput) amtInput.value = '';
    if (document.getElementById('wdCurrentPassword')) {
      document.getElementById('wdCurrentPassword').value = '';
    }
    showToast('Đã gửi yêu cầu rút tiền thành công!');
    await loadUserDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    isWithdrawalSubmitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Gửi Yêu Cầu Rút Tiền';
    }
  }
}

on('btnMaxWithdraw', 'click', () => {
  const available = currentUser?.balanceAvailable || 0;
  const amtInput = document.getElementById('withdrawAmountInput') || document.getElementById('wdAmount');
  if (amtInput) {
    amtInput.value = Math.floor(available);
  }
  const minAmount = numOr(publicConfig.minWithdrawAmount, 50000);
  if (available < minAmount) {
    showToast(`Số dư khả dụng (${fmtVnd(available)}) chưa đủ hạn mức rút tối thiểu (${fmtVnd(minAmount)}).`);
    return;
  }
  showToast(`Đã điền số dư tối đa: ${fmtVnd(Math.floor(available))}`);
});

// ================= ADMIN DASHBOARD =================
let latestAdminUsers = [];
let latestAdminOrders = [];
let currentAdminSettings = null;
const admOrdCommission = document.getElementById('admOrdCommission');
const admOrdPreview70 = document.getElementById('admOrdPreview70');

function updateAdminSplitPreview() {
  if (!admOrdCommission || !admOrdPreview70) return;
  const gross = Number(admOrdCommission.value || 0);
  const taxRate = numOr(document.getElementById('admTaxDeductPercent')?.value, 10);
  const cbRate = numOr(document.getElementById('admCashbackPercent')?.value, 70);
  const net = Math.round(gross * (1 - taxRate / 100));
  const userGet = Math.round((net * cbRate) / 100);
  const adminGet = net - userGet;
  admOrdPreview70.value = `Khách: ${fmtVnd(userGet)} | Bạn: ${fmtVnd(adminGet)}`;
}

if (admOrdCommission) {
  admOrdCommission.addEventListener('input', updateAdminSplitPreview);
}

function loadAdminSettings(settings) {
  const s = settings || {};
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  setVal('admShopeeMode', s.shopeeMode || 'an_redir');
  setVal('admShopeeAffiliateId', s.shopeeAffiliateId || '');
  setVal('admShopeeAppId', s.shopeeAppId || '');
  setVal('admShopeeAppSecret', s.shopeeAppSecret || '');
  setVal('admAddlivetagApiKey', s.addlivetagApiKey || '');
  setVal('admTiktokMode', s.tiktokMode || 'deeplink');
  setVal('admTiktokDeepLink', s.tiktokDeepLinkTemplate || '');
  setVal('admAccesstradeApiKey', s.accesstradeApiKey || '');
  setVal('admPostbackUrl', s.postbackUrlTemplate || '');
  setVal('admTaxDeductPercent', s.taxDeductPercent ?? 10);
  setVal('admCashbackPercent', s.cashbackPercent ?? 70);
  setVal('admMinWithdraw', s.minWithdrawAmount ?? 50000);
  setVal('admReferralBounty', s.referralBountyAmount ?? 10000);
  setVal('admShortener', s.shortenerProvider || 'none');
  setVal('admSupportZalo', s.supportZalo || '');
  setVal('admResendApiKey', s.resendApiKey || '');
  setVal('admMailFrom', s.mailFrom || '');
  setVal('admZaloGroupUrl', s.zaloGroupUrl || '');

  const zaloWidgetEl = document.getElementById('admZaloWidgetEnabled');
  if (zaloWidgetEl) {
    zaloWidgetEl.checked = s.zaloWidgetEnabled !== false;
  }
  const vipEnabledEl = document.getElementById('admVipTiersEnabled');
  if (vipEnabledEl) {
    vipEnabledEl.checked = s.vipTiersEnabled !== false;
  }
  renderAdminVipTiersTable(s.vipTiers || []);
}

const ADMIN_PAGE_LIMIT = 50;
let adminOrdersPage = 1;
let adminOrdersTotalPages = 1;
let adminUsersPage = 1;
let adminUsersTotalPages = 1;
let adminWithdrawalsPage = 1;
let adminWithdrawalsTotalPages = 1;
let latestAdminWithdrawals = [];

function updateAdminPaginationUi({ infoId, prevBtnId, nextBtnId, pagination, fallbackTotal, itemLabel }) {
  const page = Math.max(1, Number(pagination?.page) || 1);
  const total = Number.isFinite(Number(pagination?.total)) ? Number(pagination.total) : fallbackTotal;
  const totalPages = Math.max(1, Number(pagination?.totalPages) || 1);
  const infoEl = document.getElementById(infoId);
  if (infoEl) {
    infoEl.textContent = `Trang ${page} / ${totalPages} (${total} ${itemLabel})`;
  }
  const prevBtn = document.getElementById(prevBtnId);
  if (prevBtn) prevBtn.disabled = page <= 1;
  const nextBtn = document.getElementById(nextBtnId);
  if (nextBtn) nextBtn.disabled = page >= totalPages;
  return { page, totalPages };
}

const ADMIN_SVG = {
  check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  undo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  edit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
  qr: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/><line x1="21" y1="14" x2="21" y2="14.01"/><line x1="21" y1="21" x2="14" y2="21"/><line x1="21" y1="17" x2="21" y2="21"/></svg>',
  sliders: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
};

const ADMIN_TAB_PANES = {
  orders: 'admTabOrders',
  withdrawals: 'admTabWithdrawals',
  users: 'admTabUsers',
  settings: 'admTabSettings'
};

function switchAdminTab(tabKey) {
  if (!ADMIN_TAB_PANES[tabKey]) return;
  const tabBtns = document.querySelectorAll('[data-admin-tab]');
  if (tabBtns && tabBtns.forEach) {
    tabBtns.forEach((btn) => {
      const isMatch = btn.getAttribute('data-admin-tab') === tabKey;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute?.('aria-selected', isMatch ? 'true' : 'false');
    });
  }
  Object.entries(ADMIN_TAB_PANES).forEach(([key, paneId]) => {
    const pane = document.getElementById(paneId);
    if (pane) pane.classList.toggle('active', key === tabKey);
  });
}

(function bindAdminTabs() {
  const btns = document.querySelectorAll('[data-admin-tab]');
  if (btns && btns.forEach) {
    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        switchAdminTab(btn.getAttribute('data-admin-tab'));
      });
    });
  }
})();

function renderAdminOrdersTable(orders) {
  const ordTbody = document.getElementById('admOrdersTableBody');
  if (!ordTbody) return;
  if (!Array.isArray(orders) || orders.length === 0) {
    ordTbody.innerHTML =
      '<tr><td colspan="9" class="text-center">Chưa có đơn hàng nào.</td></tr>';
    return;
  }
  ordTbody.innerHTML = orders
    .map((o) => {
      const ordKey = escapeHtml(o.id || o.orderSn);
      const ordSnEsc = escapeHtml(o.orderSn);
      const plat = String(o.platform || 'shopee').toLowerCase() === 'tiktok' ? 'tiktok' : 'shopee';
      const platLabel = plat === 'tiktok' ? 'TikTok' : 'Shopee';
      const actionButtons =
        o.status === 'pending'
          ? `<button type="button" class="btn btn-success btn-xs btn-icon-svg" data-ord-action="approve" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Duyệt đơn và cộng tiền hoàn vào ví khách">${ADMIN_SVG.check}<span>Duyệt</span></button>
             <button type="button" class="btn btn-warning btn-xs btn-icon-svg" data-ord-action="cancel" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Hủy đơn này">${ADMIN_SVG.x}<span>Hủy</span></button>
             <button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-ord-action="edit" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Chỉnh sửa chi tiết & số tiền hoàn">${ADMIN_SVG.edit}<span>Sửa</span></button>
             <button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-ord-action="delete" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Xóa vĩnh viễn đơn này">${ADMIN_SVG.trash}<span>Xóa</span></button>`
          : o.status === 'approved'
          ? `<button type="button" class="btn btn-secondary btn-xs btn-icon-svg" data-ord-action="unapprove" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Hủy duyệt và thu hồi tiền hoàn về chờ duyệt">${ADMIN_SVG.undo}<span>Hủy duyệt</span></button>
             <button type="button" class="btn btn-warning btn-xs btn-icon-svg" data-ord-action="cancel" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Hủy đơn này">${ADMIN_SVG.x}<span>Hủy</span></button>
             <button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-ord-action="edit" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Chỉnh sửa">${ADMIN_SVG.edit}<span>Sửa</span></button>
             <button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-ord-action="delete" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Xóa vĩnh viễn">${ADMIN_SVG.trash}<span>Xóa</span></button>`
          : `<button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-ord-action="reopen" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Khôi phục về trạng thái chờ duyệt">${ADMIN_SVG.refresh}<span>Khôi phục</span></button>
             ${o.merchant || o.rejectReason ? `<button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-ord-action="reject-reason" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" data-ord-plat="${escapeHtml(plat)}" title="Xem lý do hủy đơn từ AccessTrade"><span>Lý do</span></button>` : ''}
             <button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-ord-action="edit" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Chỉnh sửa">${ADMIN_SVG.edit}<span>Sửa</span></button>
             <button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-ord-action="delete" data-ord-id="${ordKey}" data-ord-sn="${ordSnEsc}" title="Xóa vĩnh viễn">${ADMIN_SVG.trash}<span>Xóa</span></button>`;

      const dt = o.createdAt ? new Date(o.createdAt).toLocaleDateString('vi-VN') : '—';
      const stCls = getStatusClass(o.status);
      return `
        <tr>
          <td>${dt}</td>
          <td>
            <div><strong>${ordSnEsc}</strong></div>
            <span class="platform-pill ${plat}">${platLabel}</span>
          </td>
          <td><span style="font-weight:600;color:#2563eb;">${escapeHtml(
            o.userCode || 'GUEST'
          )}</span></td>
          <td>${escapeHtml(o.productName)}</td>
          <td><strong>${Number(o.orderAmount) > 0 ? fmtVnd(o.orderAmount) : '—'}</strong></td>
          <td><strong>${fmtVnd(o.grossCommission || o.totalCommission)}</strong></td>
          <td><strong style="color:#059669;">${fmtVnd(o.userCashbackAmount)}</strong></td>
          <td><span class="status-badge ${stCls}">${escapeHtml(o.status)}</span></td>
          <td><div class="admin-action-group">${actionButtons}</div></td>
        </tr>
      `;
    })
    .join('');
}

function renderAdminUsersTable(users) {
  const userTbody = document.getElementById('admUsersTableBody');
  if (!userTbody) return;
  if (!Array.isArray(users) || users.length === 0) {
    userTbody.innerHTML =
      '<tr><td colspan="6" class="text-center">Chưa có người dùng nào.</td></tr>';
    return;
  }
  userTbody.innerHTML = users
    .map((u) => {
      const lockBadge = u.accountLocked
        ? '<span class="status-badge st-cancelled">Đã khóa</span>'
        : '<span class="status-badge st-approved">Hoạt động</span>';
      const customRateBadge =
        u.customCashbackPercent !== null && u.customCashbackPercent !== undefined
          ? `<div style="margin-top:4px;"><span class="status-badge" style="background:#eef2ff;color:#4f46e5;">Hoàn riêng: ${escapeHtml(String(u.customCashbackPercent))}%</span></div>`
          : '';
      return `
        <tr>
          <td><strong>${escapeHtml(u.code)}</strong>${customRateBadge}</td>
          <td>
            <div>${escapeHtml(u.name || 'Chưa cập nhật')}</div>
            <div style="font-size:12px;color:#64748b;">${escapeHtml(u.phone)}</div>
          </td>
          <td><strong style="color:#059669;">${fmtVnd(u.balanceAvailable)}</strong></td>
          <td>${fmtVnd(u.balancePending)}</td>
          <td>${lockBadge}</td>
          <td>
            <button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-manage-user="${escapeHtml(
              u.id
            )}">${ADMIN_SVG.sliders}<span>Quản lý</span></button>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadAdminOrdersPage(page = 1) {
  try {
    const q = document.getElementById('admOrderSearchInput')?.value?.trim() || '';
    const status = document.getElementById('admOrderStatusFilter')?.value?.trim() || '';
    const params = new URLSearchParams({
      page: String(Math.max(1, Number(page) || 1)),
      limit: String(ADMIN_PAGE_LIMIT)
    });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const data = await apiFetch('/api/admin/orders?' + params.toString());
    latestAdminOrders = data.orders || [];
    renderAdminOrdersTable(latestAdminOrders);
    const state = updateAdminPaginationUi({
      infoId: 'admOrdersPageInfo',
      prevBtnId: 'admOrdersPrevBtn',
      nextBtnId: 'admOrdersNextBtn',
      pagination: data.pagination,
      fallbackTotal: latestAdminOrders.length,
      itemLabel: 'đơn'
    });
    adminOrdersPage = state.page;
    adminOrdersTotalPages = state.totalPages;
  } catch (err) {
    showToast(err.message);
  }
}

async function loadAdminUsersPage(page = 1) {
  try {
    const q = document.getElementById('admUserSearchInput')?.value?.trim() || '';
    const params = new URLSearchParams({
      page: String(Math.max(1, Number(page) || 1)),
      limit: String(ADMIN_PAGE_LIMIT)
    });
    if (q) params.set('q', q);
    const data = await apiFetch('/api/admin/users?' + params.toString());
    latestAdminUsers = data.users || [];
    renderAdminUsersTable(latestAdminUsers);
    const state = updateAdminPaginationUi({
      infoId: 'admUsersPageInfo',
      prevBtnId: 'admUsersPrevBtn',
      nextBtnId: 'admUsersNextBtn',
      pagination: data.pagination,
      fallbackTotal: latestAdminUsers.length,
      itemLabel: 'tài khoản'
    });
    adminUsersPage = state.page;
    adminUsersTotalPages = state.totalPages;
  } catch (err) {
    showToast(err.message);
  }
}

function renderAdminWithdrawalsTable(withdrawals) {
  const wdTbody = document.getElementById('admWithdrawalsTableBody');
  if (!wdTbody) return;
  if (!Array.isArray(withdrawals) || withdrawals.length === 0) {
    wdTbody.innerHTML =
      '<tr><td colspan="6" class="text-center">Chưa có lệnh rút tiền nào.</td></tr>';
    return;
  }
  wdTbody.innerHTML = withdrawals
    .map((w) => {
      const qrBtnHtml = w.vietQrUrl
        ? `<button type="button" class="btn btn-outline btn-xs btn-icon-svg" data-vietqr="${escapeHtml(
            w.vietQrUrl
          )}" data-vietqr-info="Chuyển ${fmtVnd(w.amount)} tới ${escapeHtml(
            w.bankName
          )} - ${escapeHtml(w.bankAccount)} (${escapeHtml(
            w.bankOwner
          )})" style="background:#eff6ff;color:#1e40af;border-color:#bfdbfe;">${ADMIN_SVG.qr}<span>Mã QR Chuyển Tiền</span></button>`
        : '';

      const wdActions =
        w.status === 'pending'
          ? `<button type="button" class="btn btn-success btn-xs btn-icon-svg" data-wd-action="paid" data-wd-id="${escapeHtml(
              w.id
            )}">${ADMIN_SVG.check}<span>Đã chuyển</span></button>
             <button type="button" class="btn btn-danger btn-xs btn-icon-svg" data-wd-action="rejected" data-wd-id="${escapeHtml(
               w.id
             )}">${ADMIN_SVG.x}<span>Từ chối</span></button>
             <button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-wd-delete="${escapeHtml(
               w.id
             )}">${ADMIN_SVG.trash}<span>Lưu trữ</span></button>`
          : w.status === 'rejected' || w.status === 'cancelled'
          ? `<button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-wd-delete="${escapeHtml(
              w.id
            )}">${ADMIN_SVG.trash}<span>Lưu trữ</span></button>`
          : '<span style="color:#94a3b8;font-size:12px;">Hoàn tất</span>';

      const dt = w.createdAt ? new Date(w.createdAt).toLocaleDateString('vi-VN') : '—';
      const stCls = getStatusClass(w.status);
      return `
        <tr>
          <td>${dt}</td>
          <td><strong>${escapeHtml(w.userCode || w.userId)}</strong></td>
          <td><strong style="color:#059669;">${fmtVnd(w.amount)}</strong></td>
          <td>
            <div>${escapeHtml(w.bankName)} - <strong>${escapeHtml(
        w.bankAccount
      )}</strong></div>
            <div style="font-size:12px;color:#64748b;">${escapeHtml(w.bankOwner)}</div>
            <div style="margin-top:4px;">${qrBtnHtml}</div>
          </td>
          <td><span class="status-badge ${stCls}">${escapeHtml(w.status)}</span></td>
          <td><div class="admin-action-group">${wdActions}</div></td>
        </tr>
      `;
    })
    .join('');
}

async function loadAdminWithdrawalsPage(page = 1) {
  try {
    const q = document.getElementById('admWithdrawalSearchInput')?.value?.trim() || '';
    const status = document.getElementById('admWithdrawalStatusFilter')?.value?.trim() || '';
    const params = new URLSearchParams({
      page: String(Math.max(1, Number(page) || 1)),
      limit: String(ADMIN_PAGE_LIMIT)
    });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const data = await apiFetch('/api/admin/withdrawals?' + params.toString());
    latestAdminWithdrawals = data.withdrawals || [];
    renderAdminWithdrawalsTable(latestAdminWithdrawals);
    const state = updateAdminPaginationUi({
      infoId: 'admWithdrawalsPageInfo',
      prevBtnId: 'admWithdrawalsPrevBtn',
      nextBtnId: 'admWithdrawalsNextBtn',
      pagination: data.pagination,
      fallbackTotal: latestAdminWithdrawals.length,
      itemLabel: 'lệnh rút'
    });
    adminWithdrawalsPage = state.page;
    adminWithdrawalsTotalPages = state.totalPages;
  } catch (err) {
    showToast(err.message);
  }
}

async function loadAdminDashboard() {
  await ensureAdminAssetsLoaded();
  const previousPages = { orders: adminOrdersPage, users: adminUsersPage, withdrawals: adminWithdrawalsPage };
  try {
    const data = await apiFetch('/api/admin/dashboard');
    const st = data.stats || {};
    const s = data.settings || {};
    currentAdminSettings = s;
    latestAdminOrders = data.orders || [];
    latestAdminUsers = data.users || [];
    latestAdminWithdrawals = data.withdrawals || [];
    const dashPag = data.pagination || {};
    const ordPagState = updateAdminPaginationUi({
      infoId: 'admOrdersPageInfo',
      prevBtnId: 'admOrdersPrevBtn',
      nextBtnId: 'admOrdersNextBtn',
      pagination: data.ordersPagination || (dashPag.ordersTotalPages ? {
        page: dashPag.page || 1,
        total: dashPag.totalOrders,
        totalPages: dashPag.ordersTotalPages
      } : null),
      fallbackTotal: latestAdminOrders.length,
      itemLabel: 'đơn'
    });
    adminOrdersPage = ordPagState.page;
    adminOrdersTotalPages = ordPagState.totalPages;
    const wdPagState = updateAdminPaginationUi({
      infoId: 'admWithdrawalsPageInfo',
      prevBtnId: 'admWithdrawalsPrevBtn',
      nextBtnId: 'admWithdrawalsNextBtn',
      pagination: data.withdrawalsPagination || (dashPag.withdrawalsTotalPages ? {
        page: dashPag.page || 1,
        total: dashPag.totalWithdrawals,
        totalPages: dashPag.withdrawalsTotalPages
      } : null),
      fallbackTotal: latestAdminWithdrawals.length,
      itemLabel: 'lệnh rút'
    });
    adminWithdrawalsPage = wdPagState.page;
    adminWithdrawalsTotalPages = wdPagState.totalPages;
    const usrPagState = updateAdminPaginationUi({
      infoId: 'admUsersPageInfo',
      prevBtnId: 'admUsersPrevBtn',
      nextBtnId: 'admUsersNextBtn',
      pagination: data.usersPagination || (dashPag.usersTotalPages ? {
        page: dashPag.page || 1,
        total: dashPag.totalUsers,
        totalPages: dashPag.usersTotalPages
      } : null),
      fallbackTotal: latestAdminUsers.length,
      itemLabel: 'tài khoản'
    });
    adminUsersPage = usrPagState.page;
    adminUsersTotalPages = usrPagState.totalPages;
    const dbStatus = data.dbStatus || {};

    const dbTextEl = document.getElementById('admDbStatusText');
    if (dbTextEl) {
      dbTextEl.classList?.remove('db-warn');
      if (dbStatus.mode === 'postgres') {
        dbTextEl.textContent = 'Cloud PostgreSQL đã kết nối — Dữ liệu bền vững';
        dbTextEl.style.color = '#86efac';
      } else if (dbStatus.mode === 'ephemeral_tmp') {
        dbTextEl.textContent =
          'Cảnh báo: Đang chạy bộ nhớ tạm (/tmp) trên Vercel — Hãy gắn DATABASE_URL trong Vercel Settings.';
        dbTextEl.style.color = '#fde68a';
        dbTextEl.classList?.add('db-warn');
      } else {
        dbTextEl.textContent = 'Chế độ Local JSON (Lưu trên ổ cứng máy tính)';
        dbTextEl.style.color = '#86efac';
      }
    }

    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };

    setTxt('admTotalComm', fmtVnd(st.totalCommission || 0));
    setTxt('admUserShare', fmtVnd(st.totalUserCashback || 0));
    setTxt('admProfit', fmtVnd(st.totalAdminProfit || 0));
    setTxt('admUsersOrders', `${st.totalUsers || 0} / ${st.totalOrders || 0}`);
    setTxt('admTabOrdersBadge', String(st.totalOrders ?? latestAdminOrders.length));
    setTxt('admTabWithdrawalsBadge', String(st.pendingWithdrawals ?? 0));
    setTxt('admTabUsersBadge', String(st.totalUsers ?? latestAdminUsers.length));

    const settingsHint = document.querySelector?.('#admTabSettings .save-bar-hint');
    if (settingsHint?.textContent !== 'Có thay đổi chưa lưu') loadAdminSettings(s);

    // Orders Table
    renderAdminOrdersTable(latestAdminOrders);

    // Withdrawals Table
    renderAdminWithdrawalsTable(latestAdminWithdrawals);

    // Users Table
    renderAdminUsersTable(latestAdminUsers);
    // Preserve the active filters and pages after a mutation or manual refresh.
    const hasValue = id => Boolean(document.getElementById(id)?.value?.trim());
    await Promise.all([
      previousPages.orders > 1 || hasValue('admOrderSearchInput') || hasValue('admOrderStatusFilter')
        ? loadAdminOrdersPage(previousPages.orders) : Promise.resolve(),
      previousPages.users > 1 || hasValue('admUserSearchInput')
        ? loadAdminUsersPage(previousPages.users) : Promise.resolve(),
      previousPages.withdrawals > 1 || hasValue('admWithdrawalSearchInput') || hasValue('admWithdrawalStatusFilter')
        ? loadAdminWithdrawalsPage(previousPages.withdrawals) : Promise.resolve()
    ]);
  } catch (err) {
    showToast(err.message);
  }
}

// Prevent browser password managers from autofilling saved admin usernames into search bars.
['admOrderSearchInput', 'admWithdrawalSearchInput', 'admUserSearchInput'].forEach((id) => {
  const unlock = (e) => {
    if (e.currentTarget && e.currentTarget.readOnly) e.currentTarget.readOnly = false;
  };
  on(id, 'pointerdown', unlock);
  on(id, 'focus', unlock);
});

on('refreshAdminBtn', 'click', loadAdminDashboard);
on('admOrderSearchBtn', 'click', () => loadAdminOrdersPage(1));
on('admOrderSearchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadAdminOrdersPage(1);
  }
});
on('admOrderStatusFilter', 'change', () => loadAdminOrdersPage(1));
on('admOrdersPrevBtn', 'click', () => {
  if (adminOrdersPage > 1) loadAdminOrdersPage(adminOrdersPage - 1);
});
on('admOrdersNextBtn', 'click', () => {
  if (adminOrdersPage < adminOrdersTotalPages) loadAdminOrdersPage(adminOrdersPage + 1);
});

on('admUserSearchBtn', 'click', () => loadAdminUsersPage(1));
on('admUserSearchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadAdminUsersPage(1);
  }
});
on('admUsersPrevBtn', 'click', () => {
  if (adminUsersPage > 1) loadAdminUsersPage(adminUsersPage - 1);
});
on('admUsersNextBtn', 'click', () => {
  if (adminUsersPage < adminUsersTotalPages) loadAdminUsersPage(adminUsersPage + 1);
});

on('admWithdrawalSearchBtn', 'click', () => loadAdminWithdrawalsPage(1));
on('admWithdrawalSearchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadAdminWithdrawalsPage(1);
  }
});
on('admWithdrawalStatusFilter', 'change', () => loadAdminWithdrawalsPage(1));
on('admWithdrawalsPrevBtn', 'click', () => {
  if (adminWithdrawalsPage > 1) loadAdminWithdrawalsPage(adminWithdrawalsPage - 1);
});
on('admWithdrawalsNextBtn', 'click', () => {
  if (adminWithdrawalsPage < adminWithdrawalsTotalPages) loadAdminWithdrawalsPage(adminWithdrawalsPage + 1);
});

on('syncShopeeNowBtn', 'click', async () => {
  const btn = document.getElementById('syncShopeeNowBtn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang đồng bộ...';
  }
  try {
    const res = await apiFetch('/api/admin/sync-shopee', { method: 'POST', body: '{}' });
    const warn = res.errors && res.errors.length ? ` (${res.errors.join(' | ')})` : '';
    showToast(`Đã đồng bộ tự động ${res.syncedCount || 0} đơn hàng!${warn}`);
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || 'Đồng bộ đơn tự động';
    }
  }
});

on('cleanTestDataBtn', 'click', async () => {
  const btn = document.getElementById('cleanTestDataBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Đang kiểm tra...'; }
  try {
    const res = await apiFetch('/api/admin/cleanup-test-data', { method: 'POST', body: '{}' });
    showToast(res.message);
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Kiểm tra dữ liệu thử'; }
  }
});

on('copyPostbackUrlBtn', 'click', async () => {
  const input = document.getElementById('admPostbackUrl');
  let val = input?.value || '';
  try {
    const res = await apiFetch('/api/admin/reveal-postback-url');
    if (res && res.postbackUrl) {
      val = res.postbackUrl;
      if (input) input.value = val;
    }
  } catch (_) {}
  if (!val) return;
  copyText(val, 'Đã sao chép Link Postback AccessTrade (kèm Token thật)!');
});

async function saveAdminSettings() {
  const btn = document.getElementById('saveAdminSettingsBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang lưu cấu hình...';
  }
  try {
    const zaloWidgetCheckbox = document.getElementById('admZaloWidgetEnabled');
    const zaloWidgetEnabled = zaloWidgetCheckbox ? Boolean(zaloWidgetCheckbox.checked) : true;
    const zaloGroupUrl = document.getElementById('admZaloGroupUrl')?.value?.trim() || '';
    const newAdminPassword = document.getElementById('admNewPass')?.value?.trim() || '';
    const currentPassword = document.getElementById('admCurrentPass')?.value || '';

    if (newAdminPassword && !currentPassword) {
      showToast('Vui lòng nhập Mật khẩu Admin hiện tại để đổi mật khẩu mới!');
      document.getElementById('admCurrentPass')?.focus?.();
      return;
    }

    const payload = {
      shopeeMode: document.getElementById('admShopeeMode')?.value,
      shopeeAffiliateId: document.getElementById('admShopeeAffiliateId')?.value?.trim() || '',
      shopeeAppId: document.getElementById('admShopeeAppId')?.value?.trim() || '',
      shopeeAppSecret: document.getElementById('admShopeeAppSecret')?.value?.trim() || '',
      addlivetagApiKey: document.getElementById('admAddlivetagApiKey')?.value?.trim() || '',
      tiktokMode: document.getElementById('admTiktokMode')?.value,
      tiktokDeepLinkTemplate:
        document.getElementById('admTiktokDeepLink')?.value?.trim() || '',
      accesstradeApiKey: document.getElementById('admAccesstradeApiKey')?.value?.trim() || '',
      taxDeductPercent: numOr(
        document.getElementById('admTaxDeductPercent')?.value,
        currentAdminSettings?.taxDeductPercent ?? 10
      ),
      cashbackPercent: numOr(
        document.getElementById('admCashbackPercent')?.value,
        currentAdminSettings?.cashbackPercent ?? 70
      ),
      minWithdrawAmount: numOr(
        document.getElementById('admMinWithdraw')?.value,
        currentAdminSettings?.minWithdrawAmount ?? 50000
      ),
      referralBountyAmount: numOr(
        document.getElementById('admReferralBounty')?.value,
        currentAdminSettings?.referralBountyAmount ?? 0
      ),
      shortenerProvider: document.getElementById('admShortener')?.value || 'none',
      supportZalo: document.getElementById('admSupportZalo')?.value?.trim() || '',
      resendApiKey: document.getElementById('admResendApiKey')?.value?.trim() || '',
      mailFrom: document.getElementById('admMailFrom')?.value?.trim() || '',
      zaloGroupUrl,
      zaloWidgetEnabled,
      currentPassword,
      newAdminPassword
    };

    const res = await apiFetch('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (document.getElementById('admCurrentPass')) document.getElementById('admCurrentPass').value = '';
    if (document.getElementById('admNewPass')) document.getElementById('admNewPass').value = '';
    showToast('Đã lưu cấu hình hệ thống thành công!');
    const saveHint = document.querySelector?.('#admTabSettings .save-bar-hint');
    if (saveHint) saveHint.textContent = 'Đã lưu cấu hình';
    await initPublicConfig();
    if (typeof applyZaloWidget === 'function') {
      applyZaloWidget(publicConfig);
    }
    await loadAdminDashboard();
    return res;
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Lưu Cấu Hình';
    }
  }
}

on('saveAdminSettingsBtn', 'click', saveAdminSettings);

on('admSaveOrderBtn', 'click', async () => {
  const btn = document.getElementById('admSaveOrderBtn');
  const orderSn = document.getElementById('admOrdSn')?.value?.trim() || '';
  const userCode = document.getElementById('admOrdUserCode')?.value?.trim() || '';
  const platform = document.getElementById('admOrdPlatform')?.value || 'shopee';
  const productName = document.getElementById('admOrdProduct')?.value?.trim() || '';
  const orderAmount = Number(document.getElementById('admOrdAmount')?.value || 0);
  const totalCommission = Number(document.getElementById('admOrdCommission')?.value || 0);
  const status = document.getElementById('admOrdStatus')?.value || 'pending';

  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang lưu...';
  }

  try {
    await apiFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        orderSn,
        userCode,
        platform,
        productName,
        orderAmount,
        totalCommission,
        status
      })
    });
    if (document.getElementById('admOrdSn')) document.getElementById('admOrdSn').value = '';
    if (document.getElementById('admOrdCommission')) {
      document.getElementById('admOrdCommission').value = '';
    }
    showToast('Đã lưu đơn hàng & cập nhật số dư!');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || 'Lưu Đơn Hàng';
    }
  }
});

// Admin View delegation for Orders and Withdrawals actions
const viewAdmin = document.getElementById('view-admin');
if (viewAdmin) {
  viewAdmin.addEventListener('click', async (e) => {
    const ordActionBtn = e.target.closest('[data-ord-action]');
    if (ordActionBtn) {
      const action = ordActionBtn.getAttribute('data-ord-action');
      const orderId = ordActionBtn.getAttribute('data-ord-id');
      const orderSn = ordActionBtn.getAttribute('data-ord-sn');
      const order = latestAdminOrders.find((o) => orderId ? (o.id || o.orderSn) === orderId : o.orderSn === orderSn);

      if (action === 'approve') {
        ordActionBtn.disabled = true;
        try {
          await apiFetch('/api/admin/orders', {
            method: 'POST',
            body: JSON.stringify({ id: order?.id, orderSn, status: 'approved' })
          });
          showToast(`Đã duyệt đơn #${orderSn} và cộng tiền hoàn vào ví khách!`);
          await loadAdminDashboard();
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }

      if (action === 'unapprove') {
        ordActionBtn.disabled = true;
        try {
          await apiFetch('/api/admin/orders', {
            method: 'POST',
            body: JSON.stringify({ id: order?.id, orderSn, status: 'pending' })
          });
          showToast(`Đã hủy duyệt đơn #${orderSn}, tiền hoàn đã chuyển về Chờ duyệt!`);
          await loadAdminDashboard();
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }

      if (action === 'cancel') {
        const confirmed = await askUserConfirm(
          `Xác nhận hủy đơn hàng #${orderSn}? Tiền hoàn sẽ không được cộng vào ví khách.`,
          'Xác Nhận Hủy Đơn Hàng'
        );
        if (!confirmed) {
          return;
        }
        ordActionBtn.disabled = true;
        try {
          await apiFetch('/api/admin/orders', {
            method: 'POST',
            body: JSON.stringify({ id: order?.id, orderSn, status: 'cancelled' })
          });
          showToast(`Đã chuyển đơn #${orderSn} sang trạng thái Đã huỷ!`);
          await loadAdminDashboard();
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }

      if (action === 'reopen') {
        ordActionBtn.disabled = true;
        try {
          await apiFetch('/api/admin/orders', {
            method: 'POST',
            body: JSON.stringify({ id: order?.id, orderSn, status: 'pending' })
          });
          showToast(`Đã khôi phục đơn #${orderSn} về Chờ duyệt!`);
          await loadAdminDashboard();
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }

      if (action === 'edit') {
        if (order) {
          openOrderEditModal(order);
        }
        return;
      }

      if (action === 'reject-reason') {
        const plat = ordActionBtn.getAttribute('data-ord-plat') || order?.platform || 'tiktok';
        ordActionBtn.disabled = true;
        try {
          const info = await apiFetch(
            `/api/admin/orders/${encodeURIComponent(orderSn)}/accesstrade-details?platform=${encodeURIComponent(plat)}`
          );
          const sourceLabel = info.cached ? '(Đã lưu trong DB)' : '(Tra cứu mới từ AccessTrade)';
          const merchantLine = info.merchant ? `Merchant: ${info.merchant}\n` : '';
          await askUserConfirm(
            `Đơn #${orderSn} ${sourceLabel}\n${merchantLine}Lý do hủy: ${info.rejectReason || 'Không có thông tin chi tiết.'}`,
            'Lý Do Hủy Đơn AccessTrade',
            { variant: 'info' }
          );
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }

      if (action === 'delete') {
        const confirmed = await askUserConfirm(
          `Bạn có chắc chắn muốn xóa vĩnh viễn đơn hàng #${orderSn} không?\nTiền hoàn của đơn sẽ bị xóa khỏi ví người dùng.`,
          'Xóa Vĩnh Viễn Đơn Hàng'
        );
        if (!confirmed) {
          return;
        }
        ordActionBtn.disabled = true;
        try {
          await apiFetch('/api/admin/orders/delete', {
            method: 'POST',
            body: JSON.stringify({ id: order?.id, orderSn, platform: order?.platform })
          });
          showToast(`Đã xóa vĩnh viễn đơn hàng #${orderSn}!`);
          await loadAdminDashboard();
        } catch (err) {
          showToast(err.message);
        } finally {
          ordActionBtn.disabled = false;
        }
        return;
      }
    }

    const wdBtn = e.target.closest('[data-wd-action]');
    if (wdBtn) {
      const id = wdBtn.getAttribute('data-wd-id');
      const status = wdBtn.getAttribute('data-wd-action');
      const label = status === 'paid' ? 'ĐÃ CHUYỂN TIỀN' : 'TỪ CHỐI';
      const withdrawal = latestAdminWithdrawals.find(item => item.id === id);
      const recipient = withdrawal ? `\n${fmtVnd(withdrawal.amount)} · ${withdrawal.bankName}\n${withdrawal.bankAccount} · ${withdrawal.bankOwner}` : '';
      const confirmed = await askUserConfirm(
        `Xác nhận đánh dấu ${label} cho yêu cầu rút tiền #${id}?${recipient}`,
        'Cập Nhật Lệnh Rút Tiền'
      );
      if (!confirmed) {
        return;
      }
      wdBtn.disabled = true;
      try {
        await apiFetch('/api/admin/withdrawals/update', {
          method: 'POST',
          body: JSON.stringify({ id, status })
        });
        showToast('Đã cập nhật trạng thái rút tiền!');
        await loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      } finally {
        wdBtn.disabled = false;
      }
      return;
    }

    const wdDeleteBtn = e.target.closest('[data-wd-delete]');
    if (wdDeleteBtn) {
      const id = wdDeleteBtn.getAttribute('data-wd-delete');
      const confirmed = await askUserConfirm(
        `Lưu trữ yêu cầu rút tiền #${id}?\nNếu lệnh đang chờ duyệt, tiền sẽ được hoàn lại vào ví khách. Lệnh được ẩn khỏi danh sách nhưng lịch sử đối soát vẫn được giữ.`,
        'Lưu Trữ Yêu Cầu Rút Tiền'
      );
      if (!confirmed) {
        return;
      }
      wdDeleteBtn.disabled = true;
      try {
        await apiFetch('/api/admin/withdrawals/delete', {
          method: 'POST',
          body: JSON.stringify({ id, hardDelete: true })
        });
        showToast('Đã lưu trữ yêu cầu rút tiền!');
        await loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      } finally {
        wdDeleteBtn.disabled = false;
      }
      return;
    }

    const manageUserBtn = e.target.closest('[data-manage-user]');
    if (manageUserBtn) {
      const uid = manageUserBtn.getAttribute('data-manage-user');
      const targetUser = latestAdminUsers.find((u) => u.id === uid);
      if (targetUser) {
        openUserManageModal(targetUser);
      }
    }
  });
}

// Admin User Management Modal Functions
const userManageModal = document.getElementById('userManageModal');
let currentManagingUser = null;

function openUserManageModal(user) {
  currentManagingUser = user;
  if (!userManageModal) return;
  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };

  if (document.getElementById('manageUserId')) {
    document.getElementById('manageUserId').value = user.id;
  }
  setTxt('manageUserCode', user.code);
  setTxt('manageUserName', user.name || 'Chưa cập nhật');
  setTxt('manageUserPhone', user.phone);
  setTxt('manageUserBalance', fmtVnd(user.balanceAvailable));

  const statusEl = document.getElementById('manageUserStatus');
  if (statusEl) {
    statusEl.innerHTML = user.accountLocked
      ? '<span class="status-badge st-cancelled">Đang bị khóa (Chặn đăng nhập &amp; rút tiền)</span>'
      : '<span class="status-badge st-approved">Đang hoạt động bình thường</span>';
  }

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  setVal('manageNewPassword', '');
  clearManageResetResult();
  resetPasswordVisibility(userManageModal);
  setVal('manageAdjustAmount', '');
  setVal('manageAdjustNote', '');
  setVal(
    'manageCustomCashbackRate',
    user.customCashbackPercent !== null && user.customCashbackPercent !== undefined
      ? String(user.customCashbackPercent)
      : ''
  );

  const lockBtn = document.getElementById('btnToggleUserLock');
  if (lockBtn) {
    lockBtn.innerHTML = user.accountLocked
      ? `${UI_ICONS.unlock}<span>Mở Khóa Tài Khoản</span>`
      : `${UI_ICONS.lock}<span>Khóa Tài Khoản Này</span>`;
    lockBtn.className = user.accountLocked
      ? 'btn btn-success btn-sm btn-icon-svg'
      : 'btn btn-outline btn-sm btn-icon-svg';
  }

  userManageModal.classList.remove('hidden');
}

let lastAdminResetTempPwd = '';

function clearManageResetResult() {
  lastAdminResetTempPwd = '';
  const box = document.getElementById('manageResetResultBox');
  const valEl = document.getElementById('manageResetPwdValue');
  if (valEl) valEl.textContent = '';
  if (box) box.classList.add('hidden');
}

on('closeUserManageModalBtn', 'click', () => {
  clearManageResetResult();
  resetPasswordVisibility(userManageModal);
  userManageModal?.classList.add('hidden');
});

on('btnCopyResetPwd', 'click', () => {
  if (!lastAdminResetTempPwd) return;
  copyText(lastAdminResetTempPwd, 'Đã sao chép mật khẩu tạm!');
});

on('btnCopyResetMsg', 'click', () => {
  if (!lastAdminResetTempPwd || !currentManagingUser) return;
  const label = currentManagingUser.phone || currentManagingUser.code || currentManagingUser.name || '';
  const msg = `Mật khẩu tạm tài khoản LiLa của bạn (${label}) là: ${lastAdminResetTempPwd}. Vui lòng đăng nhập tại https://hoantiensan.online và đổi lại mật khẩu mới nhé!`;
  copyText(msg, 'Đã sao chép tin nhắn gửi Zalo cho khách!');
});

on('btnGenerateRandomPwd', 'click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
    showToast('Trình duyệt không hỗ trợ tạo mật khẩu an toàn.');
    return;
  }
  const rand = new Uint32Array(12);
  window.crypto.getRandomValues(rand);
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(rand[i] % chars.length);
  }
  const input = document.getElementById('manageNewPassword');
  if (input) {
    input.value = pwd;
    input.type = 'text';
    syncPasswordToggleUi(input);
    showToast('Đã tạo mật khẩu ngẫu nhiên: ' + pwd);
  }
});

on('btnResetUserPassword', 'click', async () => {
  if (!currentManagingUser) return;
  const newPassword = document.getElementById('manageNewPassword')?.value?.trim() || '';
  if (newPassword.length < 6) {
    showToast('Mật khẩu mới phải có ít nhất 6 ký tự.');
    return;
  }
  const btn = document.getElementById('btnResetUserPassword');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({
        userId: currentManagingUser.id,
        action: 'reset_password',
        newPassword
      })
    });
    showToast(res.message);
    lastAdminResetTempPwd = newPassword;
    const resultBox = document.getElementById('manageResetResultBox');
    const resultVal = document.getElementById('manageResetPwdValue');
    if (resultVal) resultVal.textContent = newPassword;
    if (resultBox) resultBox.classList.remove('hidden');
    const pwdInput = document.getElementById('manageNewPassword');
    if (pwdInput) {
      pwdInput.value = '';
      pwdInput.type = 'password';
      syncPasswordToggleUi(pwdInput);
    }
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

on('btnAdjustUserBalance', 'click', async () => {
  if (!currentManagingUser) return;
  const type = document.getElementById('manageAdjustType')?.value;
  const rawAmt = Number(document.getElementById('manageAdjustAmount')?.value || 0);
  const note = document.getElementById('manageAdjustNote')?.value?.trim() || '';

  if (!rawAmt || rawAmt <= 0) {
    showToast('Vui lòng nhập số tiền lớn hơn 0.');
    return;
  }
  const amount = type === 'minus' ? -rawAmt : rawAmt;
  const btn = document.getElementById('btnAdjustUserBalance');
  if (btn) btn.disabled = true;

  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({
        userId: currentManagingUser.id,
        action: 'adjust_balance',
        amount,
        note
      })
    });
    showToast(res.message);
    userManageModal?.classList.add('hidden');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

on('btnResetUserBalanceZero', 'click', async () => {
  if (!currentManagingUser) return;
  const confirmed = await askUserConfirm(
    `Bạn có chắc chắn muốn đặt toàn bộ số dư khả dụng của khách hàng ${currentManagingUser.code} về 0đ không?`,
    'Đặt Lại Số Dư = 0đ'
  );
  if (!confirmed) {
    return;
  }
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'reset_balance' })
    });
    showToast(res.message);
    userManageModal?.classList.add('hidden');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

on('btnToggleUserLock', 'click', async () => {
  if (!currentManagingUser) return;
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'toggle_lock' })
    });
    showToast(res.message);
    userManageModal?.classList.add('hidden');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

on('btnDeleteUser', 'click', async () => {
  if (!currentManagingUser) return;
  const confirmed = await askUserConfirm(
    `Lưu trữ tài khoản ${currentManagingUser.code} (${currentManagingUser.phone})?\nTài khoản sẽ bị khóa và các phiên đăng nhập cũ bị thu hồi. Thông tin, số điện thoại và lịch sử giao dịch vẫn được giữ.`,
    'Lưu Trữ Tài Khoản Thành Viên'
  );
  if (!confirmed) {
    return;
  }
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'delete' })
    });
    showToast(res.message);
    userManageModal?.classList.add('hidden');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// ================= ORDER EDIT MODAL =================
const orderEditModal = document.getElementById('orderEditModal');
let currentEditingOrder = null;

function openOrderEditModal(order) {
  currentEditingOrder = order;
  if (!orderEditModal) return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  setVal('editOrdId', order.id || '');
  setVal('editOrdSn', order.orderSn || '');
  setVal('editOrdUserCode', order.userCode || '');
  setVal('editOrdPlatform', order.platform || 'shopee');
  setVal('editOrdProduct', order.productName || '');
  setVal('editOrdAmount', order.orderAmount || 0);
  setVal('editOrdCommission', order.grossCommission || order.totalCommission || 0);
  setVal('editOrdCashbackAmount', order.userCashbackAmount || 0);
  setVal('editOrdStatus', order.status || 'pending');

  orderEditModal.classList.remove('hidden');
}

on('closeOrderEditModalBtn', 'click', () => {
  orderEditModal?.classList.add('hidden');
});
on('cancelOrderEditBtn', 'click', () => {
  orderEditModal?.classList.add('hidden');
});

on('btnAutoCalcCashback', 'click', () => {
  const gross = Number(document.getElementById('editOrdCommission')?.value || 0);
  const taxRate = numOr(currentAdminSettings?.taxDeductPercent, 10);
  const cbRate = numOr(currentAdminSettings?.cashbackPercent, 70);
  const net = Math.round(gross * (1 - taxRate / 100));
  const cb = Math.round((net * cbRate) / 100);
  if (document.getElementById('editOrdCashbackAmount')) {
    document.getElementById('editOrdCashbackAmount').value = cb;
  }
  showToast(`Đã tính tiền hoàn: ${fmtVnd(cb)} (${cbRate}% sau thuế)`);
});

on('saveOrderEditBtn', 'click', async () => {
  const btn = document.getElementById('saveOrderEditBtn');
  const id = document.getElementById('editOrdId')?.value;
  const orderSn = document.getElementById('editOrdSn')?.value?.trim();
  const userCode = document.getElementById('editOrdUserCode')?.value?.trim();
  const platform = document.getElementById('editOrdPlatform')?.value;
  const productName = document.getElementById('editOrdProduct')?.value?.trim();
  const orderAmount = Number(document.getElementById('editOrdAmount')?.value || 0);
  const totalCommission = Number(document.getElementById('editOrdCommission')?.value || 0);
  const userCashbackAmount = Number(document.getElementById('editOrdCashbackAmount')?.value || 0);
  const status = document.getElementById('editOrdStatus')?.value;

  if (btn) btn.disabled = true;

  try {
    await apiFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        id,
        orderSn,
        userCode,
        platform,
        productName,
        orderAmount,
        totalCommission,
        userCashbackAmount,
        status
      })
    });
    orderEditModal?.classList.add('hidden');
    showToast(`Đã lưu thay đổi cho đơn #${orderSn}!`);
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ================= CSV IMPORT & RECONCILIATION =================
let isCsvImporting = false;

function showCsvImportReport(message, errors = []) {
  let panel = document.getElementById('csvImportReport');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'csvImportReport';
    panel.className = 'panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    const input = document.getElementById('admCsvInput');
    const anchor = input?.closest('details') || input?.closest('.admin-toolbar-actions');
    if (!anchor) return;
    anchor.after(panel);
  }
  panel.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = message;
  panel.append(summary);
  if (errors.length) {
    const details = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = `Xem ${errors.length} lỗi đối soát`;
    details.append(title);
    const list = document.createElement('ul');
    for (const error of errors) {
      const item = document.createElement('li');
      item.textContent = String(error);
      list.append(item);
    }
    details.append(list);
    panel.append(details);
  }
}

on('admCsvInput', 'change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (isCsvImporting) { showToast('Đang nhập CSV. Vui lòng chờ hoàn tất.'); return; }

  const MAX_CSV_SIZE = 2 * 1024 * 1024; // Enforce 2MB client-side limit
  if (file.size > MAX_CSV_SIZE) {
    showToast('Kích thước file CSV vượt quá giới hạn 2MB.');
    e.target.value = '';
    return;
  }

  let totalImported = 0;
  let confirmedRows = 0;
  let totalRows = 0;
  let activeBatchSize = 0;
  let phase = 'read';
  const allChunkErrors = [];
  try {
    isCsvImporting = true;
    e.target.disabled = true;
    await ensureAdminAssetsLoaded();
    const text = await file.text();
    const { rows, totalEstComm, duplicateRows, sourceRows } = window.CashbackCsv.parse(text, file.name);

    if (rows.length === 0) {
      showToast('Không tìm thấy dòng dữ liệu đơn hàng hợp lệ nào trong file CSV.');
      return;
    }

    const confirmMsg = `• Số đơn hợp lệ: ${rows.length}\n• Số dòng nguồn: ${sourceRows}\n• Số dòng cùng đơn đã gộp: ${duplicateRows}\n• Tổng hoa hồng ước tính: ${fmtVnd(
      totalEstComm
    )}\n\nBạn có muốn tiếp tục nhập và cập nhật ví khách hàng không?`;
    const confirmed = await askUserConfirm(confirmMsg, 'Xác Nhận Nhập CSV Đối Soát');
    if (!confirmed) return;
    totalRows = rows.length;
    phase = 'import';

    // Batch requests in chunks of 500 rows to prevent payload exhaustion
    const CHUNK_SIZE = 500;

    for (let c = 0; c < rows.length; c += CHUNK_SIZE) {
      const chunk = rows.slice(c, c + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      activeBatchSize = chunk.length;
      showCsvImportReport(`Đang xử lý lô ${Math.floor(c / CHUNK_SIZE) + 1}/${Math.ceil(rows.length / CHUNK_SIZE)}. Đã xác nhận nhập ${totalImported}/${totalRows} đơn.`, allChunkErrors);
      const res = await apiFetch('/api/admin/import-orders', {
        method: 'POST',
        body: JSON.stringify({ rows: chunk })
      });
      if (!Number.isInteger(res?.importedCount) || res.importedCount < 0 || res.importedCount > chunk.length ||
          !Array.isArray(res.errors) || res.importedCount + res.errors.length !== chunk.length) {
        throw new Error('Phản hồi nhập CSV không đầy đủ; chưa thể xác nhận kết quả lô hiện tại.');
      }
      totalImported += res.importedCount;
      confirmedRows += chunk.length;
      activeBatchSize = 0;
      if (Array.isArray(res?.errors) && res.errors.length > 0) {
        allChunkErrors.push(...res.errors);
      }
    }

    phase = 'refresh';
    showCsvImportReport(`Đã xử lý ${confirmedRows}/${totalRows} đơn: ${totalImported} đơn được server xác nhận nhập, ${allChunkErrors.length} lỗi đối soát.`, allChunkErrors);

    if (totalImported === 0) {
      const errDetail = allChunkErrors.length ? `: ${allChunkErrors[0]}` : '';
      showToast(`Không có đơn hàng nào được nhập thành công${errDetail}.`);
    } else if (allChunkErrors.length > 0) {
      showToast(`Đã nhập ${totalImported} đơn hàng (${allChunkErrors.length} lỗi: ${allChunkErrors[0]}).`);
      await loadAdminDashboard();
    } else {
      showToast(`Đã nhập & đối soát thành công ${totalImported} đơn hàng!`);
      await loadAdminDashboard();
    }
  } catch (err) {
    let message;
    if (phase === 'read') message = `Không thể đọc hoặc kiểm tra CSV: ${err.message}`;
    else if (phase === 'refresh') message = `Server đã xác nhận nhập ${totalImported} đơn, nhưng chưa tải lại được danh sách. Hãy tải lại trang. ${err.message}`;
    else message = `Nhập CSV bị gián đoạn. Đã xác nhận nhập ${totalImported} đơn; ${allChunkErrors.length} lỗi đối soát; ${activeBatchSize} đơn ở lô hiện tại chưa rõ kết quả; ${Math.max(0, totalRows - confirmedRows - activeBatchSize)} đơn chưa gửi. Giữ nguyên nội dung và tên file rồi chọn lại để đối soát; không coi lô mất phản hồi là đã thất bại. ${err.message}`;
    showCsvImportReport(message, allChunkErrors);
    showToast(phase === 'import' ? 'Nhập CSV bị gián đoạn. Xem chi tiết trong bảng kết quả nhập.' : message);
  } finally {
    isCsvImporting = false;
    e.target.disabled = false;
    e.target.value = '';
  }
});

// ==================== PWA INSTALL & HOME SCREEN CONTROLLER ====================
let deferredInstallPrompt = null;
const pwaInstallBanner = document.getElementById('pwaInstallBanner');
const pwaBannerDesc = document.getElementById('pwaBannerDesc');
const pwaInstallBtn = document.getElementById('pwaInstallBtn');
const pwaDismissBtn = document.getElementById('pwaDismissBtn');
const pwaGuideModal = document.getElementById('pwaGuideModal');
const pwaGuideContent = document.getElementById('pwaGuideContent');

// Register Service Worker if supported + show update banner when a new version is waiting
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let pendingWorker = null;
    let reloadingForUpdate = false;
    let updateDismissed = false;

    const showUpdateBanner = (worker) => {
      pendingWorker = worker || pendingWorker;
      if (updateDismissed) return;
      const banner = document.getElementById('pwaUpdateBanner');
      const reloadBtn = document.getElementById('pwaReloadUpdateBtn');
      const dismissBtn = document.getElementById('pwaDismissUpdateBtn');
      if (!banner) return;
      banner.classList.remove('hidden');
      if (reloadBtn && !reloadBtn.dataset.bound) {
        reloadBtn.dataset.bound = '1';
        reloadBtn.addEventListener('click', () => {
          reloadBtn.disabled = true;
          reloadBtn.textContent = 'Đang cập nhật...';
          try { pendingWorker?.postMessage?.({ type: 'SKIP_WAITING' }); } catch {}
          setTimeout(() => {
            if (!reloadingForUpdate) {
              reloadingForUpdate = true;
              window.location.reload();
            }
          }, 700);
        });
      }
      if (dismissBtn && !dismissBtn.dataset.bound) {
        dismissBtn.dataset.bound = '1';
        dismissBtn.addEventListener('click', () => {
          updateDismissed = true;
          banner.classList.add('hidden');
        });
      }
      if (!banner.dataset.backdropBound) {
        banner.dataset.backdropBound = '1';
        banner.addEventListener('click', (e) => {
          if (e.target === banner) {
            updateDismissed = true;
            banner.classList.add('hidden');
          }
        });
      }
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadingForUpdate) {
        reloadingForUpdate = true;
        window.location.reload();
      }
    });

    navigator.serviceWorker.register('/sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg.waiting);
      }
      reg.addEventListener('updatefound', () => {
        const nextWorker = reg.installing;
        if (!nextWorker) return;
        nextWorker.addEventListener('statechange', () => {
          if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(nextWorker);
          }
        });
      });
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {});
        }
      });
    }).catch(() => {});
  });
}

function isPwaStandalone() {
  return (
    (typeof window.matchMedia === 'function' &&
      (window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches)) ||
    window.navigator.standalone === true ||
    (document.referrer || '').includes('android-app://')
  );
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isIosUa = /iphone|ipad|ipod/i.test(ua);
  const isIpadOs = (platform === 'MacIntel' || /Macintosh/i.test(ua)) && navigator.maxTouchPoints > 1;
  return (isIosUa || isIpadOs) && !window.MSStream;
}

function getIosInstallContext() {
  const ua = navigator.userAgent || '';
  const isIos = isIosDevice();
  const isAndroid = /Android/i.test(ua);
  const standalone = isPwaStandalone();

  if (!isIos) {
    return { isIos: false, isAndroid, standalone, browser: isAndroid ? 'android' : 'desktop' };
  }

  if (/\bZalo\b/i.test(ua)) {
    return { isIos: true, isAndroid: false, standalone, browser: 'zalo' };
  }
  if (/\b(FBAN|FBAV|FB_IAB|FBIOS|Messenger|FBMD)\b/i.test(ua)) {
    return { isIos: true, isAndroid: false, standalone, browser: 'facebook' };
  }
  if (/\b(Instagram|Line|MicroMessenger|BytedanceWebview|musical_ly|TikTok|Twitter|Snapchat)\b/i.test(ua)) {
    return { isIos: true, isAndroid: false, standalone, browser: 'other_inapp' };
  }
  if (/\b(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA)\b/i.test(ua)) {
    return { isIos: true, isAndroid: false, standalone, browser: 'ios_other_browser' };
  }
  if (/AppleWebKit/i.test(ua) && /Safari/i.test(ua)) {
    return { isIos: true, isAndroid: false, standalone, browser: 'safari' };
  }
  return { isIos: true, isAndroid: false, standalone, browser: 'unknown_ios' };
}

const IOS_A2HS_STORAGE_KEY = 'hts_ios_a2hs_state';
const IOS_A2HS_COOLDOWN_MS = 7 * 86400 * 1000;
let iosA2hsShownThisSession = false;

const IOS_A2HS_ICONS = {
  share: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
  shareSm: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>',
  plusSquare: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  plusSquareSm: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  dots: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
  compass: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  arrowRight: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
};

function readIosA2hsState() {
  try {
    const raw = safeStorage.get(IOS_A2HS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveIosA2hsDismissed(browser) {
  try {
    const prev = readIosA2hsState() || {};
    safeStorage.set(
      IOS_A2HS_STORAGE_KEY,
      JSON.stringify({
        dismissedAt: Date.now(),
        browser: browser || 'safari',
        dismissCount: Number(prev.dismissCount || 0) + 1
      })
    );
  } catch {}
}

function shouldAutoShowIosA2hs() {
  const ctx = getIosInstallContext();
  if (!ctx.isIos || ctx.standalone) return false;
  if (ctx.browser === 'unknown_ios') return false;
  if (iosA2hsShownThisSession) return false;

  // Do not interrupt active modals or update banner
  const busyIds = ['pwaUpdateBanner', 'authModal', 'confirmActionModal', 'pwaGuideModal'];
  if (busyIds.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  })) {
    return false;
  }

  const saved = readIosA2hsState();
  if (saved && saved.dismissedAt) {
    // If user dismissed in Zalo/Facebook and then switched to Safari, show the Safari guide!
    const switchedToSafari = saved.browser !== 'safari' && ctx.browser === 'safari';
    if (!switchedToSafari && Date.now() - Number(saved.dismissedAt) < IOS_A2HS_COOLDOWN_MS) {
      return false;
    }
  }
  return true;
}

function renderIosA2hsSheet(ctx) {
  const sheet = document.getElementById('iosA2hsSheet');
  const titleEl = document.getElementById('iosA2hsTitle');
  const subEl = document.getElementById('iosA2hsSubtitle');
  const bodyEl = document.getElementById('iosA2hsBody');
  if (!sheet || !titleEl || !subEl || !bodyEl) return;

  if (ctx.browser === 'safari') {
    titleEl.textContent = 'Cài LiLa lên màn hình chính';
    subEl.textContent = 'Trải nghiệm LiLa nhanh chóng như một ứng dụng thực thụ!';
    bodyEl.innerHTML = `
      <div class="ios-a2hs-visual" aria-hidden="true">
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill is-pulse">${IOS_A2HS_ICONS.share}</span>
          <span>1. Chia sẻ</span>
        </div>
        <span class="ios-a2hs-arrow">${IOS_A2HS_ICONS.arrowRight}</span>
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill is-brand">${IOS_A2HS_ICONS.plusSquare}</span>
          <span>2. Thêm vào MH chính</span>
        </div>
      </div>
      <div class="ios-a2hs-steps">
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">1</span>
          <div>Nhấn nút <span class="ios-a2hs-inline-chip">${IOS_A2HS_ICONS.shareSm} Chia sẻ</span> trên thanh công cụ Safari.</div>
        </div>
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">2</span>
          <div>Cuộn xuống chọn <span class="ios-a2hs-inline-chip">${IOS_A2HS_ICONS.plusSquareSm} Thêm vào MH chính</span>, sau đó nhấn <strong>Thêm</strong>.</div>
        </div>
      </div>
      <div class="ios-a2hs-note">Vị trí nút Chia sẻ có thể nằm ở thanh dưới hoặc trên cùng tùy cài đặt Safari của bạn.</div>
      <div class="ios-a2hs-footer">
        <button type="button" class="btn btn-primary" id="iosA2hsAckBtn">Đã hiểu</button>
      </div>
    `;
  } else if (ctx.browser === 'zalo' || ctx.browser === 'facebook') {
    const appName = ctx.browser === 'zalo' ? 'Zalo' : 'Facebook';
    titleEl.textContent = 'Mở LiLa bằng Safari để cài đặt';
    subEl.textContent = `Trình duyệt trong ${appName} chưa hỗ trợ thêm trực tiếp ra màn hình chính.`;
    bodyEl.innerHTML = `
      <div class="ios-a2hs-visual is-inapp" aria-hidden="true">
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill is-dark is-pulse">${IOS_A2HS_ICONS.dots}</span>
          <span>1. Menu góc</span>
        </div>
        <span class="ios-a2hs-arrow">${IOS_A2HS_ICONS.arrowRight}</span>
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill">${IOS_A2HS_ICONS.compass}</span>
          <span>2. Mở bằng Safari</span>
        </div>
      </div>
      <div class="ios-a2hs-steps">
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">1</span>
          <div>Nhấn nút menu <strong>•••</strong> ở góc trình duyệt ${appName}.</div>
        </div>
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">2</span>
          <div>Chọn <strong>Mở bằng Safari</strong> (hoặc Mở bằng trình duyệt ngoài).</div>
        </div>
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">3</span>
          <div>Sau khi mở bằng Safari, nhấn <strong>Chia sẻ</strong> → <strong>Thêm vào MH chính</strong>.</div>
        </div>
      </div>
      <div class="ios-a2hs-footer">
        <button type="button" class="btn btn-outline" id="iosA2hsCopyUrlBtn">Sao chép link</button>
        <button type="button" class="btn btn-primary" id="iosA2hsAckBtn">Đã hiểu</button>
      </div>
    `;
  } else {
    titleEl.textContent = 'Mở LiLa bằng Safari để cài đặt';
    subEl.textContent = 'Dùng trình duyệt Safari mặc định trên iPhone/iPad để ghim LiLa ra màn hình chính.';
    bodyEl.innerHTML = `
      <div class="ios-a2hs-visual is-inapp" aria-hidden="true">
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill is-pulse">${IOS_A2HS_ICONS.compass}</span>
          <span>1. Mở Safari</span>
        </div>
        <span class="ios-a2hs-arrow">${IOS_A2HS_ICONS.arrowRight}</span>
        <div class="ios-a2hs-tile">
          <span class="ios-a2hs-icon-pill is-brand">${IOS_A2HS_ICONS.plusSquare}</span>
          <span>2. Thêm vào MH chính</span>
        </div>
      </div>
      <div class="ios-a2hs-steps">
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">1</span>
          <div>Mở trang LiLa bằng trình duyệt <strong>Safari</strong> trên thiết bị của bạn.</div>
        </div>
        <div class="ios-a2hs-step">
          <span class="ios-a2hs-step-num">2</span>
          <div>Nhấn nút <strong>Chia sẻ</strong> trên Safari và chọn <strong>Thêm vào MH chính</strong>.</div>
        </div>
      </div>
      <div class="ios-a2hs-footer">
        <button type="button" class="btn btn-outline" id="iosA2hsCopyUrlBtn">Sao chép link</button>
        <button type="button" class="btn btn-primary" id="iosA2hsAckBtn">Đã hiểu</button>
      </div>
    `;
  }
}

function showIosA2hsSheet({ manual = false } = {}) {
  const ctx = getIosInstallContext();
  if (ctx.standalone) {
    if (manual) showToast('LiLa đã được cài đặt trên màn hình chính của bạn!');
    return;
  }
  if (!ctx.isIos) return;
  if (!manual && !shouldAutoShowIosA2hs()) return;

  const sheet = document.getElementById('iosA2hsSheet');
  if (!sheet) return;
  renderIosA2hsSheet(ctx);
  sheet.classList.remove('hidden');
  iosA2hsShownThisSession = true;
}

function hideIosA2hsSheet(rememberDismiss = false) {
  const sheet = document.getElementById('iosA2hsSheet');
  if (!sheet) return;
  sheet.classList.add('hidden');
  if (rememberDismiss) {
    const ctx = getIosInstallContext();
    saveIosA2hsDismissed(ctx.browser);
  }
}

function handleManualInstallGuideTrigger() {
  const ctx = getIosInstallContext();
  if (ctx.standalone) {
    showToast('LiLa đã được cài đặt trên màn hình chính của bạn!');
    return;
  }
  if (ctx.isIos) {
    showIosA2hsSheet({ manual: true });
    return;
  }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice
      .then((choice) => {
        if (choice && choice.outcome === 'accepted') {
          hidePwaBanner();
          showToast('Đang cài đặt LiLa ra màn hình chính...');
        }
      })
      .catch(() => openPwaGuideModal('android'))
      .finally(() => {
        deferredInstallPrompt = null;
      });
    return;
  }
  openPwaGuideModal('android');
}

function showPwaBanner() {
  if (isPwaStandalone()) return;
  // iOS uses the dedicated compact iOS Bottom Sheet instead of the Android banner
  if (isIosDevice()) {
    showIosA2hsSheet({ manual: false });
    return;
  }
  const dismissedTime = safeStorage.get('hts_pwa_dismissed');
  if (dismissedTime && Date.now() - Number(dismissedTime) < 2 * 86400 * 1000) {
    return;
  }
  if (!pwaInstallBanner) return;

  if (pwaBannerDesc) {
    pwaBannerDesc.textContent = 'Thêm LiLa ra màn hình chính để truy cập nhanh.';
  }

  pwaInstallBanner.classList.remove('hidden');
}

function hidePwaBanner() {
  pwaInstallBanner?.classList.add('hidden');
}

function openPwaGuideModal(type = 'ios') {
  if (!pwaGuideModal || !pwaGuideContent) return;

  if (type === 'ios') {
    pwaGuideContent.innerHTML = `
      <div class="pwa-step-item">
        <div class="pwa-step-num">1</div>
        <div class="pwa-step-text">
          Trên trình duyệt Safari của iPhone, nhấn nút <strong>Chia sẻ</strong> (biểu tượng hình vuông có mũi tên hướng lên <span class="pwa-guide-highlight inline-icon-badge">${UI_ICONS.shareIos}<span>Chia sẻ</span></span> ở thanh dưới cùng).
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">2</div>
        <div class="pwa-step-text">
          Cuộn xuống dưới và chọn dòng <span class="pwa-guide-highlight inline-icon-badge">${UI_ICONS.plusSquare}<span>Thêm vào MH chính</span></span> (Add to Home Screen).
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">3</div>
        <div class="pwa-step-text">
          Nhấn nút <strong>Thêm</strong> (Add) ở góc trên bên phải màn hình. Biểu tượng ứng dụng <strong>LiLa</strong> sẽ xuất hiện ngay trên màn hình chính của bạn!
        </div>
      </div>
    `;
  } else {
    pwaGuideContent.innerHTML = `
      <div class="pwa-step-item">
        <div class="pwa-step-num">1</div>
        <div class="pwa-step-text">
          Nhấn vào biểu tượng <strong>Menu 3 chấm (⋮)</strong> ở góc trên bên phải trình duyệt Chrome / Cốc Cốc / Samsung Internet.
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">2</div>
        <div class="pwa-step-text">
          Chọn mục <span class="pwa-guide-highlight inline-icon-badge">${UI_ICONS.smartphone}<span>Cài đặt ứng dụng</span></span> hoặc <strong>Thêm vào màn hình chính</strong>.
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">3</div>
        <div class="pwa-step-text">
          Nhấn <strong>Cài đặt</strong> để hoàn tất. Bạn có thể mở LiLa trực tiếp từ màn hình điện thoại bất cứ lúc nào!
        </div>
      </div>
    `;
  }

  pwaGuideModal.classList.remove('hidden');
}

function closePwaGuideModal() {
  pwaGuideModal?.classList.add('hidden');
}

// Listen for browser install prompt (Chrome / Edge / Samsung Internet / Android)
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showPwaBanner();
});

if (pwaInstallBtn) {
  pwaInstallBtn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          hidePwaBanner();
          showToast('Đang cài đặt LiLa ra màn hình chính...');
        }
      } catch (err) {
        openPwaGuideModal(isIosDevice() ? 'ios' : 'android');
      } finally {
        deferredInstallPrompt = null;
      }
    } else if (isIosDevice()) {
      openPwaGuideModal('ios');
    } else {
      openPwaGuideModal('android');
    }
  });
}

if (pwaDismissBtn) {
  pwaDismissBtn.addEventListener('click', () => {
    safeStorage.set('hts_pwa_dismissed', String(Date.now()));
    hidePwaBanner();
  });
}

on('closePwaGuideBtn', 'click', closePwaGuideModal);
on('ackPwaGuideBtn', 'click', closePwaGuideModal);
on('iosA2hsCloseBtn', 'click', () => hideIosA2hsSheet(true));

document.addEventListener('click', (e) => {
  if (e.target.closest('#iosA2hsAckBtn')) {
    hideIosA2hsSheet(true);
    return;
  }
  if (e.target.closest('#iosA2hsCopyUrlBtn')) {
    copyText(window.location.origin + '/', 'Đã sao chép link LiLa! Hãy mở Safari và dán vào thanh địa chỉ.');
    return;
  }
  if (e.target.closest('[data-open-install-guide]')) {
    handleManualInstallGuideTrigger();
  }
});

// Swipe-down-to-close on iOS A2HS sheet
(function bindIosA2hsSwipeClose() {
  const sheet = document.getElementById('iosA2hsSheet');
  const card = sheet?.querySelector('.ios-a2hs-card');
  if (!sheet || !card) return;
  let startY = 0;
  let dragging = false;
  card.addEventListener('touchstart', (e) => {
    if (card.scrollTop > 0 || sheet.classList.contains('hidden')) return;
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dy = (e.changedTouches?.[0]?.clientY || startY) - startY;
    if (dy > 60) hideIosA2hsSheet(true);
  }, { passive: true });
})();

// Auto-trigger banner after initial page load only on iOS or when Android install prompt is available
setTimeout(() => {
  if (isIosDevice()) {
    showIosA2hsSheet({ manual: false });
  } else if (deferredInstallPrompt) {
    showPwaBanner();
  }
}, 2200);

// ================= BOOTSTRAP INITIALIZATION =================
const PASSWORD_EYE_SVG = '<svg class="svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const PASSWORD_EYE_OFF_SVG = '<svg class="svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

function syncPasswordToggleUi(input) {
  if (!input || !input.parentElement) return;
  const btn = input.parentElement.querySelector('.btn-toggle-password');
  if (!btn) return;
  const isVisible = input.type === 'text';
  btn.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
  btn.setAttribute('aria-label', isVisible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  btn.title = isVisible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu';
  btn.innerHTML = isVisible ? PASSWORD_EYE_OFF_SVG : PASSWORD_EYE_SVG;
}

function resetPasswordVisibility(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  container.querySelectorAll('.password-field-wrap input').forEach((input) => {
    if (input.type === 'text') {
      input.type = 'password';
      syncPasswordToggleUi(input);
    }
  });
}

function initPasswordVisibilityToggles() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.pwdToggleReady === '1') return;
    input.dataset.pwdToggleReady = '1';
    const parent = input.parentElement;
    if (!parent) return;

    const wrap = document.createElement('div');
    wrap.className = 'password-field-wrap';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-toggle-password';
    toggleBtn.setAttribute('aria-label', 'Hiện mật khẩu');
    toggleBtn.setAttribute('aria-pressed', 'false');
    toggleBtn.title = 'Hiện mật khẩu';
    toggleBtn.innerHTML = PASSWORD_EYE_SVG;

    toggleBtn.addEventListener('click', () => {
      const nextType = input.type === 'password' ? 'text' : 'password';
      input.type = nextType;
      syncPasswordToggleUi(input);
      input.focus({ preventScroll: true });
    });

    wrap.appendChild(toggleBtn);
  });

  document.addEventListener('submit', (e) => {
    if (e.target && typeof e.target.querySelectorAll === 'function') {
      resetPasswordVisibility(e.target);
    }
  });
}

async function initBoot() {
  initPasswordVisibilityToggles();
  syncAuthUi();
  // Font download must not block the first paint or application scripts.
  const font = document.getElementById('webFont');
  if (font) {
    const enableFont = () => { font.media = 'all'; };
    if (font.sheet) enableFont();
    else font.addEventListener('load', enableFont, { once: true });
  }

  // Show the requested screen immediately; refresh authoritative data in parallel.
  const initialHash = window.location.hash.replace('#', '');
  if (['home', 'wallet', 'admin', 'guide', 'faq', 'terms', 'leaderboard'].includes(initialHash) || ['orders', 'account'].includes(initialHash)) {
    switchView(initialHash, false, { skipReload: true });
  }
  const userReady = authToken
    ? loadUserDashboard()
    : refreshAuthSession().then((restored) => (restored ? loadUserDashboard() : null));
  const adminReady = userReady.then(() => {
    if (document.getElementById('view-admin')?.classList.contains('active')) {
      if (authToken && currentUser?.role === 'admin') return loadAdminDashboard();
      switchView('home', false);
    }
  });
  await Promise.all([initPublicConfig(), adminReady]);
}

// ================= MOBILE VISUAL VIEWPORT & VIRTUAL KEYBOARD MANAGER =================
function initMobileViewportManager() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const vv = window.visualViewport;
  let rafId = 0;
  let lastWidth = Math.round(vv ? vv.width : window.innerWidth);
  let baselineHeight = Math.round(vv ? vv.height : window.innerHeight);

  const isEditable = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const t = String(el.type || 'text').toLowerCase();
      return !['checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'file'].includes(t);
    }
    return Boolean(el.isContentEditable);
  };

  const sync = () => {
    rafId = 0;
    const width = Math.round(vv ? vv.width : window.innerWidth);
    const height = Math.round(vv ? vv.height : window.innerHeight);
    const offsetTop = Math.max(0, Math.round(vv ? vv.offsetTop : 0));
    const isMobile = width <= 640;

    if (!isMobile) {
      root.classList.remove('kb-open');
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--kb-height');
      return;
    }

    // Reset baseline height on orientation change
    if (Math.abs(width - lastWidth) > 80) {
      lastWidth = width;
      baselineHeight = Math.max(height, window.innerHeight);
    }

    const active = document.activeElement;
    if (!isEditable(active)) {
      baselineHeight = Math.max(baselineHeight, height, window.innerHeight);
    } else if (height > baselineHeight) {
      baselineHeight = height;
    }

    const kbDelta = Math.max(0, Math.max(baselineHeight, window.innerHeight) - height - offsetTop);
    const kbOpen = kbDelta > 110 || (isEditable(active) && baselineHeight - height > 110);

    root.style.setProperty('--vvh', `${height}px`);
    root.style.setProperty('--vv-top', `${offsetTop}px`);
    root.style.setProperty('--kb-height', `${kbDelta}px`);
    root.classList.toggle('kb-open', kbOpen);

    if (kbOpen && isEditable(active) && active.closest?.('.modal-box')) {
      active.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const scheduleSync = () => {
    if (!rafId) rafId = window.requestAnimationFrame(sync);
  };

  if (vv) {
    vv.addEventListener('resize', scheduleSync, { passive: true });
    vv.addEventListener('scroll', scheduleSync, { passive: true });
  }
  window.addEventListener('resize', scheduleSync, { passive: true });
  window.addEventListener('orientationchange', () => {
    setTimeout(scheduleSync, 120);
  }, { passive: true });

  document.addEventListener('focusin', (e) => {
    if (!isEditable(e.target)) return;
    scheduleSync();
    if (e.target.closest?.('.modal-box')) {
      setTimeout(() => {
        scheduleSync();
        if (document.activeElement === e.target) {
          e.target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        }
      }, 220);
    }
  });

  document.addEventListener('focusout', () => {
    setTimeout(scheduleSync, 140);
  });

  sync();
}

initMobileViewportManager();

// Multi-tab session sync + silent refresh when returning to backgrounded mobile/desktop tab
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === USER_KEY && !e.newValue && authToken) {
      clearSession({ skipLogoutApi: true });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && authToken) {
      loadUserDashboard();
    }
  });
}

function syncShibaToggleButton() {
  const btn = document.getElementById('toggleShibaCompanionBtn');
  const label = document.getElementById('toggleShibaCompanionLabel');
  if (!btn || !label) return;
  const mode = window.LilaShiba?.getMode?.() || 'active';
  const isHidden = mode === 'hidden';
  btn.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
  label.textContent = isHidden
    ? 'Bé Shiba: Đang ẩn'
    : mode === 'sleep'
      ? 'Bé Shiba: Đang ngủ'
      : 'Bé Shiba: Đang bật';
}

on('toggleShibaCompanionBtn', 'click', () => {
  if (!window.LilaShiba) return;
  const mode = window.LilaShiba.getMode();
  if (mode === 'hidden') {
    window.LilaShiba.show();
    showToast('Đã gọi bé Shiba LiLa quay lại!');
  } else {
    window.LilaShiba.hide();
    showToast('Đã ẩn bé Shiba. Bạn có thể gọi lại bất cứ lúc nào tại mục Tôi.');
  }
  syncShibaToggleButton();
});

let shibaAssetsLoaded = false;
function loadShibaCompanionAssets() {
  if (shibaAssetsLoaded) return;
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') {
    return;
  }
  shibaAssetsLoaded = true;
  if (!document.querySelector('link[href="/shibaCompanion.css?v=6"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/shibaCompanion.css?v=6';
    document.head.appendChild(link);
  }
  if (!document.querySelector('script[src="/shibaCompanion.js?v=6"]')) {
    const script = document.createElement('script');
    script.src = '/shibaCompanion.js?v=6';
    script.defer = true;
    script.onload = () => syncShibaToggleButton();
    document.head.appendChild(script);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('lila:shiba-mode-changed', syncShibaToggleButton);
  const scheduleShibaBoot = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(loadShibaCompanionAssets, { timeout: 600 });
    } else {
      setTimeout(loadShibaCompanionAssets, 250);
    }
  };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', scheduleShibaBoot, { once: true });
  } else {
    scheduleShibaBoot();
  }
}

on('logoutAllDevicesBtn', 'click', async () => {
  const confirmed = await askUserConfirm(
    'Đăng xuất khỏi tất cả điện thoại và trình duyệt đang đăng nhập tài khoản này?',
    'Đăng Xuất Mọi Thiết Bị'
  );
  if (!confirmed) return;
  try {
    await apiFetch('/api/auth/logout-all', { method: 'POST', body: '{}' });
    await clearSession({ skipLogoutApi: true });
    showToast('Đã đăng xuất khỏi tất cả thiết bị.');
  } catch (err) {
    showToast(err.message);
  }
});

// Global Escape key listener fallback (closes topmost modal without closing stacked base modals)
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const confirmEl = document.getElementById('confirmActionModal');
      if (confirmEl && !confirmEl.classList.contains('hidden')) {
        return;
      }
      const modalIds = [
        'authModal',
        'userManageModal',
        'orderEditModal',
        'vietQrModal',
        'refQrModal',
        'pwaGuideModal'
      ];
      for (const mId of modalIds) {
        const el = document.getElementById(mId);
        if (el && !el.classList.contains('hidden')) {
          el.classList.add('hidden');
        }
      }
    }
  });

  // Global CSP-compliant image fallback handler (useCapture=true since <img> error does not bubble)
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG') {
        if (target.id === 'refQrImg') {
          target.classList.add('hidden');
          if (!document.getElementById('refQrOfflineFallback')) {
            const box = document.createElement('div');
            box.id = 'refQrOfflineFallback';
            box.className = 'qr-offline-fallback';
            box.textContent =
              'Thiết bị chưa tải được ảnh QR lúc này. Bạn có thể sao chép trực tiếp Mã giới thiệu hoặc Link giới thiệu để gửi cho bạn bè.';
            target.after(box);
          }
          return;
        }
        const isPreviewThumb = target.classList.contains('ip-thumb');
        const isProductThumb = target.classList.contains('product-thumb');
        if (isPreviewThumb || isProductThumb) {
          const fallback = document.createElement('div');
          fallback.className = isPreviewThumb
            ? 'ip-thumb ip-thumb-fallback'
            : 'product-thumb product-thumb-fallback';
          fallback.setAttribute('aria-hidden', 'true');
          fallback.innerHTML = UI_ICONS.shoppingBagLg;
          target.replaceWith(fallback);
        }
      }
    },
    true
  );

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoot);
  } else if (typeof window !== 'undefined' && window.location) {
    initBoot();
  }
}

if (typeof window !== 'undefined') {
  window.loadAdminSettings = loadAdminSettings;
  window.saveAdminSettings = saveAdminSettings;
  window.applyZaloWidget = applyZaloWidget;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadAdminSettings,
    saveAdminSettings,
    applyZaloWidget
  };
}

// ================= NOTIFICATION CENTER & CUSTOM USER CASHBACK RATE =================
let lastNotifSyncAt = 0;

function updateNotificationBadge(count) {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const n = Math.max(0, Number(count) || 0);
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

function formatRelativeTimeVi(isoStr) {
  const ts = new Date(isoStr).getTime();
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  return `${Math.floor(diffSec / 86400)} ngày trước`;
}

function renderNotificationsList(items = []) {
  const listEl = document.getElementById('notifList');
  if (!listEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    listEl.innerHTML = '<div class="notif-empty">Chưa có thông báo nào.</div>';
    return;
  }
  listEl.innerHTML = items
    .map(
      (n) => `
      <div class="notif-item ${n.isRead ? '' : 'is-unread'}" data-notif-id="${escapeHtml(n.id)}">
        <span class="notif-item-dot" aria-hidden="true"></span>
        <div class="notif-item-body">
          <div class="notif-item-title">${escapeHtml(n.title)}</div>
          <div class="notif-item-msg">${escapeHtml(n.message)}</div>
          <div class="notif-item-time">${escapeHtml(formatRelativeTimeVi(n.createdAt))}</div>
        </div>
      </div>`
    )
    .join('');
}

async function fetchAndRenderNotifications() {
  const listEl = document.getElementById('notifList');
  if (listEl && !listEl.children.length) {
    listEl.innerHTML = '<div class="notif-empty">Đang tải thông báo...</div>';
  }
  try {
    const res = await apiFetch('/api/notifications?page=1&limit=20');
    lastNotifSyncAt = Date.now();
    updateNotificationBadge(res.unreadCount || 0);
    renderNotificationsList(res.items || []);
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<div class="notif-empty">${escapeHtml(err.message)}</div>`;
    }
  }
}

function setNotifDrawerOpen(isOpen) {
  const dd = document.getElementById('notifDropdown');
  const backdrop = document.getElementById('notifBackdrop');
  const btn = document.getElementById('notifBellBtn');
  if (dd) dd.classList.toggle('hidden', !isOpen);
  if (backdrop) backdrop.classList.toggle('hidden', !isOpen);
  if (btn) btn.setAttribute('aria-expanded', String(Boolean(isOpen)));
}

on('notifBellBtn', 'click', async (e) => {
  e.stopPropagation();
  const dd = document.getElementById('notifDropdown');
  if (!dd) return;
  const willOpen = dd.classList.contains('hidden');
  setNotifDrawerOpen(willOpen);
  if (willOpen) {
    const listEl = document.getElementById('notifList');
    if (listEl) {
      listEl.innerHTML = '<div class="notif-skeleton"><div class="skeleton-line w-70"></div><div class="skeleton-line w-90"></div></div>'.repeat(3);
    }
    await fetchAndRenderNotifications();
  }
});

on('notifBackdrop', 'click', () => setNotifDrawerOpen(false));
on('notifCloseBtn', 'click', () => setNotifDrawerOpen(false));

on('notifMarkAllBtn', 'click', async (e) => {
  e.stopPropagation();
  try {
    const res = await apiFetch('/api/notifications/mark-read', {
      method: 'POST',
      body: JSON.stringify({ all: true })
    });
    updateNotificationBadge(res.unreadCount || 0);
    document.querySelectorAll('#notifList .notif-item.is-unread').forEach((el) => {
      el.classList.remove('is-unread');
    });
  } catch (err) {
    showToast(err.message);
  }
});

on('notifList', 'click', async (e) => {
  const item = e.target.closest('[data-notif-id]');
  if (!item) return;
  const id = item.getAttribute('data-notif-id');
  if (!id || !item.classList.contains('is-unread')) return;
  item.classList.remove('is-unread');
  try {
    const res = await apiFetch('/api/notifications/mark-read', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
    updateNotificationBadge(res.unreadCount || 0);
  } catch (_) {}
});

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('notifBellWrap');
  const dd = document.getElementById('notifDropdown');
  if (dd && !dd.classList.contains('hidden') && !dd.contains(e.target) && (!wrap || !wrap.contains(e.target))) {
    setNotifDrawerOpen(false);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const dd = document.getElementById('notifDropdown');
    if (dd && !dd.classList.contains('hidden')) {
      setNotifDrawerOpen(false);
    }
  }
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !currentUser) return;
  if (Date.now() - lastNotifSyncAt < 60000) return;
  lastNotifSyncAt = Date.now();
  try {
    const res = await apiFetch('/api/notifications?page=1&limit=1');
    updateNotificationBadge(res.unreadCount || 0);
  } catch (_) {}
});

async function submitUserCustomCashbackRate(rateValue) {
  if (!currentManagingUser) return;
  const btn = document.getElementById('btnSaveCustomCashbackRate');
  const resetBtn = document.getElementById('btnResetCustomCashbackRate');
  if (btn) btn.disabled = true;
  if (resetBtn) resetBtn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({
        userId: currentManagingUser.id,
        action: 'set_cashback_rate',
        customCashbackPercent: rateValue
      })
    });
    currentManagingUser.customCashbackPercent = res.customCashbackPercent ?? null;
    const input = document.getElementById('manageCustomCashbackRate');
    if (input) {
      input.value =
        res.customCashbackPercent !== null && res.customCashbackPercent !== undefined
          ? String(res.customCashbackPercent)
          : '';
    }
    showToast(res.message);
    await loadAdminUsersPage(adminUsersPage);
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
  }
}

on('btnSaveCustomCashbackRate', 'click', async () => {
  const raw = document.getElementById('manageCustomCashbackRate')?.value?.trim() ?? '';
  if (raw === '') {
    await submitUserCustomCashbackRate(null);
    return;
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    showToast('Vui lòng nhập % hoàn tiền hợp lệ (>= 0).');
    return;
  }
  await submitUserCustomCashbackRate(num);
});

on('btnResetCustomCashbackRate', 'click', async () => {
  await submitUserCustomCashbackRate(null);
});

on('admBroadcastSendBtn', 'click', async () => {
  const titleEl = document.getElementById('admBroadcastTitle');
  const msgEl = document.getElementById('admBroadcastMessage');
  const title = titleEl?.value?.trim() || '';
  const message = msgEl?.value?.trim() || '';
  if (!title || !message) {
    showToast('Vui lòng nhập đầy đủ tiêu đề và nội dung thông báo.');
    return;
  }
  const btn = document.getElementById('admBroadcastSendBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/notifications/broadcast', {
      method: 'POST',
      body: JSON.stringify({ title, message })
    });
    showToast(res.message || 'Đã gửi thông báo toàn sàn!');
    if (titleEl) titleEl.value = '';
    if (msgEl) msgEl.value = '';
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ================= VIP TIERING PROGRESS, ADMIN TABLE & PUBLIC LEADERBOARD =================
let latestVipTiersAdmin = [];
let latestLeaderboardData = null;
let activeLeaderboardTab = 'spend';

function renderUserVipProgress(vipInfo, effectiveRate) {
  const card = document.getElementById('userVipCard');
  if (!card) return;
  if (!vipInfo || vipInfo.enabled === false) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const badgeEl = document.getElementById('userVipBadge');
  const rateEl = document.getElementById('userEffectiveRateBadge');
  const fillEl = document.getElementById('userVipProgressFill');
  const noteEl = document.getElementById('userVipProgressNote');

  const cur = vipInfo.currentTier || { code: 'bronze', name: 'Thành viên Đồng', minSpend: 0, cashbackPercent: 70 };
  const next = vipInfo.nextTier || null;
  const spend = Math.max(0, Number(vipInfo.totalApprovedSpend || 0));
  const shownRate = Number.isFinite(Number(effectiveRate)) ? Number(effectiveRate) : cur.cashbackPercent;

  if (badgeEl) badgeEl.innerHTML = `${renderVipBadgeSvg(cur.code || cur.icon, true)}<span>${escapeHtml(cur.name)}</span>`;
  if (rateEl) rateEl.textContent = `Hoàn ${shownRate}%`;

  if (!next) {
    if (fillEl) fillEl.style.width = '100%';
    if (noteEl) {
      noteEl.textContent = `Tổng chi tiêu đã duyệt: ${fmtVnd(spend)} — Bạn đã đạt hạng cao nhất!`;
    }
    return;
  }

  const baseMin = Number(cur.minSpend || 0);
  const nextMin = Number(next.minSpend || 0);
  const span = Math.max(1, nextMin - baseMin);
  const pct = Math.min(100, Math.max(0, Math.round(((spend - baseMin) / span) * 100)));
  const remaining = Math.max(0, nextMin - spend);

  if (fillEl) fillEl.style.width = `${pct}%`;
  if (noteEl) {
    noteEl.textContent = `Đã tích lũy ${fmtVnd(spend)} / ${fmtVnd(nextMin)} — Còn ${fmtVnd(remaining)} để lên ${next.name} (${next.cashbackPercent}%)`;
  }
}

function renderAdminVipTiersTable(tiers = []) {
  latestVipTiersAdmin = Array.isArray(tiers) ? tiers.map((t) => ({ ...t })) : [];
  const tbody = document.getElementById('admVipTiersTableBody');
  if (!tbody) return;
  if (latestVipTiersAdmin.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">Chưa có cấu hình bậc VIP.</td></tr>';
    return;
  }
  tbody.innerHTML = latestVipTiersAdmin
    .map(
      (t, idx) => `
      <tr data-vip-row="${idx}">
        <td><strong>${escapeHtml(t.icon || '🏅')} ${escapeHtml(t.code)}</strong></td>
        <td><input type="text" class="adm-vip-name" value="${escapeHtml(t.name || '')}" maxlength="60" /></td>
        <td><input type="number" class="adm-vip-spend" value="${Number(t.minSpend || 0)}" min="0" step="100000" /></td>
        <td><input type="number" class="adm-vip-rate" value="${Number(t.cashbackPercent ?? 70)}" min="0" step="0.5" /></td>
      </tr>`
    )
    .join('');
}

on('admSaveVipTiersBtn', 'click', async () => {
  const tbody = document.getElementById('admVipTiersTableBody');
  const enabled = document.getElementById('admVipTiersEnabled')?.checked !== false;
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr[data-vip-row]'));
  const updated = rows.map((row, idx) => {
    const base = latestVipTiersAdmin[idx] || {};
    const name = row.querySelector('.adm-vip-name')?.value?.trim() || base.name || `Hạng ${idx + 1}`;
    const minSpend = Number(row.querySelector('.adm-vip-spend')?.value ?? base.minSpend ?? 0);
    const cashbackPercent = Number(row.querySelector('.adm-vip-rate')?.value ?? base.cashbackPercent ?? 70);
    return {
      code: base.code || `tier_${idx}`,
      icon: base.icon || '🏅',
      name,
      minSpend,
      cashbackPercent
    };
  });

  const btn = document.getElementById('admSaveVipTiersBtn');
  if (btn) btn.disabled = true;
  try {
    await apiFetch('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({
        vipTiersEnabled: enabled,
        vipTiers: updated
      })
    });
    showToast('Đã lưu bảng cấu hình phân hạng VIP!');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

function renderLeaderboardTable(mode = 'spend', { animate = false } = {}) {
  activeLeaderboardTab = mode === 'cashback' ? 'cashback' : 'spend';
  const viewEl = document.getElementById('view-leaderboard');
  const headerEl = document.getElementById('lbMetricHeader');
  const tbody = document.getElementById('leaderboardTableBody');
  const tableWrap = document.getElementById('leaderboardTableWrap');
  const listHeadingEl = document.getElementById('leaderboardListHeading');
  const myRankEl = document.getElementById('leaderboardMyRank');

  viewEl?.classList.toggle('lb-mode-cashback', activeLeaderboardTab === 'cashback');

  document.querySelectorAll('[data-lb-tab]').forEach((btn) => {
    const isActive = btn.getAttribute('data-lb-tab') === activeLeaderboardTab;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('btn-outline', !isActive);
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (headerEl) {
    headerEl.textContent = activeLeaderboardTab === 'cashback' ? 'Tổng tiền hoàn' : 'Tổng giá trị đơn';
  }
  if (!tbody) return;

  const data = latestLeaderboardData || { topBySpend: [], topByCashback: [] };
  const list = activeLeaderboardTab === 'cashback' ? data.topByCashback : data.topBySpend;
  const myRank = activeLeaderboardTab === 'cashback' ? data.myRankCashback : data.myRankSpend;

  if (myRankEl) {
    if (myRank) {
      const val = activeLeaderboardTab === 'cashback' ? myRank.totalCashback : myRank.totalSpend;
      const initial = String(myRank.displayName || currentUser?.name || 'U').trim().charAt(0).toUpperCase() || 'U';
      const avatarSrc = isSafeAvatarUrl(myRank.avatarUrl || currentUser?.avatarUrl)
        ? (myRank.avatarUrl || currentUser?.avatarUrl)
        : '';
      const avatarInner = avatarSrc
        ? `<img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(myRank.displayName)}" loading="lazy" />`
        : escapeHtml(initial);
      const hasGap = Number.isFinite(Number(myRank.gapToNextRank)) && Number(myRank.gapToNextRank) > 0 && myRank.nextRank;
      const gapHtml = hasGap
        ? `<div class="lb-my-rank-gap">Còn thiếu ${fmtVnd(myRank.gapToNextRank)} để vượt hạng #${myRank.nextRank}</div>`
        : (myRank.rank === 1 ? '<div class="lb-my-rank-gap">Bạn đang dẫn đầu bảng xếp hạng</div>' : '');
      const isInTop20 = myRank.rank <= 20;
      const showJumpBtn = myRank.rank > 3 && isInTop20;
      const jumpBtnHtml = showJumpBtn
        ? '<button type="button" class="lb-my-rank-jump" id="lbJumpToMyRankBtn">Xem vị trí</button>'
        : '';

      const shortMyTier = String(myRank.vipTierName || '').replace(/^Thành viên\s+/i, '');
      const myTierPillHtml = shortMyTier
        ? `<span class="lb-my-tier-pill">${renderVipBadgeSvg(myRank.vipTier || myRank.vipTierIcon, false)}<span>${escapeHtml(shortMyTier)}</span></span>`
        : '';

      myRankEl.classList.remove('is-unranked', 'hidden');
      myRankEl.classList.toggle('is-sticky-bottom', !isInTop20);
      myRankEl.innerHTML = `
        <div class="lb-my-rank-main">
          <span class="lb-user-avatar">${avatarInner}</span>
          <div class="lb-my-rank-info">
            <div class="lb-my-rank-line"><span>Hạng #${myRank.rank} • ${fmtVnd(val)}</span>${myTierPillHtml}</div>
            ${gapHtml}
          </div>
        </div>
        ${jumpBtnHtml}
      `;
    } else if (authToken && currentUser && currentUser.role !== 'admin') {
      myRankEl.classList.remove('hidden', 'is-sticky-bottom');
      myRankEl.classList.add('is-unranked');
      myRankEl.innerHTML = `
        <div class="lb-my-rank-info">
          <div class="lb-my-rank-line" style="font-weight:600;color:var(--text-sub);">Bạn chưa có đơn đã duyệt trong bảng xếp hạng</div>
          <div class="lb-my-rank-gap">Lên đơn qua LiLa để xuất hiện trên bảng xếp hạng nhé!</div>
        </div>
      `;
    } else {
      myRankEl.classList.add('hidden');
      myRankEl.classList.remove('is-sticky-bottom', 'is-unranked');
    }
  }

  const podiumEl = document.getElementById('leaderboardPodium');
  if (!Array.isArray(list) || list.length === 0) {
    if (podiumEl) {
      podiumEl.innerHTML = '';
      podiumEl.classList.add('hidden');
      podiumEl.classList.remove('is-two');
    }
    listHeadingEl?.classList.add('hidden');
    tableWrap?.classList.remove('hidden');
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">Chưa có dữ liệu đơn đã duyệt để xếp hạng.</td></tr>';
    return;
  }

  let hasPodium = false;
  let podiumCount = 0;
  if (podiumEl) {
    const top3 = list.slice(0, 3);
    if (top3.length >= 2) {
      hasPodium = true;
      podiumCount = top3.length;
      const ordered = top3.length === 3 ? [top3[1], top3[0], top3[2]] : [top3[1], top3[0]];
      podiumEl.classList.toggle('is-two', top3.length === 2);
      podiumEl.innerHTML = ordered
        .map((item) => {
          const val = activeLeaderboardTab === 'cashback' ? item.totalCashback : item.totalSpend;
          const medalIcon = item.rank === 1
            ? '<svg class="lb-medal-svg" viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true"><path d="M3.5 17.5 5 8l4.5 3.5L12 6l2.5 5.5L19 8l1.5 9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" fill="#f59e0b" stroke="#b45309" stroke-width="1.6" stroke-linejoin="round"/></svg>'
            : `<svg class="lb-medal-svg" viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.85-4.25 4.14 1 5.86L12 16.9l-5.25 2.75 1-5.86L3.5 9.65l5.9-.85L12 3.5Z" fill="${item.rank === 2 ? '#94a3b8' : '#fb923c'}" stroke="${item.rank === 2 ? '#475569' : '#c2410c'}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
          const medalLabel = `${medalIcon}<span>TOP ${item.rank}</span>`;
          const isMe = currentUser && item.code && currentUser.code === item.code;
          const initial = String(item.displayName || 'U').trim().charAt(0).toUpperCase() || 'U';
          const avatarInner = isSafeAvatarUrl(item.avatarUrl)
            ? `<img src="${escapeHtml(item.avatarUrl)}" alt="${escapeHtml(item.displayName)}" loading="lazy" />`
            : escapeHtml(initial);
          const shortTier = String(item.vipTierName || '').replace(/^Thành viên\s+/i, '');
          const tierPillHtml = shortTier
            ? `<span class="lb-podium-tier">${renderVipBadgeSvg(item.vipTier || item.vipTierIcon, false)}<span>${escapeHtml(shortTier)}</span></span>`
            : '';
          return `
            <div class="lb-podium-card rank-${item.rank}${isMe ? ' is-me' : ''}" data-lb-rank="${item.rank}">
              <span class="lb-podium-medal">${medalLabel}</span>
              <div class="lb-podium-avatar">${avatarInner}</div>
              <div class="lb-podium-name" title="${escapeHtml(item.displayName)}">${escapeHtml(item.displayName)}${isMe ? ' (Bạn)' : ''}</div>
              ${tierPillHtml}
              <div class="lb-podium-val">${fmtVnd(val)}</div>
            </div>
          `;
        })
        .join('');
      podiumEl.classList.remove('hidden');
    } else {
      podiumEl.innerHTML = '';
      podiumEl.classList.add('hidden');
      podiumEl.classList.remove('is-two');
    }
  }

  // Do not duplicate Top 1-3 rows below Podium
  const tableRows = hasPodium ? list.slice(podiumCount) : list;
  if (tableRows.length === 0) {
    listHeadingEl?.classList.add('hidden');
    tableWrap?.classList.add('hidden');
    tbody.innerHTML = '';
  } else {
    if (listHeadingEl) {
      if (hasPodium) {
        const firstRank = tableRows[0].rank;
        const lastRank = tableRows[tableRows.length - 1].rank;
        listHeadingEl.textContent = firstRank === lastRank ? `Hạng ${firstRank}` : `Hạng ${firstRank} – ${lastRank}`;
        listHeadingEl.classList.remove('hidden');
      } else {
        listHeadingEl.classList.add('hidden');
      }
    }
    tableWrap?.classList.remove('hidden');
    tbody.innerHTML = tableRows
      .map((item) => {
        const medalCls = item.rank <= 3 ? `lb-rank-medal lb-rank-${item.rank}` : 'lb-rank-medal';
        const metricVal = activeLeaderboardTab === 'cashback' ? item.totalCashback : item.totalSpend;
        const isMe = currentUser && item.code && currentUser.code === item.code;
        const shortTier = String(item.vipTierName || '').replace(/^Thành viên\s+/i, '');
        const initial = String(item.displayName || 'U').trim().charAt(0).toUpperCase() || 'U';
        const avatarInner = isSafeAvatarUrl(item.avatarUrl)
          ? `<img src="${escapeHtml(item.avatarUrl)}" alt="${escapeHtml(item.displayName)}" loading="lazy" />`
          : escapeHtml(initial);
        return `
          <tr class="${isMe ? 'is-me' : ''}" data-lb-rank="${item.rank}">
            <td class="lb-col-rank"><span class="${medalCls}">#${item.rank}</span></td>
            <td class="lb-col-user">
              <div class="lb-user-row">
                <span class="lb-user-avatar">${avatarInner}</span>
                <div class="lb-user-meta">
                  <strong>${escapeHtml(item.displayName)}${isMe ? ' (Bạn)' : ''}</strong>
                  <div class="lb-user-code" style="font-size:12px;color:#64748b;">${escapeHtml(item.code)}</div>
                </div>
              </div>
            </td>
            <td class="lb-col-tier"><span class="lb-tier-pill">${renderVipBadgeSvg(item.vipTier || item.vipTierIcon, false)}<span>${escapeHtml(shortTier || item.vipTierName || '')}</span></span></td>
            <td class="lb-col-metric"><strong class="lb-metric-val">${fmtVnd(metricVal)}</strong></td>
          </tr>`;
      })
      .join('');
  }

  // Render real VIP tiers benefits card below leaderboard
  const vipCardEl = document.getElementById('leaderboardVipCard');
  if (vipCardEl) {
    const tiers = Array.isArray(data.vipTiers) ? data.vipTiers : [];
    if (tiers.length > 0) {
      const myTierCode = String(currentUser?.vipTier || '').toLowerCase();
      vipCardEl.innerHTML = `
        <div class="lb-vip-head">
          <h3>Quyền lợi hạng thành viên</h3>
          <span>Tích lũy đơn đã duyệt</span>
        </div>
        <div class="lb-vip-grid">
          ${tiers
            .map((t) => {
              const shortName = String(t.name || t.code || '').replace(/^Thành viên\s+/i, '');
              const isCurrent = Boolean(authToken && myTierCode && String(t.code || '').toLowerCase() === myTierCode);
              const spendLabel = Number(t.minSpend || 0) > 0 ? `Từ ${fmtVnd(t.minSpend)}` : 'Mặc định';
              return `
                <div class="lb-vip-item${isCurrent ? ' is-current' : ''}">
                  <div class="lb-vip-item-top">
                    <span class="lb-vip-name">${renderVipBadgeSvg(t.code || t.icon, false)}<span>${escapeHtml(shortName)}</span></span>
                    <span class="lb-vip-rate">${Number(t.cashbackPercent || 0)}%</span>
                  </div>
                  <div class="lb-vip-spend">${spendLabel}${isCurrent ? ' • <span class="lb-vip-now-tag">Hạng của bạn</span>' : ''}</div>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
      vipCardEl.classList.remove('hidden');
    } else {
      vipCardEl.classList.add('hidden');
    }
  }

  if (animate) {
    [podiumEl, tableWrap].forEach((el) => {
      if (!el || el.classList.contains('hidden')) return;
      el.classList.remove('lb-tab-animate');
      void el.offsetWidth;
      el.classList.add('lb-tab-animate');
    });
  }
}

async function loadPublicLeaderboard() {
  const tbody = document.getElementById('leaderboardTableBody');
  const tableWrap = document.getElementById('leaderboardTableWrap');
  try {
    const data = await apiFetch('/api/leaderboard');
    latestLeaderboardData = data;
    renderLeaderboardTable(activeLeaderboardTab);
  } catch (err) {
    tableWrap?.classList.remove('hidden');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="lb-error-box"><span>${escapeHtml(err.message || 'Không thể tải bảng xếp hạng.')}</span><button type="button" class="btn btn-outline btn-sm" id="lbRetryBtn">Thử lại</button></div></td></tr>`;
    }
  }
}

document.addEventListener('click', (e) => {
  const lbBtn = e.target.closest('[data-lb-tab]');
  if (lbBtn) {
    renderLeaderboardTable(lbBtn.getAttribute('data-lb-tab'), { animate: true });
    return;
  }
  if (e.target.closest('#lbRetryBtn')) {
    const tbody = document.getElementById('leaderboardTableBody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="skeleton-row"><div class="skeleton-line w-60"></div><div class="skeleton-line w-30"></div></div></td></tr>';
    }
    loadPublicLeaderboard();
    return;
  }
  if (e.target.closest('#lbJumpToMyRankBtn')) {
    const target = document.querySelector('#view-leaderboard .is-me');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }
  if (e.target.closest('#lbBackToTopBtn')) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const recentChip = e.target.closest('[data-recent-url]');
  if (recentChip) {
    const url = recentChip.getAttribute('data-recent-url');
    if (url && productUrlInput) {
      productUrlInput.value = url;
      clearInputBtn?.classList.remove('hidden');
      handleGetCashbackLink();
    }
  }
});

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => {
    const btn = document.getElementById('lbBackToTopBtn');
    const lbView = document.getElementById('view-leaderboard');
    if (!btn || !lbView) return;
    const shouldShow = lbView.classList.contains('active') && (window.scrollY || 0) > 360;
    btn.classList.toggle('hidden', !shouldShow);
  }, { passive: true });
}

// ================= RECENT CONVERTED LINKS (LOCAL HISTORY, MAX 3) =================
const RECENT_LINKS_STORAGE_KEY = 'lila_recent_links_v1';

function loadRecentConvertedLinks() {
  try {
    const raw = localStorage.getItem(RECENT_LINKS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.url === 'string').slice(0, 3) : [];
  } catch {
    return [];
  }
}

function renderRecentConvertedLinks() {
  const strip = document.getElementById('recentLinksStrip');
  if (!strip) return;
  const list = loadRecentConvertedLinks();
  if (!list.length) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML =
    '<span class="recent-links-label">Vừa tạo:</span>' +
    list
      .map((item) => {
        const prefix = item.platform === 'tiktok' ? 'TikTok' : 'Shopee';
        const shortTitle = String(item.title || prefix).slice(0, 22);
        return `<button type="button" class="recent-link-chip" data-recent-url="${escapeHtml(item.url)}" title="${escapeHtml(item.title || item.url)}">${escapeHtml(shortTitle)}</button>`;
      })
      .join('');
}

function saveRecentConvertedLink(entry) {
  if (!entry || !entry.url) return;
  try {
    const current = loadRecentConvertedLinks().filter((x) => x.url !== entry.url);
    current.unshift({
      url: String(entry.url).slice(0, 500),
      title: String(entry.title || '').slice(0, 80),
      platform: entry.platform === 'tiktok' ? 'tiktok' : 'shopee'
    });
    localStorage.setItem(RECENT_LINKS_STORAGE_KEY, JSON.stringify(current.slice(0, 3)));
    renderRecentConvertedLinks();
  } catch {
    // Ignore storage quota errors
  }
}

function setWithdrawSheetOpen(isOpen) {
  const overlay = document.getElementById('withdrawSheetOverlay');
  if (!overlay) return;
  overlay.classList.toggle('is-open', Boolean(isOpen));
  overlay.setAttribute('aria-modal', isOpen ? 'true' : 'false');
  document.body.classList.toggle('sheet-lock', Boolean(isOpen));
}

on('walletQuickWithdrawBtn', 'click', () => {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches) {
    setWithdrawSheetOpen(true);
    setTimeout(() => document.getElementById('withdrawAmountInput')?.focus(), 260);
    return;
  }
  const panel = document.getElementById('withdrawPanel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => document.getElementById('withdrawAmountInput')?.focus(), 320);
  }
});

on('closeWithdrawSheetBtn', 'click', () => setWithdrawSheetOpen(false));
on('withdrawSheetOverlay', 'click', (e) => {
  if (e.target && e.target.id === 'withdrawSheetOverlay') {
    setWithdrawSheetOpen(false);
  }
});

// Withdraw live VND formatted preview + quick amount chips
function updateWithdrawAmountPreview() {
  const inp = document.getElementById('withdrawAmountInput');
  const prev = document.getElementById('withdrawAmountPreview');
  if (!inp || !prev) return;
  const val = Number(inp.value || 0);
  if (Number.isFinite(val) && val > 0) {
    prev.textContent = `Số tiền rút: ${fmtVnd(val)}`;
    prev.classList.remove('hidden');
  } else {
    prev.textContent = '';
    prev.classList.add('hidden');
  }
}

on('withdrawAmountInput', 'input', updateWithdrawAmountPreview);
document.querySelectorAll('.wd-quick-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const inp = document.getElementById('withdrawAmountInput');
    if (!inp) return;
    const raw = chip.getAttribute('data-wd-amount');
    if (raw === 'max') {
      document.getElementById('btnMaxWithdraw')?.click();
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) inp.value = String(n);
    }
    updateWithdrawAmountPreview();
    try { navigator.vibrate?.(10); } catch {}
  });
});

// Order Search Clear Button
const ordSearchInp = document.getElementById('userOrderSearchInput');
const ordSearchClear = document.getElementById('clearOrderSearchBtn');
if (ordSearchInp && ordSearchClear) {
  const syncOrdClear = () => ordSearchClear.classList.toggle('hidden', !ordSearchInp.value.trim());
  ordSearchInp.addEventListener('input', syncOrdClear);
  ordSearchClear.addEventListener('click', () => {
    ordSearchInp.value = '';
    syncOrdClear();
    loadUserOrdersPage(1);
    ordSearchInp.focus();
  });
}

// Swipe-down-to-close on mobile Bottom Sheets (#withdrawSheetOverlay & #referralSheetOverlay)
function attachSwipeDownToClose(overlayId, panelSelector, closeFn) {
  const overlay = document.getElementById(overlayId);
  const panel = overlay?.querySelector(panelSelector);
  if (!overlay || !panel) return;
  let startY = 0;
  let dragging = false;
  panel.addEventListener('touchstart', (e) => {
    if (panel.scrollTop > 0 || !overlay.classList.contains('is-open')) return;
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const deltaY = (e.changedTouches?.[0]?.clientY || startY) - startY;
    if (deltaY > 75) closeFn();
  }, { passive: true });
}
attachSwipeDownToClose('withdrawSheetOverlay', '.app-sheet-panel', () => setWithdrawSheetOpen(false));
attachSwipeDownToClose('referralSheetOverlay', '.referral-card', () => setReferralSheetOpen(false));
attachSwipeDownToClose('orderDetailSheetOverlay', '.order-detail-sheet', () => closeOrderDetailSheet());

// Auto-blur URL input when clicking Get Cashback Link so mobile keyboard reveals result card
on('getCashbackLinkBtn', 'click', () => {
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches) {
    document.getElementById('productUrlInput')?.blur();
  }
});

// Mobile Pull-to-Refresh on Orders, Wallet & Leaderboard
(function initMobilePullToRefresh() {
  if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 768px)').matches) return;
  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.textContent = 'Thả ra để làm mới...';
  document.body.appendChild(indicator);
  let startY = 0;
  let pulling = false;
  let triggered = false;
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY > 2 || document.body.classList.contains('sheet-lock')) return;
    startY = e.touches[0].clientY;
    pulling = true;
    triggered = false;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 65 && window.scrollY <= 2) {
      indicator.classList.add('is-visible');
      triggered = true;
    } else if (dy < 30) {
      indicator.classList.remove('is-visible');
      triggered = false;
    }
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    indicator.classList.remove('is-visible');
    if (!triggered) return;
    triggered = false;
    const activeView = document.querySelector('.view-section.active')?.id;
    if (activeView === 'view-orders' && typeof loadUserOrdersPage === 'function') {
      loadUserOrdersPage(1);
      showToast('Đang làm mới danh sách đơn hàng...');
    } else if (activeView === 'view-wallet' && typeof loadUserDashboard === 'function') {
      loadUserDashboard();
      showToast('Đang cập nhật số dư ví...');
    } else if (activeView === 'view-leaderboard' && typeof loadPublicLeaderboard === 'function') {
      loadPublicLeaderboard();
      showToast('Đang cập nhật bảng xếp hạng...');
    }
  }, { passive: true });
})();

// PWA Share Target: handle ?shared_url= / ?text= / ?url= shared from Shopee/TikTok on Android
(function handlePwaShareTarget() {
  try {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('shared_url') || params.get('url') || params.get('text') || '';
    if (!shared.trim()) return;
    const urlInput = document.getElementById('productUrlInput');
    if (urlInput) {
      urlInput.value = shared.trim();
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
      setTimeout(() => document.getElementById('getCashbackLinkBtn')?.click(), 300);
    }
  } catch {}
})();

on('walletQuickHistoryBtn', 'click', () => {
  const panel = document.getElementById('walletHistoryPanel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ================= USER AVATAR CROPPER & UPLOADER =================
(function initUserAvatarUploader() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const MAX_SOURCE_BYTES = 5 * 1024 * 1024; // 5 MB source image limit
  const OUTPUT_SIZE = 320; // Crisp 320x320 circular avatar
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

  const avatarBtn = document.getElementById('accountAvatarBtn');
  const fileInput = document.getElementById('avatarFileInput');
  const spinnerEl = document.getElementById('accountAvatarSpinner');
  const cropModal = document.getElementById('avatarCropModal');
  const cropStage = document.getElementById('avatarCropStage');
  const cropCanvas = document.getElementById('avatarCropCanvas');
  const zoomSlider = document.getElementById('avatarZoomSlider');
  const resetBtn = document.getElementById('avatarCropResetBtn');
  const closeBtn = document.getElementById('avatarCropCloseBtn');
  const cancelBtn = document.getElementById('avatarCropCancelBtn');
  const confirmBtn = document.getElementById('avatarCropConfirmBtn');
  const errorEl = document.getElementById('avatarCropError');

  if (!avatarBtn || !fileInput || !cropModal || !cropCanvas) return;

  let isAvatarUploading = false;
  let activeImage = null;
  let activeObjectUrl = null;
  let baseScale = 1;
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart = null;

  function setCropError(msg) {
    if (!errorEl) return;
    if (msg) {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
    } else {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  }

  function revokeActiveObjectUrl() {
    if (activeObjectUrl) {
      try {
        URL.revokeObjectURL(activeObjectUrl);
      } catch {}
      activeObjectUrl = null;
    }
  }

  function clampOffsets() {
    if (!activeImage) return;
    const drawW = activeImage.naturalWidth * baseScale * zoom;
    const drawH = activeImage.naturalHeight * baseScale * zoom;
    const maxOffsetX = Math.max(0, (drawW - OUTPUT_SIZE) / 2);
    const maxOffsetY = Math.max(0, (drawH - OUTPUT_SIZE) / 2);
    offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, offsetX));
    offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, offsetY));
  }

  function renderCropPreview() {
    if (!activeImage || !cropCanvas) return;
    const ctx = cropCanvas.getContext('2d');
    if (!ctx) return;
    clampOffsets();
    ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    const drawW = activeImage.naturalWidth * baseScale * zoom;
    const drawH = activeImage.naturalHeight * baseScale * zoom;
    const dx = (OUTPUT_SIZE - drawW) / 2 + offsetX;
    const dy = (OUTPUT_SIZE - drawH) / 2 + offsetY;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(activeImage, dx, dy, drawW, drawH);
  }

  function closeCropModal() {
    if (isAvatarUploading) return;
    cropModal.classList.add('hidden');
    setCropError('');
    activeImage = null;
    dragStart = null;
    revokeActiveObjectUrl();
    fileInput.value = '';
  }

  function openCropModalWithImage(img) {
    activeImage = img;
    // Cover scale: fills the 320x320 square without stretching or distorting aspect ratio
    baseScale = Math.max(OUTPUT_SIZE / img.naturalWidth, OUTPUT_SIZE / img.naturalHeight);
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    if (zoomSlider) zoomSlider.value = '1';
    setCropError('');
    cropModal.classList.remove('hidden');
    renderCropPreview();
  }

  function validateSelectedFile(file) {
    if (!file) return null;
    const type = String(file.type || '').toLowerCase();
    const extMatch = /\.(jpe?g|png|webp)$/i.test(file.name || '');
    if ((!type || !ALLOWED_TYPES.has(type)) && !extMatch) {
      return 'Định dạng ảnh chưa hỗ trợ. Vui lòng chọn ảnh JPG, PNG hoặc WEBP.';
    }
    if (file.size <= 0) {
      return 'File ảnh bị lỗi hoặc trống. Vui lòng chọn ảnh khác.';
    }
    if (file.size > MAX_SOURCE_BYTES) {
      return 'Ảnh quá lớn (tối đa 5 MB). Vui lòng chọn ảnh nhẹ hơn.';
    }
    return null;
  }

  function exportCompressedBlob() {
    return new Promise((resolve, reject) => {
      cropCanvas.toBlob(
        (webpBlob) => {
          if (webpBlob && webpBlob.type === 'image/webp' && webpBlob.size > 0) {
            return resolve(webpBlob);
          }
          // Fallback to JPEG on browsers without WebP canvas encoding (e.g. older iOS Safari)
          cropCanvas.toBlob(
            (jpegBlob) => {
              if (jpegBlob && jpegBlob.size > 0) return resolve(jpegBlob);
              return reject(new Error('Không thể xử lý ảnh trên trình duyệt này.'));
            },
            'image/jpeg',
            0.86
          );
        },
        'image/webp',
        0.86
      );
    });
  }

  avatarBtn.addEventListener('click', () => {
    if (!authToken || !currentUser) {
      showToast('Vui lòng đăng nhập để thay đổi ảnh đại diện.');
      return;
    }
    if (isAvatarUploading) {
      showToast('Đang tải ảnh đại diện lên, vui lòng chờ giây lát...');
      return;
    }
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return; // User cancelled picker -> no changes

    const errMsg = validateSelectedFile(file);
    if (errMsg) {
      showToast(errMsg);
      fileInput.value = '';
      return;
    }

    revokeActiveObjectUrl();
    const url = URL.createObjectURL(file);
    activeObjectUrl = url;

    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        revokeActiveObjectUrl();
        showToast('Ảnh bị lỗi hoặc không đọc được. Vui lòng chọn ảnh khác.');
        fileInput.value = '';
        return;
      }
      openCropModalWithImage(img);
    };
    img.onerror = () => {
      revokeActiveObjectUrl();
      showToast('File ảnh bị hỏng hoặc không hợp lệ. Vui lòng chọn ảnh JPG, PNG hoặc WEBP.');
      fileInput.value = '';
    };
    img.src = url;
  });

  // Pointer/Touch drag to pan inside circular crop stage
  if (cropStage) {
    cropStage.addEventListener('pointerdown', (e) => {
      if (!activeImage || isAvatarUploading) return;
      e.preventDefault();
      cropStage.setPointerCapture?.(e.pointerId);
      dragStart = { x: e.clientX, y: e.clientY, startOffsetX: offsetX, startOffsetY: offsetY };
    });

    cropStage.addEventListener('pointermove', (e) => {
      if (!dragStart || !activeImage) return;
      const stageRect = cropStage.getBoundingClientRect();
      const ratio = OUTPUT_SIZE / Math.max(1, stageRect.width);
      offsetX = dragStart.startOffsetX + (e.clientX - dragStart.x) * ratio;
      offsetY = dragStart.startOffsetY + (e.clientY - dragStart.y) * ratio;
      renderCropPreview();
    });

    const endDrag = () => {
      dragStart = null;
    };
    cropStage.addEventListener('pointerup', endDrag);
    cropStage.addEventListener('pointercancel', endDrag);
  }

  zoomSlider?.addEventListener('input', () => {
    zoom = Math.max(1, Math.min(3, Number(zoomSlider.value || 1)));
    renderCropPreview();
  });

  resetBtn?.addEventListener('click', () => {
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    if (zoomSlider) zoomSlider.value = '1';
    renderCropPreview();
  });

  closeBtn?.addEventListener('click', closeCropModal);
  cancelBtn?.addEventListener('click', closeCropModal);
  cropModal.addEventListener('click', (e) => {
    if (e.target === cropModal) closeCropModal();
  });

  confirmBtn?.addEventListener('click', async () => {
    if (!activeImage || isAvatarUploading) return;
    if (!authToken || !currentUser) {
      setCropError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      return;
    }

    isAvatarUploading = true;
    setCropError('');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Đang tải ảnh...';
    if (cancelBtn) cancelBtn.disabled = true;
    spinnerEl?.classList.remove('hidden');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const blob = await exportCompressedBlob();
      const headers = { 'Content-Type': blob.type || 'image/webp' };
      if (authToken && authToken !== '__cookie_session__') {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const res = await fetch('/api/user/avatar', {
        method: 'POST',
        headers,
        body: blob,
        credentials: 'same-origin',
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Không thể lưu ảnh đại diện (${res.status}).`);
      }

      if (data.user) {
        currentUser = { ...currentUser, ...data.user };
      } else if (data.avatarUrl) {
        currentUser = { ...currentUser, avatarUrl: data.avatarUrl };
      }
      safeStorage.set(USER_KEY, JSON.stringify(currentUser));
      syncUserAvatarEverywhere(currentUser);

      // Sync own avatar immediately inside cached leaderboard if already loaded
      if (latestLeaderboardData && currentUser.code) {
        const patchList = (arr) => {
          if (!Array.isArray(arr)) return;
          for (const item of arr) {
            if (item && item.code === currentUser.code) {
              item.avatarUrl = currentUser.avatarUrl || '';
            }
          }
        };
        patchList(latestLeaderboardData.topBySpend);
        patchList(latestLeaderboardData.topByCashback);
        if (latestLeaderboardData.myRankSpend) latestLeaderboardData.myRankSpend.avatarUrl = currentUser.avatarUrl || '';
        if (latestLeaderboardData.myRankCashback) latestLeaderboardData.myRankCashback.avatarUrl = currentUser.avatarUrl || '';
        renderLeaderboardTable(activeLeaderboardTab);
      }

      isAvatarUploading = false;
      closeCropModal();
      showToast('Đã cập nhật ảnh đại diện thành công!');
    } catch (err) {
      const isNetworkErr =
        err?.name === 'AbortError' ||
        err instanceof TypeError ||
        String(err?.message || '').includes('Failed to fetch');
      const friendlyMsg = isNetworkErr
        ? 'Mất kết nối mạng khi tải ảnh. Kiểm tra Wi-Fi/4G rồi bấm Lưu để thử lại.'
        : (err?.message || 'Không thể tải ảnh đại diện. Vui lòng thử lại.');
      setCropError(friendlyMsg);
      showToast(friendlyMsg);
    } finally {
      clearTimeout(timeoutId);
      isAvatarUploading = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Lưu ảnh đại diện';
      if (cancelBtn) cancelBtn.disabled = false;
      spinnerEl?.classList.add('hidden');
    }
  });
})();

renderRecentConvertedLinks();
