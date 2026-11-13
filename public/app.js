const TOKEN_KEY = 'hoantienshop_token_v1';
const USER_KEY = 'hoantienshop_user_v1';

// Purge any legacy token from localStorage; auth now uses HttpOnly; SameSite=Lax cookie (hts_auth)
try {
  localStorage.removeItem(TOKEN_KEY);
} catch {}

let currentUser = null;
try {
  const saved = localStorage.getItem(USER_KEY);
  if (saved) currentUser = JSON.parse(saved);
} catch {}
let authToken = currentUser ? 'httponly_cookie_session' : '';

let publicConfig = {
  siteName: 'Hoàn Tiền Sàn',
  cashbackPercent: 70,
  taxDeductPercent: 10,
  minWithdrawAmount: 50000
};

// Capture ?ref=... referral code from URL if present
const urlParams = new URLSearchParams(window.location.search);
const urlRefCode = urlParams.get('ref');
if (urlRefCode) {
  sessionStorage.setItem('hoantienshop_ref', urlRefCode.trim());
}

function fmtVnd(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpsUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? escapeHtml(u.toString()) : '';
  } catch {
    return '';
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

async function copyText(text, msg = 'Đã sao chép thành công!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(msg);
  }
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && authToken && !url.includes('/api/auth/')) {
    clearSession();
  }
  if (!res.ok) {
    throw new Error(data.error || `Lỗi kết nối (${res.status})`);
  }
  return data;
}

// Navigation
function switchView(viewName) {
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === viewName);
  });

  if (viewName === 'wallet' && authToken) {
    loadUserDashboard();
  }
  if (viewName === 'admin' && authToken && currentUser?.role === 'admin') {
    loadAdminDashboard();
  }
}

document.body.addEventListener('click', (e) => {
  const navEl = e.target.closest('[data-nav]');
  if (navEl) {
    e.preventDefault();
    switchView(navEl.getAttribute('data-nav'));
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

  const qrBtn = e.target.closest('[data-vietqr]');
  if (qrBtn) {
    const imgUrl = qrBtn.getAttribute('data-vietqr');
    const info = qrBtn.getAttribute('data-vietqr-info') || '';
    document.getElementById('vietQrModalImg').src = imgUrl;
    document.getElementById('vietQrModalInfo').textContent = info;
    document.getElementById('vietQrModal').classList.remove('hidden');
  }
});

document.getElementById('closeVietQrModalBtn').addEventListener('click', () => {
  document.getElementById('vietQrModal').classList.add('hidden');
});

// Sync Auth UI
function syncAuthUi() {
  const navAuthArea = document.getElementById('navAuthArea');
  const navUserArea = document.getElementById('navUserArea');
  const navAdminBtn = document.getElementById('navAdminBtn');
  const walletGuestPrompt = document.getElementById('walletGuestPrompt');
  const walletAuthenticatedContent = document.getElementById('walletAuthenticatedContent');

  if (authToken && currentUser) {
    navAuthArea.classList.add('hidden');
    navUserArea.classList.remove('hidden');
    walletGuestPrompt.classList.add('hidden');
    walletAuthenticatedContent.classList.remove('hidden');

    document.getElementById('headerUserName').textContent = currentUser.name;
    document.getElementById('headerUserBalance').textContent = fmtVnd(
      currentUser.balanceAvailable
    );

    if (currentUser.role === 'admin') {
      navAdminBtn.classList.remove('hidden');
    } else {
      navAdminBtn.classList.add('hidden');
    }
  } else {
    navAuthArea.classList.remove('hidden');
    navUserArea.classList.add('hidden');
    navAdminBtn.classList.add('hidden');
    walletGuestPrompt.classList.remove('hidden');
    walletAuthenticatedContent.classList.add('hidden');
  }
}

function setSession(_token, user) {
  authToken = 'httponly_cookie_session';
  currentUser = user;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  syncAuthUi();
}

function clearSession() {
  authToken = '';
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  syncAuthUi();
  switchView('home');
}

// Public Config
async function initPublicConfig() {
  try {
    const data = await apiFetch('/api/public-config');
    publicConfig = { ...publicConfig, ...data };
    const rateEl = document.getElementById('heroCashbackRate');
    if (rateEl) rateEl.textContent = `${publicConfig.cashbackPercent}%`;
    const minLabel = document.getElementById('minWithdrawLabel');
    if (minLabel) minLabel.textContent = fmtVnd(publicConfig.minWithdrawAmount);
  } catch {}
}

// Auth Modal Logic
const authModal = document.getElementById('authModal');
function openAuthModal(tab = 'login') {
  authModal.classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-auth-tab') === tab);
  });
  document.getElementById('loginFormBox').classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerFormBox').classList.toggle('hidden', tab !== 'register');
  document.getElementById('authModalTitle').textContent =
    tab === 'login' ? 'Đăng nhập tài khoản' : 'Đăng ký tài khoản';

  const savedRef = sessionStorage.getItem('hoantienshop_ref');
  const regRefInput = document.getElementById('regRefCode');
  if (savedRef && regRefInput && !regRefInput.value) {
    regRefInput.value = savedRef;
  }
}

document.getElementById('openLoginBtn').addEventListener('click', () => openAuthModal('login'));
document.getElementById('openRegisterBtn').addEventListener('click', () => openAuthModal('register'));
document.getElementById('walletLoginBtn').addEventListener('click', () => openAuthModal('login'));
document.getElementById('walletRegisterBtn').addEventListener('click', () => openAuthModal('register'));
document.getElementById('closeAuthModalBtn').addEventListener('click', () => authModal.classList.add('hidden'));

document.querySelectorAll('.auth-tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => openAuthModal(tabBtn.getAttribute('data-auth-tab')));
});

document.getElementById('doLoginBtn').addEventListener('click', async () => {
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    });
    setSession(data.token, data.user);
    authModal.classList.add('hidden');
    showToast(`Xin chào ${data.user.name}!`);
    if (data.user.role === 'admin') {
      switchView('admin');
    }
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('doRegisterBtn').addEventListener('click', async () => {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  const refCode = document.getElementById('regRefCode')?.value?.trim() || '';
  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, phone, password, refCode })
    });
    setSession(data.token, data.user);
    authModal.classList.add('hidden');
    showToast('Đăng ký tài khoản thành công!');
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearSession();
  showToast('Đã đăng xuất tài khoản.');
});

