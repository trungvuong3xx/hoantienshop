# CHANGELOG — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> Ghi nhận các mốc nâng cấp quan trọng đã triển khai trên nhánh `main`.

---

## 2026-11-27 — 2026-11-28
* **LiLa Analytics — Giai đoạn 3 Cải thiện Frontend & Trải nghiệm Mobile/Desktop (`AN-06`, `AN-08`, `AN-09`, `lila-pwa-v57`):**
  * **`AN-06`:** Thêm `AbortController` + sequence guard chống ghi đè kết quả khi đổi bộ lọc nhanh; bổ sung thanh báo lỗi `#admAnErrorBar` kèm nút **Thử lại** thay vì nuốt lỗi im lặng.
  * **`AN-08`:** Bổ sung phân trang `Trang trước / Trang sau` (kèm `total` & `hasMore` từ server) cho bảng **Thành viên** và **Timeline Modal**; đổi xuất CSV sang `fetch` + `Blob` + `<a download>` (không bị chặn popup).
  * **`AN-09`:** Bổ sung bộ lọc **Hôm qua**, **90 ngày**, **Nguồn truy cập** và **Thiết bị** xuyên suốt Backend/Frontend; chuyển 3 bảng Analytics trên Mobile (`<= 768px`, 320–430px) sang dạng **Card List xếp dọc** không cần cuộn ngang.
* **LiLa Analytics — Giai đoạn 2 Tối ưu Backend, Database & Hiệu suất (`AN-05`, `AN-07`):**
  * **`AN-05`:** Hoàn thiện `rollupDailyAnalytics()` tổng hợp đầy đủ 7 chỉ số (`visitors`, `unique_users`, `sessions`, `page_views`, `raw_clicks`, `valid_clicks`, `affiliate_clicks`) theo ngày giờ VN; nâng cấp `getAnalyticsDailyTrend()` hỗ trợ tới 90 ngày với cơ chế đọc lai (đọc ngày đã chốt từ `analytics_daily_rollups`, đọc ngày hiện tại/chưa chốt từ bảng raw).
  * **`AN-07`:** Thêm cột `last_view` trên `analytics_sessions` (auto-migrate `ADD COLUMN IF NOT EXISTS`) và bỏ hoàn toàn correlated subquery ở `/api/admin/analytics/realtime`; thêm composite index `idx_ae_created_type_valid (created_at DESC, event_type, is_valid)` và L1 RAM cache 30 giây cho `/overview`, `/funnel`, `/trend`.
* **LiLa Analytics — Giai đoạn 1 Sửa lỗi Độ Chính Xác Dữ Liệu (`AN-01` → `AN-04`, `lila-pwa-v56`):**
  * **`AN-01`:** Nâng cấp `upsertSession` cho phép cập nhật `traffic_source` (và `utm_*`, `referrer_host`, `ref_code`, `is_pwa`) từ `direct` lên nguồn thật khi client batch gửi sau server click; rút ngắn initial flush `public/analytics.js` xuống `300ms`.
  * **`AN-02`:** Chèn `analytics_events` trước (`ON CONFLICT DO NOTHING RETURNING`) rồi mới cộng delta vào `analytics_sessions` để chống đếm trùng khi retry; dedup `trackPageView` trong `2s` (chống đếm đôi `home` lúc boot); loại trừ hoàn toàn tài khoản `role === 'admin'` và view `#admin` ở cả Frontend & Backend.
  * **`AN-03`:** Đếm `pageViews` và `clicks` theo nguồn trực tiếp từ `analytics_events.created_at >= cutoff` (hết lệch số liệu khi phiên vắt qua nửa đêm `00:00` VN).
  * **`AN-04`:** Tách rạch ròi `anonymousVisitors` (loại trừ `visitor_id` đã có phiên đăng nhập trong cùng kỳ) ở cả `/overview` và `/realtime`; chuyển `session_id` sang `localStorage` timeout 30 phút để mở nhiều tab vẫn tính 1 Session duy nhất.
  * Mở rộng hồi quy trong `tests/test_analytics_p0.js` (`npm run lint` 0 lỗi, toàn bộ test PASS).
* **Thiết kế lại danh sách Bảng Xếp Hạng từ hạng #4+ (Mẫu A — Premium Compact Leaderboard Card, `lila-pwa-v53`):**
  * Chuyển danh sách `#4+` từ `<table>` sang `<ol class="lb-list">` với mini card phẳng đồng bộ Podium: huy hiệu số hạng tròn, avatar viền theo màu cấp bậc VIP, tên in đậm, pill cấp bậc có icon (mở Bottom Sheet VIP), số tiền căn phải theo màu tab; bỏ số đơn duyệt và thanh kéo `.lb-sheet-notch`, đổi tiêu đề thành `Từ hạng #4`.
  * Tính `aboveRank`, `gapToAbove`, `progressToAbove` ngay tầng server trong `GET /api/leaderboard` kèm lớp bảo vệ riêng tư (trả `null` nếu người hiện tại hoặc người phía trên bật `amountHidden`).
  * Hiển thị thanh tiến trình cạnh tranh (`Còn Xđ để vượt hạng #Y`), nhãn `Sắp vào Top 3` cho hạng `#4`, thẻ nhấn `BẠN` + nút `Mua sắm để vượt #X`, 2 hàng trống nét đứt `#5/#6` khi có 4–5 người, và nút `Xem thêm` phân trang client (8 dòng đầu, +10 mỗi lần bấm).
* **Kiểm toán toàn diện P0 + P1 + P2 & Xác minh Affiliate Attribution (2026-11-28):**
  * Kiểm chứng trực tiếp live redirect HTTP 301/302 và Publisher ID cho cả **Shopee** (`s.shopee.vn/an_redir` $\rightarrow$ `mmp_pid=an_17346310715`) và **TikTok Shop** (AccessTrade v2 `shorten.asia` $\rightarrow$ `go.isclix.com/deep_link/7110811489339796158/6648523843406889655` giữ nguyên `sub1` & `utm_source`).
  * Sửa `BUG-016`: Bổ sung cột `source` và `deal_group` cho bảng `clicks` trên PostgreSQL để giữ trọn attribution cho `compare_sp_to_tt`, `compare_tt_to_sp` và `home_deal_shelf`.
  * Bổ sung `tests/compare/test_affiliate_attribution.js`; xác minh 5 bộ test + `npm run lint` 0 lỗi.
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
