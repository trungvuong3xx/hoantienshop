# BUSINESS RULES — LiLa Cashback

> **Cập nhật lần cuối:** 2026-11-28  
> **Nguồn xác minh:** `src/services/dbService.js`, `src/services/cashbackController.js`, `src/services/tiktokService.js`, `src/services/shopeeService.js`, `src/services/compare/*`, `src/services/avatarStorageService.js`.  
> **Cảnh báo:** Không được tự ý thay đổi bất kỳ công thức tài chính, tỷ lệ mặc định hay quy tắc khóa/lưu trữ nào dưới đây nếu chưa được chủ dự án phê duyệt.

---

## 1. Công thức Cashback & Tỷ lệ hoàn tiền (BẤT BIẾN)
* **Hàm nguồn:** `calculateCommissionSplit(grossCommission, cashbackPercent, taxDeductPercent)` trong `src/services/dbService.js`.
* **Công thức 2 tầng:**
  1. `taxAmount = Math.round((gross * taxRate) / 100)` *(mặc định `taxDeductPercent = 10%`, giới hạn an toàn `0–50%`)*.
  2. `netCommission = Math.max(0, gross - taxAmount)`.
  3. `userCashbackAmount = Math.round((netCommission * cbRate) / 100)` *(mặc định `cashbackPercent = 70%`)*.
  4. `adminShareAmount = Math.max(0, netCommission - userCashbackAmount)`.
* **Thứ tự ưu tiên xác định `%` hoàn tiền của User (`resolveUserCashbackRate`):**
  1. **Tỷ lệ riêng của thành viên (`user.customCashbackPercent`):** Ghi đè hoàn toàn hệ thống (Admin cài thủ công, chỉ áp dụng cho đơn phát sinh mới, không hồi tố đơn cũ).
  2. **Hạng VIP (`vipTiersEnabled !== false`):** Tự động nâng hạng theo tổng chi tiêu đơn `approved`:
     * 🥉 `bronze` (Thành viên Đồng): `>= 0đ` $\rightarrow$ **70%**
     * 🥈 `silver` (Thành viên Bạc): `>= 2.000.000đ` $\rightarrow$ **73%**
     * 🥇 `gold` (Thành viên Vàng): `>= 6.000.000đ` $\rightarrow$ **76%**
     * 💎 `diamond` (Thành viên Kim Cương): `>= 15.000.000đ` $\rightarrow$ **80%**
  3. **Mặc định toàn sàn:** `db.settings.cashbackPercent` (mặc định **70%** — chủ dự án đã chốt giữ 70%, không nâng lên 90%).
* **Ước tính hoàn tiền trên thẻ kết quả Shopee:** Tỷ lệ nền AddLiveTag được giới hạn trần **2.5%** (`8d60a7f`) và nhãn hiển thị là **"Hoàn tối đa"** (không hiển thị dòng "Giá thực trả sau hoàn" trên thẻ kết quả & thẻ so sánh — đã gỡ theo yêu cầu `b3e09b7`).

## 2. Sổ cái (Ledger), Ví & Rút tiền
* **Nguyên tắc sổ cái:** Mọi biến động số dư (`balanceAvailable`, `balancePending`, `totalEarned`) được tính lại từ sổ cái `ledger` thông qua `recalculateUserWallet()` dưới khóa tuần tự `withUserLock(userId)` — **tuyệt đối không cộng/trừ số dư trực tiếp bỏ qua ledger**.
* **Đơn hàng & Chuyển trạng thái:**
  * `pending` $\rightarrow$ cộng vào `balancePending` (chờ duyệt).
  * `approved` $\rightarrow$ chuyển sang `balanceAvailable` (khả dụng rút được) + ghi nhận `ledger` + xét tự động nâng hạng VIP & thưởng giới thiệu đơn đầu.
  * `cancelled` / `rejected` $\rightarrow$ không cộng tiền; nếu trước đó đã `approved` thì đối soát thu hồi qua bút toán bù trừ.