// ================= HOME CONVERTER (CUSTOMER VIEW) =================
const productUrlInput = document.getElementById('productUrlInput');
const getCashbackLinkBtn = document.getElementById('getCashbackLinkBtn');
const clearInputBtn = document.getElementById('clearInputBtn');
const conversionResultSection = document.getElementById('conversionResultSection');
const resultCardsList = document.getElementById('resultCardsList');
const instantPreviewArea = document.getElementById('instantPreviewArea');
const instantPreviewCard = document.getElementById('instantPreviewCard');

let previewDebounceTimer = null;

productUrlInput.addEventListener('input', () => {
  const val = productUrlInput.value.trim();
  clearInputBtn.classList.toggle('hidden', !val);
  if (conversionResultSection) {
    conversionResultSection.classList.add('hidden');
  }
  if (val.startsWith('http://') || val.startsWith('https://')) {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => {
      fetchInstantPreview(val);
    }, 450);
  } else {
    if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
  }
});

productUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleGetCashbackLink();
  }
});

document.getElementById('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      productUrlInput.value = text;
      clearInputBtn.classList.remove('hidden');
      if (conversionResultSection) {
        conversionResultSection.classList.add('hidden');
      }
      fetchInstantPreview(text);
    }
  } catch {
    productUrlInput.focus();
    showToast('Hãy nhấn giữ hoặc Ctrl+V vào ô nhập để dán link.');
  }
});

clearInputBtn.addEventListener('click', () => {
  productUrlInput.value = '';
  clearInputBtn.classList.add('hidden');
  if (instantPreviewArea) instantPreviewArea.classList.add('hidden');
  conversionResultSection.classList.add('hidden');
  productUrlInput.focus();
});

async function fetchInstantPreview(rawText) {
  if (!instantPreviewArea || !instantPreviewCard || !rawText) return;
  const match = rawText.match(/https?:\/\/[^\s<>"')\]}]+/i);
  if (!match) return;

  const url = match[0];
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
      body: JSON.stringify({ url })
    });

    if (!res || !res.found) {
      instantPreviewArea.classList.add('hidden');
      return;
    }

    renderInstantPreviewCard(res);
  } catch (err) {
    // If preview fails, keep it hidden gracefully
    instantPreviewArea.classList.add('hidden');
  } finally {
    instantPreviewCard.classList.remove('loading');
  }
}

function renderInstantPreviewCard(data) {
  if (!instantPreviewCard) return;

  const isShopee = data.platform === 'shopee';
  const isTikTok = data.platform === 'tiktok';

  const platLabel = isShopee
    ? `<span class="plat-badge-inline shopee">
        <svg class="plat-svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19 7h-3V6a4 4 0 0 0-8 0v1H5a1 1 0 0 0-1 1v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V8a1 1 0 0 0-1-1zm-9-1a2 2 0 0 1 4 0v1h-4V6zm8 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9h2v1.5a1 1 0 0 0 2 0V9h4v1.5a1 1 0 0 0 2 0V9h2v10z"/>
          <path d="M13.5 13.5c-.3-.2-.7-.3-1.1-.4-.6-.2-.9-.3-.9-.6 0-.3.3-.5.7-.5.5 0 .9.2 1.2.4a.5.5 0 1 0 .6-.8c-.5-.3-1.1-.6-1.8-.6-1 0-1.7.6-1.7 1.5 0 .6.4 1.1 1.2 1.3.6.2.8.3.8.6 0 .3-.3.5-.8.5-.6 0-1.1-.3-1.4-.6a.5.5 0 1 0-.7.7c.5.5 1.2.8 2.1.8 1.1 0 1.8-.6 1.8-1.5 0-.7-.4-1.1-1.1-1.3z"/>
        </svg> Shopee
      </span>`
    : isTikTok
    ? `<span class="plat-badge-inline tiktok">
        <svg class="plat-svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.34 0 .67.06.98.17V8.89a6.45 6.45 0 0 0-.98-.07A6.33 6.33 0 0 0 3 15.16 6.33 6.33 0 0 0 9.34 21.5a6.33 6.33 0 0 0 6.33-6.34V8.47a8.28 8.28 0 0 0 4.81 1.53V6.69h-.89z"/>
        </svg> TikTok Shop
      </span>`
    : '🔗 Liên kết';

  const safeThumb = safeHttpsUrl(data.imageUrl);
  const thumbHtml = safeThumb
    ? `<img src="${safeThumb}" alt="Sản phẩm" referrerpolicy="no-referrer" />`
    : `<div style="font-size:28px;">🛍️</div>`;

  const isGenericTitle =
    !data.productName ||
    /^Sản phẩm (Shopee|TikTok Shop)\s*#/i.test(data.productName) ||
    data.productName === 'Sản phẩm Shopee';
  const displayTitle = isGenericTitle ? 'Đang cập nhật thông tin sản phẩm' : data.productName;

  const priceHtml = data.price > 0
    ? `<span class="ip-price">Giá: <strong>${fmtVnd(data.price)}</strong></span>`
    : '';

  const cashbackHtml = data.estimatedCashback > 0
    ? `<span class="ip-cashback">Hoàn tiền ước tính: ~${fmtVnd(data.estimatedCashback)}</span>`
    : `<span class="ip-cashback">Mức hoàn tùy đơn hàng (tự động cộng ví khi có đơn)</span>`;

  const authNotice = !authToken
    ? `<div class="ip-guest-hint">Đăng nhập để đơn được ghi nhận tự động vào ví của bạn.</div>`
    : `<div class="ip-guest-hint"><strong>Sẵn sàng nhận hoàn tiền:</strong> Bấm nút để lấy link mua hàng!</div>`;

  instantPreviewCard.innerHTML = `
    <div class="ip-top-row">
      <div class="ip-badge-group">
        <span class="ip-badge-cashback">🟢 Có tiền hoàn</span>
        ${platLabel}
      </div>
    </div>

    <div class="ip-product-row">
      <div class="ip-thumb">${thumbHtml}</div>
      <div class="ip-details">
        <div class="ip-title">${escapeHtml(displayTitle)}</div>
        <div class="ip-numbers">
          ${priceHtml}
          ${cashbackHtml}
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

  const convertBtn = document.getElementById('btnTriggerConvertFromPreview');
  if (convertBtn) {
    convertBtn.addEventListener('click', () => {
      handleGetCashbackLink();
    });
  }
}

async function handleGetCashbackLink() {
  const text = productUrlInput.value.trim();
  if (!text) {
    showToast('Vui lòng dán link sản phẩm Shopee hoặc TikTok Shop!');
    productUrlInput.focus();
    return;
  }

  getCashbackLinkBtn.disabled = true;
  getCashbackLinkBtn.textContent = 'Đang tạo link...';

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
    conversionResultSection.classList.remove('hidden');

    const guestNoticeHtml = !authToken
      ? `<div class="guest-card-note">
           Bạn chưa đăng nhập. Bạn có thể nhấn mua hàng nhưng sẽ không được cộng tiền hoàn vào ví.
           <button type="button" class="inline-link" data-open-auth="login">Đăng nhập ngay</button>
         </div>`
      : '';

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
        const safeAffUrl = safeHttpsUrl(item.affiliateUrl);

        const thumbHtml = safeThumbUrl
          ? `<img src="${safeThumbUrl}" alt="Sản phẩm" class="product-thumb" referrerpolicy="no-referrer" />`
          : `<div class="product-thumb" style="display:flex;align-items:center;justify-content:center;font-size:26px;">🛍️</div>`;

        const priceInfoHtml =
          item.price > 0
            ? `<span class="prod-price-tag">Giá: <strong>${fmtVnd(item.price)}</strong></span>`
            : '';

        const isGenericItemTitle =
          !item.productName ||
          /^Sản phẩm (Shopee|TikTok Shop)\s*#/i.test(item.productName) ||
          item.productName === 'Sản phẩm Shopee';
        const displayItemTitle = isGenericItemTitle
          ? 'Đang cập nhật thông tin sản phẩm'
          : item.productName;

        const cbPct = Number(item.cashbackPercent || 70);
        const estCashbackHtml =
          item.estimatedCashback > 0
            ? `<div class="est-cashback-badge">
                <span>Hoàn tiền ước tính:</span>
                <strong>~${fmtVnd(item.estimatedCashback)}</strong>
               </div>`
            : `<div class="est-cashback-badge normal">
                <span>Mức hoàn tùy đơn hàng (${cbPct}% hoa hồng sàn)</span>
               </div>`;

        return `
        <div class="cashback-product-card">
          <div class="cp-top">
            <span class="valid-badge">✨ Đã tạo link hoàn tiền</span>
            <span style="font-size:13px;font-weight:700;color:#475569;">${platLabel}</span>
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

          <!-- Nổi bật phần quan trọng: Nút Mua Hàng to rõ -->
          <div class="cp-cta-block">
            <a href="${safeAffUrl}" target="_blank" rel="noopener" class="btn btn-cta btn-open-aff">
              🛒 ${openAppBtnText} (Mua ngay)
            </a>
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
                onclick="this.select()"
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
  } catch (err) {
    showToast(err.message);
  } finally {
    getCashbackLinkBtn.disabled = false;
    getCashbackLinkBtn.textContent = 'Lấy Link Hoàn Tiền';
  }
}

