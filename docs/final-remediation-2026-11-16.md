# Khắc phục sau final audit — 2026-11-16

Phạm vi: mã nguồn trong checkout `C:\NTV\Aff`, fixture JSON, PostgreSQL 18.7 localhost, trình duyệt Edge headless. Không chạy migration, sửa dữ liệu hoặc triển khai trên production. Bảo toàn các thay đổi đã có trong working tree.

## 1. Kết quả và giới hạn

Các blocker tài chính đã tái hiện trong audit được sửa và có kiểm thử hồi quy: rút trùng từ UI, chuyển chủ đơn, trùng mã giữa hai sàn, xác thực nhiều instance và logout. Không thay đổi công thức chia tiền hoàn.

**Chưa thể đóng toàn bộ mục I ở cấp vận hành production.** Đồng bộ provider có phân trang và chống báo thành công giả, nhưng còn cần kiểm chứng tài khoản/provider thật. Các báo cáo vượt giới hạn một tác vụ serverless hoặc đơn AccessTrade có sản phẩm vừa duyệt vừa hủy được báo lỗi rõ ràng, không tự suy đoán số tiền. Kiến trúc ghi snapshot vẫn còn; đã cô lập request và kiểm tra version, chưa chuyển toàn bộ mutation sang repository SQL riêng.

## 2. Đối chiếu 18 phát hiện

| Mã | Thay đổi | Bằng chứng / trạng thái |
|---|---|---|
| C01 | Một submit handler; khóa trước confirmation; intent/key theo payload trong sessionStorage; retry sau mất response giữ key | Browser: Enter/cancel, bấm lặp, sai mật khẩu, commit rồi mất response + reload + retry: PASS |
| C02 | Script cleanup cũ bị vô hiệu hóa, exit 1 trước khi import app/DB | Browser suite gọi script với URL DB không kết nối được: PASS; automation production chưa kiểm tra |
| H01 | Rút lần đầu/đổi số tài khoản hiện và yêu cầu mật khẩu | Browser tương tác thực tế: PASS |
| H02 | Request có state riêng và version đi kèm; refresh khi PG thay đổi; auth đọc đầy đủ user từ PG | Đăng ký A, dùng token B: 200; token thu hồi bị từ chối: PASS |
| H03 | Ref ledger chứa platform, mã đơn, user và sequence; từ chối dùng lại ref cho giao dịch khác; userId ưu tiên hơn userCode | Chuyển chủ: số dư hiển thị = ledger = sau reload = 6.300; chủ cũ được bù trừ; legacy ledger không bị sửa: PASS |
| H04 | PK orders `(platform, order_sn)`; lookup/create/delete/UI dùng định danh theo sàn; ngăn đổi mã/sàn của đơn hiện hữu | Migration từ PK cũ giữ row; hai sàn cùng SN lưu và reload riêng: PASS |
| H05 | Logout bọc asyncHandler; PG thu hồi token + tăng version trong transaction | Cache cũ vẫn trả 200, token bị từ chối ở instance khác: PASS |
| H06 | Shopee duyệt pageInfo/scrollId; AccessTrade dùng order-list/page/total; kiểm tra cursor/trang trùng, metadata, partial failure | Mock nhiều trang/mất metadata/lặp trang: PASS. Provider thật, báo cáo dài và mixed item status: CHƯA ĐÓNG HOÀN TOÀN |
| M01 | Tài khoản khóa/xóa không được login | HTTP 401, không trả user/token: PASS |
| M02 | Mapper orders dùng chung cho loader PG và query SQL, gồm claim flags/reason | API memory/SQL cùng claimVerified=true; integration roundtrip: PASS |
| M03 | Ledger mới nhất trước, tie-break bằng ID, phân trang 30 và UI Trước/Sau | API 35 bút toán mới: không thiếu/trùng, trang đầu mới nhất: PASS |
| M04 | Bỏ translateX cũ khi toast mobile dùng left/right; sửa keyframes tương ứng | Browser 360/375/390/412/430/1440px: toast nằm trong viewport: PASS |
| M05 | Hit area 44px cho nút nhỏ, copy, phân trang và điều hướng liên quan | Browser đo nút rút tối đa/copy >=44px: PASS |
| M06 | AsyncLocalStorage tách mutable state theo request; snapshot chụp trước await và giữ expectedVersion; chỉ publish sau commit; sync background riêng context | Hai request không ghi lẫn mutation; 20 writes/2 processes, retry 409: đủ 20 đơn, mọi balance khớp ledger. Phần bottleneck snapshot toàn bộ còn giới hạn kiến trúc |
| M07 | JSON giữ last committed state, phục hồi cache khi ghi đĩa lỗi và từ chối tái dùng object thất bại | Inject rename failure; save sau đó không hồi sinh mutation lỗi: PASS |
| M08 | Receipt webhook bền vững, event ID/payload conflict, chặn đổi terminal không có event time | Replay approved sau cancelled qua hai instance không đổi trạng thái; conflict/undated transition trả 409: PASS |
| L01 | Preview lỗi có thông báo nhìn thấy được; AbortError vẫn bỏ qua | Browser inject HTTP 503: thông báo hiển thị; xóa input làm sạch trạng thái lỗi: PASS |
| L02 | ESLint, scripts regression/browser/capacity, CI workflow, tài liệu migration và restore | Lint và các scripts local PASS; workflow cloud chưa chạy; cấu hình production chưa xác minh |

