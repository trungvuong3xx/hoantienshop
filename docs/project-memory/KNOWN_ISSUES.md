# KNOWN ISSUES & WATCHLIST — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> Ghi nhận các hạn chế hiện tại, vấn đề đang chờ xử lý và thông tin chưa xác minh (`[Chưa xác minh]`).

---

## 1. Hạn chế kỹ thuật & Điểm cần theo dõi
1. **Kích thước file Frontend lớn (`public/app.js` ~7.500 dòng, `public/styles.css` ~9.500 dòng):**
   * *Rủi ro:* Dễ phát sinh xung đột selector hoặc sửa sót khi nhiều AI Agent cùng chỉnh sửa.
   * *Biện pháp:* Luôn tìm kiếm chính xác trước khi sửa, dùng tiền tố class riêng theo component (VD: `.um-*`, `.tt-compare-*`), và bắt buộc chạy `npm run lint` + Playwright E2E sau khi sửa.
2. **File untracked trong workspace local (`public/videos/`, `tools/video_build/`):**
   * *Trạng thái:* Đang tồn tại ở máy local nhưng chưa đưa vào Git.
   * *Lưu ý:* Không dùng `git add -A` bừa bãi để tránh đẩy nhầm file video dung lượng lớn lên repository.
3. **Đồng bộ đơn thật đầu tiên qua AccessTrade Postback trên Production:**
   * *Trạng thái:* Đã kiểm thử ping test thật `200 OK` trên `https://hoantiensan.online` và E2E 5 bước cục bộ, nhưng **chưa có đơn hàng TikTok Shop thật phát sinh sau thời điểm sửa Postback** (Log AccessTrade trước đó trống).
   * *Cần theo dõi:* Kiểm tra tab `Lịch sử Postback` trên AccessTrade sau khi có đơn TikTok Shop thật đầu tiên để xác nhận nâng trạng thái `BUG-011` và đối soát `sub1` thực tế.
4. **Phạm vi chiến dịch Postback AccessTrade hiện tại:**
   * Hiện cấu hình trên AccessTrade (`/tool/post_back`) đang chọn duy nhất chiến dịch **`TIKTOK SHOP CPS`**. Nếu sau này mở rộng thêm chiến dịch khác trên AccessTrade (Shopee AT, Lazada...) thì cần bổ sung trong mục Campaign của AccessTrade.
5. **Theme hệ thống (Single Light Theme):**
   * Hiện LiLa chỉ có 1 Light Theme định nghĩa qua `:root` trong `public/styles.css`. Một số khối cũ ngoài `#userManageModal` vẫn còn mã màu hex cứng; nếu sau này bổ sung Dark Mode cần rà soát lại toàn bộ các khối cũ.

## 2. Thông tin chưa xác minh `[Chưa xác minh]`
* `[Chưa xác minh]` **Giá trị thực tế của các biến môi trường trên Vercel Dashboard** ngoài `POSTBACK_TOKEN`, `CRON_SECRET`, `DATABASE_URL` (vì agent không có quyền đọc secret trực tiếp trên Vercel — chỉ xác minh qua hành vi endpoint như `/api/health`, `/api/cron/sync-shopee`, `/api/webhooks/accesstrade`).
* `[Chưa xác minh]` **Hạn mức gói cước hiện tại (quota/billing tier)** của Neon PostgreSQL, Upstash Redis, Resend và Vercel Blob/Supabase Storage.
* `[Chưa xác minh]` **Chi tiết nguồn ảnh Avatar trên Production** (đang dùng Vercel Blob, Supabase Storage hay fallback Postgres — phụ thuộc biến nào được điền trên Vercel).
* `[Chưa xác minh]` **Lịch sử hoạt động thực tế của các file tài liệu kiểm toán cũ trong `docs/`** (từ 2026-11-16 đến 2026-11-21): được giữ nguyên làm tư liệu lịch sử, không xóa, nhưng nhiều hạng mục trong đó đã được khắc phục qua các đợt nâng cấp 2026-11-23 $\rightarrow$ 2026-11-28.
