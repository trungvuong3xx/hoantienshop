/* global copyText */
(() => {
  const form = document.getElementById('tiktokReplyForm');
  if (!form) return;
  const linkInput = document.getElementById('tiktokReplyLink');
  const commissionInput = document.getElementById('tiktokReplyCommission');
  const output = document.getElementById('tiktokReplyOutput');
  const status = document.getElementById('tiktokReplyStatus');
  const copyButton = document.getElementById('tiktokReplyCopy');
  const money = value => `${value.toLocaleString('vi-VN')}đ`;

  // Clear stale quotes when either input changes so a previous customer's
  // link or amount cannot accidentally be copied with new inputs.
  form.addEventListener('input', () => {
    output.value = '';
    copyButton.disabled = true;
    status.textContent = 'Bấm Tạo mẫu để cập nhật tin nhắn.';
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    output.value = '';
    copyButton.disabled = true;
    const link = linkInput.value.trim();
    try {
      const parsed = new URL(link);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /\s/.test(link) || link.length > 4000) {
        throw new Error('Invalid link');
      }
    } catch {
      status.textContent = 'Vui lòng dán một link affiliate hợp lệ bắt đầu bằng https://.';
      linkInput.focus();
      return;
    }
    const rawCommission = commissionInput.value.trim();
    const gross = Number(rawCommission);
    if (!/^\d+$/.test(rawCommission) || !Number.isSafeInteger(gross) || gross < 0) {
      status.textContent = 'Nhập hoa hồng bằng số đồng nguyên không âm, ví dụ 25000; không nhập dấu chấm, dấu phẩy hoặc %.';
      commissionInput.focus();
      return;
    }

    // Match the wallet's rounding: tax first, then customer's share of net.
    const tax = Math.round(gross * 10 / 100);
    const net = gross - tax;
    const cashback = Math.round(net * 70 / 100);
    output.value = [
      '🛒 Link đặt hàng TikTok:',
      link,
      '',
      `💰 Hoàn tiền ước tính: ${money(cashback)}`,
      '',
      'Đặt hàng qua link trên rồi nhắn mình để ghi nhận hoàn tiền nhé.',
      'Tiền hoàn chính thức được xác nhận sau khi sàn đối soát.'
    ].join('\n');
    status.textContent = `Hoa hồng: ${money(gross)} · Thuế 10%: ${money(tax)} · Phần của bạn: ${money(net - cashback)} · Khách nhận: ${money(cashback)}`;
    copyButton.disabled = false;
  });

  copyButton.addEventListener('click', () => {
    if (!output.value) return;
    copyText(output.value, 'Đã sao chép tin nhắn TikTok. Bạn có thể dán vào Zalo.');
  });
})();
