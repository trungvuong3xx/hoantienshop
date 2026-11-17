# Admin mobile — kết quả triển khai

## Đã thay đổi

- Thêm `public/adminMobile.js` và `public/adminMobile.css`, nạp sau các thành phần hiện có. Dùng chung DOM bảng, ID và event delegation để giao diện mobile không tạo thêm bản sao nút hoặc luồng API.
- Đưa điều hướng bốn mục lên trước KPI; nhãn ngắn; tab sticky; KPI 2×2. Đồng bộ và kiểm tra dữ liệu thử chuyển vào Công cụ. Các công cụ CSV/TikTok vẫn giữ chức năng, nằm sau danh sách.
- Ba bảng hiển thị dạng thẻ có nhãn trường trên mobile; desktop giữ bảng và tất cả hành động. Hành động phụ nằm trong nhóm mở rộng trên mobile, tự mở khi chuyển về desktop.
- Popup điều chỉnh số dư có label rõ, nhập tiền toàn chiều rộng và xem trước cộng/trừ, số dư dự kiến khi có dữ liệu người dùng. Bộ chọn tiếp tục sử dụng select gốc.
- Thêm sao chép STK, tên trạng thái tiếng Việt và thông tin người nhận/số tiền trong xác nhận rút tiền.
- Cài đặt chia nhóm thu gọn, thông báo chưa lưu, thanh lưu sticky. Làm mới dashboard không ghi đè form đang sửa; giữ lại bộ lọc và trang đã chọn bằng cách tải lại danh sách tương ứng.

## Kiểm tra

- `npm test`: 25/25 suites đạt.
- `npm run lint`: đạt.
- `node tests/csv-import.e2e.js`: đạt, gồm nhập 501 dòng, mất phản hồi và thử lại.
- `node docs/admin-mobile-audit.cjs`: kiểm tra 320, 360, 390, 430 và 1440 px; tab, bảng/thẻ, popup, vùng chạm mobile, nhập 12 chữ số, bộ chọn cộng/trừ, mở sửa đơn và quản lý khách, xác nhận rút tiền có STK, cờ chưa lưu và lỗi JavaScript.
- Ở 360 px: vùng nội dung danh sách 306 px và scrollWidth 306 px; tab y=254 thay vì 764 px trong fixture ban đầu; ô tiền rộng 326 thay vì 26 px.

Ảnh và số đo mới nhất nằm trong `docs/admin-mobile-audit/`; chúng đã được cập nhật sau triển khai, không còn là ảnh trước thay đổi. Các số đo trước thay đổi được ghi trong kế hoạch.

## Giới hạn xác minh

Chạy trong Edge/Chromium giả lập với dữ liệu local/fixture, không xác nhận trên điện thoại thật hoặc Safari; chưa kiểm tra bàn phím hệ điều hành thật. Chưa deploy production. Chưa bổ sung chia sẻ/lưu QR qua hệ điều hành; hiện có QR và sao chép STK. Luồng API tài chính và cách xử lý phản hồi mất mạng không được thiết kế lại trong thay đổi trình bày này. Hành vi mất mạng của toàn bộ thao tác quản trị cần vòng kiểm tra riêng trước khi khẳng định đạt toàn bộ tiêu chí kế hoạch.
