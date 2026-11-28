# MODULES & DEPENDENCY MAP — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Mục đích:** Giúp AI Agent xác định nhanh file cần đọc và **các module chịu ảnh hưởng (blast radius)** trước khi sửa code.

---

## 1. Backend Modules (`server.js`, `src/`)

| Module / File | Vai trò chính | Phụ thuộc chính | Ảnh hưởng khi thay đổi |
|---|---|---|---|
| `server.js` & `api/index.js` | Khởi tạo Express, Helmet/CSP, CORS, CSRF guard, `requestId`, static serving, entrypoint Vercel | `cashbackController`, `dbService`, `securityMiddleware`, `logger` | Toàn bộ API, CSP ảnh/script, hành vi cookie & proxy |
| `src/services/cashbackController.js` | Controller trung tâm chứa toàn bộ routes `/api/*`, `/go/:clickId`, webhooks, cron, admin, leaderboard | Hầu hết các services & repositories | Rất cao — mọi thay đổi route cần kiểm tra auth, rate-limit và response shape với `public/app.js` |
| `src/services/dbService.js` | Quản lý trạng thái, Ledger, `recalculateUserWallet`, `calculateCommissionSplit`, VIP tiers, JWT/Refresh session rotation, OTP, sync Postgres | `postgresRepository`, `withdrawalRepository`, `secretCrypto`, `logger` | **Cực cao (Lõi tài chính & phiên)** — bắt buộc chạy `npm test` + `test:postgres` |
| `src/repositories/postgresRepository.js` | Schema DDL, truy vấn phân trang (orders/users/withdrawals), lưu/tải snapshot & incremental sync Postgres | `pg` | Độ bền dữ liệu Production & hiệu năng truy vấn Admin/User |
| `src/repositories/withdrawalRepository.js` | Khóa & tạo/duyệt/hoàn/lưu trữ lệnh rút tiền nguyên tử | `dbService` / `pg` | An toàn tài chính, chống rút trùng |
| `src/services/converterService.js` | Phân tích text/URL, nhận diện sàn (Shopee/TikTok), điều phối tạo link & ghi `clickId` | `urlResolver`, `shopeeService`, `tiktokService`, `shortenerService` | Luồng chính dán link của khách hàng |
| `src/services/shopeeService.js` | Chuẩn hóa URL Shopee, tạo link `an_redir` / Open API, lấy metadata AddLiveTag, tìm kiếm sản phẩm Shopee | `urlResolver`, `logger` | Chuyển đổi link Shopee & so sánh giá chiều TikTok $\rightarrow$ Shopee |
| `src/services/tiktokService.js` | Tạo link AccessTrade TikTok v2, chặn link video, lấy preview, kéo đơn `/v1/orders` & `/v1/order-products` | `urlResolver`, `logger` | Chuyển đổi link TikTok & đồng bộ đơn AccessTrade |
| `src/services/tiktokCompareService.js` | **Facade tương thích ngược** cho so sánh giá 2 chiều | `src/services/compare/*` | Các endpoint `/api/compare/*` và `tests/test_tiktok_compare.js` |
| `src/services/compare/*` | Động cơ so sánh giá module hóa: `compareEngine.js`, `productNormalizer.js`, `productMatcher.js`, `brandDictionary.js`, `compareCache.js`, `circuitBreaker.js`, `adapters/shopeeAdapter.js`, `adapters/tiktokAdapter.js` | `shopeeService`, `tiktokService`, `dbService` | Độ chính xác & tốc độ so sánh giá 2 chiều (`npm run test:compare-accuracy`) |
| `src/services/orderReconciliationService.js`, `orderMapper.js`, `orderIdentity.js` | Chuẩn hóa mã đơn, đối soát trạng thái, gán đơn về đúng user qua `clickId`/`subId` | `dbService` | Ghi nhận đơn từ CSV, Postback, Shopee API & AccessTrade API |
| `src/services/webhookSecurityService.js` & `webhookReceiptService.js` | Xác thực `POSTBACK_TOKEN`, chống replay/trùng biên nhận webhook | `dbService`, `logger` | Nhận đơn tự động 24/7 từ AccessTrade |
| `src/services/avatarStorageService.js` | Validate magic bytes (JPEG/PNG/WEBP, $\le 2$MB) và lưu avatar (Vercel Blob / Supabase / Postgres / memory) | `dbService`, `logger` | Upload & hiển thị ảnh đại diện, CSP `imgSrc` |
| `src/services/mailService.js` | Gửi email OTP quên mật khẩu qua Resend | `logger` | Luồng quên mật khẩu `/api/auth/forgot-password` |
| `src/services/notificationService.js` | Tạo, đọc, đánh dấu đã đọc thông báo người dùng & Broadcast | `dbService` | Chuông thông báo & badge chưa đọc |
| `src/utils/securityMiddleware.js` | Rate limiter (Upstash Redis + memory fallback), CSRF guard, Turnstile verify, chống brute-force đăng nhập | Upstash REST | Toàn bộ endpoint nhạy cảm (`/api/auth/*`, `/api/convert`, `/api/user/withdraw`, `/go/:clickId`) |
| `src/utils/logger.js` | Ghi log chuẩn `[ENTER]/[LEAVE]/[INFO]/[WARN]/[ERROR]` và tự động ẩn secret | AsyncLocalStorage | Khả năng truy vết & bảo mật log |
| `src/utils/zalo.js` | Validate strict allowlist domain `https://zalo.me/...` & migrate cấu hình Zalo | — | Widget Zalo & cài đặt hỗ trợ |

