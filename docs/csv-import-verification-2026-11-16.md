# Kiểm chứng nhập CSV Shopee — 16/11/2026

## Phạm vi và dữ liệu

Đã đọc trực tiếp `C:/Users/Admin/Downloads/AffiliateCommissionReport_202611161133.csv`. File có BOM UTF-8, 48 cột và một dòng đơn **Đã hủy**, giá trị đơn **209.000 đồng**, hoa hồng **0 đồng**. Không sửa file gốc, không nhập vào database vận hành. SHA-256 trước/sau giống nhau: `0c312f2adf2b3a0f1b8c08628cfa2a172bccd4d6c2f9dd5d2c99ce1d04f08d4f`.

Fixture trong repository chỉ sao chép tên cột; mã đơn, tracking và tên sản phẩm đều là giả lập. Ca đơn hoàn thành, nhiều sản phẩm, điều chỉnh hoa hồng, nhập lặp và đảo thứ tự báo cáo là dữ liệu tổng hợp, không phải giao dịch thực đã xác minh với Shopee.

## Lỗi được tái hiện và sửa

| Mức độ | Lỗi trước sửa | Khắc phục và bằng chứng |
|---|---|---|
| HIGH | Parser cũ đọc dòng mẫu thành pending, orderAmount=0 do thiếu alias tiêu đề | Parser dùng đúng `Trạng thái đặt hàng`, `Giá trị đơn hàng (₫)`, `ID đơn hàng`; đọc mẫu thành cancelled/209000/0 |
| HIGH | Tách dòng CSV trước khi xử lý dấu nháy làm hỏng ô chứa xuống dòng | Parser dùng chung cho UI/test xử lý BOM, dấu nháy kép, dấu phân cách và xuống dòng trong ô |
| HIGH | Các dòng cùng đơn có thể ghi đè nhau; số tiền lỗi bị parse một phần | Gộp các dòng có cùng tổng tiền/chủ đơn/trạng thái; từ chối mâu thuẫn và số tiền không hợp lệ trước nhập |
| CRITICAL | PostgreSQL giữ cashback cũ khi giá trị mới bằng 0, có nguy cơ cộng lại sau reload | Bỏ nhánh giữ giá trị cũ trong cả batch và single-row upsert; kiểm tra điều chỉnh về 0, reload và GET /me vẫn bằng 0 |
| HIGH | Nhập báo cáo cũ có thể phục hồi trạng thái/số dư đã hủy | Dùng thời điểm snapshot từ tên file gốc để từ chối dữ liệu cũ; xung đột cùng thời điểm bị chặn; kiểm thử ledger không cộng lại |
| MEDIUM | Chọn file liên tục có thể chạy nhiều lần nhập đồng thời | Khóa thao tác trong lúc nhập, khôi phục trong finally; bổ sung kiểm tra UI thực |

Các thay đổi nằm ở `public/csvImport.js`, `public/app.js`, `public/index.html`, `src/services/cashbackController.js`, `src/services/dbService.js` và các bài kiểm thử tương ứng. API kiểm tra dữ liệu, quyền admin, dòng trùng/mâu thuẫn và ghi audit nhập CSV.

## Kết quả thực thi

| Lệnh | Kết quả |
|---|---|
| `node tests/test_csv_import.js` với CSV_SAMPLE_PATH trỏ file mẫu | PASS: đọc file thật, hash không đổi; parser và HTTP import trên dữ liệu cô lập |
| `npm test` | PASS: 23/23 suites, 7,54 giây |
| `npm run lint` | PASS |
| `node tests/csv-import.e2e.js` | PASS: đăng nhập admin, chọn file, hủy xác nhận, nhập, nhập lặp, hủy đơn, báo cáo cũ, dữ liệu sai |
| `npm run test:browser` | PASS: 6 viewport, điều hướng, vùng chạm, rút tiền lặp/mất phản hồi và lỗi API preview |
| `node tests/csv-postgres.integration.js` với CSV_SAMPLE_PATH | PASS: PostgreSQL cô lập, ledger bền vững, điều chỉnh về 0 và reload |
| `node tests/postgres.integration.js` | PASS: 19 kiểm tra hồi quy PostgreSQL |
| `node tests/final-audit-diagnostics.js` với PG_BIN | PASS: đa tiến trình, 20 cập nhật đồng thời, phân quyền/session, webhook, pg_dump/pg_restore và bảo vệ ledger |

Database kiểm thử được tạo và xóa riêng bằng harness trên PostgreSQL localhost cổng 55440; không dùng DATABASE_URL của dự án. Cụm tạm cũ cổng 55439 không khởi động được vì thiếu thư mục pg_notify; đã tạo cụm kiểm thử mới, không sửa cụm cũ. CI được bổ sung hai lệnh test CSV; chưa chạy workflow CI từ xa trong lượt này.

## Giới hạn cần hiểu trước vận hành

- Giữ nguyên cơ sở tính hiện tại: tổng hoa hồng đơn hàng, thuế và tỷ lệ cashback đã cấu hình. Không tự đổi sang hoa hồng ròng hoặc trừ phí MCN. Đơn có phí MCN khác 0 hoặc trạng thái sản phẩm khác trạng thái đơn bị chặn để đối soát.
- Quy tắc hiện có `Hoàn thành -> approved` được giữ lại. Trạng thái đơn hoàn thành **không tự chứng minh hoa hồng đã được Shopee thanh toán cuối cùng**; file mẫu chỉ có đơn hủy nên chưa xác minh được quy trình quyết toán thực tế.
- Thời điểm snapshot suy ra từ quy ước tên `AffiliateCommissionReport_YYYYMMDDHHmm.csv`, múi giờ +07:00. Đây là giả định định dạng theo file mẫu, không phải chữ ký xác thực của Shopee. Giữ nguyên tên tải xuống; đổi tên có thể làm mất hoặc sai thứ tự. Hai báo cáo cùng phút nhưng khác tiền/trạng thái cần đối soát, không tự ghi đè.
- Gộp nhiều dòng chỉ khi tổng tiền cấp đơn lặp lại nhất quán; không tự cộng tổng tiền cấp đơn. Cấu trúc báo cáo có giá trị cấp sản phẩm khác nhau sẽ bị từ chối thay vì đoán cách cộng.
- File lớn vẫn chia lô 500 đơn; toàn file không phải một giao dịch nguyên tử. Một số lô/dòng có thể thành công trong khi dòng khác lỗi; UI báo số nhập và lỗi, nhập lại được kiểm tra chống cộng trùng.
- Kết quả này chứng minh các trường hợp đã kiểm tra trong môi trường cô lập, không phải chứng nhận toàn bộ nghiệp vụ tài chính hoặc production đã an toàn tuyệt đối.
