# Kế hoạch tối ưu admin trên điện thoại — 17/11/2026

## Phạm vi và bằng chứng

Đọc source hiện tại và render bằng Edge/Playwright ở 360×800, 390×800, 430×800 với dữ liệu giả. Dùng static server, mock public-config; gọi các hàm render hiện có để kiểm tra bố cục. Không đăng nhập backend, không sửa dữ liệu thật, không xác minh giao dịch hoặc quyền truy cập. Popup được mở để đo layout, không phải kiểm thử hoàn chỉnh luồng thao tác. Chưa thử Safari, bàn phím thật hoặc điện thoại thật. Chưa sửa mã ứng dụng.

Script tái lập: `node docs/admin-mobile-audit.cjs`. Ảnh và số đo: `docs/admin-mobile-audit/`.

## Vấn đề theo ưu tiên

| Mức | Vị trí | Bằng chứng / tác động | Hướng xử lý |
|---|---|---|---|
| P1 | public/index.html:1452; public/selectPopup.css:2 | Ô manageAdjustAmount chỉ rộng 26 px trên cả ba viewport. Select được thay bằng nút width:100% trong hàng flex không wrap, lấn ô nhập tiền. | Sửa kích thước trigger theo container; chuyển nhóm loại điều chỉnh / số tiền thành một cột trên mobile. Label riêng, inputmode phù hợp, hiển thị số tiền đã định dạng và số dư dự kiến. Kiểm tra toàn bộ select thay thế ở các form khác. |
| P1 | public/index.html:1107,1157,1199; public/app.js:2084,2136,2224 | Tại 360 px, vùng bảng 306 px nhưng nội dung đơn hàng 787 px, rút tiền 686 px, thành viên 559 px. Thông tin và nút xử lý bị chia ra nhiều vùng kéo ngang. | Mobile dùng thẻ; desktop giữ bảng. Dùng chung dữ liệu, phân trang và handler nghiệp vụ để tránh lệch hành vi. |
| P1 | public/index.html:893–979; public/styles.css:3829 | Thanh tab ở y=764 px tại viewport 360×800 trong fixture, bị cạnh tranh không gian bởi bottom nav. Dải tab rộng 766 px trong vùng 334 px, scrollbar ẩn. | Header gọn, KPI 2×2 hoặc thu gọn; đưa tab lên trước thống kê. Bốn nhãn ngắn Đơn / Rút tiền / Khách / Cài đặt, hiển thị đủ, sticky dưới header. |
| P2 | public/app.js:2098–2113,2232–2257 | Một hàng đặt nhiều hành động duyệt, hủy, sửa, xóa; QR và xác nhận đã chuyển nằm ở các cột khác nhau. | Mỗi thẻ có một hành động chính và Chi tiết; thao tác hủy/xóa/lưu trữ trong menu phụ. Giữ xác nhận hiện có, bổ sung ngữ cảnh người nhận, mã đơn, số tiền. |
| P2 | public/styles.css:3847; public/index.html:1092,1142,1190 | Tab cao 36–40 px; tìm kiếm/lọc/tìm tách nhiều hàng trên mobile. | Mục tiêu vùng chạm tối thiểu 44×44 px; tìm kiếm toàn chiều rộng, Enter để tìm; chip trạng thái thường dùng, bộ lọc phụ trong sheet. Không tự tìm mỗi phím nếu chưa có debounce. |
| P2 | public/index.html:1225–1407; public/styles.css:4161 | Cài đặt là nhiều form nối tiếp và thanh lưu ở cuối, không sticky. | Nhóm thu gọn theo chức năng, báo có thay đổi chưa lưu, thanh lưu dễ tiếp cận và không che nội dung/bottom nav; thông báo rõ kết quả. Không đổi ngữ nghĩa lưu backend khi chỉ thay bố cục. |
| P2 | public/app.js:2128,2275 | Badge đơn hàng/rút tiền hiển thị trực tiếp pending, approved, paid... | Map nhãn tiếng Việt nhất quán, giữ nguyên enum API. Trạng thái phải có chữ, không chỉ màu. |

Không phát hiện tràn ngang toàn trang ở ba viewport. Hai popup kiểm tra cũng không tràn khung; điều này không đồng nghĩa mọi ô nhập bên trong đều dùng được.

## Bố cục đề xuất