getCashbackLinkBtn.addEventListener('click', handleGetCashbackLink);

// ================= USER WALLET & ORDERS =================
const wdBankAccountInput = document.getElementById('wdBankAccount');
const wdPasswordConfirmGroup = document.getElementById('wdPasswordConfirmGroup');

if (wdBankAccountInput) {
  wdBankAccountInput.addEventListener('input', () => {
    const savedAcc = currentUser?.bankAccount || '';
    const newAcc = wdBankAccountInput.value.trim();
    if (savedAcc && newAcc && newAcc !== savedAcc) {
      wdPasswordConfirmGroup.classList.remove('hidden');
    } else {
      wdPasswordConfirmGroup.classList.add('hidden');
    }
  });
}

async function loadUserDashboard() {
  if (!authToken) return;
  try {
    const data = await apiFetch('/api/user/me');
    currentUser = data.user;
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    syncAuthUi();

    document.getElementById('walletUserName').textContent = currentUser.name;
    document.getElementById('statAvailable').textContent = fmtVnd(currentUser.balanceAvailable);
    document.getElementById('statPending').textContent = fmtVnd(currentUser.balancePending);
    document.getElementById('statTotalEarned').textContent = fmtVnd(currentUser.totalEarned);
    document.getElementById('statWithdrawn').textContent = fmtVnd(currentUser.totalWithdrawn);

    // Referral Info (safely check if element exists)
    const refCountEl = document.getElementById('userRefCount');
    if (refCountEl) refCountEl.textContent = data.referralCount || 0;
    const refInputEl = document.getElementById('userReferralLinkInput');
    if (refInputEl) {
      refInputEl.value = `${window.location.origin}/?ref=${encodeURIComponent(currentUser.code)}`;
    }

    if (currentUser.bankName) document.getElementById('wdBankName').value = currentUser.bankName;
    if (currentUser.bankAccount) {
      document.getElementById('wdBankAccount').value = currentUser.bankAccount;
    }
    if (currentUser.bankOwner) document.getElementById('wdBankOwner').value = currentUser.bankOwner;
    wdPasswordConfirmGroup.classList.add('hidden');

    // Orders
    const ordBody = document.getElementById('userOrdersTableBody');
    const orders = data.orders || [];
    if (orders.length === 0) {
      ordBody.innerHTML =
        '<tr><td colspan="4" class="text-center">Chưa có đơn hàng nào được ghi nhận.</td></tr>';
    } else {
      ordBody.innerHTML = orders
        .map((o) => {
          const stBadge =
            o.status === 'approved'
              ? '<span class="status-badge st-approved">Đã cộng vào ví</span>'
              : o.status === 'cancelled'
              ? '<span class="status-badge st-cancelled">Đã huỷ</span>'
              : '<span class="status-badge st-pending">Đang đối soát</span>';
          return `
            <tr>
              <td><strong>${escapeHtml(o.orderSn)}</strong></td>
              <td>${escapeHtml(o.productName)}</td>
              <td><strong style="color:#059669;">+${fmtVnd(o.userCashbackAmount)}</strong></td>
              <td>${stBadge}</td>
            </tr>
          `;
        })
        .join('');
    }

    // Ledger
    const ledBody = document.getElementById('userLedgerTableBody');
    const ledger = data.ledger || [];
    if (ledger.length === 0) {
      ledBody.innerHTML =
        '<tr><td colspan="3" class="text-center">Chưa có biến động số dư.</td></tr>';
    } else {
      ledBody.innerHTML = ledger
        .map((l) => {
          const isPos = Number(l.amount) >= 0;
          const color = isPos ? '#059669' : '#dc2626';
          const prefix = isPos ? '+' : '';
          return `
            <tr>
              <td>${new Date(l.createdAt).toLocaleDateString('vi-VN')}</td>
              <td>${escapeHtml(l.note)}</td>
              <td><strong style="color:${color};">${prefix}${fmtVnd(l.amount)}</strong></td>
            </tr>
          `;
        })
        .join('');
    }

    // Withdrawals
    const wdBody = document.getElementById('userWithdrawalsTableBody');
    const wds = data.withdrawals || [];
    if (wds.length === 0) {
      wdBody.innerHTML =
        '<tr><td colspan="4" class="text-center">Chưa có lịch sử rút tiền.</td></tr>';
    } else {
      wdBody.innerHTML = wds
        .map((w) => {
          const stBadge =
            w.status === 'paid'
              ? '<span class="status-badge st-paid">Đã chuyển khoản</span>'
              : w.status === 'rejected'
              ? '<span class="status-badge st-rejected">Từ chối</span>'
              : '<span class="status-badge st-pending">Chờ thanh toán</span>';
          return `
            <tr>
              <td>${new Date(w.createdAt).toLocaleDateString('vi-VN')}</td>
              <td><strong>${fmtVnd(w.amount)}</strong></td>
              <td>${escapeHtml(w.bankName)} - ${escapeHtml(w.bankAccount)}</td>
              <td>${stBadge}</td>
            </tr>
          `;
        })
        .join('');
    }
  } catch (err) {
    showToast(err.message);
  }
}

