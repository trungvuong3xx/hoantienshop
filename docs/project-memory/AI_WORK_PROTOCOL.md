# AI WORK PROTOCOL — Quy Trình Bắt Buộc Cho Mọi AI Agent

> **Cập nhật lần cuối:** 2026-11-28  
> **Áp dụng cho:** Tất cả AI Agent (Antigravity, Claude Code, Cursor, Codex, Copilot...) và Developer làm việc trên repository LiLa Cashback.

---

## 1. TRƯỚC KHI BẮT ĐẦU BẤT KỲ CÔNG VIỆC NÀO
AI Agent **bắt buộc** thực hiện theo thứ tự:
1. Đọc `AGENTS.md` ở thư mục gốc.
2. Đọc `docs/project-memory/PROJECT_CONTEXT.md` để nắm kiến trúc & trạng thái mới nhất.
3. Đọc `docs/project-memory/MODULES.md` để xác định đúng file & phạm vi ảnh hưởng (blast radius).
4. Đọc `docs/project-memory/BUSINESS_RULES.md` nếu công việc liên quan đến tiền, hoa hồng, đơn hàng, VIP, bảng xếp hạng, affiliate, auth hoặc quyền Admin.
5. Đọc `docs/project-memory/SYSTEM_CONFIG.md` nếu công việc liên quan đến biến môi trường, API bên thứ ba, DB, Redis, CSP hoặc deploy.
6. Kiểm tra `docs/project-memory/BUG_FIX_HISTORY.md` và `docs/project-memory/DECISION_LOG.md` để **không sửa lặp lỗi cũ và không phá vỡ quyết định đã thống nhất**.
7. **Đối chiếu với source code thực tế** tại các file liên quan. *Project Memory không thay thế source code — nếu có mâu thuẫn, phải kiểm tra code thật trước khi kết luận.*

---

## 2. QUY TRÌNH ĐẶC BIỆT TRƯỚC KHI SỬA LỖI
Khi nhận yêu cầu sửa lỗi, AI **không được sửa mò ngay**. Phải tra cứu `BUG_FIX_HISTORY.md` và trả lời 6 câu hỏi:
1. Lỗi tương tự đã từng xảy ra chưa?
2. Trước đây đã sửa ở file nào?
3. Nguyên nhân gốc trước đây là gì?
4. Giải pháp cũ hiện còn tồn tại trong code không?
5. Tại sao lỗi xuất hiện trở lại (có phải code mới ghi đè giải pháp cũ không)?
6. Nếu lỗi đã được xử lý và không tái phát, có cần làm lại không?

---

## 3. TRONG QUÁ TRÌNH THỰC HIỆN
* **Tái sử dụng giải pháp hiện có:** Không tạo hàm/module/endpoint trùng lặp (VD: đã có `src/services/compare/*`, `askUserConfirm`, `initPasswordVisibilityToggles`, `withUserLock`, `recalculateUserWallet`).
* **Bảo toàn nghiệp vụ:** Không tự ý sửa công thức Cashback, tỷ lệ 70%, VIP tiers, cơ chế ledger/soft-delete hay quyền Admin nếu chưa được phê duyệt.
* **Không ghi Secret vào code hay tài liệu:** Tuyệt đối không chép giá trị từ `.env`, API key, token, password vào bất kỳ file `.md` hay commit nào.
* **PWA Cache Discipline:** Mọi thay đổi ở `public/app.js` hoặc `public/styles.css` phải đi kèm bump `?v=...` trong `public/index.html` và tăng `CACHE_NAME` + `SHELL_ASSETS` trong `public/sw.js`.
* **Git Hygiene:** Chỉ `git add` đúng các file liên quan đến công việc; tránh `git add -A` khi workspace có thư mục untracked như `public/videos/`, `tools/video_build/`.
* **Kiểm thử bắt buộc trước khi kết luận xong:**
  * Chạy `npm run lint` (0 lỗi).
  * Chạy các test phù hợp (`npm test`, `npm run test:browser`, `npm run test:compare-accuracy`...).
  * Không bao giờ đánh dấu trạng thái `[4-Đã sửa & Test PASS]` nếu chưa chạy kiểm thử thực tế.

---

## 4. SAU KHI HOÀN THÀNH CÔNG VIỆC (CHỐNG TÀI LIỆU LỖI THỜI)
Nếu thay đổi có tác động đáng kể (tính năng mới, sửa lỗi, đổi cấu hình, quyết định mới), AI **phải cập nhật** đúng file trong `docs/project-memory/`:
* Sửa lỗi xong + có bằng chứng test $\rightarrow$ Cập nhật `BUG_FIX_HISTORY.md` (ghi rõ mã, ngày, nguyên nhân, giải pháp, kiểm thử, lưu ý chống tái phát).
* Có quyết định kiến trúc/nghiệp vụ/UI mới $\rightarrow$ Thêm mục vào `DECISION_LOG.md` (không xóa quyết định cũ; nếu thay thế thì đổi trạng thái quyết định cũ thành `Đã thay thế bởi DEC-xxx`).
* Ra tính năng / nâng cấp đáng chú ý $\rightarrow$ Ghi vào `CHANGELOG.md` và cập nhật trạng thái/cache version trong `PROJECT_CONTEXT.md`.
* Thêm/đổi biến môi trường hoặc tích hợp $\rightarrow$ Cập nhật `SYSTEM_CONFIG.md` (**chỉ tên biến, 0 secret**).
* Phát hiện hoặc đóng vấn đề tồn đọng $\rightarrow$ Cập nhật `KNOWN_ISSUES.md`.
* Luôn cập nhật dòng **`Cập nhật lần cuối: YYYY-MM-DD`** ở đầu mỗi file vừa sửa.

## 5. XỬ LÝ MÂU THUẪN GIỮA TÀI LIỆU VÀ CODE
1. Xác định trạng thái thực tế trong source code.
2. Tìm nguyên nhân tài liệu bị lỗi thời (VD: vừa refactor mà quên cập nhật `MODULES.md`).
3. Báo rõ cho người dùng và đề xuất cập nhật tài liệu theo code thật — **không tự ý sửa ngược code theo tài liệu cũ**.