## 2. Frontend Modules (`public/`)

| File | Vai trò chính | Lưu ý khi chỉnh sửa |
|---|---|---|
| `public/index.html` | Toàn bộ DOM của SPA (Trang chủ, Đơn hàng, Ví, Xếp hạng, Tài khoản, Admin, Modals) | Khi đổi CSS/JS phải bump query `?v=...` khớp với `public/sw.js` |
| `public/app.js` | Logic toàn bộ SPA: `apiFetch`, auth/refresh, convert link, compare UI, wallet/withdraw, profile/avatar, leaderboard, admin, `#userManageModal`, password toggles, PWA install/update | File lớn (~7.500 dòng); khi sửa `apiFetch` phải giữ tương thích với `tests/pwa-startup.e2e.js` |
| `public/styles.css` | Toàn bộ design tokens (`:root`) và style Desktop/Mobile | Dùng biến CSS `:root`, tránh hard-code màu; `tests/test_tiktok_compare.js` kiểm tra marker class |
| `public/sw.js` | Service Worker PWA (SWR cho shell, offline fallback, `SKIP_WAITING` cho banner cập nhật) | Phải tăng `CACHE_NAME` mỗi lần phát hành UI mới; `tests/pwa-startup.e2e.js` & `test_security_audit_remediation.js` kiểm tra file này |
| `public/adminMobile.css` & `public/adminMobile.js` | Lazy-load tối ưu Admin trên Mobile (cards gọn, accordion cài đặt) | Chỉ tải khi tài khoản `admin` đăng nhập |
| `public/csvImport.js` | Lazy-load nhập báo cáo CSV Shopee/AccessTrade phía Admin | Kiểm tra bằng `npm run test:csv:browser` |
| `public/tiktokReply.js` | Lazy-load công cụ hỗ trợ trả lời/xử lý TikTok phía Admin | — |
| `public/selectPopup.css` & `public/selectPopup.js` | Popup chọn tùy biến thân thiện mobile thay `<select>` mặc định | — |
| `public/shibaCompanion.css` & `public/shibaCompanion.js` | Linh vật Shiba tương tác mép dưới màn hình (tự tránh nút Zalo) | — |
| `public/leaderboardShare.js` | Tạo/chia sẻ thẻ thành tích Bảng xếp hạng | — |
| `public/offline.html` & `public/offline.js` | Màn hình báo mất kết nối phân loại 4 nguyên nhân (`offline`, `timeout`, `server`, `connection`) | Được kiểm tra bởi `tests/pwa-startup.e2e.js` |
