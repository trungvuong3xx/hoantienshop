# Rà soát tiếp: xử lý rút tiền và nhật ký quản trị

Ngày kiểm chứng: 2026-11-16. Chỉ chạy trên dữ liệu kiểm thử và PostgreSQL localhost riêng; không triển khai production.

## Các vấn đề đã xử lý

| Mức độ | Vấn đề | Thay đổi |
|---|---|---|
| High | Duyệt/từ chối rút tiền phụ thuộc trạng thái cache và cơ chế lưu snapshot, dễ xung đột giữa các instance | Chuyển quyết định trạng thái sang transaction PostgreSQL, khóa bản ghi trạng thái và lệnh rút theo thứ tự thống nhất |
| High | Thiếu kiểm chứng bút toán giữ tiền trước khi kết thúc lệnh rút | Yêu cầu bút toán debit đúng chủ tài khoản, đúng số tiền; chặn lệnh pending đã có refund |
| High | Nhật ký xử lý rút tiền không được bảo đảm cùng giao dịch với thay đổi tài chính | Cùng transaction cập nhật trạng thái, refund nếu có, số dư, tổng tiền đã rút, audit và version; lỗi audit làm rollback toàn bộ |
| Medium | Một số thao tác quản trị ghi audit sau saveDb nên phản hồi thành công nhưng audit chưa được lưu | Đưa audit của reset/adjust balance, reset password, toggle lock, soft/hard delete tài khoản vào trước saveDb; thao tác số dư ghi audit bên trong khóa người dùng |

Repository mới: `src/repositories/withdrawalRepository.js`. Controller gọi đường giao dịch PostgreSQL trước khi kiểm tra cache. Chế độ JSON vẫn được hỗ trợ, nhưng không có bảo đảm giao dịch đa tiến trình của PostgreSQL.

Replay cùng trạng thái cuối trả lại kết quả hiện có, không tạo thêm refund hoặc audit. Đổi từ paid sang rejected hoặc ngược lại bị chặn với HTTP 409. Lệnh pending có dữ liệu giữ tiền không khớp bị chặn để đối soát, không tự sửa số tiền.

## Bằng chứng kiểm thử

- `npm test`: 21/21 suite thành công, 6,67 giây trong lần chạy cuối.
- `npm run test:postgres`: 13 kịch bản thành công trên PostgreSQL 18.7 localhost, database dùng riêng được tạo và xóa bởi harness.
- Hai worker tranh chấp paid/refund: đúng một thao tác thành công, một trạng thái cuối, một audit; số refund khớp trạng thái.
- Trigger cố ý làm lỗi INSERT audit: lệnh vẫn pending, không có refund mới, số dư không đổi; retry thành công và replay không nhân đôi audit.
- API adjust_balance: bút toán và audit đã có trong PostgreSQL khi HTTP trả 200.
- Cố ý làm lệch số tiền lệnh rút so với debit: cả paid và refund bị chặn, không đổi trạng thái, không sinh refund/audit.
- Các kịch bản trước về stale snapshot, khóa idempotency, thu hồi token, attribution giữa instance và click insert lỗi vẫn thành công.

## Giới hạn và công việc còn lại

1. **High — vòng đời dữ liệu tài chính:** đường hard-delete lệnh rút vẫn có thể xóa lệnh đã rejected, làm mất bản ghi chứa idempotency key. Cần chuyển sang lưu trữ/tombstone với migration và thống nhất hành vi giao diện; chưa thay đổi chức năng xóa trong đợt này.
2. **High — ghi snapshot còn tồn tại:** điều chỉnh số dư và cập nhật đơn hàng vẫn dùng snapshot/OCC. Audit được đưa vào cùng lần lưu, nhưng đây chưa phải transaction chuyên biệt theo từng nghiệp vụ. Cần kiểm thử cả trạng thái cache sau lỗi lưu trước khi mở rộng tải nhiều instance.
3. **Medium — hiệu suất xử lý rút tiền:** transaction vẫn lấy khóa state toàn cục để tương thích đường snapshot hiện tại, và tải lại cache sau commit. Chưa đo throughput riêng cho quyết toán rút tiền; không suy ra cải thiện tốc độ từ thay đổi này.
4. **Chưa kiểm chứng vận hành thực:** Redis production, cold start, quota/độ trễ nhà cung cấp, phục hồi backup và tải hỗn hợp trên môi trường triển khai. Kết quả localhost không chứng nhận production hoặc an toàn tài chính toàn hệ thống.

Benchmark chuyển link trước đó được giữ nguyên trong `incremental-clicks-2026-11-16.md`; không chạy lại benchmark trong đợt sửa quyết toán này và không dùng số đo cũ để khẳng định hiệu suất của đường rút tiền mới.
