const STORAGE_KEY_CONFIG = 'affconvert_config_v1';
const STORAGE_KEY_HISTORY = 'affconvert_history_v1';

const defaultConfig = {
  shopeeMode: 'an_redir',
  shopeeAffiliateId: '',
  shopeeAppId: '',
  shopeeAppSecret: '',
  tiktokMode: 'clean_extract',
  tiktokAppKey: '',
  tiktokAppSecret: '',
  tiktokAccessToken: '',
  tiktokCookie: '',
  tiktokDeepLinkTemplate: '',
  subId: '',
  shortenerProvider: 'isgd'
};

let currentConfig = loadConfig();

// DOM Elements
const quickShopeeId = document.getElementById('quickShopeeId');
const quickTikTokMode = document.getElementById('quickTikTokMode');
const quickSubId = document.getElementById('quickSubId');
const quickShortener = document.getElementById('quickShortener');

const shopeeStatusPill = document.getElementById('shopeeStatusPill');
const tiktokStatusPill = document.getElementById('tiktokStatusPill');

const inputText = document.getElementById('inputText');
const outputText = document.getElementById('outputText');
const liveDetectedBadges = document.getElementById('liveDetectedBadges');
const convertBtn = document.getElementById('convertBtn');
const copyAllTextBtn = document.getElementById('copyAllTextBtn');
const pasteClipboardBtn = document.getElementById('pasteClipboardBtn');
const sampleBtn = document.getElementById('sampleBtn');
const clearBtn = document.getElementById('clearBtn');

const linkCountLabel = document.getElementById('linkCountLabel');
const summaryStats = document.getElementById('summaryStats');
const linkCardsContainer = document.getElementById('linkCardsContainer');
const historyContainer = document.getElementById('historyContainer');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

// Modal Elements
const settingsModal = document.getElementById('settingsModal');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

const modalShopeeMode = document.getElementById('modalShopeeMode');
const modalShopeeId = document.getElementById('modalShopeeId');
const modalShopeeAppId = document.getElementById('modalShopeeAppId');
const modalShopeeAppSecret = document.getElementById('modalShopeeAppSecret');

const modalTikTokMode = document.getElementById('modalTikTokMode');
const modalTikTokAppKey = document.getElementById('modalTikTokAppKey');
const modalTikTokAppSecret = document.getElementById('modalTikTokAppSecret');
const modalTikTokAccessToken = document.getElementById('modalTikTokAccessToken');
const modalTikTokCookie = document.getElementById('modalTikTokCookie');
const modalTikTokDeepLink = document.getElementById('modalTikTokDeepLink');

const toastEl = document.getElementById('toast');

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (!raw) return { ...defaultConfig };
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfig(newConf) {
  currentConfig = { ...currentConfig, ...newConf };
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(currentConfig));
  syncUiFromConfig();
}

function syncUiFromConfig() {
  quickShopeeId.value = currentConfig.shopeeAffiliateId || '';
  quickTikTokMode.value = currentConfig.tiktokMode || 'clean_extract';
  quickSubId.value = currentConfig.subId || '';
  quickShortener.value = currentConfig.shortenerProvider || 'isgd';

  modalShopeeMode.value = currentConfig.shopeeMode || 'an_redir';
  modalShopeeId.value = currentConfig.shopeeAffiliateId || '';
  modalShopeeAppId.value = currentConfig.shopeeAppId || '';
  modalShopeeAppSecret.value = currentConfig.shopeeAppSecret || '';

  modalTikTokMode.value = currentConfig.tiktokMode || 'clean_extract';
  modalTikTokAppKey.value = currentConfig.tiktokAppKey || '';
  modalTikTokAppSecret.value = currentConfig.tiktokAppSecret || '';
  modalTikTokAccessToken.value = currentConfig.tiktokAccessToken || '';
  modalTikTokCookie.value = currentConfig.tiktokCookie || '';
  modalTikTokDeepLink.value = currentConfig.tiktokDeepLinkTemplate || '';

  // Update header status pills
  const hasShopee =
    (currentConfig.shopeeMode === 'openapi' && currentConfig.shopeeAppId) ||
    Boolean(currentConfig.shopeeAffiliateId && currentConfig.shopeeAffiliateId.trim());

  if (hasShopee) {
    shopeeStatusPill.className = 'status-pill pill-ok';
    shopeeStatusPill.textContent =
      currentConfig.shopeeMode === 'openapi'
        ? 'Shopee: Open API'
        : `Shopee ID: ${currentConfig.shopeeAffiliateId.trim()}`;
  } else {
    shopeeStatusPill.className = 'status-pill pill-warn';
    shopeeStatusPill.textContent = 'Shopee: Chưa nhập Affiliate ID';
  }

  const tiktokModeLabels = {
    clean_extract: 'TikTok: Bóc Product ID & Link sạch',
    openapi: 'TikTok: Open API',
    cookie: 'TikTok: Web Cookie',
    deeplink: 'TikTok: DeepLink'
  };
  tiktokStatusPill.className = 'status-pill pill-info';
  tiktokStatusPill.textContent =
    tiktokModeLabels[currentConfig.tiktokMode] || 'TikTok: Bóc Product ID';
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 2600);
}

