# Khắc phục đợt 1 sau final audit

Phạm vi được phê duyệt: C01 (gửi rút trùng), H01 (mật khẩu lần rút đầu), C02 (script xóa dữ liệu). Không thay công thức cashback, số dư hoặc schema database. Chưa deploy production.

## Thay đổi

- Form rút tiền chỉ có một handler submit, dùng chung cho click và Enter. Cờ đang gửi và nút disabled được đặt trước khi mở modal; cancel/lỗi/thành công đều giải phóng cờ qua finally.
- Cùng người dùng và cùng thông tin nhận tiền/số tiền giữ cùng idempotency key trong sessionStorage khi chưa nhận kết quả thành công. Retry sau HTTP/network error hoặc reload trong cùng tab dùng lại key. Password không được lưu.
- Retry một yêu cầu chưa xác nhận không bị số dư mới thấp hơn chặn ở frontend: backend vẫn kiểm tra key và số dư thật. Điều này xử lý trường hợp lệnh đã commit nhưng response bị mất.
- Chỉ bỏ key sau khi có response chứa withdrawal.id. Không gửi nếu không lưu được trạng thái chống trùng. Kiểm tra lại danh tính sau modal để không tiếp tục gửi khi đã đăng xuất/đổi người dùng trong trang.
- Hiện và đặt required cho password khi chưa có STK đã lưu hoặc STK mới khác; đồng bộ lại khi tải dashboard và khi sửa input. Backend vẫn giữ nguyên kiểm tra password.
- `scripts/clean_test_data.js` chỉ in thông báo DISABLED và exit code 1; không import server/pg, không đọc .env và không kết nối database.

## Kiểm thử

- `npm test`: 21/21 suite đạt.
- `npm run test:postgres`: 19 kịch bản đạt trên PostgreSQL localhost riêng.
- `node tests/withdrawal-ui.e2e.js`: browser suite mới đạt:
  - Ô mật khẩu visible/required với ngân hàng đầu tiên.
  - Enter rồi cancel không gửi request.
  - Storage bị từ chối: không gửi request, nút được mở lại.
  - Gửi form lặp khi modal đang mở: một request.
  - Sai password 403 rồi sửa password: cùng key, đúng một lệnh thành công.
  - Commit lệnh dùng hết số dư rồi cố ý bỏ response; reload và retry ở số dư 0: cùng key, cùng withdrawal ID, không có debit thứ hai.
  - Tổng hai ý định rút 50.000đ từ fixture 100.000đ tạo đúng hai lệnh, hai debit, số dư 0.
  - Không có pageerror hoặc password trong kho intent.
  - Chạy script cũ với URL DB giả: exit 1 ngay, không kết nối.

Browser test dùng Playwright cài ở TEMP và Edge có sẵn; không thay dependency ứng dụng. Ví dụ PowerShell:

```powershell
$env:PLAYWRIGHT_MODULE = Join-Path $env:TEMP 'aff-final-audit-tools/node_modules/playwright'
node tests/withdrawal-ui.e2e.js
```

Có thể dùng `PLAYWRIGHT_MODULE` trỏ tới module Playwright khác và `AUDIT_BROWSER` trỏ tới executable Chromium/Edge. Fixture browser dùng JSON tạm riêng, không nạp .env và chặn request ngoài localhost.

## Giới hạn

- Kho intent thuộc sessionStorage của tab, có lưu fingerprint gồm thông tin nhận tiền; không chứa mật khẩu. Đóng/xóa session storage hoặc gửi từ thiết bị khác không được bảo đảm chia sẻ key. Đổi payload được coi là ý định khác. Người dùng vẫn cần đối chiếu lịch sử nếu không còn trạng thái retry.
- Kết quả C01/H01 đã kiểm chứng bằng browser + local fixture; transaction PostgreSQL giữ nguyên và regression database vẫn đạt. Chưa thử trình duyệt thiết bị thật hoặc production.
- H02–H06 và các mục Medium/Low khác trong final audit chưa được xử lý ở đợt này. Không đổi kết luận toàn hệ thống thành production-ready.
