# Tích hợp GitHub Issue và Pull Request cho Dự án (Opt-in): Tóm tắt cho chủ sở hữu

> **Trạng thái: Đã duyệt (`Accepted`)** - anh JOY đã duyệt cả 4 phương án đề xuất (`D-1` đến `D-4`) vào `2026-11-27 04:07+07:00`, ghi nhận tại [bình luận #1210](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474) và [bình luận #5126](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822). Quyết định kiến trúc hiệu lực: [ADR-0060](../adr/0060-projects-github-issue-pr-sync.md) (`Accepted`). Ngày: 2026-11-26 (duyệt 2026-11-27). Bản kế hoạch đầy đủ tiếng Anh: [projects-github-integration.md](projects-github-integration.md). Issue thiết kế: [#5126](https://github.com/DOS/Ludy/issues/5126) (các issue xây dựng Bước 0, Gói 1, Gói 2 sẽ mở dưới `#5126`, mã issue TBD).

Giải thích nhanh thuật ngữ kỹ thuật:
- **ADR (Architecture Decision Record):** Văn bản chốt các ranh giới kiến trúc và bảo mật trước khi viết mã.
- **GitHub App / Fine-grained PAT:** Hai cách kết nối Ludy với GitHub. GitHub App cài ở cấp tổ chức (cấp token ngắn hạn 1 giờ, không phụ thuộc vào một tài khoản cá nhân); Fine-grained PAT là mã truy cập giới hạn theo từng kho mã (dễ tự cài khi chạy `docker compose up`, nhưng có hạn sử dụng tối đa 1 năm).
- **Webhook & HMAC-SHA256 (`X-Hub-Signature-256`):** Tín hiệu GitHub gửi về khi có PR/Issue thay đổi, kèm chữ ký mật mã để Ludy kiểm chứng đúng từ GitHub gửi tới.
- **Egress allowlist & SSRF:** Danh sách tên miền cho phép gọi ra ngoài (chỉ `api.github.com`) và khóa chống gọi nhầm vào mạng nội bộ.
- **Loop-breaker:** Cơ chế chống lặp vòng vô tận khi đồng bộ 2 chiều giữa Ludy và GitHub.
- **`shared-core`:** Phần lõi dùng chung toàn hệ thống; mỗi khi sửa cần PO Nền tảng duyệt chéo.

---

## 1. Doanh nghiệp nhỏ (OPC / SME) nhận được gì và phạm vi gọn nhất

Nhóm làm phần mềm, agency và lập trình viên độc lập thường quản lý công việc tuần trong **Dự án (`Projects`)** nhưng mã nguồn, Issue và Pull Request (PR) nằm trên **GitHub**. Đợt thiết kế này giúp tự động nối tiến độ GitHub vào thẻ việc Ludy mà không làm phức tạp thêm sản phẩm cho các doanh nghiệp không làm phần mềm:

1. **Mặc định tắt hoàn toàn (`opt-in` 2 lớp):** Công ty một người hoặc SME phi kỹ thuật (kế toán, bán lẻ, dịch vụ) không thấy bất kỳ nút GitHub hay mã thẻ `WEB-42` nào. Chỉ khi chủ sở hữu hoặc quản trị viên chủ động kết nối GitHub cho tổ chức và gắn kho mã vào một dự án thì tính năng mới hiện ra.
2. **Gói 1 (Đồng bộ 1 chiều từ GitHub vào Ludy):**
   - Gắn trực tiếp Issue hoặc PR của GitHub vào thẻ việc trên Ludy (bằng tay hoặc tự động khi tên nhánh, tiêu đề hay mô tả PR nhắc tới mã việc dạng `#/WEB-42` hoặc `Fixes WEB-42`).
   - Khi PR được mở (`pull_request.opened`), việc đang ở `Cần làm` tự động chuyển sang `Đang làm`; khi PR được gộp (`merged`) hoặc Issue gắn kết được đóng trên GitHub, thẻ việc tự động chuyển sang `Xong` (hoặc cột đã cấu hình), vẫn tôn trọng quy tắc khóa việc khi tác tử AI đang chạy (`ADR-0029`).
3. **Gói 2 (Tùy chọn bật đồng bộ 2 chiều + Trợ lý Vy):**
   - Tùy chọn bật thêm (`outbound_close_issue_on_done`, mặc định tắt): khi thành viên kéo việc trên Ludy sang `Xong` (hoặc mở lại), hệ thống mới xếp hàng gọi GitHub để đóng/mở lại đúng **GitHub Issue** đã gắn (không bao giờ tự đóng nhầm Pull Request), có cơ chế **chống lặp vòng (loop-breaker)** để webhook phản hồi từ GitHub không chạy ngược lại.
   - **Vy** (đồng nghiệp AI tổng quản) hỗ trợ tóm tắt ngắn gọn tình trạng các PR/Issue gắn với thẻ việc (`projects.github_pr_summary`) và gợi ý Issue phù hợp để gắn (`projects.github_issue_match`) qua đồng hồ đo ngân sách AI (`metered(...)`, `AI_FEATURES` `'projects'`). Tắt AI hoặc hết ngân sách thì toàn bộ việc gắn kết và đồng bộ vẫn chạy đủ 100%.

**Ngoài phạm vi (để Icebox/bỏ qua):** GitHub Enterprise Server tự host (tên miền tùy chỉnh), bảng điều khiển đa tổ chức kiểu đại lý, đồng bộ từng dòng bình luận/diff mã nguồn về Ludy, kích hoạt CI/CD, tự tạo GitHub Issue hàng loạt cho mọi thẻ việc, hoặc bộ dựng luật tự động hóa nhiều bước.

---

## 2. Nguyên tắc bảo mật, lưu khóa và quyền con người

1. **Không lưu mật khẩu/token dạng thô trong mô-đun Dự án:** Toàn bộ token kết nối hoặc bí mật webhook được niêm phong mã hóa AES-256-GCM trong `ludy_kernel.credential` (tái sử dụng kiến trúc `ADR-0025`). Tiến trình API (`ludy_app`) **không bao giờ** giải mã được token; chỉ tiến trình nền (`ludy_worker`) trong ngữ cảnh `system` mới mở được token để gọi GitHub, và tự động ngắt quyền nếu người kết nối rời tổ chức hoặc bị hạ quyền.
2. **Kiểm tra chữ ký webhook & chống phát lại:** Đường dẫn webhook xác thực chữ ký `X-Hub-Signature-256` theo thời gian hằng số (`timingSafeEqual`), giới hạn dung lượng thân tin (`256 KB`), giới hạn tần suất theo IP/hook, khử trùng lặp theo mã giao hàng `X-GitHub-Delivery`, và xóa ngay nội dung thô sau khi xử lý. Nếu tổ chức tắt ứng dụng Dự án (`ADR-0053`), webhook trả `404` mờ hoặc bỏ qua an toàn.
3. **Chỉ gọi ra duy nhất `https://api.github.com`:** Mọi lệnh gọi GitHub đi qua lớp bảo vệ egress của `packages/kernel-runtime`, không theo chuyển hướng (`maxRedirects: 0`), chặn IP nội bộ (chống SSRF). Gói 2 bổ sung phương thức `PATCH` vào `GuardedRequest` (qua duyệt `shared-core` của PO Nền tảng).
4. **Đánh dấu dữ liệu ngoài (`tainted = true`, `ADR-0018`):** Tiêu đề Issue/PR, tên nhánh và tên tác giả từ GitHub luôn mang cờ `tainted = true`, hiển thị dạng văn bản thuần (chống XSS), không tự tạo thẻ việc mới trên Ludy từ Issue bên ngoài chưa kiểm duyệt, và được bọc khung `<<< >>>` trước khi đưa cho Vy đọc.
5. **Quyền hạn & Dự án riêng tư (`#2604`):** Chỉ `owner`/`admin` của tổ chức mới kết nối được GitHub và bật quyền đóng Issue 2 chiều; thành viên chỉ gắn/gỡ Issue/PR trên các dự án mình được xem; mọi bảng mới có `project_id` đều gắn khóa `RESTRICTIVE project_visibility` để dự án mật tuyệt đối không lộ dữ liệu.

---

## 3. Lộ trình 3 bước xây dựng (mã issue TBD, sẽ mở dưới `#5126`)

1. **Bước 0 (Chuẩn bị kiểm thử bảo mật, `shared-core`):** Đăng ký trước các bảng `ludy_projects.github_*` vào bộ kiểm thử bất biến `rls-matrix` (`PENDING_TABLES` / `MACHINERY`), `projects-private`, danh sách route công khai (`route-coverage`, `app-gate-routes`), và khai báo egress `channels.github` trong `job-egress`.
2. **Gói 1 (`priority:P1`, đồng bộ từ GitHub vào Ludy):** Lưu cấu hình dự án (`github_project_binding`, `github_project_repo`), liên kết thẻ việc (`github_task_link`), mã việc tùy chọn (`project_task.task_number`), nhật ký đồng bộ (`github_sync_delivery`), lệnh hệ thống cập nhật trạng thái (`kernel.task.sync_external_status`), bộ đọc webhook + worker cập nhật trạng thái khi PR mở/gộp hoặc Issue đóng, và giao diện cài đặt + gắn thẻ việc.
3. **Gói 2 (`priority:P1`, đồng bộ 2 chiều tùy chọn + Trợ lý Vy):** Mở rộng `PATCH` trong `egress.ts` (`shared-core`), công tắc xác nhận `outbound_close_issue_on_done`, worker đẩy `PATCH` đóng/mở lại GitHub Issue kèm cơ chế chống lặp vòng 3 lớp, hai trợ lý Vy (`github_pr_summary`, `github_issue_match`), và bộ kiểm thử chống lặp + chống prompt injection.

---

## 4. Các quyết định anh JOY đã chốt (2026-11-27, theo đề xuất)

Anh JOY đã duyệt cả 4 quyết định `D-1` đến `D-4` lúc `2026-11-27 04:07+07:00` ([bình luận #1210](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474), [bình luận #5126](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822)):

| # | Câu hỏi | Đã chốt (JOY, 2026-11-27) | Lý do và tác động |
| --- | --- | --- | --- |
| **D-1** | **Cách xác thực với GitHub ở Gói 1?** | **GitHub App Installation (chính) + Fine-grained PAT (dự phòng tự cài `docker compose up`)** | An toàn cho đội nhóm (token ngắn hạn 1 giờ, không đứt khi lập trình viên nghỉ việc), đồng thời bản tự host chạy được ngay không cần đăng ký GitHub App; hỗ trợ 2 luồng nhận webhook (`global` và `:hookKey`). |
| **D-2** | **Nơi lưu token GitHub đã mã hóa?** | **Dùng lại `ludy_kernel.channel_connection` + `ludy_kernel.credential`** (lọc tách khỏi danh sách kênh Mạng xã hội) | Tái sử dụng trọn bộ mã hóa AES-256-GCM, xoay khóa (`credential-reseal`), kiểm tra quyền `owner`/`admin`, tự ngắt khi người kết nối rời tổ chức; 0 mật khẩu lưu ở `ludy_projects` (PO Nền tảng duyệt phần lọc `shared-core` ở `channels.ts`). |
| **D-3** | **Định dạng mã việc để tự nối PR/nhánh?** | **Tiền tố tùy chọn theo dự án (`task_key_prefix`, ví dụ `WEB-42`) + `project_task.task_number`** (chỉ cấp khi bật tích hợp GitHub), kèm `#/<task-key>` và link việc Ludy | Đúng thói quen dev (`feat/WEB-42-fix`, `Fixes WEB-42`), dự án không bật GitHub hoàn toàn không bị rối mắt, và giữ nguyên bảng lõi `ludy_kernel.task`. |
| **D-4** | **Phạm vi và lộ trình 2 gói?** | **Chia 2 gói `priority:P1` (Gói 1 đồng bộ vào trước; Gói 2 đồng bộ 2 chiều `Done <-> Close` tùy chọn với cơ chế chống lặp, `PATCH` egress + Vy AI sau)** | Giao giá trị sớm ở Gói 1 mà chưa cần quyền ghi GitHub, rồi khóa chặt cơ chế chống lặp và Vy AI ở Gói 2 (issue Bước 0, Gói 1, Gói 2 sẽ mở dưới `#5126`, mã TBD). |
