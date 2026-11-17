# Nâng cấp toàn diện — trạng thái ngày 17/11/2026

## Mục tiêu và nguyên tắc phát hành

Ưu tiên gán đúng người, số dư khớp ledger và phục hồi được dữ liệu trước mở rộng TikTok. Mọi kết quả PASS chỉ áp dụng cho các ca được chạy. Không đổi công thức chia tiền, điều kiện duyệt tiền, API tài chính hay schema trong đợt 1. Các bước thay đổi schema/quy trình tiền phải có thiết kế, kiểm thử trên bản sao và phê duyệt trước triển khai.

## Đợt 1 — đã sửa, kiểm chứng và phát hành

Deployment Production: `dpl_G6QUZMZFF5wUibNjwh531hNTfL9i`, trạng thái READY, domain `https://hoantiensan.online`. Phát hành source của đợt 1, không chạy migration riêng hoặc chỉnh dữ liệu tài chính. Trước upload đã kiểm tra danh sách file bằng `vercel deploy --dry`: không có file secrets `.env`/`.env.*` thật, chỉ có `.env.example`.

1. **Tracking về muộn:** thêm chế độ tra cứu phục vụ đối soát trong `findClickById`. CSV, đồng bộ đơn và postback được tìm bản ghi PostgreSQL quá 30 ngày. `/go/:clickId` vẫn áp dụng TTL 30 ngày. Không tăng thời hạn cookie của sàn, không suy đoán chủ đơn. PostgreSQL đã giữ những bản ghi này từ trước; không thêm migration hoặc thay đổi chính sách xóa dữ liệu.
2. **Redis trên Vercel:** nhận cặp tên `KV_REST_API_URL`/`KV_REST_API_TOKEN` do Marketplace cung cấp. Cặp `UPSTASH_REDIS_REST_*` vẫn được ưu tiên. Không trộn URL/token giữa hai cặp; nếu cấu hình ưu tiên chỉ có một phần thì chặn thay vì dùng nhầm token. Redis lỗi vẫn fail-closed cho endpoint nhạy cảm.
3. **Kiểm tra cấu hình trước phát hành:** `npm run check:config`. Kiểm tra secret xác thực, bootstrap, PostgreSQL, Redis và cặp Turnstile; cảnh báo cron thiếu secret. Không import server, không tự migration/bootstrap, không in giá trị bí mật. `--live` chỉ SELECT 1/PING khi cấu hình kiểm tra được; `--strict` coi cảnh báo là chưa đạt.
4. **Kiểm tra production chỉ đọc:** `npm run check:production -- https://hoantiensan.online`. Kiểm tra HTML app, health PostgreSQL persistent, JSON cấu hình và tài nguyên popup. Không login, tạo link, tạo đơn hay rút tiền. Exit khác 0 khi lỗi để hệ thống giám sát sử dụng. Chưa thiết lập lịch chạy hoặc kênh gửi cảnh báo bên ngoài.
5. **Bảo vệ file môi trường:** loại `.env.*` khỏi Git và gói upload Vercel, ngoại trừ `.env.example`; loại dữ liệu local và log khỏi deployment.

### Giới hạn tracking

- Lookup cũ chỉ giải quyết dữ liệu còn trong PostgreSQL. Không phục hồi được click đã bị xóa trước đó.
- JSON local vẫn dọn click quá 30 ngày, không phải phương án vận hành tài chính lâu dài. Production phải dùng PostgreSQL.
- Tracking không tồn tại không được gán đoán. Ca provider thay đổi attribution vẫn cần đối soát.

### Kết quả kiểm chứng đợt 1

- Lint PASS; bộ kiểm thử chính 24/24 PASS (9,60 giây ở lần chạy đầu đợt).
- Lần chạy cuối trước phát hành: 24/24 PASS, 7,87 giây. Sau deploy, 5 smoke checks đều PASS/HTTP 200; health lần này 4.859ms. Cần đo thêm cold/warm latency để tìm bottleneck, chưa thể kết luận nguyên nhân từ một lần đo.
- Test PostgreSQL CSV dùng tracking 120 ngày tuổi: tra cứu đối soát đúng user, không phục hồi redirect cũ; chuỗi pending/approved/cancelled/replay/điều chỉnh về 0 vẫn PASS sau reload.
- Regression PostgreSQL: đa instance, xung đột cập nhật, 20 thao tác ghi đồng thời, webhook replay và pg_dump/pg_restore PASS trên database tạm.
- Smoke production ngày 17/11: 5 endpoint/tài nguyên đều 200. Một request health mất 5.645ms; đây là một mẫu đơn lẻ, không phải p95 hay kết luận hiệu năng.
- Vercel env export che giá trị Secret. Không thể dùng placeholder để kết luận production thiếu hoặc sai secret. Preflight đánh dấu NOT_TESTED khi nhận giá trị đã che; cần chạy trong deployment với biến thật. Các file export tạm đã xóa sau kiểm tra.

