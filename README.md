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
