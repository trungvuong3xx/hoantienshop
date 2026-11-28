# SYSTEM CONFIG — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Cảnh báo bảo mật:** **TUYỆT ĐỐI KHÔNG GHI BẤT KỲ GIÁ TRỊ SECRET, TOKEN, PASSWORD, API KEY HAY CONNECTION STRING CÓ THÔNG TIN ĐĂNG NHẬP NÀO VÀO FILE NÀY.** Chỉ ghi tên biến, mục đích và nơi cấu hình.

---

## 1. Nền tảng & Deployment
* **Production Domain:** `https://hoantiensan.online`
* **Hosting:** Vercel Serverless (`vercel.json`)
  * `regions`: `["sin1"]` (Singapore — đặt gần Neon PostgreSQL để giảm độ trễ).
  * `functions.api/*.js.maxDuration`: `30` giây.
  * Rewrites: `/api/(.*)` và `/go/(.*)` $\rightarrow$ `/api/index.js`.
  * Cron Job: `GET /api/cron/sync-shopee` chạy lúc `0 3 * * *` (03:00 UTC hàng ngày = 10:00 sáng giờ VN).
* **CI/CD & Backup (`.github/workflows/`):**
  * `verify.yml`: Cài Playwright Chromium $\rightarrow$ `npm run lint` $\rightarrow$ `npm test`.
  * `backup-postgres.yml`: Cài `postgresql-client-18` (PGDG) $\rightarrow$ sao lưu mã hóa PostgreSQL hàng ngày.
* **PWA & Service Worker:** `public/sw.js` (`CACHE_NAME = 'lila-pwa-v38'`), chiến lược Stale-While-Revalidate cho `SHELL_ASSETS`, không bao giờ cache `/api/*` và `/go/*`.

## 2. Danh mục Biến môi trường (Chỉ tên biến — Không chứa giá trị)

### A. Lõi ứng dụng & Bảo mật (Cấu hình tại Vercel Production / `.env` local)
| Tên biến | Bắt buộc (Prod) | Mục đích |
|---|---|---|
| `NODE_ENV` | Có (`production`) | Chế độ vận hành (`production`, `development`, `test`). |
| `PORT` | Không (mặc định `3456`) | Cổng chạy local (`server.js`). |
| `APP_HOST` | Khuyến nghị | Hostname chuẩn (mặc định fallback `hoantiensan.online`). |
| `TRUST_PROXY` | Tự động (`1` trên Vercel) | Số hop proxy tin cậy cho Express rate-limit & IP. |
| `ALLOWED_ORIGINS` | Khuyến nghị | Danh sách origin được phép gọi CORS/CSRF. |
| `JWT_SECRET` / `AUTH_SECRET` | Có | Khóa ký JWT & phiên đăng nhập. |
| `SETTINGS_ENCRYPTION_KEY` | Khuyến nghị | Khóa mã hóa các secret cài đặt lưu trong DB (`secretCrypto.js`). |
| `STRICT_PRODUCTION_SECURITY` | Tùy chọn | Ép kiểm tra nghiêm ngặt cấu hình bảo mật khi boot. |

### B. Database & Redis / Rate Limiting
| Tên biến | Bắt buộc (Prod) | Mục đích |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | Có | Kết nối Neon PostgreSQL (lưu users, orders, clicks, withdrawals, ledger, settings, sessions). |
| `TEST_DATABASE_URL` | Chỉ khi test PG | DB riêng phục vụ `npm run test:postgres`. |
| `PG_SSL_CA` | Tùy chọn | Chứng chỉ CA tùy chỉnh cho SSL PostgreSQL. |
| `UPSTASH_REDIS_REST_URL` | Có | Endpoint Upstash Redis REST cho rate-limit & chống brute-force phân tán. |
| `UPSTASH_REDIS_REST_TOKEN` | Có | Token xác thực Upstash Redis REST. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Alias dự phòng | Biến alias cũ của Vercel Marketplace (chỉ dùng khi thiếu cặp `UPSTASH_*`). |

### C. Tài khoản Admin khởi tạo & Vận hành Cron
| Tên biến | Mục đích |
|---|---|
| `ADMIN_PHONE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_CODE`, `ADMIN_BANK_OWNER` | Khởi tạo/đồng bộ tài khoản Super Admin nếu chưa tồn tại trong DB. |
| `FORCE_SYNC_ADMIN_PASSWORD` / `RESET_ADMIN_PASSWORD` | Cờ khẩn cấp đồng bộ lại mật khẩu Admin (không bật thường trực). |
| `CRON_SECRET` | Xác thực cho Vercel Cron gọi `/api/cron/sync-shopee` (thiếu/sai trả `401`). |