const copyRefLinkBtn = document.getElementById('copyRefLinkBtn');
if (copyRefLinkBtn) {
  copyRefLinkBtn.addEventListener('click', () => {
    const val = document.getElementById('userReferralLinkInput')?.value;
    if (val) copyText(val, 'Đã sao chép liên kết giới thiệu bạn bè!');
  });
}

document.getElementById('refreshWalletBtn').addEventListener('click', loadUserDashboard);

document.getElementById('submitOrderClaimBtn').addEventListener('click', async () => {
  const platform = document.getElementById('claimPlatform').value;
  const orderSn = document.getElementById('claimOrderSn').value.trim();
  const productName = document.getElementById('claimProductName').value.trim();
  try {
    const res = await apiFetch('/api/user/submit-order', {
      method: 'POST',
      body: JSON.stringify({ platform, orderSn, productName })
    });
    document.getElementById('claimOrderSn').value = '';
    document.getElementById('claimProductName').value = '';
    showToast(res.message || 'Đã lưu mã đơn hàng thành công!');
    loadUserDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('submitWithdrawBtn').addEventListener('click', async () => {
  const method = document.getElementById('wdMethod').value;
  const bankName = document.getElementById('wdBankName').value.trim();
  const bankAccount = document.getElementById('wdBankAccount').value.trim();
  const bankOwner = document.getElementById('wdBankOwner').value.trim();
  const amount = Number(document.getElementById('wdAmount').value);
  const currentPassword = document.getElementById('wdCurrentPassword').value;

  try {
    await apiFetch('/api/user/withdraw', {
      method: 'POST',
      body: JSON.stringify({
        method,
        bankName,
        bankAccount,
        bankOwner,
        amount,
        currentPassword
      })
    });
    document.getElementById('wdAmount').value = '';
    document.getElementById('wdCurrentPassword').value = '';
    showToast('Đã gửi yêu cầu rút tiền thành công!');
    loadUserDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// ================= ADMIN DASHBOARD =================
let latestAdminUsers = [];
let latestAdminOrders = [];
let currentAdminSettings = null;
const admOrdCommission = document.getElementById('admOrdCommission');
const admOrdPreview70 = document.getElementById('admOrdPreview70');

function updateAdminSplitPreview() {
  const gross = Number(admOrdCommission.value || 0);
  const taxRate = Number(document.getElementById('admTaxDeductPercent').value ?? 10);
  const cbRate = Number(document.getElementById('admCashbackPercent').value || 70);
  const net = Math.round(gross * (1 - taxRate / 100));
  const userGet = Math.round((net * cbRate) / 100);
  const adminGet = net - userGet;
  admOrdPreview70.value = `Khách: ${fmtVnd(userGet)} | Bạn: ${fmtVnd(adminGet)}`;
}

if (admOrdCommission) {
  admOrdCommission.addEventListener('input', updateAdminSplitPreview);
}

async function loadAdminDashboard() {
  try {
    const data = await apiFetch('/api/admin/dashboard');
    const st = data.stats;
    const s = data.settings;
    currentAdminSettings = s;
    latestAdminOrders = data.orders || [];
    const dbStatus = data.dbStatus || {};

    const dbTextEl = document.getElementById('admDbStatusText');
    if (dbStatus.mode === 'postgres') {
      dbTextEl.textContent = '🟢 Đã kết nối Cloud PostgreSQL (Dữ liệu bền vững + Sổ cái Ledger)';
      dbTextEl.style.color = '#059669';
    } else if (dbStatus.mode === 'ephemeral_tmp') {
      dbTextEl.textContent =
        '🟠 Đang chạy bộ nhớ tạm (/tmp) trên Vercel — Hãy gắn biến DATABASE_URL (Neon/Supabase) trong Vercel Settings để lưu vĩnh viễn.';
      dbTextEl.style.color = '#d97706';
    } else {
      dbTextEl.textContent = '🟢 Chế độ Local JSON (Lưu trên ổ cứng máy tính)';
    }

    document.getElementById('admTotalComm').textContent = fmtVnd(st.totalCommission);
    document.getElementById('admUserShare').textContent = fmtVnd(st.totalUserCashback);
    document.getElementById('admProfit').textContent = fmtVnd(st.totalAdminProfit);
    document.getElementById('admUsersOrders').textContent = `${st.totalUsers} / ${st.totalOrders}`;

    document.getElementById('admShopeeMode').value = s.shopeeMode || 'an_redir';
    document.getElementById('admShopeeAffiliateId').value = s.shopeeAffiliateId || '';
    document.getElementById('admShopeeAppId').value = s.shopeeAppId || '';
    document.getElementById('admShopeeAppSecret').value = s.shopeeAppSecret || '';
    const addliveEl = document.getElementById('admAddlivetagApiKey');
    if (addliveEl) addliveEl.value = s.addlivetagApiKey || '';
    document.getElementById('admTiktokMode').value = s.tiktokMode || 'deeplink';
    document.getElementById('admTiktokDeepLink').value = s.tiktokDeepLinkTemplate || '';
    const atKeyEl = document.getElementById('admAccesstradeApiKey');
    if (atKeyEl) atKeyEl.value = s.accesstradeApiKey || '';
    const pbUrlEl = document.getElementById('admPostbackUrl');
    if (pbUrlEl) pbUrlEl.value = s.postbackUrlTemplate || '';
    document.getElementById('admTaxDeductPercent').value = s.taxDeductPercent ?? 10;
    document.getElementById('admCashbackPercent').value = s.cashbackPercent || 70;
    document.getElementById('admMinWithdraw').value = s.minWithdrawAmount || 50000;
    document.getElementById('admShortener').value = s.shortenerProvider || 'none';
    document.getElementById('admSupportZalo').value = s.supportZalo || '';

    const ordTbody = document.getElementById('admOrdersTableBody');
    if (latestAdminOrders.length === 0) {
      ordTbody.innerHTML = '<tr><td colspan="7" class="text-center">Chưa có đơn hàng nào.</td></tr>';
    } else {
      ordTbody.innerHTML = latestAdminOrders
        .map((o) => {
          const actionButtons =
            o.status === 'pending'
              ? `<button type="button" class="btn btn-success btn-xs" data-ord-action="approve" data-ord-sn="${escapeHtml(o.orderSn)}" title="Duyệt đơn và cộng tiền hoàn vào ví khách">Duyệt</button>
                 <button type="button" class="btn btn-warning btn-xs" data-ord-action="cancel" data-ord-sn="${escapeHtml(o.orderSn)}" title="Hủy đơn này">Hủy</button>
                 <button type="button" class="btn btn-outline btn-xs" data-ord-action="edit" data-ord-sn="${escapeHtml(o.orderSn)}" title="Chỉnh sửa chi tiết & số tiền hoàn">Sửa</button>
                 <button type="button" class="btn btn-ghost btn-xs text-danger" data-ord-action="delete" data-ord-sn="${escapeHtml(o.orderSn)}" title="Xóa vĩnh viễn đơn này">Xóa</button>`
              : o.status === 'approved'
              ? `<button type="button" class="btn btn-secondary btn-xs" data-ord-action="unapprove" data-ord-sn="${escapeHtml(o.orderSn)}" title="Hủy duyệt và thu hồi tiền hoàn về chờ duyệt">↩️ Hủy duyệt</button>
                 <button type="button" class="btn btn-warning btn-xs" data-ord-action="cancel" data-ord-sn="${escapeHtml(o.orderSn)}" title="Hủy đơn và thu hồi tiền hoàn">Hủy đơn</button>
                 <button type="button" class="btn btn-outline btn-xs" data-ord-action="edit" data-ord-sn="${escapeHtml(o.orderSn)}" title="Chỉnh sửa chi tiết & số tiền hoàn">Sửa</button>
                 <button type="button" class="btn btn-ghost btn-xs text-danger" data-ord-action="delete" data-ord-sn="${escapeHtml(o.orderSn)}" title="Xóa vĩnh viễn đơn này">Xóa</button>`
              : `<button type="button" class="btn btn-primary btn-xs" data-ord-action="reopen" data-ord-sn="${escapeHtml(o.orderSn)}" title="Khôi phục về trạng thái chờ duyệt">🔄 Khôi phục</button>
                 <button type="button" class="btn btn-outline btn-xs" data-ord-action="edit" data-ord-sn="${escapeHtml(o.orderSn)}" title="Chỉnh sửa chi tiết & số tiền hoàn">Sửa</button>
                 <button type="button" class="btn btn-ghost btn-xs text-danger" data-ord-action="delete" data-ord-sn="${escapeHtml(o.orderSn)}" title="Xóa vĩnh viễn đơn này">Xóa</button>`;

          return `
        <tr>
          <td>
            <strong>${escapeHtml(o.orderSn)}</strong><br/>
            <small style="color:#64748b;">${escapeHtml(o.platform === 'tiktok' ? 'TikTok' : 'Shopee')}</small>
          </td>
          <td>${escapeHtml(o.userCode || 'GUEST')}</td>
          <td>${fmtVnd(o.orderAmount || 0)}</td>
          <td>${fmtVnd(o.netCommission || o.totalCommission || 0)}</td>
          <td><strong style="color:#059669;">${fmtVnd(o.userCashbackAmount || 0)}</strong></td>
          <td>
            <span class="status-badge st-${o.status}">${
              o.status === 'approved'
                ? 'Đã duyệt'
                : o.status === 'cancelled'
                ? 'Đã huỷ'
                : 'Chờ duyệt'
            }</span>
          </td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
              ${actionButtons}
            </div>
          </td>
        </tr>
      `;
        })
        .join('');
    }

    const wdTbody = document.getElementById('admWithdrawalsTableBody');
    const wds = data.withdrawals || [];
    if (wds.length === 0) {
      wdTbody.innerHTML =
        '<tr><td colspan="5" class="text-center">Chưa có lệnh rút tiền nào.</td></tr>';
    } else {
      wdTbody.innerHTML = wds
        .map((w) => {
          const qrBtnHtml = w.vietQrUrl
            ? `<button type="button" class="btn btn-outline btn-sm" data-vietqr="${escapeHtml(
                w.vietQrUrl
              )}" data-vietqr-info="${escapeHtml(w.bankName)} - ${escapeHtml(
                w.bankAccount
              )} (${escapeHtml(w.bankOwner)}): ${fmtVnd(w.amount)}">📱 Quét QR</button>`
            : '<span style="font-size:12px;color:#64748b;">Chuyển tay</span>';

          return `
        <tr>
          <td><strong>${escapeHtml(w.userName)}</strong> (${escapeHtml(w.userPhone)})</td>
          <td><strong style="color:#dc2626;">${fmtVnd(w.amount)}</strong></td>
          <td>${escapeHtml(w.bankName)} - <strong>${escapeHtml(
            w.bankAccount
          )}</strong> (${escapeHtml(w.bankOwner)})</td>
          <td>${qrBtnHtml}</td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
              ${
                w.status === 'pending'
                  ? `<button type="button" class="btn btn-success btn-xs" data-wd-action="paid" data-wd-id="${w.id}">Đã chuyển</button>
                     <button type="button" class="btn btn-ghost btn-xs" data-wd-action="rejected" data-wd-id="${w.id}">Từ chối</button>`
                  : `<span class="status-badge st-${w.status}">${w.status === 'paid' ? 'Đã chi trả' : 'Đã từ chối'}</span>`
              }
              <button type="button" class="btn btn-ghost btn-xs text-danger" data-wd-delete="${w.id}" title="Xóa lệnh rút tiền này">🗑️ Xóa</button>
            </div>
          </td>
        </tr>
      `;
        })
        .join('');
    }

    const usrTbody = document.getElementById('admUsersTableBody');
    latestAdminUsers = data.users || [];
    usrTbody.innerHTML = latestAdminUsers
      .map((u) => {
        const isLocked = Boolean(u.accountLocked);
        const statusHtml = isLocked
          ? '<span class="status-badge st-cancelled">🔒 Đã khóa</span>'
          : '<span class="status-badge st-approved">🟢 Hoạt động</span>';
        const isSuperAdmin = u.role === 'admin';

        return `
      <tr>
        <td><strong>${escapeHtml(u.code)}</strong></td>
        <td>${escapeHtml(u.name)} (${escapeHtml(u.phone)})</td>
        <td><strong style="color:#059669;">${fmtVnd(u.balanceAvailable)}</strong></td>
        <td>${fmtVnd(u.balancePending)}</td>
        <td>${statusHtml}</td>
        <td>
          ${
            isSuperAdmin
              ? '<span style="font-size:12px;color:#64748b;font-weight:600;">👑 Admin tối cao</span>'
              : `<button type="button" class="btn btn-outline btn-sm" data-manage-user="${escapeHtml(
                  u.id
                )}">⚙️ Quản lý</button>`
          }
        </td>
      </tr>
    `;
      })
      .join('');
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('refreshAdminBtn').addEventListener('click', loadAdminDashboard);

document.getElementById('syncShopeeNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncShopeeNowBtn');
  btn.disabled = true;
  btn.textContent = 'Đang đồng bộ...';
  try {
    const res = await apiFetch('/api/admin/sync-shopee', { method: 'POST', body: '{}' });
    const warn = res.errors && res.errors.length ? ` (${res.errors.join(' | ')})` : '';
    showToast(`Đã đồng bộ tự động ${res.syncedCount || 0} đơn hàng!${warn}`);
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Đồng bộ đơn tự động (Shopee + AccessTrade)';
  }
});

const copyPostbackUrlBtn = document.getElementById('copyPostbackUrlBtn');
if (copyPostbackUrlBtn) {
  copyPostbackUrlBtn.addEventListener('click', async () => {
    const val = document.getElementById('admPostbackUrl')?.value || '';
    if (!val) return;
    await navigator.clipboard.writeText(val);
    showToast('Đã sao chép Link Postback AccessTrade!');
  });
}

document.getElementById('saveAdminSettingsBtn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({
        shopeeMode: document.getElementById('admShopeeMode').value,
        shopeeAffiliateId: document.getElementById('admShopeeAffiliateId').value.trim(),
        shopeeAppId: document.getElementById('admShopeeAppId').value.trim(),
        shopeeAppSecret: document.getElementById('admShopeeAppSecret').value.trim(),
        addlivetagApiKey: document.getElementById('admAddlivetagApiKey')?.value?.trim() || '',
        tiktokMode: document.getElementById('admTiktokMode').value,
        tiktokDeepLinkTemplate: document.getElementById('admTiktokDeepLink').value.trim(),
        accesstradeApiKey: document.getElementById('admAccesstradeApiKey')?.value.trim() || '',
        taxDeductPercent: Number(document.getElementById('admTaxDeductPercent').value ?? 10),
        cashbackPercent: Number(document.getElementById('admCashbackPercent').value || 70),
        minWithdrawAmount: Number(document.getElementById('admMinWithdraw').value || 50000),
        shortenerProvider: document.getElementById('admShortener').value,
        supportZalo: document.getElementById('admSupportZalo').value.trim(),
        newAdminPassword: document.getElementById('admNewPass').value.trim()
      })
    });
    document.getElementById('admNewPass').value = '';
    showToast('Đã lưu cấu hình hệ thống thành công!');
    initPublicConfig();
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('admSaveOrderBtn').addEventListener('click', async () => {
  const orderSn = document.getElementById('admOrdSn').value.trim();
  const userCode = document.getElementById('admOrdUserCode').value.trim();
  const productName = document.getElementById('admOrdProduct').value.trim();
  const orderAmount = Number(document.getElementById('admOrdAmount').value || 0);
  const totalCommission = Number(document.getElementById('admOrdCommission').value || 0);
  const status = document.getElementById('admOrdStatus').value;

  try {
    await apiFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        orderSn,
        userCode,
        productName,
        orderAmount,
        totalCommission,
        status
      })
    });
    document.getElementById('admOrdSn').value = '';
    document.getElementById('admOrdCommission').value = '';
    showToast('Đã lưu đơn hàng & ghi nhận vào sổ cái!');
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('view-admin').addEventListener('click', async (e) => {
  const ordActionBtn = e.target.closest('[data-ord-action]');
  if (ordActionBtn) {
    const action = ordActionBtn.getAttribute('data-ord-action');
    const orderSn = ordActionBtn.getAttribute('data-ord-sn');
    const order = latestAdminOrders.find((o) => o.orderSn === orderSn);

    if (action === 'approve') {
      try {
        await apiFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ orderSn, status: 'approved' })
        });
        showToast(`Đã duyệt đơn #${orderSn} và cộng tiền hoàn vào ví khách!`);
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'unapprove') {
      try {
        await apiFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ orderSn, status: 'pending' })
        });
        showToast(`Đã hủy duyệt đơn #${orderSn}, tiền hoàn đã chuyển về Chờ duyệt!`);
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'cancel') {
      try {
        await apiFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ orderSn, status: 'cancelled' })
        });
        showToast(`Đã chuyển đơn #${orderSn} sang trạng thái Đã huỷ!`);
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (action === 'reopen') {
      try {
        await apiFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ orderSn, status: 'pending' })
        });
        showToast(`Đã khôi phục đơn #${orderSn} về Chờ duyệt!`);
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
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
      if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn đơn hàng #${orderSn} không?\nTiền hoàn của đơn sẽ bị xóa khỏi ví người dùng.`)) {
        return;
      }
      try {
        await apiFetch('/api/admin/orders/delete', {
          method: 'POST',
          body: JSON.stringify({ orderSn })
        });
        showToast(`Đã xóa vĩnh viễn đơn #${orderSn}!`);
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
  }

  const wdBtn = e.target.closest('[data-wd-action]');
  if (wdBtn) {
    const id = wdBtn.getAttribute('data-wd-id');
    const status = wdBtn.getAttribute('data-wd-action');
    try {
      await apiFetch('/api/admin/withdrawals/update', {
        method: 'POST',
        body: JSON.stringify({ id, status })
      });
      showToast('Đã cập nhật trạng thái rút tiền!');
      loadAdminDashboard();
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  const wdDeleteBtn = e.target.closest('[data-wd-delete]');
  if (wdDeleteBtn) {
    const id = wdDeleteBtn.getAttribute('data-wd-delete');
    if (!confirm(`Bạn có chắc chắn muốn xóa yêu cầu rút tiền #${id} không?`)) {
      return;
    }
    try {
      await apiFetch('/api/admin/withdrawals/delete', {
        method: 'POST',
        body: JSON.stringify({ id })
      });
      showToast('Đã xóa yêu cầu rút tiền!');
      loadAdminDashboard();
    } catch (err) {
      showToast(err.message);
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

// Admin User Management Modal Functions
const userManageModal = document.getElementById('userManageModal');
let currentManagingUser = null;

function openUserManageModal(user) {
  currentManagingUser = user;
  document.getElementById('manageUserId').value = user.id;
  document.getElementById('manageUserCode').textContent = user.code;
  document.getElementById('manageUserName').textContent = user.name || 'Chưa cập nhật';
  document.getElementById('manageUserPhone').textContent = user.phone;
  document.getElementById('manageUserBalance').textContent = fmtVnd(user.balanceAvailable);
  document.getElementById('manageUserStatus').innerHTML = user.accountLocked
    ? '<span style="color:#dc2626;">🔒 Đang bị khóa (Chặn đăng nhập & rút tiền)</span>'
    : '<span style="color:#059669;">🟢 Đang hoạt động bình thường</span>';

  document.getElementById('manageNewPassword').value = '';
  document.getElementById('manageAdjustAmount').value = '';
  document.getElementById('manageAdjustNote').value = '';

  const lockBtn = document.getElementById('btnToggleUserLock');
  lockBtn.textContent = user.accountLocked ? '🔓 Mở Khóa Tài Khoản' : '🔒 Khóa Tài Khoản Này';
  lockBtn.className = user.accountLocked ? 'btn btn-success btn-sm' : 'btn btn-outline btn-sm';

  userManageModal.classList.remove('hidden');
}

document.getElementById('closeUserManageModalBtn').addEventListener('click', () => {
  userManageModal.classList.add('hidden');
});

document.getElementById('btnResetUserPassword').addEventListener('click', async () => {
  if (!currentManagingUser) return;
  const newPassword = document.getElementById('manageNewPassword').value.trim();
  if (newPassword.length < 6) {
    showToast('Mật khẩu mới phải có ít nhất 6 ký tự.');
    return;
  }
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'reset_password', newPassword })
    });
    showToast(res.message);
    document.getElementById('manageNewPassword').value = '';
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('btnAdjustUserBalance').addEventListener('click', async () => {
  if (!currentManagingUser) return;
  const type = document.getElementById('manageAdjustType').value;
  const rawAmt = Number(document.getElementById('manageAdjustAmount').value || 0);
  const note = document.getElementById('manageAdjustNote').value.trim();
  if (!rawAmt || rawAmt <= 0) {
    showToast('Vui lòng nhập số tiền lớn hơn 0.');
    return;
  }
  const amount = type === 'minus' ? -rawAmt : rawAmt;
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'adjust_balance', amount, note })
    });
    showToast(res.message);
    userManageModal.classList.add('hidden');
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