## 3. Thiết kế tài chính và migration

- Sổ cái vẫn append-only. Không sửa hoặc xóa bút toán cũ để đổi chủ đơn. Reconciler thêm bút toán bù cho chủ cũ và credit cho chủ mới.
- Ref mới mã hóa JSON `[platform, orderSn, userId]` bằng base64url, kèm sequence. Đây là định danh, không phải mã hóa bảo mật.
- `settings.legacyOrderPlatforms` cố định nguồn của ref cũ trước khi tạo đơn cùng mã ở sàn khác. Dữ liệu legacy mơ hồ bị từ chối thay vì tự gán.
- Bảng `webhook_receipts` được ghi cùng transaction với snapshot/ledger. Thất bại transaction không để lại receipt thành công giả.
- State version được khóa trước ghi tài chính. Xung đột trả 409; không tự retry một snapshot cũ với version mới.
- Đường redirect/convert PG dùng insert click riêng và context nhẹ; không ghi snapshot tài chính.

Migration được kiểm tra bằng bảng orders PK cũ có dữ liệu, khởi động hai worker, kiểm tra PK mới và row giữ nguyên. Đây không thay thế dry-run với bản sao dữ liệu production.

## 4. Kiểm thử thực chạy

| Lệnh / bài kiểm tra | Kết quả |
|---|---|
| `npm run lint` | PASS |
| `npm test` | 22/22 suites, lần kiểm tra cuối 7,00 giây |
| `npm run test:postgres` | 19 ca PostgreSQL cũ PASS |
| `npm run test:regression` | Migration cũ, đa instance, chuyển chủ, trùng sàn, logout, receipt, concurrent writes PASS |
| `PG_BIN=... npm run test:regression` | Dump/restore: hash/count cả tám bảng khớp; PK và trigger append-only còn hiệu lực |
| `npm run test:browser` | Luồng rút tiền + 6 viewport × 6 trang + toast/hit area PASS |
| `npm run test:capacity` | 100.000 redirect, 2.000 convert, không có kết quả sai trong fixture |
| `npm audit --omit=dev` | 0 advisory được registry báo tại thời điểm chạy; không đồng nghĩa không có lỗ hổng logic |
| `git diff --check` | PASS |

Các test cũ giữ object user qua HTTP đã được đổi sang đọc lại state hiện hành sau commit. Các assertion ref cũ được đổi sang kiểm tra đúng order identity/amount/type của bút toán bù. Không bỏ test tài chính để làm xanh bộ test.

Artifact regression: `docs/final-audit/remediation-diagnostics.json`. Các log audit ban đầu không được dùng như kết quả trạng thái hiện tại.

## 5. Hiệu năng thực đo

Fixture: 20 người, 60.000 click có sẵn; provider giả lập 100ms; tắt log trong harness. Bài bão hòa bypass rate limiter sau hai bài kiểm tra limiter thật. Không phải lưu lượng/provider/network production.