### D. Tích hợp Affiliate, Webhook & So sánh giá
| Tên biến | Nơi cấu hình | Mục đích |
|---|---|---|
| `POSTBACK_TOKEN` / `POSTBACK_SECRET` | Vercel Prod | Token xác thực webhook `/api/webhooks/accesstrade` (bắt buộc để nhận đơn TikTok Shop 24/7). |
| `ACCESSTRADE_API_KEY` | Vercel hoặc Admin UI | Gọi AccessTrade v2 (tạo link TikTok Shop, feed so sánh giá) & v1 (đồng bộ đơn). |
| `ADDLIVETAG_API_KEY` | Vercel hoặc Admin UI | Lấy metadata sản phẩm Shopee & tìm kiếm đối chiếu TikTok $\rightarrow$ Shopee. |
| `SHOPEE_MODE`, `SHOPEE_AFFILIATE_ID`, `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` | Vercel hoặc Admin UI | Cấu hình tạo link & đồng bộ đơn Shopee (`an_redir` / `openapi`). |
| `TIKTOK_MODE`, `TIKTOK_DEEPLINK_TEMPLATE`, `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_ACCESS_TOKEN` | Vercel hoặc Admin UI | Cấu hình chế độ TikTok Shop (`deeplink` / `openapi` / `disabled`). |
| `SHORTENER_PROVIDER` | Vercel hoặc Admin UI | Dịch vụ rút gọn link (nếu bật). |
| `RESOLVER_USER_AGENT` | Tùy chọn | User-Agent cho `urlResolver.js`. |

### E. Email, Anti-Bot, Lưu trữ Avatar & Cấu hình chung
| Tên biến | Mục đích |
|---|---|
| `RESEND_API_KEY`, `MAIL_FROM` | Gửi email OTP quên mật khẩu qua Resend (`mailService.js`). |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `REQUIRE_TURNSTILE`, `ENFORCE_TURNSTILE_IN_TEST` | Bảo vệ form đăng ký/đăng nhập/quên mật khẩu bằng Cloudflare Turnstile. |
| `BLOB_READ_WRITE_TOKEN` | Lưu ảnh đại diện người dùng trên Vercel Blob (`avatarStorageService.js`). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AVATAR_BUCKET` | Phương án lưu ảnh đại diện thay thế trên Supabase Storage. |
| `SITE_NAME`, `CASHBACK_PERCENT`, `TAX_DEDUCT_PERCENT`, `MIN_WITHDRAW`, `REFERRAL_BOUNTY_AMOUNT`, `SUPPORT_ZALO`, `ZALO_GROUP_URL` | Giá trị mặc định khởi tạo settings (có thể chỉnh trực tiếp trong Admin UI). |

## 3. Cấu hình Security Headers & CSP (`server.js` + `vercel.json`)
* `X-Frame-Options: DENY` & `frameAncestors: ['none']` (chống clickjacking).
* `Referrer-Policy: strict-origin-when-cross-origin` (ẩn nguồn web cashback khi chuyển hướng sang sàn).
* `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
* `Content-Security-Policy` cho phép ảnh từ `self`, `data:`, `blob:`, Vercel Blob, Supabase, VietQR, `api.qrserver.com`, CDN Shopee & TikTok; script chỉ từ `self` và Cloudflare Turnstile.
* Toàn bộ API thay đổi dữ liệu yêu cầu header `X-Requested-With: XMLHttpRequest` (CSRF guard) và xác thực bằng HttpOnly Cookie.

## 4. Điểm lưu ý về đồng bộ cài đặt
* Các trường bí mật trong Admin Settings được mã hóa bằng `secretCrypto.js` trước khi lưu DB và **luôn trả dạng che (`•••`)** khi gọi `GET /api/admin/settings` (chỉ hiển thị bản thô URL Postback qua endpoint riêng `GET /api/admin/reveal-postback-url` có `requireAdmin`).
* Biến môi trường trên Vercel luôn ưu tiên làm fallback hoặc ghi đè tùy trường (xem `cashbackController.js` & `dbService.js`).
