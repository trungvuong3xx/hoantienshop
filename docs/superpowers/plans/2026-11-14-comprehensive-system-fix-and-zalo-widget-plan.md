# Kế Hoạch Triển Khai Toàn Diện: Khắc Phục Lỗi Hệ Thống & Tích Hợp Nút Zalo Cộng Đồng

> **Dành cho Agentic Workers:** REQUIRED SUB-SKILL: Sử dụng `superpowers:subagent-driven-development` (khuyến nghị) hoặc `superpowers:executing-plans` để thực thi từng nhiệm vụ theo thứ tự. Các bước sử dụng cú pháp checkbox (`- [ ]`) để theo dõi tiến độ.

**Mục tiêu:** Khắc phục toàn bộ các lỗ hổng bảo mật, lỗi logic hạch toán ví, đồng bộ hóa frontend/backend (P0, P1, P2) và triển khai nút "Cộng đồng Zalo" nổi chuẩn bảo mật với URL allowlist tại server.

**Kiến trúc:**
- **Backend (Node.js/Express):** Tách bạch module tiện ích (`src/utils/zalo.js`, `src/utils/security.js`), chuẩn hóa webhook HMAC qua raw-body, cố định tỷ lệ hoàn tiền khi tạo đơn, bảo vệ concurrency bằng per-user lock, chuyển đổi quản lý click sang TTL time-based.
- **Frontend (Vanilla JS/CSS):** Đồng bộ hóa các trường đăng ký/giới thiệu, điều hướng chuẩn, xử lý an toàn VietQR/Preview AbortController, tích hợp nút Zalo nổi ở `z-index: 90` có cơ chế né PWA banner và tự ẩn khi mở modal/admin view.
- **Data & Config:** Di chuyển `supportZalo` cũ thành 2 trường riêng biệt: `zaloGroupUrl` và `zaloWidgetEnabled` (kèm SĐT CSKH độc lập); áp dụng URL allowlist nghiêm ngặt tại server (`https://zalo.me/*`).

**Tech Stack:** Node.js, Express, JavaScript ES6+, HTML5, CSS3 (CSS Variables, `:has()`, CSS Animation), Jest / Node Test Runner, Git.

## Global Constraints

- **Môi trường chạy:** Node.js v18+, Express, Vercel Serverless / Docker persistent host.
- **Quy tắc bảo mật Zalo:** CHỈ chấp nhận URL giao thức `https://` với hostname chính xác là `zalo.me` hoặc subdomain `*.zalo.me`. Từ chối mọi URL khác (http, javascript:, URL lừa đảo dạng `zalo.me.evil.com`, `zalo.me@evil.com`).
- **Quy tắc tài chính:** Bất biến Ledger (Financial Ledger Immutability) - không ghi `NaN`, không hoàn tiền trùng lặp cho lệnh rút tiền, không ghi đè trạng thái đơn hàng đã phê duyệt.
- **Trải nghiệm người dùng:** Giao diện tương thích mobile 360px, iPhone tai thỏ/Home bar (`env(safe-area-inset-*)`), tuân thủ chuẩn tương phản WCAG AA và `prefers-reduced-motion`.
- **Đặt tên file kế hoạch:** `docs/superpowers/plans/2026-11-14-comprehensive-system-fix-and-zalo-widget-plan.md`

---

## Danh Sách Tệp Tác Động (File Impact Map)

### Tệp Tạo Mới
- `src/utils/zalo.js`: Module chuẩn hóa, kiểm tra allowlist và xử lý URL Zalo dùng chung cho backend và validator.
- `src/utils/security.js`: Helper kiểm tra kiểu dữ liệu, làm sạch số điện thoại (E.164/VN), sanitize chuỗi chống XSS/rò rỉ.
- `tests/zalo.test.js`: Bộ unit test kiểm thử toàn diện module chuẩn hóa Zalo (các ca hợp lệ, độc hại, edge cases).
- `tests/wallet-ledger.test.js`: Kiểm thử logic hoàn tiền lệnh rút, hạch toán không sinh NaN, chống double refund.
- `tests/clicks-ttl.test.js`: Kiểm thử cơ chế dọn dẹp click theo thời gian (TTL), chống spam từ khách ẩn danh.
- `public/offline.html`: Trang offline dự phòng cho Service Worker khi mất kết nối mạng.

### Tệp Chỉnh Sửa
- `src/services/cashbackController.js`: Sửa logic click TTL, webhook HMAC, khóa đơn hàng approved, lọc trường nhạy cảm, API settings Zalo.
- `src/services/dbService.js`: Sửa `recalculateUserWallet`, hàm hoàn tiền lệnh rút, chặn ghi `NaN`, đảm bảo atomic lock với `withUserLock`.
- `public/index.html`: Thêm nút Zalo nổi, gắn label cho form, sửa trường cài đặt Admin, bổ sung checkbox điều khoản & bảo mật cá nhân (NĐ 13/2023).
- `public/styles.css`: CSS nút Zalo nổi (`z-index: 90`), né PWA banner, responsive mobile, dọn dẹp class thừa/thiếu, bổ sung `:focus-visible`.
- `public/app.js`: Tích hợp `applyZaloWidget`, sửa router `#guide`, sửa lỗi escape `&amp;` VietQR, sửa AbortError preview, xử lý sự kiện Enter kép.
- `public/sw.js`: Bổ sung cơ chế dọn cache cũ, bắt fallback `/offline.html`.

---

# PHẦN 1: KHẮC PHỤC CÁC LỖ HỔNG & LỖI HỆ THỐNG (P0, P1, P2)

---

### Task 1: Khắc Phục Lỗi Quản Lý Clicks Tại `/api/convert` (P0 #1)

