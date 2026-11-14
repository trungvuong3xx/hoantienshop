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
  siteName: 'Hoàn Tiền Sàn',
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

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.setAttribute('aria-atomic', 'true');
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2800);
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
  }, 15000);

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
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && authToken && !url.includes('/api/auth/')) {
      clearSession();
    }
    if (!res.ok) {
      throw new Error(data.error || `Lỗi kết nối (${res.status})`);
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      // If caller intentionally aborted via signal, preserve AbortError without masking as timeout
      if (options.signal?.aborted && !timedOut) {
        throw err;
      }
      throw new Error('Yêu cầu quá thời gian chờ (Timeout). Vui lòng thử lại.');
    }
    if (err instanceof TypeError || String(err.message).includes('Failed to fetch')) {
      throw new Error('Mất kết nối mạng hoặc máy chủ không phản hồi. Vui lòng kiểm tra lại kết nối.');
    }
    throw err;
  }
}

// Navigation & History API
function switchView(viewName, updateHistory = true, options = {}) {
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

  if (['wallet', 'orders', 'account'].includes(targetView) && authToken && !options.skipReload) {
    loadUserDashboard();
  }
  if (targetView === 'admin' && authToken && currentUser?.role === 'admin') {
    loadAdminDashboard();
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
    renderUserOrdersTable(userOrdersCache);
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

// Modal a11y: Escape to close & Tab / Shift+Tab focus trap cycling
window.addEventListener('keydown', (e) => {
  const openModal = document.querySelector('.modal-backdrop:not(.hidden)');
  if (!openModal) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    openModal.classList.add('hidden');
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

  const privacyBtn = document.getElementById('toggleBalancePrivacyBtn');
  if (privacyBtn) {
    privacyBtn.textContent = isBalanceHidden ? '👁️ Hiện số dư' : '👁️ Ẩn số dư';
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
    textEl.textContent = '✅ Bạn đã đủ điều kiện rút tiền ngay!';
  } else {
    barBox.classList.remove('eligible');
    const remaining = Math.max(0, minAmount - available);
    textEl.textContent = `Cần thêm ${fmtVnd(remaining)} để đạt hạn mức tối thiểu (${fmtVnd(minAmount)})`;
  }
}

function syncAccountProfileUi() {
  if (!currentUser) return;
  const setTxt = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  const displayName = currentUser.name || 'Thành viên';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'U';
  setTxt('accountAvatarInitial', initial);
  setTxt('accountUserName', displayName);
  setTxt('accountUserPhone', currentUser.phone || 'Chưa cập nhật SĐT');
  setTxt('accountUserCode', currentUser.code || '...');

  const bankSummaryEl = document.getElementById('accountBankSummary');
  if (bankSummaryEl) {
    if (currentUser.bankName && currentUser.bankAccount) {
      const ownerPart = currentUser.bankOwner ? ` • ${currentUser.bankOwner}` : '';
      bankSummaryEl.textContent = `🏦 Tài khoản nhận tiền: ${currentUser.bankName} — ${currentUser.bankAccount}${ownerPart}`;
    } else {
      bankSummaryEl.textContent = '🏦 Chưa lưu thông tin ngân hàng nhận tiền (nhập ở mục Ví khi rút lần đầu)';
    }
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
  } else {
    navAuthArea?.classList.remove('hidden');
    navUserArea?.classList.add('hidden');
    navAdminBtn?.classList.add('hidden');
    mobileNavAdminBtn?.classList.add('hidden');
    accountAdminMenuBtn?.classList.add('hidden');
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
}

async function clearSession() {
  authToken = '';
  currentUser = null;
  safeStorage.remove(TOKEN_KEY);
  safeStorage.remove(USER_KEY);
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (err) {
    console.warn('Logout network notice:', err);
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
  const rateEl = document.getElementById('heroCashbackRate');
  if (rateEl) rateEl.textContent = `${publicConfig.cashbackPercent}%`;
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
function openAuthModal(tab = 'login') {
  if (!authModal) return;
  authModal.classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-auth-tab') === tab);
  });
  document.getElementById('loginFormBox')?.classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerFormBox')?.classList.toggle('hidden', tab !== 'register');
  const titleEl = document.getElementById('authModalTitle');
  if (titleEl) {
    titleEl.textContent = tab === 'login' ? 'Đăng nhập tài khoản' : 'Đăng ký tài khoản';
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

on('openLoginBtn', 'click', () => openAuthModal('login'));
on('openRegisterBtn', 'click', () => openAuthModal('register'));
on('walletLoginBtn', 'click', () => openAuthModal('login'));
on('walletRegisterBtn', 'click', () => openAuthModal('register'));
on('closeAuthModalBtn', 'click', () => authModal?.classList.add('hidden'));

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
  const password = document.getElementById('regPassword')?.value || '';
  const refCode = document.getElementById('regRefCode')?.value?.trim() || '';

  if (!name || !phone || !password) {
    showToast('Vui lòng điền đầy đủ họ tên, SĐT và mật khẩu!');
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
on('withdrawFormBox', 'submit', (e) => {
  e.preventDefault();
  document.getElementById('submitWithdrawBtn')?.click();
});

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

on('toggleClaimBoxBtn', 'click', () => {
  const trigger = document.getElementById('toggleClaimBoxBtn');
  const body = document.getElementById('orderClaimCollapsible');
  if (!trigger || !body) return;
  const isNowHidden = body.classList.toggle('hidden');
  trigger.setAttribute('aria-expanded', isNowHidden ? 'false' : 'true');
  if (!isNowHidden) {
    document.getElementById('claimOrderSn')?.focus();
  }
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

if (productUrlInput) {
  productUrlInput.addEventListener('input', () => {
    const val = productUrlInput.value.trim();
    clearInputBtn?.classList.toggle('hidden', !val);
    clearTimeout(previewDebounceTimer);
    if (conversionResultSection) {
      conversionResultSection.classList.add('hidden');
    }
    if (val.startsWith('http://') || val.startsWith('https://')) {
      previewDebounceTimer = setTimeout(() => {
        fetchInstantPreview(val);
      }, 450);
    } else {
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
      if (/https?:\/\//i.test(val)) {
        clearTimeout(previewDebounceTimer);
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
      fetchInstantPreview(text);
      if (/https?:\/\//i.test(text)) {
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
    if (productUrlInput) productUrlInput.value = '';
    clearInputBtn.classList.add('hidden');
    if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
    if (conversionResultSection) conversionResultSection.classList.add('hidden');
    productUrlInput?.focus();
  });
}

async function fetchInstantPreview(rawText) {
  if (!instantPreviewArea || !instantPreviewCard || !rawText) return;
  const match = rawText.match(/https?:\/\/[^\s<>"')\]}]+/i);
  if (!match) return;

  const url = match[0];

  if (previewAbortController) {
    previewAbortController.abort();
  }
  previewAbortController = new AbortController();
  const signal = previewAbortController.signal;

  instantPreviewArea.classList.remove('hidden');
  instantPreviewCard.classList.add('loading');
  instantPreviewCard.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;color:#64748b;font-size:13.5px;padding:8px 4px;">
      <span style="display:inline-block;animation:spin 1s linear infinite;font-size:18px;">⏳</span>
      <span>Đang tra cứu thông tin sản phẩm và tính toán mức hoàn tiền...</span>
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
      instantPreviewArea.classList.add('hidden');
      return;
    }
    renderInstantPreviewCard(res);
  } catch (err) {
    if (signal.aborted || err.name === 'AbortError') {
      // Previous preview request was aborted by subsequent input; silently ignore without altering subsequent state
      return;
    }
    instantPreviewArea.classList.add('hidden');
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
    : `<div class="ip-thumb ip-thumb-fallback">🛍️</div>`;

  const cashbackPill = estCashback
    ? `<span class="cashback-pill">Hoàn tiền ước tính: <strong>${estCashback}</strong></span>`
    : `<span class="cashback-pill" style="background:#f1f5f9;color:#475569;">Có hoàn tiền</span>`;

  const authNotice = !authToken
    ? `<div class="ip-auth-notice">
         ⚠️ Bạn chưa đăng nhập. Nhấn Tạo link để nhận liên kết mua hàng, hoặc <button type="button" class="inline-link" data-open-auth="login">Đăng nhập ngay</button> để tích lũy tiền vào ví!
       </div>`
    : '';

  instantPreviewCard.innerHTML = `
    <div class="ip-top-row">
      <span class="ip-status-badge">✨ Đã tìm thấy sản phẩm</span>
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

async function handleGetCashbackLink() {
  if (isConverting) return;
  const text = productUrlInput?.value?.trim() || '';
  if (!text) {
    showToast('Vui lòng dán link sản phẩm Shopee hoặc TikTok Shop!');
    productUrlInput?.focus();
    return;
  }

  isConverting = true;
  if (getCashbackLinkBtn) {
    getCashbackLinkBtn.disabled = true;
    getCashbackLinkBtn.textContent = 'Đang tạo link...';
  }

  try {
    const data = await apiFetch('/api/convert', {
      method: 'POST',
      body: JSON.stringify({ text })
    });

    const items = (data.items || []).filter((i) => i.status === 'success');
    if (items.length === 0) {
      const firstErr = data.items?.[0]?.error;
      showToast(firstErr || 'Không tìm thấy link sản phẩm Shopee hoặc TikTok Shop hợp lệ.');
      return;
    }

    if (instantPreviewArea) {
      instantPreviewArea.classList.add('hidden');
    }
    conversionResultSection?.classList.remove('hidden');
    conversionResultSection?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });

    const guestNoticeHtml = !authToken
      ? `<div class="guest-card-note">
           Bạn chưa đăng nhập. Bạn có thể nhấn mua hàng nhưng sẽ không được cộng tiền hoàn vào ví.
           <button type="button" class="inline-link" data-open-auth="login">Đăng nhập ngay</button>
         </div>`
      : '';

    if (resultCardsList) {
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
            : '🔗 Liên kết';

          const safeThumbUrl = safeHttpsUrl(item.imageUrl);
          const safeAffUrl = safeAppOrWebUrl(item.affiliateUrl);

          const thumbHtml = safeThumbUrl
            ? `<img src="${safeThumbUrl}" alt="Sản phẩm" class="product-thumb" referrerpolicy="no-referrer" />`
            : `<div class="product-thumb" style="display:flex;align-items:center;justify-content:center;font-size:26px;">🛍️</div>`;

          const priceInfoHtml =
            item.price > 0
              ? `<span class="prod-price-tag">Giá bán: <strong>${fmtVnd(item.price)}</strong></span>`
              : `<span class="prod-price-tag">Giá bán: <strong>Đang cập nhật</strong></span>`;

          const estCashbackHtml =
            item.estimatedCashback > 0
              ? `<span class="cashback-badge">Hoàn tiền ước tính: ~<strong>${fmtVnd(
                  item.estimatedCashback
                )}</strong></span>`
              : `<span class="cashback-badge" style="background:#ecfdf5;color:#059669;">Có hoàn tiền</span>`;

          const rawTitle = item.productName || item.title || '';
          const displayItemTitle =
            rawTitle && !rawTitle.match(/^Sản phẩm (Shopee|TikTok)/i)
              ? rawTitle
              : isShopee
              ? 'Sản phẩm Shopee'
              : 'Sản phẩm TikTok Shop';

          const ctaButtonHtml = safeAffUrl
            ? `<a href="${safeAffUrl}" target="_blank" rel="noopener" class="btn btn-cta btn-open-aff">
                 🛒 ${openAppBtnText} (Mua ngay)
               </a>`
            : `<div style="color:#dc2626;font-size:13px;padding:8px 0;">Không thể tạo liên kết mở app cho sản phẩm này.</div>`;

          return `
            <div class="cashback-product-card">
              <div class="cp-top">
                <span class="valid-badge">✅ Đã tạo link hoàn tiền</span>
                ${platLabel}
              </div>

              <!-- Product Details Row -->
              <div class="product-meta-row">
                ${thumbHtml}
                <div class="product-meta-info">
                  <h4>${escapeHtml(displayItemTitle)}</h4>
                  <div class="product-meta-sub">
                    ${priceInfoHtml}
                    ${estCashbackHtml}
                  </div>
                </div>
              </div>

              <!-- Nút Mua Hàng to rõ -->
              <div class="cp-cta-block">
                ${ctaButtonHtml}
              </div>

              <!-- Rút gọn link aff thành 1 ô ngang duy nhất (Bỏ hoàn toàn mã QR) -->
              <div class="cp-link-single-row">
                <div class="aff-input-box" title="Bấm để sao chép link">
                  <span class="aff-link-icon">🔗</span>
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
                  class="btn btn-copy-inline"
                  data-copy="${safeAffUrl}"
                  data-copy-msg="Đã sao chép link mua hàng hoàn tiền!"
                  title="Sao chép link mua hàng"
                >
                  📋 Sao chép
                </button>
              </div>

              ${guestNoticeHtml}
            </div>
          `;
        })
        .join('');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    isConverting = false;
    if (getCashbackLinkBtn) {
      getCashbackLinkBtn.disabled = false;
      getCashbackLinkBtn.textContent = 'Lấy Link Hoàn Tiền';
    }
  }
}

on('getCashbackLinkBtn', 'click', handleGetCashbackLink);

// ================= USER WALLET & ORDERS =================
const wdBankAccountInput = document.getElementById('wdBankAccount');
const wdPasswordConfirmGroup = document.getElementById('wdPasswordConfirmGroup');

if (wdBankAccountInput) {
  wdBankAccountInput.addEventListener('input', () => {
    const savedAcc = currentUser?.bankAccount || '';
    const newAcc = wdBankAccountInput.value.trim();
    if (savedAcc && newAcc && newAcc !== savedAcc) {
      wdPasswordConfirmGroup?.classList.remove('hidden');
    } else {
      wdPasswordConfirmGroup?.classList.add('hidden');
    }
  });
}

const USER_ORDERS_LIMIT = 10;
let userOrdersPage = 1;
let userOrdersTotalPages = 1;
let userOrdersCache = [];
let activeOrderStatusFilter = 'all';

function syncOrderStatusCounts(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const counts = { all: list.length, pending: 0, approved: 0, cancelled: 0 };
  for (const o of list) {
    const st = String(o.status || 'pending').toLowerCase();
    if (st === 'approved') counts.approved += 1;
    else if (st === 'cancelled') counts.cancelled += 1;
    else counts.pending += 1;
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

function renderUserOrdersTable(orders) {
  const ordBody = document.getElementById('userOrdersTableBody');
  if (!ordBody) return;
  const sourceOrders = Array.isArray(orders) ? orders : [];
  userOrdersCache = sourceOrders;
  syncOrderStatusCounts(sourceOrders);

  const filteredOrders =
    activeOrderStatusFilter === 'all'
      ? sourceOrders
      : sourceOrders.filter((o) => {
          const st = String(o.status || 'pending').toLowerCase();
          return activeOrderStatusFilter === 'pending'
            ? st !== 'approved' && st !== 'cancelled'
            : st === activeOrderStatusFilter;
        });

  if (filteredOrders.length === 0) {
    const emptyMsg =
      sourceOrders.length === 0
        ? 'Chưa có đơn hàng nào được ghi nhận.'
        : 'Không có đơn hàng nào ở trạng thái này trong trang hiện tại.';
    ordBody.innerHTML = `<tr><td colspan="4" class="text-center">${emptyMsg}</td></tr>`;
    return;
  }
  ordBody.innerHTML = filteredOrders
    .map((o) => {
      const stCls = getStatusClass(o.status);
      const stLabel =
        o.status === 'approved'
          ? 'Đã cộng vào ví'
          : o.status === 'cancelled'
          ? 'Đã huỷ'
          : 'Đang đối soát';
      const plat = String(o.platform || '').toLowerCase();
      const platBadge =
        plat === 'tiktok'
          ? '<span class="plat-badge-inline tiktok" style="font-size:10.5px;padding:1px 6px;">TikTok</span>'
          : '<span class="plat-badge-inline shopee" style="font-size:10.5px;padding:1px 6px;">Shopee</span>';
      const dt = o.createdAt ? new Date(o.createdAt).toLocaleDateString('vi-VN') : '—';
      const orderAmtStr = Number(o.orderAmount) > 0 ? ` • Giá đơn: ${fmtVnd(o.orderAmount)}` : '';
      return `
        <tr>
          <td data-label="Mã đơn">
            <div><strong>${escapeHtml(o.orderSn)}</strong> ${platBadge}</div>
            <div style="font-size:11.5px;color:#64748b;margin-top:2px;">${dt}${orderAmtStr}</div>
          </td>
          <td data-label="Sản phẩm">${escapeHtml(o.productName)}</td>
          <td data-label="Tiền hoàn"><strong style="color:#059669;">+${fmtVnd(o.userCashbackAmount)}</strong></td>
          <td data-label="Trạng thái"><span class="status-badge ${stCls}">${stLabel}</span></td>
        </tr>
      `;
    })
    .join('');
}

async function loadUserOrdersPage(page = 1) {
  if (!authToken) return;
  try {
    const q = document.getElementById('userOrderSearchInput')?.value?.trim() || '';
    const params = new URLSearchParams({
      orderPage: String(Math.max(1, Number(page) || 1)),
      orderLimit: String(USER_ORDERS_LIMIT)
    });
    if (q) params.set('q', q);
    const data = await apiFetch('/api/user/me?' + params.toString());
    const orders = data.orders || [];
    renderUserOrdersTable(orders);
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
    refreshOrdersBtn.textContent = 'Đang đồng bộ...';
  }
  try {
    const q = document.getElementById('userOrderSearchInput')?.value?.trim() || '';
    const params = new URLSearchParams({
      orderPage: String(userOrdersPage),
      orderLimit: String(USER_ORDERS_LIMIT)
    });
    if (q) params.set('q', q);
    const data =
      prefetchedData && prefetchedData.user
        ? prefetchedData
        : await apiFetch('/api/user/me?' + params.toString());
    currentUser = data.user;
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

    loadUserReferrals();

    if (currentUser.bankName && document.getElementById('wdBankName')) {
      document.getElementById('wdBankName').value = currentUser.bankName;
    }
    if (currentUser.bankAccount && document.getElementById('wdBankAccount')) {
      document.getElementById('wdBankAccount').value = currentUser.bankAccount;
    }
    if (currentUser.bankOwner && document.getElementById('wdBankOwner')) {
      document.getElementById('wdBankOwner').value = currentUser.bankOwner;
    }
    wdPasswordConfirmGroup?.classList.add('hidden');

    // Orders Table
    const orders = data.orders || [];
    renderUserOrdersTable(orders);
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

    // Balance History Table
    const ledBody = document.getElementById('userLedgerTableBody');
    const ledger = data.ledger || [];
    if (ledBody) {
      if (ledger.length === 0) {
        ledBody.innerHTML =
          '<tr><td colspan="3" class="text-center">Chưa có biến động số dư.</td></tr>';
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
        wdBody.innerHTML =
          '<tr><td colspan="4" class="text-center">Chưa có lịch sử rút tiền.</td></tr>';
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
      refreshOrdersBtn.textContent = '🔄 Đồng bộ';
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
              ? '<span class="status-badge status-approved">✅ Đã có đơn</span>'
              : '<span class="status-badge status-pending">⏳ Chờ đơn đầu</span>';
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
  const title = 'Mua Shopee & TikTok hoàn tiền đến 70%';
  const text = `Tớ đang dùng Hoàn Tiền Sàn mua sắm Shopee & TikTok được hoàn đến 70% hoa hồng! Bấm vào đây đăng ký cùng tớ nhé: ${refLink}`;

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

  if (qrImg) {
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

on('refreshWalletBtn', 'click', () => loadUserDashboard());
on('userOrderSearchBtn', 'click', () => loadUserOrdersPage(1));
on('userOrderSearchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadUserOrdersPage(1);
  }
});
on('userOrdersPrevBtn', 'click', () => {
  if (userOrdersPage > 1) loadUserOrdersPage(userOrdersPage - 1);
});
on('userOrdersNextBtn', 'click', () => {
  if (userOrdersPage < userOrdersTotalPages) loadUserOrdersPage(userOrdersPage + 1);
});

on('submitOrderClaimBtn', 'click', async () => {
  const platform = document.getElementById('claimPlatform')?.value || 'shopee';
  const orderSn = document.getElementById('claimOrderSn')?.value?.trim() || '';
  const productName = document.getElementById('claimProductName')?.value?.trim() || '';

  if (!orderSn) {
    showToast('Vui lòng nhập mã đơn hàng của bạn!');
    return;
  }

  const btn = document.getElementById('submitOrderClaimBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang gửi...';
  }

  try {
    const res = await apiFetch('/api/user/submit-order', {
      method: 'POST',
      body: JSON.stringify({ platform, orderSn, productName })
    });
    if (document.getElementById('claimOrderSn')) document.getElementById('claimOrderSn').value = '';
    if (document.getElementById('claimProductName')) {
      document.getElementById('claimProductName').value = '';
    }
    showToast(res.message || 'Đã lưu mã đơn hàng thành công!');
    await loadUserDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Lưu đơn';
    }
  }
});

function askUserConfirm(message, title = 'Xác Nhận Yêu Cầu') {
  const modal = document.getElementById('confirmActionModal');
  const titleEl = document.getElementById('confirmModalTitle');
  const msgEl = document.getElementById('confirmModalMessage');
  const okBtn = document.getElementById('confirmModalOkBtn');
  const cancelBtn = document.getElementById('confirmModalCancelBtn');
  const closeBtn = document.getElementById('closeConfirmModalBtn');

  if (!modal || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(typeof confirm === 'function' ? confirm(message) : true);
  }

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

on('submitWithdrawBtn', 'click', async () => {
  const method = document.getElementById('wdMethod')?.value || 'bank';
  const bankName = document.getElementById('wdBankName')?.value?.trim() || '';
  const bankAccount = document.getElementById('wdBankAccount')?.value?.trim() || '';
  const bankOwner = document.getElementById('wdBankOwner')?.value?.trim() || '';
  const amountStr = (document.getElementById('withdrawAmountInput') || document.getElementById('wdAmount'))?.value?.trim() || '';
  const currentPassword = document.getElementById('wdCurrentPassword')?.value || '';

  const amount = Number(amountStr);
  const minAmount = numOr(publicConfig.minWithdrawAmount, 50000);
  const available = currentUser?.balanceAvailable || 0;

  if (!amountStr || isNaN(amount) || !Number.isInteger(amount) || amount <= 0) {
    showToast('Vui lòng nhập số tiền rút hợp lệ (số nguyên dương)!');
    return;
  }
  if (amount < minAmount) {
    showToast(`Số tiền rút tối thiểu là ${fmtVnd(minAmount)}.`);
    return;
  }
  if (amount > available) {
    showToast(`Số dư khả dụng (${fmtVnd(available)}) không đủ để rút ${fmtVnd(amount)}.`);
    return;
  }
  if (!bankName || !bankAccount || !bankOwner) {
    showToast('Vui lòng nhập đầy đủ thông tin tài khoản ngân hàng nhận tiền.');
    return;
  }

  const ok = await askUserConfirm(
    `• Số tiền: ${fmtVnd(
      amount
    )}\n• Ngân hàng: ${bankName}\n• Số tài khoản: ${bankAccount}\n• Chủ tài khoản: ${bankOwner}\n\nBạn có chắc chắn muốn gửi yêu cầu rút tiền này không?`,
    'Xác Nhận Yêu Cầu Rút Tiền'
  );
  if (!ok) return;

  const btn = document.getElementById('submitWithdrawBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang gửi yêu cầu...';
  }

  const idempotencyKey =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2);

  try {
    await apiFetch('/api/user/withdraw', {
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
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Gửi Yêu Cầu Rút Tiền';
    }
  }
});

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
  setVal('admZaloGroupUrl', s.zaloGroupUrl || '');

  const zaloWidgetEl = document.getElementById('admZaloWidgetEnabled');
  if (zaloWidgetEl) {
    zaloWidgetEl.checked = s.zaloWidgetEnabled !== false;
  }
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
      '<tr><td colspan="8" class="text-center">Chưa có đơn hàng nào.</td></tr>';
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
      return `
        <tr>
          <td><strong>${escapeHtml(u.code)}</strong></td>
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
             )}">${ADMIN_SVG.trash}<span>Xóa</span></button>`
          : w.status === 'rejected' || w.status === 'cancelled'
          ? `<button type="button" class="btn btn-ghost btn-xs text-danger btn-icon-svg" data-wd-delete="${escapeHtml(
              w.id
            )}">${ADMIN_SVG.trash}<span>Xóa</span></button>`
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

    loadAdminSettings(s);

    // Orders Table
    renderAdminOrdersTable(latestAdminOrders);

    // Withdrawals Table
    renderAdminWithdrawalsTable(latestAdminWithdrawals);

    // Users Table
    renderAdminUsersTable(latestAdminUsers);
  } catch (err) {
    showToast(err.message);
  }
}

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
  const ok = await askUserConfirm(
    'Hệ thống sẽ dọn sạch tài khoản test, đơn hàng thử nghiệm, lệnh rút tiền & sổ cái test rác (giữ nguyên toàn bộ tài khoản & giao dịch thật).\n\nBạn có muốn thực hiện ngay không?',
    'Dọn Dữ Liệu Test Rác'
  );
  if (!ok) return;

  const btn = document.getElementById('cleanTestDataBtn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang dọn rác...';
  }
  try {
    const res = await apiFetch('/api/admin/cleanup-test-data', { method: 'POST', body: '{}' });
    showToast(res.message || 'Đã dọn sạch dữ liệu test rác!');
    await loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml || 'Dọn rác Test';
    }
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

  if (!orderSn) {
    showToast('Vui lòng nhập mã đơn hàng!');
    return;
  }

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
      const order = latestAdminOrders.find((o) => (o.id || o.orderSn) === orderId || o.orderSn === orderSn);

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
            body: JSON.stringify({ id: order?.id, orderSn })
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
      const confirmed = await askUserConfirm(
        `Xác nhận đánh dấu ${label} cho yêu cầu rút tiền #${id}?`,
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
        `Bạn có chắc chắn muốn xóa yêu cầu rút tiền #${id} không?\nNếu lệnh đang chờ duyệt, số tiền sẽ được hoàn lại vào ví khách trước khi xóa.`,
        'Xóa Yêu Cầu Rút Tiền'
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
        showToast('Đã xóa yêu cầu rút tiền!');
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
  setVal('manageAdjustAmount', '');
  setVal('manageAdjustNote', '');

  const lockBtn = document.getElementById('btnToggleUserLock');
  if (lockBtn) {
    lockBtn.textContent = user.accountLocked ? 'Mở Khóa Tài Khoản' : 'Khóa Tài Khoản Này';
    lockBtn.className = user.accountLocked ? 'btn btn-success btn-sm' : 'btn btn-outline btn-sm';
  }

  userManageModal.classList.remove('hidden');
}

on('closeUserManageModalBtn', 'click', () => {
  userManageModal?.classList.add('hidden');
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
    if (document.getElementById('manageNewPassword')) {
      document.getElementById('manageNewPassword').value = '';
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
    `Bạn có chắc chắn muốn xóa tài khoản ${currentManagingUser.code} (${currentManagingUser.phone}) không?`,
    'Xóa Tài Khoản Thành Viên'
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
function detectCsvDelimiter(headerLine) {
  let commaCount = 0;
  let semiCount = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ',') commaCount++;
      else if (ch === ';') semiCount++;
    }
  }
  return semiCount > commaCount ? ';' : ',';
}

function splitCsvLine(line, delimiter) {
  const delim = delimiter || detectCsvDelimiter(line);
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Robust Vietnamese & International money parser
function parseVnMoney(raw) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim().replace(/[₫đVNDvnd\s]/g, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes('.')) {
    const parts = s.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      s = s.replace(/\./g, '');
    }
  } else if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

on('admCsvInput', 'change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const MAX_CSV_SIZE = 2 * 1024 * 1024; // Enforce 2MB client-side limit
  if (file.size > MAX_CSV_SIZE) {
    showToast('Kích thước file CSV vượt quá giới hạn 2MB.');
    e.target.value = '';
    return;
  }

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      showToast('File CSV trống hoặc không đúng định dạng.');
      return;
    }

    const delimiter = detectCsvDelimiter(lines[0]);
    const headers = splitCsvLine(lines[0], delimiter).map((h) => h.replace(/^\uFEFF/, '').toLowerCase().trim());
    const rows = [];
    let totalEstComm = 0;
    let skippedCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i], delimiter);
      if (cols.length < 2) {
        skippedCount++;
        continue;
      }

      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = cols[idx] || '';
      });

      const orderSn =
        rowObj['mã đơn hàng'] ||
        rowObj['order id'] ||
        rowObj['order_id'] ||
        rowObj['conversion_id'] ||
        rowObj['transaction_id'] ||
        rowObj['ordersn'] ||
        cols[0] ||
        '';

      const cleanOrderSn = String(orderSn).trim();
      // Validate orderSn format before submission
      if (!cleanOrderSn || cleanOrderSn.length < 2 || !/^[A-Za-z0-9_\-\.]+$/.test(cleanOrderSn)) {
        skippedCount++;
        continue;
      }

      const subId1 =
        rowObj['sub_id1'] ||
        rowObj['sub id 1'] ||
        rowObj['sub_id'] ||
        rowObj['sub1'] ||
        rowObj['utm_source'] ||
        'GUEST';

      const commRaw =
        rowObj['tổng hoa hồng đơn hàng(₫)'] ||
        rowObj['hoa hồng ròng'] ||
        rowObj['total commission'] ||
        rowObj['net commission'] ||
        rowObj['pub_commission'] ||
        rowObj['hoa hồng'] ||
        rowObj['reward'] ||
        '0';

      const amountRaw =
        rowObj['giá trị đơn hàng(₫)'] ||
        rowObj['billing'] ||
        rowObj['total_amount'] ||
        rowObj['order amount'] ||
        '0';

      const totalCommission = parseVnMoney(commRaw);
      const orderAmount = parseVnMoney(amountRaw);

      // Validate finite non-negative numbers before submission
      if (
        isNaN(totalCommission) ||
        !Number.isFinite(totalCommission) ||
        totalCommission < 0 ||
        isNaN(orderAmount) ||
        !Number.isFinite(orderAmount) ||
        orderAmount < 0
      ) {
        skippedCount++;
        continue;
      }

      const statusRaw = (
        rowObj['trạng thái đơn hàng'] ||
        rowObj['order status'] ||
        rowObj['status'] ||
        rowObj['trạng thái'] ||
        ''
      ).toLowerCase();

      const merchantRaw = (
        rowObj['merchant'] ||
        rowObj['chiến dịch'] ||
        rowObj['platform'] ||
        ''
      ).toLowerCase();

      totalEstComm += totalCommission;

      const status =
        statusRaw === '1' ||
        statusRaw.includes('hoàn thành') ||
        statusRaw.includes('completed') ||
        statusRaw.includes('approved') ||
        statusRaw.includes('đã duyệt')
          ? 'approved'
          : statusRaw === '2' ||
            statusRaw === '-1' ||
            statusRaw.includes('huỷ') ||
            statusRaw.includes('hủy') ||
            statusRaw.includes('cancel') ||
            statusRaw.includes('reject')
          ? 'cancelled'
          : 'pending';

      const platform = merchantRaw.includes('tiktok') ? 'tiktok' : 'shopee';

      rows.push({
        orderSn: cleanOrderSn,
        userCode: String(subId1 || 'GUEST').trim(),
        totalCommission,
        orderAmount,
        platform,
        status
      });
    }

    if (rows.length === 0) {
      showToast('Không tìm thấy dòng dữ liệu đơn hàng hợp lệ nào trong file CSV.');
      return;
    }

    const confirmMsg = `• Số đơn hợp lệ: ${rows.length}\n• Số dòng bỏ qua/lỗi: ${skippedCount}\n• Tổng hoa hồng ước tính: ${fmtVnd(
      totalEstComm
    )}\n\nBạn có muốn tiếp tục nhập và cập nhật ví khách hàng không?`;
    const confirmed = await askUserConfirm(confirmMsg, 'Xác Nhận Nhập CSV Đối Soát');
    if (!confirmed) return;

    // Batch requests in chunks of 500 rows to prevent payload exhaustion
    const CHUNK_SIZE = 500;
    let totalImported = 0;
    const allChunkErrors = [];

    for (let c = 0; c < rows.length; c += CHUNK_SIZE) {
      const chunk = rows.slice(c, c + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const res = await apiFetch('/api/admin/import-orders', {
        method: 'POST',
        body: JSON.stringify({ rows: chunk })
      });
      if (typeof res?.importedCount === 'number') {
        totalImported += res.importedCount;
      }
      if (Array.isArray(res?.errors) && res.errors.length > 0) {
        allChunkErrors.push(...res.errors);
      }
    }

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
    showToast(`Lỗi đọc file CSV: ${err.message}`);
  } finally {
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

// Register Service Worker if supported
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

function isPwaStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://')
  );
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  const isIosUa = /iphone|ipad|ipod/i.test(ua);
  const isIpadOs = navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
  return (isIosUa || isIpadOs) && !window.MSStream;
}

function showPwaBanner() {
  if (isPwaStandalone()) return;
  const dismissedTime = safeStorage.get('hts_pwa_dismissed');
  if (dismissedTime && Date.now() - Number(dismissedTime) < 2 * 86400 * 1000) {
    return;
  }
  if (!pwaInstallBanner) return;

  if (isIosDevice()) {
    if (pwaBannerDesc) {
      pwaBannerDesc.textContent =
        'Thêm Hoàn Tiền Sàn ra màn hình chính iPhone để mở nhanh như App.';
    }
  } else {
    if (pwaBannerDesc) {
      pwaBannerDesc.textContent = 'Thêm Hoàn Tiền Sàn ra màn hình chính để truy cập nhanh.';
    }
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
          Trên trình duyệt Safari của iPhone, nhấn nút <strong>Chia sẻ</strong> (biểu tượng hình vuông có mũi tên hướng lên <span class="pwa-guide-highlight">⬆️</span> ở thanh dưới cùng).
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">2</div>
        <div class="pwa-step-text">
          Cuộn xuống dưới và chọn dòng <span class="pwa-guide-highlight">➕ Thêm vào MH chính</span> (Add to Home Screen).
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">3</div>
        <div class="pwa-step-text">
          Nhấn nút <strong>Thêm</strong> (Add) ở góc trên bên phải màn hình. Biểu tượng ứng dụng <strong>Hoàn Tiền Sàn</strong> sẽ xuất hiện ngay trên màn hình chính của bạn!
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
          Chọn mục <span class="pwa-guide-highlight">📲 Cài đặt ứng dụng</span> hoặc <strong>Thêm vào màn hình chính</strong>.
        </div>
      </div>
      <div class="pwa-step-item">
        <div class="pwa-step-num">3</div>
        <div class="pwa-step-text">
          Nhấn <strong>Cài đặt</strong> để hoàn tất. Bạn có thể mở Hoàn Tiền Sàn trực tiếp từ màn hình điện thoại bất cứ lúc nào!
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
          showToast('Đang cài đặt Hoàn Tiền Sàn ra màn hình chính...');
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

// Auto-trigger banner after initial page load only on iOS or when prompt is available
setTimeout(() => {
  if (isIosDevice() || deferredInstallPrompt) {
    showPwaBanner();
  }
}, 1500);

// ================= BOOTSTRAP INITIALIZATION =================
async function initBoot() {
  syncAuthUi();

  await Promise.all([
    initPublicConfig(),
    authToken ? loadUserDashboard() : Promise.resolve()
  ]);

  // Restore view from URL hash on load (support both guide and faq routes)
  const initialHash = window.location.hash.replace('#', '');
  if (
    initialHash &&
    (['home', 'wallet', 'admin', 'guide', 'faq', 'terms'].includes(initialHash) ||
      ['orders', 'account'].includes(initialHash))
  ) {
    switchView(initialHash, false, {
      skipReload: initialHash === 'wallet' || initialHash === 'orders' || initialHash === 'account'
    });
  }
}

// Global Escape key listener to close active modals
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modalIds = [
        'authModal',
        'userManageModal',
        'orderEditModal',
        'vietQrModal',
        'refQrModal',
        'pwaGuideModal',
        'confirmActionModal'
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
        if (target.classList.contains('ip-thumb') || target.classList.contains('product-thumb')) {
          target.style.display = 'none';
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
