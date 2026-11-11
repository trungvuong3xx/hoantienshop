const TOKEN_KEY = 'hoantienshop_token_v1';
const USER_KEY = 'hoantienshop_user_v1';

let authToken = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;
try {
  const saved = localStorage.getItem(USER_KEY);
  if (saved) currentUser = JSON.parse(saved);
} catch {}

let publicConfig = {
  siteName: 'HoànTiềnShop',
  cashbackPercent: 70,
  minWithdrawAmount: 50000
};

// Helpers
function fmtVnd(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

async function copyText(text, msg = 'Đã sao chép liên kết thành công!') {
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
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
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
    copyText(copyBtn.getAttribute('data-copy'));
    return;
  }

  const openAuthEl = e.target.closest('[data-open-auth]');
  if (openAuthEl) {
    openAuthModal(openAuthEl.getAttribute('data-open-auth') || 'login');
  }
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

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  syncAuthUi();
}

function clearSession() {
  authToken = '';
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  syncAuthUi();
  switchView('home');
}

// Public Config
async function initPublicConfig() {
  try {
    const data = await apiFetch('/api/public-config');
    publicConfig = { ...publicConfig, ...data };
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
  try {
    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, phone, password })
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

productUrlInput.addEventListener('input', () => {
  clearInputBtn.classList.toggle('hidden', !productUrlInput.value);
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
      handleGetCashbackLink();
    }
  } catch {
    productUrlInput.focus();
    showToast('Hãy nhấn giữ hoặc Ctrl+V vào ô nhập để dán link.');
  }
});

