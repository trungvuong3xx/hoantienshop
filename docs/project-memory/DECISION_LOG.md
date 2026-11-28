# DECISION LOG — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Quy tắc:** Nếu AI Agent đề xuất giải pháp trái với bất kỳ quyết định `Đang hiệu lực` nào dưới đây, AI **phải**: (1) Chỉ rõ sự khác biệt, (2) Giải thích lý do, (3) Phân tích lợi ích & rủi ro, (4) Xin phê duyệt trước khi thay đổi. **Không tự ý đảo ngược quyết định cũ.**

---

## DEC-001 — Giữ tỷ lệ hoàn tiền mặc định 70% + Thuế 10% + VIP 4 hạng (70%–80%)
* **Ngày ghi nhận:** 2026-11-26 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `src/services/dbService.js`, Admin Settings.
* **Nội dung:** Tỷ lệ hoàn mặc định là `70%` sau thuế `10%` (khách nhận `63%` hoa hồng gốc, Admin giữ `27%`). Khách mua nhiều tự động lên hạng VIP (Bạc 73%, Vàng 76%, Kim Cương 80%).
* **Lý do & Phương án đã loại bỏ:** Đã phân tích phương án cạnh tranh 90% sau thuế 11% (Admin chỉ còn `8,9%` hoa hồng gốc $\rightarrow$ biên lợi nhuận quá mỏng). Chủ dự án quyết định giữ **70%** để đảm bảo lợi nhuận vận hành bền vững.
* **Điều kiện thay đổi:** Chỉ đổi khi chủ dự án yêu cầu trực tiếp hoặc tự chỉnh trong Admin Settings.

## DEC-002 — Không lưu/xem mật khẩu dạng plaintext; Admin dùng luồng Cấp lại mật khẩu tạm
* **Ngày ghi nhận:** 2026-11-25 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `src/services/cashbackController.js`, `public/app.js`, `public/index.html`.
* **Nội dung:** Mật khẩu người dùng chỉ lưu dạng hash bất đối xứng (`scrypt`/async hash). Admin không xem được mật khẩu cũ mà dùng chức năng **Cấp lại mật khẩu mới** (kèm tạo ngẫu nhiên, hộp hiển thị tạm tự ẩn sau 60s, nút Copy MK & Copy tin nhắn gửi Zalo) + tự động thu hồi toàn bộ phiên cũ.
* **Phương án đã loại bỏ:** Lưu mật khẩu mã hóa 2 chiều để Admin xem lại (rủi ro bảo mật nghiêm trọng).

## DEC-003 — Không xóa vật lý tài khoản người dùng (Soft-Delete / Lưu trữ)
* **Ngày ghi nhận:** 2026-11-20 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `src/services/dbService.js`, `src/repositories/postgresRepository.js`, `cashbackController.js`.
* **Nội dung:** Hành động `delete` chỉ đặt `isDeleted = true`, `accountLocked = true`, thu hồi phiên, và bảo lưu toàn bộ bản ghi user/order/ledger để đối soát tài chính.

## DEC-004 — TikTok Shop dùng AccessTrade API v2 nghiêm ngặt, không fallback deeplink mù
* **Ngày ghi nhận:** 2026-11-25 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `src/services/tiktokService.js`.
* **Nội dung:** Chặn link Video/Livestream TikTok; gọi AccessTrade TikTok v2 API truyền cả `sub1` & `utm_source`; từ chối nếu `aff_url` trả về thiếu `subId`; không fallback sang deeplink mù khi API v2 lỗi để tránh mất hoa hồng của khách.

## DEC-005 — Pin Vercel Serverless tại Singapore (`sin1`) & tăng `apiFetch` timeout lên 25s
* **Ngày ghi nhận:** 2026-11-26 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `vercel.json`, `public/app.js`.
* **Lý do:** Đặt function sát Neon PostgreSQL tại khu vực Singapore giúp giảm mạnh độ trễ truy vấn và tránh timeout giả trên mạng di động Việt Nam.

## DEC-006 — Gỡ dòng "Giá thực trả sau hoàn" & thống nhất nhãn so sánh giá
* **Ngày ghi nhận:** 2026-11-27 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `public/app.js`, `src/services/compare/*`, `src/services/tiktokCompareService.js`.
* **Nội dung:**
  * Không hiển thị dòng *"Giá thực trả sau hoàn"* trên thẻ kết quả chính và thẻ so sánh (chỉ hiển thị Giá bán + Hoàn tối đa).
  * Không hiển thị dòng hoa hồng gốc nội bộ (`grossCommission`) trên thẻ so sánh public.
  * Thống nhất nhãn so sánh: `TikTok Shop rẻ hơn Xđ`, `Shopee rẻ hơn Xđ`, `Giá tương đương`.

## DEC-007 — Không dùng mã nhúng tự động của AccessTrade (`Coupon embed`, `Product Generation`, `Autolink`)
* **Ngày ghi nhận:** 2026-11-27 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** Tích hợp AccessTrade.
* **Lý do:** Các widget nhúng sẵn dồn toàn bộ click về 1 tài khoản publisher chung, **không gắn được `clickId`/`sub1` riêng cho từng khách hàng LiLa** nên không thể chia hoàn tiền. Nếu làm kho Voucher/Deal Hot về sau, bắt buộc phải lấy dữ liệu qua API để backend LiLa tự gắn mã tracking riêng của từng user.

## DEC-008 — Bố cục Quản lý thành viên (`#userManageModal`): Desktop 2 cột Card, Mobile Bottom Sheet + Accordion
* **Ngày ghi nhận:** 2026-11-27 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `public/index.html`, `public/styles.css`, `public/app.js`.
* **Nội dung:** Desktop (`>= 768px`) dùng modal `860px` chia 2 cột Card cân đối (Trái: Số dư & % Hoàn; Phải: Mật khẩu & Kiểm soát tài khoản); Mobile (`< 768px`) dùng Bottom Sheet `94dvh`, mở sẵn mục Điều chỉnh số dư, 3 mục còn lại dạng Accordion 1 chạm. Mọi thao tác đổi tiền & khóa tài khoản bắt buộc đi qua `askUserConfirm`.

## DEC-009 — Kiến trúc So sánh giá dạng Module (`src/services/compare/*`) giữ Facade `tiktokCompareService.js`
* **Ngày ghi nhận:** 2026-11-27 / 2026-11-28 | **Trạng thái:** `Đang hiệu lực`
* **Phạm vi:** `src/services/tiktokCompareService.js`, `src/services/compare/*`.
* **Nội dung:** Tách chuẩn hóa tiêu đề, từ điển thương hiệu, chấm điểm khớp, cache, circuit breaker và adapters thành các module nhỏ dưới `src/services/compare/`, trong khi giữ `tiktokCompareService.js` làm facade tương thích ngược cho routes & tests.