* **Điều chỉnh số dư thủ công (Admin):**
  * Ghi bút toán `admin_adjustment` vào `ledger` + ghi `recordAuditLog`.
  * Trên UI Admin (`#userManageModal`), **bắt buộc có hộp preview Trước $\rightarrow$ Sau và hộp thoại xác nhận `askUserConfirm`** trước khi gửi API.
* **Rút tiền (`withdrawalRepository.js` & `cashbackController.js`):**
  * Mức rút tối thiểu mặc định: `minWithdrawAmount = 50.000đ` (cấu hình trong Admin).
  * Khấu trừ nguyên tử (`executeAtomicWithdrawal`) chống race-condition / double-withdraw.
  * Hỗ trợ tạo mã QR thanh toán qua **VietQR** cho Admin duyệt chuyển khoản.

## 3. Affiliate Tracking & Đối soát đơn hàng
* **Shopee Affiliate (`shopeeService.js`, `converterService.js`):**
  * Hỗ trợ 2 chế độ: `an_redir` (Universal Redirect gắn `sub_id = clickId`) và `openapi` (Shopee Open API GraphQL).
  * Nhập đơn qua CSV Shopee (`csvImport.js` / `/api/admin/import-csv`) hỗ trợ trạng thái `pending` & hoa hồng thập phân, hoặc đồng bộ tự động qua Shopee Open API + Vercel Cron (`0 3 * * *` UTC).
  * URL sản phẩm Shopee có dấu ngoặc cân bằng `()`/`[]` phải được giữ nguyên khi bóc tách (`cf00347`).
* **TikTok Shop Affiliate (`tiktokService.js`):**
  * Sử dụng **AccessTrade TikTok Shop API v2** (`/v2/tiktokshop_product_feeds/create_link`), truyền đồng thời `sub1 = clickId` và `utm_source = clickId`.
  * **Chặn link Video/Nội dung:** Nếu khách dán link Video/Livestream TikTok, hệ thống từ chối và hướng dẫn lấy link trang chi tiết sản phẩm.
  * **Không fallback sang deeplink mù** khi API v2 lỗi (`054665f`) và từ chối link trả về nếu `aff_url` thiếu `subId` (chống mất đơn).
  * **Nhận đơn 2 lớp:**
    1. Real-time qua AccessTrade Postback (`GET/POST /api/webhooks/accesstrade?token=...&order_id={order_id}&sub1={sub1}&...`) xác thực bằng `POSTBACK_TOKEN`. Ping test có `{order_id}` trả `200 { status: 'ok', testPing: true }` không ghi DB.
    2. Đồng bộ bù qua AccessTrade Publisher API (`/v1/orders`, 30 ngày gần nhất) qua Cron / mở Ví / nút Sync Admin.

## 4. So sánh giá 2 chiều Shopee $\leftrightarrow$ TikTok Shop
* **Kiến trúc:** Facade `src/services/tiktokCompareService.js` $\rightarrow$ Động cơ module `src/services/compare/*`.
* **Quy tắc khớp sản phẩm nghiêm ngặt:**
  * Tự chuẩn hóa từ lách kiểm duyệt TikTok (`N. ú.m` $\rightarrow$ `Núm`) **chỉ trên chuỗi tìm kiếm/chấm điểm**, tuyệt đối không đụng vào URL/Product ID Affiliate.
  * Bắt buộc khớp đơn vị/dung tích/combo (`compareUnits`): từ chối đơn lẻ vs combo, hoặc sai số lượng/dung tích (VD: 50ml vs 15ml).
  * **Brand Gate:** Nếu sản phẩm nguồn có tên thương hiệu đặc trưng (`Greenfinger`, `Bebegrow`, `La Roche Posay`...), ứng viên phải khớp thương hiệu.
  * Không trả về `productLink` thô hay `grossCommission` / biên lợi nhuận nội bộ ra public frontend (`f90f086`).
  * Nhãn so sánh thống nhất: **`TikTok Shop rẻ hơn Xđ`**, **`Shopee rẻ hơn Xđ`**, **`Giá tương đương`** (`2c4192a`).