**Files:**
- Modify: `src/services/cashbackController.js:1510-1535`
- Test: `tests/clicks-ttl.test.js`

**Mô tả lỗi:** Code hiện tại dùng `db.clicks.unshift(...)` sau đó cắt `db.clicks.slice(0, 5000)` hoặc `slice(-5000)`. Khi traffic lớn hoặc khách ẩn danh spam tạo link, click mới bị đẩy ra hoặc click cũ bị giữ lại vĩnh viễn theo số lượng cố định, dẫn tới `/go/:clickId` chuyển hướng lỗi về `/` và đơn hàng không gán được cho người dùng.

**Interfaces:**
- Input: `req.body.text` qua `/api/convert`.
- Output: `db.clicks` lưu trữ theo thời gian thực kèm `createdAt` và tự động lọc bỏ các click hết hạn (TTL 30 ngày) thay vì cắt gọt mảng tuyến tính.
- Logic: Giới hạn lưu click ẩn danh (guest click chỉ lưu tối thiểu hoặc yêu cầu đăng nhập/rate-limit chặt), click của thành viên được bảo toàn.

- [ ] **Step 1: Viết test kiểm tra cơ chế TTL và giữ lại click mới nhất**
Tạo file `tests/clicks-ttl.test.js`:
```javascript
const { cleanExpiredClicks, addClickRecord } = require('../src/utils/clickManager');

describe('Click TTL and Retention', () => {
  test('retains newly added clicks and removes clicks older than 30 days', () => {
    const now = Date.now();
    const mockClicks = [
      { clickId: 'old_1', createdAt: new Date(now - 31 * 86400000).toISOString() },
      { clickId: 'recent_1', createdAt: new Date(now - 2 * 86400000).toISOString() }
    ];
    const cleaned = cleanExpiredClicks(mockClicks, now);
    expect(cleaned.some(c => c.clickId === 'old_1')).toBe(false);
    expect(cleaned.some(c => c.clickId === 'recent_1')).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận test FAIL**
Run: `node --test tests/clicks-ttl.test.js` hoặc `npm test`
Expected: FAIL ("Cannot find module '../src/utils/clickManager'").

- [ ] **Step 3: Triển khai module `src/utils/clickManager.js` và cập nhật `cashbackController.js`**
Tạo `src/utils/clickManager.js`:
```javascript
const CLICK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày
const MAX_CLICKS_HARD_LIMIT = 20000;

function cleanExpiredClicks(clicks, now = Date.now()) {
  if (!Array.isArray(clicks)) return [];
  const cutoff = now - CLICK_TTL_MS;
  return clicks.filter(c => {
    const time = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    return time > cutoff;
  }).slice(0, MAX_CLICKS_HARD_LIMIT);
}

