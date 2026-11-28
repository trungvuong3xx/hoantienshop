# BUG FIX HISTORY — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Quy định trạng thái:**  
> `[1-Phát hiện]` Chưa sửa · `[2-Đang xử lý]` Đang làm · `[3-Đã sửa/Chưa test đủ]` · `[4-Đã sửa & Test PASS]` · `[5-Xác nhận ổn định]` · `[6-Đã thay thế]`  
> **Bắt buộc:** AI Agent phải tìm kiếm trong file này trước khi đề xuất sửa lỗi để tránh sửa lặp hoặc ghi đè giải pháp cũ.

---

## Bảng tra cứu nhanh

| Mã | Ngày | Module | Tóm tắt lỗi | Trạng thái |
|---|---|---|---|---|
| `BUG-001` | 2026-11-20 | `dbService` / Postgres | Xóa nhầm user khi sync Postgres & lệch số user active | `[5-Xác nhận ổn định]` |
| `BUG-002` | 2026-11-23 | `cashbackController` / `sw.js` | Lộ secret trên Admin UI, thiếu mask 8 secret, thiếu FK | `[5-Xác nhận ổn định]` |
| `BUG-003` | 2026-11-25 | `csvImport` / `orderMapper` | Lỗi đọc dấu chấm thập phân & trạng thái `pending` CSV Shopee | `[5-Xác nhận ổn định]` |
| `BUG-004` | 2026-11-25 | `tiktokService` | Dán link video TikTok tạo link mù gây mất đơn hoàn tiền | `[5-Xác nhận ổn định]` |
| `BUG-005` | 2026-11-25 | `cashbackController` / `dbService` | Đổi MK / Khóa user không thu hồi Refresh Session cũ (`AUD-01`) | `[5-Xác nhận ổn định]` |
| `BUG-006` | 2026-11-25 | `cashbackController` | Quên mật khẩu báo thành công giả khi Resend gửi mail lỗi (`AUD-02`) | `[5-Xác nhận ổn định]` |
| `BUG-007` | 2026-11-25 | `.github/workflows/*` | CI `verify.yml` thiếu Chromium trước `npm test`; Backup thiếu `pg_dump` v18 | `[5-Xác nhận ổn định]` |
| `BUG-008` | 2026-11-26 | `shopeeService` | AddLiveTag ước tính hoàn tiền quá cao do không giới hạn trần 2.5% | `[5-Xác nhận ổn định]` |
| `BUG-009` | 2026-11-26 | `cashbackController` / Postgres | Lệch version cache Bảng xếp hạng giữa các serverless instance | `[5-Xác nhận ổn định]` |
| `BUG-010` | 2026-11-27 | `urlResolver` / `shopeeService` | Cắt cụt URL Shopee chứa dấu ngoặc `()` / `[]` | `[4-Đã sửa & Test PASS]` |
| `BUG-011` | 2026-11-27 | `AccessTrade Postback` / Vercel | Postback URL trỏ domain cũ + token rỗng do thiếu `POSTBACK_TOKEN` trên Vercel | `[5-Xác nhận ổn định]` |
| `BUG-012` | 2026-11-27 | `public/app.js` & `sw.js` | Hay hiện banner "mất mạng" giả khi chuyển app trên mobile & banner dính vĩnh viễn | `[4-Đã sửa & Test PASS]` |
| `BUG-013` | 2026-11-27 | `tiktokCompareService` / `compare/*` | So sánh giá ra sản phẩm rác không liên quan (VD: `N. ú.m Greenfinger Bebegrow` ra vải ủi/ván trượt) | `[6-Đã thay thế]` *(nâng cấp lên engine `src/services/compare/*`)* |
| `BUG-014` | 2026-11-27 | `public/app.js` (`#userManageModal`) | Toast in lộ mật khẩu ngẫu nhiên; cộng/trừ tiền & khóa tài khoản thiếu xác nhận | `[4-Đã sửa & Test PASS]` |
| `BUG-015` | 2026-11-28 | `cashbackController` / `dbService` / `app.js` | Audit BXH V5: lỗi scope `no-undef` trigger thông báo, báo vượt hạng giả, thiếu cột PG `lb_notify_disabled`, lệch nhãn `#4` khi < 3 user, sticky bar trùng thẻ cá nhân | `[4-Đã sửa & Test PASS]` |

---

## Chi tiết từng lỗi & Lưu ý chống tái phát