1. Header một hàng: Quản trị, trạng thái kết nối ngắn, Làm mới; đồng bộ và dọn dữ liệu đưa vào menu công cụ.
2. Điều hướng bốn mục ngay dưới header. Giữ bottom nav hiện có trong đợt đầu, tránh thêm thanh cố định thứ ba; cân nhắc chế độ quản trị riêng sau khi thử sử dụng.
3. KPI 2×2 gọn, có thể thu gọn; ưu tiên số việc cần xử lý nếu API cung cấp đủ số đếm chính xác.
4. Tìm kiếm, trạng thái lọc đang áp dụng, danh sách thẻ và phân trang.
5. Công cụ nhập CSV, thêm đơn và tin nhắn TikTok đưa vào nhóm Công cụ thu gọn, tránh chiếm chỗ trước danh sách mặc định.

Thẻ đơn: mã đơn + sàn; khách + ngày; tên sản phẩm tối đa hai dòng; số tiền hoàn nổi bật; trạng thái; Chi tiết / Duyệt nếu còn chờ. Chi tiết chứa hoa hồng đầy đủ và các hành động phụ.

Thẻ rút tiền: khách, số tiền, trạng thái; ngân hàng / STK / chủ tài khoản cùng một khối; sao chép từng trường; mở QR. Trên cùng điện thoại, bổ sung lưu/chia sẻ QR nếu được hỗ trợ và luôn có sao chép thông tin dự phòng. Đã chuyển là xác nhận thủ công, không tự coi mở QR là thanh toán thành công.

Thẻ khách: tên + mã + điện thoại; số dư khả dụng/chờ; trạng thái; Quản lý. Popup quản lý tách nhóm mật khẩu, điều chỉnh tiền, tài khoản; ô lý do và tiền toàn chiều rộng. Thao tác xóa và đặt số dư về 0 tách khỏi thao tác thường dùng.

## Thứ tự triển khai

1. **Đợt 1 — Gỡ điểm nghẽn:** sửa ô tiền và select trigger; header/KPI/tab; vùng chạm; nhãn trạng thái. Kiểm tra desktop không bị ảnh hưởng.
2. **Đợt 2 — Luồng hằng ngày:** thẻ rút tiền trước, rồi đơn hàng, thành viên; chi tiết và menu hành động; giữ bộ lọc, trang và vị trí cuộn sau thao tác; cập nhật trạng thái tại chỗ theo phản hồi server.
3. **Đợt 3 — Hoàn thiện:** popup nhập liệu, nhóm cài đặt, thanh lưu, công cụ CSV/TikTok; trạng thái đang tải/rỗng/lỗi/thử lại. Với thao tác tài chính mất phản hồi, kiểm tra trạng thái hiện tại trước khi cho gửi lại, không chỉ báo thất bại chung chung.
4. **Đợt 4 — Nghiệm thu:** kiểm tra tự động bố cục và luồng quan trọng trên fixture, rồi Android Chrome và iPhone Safari thật.

## Tiêu chí nghiệm thu

- 360/390/430 px: không kéo ngang để đọc thông tin chính hoặc xử lý một mục; thêm 320 px làm kiểm tra biên.
- Bốn mục quản trị nhìn thấy khi mở màn hình, không cần vuốt ngang tìm mục.
- Vùng chạm chính ít nhất 44×44 px; ô số tiền đủ đọc tối thiểu 12 chữ số, kiểm tra với dữ liệu dài và font phóng lớn.
- Khi bàn phím mở, ô đang nhập và hành động tiếp theo vẫn tới được; popup cuộn độc lập, nút đóng luôn dễ tìm, giữ focus hợp lý.
- Không che nội dung bởi sticky header/footer hoặc vùng an toàn iPhone; kiểm tra cả xoay ngang.
- Từ danh sách tìm được thông tin nhận tiền và nút sao chép trong tối đa hai thao tác; xác nhận tiền vẫn hiển thị đủ người nhận và số tiền.
- Thử không có dữ liệu, nhiều trang, tên/mã rất dài, số dư lớn, tải chậm, mất mạng, nhấn hai lần và lỗi API. Không mất bộ lọc khi xử lý xong.
- Regression desktop 1280/1440 px và các luồng duyệt đơn, điều chỉnh số dư, rút tiền, lưu cấu hình, nhập CSV. Kiểm tra API/ledger riêng khi có thay đổi nghiệp vụ; UI audit này chưa xác minh chúng.
