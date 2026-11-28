# PROJECT CONTEXT — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Nguồn xác minh:** Source code thực tế tại nhánh `main` (`server.js`, `package.json`, `vercel.json`, `src/`, `public/`, `.github/workflows/`).  
> **Nguyên tắc:** Tài liệu này giúp nắm nhanh ngữ cảnh; **source code hiện tại luôn là chân lý tối thượng (source of truth)**.

---

## 1. Tổng quan dự án
* **Tên dự án:** LiLa Cashback (`aff-link-converter`, domain production: `https://hoantiensan.online`).
* **Mục đích:** Nền tảng Web App / PWA hoàn tiền mua sắm (Cashback) cho **Shopee** và **TikTok Shop** tại Việt Nam: khách dán link sản phẩm $\rightarrow$ tạo link Affiliate gắn mã định danh (`clickId`) $\rightarrow$ tự động đối chiếu/so sánh giá 2 chiều Shopee $\leftrightarrow$ TikTok Shop $\rightarrow$ ghi nhận đơn hàng qua Postback / API / CSV $\rightarrow$ chia hoa hồng minh bạch vào sổ cái `ledger` $\rightarrow$ rút tiền về ngân hàng (VietQR).
* **Nền tảng mục tiêu:** Desktop Web, Mobile Web (320px–430px), và **PWA** cài ra màn hình chính trên iOS (Safari) & Android (Chrome).

## 2. Công nghệ & Thư viện cốt lõi
* **Runtime:** Node.js (`^20.19.0 || ^22.13.0 || >=24`).
* **Backend:** Express `^4.21.2`, `helmet ^8.3.0`, `cors ^2.8.5`, `pg ^8.23.1` (zero ORM, SQL thuần + in-memory cache đồng bộ phiên bản).
* **Frontend:** Vanilla HTML/CSS/JS thuần (`public/index.html`, `public/app.js`, `public/styles.css`), không dùng bundler/framework nặng; lazy-load bundle Admin (`adminMobile.css`, `adminMobile.js`, `csvImport.js`, `tiktokReply.js`) và widget (`shibaCompanion.*`, `selectPopup.*`, `leaderboardShare.js`).
* **Database:** PostgreSQL (Production chạy Neon Postgres) + fallback JSON file (`data/db.json`) hoặc memory cho local/unit test.
* **Rate Limiting / Distributed Guard:** Upstash Redis REST API (fallback in-memory khi local/test).
* **Storage (Avatar):** Vercel Blob / Supabase Storage / PostgreSQL fallback.
* **Email / OTP:** Resend API (`mailService.js`).
* **Bot Protection:** Cloudflare Turnstile.
* **Kiểm thử & Chất lượng:** ESLint `10.15.0`, Playwright `1.65.1`, custom test runner (`tests/run_all_tests.js`).

## 3. Kiến trúc tổng thể
```text
[Browser / PWA (public/ + sw.js)]
        │  HTTPS (HttpOnly Cookie JWT + Rotating Refresh Token + CSRF header)
        ▼
[Vercel Serverless (region: sin1, maxDuration: 30s) -> api/index.js -> server.js]
        │
        ├── Route Layer: src/services/cashbackController.js (Auth, Convert, Compare, Wallet, Withdraw, Leaderboard, Admin, Webhooks, Cron)
        ├── Domain Services:
        │     ├── converterService.js / shopeeService.js / tiktokService.js / urlResolver.js
        │     ├── compare/* (Facade: tiktokCompareService.js -> compareEngine, productNormalizer, productMatcher, brandDictionary, compareCache, circuitBreaker, adapters/*)
        │     ├── orderReconciliationService.js / orderMapper.js / orderIdentity.js
        │     ├── notificationService.js / mailService.js / avatarStorageService.js
        │     └── webhookSecurityService.js / webhookReceiptService.js
        └── Persistence Layer:
              ├── src/services/dbService.js (Ledger, Wallet Recalc, VIP Tiers, Session Rotation, State Sync)
              └── src/repositories/postgresRepository.js & withdrawalRepository.js -> PostgreSQL (Neon)
```

## 4. Cấu trúc thư mục chính
* `server.js` / `api/index.js`: Khởi tạo Express, Helmet/CSP, CORS, CSRF guard, requestId tracing, entrypoint Vercel.
* `src/services/`: Toàn bộ logic nghiệp vụ và tích hợp API bên thứ ba.
* `src/services/compare/`: Động cơ so sánh giá 2 chiều Shopee $\leftrightarrow$ TikTok Shop dạng module hóa.
* `src/repositories/`: Truy vấn PostgreSQL phân trang và xử lý giao dịch rút tiền nguyên tử.
* `src/utils/`: Logger có ẩn secret (`logger.js`), mã hóa secret cài đặt (`secretCrypto.js`), rate limit & Turnstile (`securityMiddleware.js`), validator link Zalo (`zalo.js`), cấu hình runtime (`runtimeConfig.js`).
* `public/`: Giao diện khách hàng, giao diện quản trị, Service Worker (`sw.js`), trang offline (`offline.html`).
* `scripts/`: `production-preflight.js`, `production-smoke.js`, tiện ích vận hành.
* `tests/`: Bộ kiểm thử đơn vị, tích hợp Postgres, Playwright E2E, benchmark độ chính xác so sánh giá (`tests/compare/`).
* `docs/`: Tài liệu kiểm toán cũ + `docs/project-memory/` (Project Memory trung tâm).
* `.github/workflows/`: `verify.yml` (CI lint + test + Playwright) và `backup-postgres.yml` (sao lưu Postgres mã hóa hàng ngày).

## 5. Quy trình Build, Kiểm thử & Deploy
* **Chạy local:** `npm start` hoặc `npm run dev` (cổng mặc định `3456`).
* **Kiểm tra bắt buộc trước khi push:**
  * `npm run lint` (ESLint toàn repo — phải 0 lỗi).
  * `npm test` (toàn bộ bộ test trong `tests/run_all_tests.js`).
  * Kiểm thử chuyên biệt khi sửa module liên quan: `npm run test:browser`, `npm run test:csv:browser`, `npm run test:compare-accuracy`, `npm run test:postgres`.
* **Deploy:** Push lên nhánh `main` $\rightarrow$ GitHub Actions chạy `verify.yml` & Vercel tự động deploy lên `https://hoantiensan.online` (region `sin1`).
* **PWA Cache:** Khi sửa file trong `public/`, phải bump query version trong `public/index.html` và `CACHE_NAME` + `SHELL_ASSETS` trong `public/sw.js` (hiện tại: `lila-pwa-v38`, `styles.css?v=2.9.21`, `app.js?v=2.9.21`).

## 6. Trạng thái hiện tại (2026-11-28)
* **Production:** Hoạt động ổn định trên Vercel (`sin1`) + Neon PostgreSQL + Upstash Redis.
* **Các tính năng đã chạy thực tế:** Dán link 1 chạm Shopee/TikTok, So sánh giá 2 chiều (động cơ `src/services/compare/*`), AccessTrade Postback 24/7 + API Sync + Vercel Cron (`0 3 * * *` UTC), Ví & Sổ cái Ledger, Rút tiền VietQR, VIP 4 hạng, Bảng xếp hạng (Đại Gia LiLa / Vua Hoàn Tiền), Giới thiệu bạn bè, Upload Avatar có crop, Thông báo chuông + Broadcast, Shiba Companion, iOS A2HS Bottom Sheet, Modal Quản lý thành viên (Desktop 2 cột / Mobile Bottom Sheet).