### `BUG-001` — Đồng bộ Postgres cắt nhầm user (2026-11-20 · `128dd38`, `d07c50b`)
* **Module:** `src/services/dbService.js`, `src/repositories/postgresRepository.js`
* **Nguyên nhân:** Logic sync cũ xóa bản ghi user không có trong bộ nhớ tạm khi cold start.
* **Giải pháp:** Bỏ destructive user pruning, luôn bảo toàn tài khoản & đảm bảo Admin tồn tại; mọi thao tác xóa user chỉ là soft-delete (`isDeleted = true`).
* **Lưu ý chống tái phát:** Tuyệt đối không xóa vật lý bảng `users` trong bất kỳ luồng sync hay Admin action nào.

### `BUG-004` — Link Video TikTok & Fallback deeplink làm mất đơn (2026-11-25 · `054665f`, `6480979`)
* **Module:** `src/services/tiktokService.js`
* **Biểu hiện:** Khách dán link Video/Live TikTok hoặc khi AccessTrade v2 lỗi, hệ thống fallback sang deeplink không có tracking chuẩn dẫn tới rớt đơn.
* **Giải pháp:** Chặn link Video/Nội dung với thông báo hướng dẫn lấy link sản phẩm; bỏ fallback deeplink mù khi AT v2 lỗi; kiểm tra `aff_url` bắt buộc chứa `subId`.
* **Kiểm thử:** `tests/test_accesstrade_resilience.js` (12/12 PASS).

### `BUG-005` & `BUG-006` — Thu hồi phiên & Báo lỗi gửi mail OTP (2026-11-25 · `e229e85`)
* **Module:** `src/services/cashbackController.js`, `src/services/dbService.js`
* **Giải pháp:** Gọi `revokeUserSessions(userId)` khi Admin đổi mật khẩu, khóa/mở khóa, lưu trữ user, hoặc đổi mật khẩu Admin. Kiểm tra `mailResult.sent` ở `/api/auth/forgot-password` (trả `503 MAIL_DELIVERY_FAILED` nếu lỗi). Thêm `pruneExpiredAuthRecords()` vào Cron.
* **Kiểm thử:** `npm test` (37/37 PASS).

### `BUG-011` — AccessTrade Postback chưa bắn đơn về (2026-11-27)
* **Module:** Vercel Env + AccessTrade `/tool/post_back` + `webhookSecurityService.js`
* **Nguyên nhân:** (1) Postback trên AccessTrade trỏ domain cũ `hoantienshop.vercel.app` với chuỗi mẫu `{SECRET_POSTBACK_TOKEN}`; (2) Production chưa có biến `POSTBACK_TOKEN` khiến `verifyWebhookRequest` trả `403`.
* **Giải pháp:** Cấu hình `POSTBACK_TOKEN` trên Vercel Production, Redeploy, cập nhật Postback URL trên AccessTrade về `https://hoantiensan.online/api/webhooks/accesstrade?token=...`.
* **Kiểm thử:** Bắn test thật lên production: token sai $\rightarrow$ `401`, token đúng với `{order_id}` $\rightarrow$ `200 { status: 'ok', testPing: true }`; E2E 5 bước TikTok $\rightarrow$ Postback $\rightarrow$ Ví PASS.

### `BUG-012` — Hay báo "mất mạng" giả trên Mobile (2026-11-27 · `b3e09b7`)
* **Module:** `public/app.js` (`apiFetch`, `showConnectionNotice`), `public/sw.js` (`navigationResponse`)
* **Nguyên nhân:** (1) Chuyển app sang Shopee/TikTok khiến OS ngắt `fetch` ném `TypeError: Load failed`, kích hoạt banner đỏ; (2) Request phụ (`/api/preview`, `/api/compare/*`) lỗi cũng bật banner toàn trang; (3) Thiếu `hideConnectionNotice()` nên banner dính mãi dù mạng đã hồi phục; (4) `sw.js` văng thẳng `offline.html` thay vì dùng cache shell `/`.
* **Giải pháp:** Thêm `hideConnectionNotice()` tự ẩn khi `online` hoặc request thành công; auto-retry 1 lần (400ms) cho `GET` bị `Load failed`; thêm `silentConnectionNotice: true` cho request phụ và ẩn khi `visibilityState === 'hidden'`; `sw.js` fallback về cache `/` trước `offline.html`.
* **Kiểm thử:** `tests/pwa-startup.e2e.js` PASS + kiểm thử 4 kịch bản `apiFetch` PASS.
* **Lưu ý chống tái phát:** Khi sửa `apiFetch`, phải giữ guard `typeof hideConnectionNotice === 'function'` và `typeof document !== 'undefined'` vì `tests/pwa-startup.e2e.js` chạy `apiFetch` trong `vm.runInNewContext` không có DOM.

