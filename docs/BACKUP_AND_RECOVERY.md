# Quy Trình Sao Lưu & Khôi Phục Cơ Sở Dữ Liệu (Backup & DR Runbook)

## 1. Chỉ tiêu RPO / RTO
* **RPO (Mất dữ liệu tối đa chấp nhận được):** 24 giờ (với backup tự động hàng ngày) hoặc vài phút (kết hợp PITR của Neon PostgreSQL).
* **RTO (Thời gian khôi phục tối đa):** 30 – 60 phút.

## 2. Cấu hình Backup Tự Động Ngoài Neon (GitHub Actions)
Workflow [.github/workflows/backup-postgres.yml](../.github/workflows/backup-postgres.yml) tự động chạy lúc `02:30 UTC` mỗi ngày, thực hiện `pg_dump`, nén `gzip -9` và mã hóa `AES-256-CBC (PBKDF2)` trước khi lưu trữ 30 ngày.

### Các GitHub Repository Secrets bắt buộc cấu hình:
1. `DATABASE_URL`: Chuỗi kết nối Neon PostgreSQL (ưu tiên dùng role chỉ đọc / `pg_dump` nếu có thể).
2. `BACKUP_ENCRYPTION_KEY`: Khóa mã hóa ngẫu nhiên $\ge 32$ ký tự (lưu trữ an toàn ngoài GitHub và Neon, ví dụ trong Password Manager).

## 3. Quy Trình Diễn Tập Khôi Phục (KHÔNG chạy đè lên Production)
Thực hiện kiểm thử khôi phục ít nhất **1 lần/tháng** trên một Neon Branch hoặc PostgreSQL staging riêng:

1. Tải file `hoantiensan_<timestamp>.sql.gz.enc` từ GitHub Actions Artifacts.
2. Giải mã và giải nén:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in hoantiensan_YYYYMMDD_HHMMSS.sql.gz.enc -out restore.sql.gz -pass env:BACKUP_ENCRYPTION_KEY
   gunzip restore.sql.gz
   ```
3. Nạp vào **database staging trống**:
   ```bash
   psql "$STAGING_DATABASE_URL" -f restore.sql
   ```
4. Đối chiếu số lượng bản ghi các bảng cốt lõi (`users`, `orders`, `ledger`, `withdrawals`) và kiểm tra tính nhất quán sổ cái.
5. Xóa file `restore.sql` và `restore.sql.gz` khỏi máy cục bộ sau khi hoàn tất.