| Bài đo | Kết quả | p95 | p99 |
|---|---|---:|---:|
| 100.000 redirect, concurrency 20 | 100.000 HTTP 302 đúng; 47,53 giây | 17,47ms | 22,09ms |
| 2.000 convert, concurrency 20 | 2.000 HTTP 200 đúng; lưu đủ 2.000 click; 11,50 giây | 126,83ms | 138,19ms |
| 40 convert qua limiter thật | 40 HTTP 200 | 132,33ms | 165,74ms |
| 35 request bổ sung một tài khoản | 28 HTTP 200, 7 HTTP 429 | 127,48ms | 129,94ms |

20 thao tác ghi đơn đồng thời qua hai tiến trình, retry các HTTP 409: 2.344ms trong lần regression cuối; đủ 20 đơn, không có balance lệch SUM(ledger). Đây là kiểm tra đúng đắn khi tranh chấp, không phải benchmark giao dịch tài chính production.

Raw: `docs/capacity-results-final-fixes-2026-11-16.json`. Không dùng phép đo này để tuyên bố tối ưu tuyệt đối hoặc đảm bảo tải production.

## 6. Provider và việc còn cần hoàn tất

Cập nhật theo xác nhận của người dùng: dự án sử dụng API bên thứ ba, không dùng Shopee Open API trực tiếp. Vì vậy, kiểm chứng Shopee Open API thật không phải điều kiện bắt buộc cho cấu hình đang dùng. Cần xác nhận tên nhà cung cấp và luồng dữ liệu thực tế trước khi áp dụng các giới hạn provider dưới đây. Trong mã hiện tại, AddLiveTag lấy metadata sản phẩm/hoa hồng dự kiến; AccessTrade và webhook xử lý đơn/giao dịch. Chưa có bằng chứng API bên thứ ba người dùng nói đến cung cấp cả báo cáo giao dịch.

Contract Shopee được đối chiếu với [trang Open API chính thức](https://affiliate.shopee.vn/open_api/list) và bundle tài liệu công khai `open_api_list.26c658ce.js` của Shopee: conversionReport có pageInfo, hasNextPage, scrollId. AccessTrade đối chiếu [tài liệu order-list chính thức](https://developers.accesstrade.vn/api-publisher-vietnamese/lay-danh-sach-don-hang-v2): page bắt đầu từ 1, limit tối đa 300 và response có total.

1. Chạy staging với provider thật, đặc biệt đơn AccessTrade nhiều sản phẩm khác trạng thái. Hiện không suy đoán phân bổ commission trong trường hợp chỉ có tổng commission mà thiếu phần đã duyệt/hủy.
2. Nếu report vượt 100 trang Shopee, 10 trang AccessTrade hoặc ngân sách khoảng 22 giây/provider, cần worker dài hạn/chia cửa sổ có checkpoint. Hiện trả lỗi rõ và không cập nhật mốc thành công toàn bộ; không bỏ trang âm thầm. Hai provider chung một cron 30 giây vẫn có thể vượt thời gian khi cả hai chậm.
3. Kiểm tra secrets, SSL/proxy/CORS, backup retention, alerting, automation và lịch cron trên môi trường triển khai. Chưa có quyền/địa chỉ production để xác minh các mục này.
4. Snapshot vẫn ghi toàn bộ state và giữ khóa version chung. Đúng đắn được bảo vệ; tải tài chính lớn cần tách mutation SQL và đo lại trên dữ liệu/tải mục tiêu. Chưa có benchmark production cho phần này.

## 7. Phát hành và phục hồi

Chưa triển khai production. Trước phát hành: maintenance/drain toàn bộ worker cũ; backup đầy đủ; phục hồi bản sao và đối chiếu dữ liệu; chạy migration trên bản sao; phát hành cùng một phiên bản cho mọi worker; smoke test auth/ledger/withdrawal/webhook. Không cho code cũ chạy cùng PK mới.

Rollback không được DROP khóa mới tùy tiện nếu đã có hai sàn trùng orderSn. Dùng bản ứng dụng tương thích schema mới hoặc kế hoạch phục hồi đã diễn tập, có đối soát giao dịch phát sinh sau backup. Không dùng script cleanup, không disable trigger ledger, không xóa lịch sử tài chính để làm rollback.

Kết luận: các lỗi tái hiện cốt lõi có bằng chứng khắc phục trong môi trường cô lập. Các giới hạn provider và xác minh production ở trên vẫn còn mở; không tuyên bố dự án đã tối ưu hoàn toàn hoặc mục I đã hoàn tất trên production.
