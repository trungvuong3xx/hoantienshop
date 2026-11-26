/* global ADMIN_TAB_PANES, latestAdminUsers, fmtVnd, showToast */
/* Responsive admin presentation; existing delegated handlers remain the source of actions. */
(() => {
  const root = document.getElementById('view-admin');
  if (!root) return;
  const nav = root.querySelector('.admin-tabs-nav');
  root.querySelector('.admin-banner').after(nav);
  const names = { orders: 'Đơn', withdrawals: 'Rút tiền', users: 'Khách', settings: 'Cài đặt' };
  nav.querySelectorAll('[data-admin-tab]').forEach(button => {
    button.querySelector('span').textContent = names[button.dataset.adminTab];
    button.setAttribute('aria-controls', ADMIN_TAB_PANES[button.dataset.adminTab]);
  });
  const header = document.querySelector('header');
  if (header && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    root.style.setProperty('--admin-header-height', `${header.getBoundingClientRect().height}px`);
  }).observe(header);
  root.querySelector('.admin-banner-title-row h2').textContent = 'Quản trị';
  const tools = document.createElement('details');
  tools.className = 'admin-header-tools';
  tools.innerHTML = '<summary>Công cụ</summary><div></div>';
  const actions = root.querySelector('.admin-banner-actions');
  actions.append(tools);
  ['syncShopeeNowBtn', 'cleanTestDataBtn'].forEach(id => tools.lastElementChild.append(document.getElementById(id)));
  // Frequent work comes before occasional import and message tools.
  const ordersPane = document.getElementById('admTabOrders');
  ordersPane.querySelectorAll(':scope > details').forEach(e => ordersPane.append(e));
  const labels = { pending: 'Chờ xử lý', approved: 'Đã duyệt', cancelled: 'Đã hủy', paid: 'Đã chuyển', rejected: 'Từ chối' };
  const mobile = window.matchMedia('(max-width: 640px)');
  const arrangeActions = more => {
    const group = more.parentElement;
    const secondary = [...group.querySelectorAll('button')].filter(e => !e.matches('[data-ord-action="approve"], [data-wd-action="paid"]'));
    secondary.forEach(button => (mobile.matches ? more.lastElementChild : group).append(button));
    more.open = false;
  };
  mobile.addEventListener('change', () => root.querySelectorAll('.admin-more-actions').forEach(arrangeActions));
  root.querySelectorAll('.admin-data-table').forEach(table => {
    const headings = [...table.querySelectorAll('th')].map(e => e.textContent.trim());
    const body = table.tBodies[0];
    const decorate = () => {
      for (const row of body.rows) {
        if (row.dataset.mobileReady) continue;
        row.dataset.mobileReady = 'true';
        [...row.cells].forEach((cell, i) => { cell.dataset.label = headings[i]; });
        row.querySelectorAll('.status-badge').forEach(badge => {
          const status = badge.textContent.trim();
          badge.textContent = status === 'pending' ? (body.id === 'admOrdersTableBody' ? 'Chờ đối soát' : 'Chờ thanh toán') : labels[status] || status;
        });
        const group = row.querySelector('.admin-action-group');
        if (group) {
          const secondary = [...group.children].filter(e => e.matches('button') && !e.matches('[data-ord-action="approve"], [data-wd-action="paid"]'));
          if (secondary.length) {
            const more = document.createElement('details');
            more.className = 'admin-more-actions';
            more.open = !mobile.matches;
            more.innerHTML = '<summary>Thao tác khác</summary><div></div>';
            secondary.forEach(e => more.lastElementChild.append(e));
            group.append(more);
            arrangeActions(more);
          }
        }
        if (body.id === 'admWithdrawalsTableBody' && row.cells.length === 6) {
          const bankCell = row.cells[3];
          const copy = document.createElement('button');
          copy.type = 'button'; copy.className = 'btn btn-outline btn-xs admin-copy-bank';
          copy.textContent = 'Sao chép STK';
          copy.addEventListener('click', async () => {
            const account = bankCell.querySelector('strong')?.textContent || '';
            try { await navigator.clipboard.writeText(account); showToast('Đã sao chép số tài khoản'); }
            catch { showToast('Không thể sao chép. Hãy nhấn giữ số tài khoản để sao chép thủ công.'); }
          });
          bankCell.append(copy);
        }
      }
    };
    new MutationObserver(decorate).observe(body, { childList: true });
    decorate();
  });
  // Field layout lives in HTML/base CSS and does not depend on this enhancement.
  const preview = document.createElement('p'); preview.className = 'admin-adjust-preview'; preview.setAttribute('aria-live', 'polite');
  document.getElementById('manageAdjustAmount').closest('.admin-adjust-row').after(preview);
  const updatePreview = () => {
    const amount = Number(document.getElementById('manageAdjustAmount').value);
    const balance = latestAdminUsers.find(u => u.id === document.getElementById('manageUserId').value)?.balanceAvailable;
    const minus = document.getElementById('manageAdjustType').value === 'minus';
    preview.textContent = amount > 0 ? `${minus ? 'Trừ' : 'Cộng'} ${fmtVnd(amount)}${Number.isFinite(balance) ? ` · Số dư dự kiến: ${fmtVnd(balance + (minus ? -amount : amount))}` : ''}` : '';
  };
  ['manageAdjustAmount', 'manageAdjustType'].forEach(id => document.getElementById(id).addEventListener('input', updatePreview));
  new MutationObserver(() => { if (!document.getElementById('userManageModal').classList.contains('hidden')) updatePreview(); }).observe(document.getElementById('userManageModal'), { attributes: true, attributeFilter: ['class'] });
  // Collapse settings into named sections without changing field IDs or save payloads.
  root.querySelectorAll('.admin-settings-grid > .admin-card').forEach(card => {
    const section = document.createElement('details'); section.className = card.className; section.open = !mobile.matches;
    const summary = document.createElement('summary'); summary.className = 'admin-settings-summary';
    const head = card.querySelector('.admin-card-head'); summary.append(head);
    section.append(summary); while (card.firstChild) section.append(card.firstChild);
    card.replaceWith(section);
  });
  const settings = document.getElementById('admTabSettings');
  const hint = settings.querySelector('.save-bar-hint');
  settings.addEventListener('input', () => { hint.textContent = 'Có thay đổi chưa lưu'; });
  settings.addEventListener('change', () => { hint.textContent = 'Có thay đổi chưa lưu'; });
})();