### `BUG-013` — So sánh giá TikTok $\rightarrow$ Shopee trả sản phẩm không liên quan (2026-11-27 · `0625d71`, sau đó nâng cấp sang `src/services/compare/*`)
* **Module:** `src/services/tiktokCompareService.js` $\rightarrow$ `src/services/compare/*`
* **Biểu hiện:** Dán `[LIVE] Đồ dùng trẻ em N. ú.m Greenfinger Bebegrow mềm mại, chịu nhiệt tốt` (179k) trả về vải ủi, ván trượt, xẻng cào (46k–54k).
* **Nguyên nhân:** Không gộp từ lách kiểm duyệt (`N. ú.m`); fallback query lấy 5 từ đầu cắt mất thương hiệu `Greenfinger Bebegrow`; thiếu chốt chặn thương hiệu (Brand Gate) và ngưỡng khớp thấp (`0.34`).
* **Giải pháp:** Chuẩn hóa từ lách kiểm duyệt (`N. ú.m` $\rightarrow$ `Núm`), giữ thương hiệu trong fallback query, thêm Brand Gate, sau đó module hóa hoàn chỉnh thành `src/services/compare/*` với `brandDictionary.js` và `productMatcher.js`.
* **Kiểm thử:** `tests/test_tiktok_compare.js` PASS + `npm run test:compare-accuracy`.

### `BUG-014` — Lộ mật khẩu trên Toast & thiếu xác nhận tài chính ở `#userManageModal` (2026-11-27 · `0625d71`)
* **Module:** `public/index.html`, `public/app.js`, `public/styles.css`, `public/adminMobile.js`
* **Nguyên nhân:** `btnGenerateRandomPwd` gọi `showToast('... ' + pwd)`; `btnAdjustUserBalance` và `btnToggleUserLock` không có `askUserConfirm`; preview số dư phụ thuộc `adminMobile.js`.
* **Giải pháp:** Xóa mật khẩu khỏi toast; thêm tự ẩn mật khẩu tạm sau 60s; tích hợp Segmented Toggle Cộng/Trừ + Preview Trước/Sau trực tiếp trong `index.html`/`app.js` + bắt buộc `askUserConfirm` cho điều chỉnh số dư & khóa tài khoản.
* **Kiểm thử:** Playwright E2E 6 viewport (`1280`, `320`, `360`, `375`, `390`, `430`) PASS 6/6 + `npm run lint` PASS.

### `BUG-015` — Kiểm toán Bảng Xếp Hạng V5 (2026-11-28)
* **Module:** `src/services/cashbackController.js`, `src/services/dbService.js`, `src/services/userMapper.js`, `public/app.js`, `public/sw.js`
* **Nguyên nhân:** (1) `notifyOrderEvent()` ở top-level gọi `triggerLeaderboardRankNotifications` khai báo trong closure `registerCashbackRoutes` gây lỗi ESLint `no-undef` và không kích hoạt thông báo; (2) báo vượt hạng giả khi người dẫn đầu mua thêm đơn; (3) thiếu cột `lb_notify_disabled` trong PostgreSQL `users`; (4) khối CTA hardcode `#4` kể cả khi chỉ có 1–2 user; (5) Sticky My Rank Bar chưa theo dõi `#leaderboardSideMyCard` trên Mobile.
* **Giải pháp:** Thêm module-level hook `leaderboardRankNotifyHook`; chỉ báo `lb_overtaken` khi `rankDelta` thực sự thay đổi; bổ sung cột PG `lb_notify_disabled`; tính động `nextOpenRank = Math.min(4, list.length + 1)`; mở rộng `IntersectionObserver` theo dõi cả `#leaderboardSideMyCard`.
* **Kiểm thử:** `npm run lint` (0 lỗi), 4 bộ test hồi quy PASS 100%, Playwright 8 viewport (`320`–`1920px`) × 2 tab PASS 16/16 (`0px` overflow, `0` lỗi JS).