module.exports = { cleanExpiredClicks, CLICK_TTL_MS };
```
Cập nhật trong `src/services/cashbackController.js`:
```javascript
const { cleanExpiredClicks } = require('../utils/clickManager');
// Khi thêm click mới:
db.clicks.unshift({
  clickId: item.clickId,
  userId: authUser ? authUser.id : null,
  userCode: authUser ? authUser.code : 'GUEST',
  platform: item.platform,
  originalUrl: item.originalUrl,
  createdAt: new Date().toISOString()
});
db.clicks = cleanExpiredClicks(db.clicks);
await saveDb(db);
```

- [ ] **Step 4: Chạy test xác nhận PASS**
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit thay đổi**
```bash
git add src/utils/clickManager.js src/services/cashbackController.js tests/clicks-ttl.test.js
git commit -m "fix(p0): resolve click retention bug using ttl expiration at /api/convert"
```

---

### Task 2: Đồng Bộ Dữ Liệu `app.js` ↔ `index.html` ↔ `cashbackController.js` (P0 #2)

**Files:**
- Modify: `public/index.html:980-1010`
- Modify: `public/app.js:1200-1400`
- Modify: `src/services/cashbackController.js:840-960`

**Mô tả lỗi:** `app.js` tham chiếu đến các ID và API endpoint (`regRefCode`, `regTermsAgree`, `btnMaxWithdraw`, `/api/user/referrals`, `referralBountyAmount`) nhưng có trường hợp HTML thiếu phần tử hoặc API controller thiếu trường trả về, khiến hoa hồng giới thiệu 5.000đ không hoạt động và lỗi JS ngầm.

- [ ] **Step 1: Viết test kiểm tra trường `referrals` và `bountyAmount` trong API `/api/user/me`**
Thêm ca kiểm thử kiểm tra response của `/api/user/me`:
```javascript
test('GET /api/user/me returns referral statistics and bounty amount', async () => {
  const res = await request(app).get('/api/user/me').set('Cookie', authCookie);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('referralCount');
  expect(res.body).toHaveProperty('referralBountyAmount');
});
```

- [ ] **Step 2: Đảm bảo phần tử HTML tồn tại trong `public/index.html`**
Kiểm tra và chuẩn hóa các trường trong modal Đăng ký và Rút tiền:
1. Modal Đăng ký: Có `<input id="regRefCode" name="refcode" />` và `<input type="checkbox" id="regTermsAgree" required />`.
2. Modal Rút tiền: Có nút `<button type="button" id="btnMaxWithdraw" class="btn btn-ghost btn-sm">Rút hết</button>`.

- [ ] **Step 3: Khớp nối trong `public/app.js`**
Đảm bảo các bộ bắt sự kiện kiểm tra null-safe trước khi gọi `.addEventListener`:
```javascript
const btnMax = document.getElementById('btnMaxWithdraw');
if (btnMax) {
  btnMax.onclick = () => {
    const maxVal = currentUser?.balanceAvailable || 0;
    const amountInput = document.getElementById('withdrawAmountInput');
    if (amountInput) amountInput.value = maxVal;
  };
}
```

- [ ] **Step 4: Chạy test và xác nhận luồng đăng ký có mã giới thiệu hoạt động thông suốt**
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit thay đổi**
```bash
git add public/index.html public/app.js src/services/cashbackController.js
git commit -m "fix(p0): synchronize referral form elements and endpoints across client and server"
```

---

### Task 3: Chống Hoàn Tiền Trùng Lặp & Chặn Lỗi `NaN` Trong Rút Tiền (P0 #3)

**Files:**
- Modify: `src/services/dbService.js:200-350`
- Modify: `src/services/cashbackController.js:2180-2280`
- Test: `tests/wallet-ledger.test.js`

**Mô tả lỗi:** Khi admin từ chối lệnh rút (`rejected`), nếu hàm `recalculateUserWallet` đã loại trừ lệnh này khỏi tổng tiền trừ thì việc gọi thêm `refundWithdrawal` tạo bút toán hoàn tiền sẽ khiến khách hàng được hoàn tiền 2 lần (double refund). Đồng thời, nếu `wd.amount` không hợp lệ, `Math.abs(NaN)` sẽ ghi `NaN` vào ledger.

- [ ] **Step 1: Viết test kiểm tra tính bất biến và không hoàn tiền 2 lần khi reject lệnh rút**
Tạo file `tests/wallet-ledger.test.js`:
```javascript
test('rejecting a withdrawal credits wallet exactly once and rejects invalid amounts', () => {
  const initialBalance = 200000;
  const withdrawAmount = 100000;
  // Giả lập trạng thái sau khi trừ tiền tạo lệnh rút
  // Khi reject: Số dư khả dụng phải quay lại đúng 200000, không được thành 300000
});
```

- [ ] **Step 2: Chạy test xác nhận FAIL nếu xảy ra double refund**
Run: `node --test tests/wallet-ledger.test.js`

- [ ] **Step 3: Cập nhật hàm `refundWithdrawal` và `recalculateUserWallet`**
Trong `src/services/cashbackController.js`:
```javascript
async function refundWithdrawal(db, wd, adminUser) {
  const numAmount = Math.round(Number(wd.amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error('Số tiền hoàn lệnh rút không hợp lệ (NaN hoặc <= 0).');
  }
  // Kiểm tra xem đã có bút toán hoàn trả cho lệnh rút này chưa (chống hoàn 2 lần)
  const existingRefund = db.ledger.find(
    l => l.refId === `withdraw_refund_${wd.id}` && l.type === 'withdrawal_refund'
  );
  if (existingRefund) {
    return wd; // Đã hoàn rồi, không tạo thêm bút toán
  }
  wd.status = 'rejected';
  wd.processedAt = new Date().toISOString();
  // Thêm bút toán ledger hoàn tiền duy nhất
  appendLedgerEntry(db, {
    userId: wd.userId,
    type: 'withdrawal_refund',
    amount: numAmount,
    refId: `withdraw_refund_${wd.id}`,
    note: `Hoàn tiền lệnh rút bị từ chối #${wd.id}`
  });
  recalculateUserWallet(wd.userId, { persist: false });
  await saveDb(db);
  return wd;
}
```

- [ ] **Step 4: Chạy test xác nhận PASS**
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit thay đổi**
```bash
git add src/services/cashbackController.js src/services/dbService.js tests/wallet-ledger.test.js
git commit -m "fix(p0): prevent double refund and guard against NaN in withdrawal ledger entries"
```

---

### Task 4: Khắc Phục Lỗ Hổng Lost Updates Trên Môi Trường Multi-Instance Vercel (P0 #4)

**Files:**
- Modify: `src/services/dbService.js`
- Modify: `src/services/cashbackController.js`

**Mô tả lỗi:** Lưu trữ DB toàn cục bằng `saveDb(db)` trên serverless multi-instance dẫn tới race condition (ghi đè dữ liệu mới của nhau). Hàm `withUserLock` đã được import nhưng chưa bọc các thao tác tài chính quan trọng.

- [ ] **Step 1: Áp dụng `withUserLock` đồng nhất cho các hành động thay đổi số dư**
Bọc toàn bộ các endpoint sau bằng `withUserLock(userId, async () => { ... })`:
- `POST /api/user/withdraw`
- `POST /api/user/submit-order`
- `POST /api/admin/withdrawals/update`
- `POST /api/admin/withdrawals/cancel`
- `POST /api/admin/users/action` (điều chỉnh số dư)

- [ ] **Step 2: Kiểm tra reload dữ liệu mới nhất từ nguồn bền vững trước khi tính toán ví**
Đảm bảo trong khối lock luôn đọc trạng thái mới nhất từ `db` trước khi áp dụng thay đổi.

- [ ] **Step 3: Commit thay đổi**
```bash
git add src/services/cashbackController.js src/services/dbService.js
git commit -m "fix(p0): enforce atomic withUserLock across all financial balance operations"
```

---

### Task 5: Chuẩn Hóa Logic Cập Nhật Đơn Hàng Mạng Lưới `upsertNetworkOrder` (P0 #5)

**Files:**
- Modify: `src/services/cashbackController.js:1000-1120`

**Mô tả lỗi:** Khối cập nhật hoa hồng chạy trước khi kiểm tra chuyển trạng thái; đơn hàng trạng thái `approved` có thể bị sự kiện cũ ghi đè; trạng thái `approved` ↔ `cancelled` bị lật qua lại mà không có `eventTime`; đơn hàng đã thanh toán bị hủy chưa có cơ chế thu hồi hoa hồng (clawback).

- [ ] **Step 1: Thêm trường `eventTime` và kiểm tra thứ tự sự kiện**
Chỉ chấp nhận cập nhật nếu `newEventTime >= currentEventTime`.
- [ ] **Step 2: Đưa kiểm tra chặn chuyển trạng thái ngược lên trước khi cập nhật số tiền**
Nếu đơn hàng đã `approved`, không cho phép payload cũ đổi ngược về `pending`.
- [ ] **Step 3: Triển khai clawback đối với đơn đã chi trả nhưng sau đó sàn báo hủy (`cancelled`)**
Tạo bút toán ledger `order_clawback` trừ lại số dư chờ duyệt hoặc thông báo thu hồi nếu đơn đã duyệt trước đó.

- [ ] **Step 4: Chạy test hồi quy kiểm thử webhook cập nhật đơn**
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit thay đổi**
```bash
git add src/services/cashbackController.js
git commit -m "fix(p0): secure upsertNetworkOrder against out-of-order events and add clawback guard"
```

---

### Task 6: Siết Chặt Bảo Mật Webhook AccessTrade / Postback (P0 #6)

**Files:**
- Modify: `src/services/cashbackController.js:600-690`
- Modify: `server.js`

**Mô tả lỗi:** Sử dụng `getDefaultPostbackToken()`, nhận token qua query string, tính HMAC trên `JSON.stringify(req.body)` thay vì raw buffer, thiếu timestamp chống replay attack.

- [ ] **Step 1: Bắt raw body cho các endpoint webhook trong `server.js`**
Cấu hình Express lưu lại `req.rawBody` để xác thực chữ ký HMAC chuẩn xác.
- [ ] **Step 2: Loại bỏ hoàn toàn fallback token mặc định không an toàn**
Nếu cấu hình `postbackToken` không được thiết lập trong biến môi trường hoặc admin, từ chối webhook với mã 403 Forbidden.
- [ ] **Step 3: Yêu cầu token truyền qua HTTP Header chuyên dụng (`X-Postback-Token` hoặc `X-Signature-SHA256`)**
- [ ] **Step 4: Kiểm tra timestamp webhook trong vòng 5 phút để chống replay**
- [ ] **Step 5: Commit thay đổi**
```bash
git add server.js src/services/cashbackController.js
git commit -m "fix(p0): secure webhook endpoints with raw-body hmac verification and replay protection"
```

---

### Task 7: Đồng Bộ Shopee Auto Sync Theo Đúng Schema API v2 (P0 #7)

**Files:**
- Modify: `src/services/cashbackController.js:400-550`

**Mô tả lỗi:** Tên trường hoa hồng (`ord.netCommission`, `it.qty`) là phỏng đoán, khi lỗi trả về chia đều theo số đơn làm sai lệch tỷ lệ hoa hồng từng sản phẩm.

- [ ] **Step 1: Cập nhật mapper theo đúng Shopee Open API v2 Affiliate Schema**
Sử dụng các trường chuẩn: `commission`, `item_price`, `actual_amount`, `buyer_commission_rate`.
- [ ] **Step 2: Loại bỏ chia đều hoa hồng dạng fallback**
Nếu không bóc tách được chi tiết sản phẩm, lưu toàn bộ vào hoa hồng đơn hàng tổng thay vì tự ý chia đều gây sai lệch kế toán.
- [ ] **Step 3: Commit thay đổi**
```bash
git add src/services/cashbackController.js
git commit -m "fix(p0): align shopee auto sync parser with official v2 affiliate schema"
```

---

### Task 8: Nhóm Lỗi P1 - Tiền Hoàn, Rút Tiền, Bảo Mật Dữ Liệu & API

**Files:**
- Modify: `src/services/cashbackController.js`
- Modify: `public/app.js`

**Nội dung thực hiện chi tiết:**
- [ ] **8.1 (Tiền hoàn):** Chốt tỷ lệ hoàn tiền (`cashbackPercent`) và thuế (`taxDeductPercent`) tại thời điểm tạo đơn (`order.lockedCashbackRate`, `order.lockedTaxRate`). Sửa modal sửa đơn không tự động bật `hasCustomCashback` khi để trống.
- [ ] **8.2 (Rút tiền):** Bắt buộc xác nhận mật khẩu khi đổi số tài khoản ngân hàng. Áp dụng rate limit cho `/api/user/profile`. Kiểm tra và lưu vết `Idempotency-Key` tại server chống gửi đúp lệnh rút.
- [ ] **8.3 (Lộ dữ liệu nhạy cảm):** Lọc bỏ các trường nội bộ (`adminShareAmount`, `grossCommission`, `claimedByUserId`) khỏi kết quả trả về của `/api/user/me` và `/api/user/submit-order`. Không bao giờ trả plaintext token hoặc secret trong response.
- [ ] **8.4 (Admin API):** Kiểm tra mật khẩu cũ trước khi đổi mật khẩu Admin. Chặn giá trị `Infinity` và `NaN` trong `adjust_balance`. Thêm bảng ghi nhật ký thao tác quản trị (`db.auditLogs`).
- [ ] **8.5 (Xác thực & Token):** Khi `logout`, tăng `user.tokenVersion` để vô hiệu hóa token cũ trên tất cả các thiết bị. Chuẩn hóa số điện thoại người dùng về định dạng chuẩn (bỏ khoảng trắng, mã vùng +84/0) để chống gian lận đăng ký nhiều tài khoản nhận thưởng.
- [ ] **8.6 (Xử lý lỗi):** Ẩn stack trace và `err.message` thô trong môi trường production, trả về mã lỗi thân thiện.
- [ ] **8.7 (Commit nhóm P1):**
```bash
git add src/services/cashbackController.js public/app.js
git commit -m "fix(p1): resolve cashback locking, withdrawal security, data sanitization and audit logs"
```

---

### Task 9: Nhóm Lỗi P1 Frontend (`app.js`) & Pháp Lý

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`

**Nội dung thực hiện chi tiết:**
- [ ] **9.1 (VietQR):** Sửa lỗi `safeHttpsUrl` biến ký tự `&` thành `&amp;` trong thẻ `<img src="...">`, đảm bảo query params nội dung chuyển khoản và chủ tài khoản không bị hỏng.
- [ ] **9.2 (Preview Link):** Bắt riêng `AbortError` trong `apiFetch` để khi người dùng gõ URL mới, request cũ bị hủy không làm ẩn thẻ xem trước của link mới.
- [ ] **9.3 (Điều hướng):** Đồng bộ hash `#guide` và `#faq` trong router của `app.js` tránh màn hình trắng. Ẩn hoàn toàn thẻ HTML Admin khỏi DOM người dùng thông thường.
- [ ] **9.4 (CSV Import):** Bắt lỗi chi tiết từng dòng, kiểm tra dung lượng file CSV (tối đa 2MB), xử lý dấu phân cách `,` và `;`.
- [ ] **9.5 (Form Auth & Enter):** Chặn gửi đúp form khi người dùng nhấn Enter trên input bằng cách quản lý cờ `isSubmitting`.
- [ ] **9.6 (Pháp lý & Minh bạch):**
  - Thêm checkbox đồng ý xử lý dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP khi đăng ký.
  - Cập nhật tuyên bố đối tác bên thứ ba trong Điều khoản (VietQR, Cloudflare Turnstile, Shopee/TikTok Partner).
  - Chuẩn hóa thông điệp hoàn tiền: ghi rõ "nhận lên đến 70% hoa hồng sàn thực nhận (tương đương ~63% sau trừ 10% thuế TNCN theo quy định)" và mốc thời gian đối soát thống nhất "7 - 14 ngày".
- [ ] **9.7 (Commit nhóm Frontend & Pháp lý):**
```bash
git add public/app.js public/index.html
git commit -m "fix(p1): fix vietqr url escaping, router sync, double enter submit and legal consent"
```

---

### Task 10: Nhóm Lỗi P2 - Tối Ưu Trải Nghiệm, CSS & Trợ Năng

**Files:**
- Modify: `public/styles.css`
- Modify: `public/sw.js`
- Create: `public/offline.html`
- Modify: `src/utils/urlResolver.js`

**Nội dung thực hiện chi tiết:**
- [ ] **10.1 (CSS & A11y):** Bổ sung các class CSS còn thiếu (`status-approved`, `status-pending`, `cashback-pill`). Thêm `:focus-visible` hỗ trợ điều hướng bàn phím Tab. Bổ sung focus trap trong modal.
- [ ] **10.2 (Service Worker):** Thêm trang dự phòng `public/offline.html`, tự động xóa sạch cache phiên bản cũ khi service worker mới kích hoạt.
- [ ] **10.3 (URL Resolver):** Thêm cơ chế ghim IP (DNS pin) chống DNS rebinding attack, kiểm tra giới hạn thời gian resolve tối đa (deadline 6s).
- [ ] **10.4 (Commit nhóm P2):**
```bash
git add public/styles.css public/sw.js public/offline.html src/utils/urlResolver.js
git commit -m "fix(p2): polish a11y, clean unused styles, add offline fallback and harden url resolver"
```

---

# PHẦN 2: KẾ HOẠCH TRIỂN KHAI NÚT ZALO CỘNG ĐỒNG

---

### Quyết Định Thiết Kế Nút Zalo (Thống Nhất Sau Khi Rà Soát Lỗi)

| Mục | Thiết kế Cũ | Thiết kế Chuẩn Đã Chốt |
|---|---|---|
| **Lưu trữ dữ liệu** | 1 trường `supportZalo` gộp chung | 2 trường riêng biệt: `zaloGroupUrl` (link nhóm) và `zaloWidgetEnabled` (bật/tắt nút). SĐT CSKH giữ riêng ở `supportZalo`. |
| **Kiểm tra URL** | Kiểm tra sơ sài ở Client (`startsWith('http')`) | **Allowlist nghiêm ngặt tại Server** (`https://zalo.me/*`). Client chỉ render giá trị đã được server xác thực. |
| **Xử lý khi để trống** | Dùng link cứng trong JS | **Ẩn nút hoàn toàn** khi tắt hoặc để trống. Link mặc định nằm tại server config. |
| **Nhãn hiển thị** | "Nhóm Zalo hỗ trợ" | **"Cộng đồng Zalo"** (tránh hiểu lầm là kênh hỗ trợ 1-1, giảm thiểu rủi ro mạo danh admin lừa đảo). |
| **Thứ tự lớp (z-index)** | 120 | **90** (Nằm dưới Modal 100, dưới PWA Banner 150, dưới Toast 250, nhưng trên Navbar 50). |
| **Vị trí & Tránh đè** | Cố định `bottom: 24px; right: 24px` | Tự động nâng cao độ khi PWA Banner xuất hiện (`bottom: 132px`). Tự ẩn khi có Modal hoặc khi ở trang Admin. |

---

### Task 11: Backend - Module Tiện Ích Zalo & Server Allowlist (Giai đoạn 0 & 1)

**Files:**
- Create: `src/utils/zalo.js`
- Test: `tests/zalo.test.js`
- Modify: `src/services/cashbackController.js`

**Mô tả:** Tạo module chuẩn hóa và kiểm tra đường dẫn Zalo. Server chỉ chấp nhận các link thuộc tên miền chính thức `zalo.me`.

- [ ] **Step 1: Viết test kiểm tra tính hợp lệ của đường dẫn Zalo**
Tạo file `tests/zalo.test.js`:
```javascript
const { normalizeZaloTarget, isValidZaloGroupUrl } = require('../src/utils/zalo');

describe('Zalo URL Normalizer and Server Allowlist', () => {
  test('accepts valid https zalo.me group URLs', () => {
    const validUrl = 'https://zalo.me/g/cl2cmiseoqienusnrbyr';
    expect(isValidZaloGroupUrl(validUrl)).toBe(true);
    expect(normalizeZaloTarget(validUrl)).toBe(validUrl);
  });

  test('rejects insecure http URLs', () => {
    expect(isValidZaloGroupUrl('http://zalo.me/g/cl2cmiseoqienusnrbyr')).toBe(false);
  });

  test('rejects phishing domains with zalo.me prefix or suffix', () => {
    expect(isValidZaloGroupUrl('https://zalo.me.evil.com/fake')).toBe(false);
    expect(isValidZaloGroupUrl('https://evil.com/zalo.me')).toBe(false);
    expect(isValidZaloGroupUrl('https://zalo.me@evil.com/steal')).toBe(false);
  });

  test('rejects javascript: and dangerous schemes', () => {
    expect(isValidZaloGroupUrl('javascript:alert(1)')).toBe(false);
    expect(isValidZaloGroupUrl('data:text/html,...')).toBe(false);
  });

  test('handles empty or blank input safely', () => {
    expect(isValidZaloGroupUrl('')).toBe(false);
    expect(normalizeZaloTarget('')).toBe('');
  });
});
```

- [ ] **Step 2: Chạy test xác nhận FAIL**
Run: `node --test tests/zalo.test.js`
Expected: FAIL ("Cannot find module '../src/utils/zalo'").

- [ ] **Step 3: Triển khai module `src/utils/zalo.js`**
Tạo file `src/utils/zalo.js`:
```javascript
const DEFAULT_ZALO_GROUP_URL = 'https://zalo.me/g/cl2cmiseoqienusnrbyr';

function isValidZaloGroupUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (trimmed.length > 255) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    // Chỉ chấp nhận chính xác host zalo.me hoặc subdomain hợp lệ
    return parsed.hostname === 'zalo.me' || parsed.hostname.endsWith('.zalo.me');
  } catch (e) {
    return false;
  }
}

function normalizeZaloTarget(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const trimmed = urlStr.trim();
  if (isValidZaloGroupUrl(trimmed)) {
    return trimmed;
  }
  return '';
}

module.exports = {
  DEFAULT_ZALO_GROUP_URL,
  isValidZaloGroupUrl,
  normalizeZaloTarget
};
```

- [ ] **Step 4: Chạy test xác nhận PASS**
Run: `node --test tests/zalo.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Tích hợp vào API Cài đặt Admin và Public Config**
Trong `src/services/cashbackController.js`:
1. Tại `POST /api/admin/settings`:
```javascript
const { isValidZaloGroupUrl, normalizeZaloTarget } = require('../utils/zalo');

// Validate zaloGroupUrl nếu được gửi lên
if (req.body.zaloGroupUrl !== undefined) {
  const rawZalo = String(req.body.zaloGroupUrl || '').trim();
  if (rawZalo && !isValidZaloGroupUrl(rawZalo)) {
    return res.status(400).json({
      error: 'Link nhóm Zalo không hợp lệ! Vui lòng nhập link chính thức dạng https://zalo.me/g/...'
    });
  }
  db.settings.zaloGroupUrl = normalizeZaloTarget(rawZalo);
}

if (req.body.zaloWidgetEnabled !== undefined) {
  db.settings.zaloWidgetEnabled = Boolean(req.body.zaloWidgetEnabled);
}
```
2. Tại `GET /api/public-config` (hoặc `GET /api/settings`):
Trả về:
```javascript
zaloGroupUrl: db.settings.zaloGroupUrl || DEFAULT_ZALO_GROUP_URL,
zaloWidgetEnabled: db.settings.zaloWidgetEnabled ?? true,
```
3. Di chuyển dữ liệu cũ: Nếu `settings.supportZalo` hiện tại có dạng `https://zalo.me/g/...`, tự động sao chép sang `settings.zaloGroupUrl`.

- [ ] **Step 6: Commit thay đổi**
```bash
git add src/utils/zalo.js tests/zalo.test.js src/services/cashbackController.js
git commit -m "feat(zalo): add server-side url normalizer and allowlist validation"
```

---

### Task 12: Frontend - Thêm Nút Nổi & Style Né PWA/Modal (Giai đoạn 2)

**Files:**
- Modify: `public/index.html:1050-1070`
- Modify: `public/styles.css`
- Modify: `public/app.js`

**Mô tả:** Tạo phần tử thẻ `<a>` chuẩn trợ năng, gán CSS điều chỉnh độ cao né banner PWA, ẩn khi mở modal hoặc vào trang admin, và hàm cập nhật link từ cấu hình server.

- [ ] **Step 1: Bổ sung HTML nút Zalo vào `public/index.html`**
Đặt trước thẻ đóng `</body>`:
```html
<!-- Floating Zalo Community Button -->
<div id="floatingZaloWidget" class="floating-zalo hidden" role="complementary" aria-label="Cộng đồng Zalo">
  <a
    id="floatingZaloLink"
    href="https://zalo.me/g/cl2cmiseoqienusnrbyr"
    target="_blank"
    rel="noopener noreferrer"
    class="floating-zalo-btn"
    title="Tham gia Cộng đồng Zalo (mở tab mới)"
    aria-label="Tham gia Cộng đồng Zalo (mở tab mới)"
  >
    <span class="zalo-pulse-ring" aria-hidden="true"></span>
    <span class="zalo-icon-wrap" aria-hidden="true">
      <svg class="zalo-svg-icon" viewBox="0 0 48 48" width="28" height="28" fill="none">
        <circle cx="24" cy="24" r="24" fill="#0068FF"/>
        <path d="M14 16h20v4l-12 11h12v4H14v-4l12-11H14v-4z" fill="#ffffff" />
      </svg>
    </span>
    <span class="zalo-label-text">Cộng đồng Zalo</span>
  </a>
</div>
```

- [ ] **Step 2: Thêm CSS kiểm soát vị trí, hiệu ứng và né PWA trong `public/styles.css`**
```css
/* ==================== FLOATING ZALO COMMUNITY BUTTON ==================== */
.floating-zalo {
  position: fixed;
  z-index: 90; /* Dưới modal (100), trên navbar (50) */
  right: calc(16px + env(safe-area-inset-right, 0px));
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  display: flex;
  align-items: center;
  transition: bottom 0.25s ease, opacity 0.2s ease;
}

.floating-zalo.hidden {
  display: none !important;
}

.floating-zalo-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #ffffff;
  padding: 6px 14px 6px 6px;
  border-radius: 9999px;
  border: 1px solid #bfdbfe;
  box-shadow: 0 4px 14px rgba(0, 104, 255, 0.25);
  text-decoration: none;
  position: relative;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.floating-zalo-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 6px 18px rgba(0, 104, 255, 0.35);
}

.floating-zalo-btn:active {
  transform: scale(0.96);
}

.floating-zalo-btn:focus-visible {
  outline: 3px solid #0068ff;
  outline-offset: 2px;
}

.zalo-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0068ff;
  flex-shrink: 0;
}

.zalo-label-text {
  font-size: 13.5px;
  font-weight: 600;
  color: #0f172a;
  white-space: nowrap;
}

/* Hiệu ứng Pulse Ring - chạy 5 chu kỳ rồi dừng */
.zalo-pulse-ring {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 2px solid #0068ff;
  pointer-events: none;
  animation: zaloPulse 2s ease-out 5;
}

@keyframes zaloPulse {
  from {
    transform: scale(1);
    opacity: 0.6;
  }
  to {
    transform: scale(1.45);
    opacity: 0;
  }
}

/* Tự động né PWA banner khi banner hiển thị */
body:has(#pwaInstallBanner:not(.hidden)) .floating-zalo {
  bottom: calc(132px + env(safe-area-inset-bottom, 0px));
}

/* Tự động ẩn khi có bất kỳ Modal nào mở hoặc khi đang ở trang Quản trị Admin */
body:has(.modal-backdrop:not(.hidden)) .floating-zalo,
body:has(#view-admin.active) .floating-zalo {
  display: none !important;
}

/* Responsive: Ẩn nhãn chữ trên màn hình nhỏ dưới 480px */
@media (max-width: 480px) {
  .zalo-label-text {
    display: none;
  }
  .floating-zalo-btn {
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
  }
  .zalo-icon-wrap {
    width: 50px;
    height: 50px;
    box-shadow: 0 4px 12px rgba(0, 104, 255, 0.35);
  }
  .zalo-pulse-ring {
    top: 0;
    left: 0;
    width: 50px;
    height: 50px;
  }
}

/* Trợ năng: Giảm chuyển động */
@media (prefers-reduced-motion: reduce) {
  .zalo-pulse-ring {
    animation: none !important;
  }
  .floating-zalo-btn {
    transition: none !important;
  }
}
```

- [ ] **Step 3: Triển khai hàm `applyZaloWidget` trong `public/app.js`**
```javascript
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
```
Gọi hàm `applyZaloWidget(publicConfig)` trong hàm khởi tạo ứng dụng `initPublicConfig()` / `applyPublicSettings()`.

- [ ] **Step 4: Chạy thử nghiệm trên trình duyệt**
Xác nhận nút hiển thị đầy đủ icon + chữ trên desktop, thu gọn trên mobile, và click mở tab mới tới nhóm Zalo.

- [ ] **Step 5: Commit thay đổi**
```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat(zalo): implement floating community button with responsive styling and pwa avoidance"
```

---

### Task 13: Giao Diện Quản Trị Admin - Cấu Hình & Bật/Tắt Nút Zalo (Giai đoạn 3)

**Files:**
- Modify: `public/index.html:680-705`
- Modify: `public/app.js:1350-1420`

**Mô tả:** Thêm ô nhập Link Nhóm Zalo và công tắc bật/tắt hiển thị nút trong tab Cài đặt của Quản trị viên. Khi Admin lưu cấu hình, gọi lại API và cập nhật giao diện ngay lập tức mà không cần tải lại trang.

- [ ] **Step 1: Cập nhật giao diện Cài đặt trong `public/index.html`**
```html
<div class="form-group">
  <label for="admZaloGroupUrl">Link Nhóm Cộng Đồng Zalo</label>
  <input
    type="url"
    id="admZaloGroupUrl"
    placeholder="https://zalo.me/g/cl2cmiseoqienusnrbyr"
  />
  <span class="form-hint" style="font-size:12px;color:#64748b;">Chỉ chấp nhận link chính thức có dạng https://zalo.me/g/...</span>
</div>

<div class="form-group" style="margin-top:10px;">
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
    <input type="checkbox" id="admZaloWidgetEnabled" checked />
    <span style="font-weight:600;font-size:13.5px;">Bật nút nổi Cộng đồng Zalo ngoài trang chủ</span>
  </label>
</div>

<div class="form-group">
  <label for="admSupportZalo">SĐT Hỗ Trợ Kỹ Thuật (CSKH 1-1)</label>
  <input type="text" id="admSupportZalo" placeholder="0329992448..." />
</div>
```

- [ ] **Step 2: Cập nhật luồng đọc và lưu dữ liệu trong `public/app.js`**
Khi nạp cài đặt admin (`loadAdminSettings`):
```javascript
setVal('admZaloGroupUrl', s.zaloGroupUrl || '');
const chkZalo = document.getElementById('admZaloWidgetEnabled');
if (chkZalo) chkZalo.checked = s.zaloWidgetEnabled !== false;
setVal('admSupportZalo', s.supportZalo || '');
```
Khi lưu cài đặt admin (`saveAdminSettings`):
```javascript
const payload = {
  zaloGroupUrl: document.getElementById('admZaloGroupUrl')?.value?.trim() || '',
  zaloWidgetEnabled: document.getElementById('admZaloWidgetEnabled')?.checked ?? true,
  supportZalo: document.getElementById('admSupportZalo')?.value?.trim() || '',
  // ... các cài đặt khác
};
// Sau khi lưu thành công: Lấy lại public-config và cập nhật nút Zalo ngay
const updatedCfg = await apiFetch('/api/public-config');
applyZaloWidget(updatedCfg);
```

- [ ] **Step 3: Chạy test thao tác Admin**
Thử nhập URL giả mạo (ví dụ `https://evil.com`) -> Kiểm tra server trả về lỗi 400 rõ ràng.
Thử đổi link nhóm mới hợp lệ và tắt/bật công tắc -> Kiểm tra nút ngoài trang chủ phản hồi ngay lập tức.

- [ ] **Step 4: Commit thay đổi**
```bash
git add public/index.html public/app.js
git commit -m "feat(zalo): add admin settings controls for zalo group link and visibility toggle"
```

---

### Task 14: An Toàn Nội Dung & Quy Định Cộng Đồng (Giai đoạn 5)

**Files:**
- Modify: `public/index.html` (Mục FAQ & Hướng dẫn)

**Mô tả:** Bổ sung cảnh báo an toàn tại mục FAQ để bảo vệ thành viên nhóm Zalo khỏi các hành vi mạo danh admin lừa đảo.

- [ ] **Step 1: Thêm mục hỏi đáp an toàn Zalo vào FAQ trong `public/index.html`**
```html
<div class="faq-item">
  <h4 class="faq-question">🛡️ Quy định an toàn khi tham gia Cộng đồng Zalo</h4>
  <div class="faq-answer">
    <p>Nhóm Zalo là không gian giao lưu, chia sẻ kinh nghiệm mua sắm và săn sale hoàn tiền. Để đảm bảo an toàn tài chính:</p>
    <ul>
      <li><strong>Ban Quản Trị KHÔNG BAO GIỜ chủ động nhắn tin riêng yêu cầu bạn cung cấp Mật khẩu, mã OTP, hoặc chuyển tiền cọc.</strong></li>
      <li>Mọi giao dịch rút tiền chỉ diễn ra duy nhất trên website chính thức của Hoàn Tiền Sàn.</li>
      <li>Nếu phát hiện thành viên mạo danh lừa đảo, vui lòng báo cáo ngay cho hotline CSKH để xử lý.</li>
    </ul>
  </div>
</div>
```

- [ ] **Step 2: Commit thay đổi**
```bash
git add public/index.html
git commit -m "docs: add zalo community safety and fraud prevention guidelines to faq"
```

---

### Task 15: Kiểm Thử Toàn Diện & Kế Hoạch Phát Hành (Giai đoạn 4 & 6)

**Files:**
- Test: Toàn bộ test suite (`npm test`)

- [ ] **Step 1: Chạy kiểm thử tự động toàn hệ thống**
Run: `npm test`
Expected: 100% test cases PASS (không có lỗi hồi quy).

- [ ] **Step 2: Thực hiện kiểm thử thủ công theo checklist (Manual Testing Checklist)**
- [ ] 1. Màn hình điện thoại 360px: Chỉ hiện icon tròn, không che nút "Gửi Yêu Cầu Rút Tiền" và không đè bàn phím ảo.
- [ ] 2. iPhone có thanh Home (tai thỏ): Nút có khoảng cách đệm `safe-area-inset-bottom`, không bị đè bởi thanh Home.
- [ ] 3. Khi PWA Banner xuất hiện: Nút tự động được đẩy lên vị trí an toàn (`bottom: 132px`), không bị đè lên banner.
- [ ] 4. Mở modal đăng nhập, rút tiền, hoặc quét VietQR: Nút Zalo tự động ẩn đi.
- [ ] 5. Chuyển sang tab Quản trị (Admin): Nút Zalo tự động ẩn, không che các nút thao tác duyệt/hủy.
- [ ] 6. Bật chế độ `prefers-reduced-motion` trong cài đặt hệ thống: Vòng sóng pulse ring dừng hoàn toàn.
- [ ] 7. Điều hướng bằng phím Tab: Phím Tab trỏ đúng vào nút Zalo và có viền `:focus-visible` xanh rõ nét.
- [ ] 8. Thao tác trên Admin: Đổi link nhóm, tắt công tắc, lưu lại -> Nút ngoài trang chủ cập nhật ngay lập tức không cần F5.

- [ ] **Step 3: Quy trình phát hành (Rollout & Rollback)**
1. Triển khai code Backend trước để có sẵn API validation và config mới.
2. Triển khai code Frontend sau.
3. Kích hoạt nút thông qua công tắc trong Quản trị Admin.
4. Trường hợp có sự cố: Admin chỉ cần tắt công tắc trong trang Quản trị, nút sẽ lập tức biến mất mà không cần deploy lại code.

- [ ] **Step 4: Commit và tổng kết**
```bash
git status
git commit -m "chore: complete comprehensive system audit and verified zalo community widget rollout"
```