clearInputBtn.addEventListener('click', () => {
  productUrlInput.value = '';
  clearInputBtn.classList.add('hidden');
  conversionResultSection.classList.add('hidden');
  productUrlInput.focus();
});

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
      showToast('Không tìm thấy link sản phẩm Shopee hoặc TikTok Shop hợp lệ.');
      return;
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
        const platLabel = isShopee
          ? '🟠 Shopee'
          : isTikTok
          ? '⚫ TikTok Shop'
          : '🔗 Liên kết';

        return `
        <div class="cashback-product-card">
          <div class="cp-top">
            <span class="valid-badge">Sản phẩm hợp lệ nhận hoàn tiền</span>
            <span style="font-size:13px;font-weight:700;color:#475569;">${platLabel}</span>
          </div>

          <div style="font-size:13.5px;color:#475569;">
            Số tiền hoàn thực tế và chi tiết đơn hàng sẽ được hệ thống cập nhật tự động vào ví ngay sau khi bạn mua hàng thành công qua liên kết bên dưới.
          </div>

          <div class="cp-body-flex">
            <div class="qr-box" title="Quét mã QR bằng điện thoại để mua hàng nhanh chóng">
              <img src="${escapeHtml(item.qrUrl)}" alt="QR Mua Hàng" loading="lazy" />
            </div>

            <div class="cp-actions-col">
              <div style="font-size:12.5px;color:#475569;font-weight:600;">Liên kết rút gọn hoàn tiền của bạn:</div>
              <div class="short-link-box">${escapeHtml(item.affiliateUrl)}</div>

              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
                <a href="${escapeHtml(
                  item.affiliateUrl
                )}" target="_blank" rel="noopener" class="btn btn-primary" style="flex:1;">
                  Mở Mua Hàng Nhận Hoàn Tiền
                </a>
                <button type="button" class="btn btn-outline" data-copy="${escapeHtml(
                  item.affiliateUrl
                )}">
                  Sao chép
                </button>
              </div>
            </div>
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

    if (currentUser.bankName) document.getElementById('wdBankName').value = currentUser.bankName;
    if (currentUser.bankAccount)
      document.getElementById('wdBankAccount').value = currentUser.bankAccount;
    if (currentUser.bankOwner) document.getElementById('wdBankOwner').value = currentUser.bankOwner;

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

document.getElementById('refreshWalletBtn').addEventListener('click', loadUserDashboard);

document.getElementById('submitOrderClaimBtn').addEventListener('click', async () => {
  const platform = document.getElementById('claimPlatform').value;
  const orderSn = document.getElementById('claimOrderSn').value.trim();
  const productName = document.getElementById('claimProductName').value.trim();
  try {
    await apiFetch('/api/user/submit-order', {
      method: 'POST',
      body: JSON.stringify({ platform, orderSn, productName })
    });
    document.getElementById('claimOrderSn').value = '';
    document.getElementById('claimProductName').value = '';
    showToast('Đã lưu mã đơn hàng thành công!');
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

  try {
    await apiFetch('/api/user/withdraw', {
      method: 'POST',
      body: JSON.stringify({ method, bankName, bankAccount, bankOwner, amount })
    });
    document.getElementById('wdAmount').value = '';
    showToast('Đã gửi yêu cầu rút tiền thành công!');
    loadUserDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// ================= ADMIN DASHBOARD =================
const admOrdCommission = document.getElementById('admOrdCommission');
const admOrdPreview70 = document.getElementById('admOrdPreview70');

if (admOrdCommission) {
  admOrdCommission.addEventListener('input', () => {
    const comm = Number(admOrdCommission.value || 0);
    const rate = Number(document.getElementById('admCashbackPercent').value || 70);
    const userGet = Math.round((comm * rate) / 100);
    const adminGet = comm - userGet;
    admOrdPreview70.value = `Khách: ${fmtVnd(userGet)} | Quản trị: ${fmtVnd(adminGet)}`;
  });
}

async function loadAdminDashboard() {
  try {
    const data = await apiFetch('/api/admin/dashboard');
    const st = data.stats;
    const s = data.settings;

    document.getElementById('admTotalComm').textContent = fmtVnd(st.totalCommission);
    document.getElementById('admUserShare').textContent = fmtVnd(st.totalUserCashback);
    document.getElementById('admProfit').textContent = fmtVnd(st.totalAdminProfit);
    document.getElementById('admUsersOrders').textContent = `${st.totalUsers} / ${st.totalOrders}`;

    document.getElementById('admShopeeMode').value = s.shopeeMode || 'an_redir';
    document.getElementById('admShopeeAffiliateId').value = s.shopeeAffiliateId || '';
    document.getElementById('admShopeeAppId').value = s.shopeeAppId || '';
    document.getElementById('admShopeeAppSecret').value = s.shopeeAppSecret || '';
    document.getElementById('admTiktokMode').value = s.tiktokMode || 'clean_extract';
    document.getElementById('admTiktokDeepLink').value = s.tiktokDeepLinkTemplate || '';
    document.getElementById('admCashbackPercent').value = s.cashbackPercent || 70;
    document.getElementById('admMinWithdraw').value = s.minWithdrawAmount || 50000;
    document.getElementById('admShortener').value = s.shortenerProvider || 'isgd';
    document.getElementById('admSupportZalo').value = s.supportZalo || '';

    const ordTbody = document.getElementById('admOrdersTableBody');
    ordTbody.innerHTML = (data.orders || [])
      .map(
        (o) => `
      <tr>
        <td><strong>${escapeHtml(o.orderSn)}</strong></td>
        <td>${escapeHtml(o.userCode || 'GUEST')}</td>
        <td>${fmtVnd(o.totalCommission)}</td>
        <td><strong style="color:#059669;">${fmtVnd(o.userCashbackAmount)}</strong></td>
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
          <button type="button" class="btn btn-success btn-sm" data-approve-ord="${escapeHtml(
            o.orderSn
          )}" data-comm="${o.totalCommission}" data-ucode="${escapeHtml(
          o.userCode
        )}">Duyệt</button>
        </td>
      </tr>
    `
      )
      .join('');

    const wdTbody = document.getElementById('admWithdrawalsTableBody');
    const wds = data.withdrawals || [];
    if (wds.length === 0) {
      wdTbody.innerHTML =
        '<tr><td colspan="5" class="text-center">Chưa có lệnh rút tiền nào.</td></tr>';
    } else {
      wdTbody.innerHTML = wds
        .map(
          (w) => `
        <tr>
          <td><strong>${escapeHtml(w.userName)}</strong> (${escapeHtml(w.userPhone)})</td>
          <td><strong style="color:#dc2626;">${fmtVnd(w.amount)}</strong></td>
          <td>${escapeHtml(w.bankName)} - <strong>${escapeHtml(
            w.bankAccount
          )}</strong> (${escapeHtml(w.bankOwner)})</td>
          <td><span class="status-badge st-${w.status}">${w.status}</span></td>
          <td>
            ${
              w.status === 'pending'
                ? `<button type="button" class="btn btn-success btn-sm" data-wd-action="paid" data-wd-id="${w.id}">Đã chuyển</button>
                   <button type="button" class="btn btn-ghost btn-sm" data-wd-action="rejected" data-wd-id="${w.id}">Từ chối</button>`
                : 'Đã xử lý'
            }
          </td>
        </tr>
      `
        )
        .join('');
    }

    const usrTbody = document.getElementById('admUsersTableBody');
    usrTbody.innerHTML = (data.users || [])
      .map(
        (u) => `
      <tr>
        <td>${escapeHtml(u.code)}</td>
        <td>${escapeHtml(u.name)} (${escapeHtml(u.phone)})</td>
        <td><strong style="color:#059669;">${fmtVnd(u.balanceAvailable)}</strong></td>
        <td>${fmtVnd(u.balancePending)}</td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('refreshAdminBtn').addEventListener('click', loadAdminDashboard);