async function copyToClipboard(text, label = 'Đã sao chép vào Clipboard!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`✅ ${label}`);
  } catch {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
    showToast(`✅ ${label}`);
  }
}

// Live URL detection in input textarea
function updateLiveBadges() {
  const val = inputText.value || '';
  const urls = (val.match(/https?:\/\/[^\s<>"')\]}]+/gi) || []).map((u) =>
    u.replace(/[.,;!?]+$/, '')
  );

  if (urls.length === 0) {
    liveDetectedBadges.innerHTML = '<span class="badge-neutral">Chưa phát hiện link</span>';
    return;
  }

  let shopee = 0;
  let tiktok = 0;
  let other = 0;

  urls.forEach((u) => {
    const lower = u.toLowerCase();
    if (lower.includes('shopee.vn') || lower.includes('shp.ee') || lower.includes('shope.ee')) {
      shopee++;
    } else if (lower.includes('tiktok.com')) {
      tiktok++;
    } else {
      other++;
    }
  });

  const badges = [];
  if (shopee > 0) badges.push(`<span class="badge-shopee">🟠 ${shopee} link Shopee</span>`);
  if (tiktok > 0) badges.push(`<span class="badge-tiktok">⚫ ${tiktok} link TikTok</span>`);
  if (other > 0) badges.push(`<span class="badge-neutral">🔗 ${other} link khác</span>`);
  liveDetectedBadges.innerHTML = badges.join('');
}

// Render detailed breakdown cards
function renderLinkCards(items, summary) {
  linkCountLabel.textContent = items.length;
  if (summary) {
    summaryStats.textContent = `Thành công: ${summary.successCount}/${summary.total}`;
  } else {
    summaryStats.textContent = '';
  }

  if (!items || items.length === 0) {
    linkCardsContainer.innerHTML = `
      <div class="empty-state">
        Không tìm thấy link nào trong văn bản. Hãy kiểm tra lại nội dung dán vào.
      </div>`;
    return;
  }

  linkCardsContainer.innerHTML = items
    .map((item, idx) => {
      const isShopee = item.platform === 'shopee';
      const isTikTok = item.platform === 'tiktok';
      const cardClass =
        item.status === 'error'
          ? 'card-error'
          : isShopee
          ? 'card-shopee'
          : isTikTok
          ? 'card-tiktok'
          : '';

      const badgeHtml = isShopee
        ? '<span class="badge-shopee">🟠 Shopee</span>'
        : isTikTok
        ? '<span class="badge-tiktok">⚫ TikTok Shop</span>'
        : '<span class="badge-neutral">🔗 Link khác</span>';

      const idText = item.productId
        ? `<span class="id-pill" data-copy="${escapeHtml(item.productId)}" title="Bấm để copy mã ID sản phẩm">ID: ${escapeHtml(
            item.productId
          )} 📋</span>`
        : '';

      const errorOrNoteHtml = item.error
        ? `<div class="card-note">⚠️ ${escapeHtml(item.error)}</div>`
        : item.note
        ? `<div class="card-note">ℹ️ ${escapeHtml(item.note)}</div>`
        : '';

      const tiktokQuickBtn =
        isTikTok && item.affiliateCenterUrl
          ? `<a href="${escapeHtml(
              item.affiliateCenterUrl
            )}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">🚀 Mở trong TikTok Affiliate Center</a>`
          : '';

      return `
        <div class="link-card ${cardClass}">
          <div class="card-top">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              ${badgeHtml}
              <span class="method-tag">${escapeHtml(item.usedMethod || '')}</span>
            </div>
            ${idText}
          </div>

          <div class="url-row">
            <span class="url-mono" id="aff-url-${idx}">${escapeHtml(item.affiliateUrl)}</span>
            <button type="button" class="btn btn-primary btn-sm" data-copy="${escapeHtml(
              item.affiliateUrl
            )}">Copy Link</button>
          </div>

          <div class="url-sub">
            <strong>Link gốc sạch:</strong> <a href="${escapeHtml(
              item.cleanUrl
            )}" target="_blank" rel="noopener">${escapeHtml(item.cleanUrl)}</a>
          </div>

          ${errorOrNoteHtml}

          ${
            tiktokQuickBtn
              ? `<div class="card-actions">${tiktokQuickBtn}</div>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Perform conversion
async function handleConvert() {
  const text = inputText.value.trim();
  if (!text) {
    showToast('⚠️ Vui lòng dán link hoặc bài viết vào ô bên trái trước!');
    inputText.focus();
    return;
  }

  // Sync quick bar fields into currentConfig
  saveConfig({
    shopeeAffiliateId: quickShopeeId.value.trim(),
    tiktokMode: quickTikTokMode.value,
    subId: quickSubId.value.trim(),
    shortenerProvider: quickShortener.value
  });

  // Check if Shopee link exists but no Affiliate ID entered
  const hasShopeeUrl = /shopee\.vn|shp\.ee|shope\.ee/i.test(text);
  if (
    hasShopeeUrl &&
    currentConfig.shopeeMode !== 'openapi' &&
    !currentConfig.shopeeAffiliateId
  ) {
    showToast('⚠️ Hãy nhập Mã Shopee Affiliate ID của bạn ở thanh trên cùng!');
    quickShopeeId.focus();
    return;
  }

  convertBtn.disabled = true;
  convertBtn.textContent = '⏳ Đang giải mã & chuyển đổi...';

  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        config: currentConfig
      })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.error || 'Có lỗi xảy ra'}`);
      return;
    }

    outputText.value = data.convertedText || '';
    copyAllTextBtn.disabled = !data.convertedText;

    renderLinkCards(data.items || [], data.summary);
    saveToHistory(data);
    showToast(`✅ Đã xử lý xong ${data.summary?.successCount || 0} link!`);
  } catch (err) {
    showToast(`❌ Không thể kết nối máy chủ: ${err.message}`);
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = '⚡ Chuyển đổi sang Link Affiliate';
  }
}

// History management
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToHistory(resultData) {
  if (!resultData || !resultData.items || resultData.items.length === 0) return;
  const list = loadHistory();
  const entry = {
    id: Date.now(),
    time: new Date().toLocaleString('vi-VN'),
    convertedText: resultData.convertedText,
    shopeeCount: resultData.summary?.shopeeCount || 0,
    tiktokCount: resultData.summary?.tiktokCount || 0
  };
  const updated = [entry, ...list].slice(0, 12);
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(updated));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  if (list.length === 0) {
    historyContainer.innerHTML = '<div class="empty-state-sm">Chưa có lịch sử chuyển đổi nào.</div>';
    return;
  }

  historyContainer.innerHTML = list
    .map(
      (item) => `
      <div class="history-item">
        <div class="history-meta">
          <span>🕒 ${escapeHtml(item.time)}</span>
          <span>🟠 ${item.shopeeCount} Shopee | ⚫ ${item.tiktokCount} TikTok</span>
        </div>
        <div class="history-preview">${escapeHtml(item.convertedText)}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:4px;">
          <button type="button" class="btn btn-secondary btn-sm" data-copy="${escapeHtml(
            item.convertedText
          )}">📋 Copy lại bài này</button>
        </div>
      </div>
    `
    )
    .join('');
}

// Event Listeners
inputText.addEventListener('input', updateLiveBadges);

inputText.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleConvert();
  }
});

convertBtn.addEventListener('click', handleConvert);

copyAllTextBtn.addEventListener('click', () => {
  if (outputText.value) {
    copyToClipboard(outputText.value, 'Đã copy toàn bộ bài viết đã đổi link!');
  }
});

pasteClipboardBtn.addEventListener('click', async () => {
  try {
    const clip = await navigator.clipboard.readText();
    if (clip) {
      inputText.value = clip;
      updateLiveBadges();
      showToast('📋 Đã dán nội dung từ Clipboard!');
    }
  } catch {
    showToast('⚠️ Hãy nhấn Ctrl+V vào ô văn bản để dán.');
    inputText.focus();
  }
});

sampleBtn.addEventListener('click', () => {
  if (!quickShopeeId.value.trim()) {
    quickShopeeId.value = '17388899900';
  }
  inputText.value = [
    '🔥 Tổng hợp deal hời hôm nay cho cả nhà:',
    '1. Tai nghe Bluetooth chống ồn trên Shopee: https://shopee.vn/Tai-nghe-i.12345678.9876543210?sp_atk=abc123&utm_source=someone_else',
    '2. Link rút gọn có gắn mã của người khác: https://s.shopee.vn/an_redir?origin_link=https%3A%2F%2Fshopee.vn%2Fproduct%2F88776655%2F1122334455&affiliate_id=9999999',
    '3. Áo thun boxy trên TikTok Shop: https://shop.tiktok.com/view/product/1729584930291827364?checksum=old_aff_code&sec_uid=xxx'
  ].join('\n\n');
  updateLiveBadges();
  showToast('🧪 Đã nạp bài viết mẫu! Hãy bấm "Chuyển đổi sang Link Affiliate".');
});

clearBtn.addEventListener('click', () => {
  inputText.value = '';
  outputText.value = '';
  copyAllTextBtn.disabled = true;
  updateLiveBadges();
  linkCountLabel.textContent = '0';
  summaryStats.textContent = '';
  linkCardsContainer.innerHTML = `
    <div class="empty-state">
      Dán link ở cột bên trái và bấm <strong>"Chuyển đổi sang Link Affiliate"</strong> để xem chi tiết từng sản phẩm.
    </div>`;
});

// Quick bar auto-save
[quickShopeeId, quickTikTokMode, quickSubId, quickShortener].forEach((el) => {
  el.addEventListener('change', () => {
    saveConfig({
      shopeeAffiliateId: quickShopeeId.value.trim(),
      tiktokMode: quickTikTokMode.value,
      subId: quickSubId.value.trim(),
      shortenerProvider: quickShortener.value
    });
  });
});

// Delegate copy buttons in cards and history
document.body.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const val = copyBtn.getAttribute('data-copy');
    if (val) copyToClipboard(val);
    return;
  }

  const guideBtn = e.target.closest('[data-open-guide]');
  if (guideBtn) {
    const target = guideBtn.getAttribute('data-open-guide');
    openModalWithTab(target === 'tiktok' ? 'tab-tiktok' : 'tab-shopee');
  }
});

// Modal logic
function openModalWithTab(tabId = 'tab-shopee') {
  syncUiFromConfig();
  settingsModal.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === tabId);
  });
}

openSettingsBtn.addEventListener('click', () => openModalWithTab('tab-shopee'));
shopeeStatusPill.addEventListener('click', () => openModalWithTab('tab-shopee'));
tiktokStatusPill.addEventListener('click', () => openModalWithTab('tab-tiktok'));

closeSettingsBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    openModalWithTab(tabId);
  });
});

saveSettingsBtn.addEventListener('click', () => {
  saveConfig({
    shopeeMode: modalShopeeMode.value,
    shopeeAffiliateId: modalShopeeId.value.trim(),
    shopeeAppId: modalShopeeAppId.value.trim(),
    shopeeAppSecret: modalShopeeAppSecret.value.trim(),
    tiktokMode: modalTikTokMode.value,
    tiktokAppKey: modalTikTokAppKey.value.trim(),
    tiktokAppSecret: modalTikTokAppSecret.value.trim(),
    tiktokAccessToken: modalTikTokAccessToken.value.trim(),
    tiktokCookie: modalTikTokCookie.value.trim(),
    tiktokDeepLinkTemplate: modalTikTokDeepLink.value.trim()
  });
  settingsModal.classList.add('hidden');
  showToast('💾 Đã lưu cài đặt tài khoản Affiliate!');
});

clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY_HISTORY);
  renderHistory();
  showToast('🗑️ Đã xoá lịch sử chuyển đổi.');
});

// Initialize on page load
syncUiFromConfig();
renderHistory();
updateLiveBadges();
