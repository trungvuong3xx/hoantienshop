# AGENTS.md — Hướng Dẫn Bắt Buộc Cho AI Agent & Developer (LiLa Cashback)

> **Hệ thống Project Memory trung tâm nằm tại:** [`docs/project-memory/`](docs/project-memory/)  
> **Nguyên tắc vàng:** Project Memory lưu trữ kiến thức, quyết định và lịch sử để bạn không lặp lại sai lầm — **nhưng source code hiện tại luôn là chân lý tối thượng (source of truth)**. Luôn đối chiếu tài liệu với code thực tế trước khi kết luận.

---

## 1. Bắt buộc đọc trước khi làm bất kỳ công việc nào

| Thứ tự | Tài liệu | Khi nào bắt buộc đọc |
|---|---|---|
| 1 | [`docs/project-memory/AI_WORK_PROTOCOL.md`](docs/project-memory/AI_WORK_PROTOCOL.md) | **Mọi nhiệm vụ** (quy trình Trước / Trong / Sau + quy trình kiểm tra trước khi sửa lỗi) |
| 2 | [`docs/project-memory/PROJECT_CONTEXT.md`](docs/project-memory/PROJECT_CONTEXT.md) | **Mọi nhiệm vụ** (kiến trúc, tech stack, deploy, cache PWA hiện tại) |
| 3 | [`docs/project-memory/MODULES.md`](docs/project-memory/MODULES.md) | **Mọi nhiệm vụ** (xác định đúng file & phạm vi ảnh hưởng) |
| 4 | [`docs/project-memory/BUSINESS_RULES.md`](docs/project-memory/BUSINESS_RULES.md) | Khi liên quan đến Cashback, VIP, Ledger/Ví, Rút tiền, Shopee/TikTok, So sánh giá, BXH, Auth, Admin |
| 5 | [`docs/project-memory/SYSTEM_CONFIG.md`](docs/project-memory/SYSTEM_CONFIG.md) | Khi liên quan đến biến môi trường, DB, Redis, API bên thứ ba, CSP, Vercel Cron |
| 6 | [`docs/project-memory/BUG_FIX_HISTORY.md`](docs/project-memory/BUG_FIX_HISTORY.md) | **Mọi nhiệm vụ sửa lỗi** (kiểm tra xem lỗi đã từng xảy ra/sửa ở đâu chưa) |
| 7 | [`docs/project-memory/DECISION_LOG.md`](docs/project-memory/DECISION_LOG.md) | Trước khi đề xuất thay đổi kiến trúc, tỷ lệ, UI/UX hoặc phương án kỹ thuật |
| 8 | [`docs/project-memory/KNOWN_ISSUES.md`](docs/project-memory/KNOWN_ISSUES.md) & [`CHANGELOG.md`](docs/project-memory/CHANGELOG.md) | Khi kiểm tra tồn đọng hoặc rà soát các đợt nâng cấp gần nhất |

---

## 2. Những điều TUYỆT ĐỐI KHÔNG ĐƯỢC tự ý làm
* **Không ghi Secret** (API key, token, password, `DATABASE_URL` chứa mật khẩu, nội dung `.env`) vào tài liệu, code hoặc log.
* **Không tự ý đổi nghiệp vụ tài chính:** công thức 2 tầng (`tax 10%` $\rightarrow$ `cashback 70%`), VIP 4 hạng (`70/73/76/80%`), sổ cái `ledger` dưới `withUserLock`, hay xóa vật lý bảng `users`.
* **Không bỏ qua xác nhận (`askUserConfirm`)** ở các thao tác tài chính & kiểm soát tài khoản Admin.
* **Không đảo ngược quyết định trong `DECISION_LOG.md`** nếu chưa phân tích rủi ro và được chủ dự án phê duyệt.
* **Không sửa UI trong `public/` mà quên bump cache** (`public/index.html` `?v=...` và `public/sw.js` `CACHE_NAME` + `SHELL_ASSETS`).
* **Không đánh dấu đã sửa lỗi** nếu chưa chạy kiểm thử xác minh (`npm run lint`, `npm test`, hoặc test E2E liên quan).

---

## 3. Bắt buộc sau khi hoàn thành công việc có thay đổi đáng kể
1. Chạy `npm run lint` (0 lỗi) và bộ test liên quan.
2. Cập nhật đúng các file tương ứng trong `docs/project-memory/` (`BUG_FIX_HISTORY.md`, `DECISION_LOG.md`, `CHANGELOG.md`, `KNOWN_ISSUES.md`, `SYSTEM_CONFIG.md`, `PROJECT_CONTEXT.md`) kèm ngày cập nhật mới nhất.
3. Chỉ stage (`git add`) đúng các file đã thay đổi; tránh commit thư mục untracked như `public/videos/`, `tools/video_build/`.
