# Thiết Kế Nút Nổi Nhóm Zalo Hỗ Trợ (Floating Zalo Group Button)

- **Ngày tạo:** 2026-11-14
- **Trạng thái:** Đã duyệt bởi người dùng
- **Mục tiêu:** Bổ sung nút liên hệ Zalo dạng nổi cố định ở góc dưới bên phải website Hoàn Tiền Sàn, trỏ trực tiếp đến link nhóm Zalo cộng đồng `https://zalo.me/g/cl2cmiseoqienusnrbyr`, đồng thời hỗ trợ cập nhật linh hoạt qua mục Quản trị hệ thống (Admin Settings).

---

## 1. Bối cảnh & Yêu cầu (Context & Requirements)

### 1.1 Hiện trạng
- Website `Hoàn Tiền Sàn` chưa có nút liên hệ nổi cố định trên màn hình giúp người dùng nhanh chóng tham gia nhóm hỗ trợ/trao đổi.
- Cấu hình hệ thống hiện có trường `settings.supportZalo` (đang lưu số điện thoại hỗ trợ hoặc rỗng).
- Người dùng đã cung cấp đường dẫn nhóm Zalo: `https://zalo.me/g/cl2cmiseoqienusnrbyr` và ảnh mẫu tham khảo cụm nút liên hệ nổi.

### 1.2 Yêu cầu nghiệp vụ
1. Hiển thị nút tròn Zalo nổi bật ở góc dưới bên phải màn hình.
2. Có vòng sóng lan tỏa (*pulse ring*) nhẹ nhàng thu hút sự chú ý.
3. Kèm nhãn phụ chữ *"Nhóm Zalo hỗ trợ"* (tự động thu gọn trên màn hình di động nhỏ để không che khuất giao diện).
4. Khi click: Mở link nhóm Zalo trong tab mới (`target="_blank" rel="noopener noreferrer"`).
5. Tích hợp với cài đặt Admin: Cho phép Quản trị viên thay đổi đường link nhóm Zalo hoặc SĐT bất kỳ lúc nào ngay trên giao diện web.

---

## 2. Thiết kế Giao diện & Trải nghiệm (UI/UX Design)

### 2.1 Vị trí & Bố cục
- **Vị trí:** Cố định góc dưới bên phải màn hình (`bottom: 24px`, `right: 24px`).
- **Z-Index:** `120` (nằm trên nội dung trang web nhưng dưới các modal/dialog hệ thống `z-index: 200+`).
- **Khả năng tương thích Mobile & PWA:**
  - Trên màn hình di động (`max-width: 480px`), vị trí là `bottom: 20px`, `right: 16px`.
  - Tự động điều chỉnh khoảng cách hợp lý để không xung đột với banner cài đặt PWA hoặc thanh điều hướng trình duyệt di động (`env(safe-area-inset-bottom)`).

### 2.2 Thành phần giao diện (Component Specification)
```html
<aside id="floatingZaloWidget" class="floating-zalo-widget" aria-label="Hỗ trợ Zalo">
  <a
    id="floatingZaloLink"
    href="https://zalo.me/g/cl2cmiseoqienusnrbyr"
    target="_blank"
    rel="noopener noreferrer"
    class="floating-zalo-btn"
    title="Tham gia nhóm Zalo hỗ trợ"
    aria-label="Tham gia nhóm Zalo hỗ trợ"
  >
    <span class="zalo-pulse-ring" aria-hidden="true"></span>
    <span class="zalo-icon-wrap" aria-hidden="true">
      <svg class="zalo-svg-icon" viewBox="0 0 48 48" width="28" height="28" fill="none">
        <!-- Zalo official logo vector -->
      </svg>
    </span>
    <span class="zalo-label-text">Nhóm Zalo hỗ trợ</span>
  </a>
</aside>
```

### 2.3 Hiệu ứng chuyển động (Animation & Motion)
- **Pulse Ring:** Vòng tròn sóng nước hiệu ứng lan tỏa mở rộng từ 100% đến 145%, mờ dần theo chu kỳ 2s.
- **Hover/Active:** Khi hover trên desktop, nút phóng to nhẹ (`transform: scale(1.05)`). Khi nhấn trên mobile, nút lún nhẹ (`transform: scale(0.96)`).
- **Trợ năng (Accessibility):** Tôn trọng cấu hình `@media (prefers-reduced-motion: reduce)`, tắt hiệu ứng pulse khi người dùng bật giảm chuyển động.