const btnResetZero = document.getElementById('btnResetUserBalanceZero');
if (btnResetZero) {
  btnResetZero.addEventListener('click', async () => {
    if (!currentManagingUser) return;
    if (
      !confirm(
        `Bạn có chắc chắn muốn xóa toàn bộ số dư khả dụng của khách hàng ${currentManagingUser.code} về 0đ không?`
      )
    ) {
      return;
    }
    try {
      const res = await apiFetch('/api/admin/users/action', {
        method: 'POST',
        body: JSON.stringify({ userId: currentManagingUser.id, action: 'reset_balance' })
      });
      showToast(res.message);
      userManageModal.classList.add('hidden');
      loadAdminDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });
}

document.getElementById('btnToggleUserLock').addEventListener('click', async () => {
  if (!currentManagingUser) return;
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'toggle_lock' })
    });
    showToast(res.message);
    userManageModal.classList.add('hidden');
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('btnDeleteUser').addEventListener('click', async () => {
  if (!currentManagingUser) return;
  if (!confirm(`Bạn có chắc chắn muốn xóa tài khoản ${currentManagingUser.code} (${currentManagingUser.phone}) không?`)) {
    return;
  }
  try {
    const res = await apiFetch('/api/admin/users/action', {
      method: 'POST',
      body: JSON.stringify({ userId: currentManagingUser.id, action: 'delete' })
    });
    showToast(res.message);
    userManageModal.classList.add('hidden');
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// ================= ORDER EDIT MODAL =================
const orderEditModal = document.getElementById('orderEditModal');
let currentEditingOrder = null;

function openOrderEditModal(order) {
  currentEditingOrder = order;
  document.getElementById('editOrdId').value = order.id || '';
  document.getElementById('editOrdSn').value = order.orderSn || '';
  document.getElementById('editOrdUserCode').value = order.userCode || '';
  document.getElementById('editOrdPlatform').value = order.platform || 'shopee';
  document.getElementById('editOrdProduct').value = order.productName || '';
  document.getElementById('editOrdAmount').value = order.orderAmount || 0;
  document.getElementById('editOrdCommission').value =
    order.grossCommission || order.totalCommission || 0;
  document.getElementById('editOrdCashbackAmount').value = order.userCashbackAmount || 0;
  document.getElementById('editOrdStatus').value = order.status || 'pending';

  orderEditModal.classList.remove('hidden');
}

const closeOrderEditBtn = document.getElementById('closeOrderEditModalBtn');
if (closeOrderEditBtn) {
  closeOrderEditBtn.addEventListener('click', () => {
    orderEditModal.classList.add('hidden');
  });
}

const cancelOrderEditBtn = document.getElementById('cancelOrderEditBtn');
if (cancelOrderEditBtn) {
  cancelOrderEditBtn.addEventListener('click', () => {
    orderEditModal.classList.add('hidden');
  });
}

const btnAutoCalcCashback = document.getElementById('btnAutoCalcCashback');
if (btnAutoCalcCashback) {
  btnAutoCalcCashback.addEventListener('click', () => {
    const gross = Number(document.getElementById('editOrdCommission').value || 0);
    const taxRate = Number(currentAdminSettings?.taxDeductPercent ?? 10);
    const cbRate = Number(currentAdminSettings?.cashbackPercent ?? 70);
    const net = Math.round(gross * (1 - taxRate / 100));
    const cb = Math.round((net * cbRate) / 100);
    document.getElementById('editOrdCashbackAmount').value = cb;
    showToast(`Đã tính tiền hoàn: ${cb.toLocaleString('vi-VN')}đ (70% sau thuế)`);
  });
}

const saveOrderEditBtn = document.getElementById('saveOrderEditBtn');
if (saveOrderEditBtn) {
  saveOrderEditBtn.addEventListener('click', async () => {
    const id = document.getElementById('editOrdId').value;
    const orderSn = document.getElementById('editOrdSn').value.trim();
    const userCode = document.getElementById('editOrdUserCode').value.trim();
    const platform = document.getElementById('editOrdPlatform').value;
    const productName = document.getElementById('editOrdProduct').value.trim();
    const orderAmount = Number(document.getElementById('editOrdAmount').value || 0);
    const totalCommission = Number(document.getElementById('editOrdCommission').value || 0);
    const userCashbackAmount = Number(document.getElementById('editOrdCashbackAmount').value || 0);
    const status = document.getElementById('editOrdStatus').value;

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
      orderEditModal.classList.add('hidden');
      showToast(`Đã lưu thay đổi cho đơn #${orderSn}!`);
      loadAdminDashboard();
    } catch (err) {
      showToast(err.message);
    }
  });
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

document.getElementById('admCsvInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      showToast('File CSV trống hoặc không đúng định dạng.');
      return;
    }

    const headers = splitCsvLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i]);
      if (cols.length < 2) continue;

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
        cols[0];

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

      const totalCommission = Number(String(commRaw).replace(/[^\d.]/g, '')) || 0;
      const orderAmount = Number(String(amountRaw).replace(/[^\d.]/g, '')) || 0;
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

      if (orderSn) {
        rows.push({
          orderSn,
          userCode: subId1 || 'GUEST',
          totalCommission,
          orderAmount,
          platform,
          status
        });
      }
    }

    const res = await apiFetch('/api/admin/import-orders', {
      method: 'POST',
      body: JSON.stringify({ rows })
    });
    showToast(`Đã nhập & đối soát tự động ${res.importedCount} đơn hàng!`);
    loadAdminDashboard();
  } catch (err) {
    showToast(`Lỗi đọc file CSV: ${err.message}`);
  } finally {
    e.target.value = '';
  }
});

