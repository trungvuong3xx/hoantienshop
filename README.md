# AffConvert — Chuyển Đổi Link Affiliate Shopee & TikTok Shop

Web App chuyển đổi link tiếp thị liên kết (Affiliate) **Shopee** và **TikTok Shop** hàng loạt (Bulk Convert).

## Tính năng chính
- **Tự động giải mã (Unshorten)**: Truy vết các link rút gọn (`s.shopee.vn`, `vn.shp.ee`, `shp.ee`, `vt.tiktok.com`, `vm.tiktok.com`, `is.gd`, `tinyurl.com`) về link sản phẩm gốc.
- **Xoá sạch mã Affiliate cũ**: Loại bỏ toàn bộ tham số tracking của người khác (`utm_source`, `affiliate_id`, `sp_atk`, `checksum`, `sec_uid`,...).
- **Chuyển đổi hàng loạt (Bulk Convert)**: Dán cả bài viết quảng cáo có nhiều link Shopee & TikTok $\rightarrow$ Thay thế toàn bộ link trong bài sang link Affiliate của bạn và giữ nguyên văn bản.
- **Hỗ trợ Shopee Affiliate**:
  - Ghép trực tiếp bằng `Affiliate ID` (`an_redir` - không cần API, không hết hạn).
  - Gọi trực tiếp **Shopee Affiliate Open API** (GraphQL `generateShortLink`).
- **Hỗ trợ TikTok Shop Affiliate**:
  - Bóc tách `Product ID` sạch + Nút mở nhanh sản phẩm trong **TikTok Affiliate Center** (`affiliate.tiktok.com`).
  - **TikTok Shop Open API** (`partner.tiktokshop.com`).
  - **TikTok Web Cookie** & **DeepLink (Accesstrade / Custom)**.
- **Tích hợp rút gọn link miễn phí**: Tự động rút gọn link dài qua `is.gd` hoặc `TinyURL`.

## Cách chạy trên máy tính

1. Cài đặt thư viện:
   ```bash
   npm install
   ```
2. Khởi chạy server:
   ```bash
   npm start
   ```
   *(Trên Windows có thể nhấp đúp vào file `start.bat`)*
3. Mở trình duyệt tại: `http://localhost:3456`

## Kiểm thử và vận hành Cashback

Dùng Node.js 24 cho môi trường phát triển/CI; các phiên bản tối thiểu được khai báo trong `package.json`. Cài đúng dependency bằng `npm ci`.

```powershell
npm run lint
npm test
npm run test:browser
```

Browser test dùng Edge trên Windows, Chromium của Playwright trên Linux (`npx playwright install --with-deps chromium`). Có thể chỉ định executable qua `AUDIT_BROWSER`.

Kiểm thử PostgreSQL yêu cầu **database localhost dùng riêng cho kiểm thử**, với role có quyền tạo/xóa database fixture. Các harness tự tạo và xóa database riêng; không trỏ vào production.

```powershell
$env:PG_TEST_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/postgres'
npm run test:postgres
npm run test:regression
npm run test:capacity
```

Để chạy thêm diễn tập backup/restore, đặt `PG_BIN` tới thư mục chứa `pg_dump` và `pg_restore` cùng phiên bản tương thích với server, rồi chạy `npm run test:regression`. Không đặt biến này thì bước restore được bỏ qua; không suy ra đã kiểm chứng phục hồi.

CI tại `.github/workflows/verify.yml` chạy lint, unit/integration và browser tests. Repository là Express + JavaScript thuần, không có bước bundler build hoặc kiểm tra kiểu TypeScript; không đánh đồng lint với hai bước này.

Thay đổi schema ngày 2026-11-16 chuyển khóa đơn thành `(platform, order_sn)` và thêm `webhook_receipts`. Cần dừng/drain toàn bộ worker cũ, backup và kiểm tra phục hồi trước khi phát hành bản mới; **không rolling deploy lẫn code cũ và mới** vì code cũ vẫn dùng `ON CONFLICT(order_sn)`. Không tự hạ schema sau khi đã có hai nền tảng trùng mã đơn.

Webhook đổi trạng thái terminal cần `eventTime`, `event_time`, `update_time` hoặc `timestamp` trong payload. Retry giữ nguyên event ID/payload. Không tạo timestamp mới cho sự kiện cũ để vượt kiểm tra thứ tự. Xung đột HTTP 409 cần tải lại dữ liệu và thực hiện lại ý định ban đầu; lệnh rút tiền phải giữ nguyên idempotency key khi retry.

Đối chiếu các mục đã xử lý, bằng chứng và giới hạn phát hành tại [báo cáo khắc phục cuối](docs/final-remediation-2026-11-16.md).