## 5. Giới thiệu bạn bè (Referral)
* Thưởng cố định đơn đầu mặc định: `referralBountyAmount = 10.000đ` (cấu hình trong Admin `0–1.000.000đ`).
* Điều kiện: Người được mời đăng ký qua link/mã giới thiệu và có **đơn hàng đầu tiên đạt trạng thái `approved`** $\rightarrow$ hệ thống tự cộng thưởng vào ví người giới thiệu qua `ledger`.

## 6. Bảng xếp hạng (Đại Gia LiLa & Vua Hoàn Tiền)
* **2 chế độ vinh danh:**
  * **Đại Gia LiLa (`spend`):** Xếp hạng theo tổng giá trị đơn hàng `approved`.
  * **Vua Hoàn Tiền (`cashback`):** Xếp hạng theo tổng tiền hoàn `approved` (Top 1 nhận huy hiệu `cashback_king`).
* **Quy tắc hiển thị & riêng tư:**
  * Loại trừ tài khoản `isDeleted`, `accountLocked`, `role === 'admin'`, hoặc user bật `hideFromLeaderboard`.
  * Ẩn thông tin nhạy cảm (`maskLeaderboardDisplay`) nếu tên giống SĐT/email.
  * Hỗ trợ chế độ mùa giải: `all_time`, `weekly`, `monthly`, `yearly` + lưu snapshot xếp hạng để tính `rankDelta` (tối đa 7 ngày).

## 7. Xác thực, Phiên đăng nhập & Quản lý thành viên
* **Chính sách phiên (`getSessionPolicy`):**
  * **User thường:** Access token 1 giờ; Refresh token trượt 30 ngày (tối đa 90 ngày).
  * **Admin:** Access token 30 phút; Refresh token trượt 7 ngày (tối đa 14 ngày).
  * Cơ chế xoay vòng Refresh Token (`rotateRefreshSession`) có `REFRESH_MULTI_TAB_GRACE_MS = 15s` để tránh xung đột đa tab.
* **Quên mật khẩu OTP:** Gửi qua Resend API; nếu mail lỗi trả `503 MAIL_DELIVERY_FAILED` kèm hướng dẫn nhắn Zalo CSKH. Bản ghi OTP/phiên hết hạn được dọn tự động trong `/api/cron/sync-shopee` (`pruneExpiredAuthRecords`).
* **Bảo mật Admin (`POST /api/admin/users/action`):**
  * **Không bao giờ lưu/xem mật khẩu cũ dạng plaintext.** Admin chỉ cấp lại mật khẩu mới $\rightarrow$ lập tức thu hồi toàn bộ phiên cũ (`revokeUserSessions`).
  * **Khóa tài khoản (`toggle_lock`):** Chặn đăng nhập & rút tiền, thu hồi phiên cũ, có thể mở khóa lại (bắt buộc `askUserConfirm`).
  * **Lưu trữ tài khoản (`delete` / soft-delete):** Đặt `isDeleted = true`, `accountLocked = true`, thu hồi phiên cũ; **không bao giờ xóa vật lý** bản ghi người dùng để bảo toàn đối soát đơn hàng/sổ cái. Không cho phép xóa tài khoản `role === 'admin'`.
* **Upload Avatar (`avatarStorageService.js`):** Kiểm tra **magic bytes** thực tế — chỉ chấp nhận `JPEG`, `PNG`, `WEBP`, giới hạn cứng `2 MB` trên server (từ chối SVG/HTML/GIF).
* **Thông báo (`notificationService.js`):** Chuông thông báo cá nhân (đơn mới/duyệt/hủy, rút tiền, nâng hạng VIP) + Admin gửi Thông báo toàn sàn (Broadcast, có rate-limit).