// Boot
initPublicConfig();
syncAuthUi();
if (authToken) {
  loadUserDashboard();
}

// ==================== PWA INSTALL & HOME SCREEN CONTROLLER ====================
let deferredInstallPrompt = null;
const pwaInstallBanner = document.getElementById('pwaInstallBanner');
const pwaBannerDesc = document.getElementById('pwaBannerDesc');
const pwaInstallBtn = document.getElementById('pwaInstallBtn');
const pwaDismissBtn = document.getElementById('pwaDismissBtn');
const pwaGuideModal = document.getElementById('pwaGuideModal');
const pwaGuideContent = document.getElementById('pwaGuideContent');
const closePwaGuideBtn = document.getElementById('closePwaGuideBtn');
const ackPwaGuideBtn = document.getElementById('ackPwaGuideBtn');

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
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !window.MSStream;
}

function showPwaBanner() {
  if (isPwaStandalone()) return;
  const dismissedTime = localStorage.getItem('hts_pwa_dismissed');
  if (dismissedTime && Date.now() - Number(dismissedTime) < 2 * 86400 * 1000) {
    return;
  }
  if (!pwaInstallBanner) return;

  if (isIosDevice()) {
    pwaBannerDesc.textContent = 'Thêm Hoàn Tiền Sàn ra màn hình chính iPhone để mở nhanh như App.';
  } else {
    pwaBannerDesc.textContent = 'Thêm Hoàn Tiền Sàn ra màn hình chính để truy cập nhanh.';
  }

  pwaInstallBanner.classList.remove('hidden');
}

function hidePwaBanner() {
  if (pwaInstallBanner) {
    pwaInstallBanner.classList.add('hidden');
  }
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
  if (pwaGuideModal) {
    pwaGuideModal.classList.add('hidden');
  }
}

// Listen for browser install prompt (Chrome / Edge / Samsung Internet / Android)
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showPwaBanner();
});

// User installs app
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

// User dismisses banner
if (pwaDismissBtn) {
  pwaDismissBtn.addEventListener('click', () => {
    localStorage.setItem('hts_pwa_dismissed', String(Date.now()));
    hidePwaBanner();
  });
}

if (closePwaGuideBtn) closePwaGuideBtn.addEventListener('click', closePwaGuideModal);
if (ackPwaGuideBtn) ackPwaGuideBtn.addEventListener('click', closePwaGuideModal);

// Auto-trigger banner after initial page load (if not installed & not dismissed)
setTimeout(() => {
  showPwaBanner();
}, 1500);
