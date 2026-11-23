# Bảo vệ dữ liệu — 21/11/2026

## Thay đổi

- Đồng bộ orders/withdrawals chỉ upsert; thiếu bản ghi trong snapshot không còn cho phép xóa. Xóa đơn admin truyền danh sách rõ ràng vào saveDb trong request context; xóa SQL, bút toán điều chỉnh và audit cùng transaction/version lock. Các luồng rút tiền tiếp tục dùng archive.
- Xóa user luôn soft-delete và khóa tài khoản, tăng tokenVersion; giữ ID, SĐT, ngày tạo và liên kết. SĐT tài khoản lưu trữ vẫn được giữ, không tự cho đăng ký lại bằng SĐT đó.
- INSERT user giữ createdAt; UPDATE không thay ngày tạo SQL. Bootstrap ghi user còn thiếu vào SQL trước khi đánh dấu cache đã đồng bộ.
- Sai/thiếu khóa giải mã hoặc ciphertext hỏng ném SETTINGS_DECRYPT_FAILED, không biến secret thành chuỗi rỗng. Không đổi khóa production tự động.
- Công cụ rotate-settings-key.js không đọc .env, mặc định preview; --apply bắt buộc file backup mới và giữ nguyên encrypted envelope trước khi ghi, tăng version trong cùng transaction.

## Kiểm thử cô lập

Chạy npm test, npm run lint, test:postgres và test:rotation. test:regression với PG_BIN kiểm tra thêm pg_dump/pg_restore. PG_TEST_URL chỉ trỏ localhost; mỗi suite tạo database riêng và xóa đúng database đó. Không dùng Neon production.

Các ca mới: snapshot rỗng không xóa user/đơn/lệnh rút pending/paid/rejected; ngày tạo giữ qua INSERT/UPDATE; xóa đơn có audit và bút toán đảo không lặp; user không có giao dịch vẫn bị khóa/thu hồi phiên; sai khóa không ghi; chuyển khóa giữ dữ liệu; không ghi đè file backup.

## Phát hành production (chưa thực hiện)

Kết quả kiểm chứng: 30/30 suite của npm test đạt; PostgreSQL integration và kiểm thử chuyển khóa đạt; final-audit-diagnostics với PG_BIN đã diễn tập dump/restore thành công cả tám bảng. Kiểm thử mới xác nhận xóa đơn đã duyệt tạo bút toán đảo, giữ ledger gốc và không đảo hai lần khi gửi lại. Các kết quả này chỉ áp dụng fixture local, không phải backup/đối chiếu Neon production.

1. Sao lưu Neon hiện tại sau phục hồi thủ công; xác minh bản sao trên branch/database riêng, đối chiếu counts và ledger. Backup trong test không thay cho backup production.
2. Dừng nhận ghi và drain toàn bộ worker cũ. Không rolling deploy lẫn bản cũ còn prune và bản mới.
3. Triển khai mã mới, giữ nguyên khóa hiện tại trước. Không cần migration schema mới. Kiểm tra đăng nhập, lưu, đối soát và counts trước/sau.
4. Để tách mã hóa khỏi JWT mà không đổi ciphertext: đặt SETTINGS_ENCRYPTION_KEY bằng đúng secret đã dùng mã hóa trước đây (khóa riêng cũ hoặc JWT_SECRET/AUTH_SECRET theo cấu hình cũ), không tạo ngẫu nhiên rồi thay trực tiếp.
5. Nếu đổi vật liệu khóa: tiếp tục dừng toàn bộ worker và tác vụ ghi; cung cấp ROTATION_DATABASE_URL, OLD_SETTINGS_KEY, NEW_SETTINGS_KEY qua môi trường an toàn. Chạy `node scripts/rotate-settings-key.js` để preview. Sau khi đạt, đặt ROTATION_BACKUP_PATH tới file mới ở nơi bảo mật và chạy thêm `--apply`. Không đưa các secret vào command line/history.
6. Cập nhật SETTINGS_ENCRYPTION_KEY cho tất cả worker bằng NEW_SETTINGS_KEY trước khi khởi động lại. Công cụ chỉ chuyển settings trong hoantienshop_state, không chuyển bản JSON offline; các bản backup cũ cần giữ khóa cũ trong kho bí mật để phục hồi.
7. Kiểm tra đọc cấu hình, webhook và không xuất hiện lỗi giải mã. Chỉ mở lại ghi khi đã xác nhận.

Rollback phải dùng bản ứng dụng đã bỏ prune. Nếu cần quay khóa, dùng công cụ với khóa hiện tại và khóa cũ khi worker đã dừng; không phục hồi đè toàn bộ DB. Không bỏ lỗi giải mã để ứng dụng tiếp tục ghi.