## Đợt 2 — vận hành production và bảo mật

| Việc | Tiêu chí hoàn tất | Trạng thái |
|---|---|---|
| Turnstile | Site key/secret đúng domain; thử đăng ký/đăng nhập hợp lệ, token thiếu/sai, API gián đoạn | Chưa kiểm chứng cấu hình thực; không tự tạo key giả hoặc bật bắt buộc gây khóa đăng nhập |
| Giám sát | Chạy smoke định kỳ ở hạ tầng được chọn; cảnh báo khi nhiều lần lỗi, có người nhận và kiểm tra cảnh báo phục hồi | Đã có script, chưa thiết lập lịch/kênh nhận |
| Redis | Đối chiếu quota gói thực, lưu lượng lệnh/ngày; thử hết quota/mất kết nối ở staging | Đã có kiểm thử fail-closed, chưa đo quota/tải production dài hạn |
| Backup | Xác minh retention/PITR của nhà cung cấp, phục hồi bản sao production và đối chiếu ledger | Đã diễn tập fixture; production backup/PITR chưa xác nhận |
| CI/phát hành | Lint, test, PostgreSQL, browser; chạy preflight trong môi trường có secrets rồi smoke sau deploy | Các lệnh có sẵn; cần xác minh workflow cloud và gắn gate vào quy trình phát hành |

## Đợt 3 — CSV lớn và dữ liệu tài chính

Thiết kế đề xuất trước khi viết migration:

- Import job có fingerprint file, trạng thái, tiến độ, lỗi từng dòng và idempotency theo job/batch. Kiểm tra file trước khi ghi; có màn hình kết quả rõ phần thành công/thất bại và tiếp tục job sau gián đoạn.
- Giữ ledger append-only; không hoàn tác bằng xóa lịch sử. Quyết định toàn-file atomic hay từng batch phải dựa kích thước/tải và thời gian serverless, không cam kết atomic khi còn chia 500 đơn/lần.
- Tách các mutation tài chính khỏi snapshot toàn state sang transaction SQL theo nghiệp vụ. Giữ idempotency, điều kiện số dư và thứ tự bút toán. Migration/rollback phải kiểm thử trên bản sao trước khi xin phê duyệt.
- Tiêu chí nghiệm thu: import lớn bị ngắt ở nhiều vị trí, resume/replay không thiếu/trùng; mọi số dư khớp ledger; báo cáo cũ không khôi phục tiền; truy vấn và thời gian giữ khóa được đo ở tải mục tiêu.

**Đợt này chưa triển khai:** có thay đổi database/API/quy trình ghi tài chính nên cần phê duyệt thiết kế cụ thể.

## Đợt 4 — TikTok qua RioHub

Theo tài liệu người dùng cung cấp: ưu tiên `/affiliate/links` có `sub_id`, không dùng general-links cho attribution. Key chỉ ở server; failover host chỉ lỗi DNS/kết nối/TLS/timeout, nhớ host thành công; HTTP lỗi không đổi host. Retry 429 có giới hạn và theo Retry-After.

Trước tích hợp tài chính cần: creator đã kết nối, API key trong secret store, JSON mẫu orders/products, pagination, đơn vị tiền, thời gian/timezone, cách phân biệt estimated/settled commission, thuật toán/chìa khóa ký webhook, quy tắc hoàn một phần. Chưa đoán chữ ký hoặc map tiền từ trường chưa xác định.

Tiêu chí nghiệm thu: link thật có sub_id, đơn thật trả đúng mã, pending/settled/refund và replay đúng ledger; webhook nhận nhanh, lưu bền vững rồi verify đơn theo lô; không bỏ đơn khi phân trang lỗi. Chưa có đủ contract để đánh dấu triển khai hoàn tất.

## Đợt 5 — hiệu năng và trải nghiệm

Đo tải hỗn hợp 20 người dùng, 100.000 click/ngày và 2.000 lượt tạo link/ngày; tách latency provider/cache/database. Báo p50/p95/p99 và tỷ lệ lỗi, không dùng benchmark giả lập thay số production. Kiểm tra điện thoại thật Android/iOS, bàn phím, chọn ngân hàng, tải lại/mất mạng giữa thao tác, accessibility. Ưu tiên tối ưu có số liệu trước/sau; không viết lại UI đang hoạt động chỉ để đổi hình thức.

## Lệnh vận hành

```text
npm run check:config
npm run check:config -- --env-file <secure-path> --live --strict
npm run check:production -- https://hoantiensan.online
npm test
npm run test:csv:postgres
npm run test:regression
```

Hai bộ PostgreSQL yêu cầu PG_TEST_URL trỏ localhost, harness tạo/xóa database riêng. Không chạy các harness này với URL production. Không commit bản export secrets. Cảnh báo/NOT_TESTED là việc còn phải giải quyết, không phải PASS.
