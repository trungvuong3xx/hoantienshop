const logger = require('../utils/logger');

const DEFAULT_MAIL_FROM = 'LiLa Hoàn Tiền <no-reply@hoantiensan.online>';
const RESEND_API_URL = 'https://api.resend.com/emails';

let customTransportOverride = null;

function setMailTransportOverride(fn) {
  customTransportOverride = typeof fn === 'function' ? fn : null;
}

function resolveMailConfig(settings = {}) {
  const apiKey = String(settings?.resendApiKey || process.env.RESEND_API_KEY || '').trim();
  const from = String(settings?.mailFrom || process.env.MAIL_FROM || DEFAULT_MAIL_FROM).trim() || DEFAULT_MAIL_FROM;
  return { apiKey, from, enabled: Boolean(apiKey || customTransportOverride) };
}

function buildResetOtpEmailHtml({ userName, otpCode, ttlMinutes = 10 }) {
  const safeName = String(userName || 'bạn')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const safeOtp = String(otpCode || '').replace(/[^0-9]/g, '');
  return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 24px;">
    <h2 style="margin:0 0 12px;font-size:20px;color:#ee4d2d;">LiLa Hoàn Tiền</h2>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.5;">Xin chào <strong>${safeName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#334155;">
      Bạn vừa yêu cầu đặt lại mật khẩu tài khoản LiLa. Mã xác nhận 6 số của bạn là:
    </p>
    <div style="text-align:center;margin:20px 0;padding:16px;background:#fff7ed;border:1px dashed #fb923c;border-radius:12px;">
      <span style="font-size:30px;font-weight:800;letter-spacing:8px;color:#c2410c;">${safeOtp}</span>
    </div>
    <p style="margin:0 0 10px;font-size:13px;color:#475569;">
      Mã có hiệu lực trong <strong>${ttlMinutes} phút</strong> và chỉ sử dụng được một lần.
    </p>
    <p style="margin:0;font-size:12.5px;color:#64748b;">
      Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email và không chia sẻ mã cho bất kỳ ai.
    </p>
  </div>
</body>
</html>`;
}

async function sendPasswordResetOtpEmail({ to, userName, otpCode, settings = {}, ttlMinutes = 10 }) {
  logger.logEnter('sendPasswordResetOtpEmail', { hasRecipient: Boolean(to) });
  const cfg = resolveMailConfig(settings);
  if (!cfg.enabled) {
    logger.logLeave('sendPasswordResetOtpEmail', { sent: false, reason: 'NOT_CONFIGURED' });
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }

  const subject = `[LiLa] Mã xác nhận đặt lại mật khẩu: ${otpCode}`;
  const html = buildResetOtpEmailHtml({ userName, otpCode, ttlMinutes });
  const text = `Ma xac nhan dat lai mat khau LiLa cua ban la: ${otpCode}. Ma co hieu luc trong ${ttlMinutes} phut. Khong chia se ma nay cho bat ky ai.`;

  if (customTransportOverride) {
    await customTransportOverride({ from: cfg.from, to, subject, html, text, otpCode });
    logger.logLeave('sendPasswordResetOtpEmail', { sent: true, transport: 'override' });
    return { sent: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [to],
        subject,
        html,
        text
      })
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warning('sendPasswordResetOtpEmail', 'Resend API returned non-2xx', {
        status: res.status,
        detail: errBody.slice(0, 200)
      });
      logger.logLeave('sendPasswordResetOtpEmail', { sent: false, status: res.status });
      return { sent: false, reason: 'PROVIDER_ERROR', status: res.status };
    }
    logger.logLeave('sendPasswordResetOtpEmail', { sent: true });
    return { sent: true };
  } catch (err) {
    logger.error('sendPasswordResetOtpEmail', 'Failed to send reset email', { error: err.message });
    return { sent: false, reason: 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  DEFAULT_MAIL_FROM,
  resolveMailConfig,
  sendPasswordResetOtpEmail,
  setMailTransportOverride
};