document.getElementById('saveAdminSettingsBtn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({
        shopeeMode: document.getElementById('admShopeeMode').value,
        shopeeAffiliateId: document.getElementById('admShopeeAffiliateId').value.trim(),
        shopeeAppId: document.getElementById('admShopeeAppId').value.trim(),
        shopeeAppSecret: document.getElementById('admShopeeAppSecret').value.trim(),
        tiktokMode: document.getElementById('admTiktokMode').value,
        tiktokDeepLinkTemplate: document.getElementById('admTiktokDeepLink').value.trim(),
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
    showToast('Đã lưu đơn hàng thành công!');
    loadAdminDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('view-admin').addEventListener('click', async (e) => {
  const approveBtn = e.target.closest('[data-approve-ord]');
  if (approveBtn) {
    const orderSn = approveBtn.getAttribute('data-approve-ord');
    const totalCommission = Number(approveBtn.getAttribute('data-comm') || 0);
    const userCode = approveBtn.getAttribute('data-ucode');
    try {
      await apiFetch('/api/admin/orders', {
        method: 'POST',
        body: JSON.stringify({ orderSn, userCode, totalCommission, status: 'approved' })
      });
      showToast(`Đã duyệt đơn ${orderSn}!`);
      loadAdminDashboard();
    } catch (err) {
      showToast(err.message);
    }
    return;
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
  }
});

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

    const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      if (cols.length < 2) continue;

      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = cols[idx] || '';
      });

      const orderSn =
        rowObj['mã đơn hàng'] || rowObj['order id'] || rowObj['ordersn'] || cols[0];
      const subId1 =
        rowObj['sub_id1'] || rowObj['sub id 1'] || rowObj['sub_id'] || 'ADMIN';
      const commRaw =
        rowObj['tổng hoa hồng đơn hàng(₫)'] ||
        rowObj['hoa hồng ròng'] ||
        rowObj['total commission'] ||
        rowObj['net commission'] ||
        '0';
      const statusRaw = (
        rowObj['trạng thái đơn hàng'] ||
        rowObj['order status'] ||
        ''
      ).toLowerCase();

      const totalCommission = Number(String(commRaw).replace(/[^\d.]/g, '')) || 0;
      const status =
        statusRaw.includes('hoàn thành') || statusRaw.includes('completed')
          ? 'approved'
          : statusRaw.includes('huỷ') || statusRaw.includes('cancel')
          ? 'cancelled'
          : 'pending';

      if (orderSn) {
        rows.push({
          orderSn,
          userCode: subId1 || 'ADMIN',
          totalCommission,
          status
        });
      }
    }

    const res = await apiFetch('/api/admin/import-orders', {
      method: 'POST',
      body: JSON.stringify({ rows })
    });
    showToast(`Đã nhập thành công ${res.importedCount} đơn hàng!`);
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
