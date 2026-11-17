# Shopee CSV: kết quả nhập khi gián đoạn

Theo lựa chọn của người dùng, ưu tiên hoàn thiện Shopee; tạm gác RioHub khi chưa có creator/key/contract chi tiết.

## Thay đổi

- Hiển thị bảng kết quả ngay trong khu vực quản trị thay vì chỉ toast tự biến mất.
- Theo dõi số đơn được server xác nhận, lỗi đối soát, số đơn ở lô chưa rõ kết quả và số đơn chưa gửi.
- Phân biệt lỗi đọc/kiểm tra file, lỗi truyền lô và lỗi tải lại dashboard sau nhập. Không gọi mất mạng là lỗi đọc CSV.
- Kiểm tra tính đầy đủ của phản hồi trước khi đánh dấu một lô đã xác nhận.
- Hiển thị toàn bộ lỗi bằng textContent, không render thông báo từ API thành HTML.
- Khi mất phản hồi: hướng dẫn chọn lại đúng nội dung và tên file để đối soát. Không tự giả định server chưa ghi; không tự hoàn tác tiền hoặc gửi lại âm thầm.

Không thay đổi schema, API, công thức tiền hoặc nghiệp vụ import. Đây chưa phải import job bền vững trên server: bảng tiến độ không tồn tại qua reload; file vẫn chia lô 500 đơn và không atomic toàn file.

## Kiểm thử thực tế

`npm run test:csv:browser`: PASS, dùng server/database fixture riêng và trình duyệt headless.

Ca mới: 501 đơn approved, hoa hồng 10.000đ mỗi đơn. Lô 500 thành công; lô cuối được server xử lý nhưng phản hồi bị chặn. UI ghi 500 đơn đã xác nhận và 1 đơn chưa rõ kết quả. Database đã có đủ 501 đơn mới, số dư fixture 3.156.300đ. Chọn lại nguyên file: số đơn, số dư và số bút toán giữ nguyên. Các ca CSV trước đó vẫn PASS.

Thay đổi chỉ sửa phần CSV trong app.js và bổ sung bài kiểm thử. Không ghi dữ liệu production. Chưa phát hành đợt này vì checkout có thêm thay đổi ngoài CSV cần được tách hoặc rà soát trước khi upload toàn bộ.
