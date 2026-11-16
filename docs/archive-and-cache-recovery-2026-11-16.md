# Lưu trữ lệnh rút và phục hồi cache sau lỗi lưu

## Đã thực hiện

- Thay xóa vật lý lệnh rút bằng đánh dấu `archived_at`. Giữ nguyên endpoint và trường `deleted` để tương thích, bổ sung `archived: true`; giao diện đổi nhãn thành **Lưu trữ**.
- Lệnh đã lưu trữ không xuất hiện trong danh sách quản trị và lịch sử rút tiền hiển thị thông thường. Bản ghi, khóa idempotency và ledger vẫn tồn tại phục vụ đối soát. Chưa bổ sung màn hình tra cứu riêng cho bản ghi đã lưu trữ.
- PostgreSQL thực hiện hoàn tiền lệnh pending, cập nhật số dư, lưu trữ và audit trong cùng transaction. Lệnh paid không được lưu trữ qua thao tác này. Lặp lại thao tác không tạo thêm refund/audit.
- Thêm cột nullable bằng `ADD COLUMN IF NOT EXISTS`; không đổi trạng thái hay xóa dữ liệu cũ khi khởi tạo schema. Snapshot không xóa bản ghi đã được lưu trữ.
- Replay yêu cầu rút tiền trên PostgreSQL được kiểm tra tại database, không trả trạng thái từ cache có thể đã cũ.
- Khi lưu snapshot PostgreSQL thất bại, cache được đánh dấu không tin cậy và tải lại từ database; yêu cầu gốc vẫn trả lỗi. Các lần lưu đã xếp hàng thuộc thế hệ cache cũ bị từ chối.
- Nếu tải lại thất bại, truy cập qua `ensureDbLoaded` và `saveDb` bị chặn với `CACHE_UNAVAILABLE`/503 đến khi tải lại thành công. Không dùng dữ liệu chưa lưu để tiếp tục trả kết quả thành công.
- Phiên bản snapshot chỉ cập nhật sau khi transaction tải lại commit; settings được thay bằng dữ liệu đã tải thay vì giữ các thuộc tính thừa từ cache cũ.

## Kiểm chứng

- `npm test`: 21/21 suite đạt, có kiểm tra archive/replay ở chế độ local.
- `npm run test:postgres`: 16 kịch bản đạt trên PostgreSQL localhost dùng database riêng, tự xóa sau kiểm thử.
- Kịch bản mới kiểm tra API lưu trữ, refund duy nhất, audit duy nhất, replay cùng key giữ nguyên ID, key với payload khác bị từ chối, ẩn khỏi danh sách và tồn tại qua snapshot save.
- Trigger cố ý làm lỗi audit chứng minh hoàn tiền và archive cùng rollback.
- API điều chỉnh số dư bị lỗi audit: bút toán thất bại biến mất khỏi cache, không xuất hiện trong PostgreSQL ở lần lưu thành công tiếp theo.
- Tạm đổi tên bảng trong database thử nghiệm khiến save và reload cùng lỗi: cache chặn đọc/ghi, hoạt động trở lại sau khi khôi phục bảng và reload.
- `git diff --check` không có lỗi whitespace.

## Giới hạn

- Chưa triển khai production; các bảo đảm transaction nêu trên dành cho PostgreSQL. Local JSON chưa có bảo đảm rollback/cache tương đương khi ghi đĩa lỗi.
- Snapshot và cache dùng chung vẫn tồn tại ở nhiều nghiệp vụ. Phục hồi sau lỗi không thay thế việc tách transaction theo nghiệp vụ hoặc kiểm chứng toàn bộ lịch xen kẽ của request đang chạy.
- Cần tiếp tục rà đường `cleanup-test-data`: hiện phân loại dữ liệu bằng heuristic và có quyền tắt trigger ledger để xóa. Không chạy chức năng này trên dữ liệu thật trong đợt kiểm thử.
- Chưa có diễn tập phục hồi backup, kiểm thử Redis và tải hỗn hợp trên môi trường triển khai thực.
- Không chạy lại benchmark chuyển link; không suy ra cải thiện throughput từ lần sửa này.