---

## 3. Luồng dữ liệu & Cấu hình Quản trị (Data Flow & Admin Settings)

### 3.1 Nguồn dữ liệu & Link mặc định
- Hằng số mặc định trong mã nguồn:
  `const DEFAULT_ZALO_GROUP_URL = 'https://zalo.me/g/cl2cmiseoqienusnrbyr';`
- Trường lưu trữ: `settings.supportZalo` trong database (`data/db.json` / Postgres).

### 3.2 Bộ chuẩn hóa đường dẫn thông minh (URL Normalizer)
Khi tải cấu hình trang (hàm `applyPublicSettings` / `initApp` trong `public/app.js`):
1. Đọc giá trị `rawVal = settings.supportZalo?.trim()`.
2. Kiểm tra định dạng:
   - Nếu `rawVal` bắt đầu bằng `http://` hoặc `https://`: Sử dụng trực tiếp `rawVal`.
   - Nếu `rawVal` là số điện thoại (ví dụ: `0329992448`): Chuẩn hóa thành `https://zalo.me/0329992448`.
   - Nếu `rawVal` rỗng hoặc không hợp lệ: Sử dụng `DEFAULT_ZALO_GROUP_URL`.
3. Gán URL đã chuẩn hóa vào thuộc tính `href` của `#floatingZaloLink`.

### 3.3 Giao diện Quản trị (Admin Panel)
- Trong `public/index.html` (Tab Cài đặt chung của Quản trị viên):
  - Cập nhật nhãn: `<label for="admSupportZalo">Link Nhóm Zalo / SĐT Hỗ Trợ</label>`
  - Cập nhật placeholder: `placeholder="https://zalo.me/g/... hoặc SĐT hỗ trợ"`
- Khi Admin nhấn "Lưu Cài Đặt", API `/api/admin/settings` lưu giá trị và frontend lập tức cập nhật lại `href` của nút Zalo nổi mà không cần tải lại toàn bộ trang.

---

## 4. Xử lý Ngoại lệ & Trường hợp đặc biệt (Edge Cases)

| Tình huống | Cách xử lý |
|---|---|
| Admin để trống trường cài đặt | Tự động fallback về link nhóm mặc định `https://zalo.me/g/cl2cmiseoqienusnrbyr` |
| Link nhập vào chứa khoảng trắng thừa | Sử dụng `.trim()` trước khi xử lý |
| Người dùng bấm vào nút trên Mobile | Mở ứng dụng Zalo (nếu đã cài đặt) hoặc trang web nhóm Zalo trong trình duyệt |
| Banner PWA xuất hiện | Nút Zalo có vị trí và z-index độc lập, không bị che khuất |
| Trình duyệt không hỗ trợ SVG | Kèm fallback chữ và aria-label đầy đủ |

---

## 5. Kế hoạch Kiểm thử (Testing Plan)

1. **Kiểm tra Giao diện (Visual & Responsive):**
   - Kiểm tra nút hiển thị chuẩn trên màn hình máy tính (hiện cả icon và chữ "Nhóm Zalo hỗ trợ").
   - Kiểm tra nút hiển thị gọn gàng trên màn hình điện thoại (chỉ hiển thị icon tròn và hiệu ứng sóng).
2. **Kiểm tra Tương tác (Interaction):**
   - Click nút trên trang chủ -> Xác nhận mở đúng tab mới trỏ tới `https://zalo.me/g/cl2cmiseoqienusnrbyr`.
3. **Kiểm tra Cấu hình Quản trị (Admin Settings Verification):**
   - Thay đổi giá trị trong Admin sang số điện thoại khác -> Kiểm tra nút cập nhật thành link cá nhân `https://zalo.me/...`.
   - Thay đổi giá trị thành link nhóm Zalo mới -> Kiểm tra nút cập nhật link nhóm mới.
   - Để trống và lưu -> Kiểm tra nút tự khôi phục về link nhóm mặc định.
4. **Kiểm tra Hồi quy (Regression Testing):**
   - Chạy toàn bộ test suites (`npm test`) để đảm bảo không làm gãy các chức năng hiện tại của hệ thống.
