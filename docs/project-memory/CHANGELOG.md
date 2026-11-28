# CHANGELOG — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> Ghi nhận các mốc nâng cấp quan trọng đã triển khai trên nhánh `main`.

---

## 2026-11-27 — 2026-11-28
* **Nâng cấp toàn diện Bảng Xếp Hạng V5 & Kiểm toán QA (`lila-pwa-v49`):**
  * Thiết kế lại sân khấu Podium Vàng/Bạc/Đồng cho 2 danh hiệu **Đại Gia LiLa** (Cam-Vàng) & **Vua Hoàn Tiền** (Xanh Ngọc), gộp 1 nút Chia sẻ duy nhất, tránh mascot Shiba đè nút trên Mobile.
  * Thêm bộ lọc trực tiếp **Tuần này / Tháng này / Toàn thời gian** (UTC+7 + đếm ngược + index PG `idx_orders_status_updated_at`), khối CTA động `#4` với 3 slot mờ, khoảng cách tới hạng kế / dẫn trước Top #2, thanh tiến trình VIP + Bottom Sheet quyền lợi.
  * Thêm quyền riêng tư BXH lọc ngay tầng server (`hide_from_leaderboard`, `leaderboard_anonymous`, `leaderboard_hide_amount`, `lb_notify_disabled`), Ảnh chia sẻ PNG tích hợp QR Code chuẩn ISO/IEC 18004 (9:16 Story & 1:1 Post) + Deep Link tracking, Confetti 1.5s + Shiba chúc mừng lên hạng, thông báo biến động BXH (giờ yên tĩnh 22h–7h VN), và Cấu hình Mùa giải + Phần thưởng Top 3 trong Admin Settings (2C).
  * Kiểm toán toàn diện & sửa 5 lỗi P1/P2 (`BUG-015`): `npm run lint` 0 lỗi, 4 suite hồi quy PASS, Playwright 8 viewport (`320–1920px`) PASS 16/16.
* **So sánh giá 2 chiều Shopee $\leftrightarrow$ TikTok Shop (`195f843`, `79de75b`, `f90f086`, `2c4192a`, `0625d71`, và refactor `src/services/compare/*`):**
  * Thêm so sánh giá 2 chiều kèm nút mua tạo link affiliate có tracking riêng cho từng user.
  * Thêm nguồn AddLiveTag Market Search fallback cho chiều TikTok $\rightarrow$ Shopee.
  * Tái cấu trúc thành động cơ module `src/services/compare/*` (brand dictionary, obfuscated-word normalizer `N. ú.m` $\rightarrow$ `Núm`, strict unit/combo matcher, circuit breaker, compare cache).
  * Thống nhất nhãn `TikTok Shop rẻ hơn Xđ` / `Shopee rẻ hơn Xđ`; ẩn hoa hồng gốc nội bộ & bỏ dòng "Giá thực trả sau hoàn".
* **Thiết kế lại Modal Quản lý thành viên (`0625d71`, `lila-pwa-v38`):**
  * Desktop `860px` 2 cột Card; Mobile Bottom Sheet `94dvh` + Accordion (tối ưu 320px–430px).
  * Thêm Segmented Toggle Cộng/Trừ, hộp xem trước số dư Trước/Thay đổi/Sau (cảnh báo số dư âm), bắt buộc xác nhận cho điều chỉnh số dư & khóa tài khoản, tự ẩn mật khẩu tạm sau 60s.
* **Khắc phục lỗi báo "mất mạng" giả (`b3e09b7`, `lila-pwa-v36`):**
  * Thêm `hideConnectionNotice()`, auto-retry 1x cho `GET` khi bị OS ngắt kết nối lúc chuyển app, im lặng với request phụ/tab ẩn, và `sw.js` fallback shell `/`.
* **Hoàn thiện AccessTrade Postback 24/7 (Production):**
  * Cấu hình `POSTBACK_TOKEN` trên Vercel Production & cập nhật Postback URL trên AccessTrade về `https://hoantiensan.online/api/webhooks/accesstrade` (đã test HTTP 200 live & E2E 5 bước).
* **Nâng cấp Trang chủ, Ví, Bảng xếp hạng, Upload Avatar & Admin Dashboard (`4d7a146`, `971d388`, `19303f4`, `c53f2b1`, `3f7fcbd`):**
  * Thêm upload ảnh đại diện có cropper mobile & kiểm tra magic bytes.
  * Nâng cấp UI/UX 4 giai đoạn cho Trang chủ, Ví/Rút tiền, Bảng xếp hạng (Đại Gia LiLa / Vua Hoàn Tiền) và Admin Dashboard.

## 2026-11-26
* **Trải nghiệm Mobile & PWA v2.9 (`b8d7545`, `de767c8`, `d907e75`, `524049f`, `46b2ad7`):**
  * Pin Vercel region sang `sin1` (Singapore), tăng `apiFetch` timeout lên 25s.
  * Thêm Bottom Sheet hướng dẫn cài app iOS (nhận diện Safari, Zalo, Facebook, iPad) và banner cập nhật PWA Mẫu 2.
  * Nâng cấp Tab Đơn hàng khách hàng (3-tier cards, Detail Bottom Sheet, bộ lọc sàn) & Admin Mobile cards.
  * Thêm linh vật **Shiba Companion** tương tác mép dưới màn hình (`951ca71`, `91b8e3d`).
  * Giới hạn trần tỷ lệ nền AddLiveTag Shopee ở `2.5%` và đổi nhãn thành "Hoàn tối đa" (`8d60a7f`).

## 2026-11-25
* **Bảo mật phiên, Audit & CI/CD (`a073c67`, `054665f`, `e229e85`, `4dcdc96`, `2c3a82c`, `731af49`):**
  * Triển khai Rotating Refresh Token đa tab, thu hồi phiên khi Admin đổi MK/khóa/lưu trữ, dọn OTP/phiên hết hạn qua Cron.
  * Chuyển TikTok sang AccessTrade v2 API, chặn link video.
  * Thêm nút con mắt ẩn/hiện mật khẩu cho toàn bộ 16 ô mật khẩu & hộp copy MK/tin Zalo cho Admin (`v20`).
  * Sửa GitHub Actions `verify.yml` (Chromium) và `backup-postgres.yml` (`postgresql-client-18`).
