# Kiểm tra dữ liệu thử và lưu trạng thái đối soát đơn

## Thay đổi

- Chuyển chức năng dọn dữ liệu thử sang kiểm tra chỉ đọc. Các dấu hiệu như tên/ID chứa `test` chỉ tạo danh sách ứng viên cần rà soát, không cho phép xóa.
- Giữ URL `/api/admin/cleanup-test-data` cho client cũ, vẫn yêu cầu quyền admin, nhưng trả `previewOnly: true`, số lượng và ID ứng viên. Giao diện đổi thành **Kiểm tra dữ liệu thử**.
- Loại bỏ đường xóa tự động và mã tắt trigger ledger khỏi chức năng này. Không còn transaction xóa commit trước audit trong đường dọn dữ liệu, vì endpoint không thực hiện thay đổi dữ liệu.
- Không cung cấp chức năng xóa dữ liệu nghi là thử nghiệm trên database dùng chung. Harness PostgreSQL tiếp tục tạo/xóa database riêng mà nó sở hữu. Dữ liệu cũ lẫn trong production cần quy trình đối soát riêng, không suy đoán từ tên hay email.
- Thêm các cột `claim_verified`, `claim_rejected`, `claim_reject_reason` bằng migration khởi tạo có thể chạy lại. Cập nhật cả đường batch, lưu một đơn và tải lại từ PostgreSQL.
- Khi tracking xác minh hoặc bác bỏ người nhận đơn, xóa cờ đối lập; xác minh thành công cũng xóa lý do từ chối cũ.

## Kiểm chứng

- `npm test`: 21/21 suite đạt, 6,75 giây.
- `npm run test:postgres`: 19 kịch bản đạt trên PostgreSQL localhost cô lập.
- So sánh toàn bộ hàng của users, orders, ledger, withdrawals, clicks, audit_logs và hoantienshop_state trước/sau gọi endpoint kiểm tra: không thay đổi, dù có bản ghi bị đánh dấu nghi là dữ liệu thử.
- Thử DELETE ledger trong database kiểm thử: trigger từ chối, bút toán vẫn còn.
- Cả trạng thái xác minh và từ chối kèm lý do được giữ qua batch save/reload; đường lưu một đơn cho phép chuyển sang verified và xóa lý do cũ.
- Các kiểm thử lỗi audit, rollback, cache recovery và race rút tiền từ các đợt trước vẫn đạt.
- `git diff --check` không có lỗi whitespace. PostgreSQL kiểm thử được dừng sau khi hoàn thành.

## Giới hạn còn lại

- Chưa triển khai production hoặc thay đổi dữ liệu thật.
- Các trường claim đã mất trong quá khứ không được tự suy diễn để phục hồi. Cột mới mặc định false/null; cần đối soát nguồn nếu muốn bổ sung lịch sử.
- Chức năng kiểm tra chỉ đưa ra gợi ý, không khẳng định bản ghi là dữ liệu thử; chưa có màn hình rà soát từng ứng viên.
- Snapshot/cache chung, độ bền khi lỗi ghi đĩa ở chế độ JSON, diễn tập backup và kiểm chứng Redis/tải production vẫn cần công việc riêng.
