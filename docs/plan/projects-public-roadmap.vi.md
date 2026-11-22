# Lộ trình công khai của Dự án (Public Roadmap): tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [projects-public-roadmap.md](projects-public-roadmap.md) và [ADR-0057](../adr/0057-projects-public-roadmap-ideas-voting-changelog.md) (`Accepted`), ngày 2026-11-22. Anh JOY đã chốt hướng đi và các quyết định vào ngày `2026-11-22T10:04+07:00` trong phiên `Projects & Notes Product Owner` ([#1210](https://github.com/DOS/Ludy/issues/1210#issuecomment-7073382197)). Mục tiêu là mang lại trang Lộ trình công khai (Public Roadmap) gọn nhẹ 3 thẻ giống Frill.co và UserJot, kết hợp các khả năng AI bản địa (AI-native) học từ Quackback, Productlane và Cycle trên nền tảng hợp nhất của Ludy.

## 1. Người dùng và doanh nghiệp nhỏ được gì

Nhiều doanh nghiệp nhỏ, đội sản phẩm, công ty dịch vụ và người làm sản phẩm độc lập cần một trang công khai để nhận góp ý từ khách hàng, đo mức độ quan tâm qua lượt bình chọn (upvote), cho khách xem tính năng nào đang được lên kế hoạch hoặc đang làm, và thông báo khi tính năng ra mắt.

- **Giao diện công khai 3 thẻ sạch gọn (`/-/roadmap/:orgSlug/:boardSlug`):**
  1. **Ý tưởng (`Ideas`):** Khách xem tự do không cần đăng nhập; tìm kiếm, lọc theo chủ đề, bấm bình chọn hoặc gửi ý tưởng mới.
  2. **Lộ trình (`Roadmap`):** 3 cột rõ ràng gồm **Dự kiến (`Planned`)**, **Đang làm (`In Progress`)** và **Đã phát hành (`Shipped`)**.
  3. **Nhật ký thay đổi (`Changelog`, Gói 2):** Tổng hợp các bản cập nhật đã phát hành kèm thẻ tính năng liên quan và tùy chọn nhận thông báo.
- **Chế độ nhúng khung (`?embed=1`):** Có thể nhúng bảng lộ trình vào trang web hoặc phần mềm của công ty thông qua khung iframe, nhưng chỉ cho phép đúng danh sách tên miền HTTPS mà chủ sở hữu đã cấu hình.
- **Cổng riêng cho từng khách hàng (`#2603`) vẫn giữ trong Icebox:** Trang này là lộ trình sản phẩm công khai, tách biệt hoàn toàn với cổng dự án nội bộ có đăng nhập riêng cho từng khách hàng (`#2603`).

## 2. Quyết định đã chốt (2026-11-22)

1. **`A1` - Xem miễn phí, xác thực 1 chạm bằng mã OTP 6 chữ số qua email (không mật khẩu, không CAPTCHA bên thứ ba theo `#203`):**
   - Khách truy cập xem toàn bộ **Ý tưởng**, **Lộ trình** và **Nhật ký thay đổi** mà không cần tạo tài khoản hay mật khẩu.
   - Ở lần đầu bấm **Bình chọn** hoặc **Gửi ý tưởng**, khách nhập email để nhận mã OTP (mã dùng một lần) 6 chữ số qua email. Cách làm này dùng lại luồng gửi email OTP sẵn có của Ludy, không dùng dịch vụ CAPTCHA của bên thứ ba (`#203`) để bản tự lưu trữ `docker compose up` chạy trọn vẹn ngay từ đầu.
   - Khách đã xác thực có thể bật nhận email thông báo khi ý tưởng được phát hành (`notify_on_ship`) và hủy đăng ký bất kỳ lúc nào qua một lần bấm.
2. **`A2` - Thứ tự ưu tiên triển khai:**
   - Làm ngay kế hoạch, tài liệu quyết định kiến trúc `ADR-0057` (`#4397`) và Bước 0 đăng ký kiểm thử bảo mật (`#4398`) song song mà không làm gián đoạn Đợt 1 của Dự án v2 (`#4361`, `#2605`, `#2601`, `#2604`).
   - Sau khi Đợt 1 xong, ưu tiên xây dựng Lộ trình công khai (`#4399`, `#4400`) ngay sau Đợt 1 (trước hoặc song song với Đợt 2 gồm biểu đồ Gantt `#2599` và chấm giờ làm `#2600`).
3. **Bật tùy chọn theo từng công ty (tiêu chí OPC/SME):**
   - Mặc định **tắt** (`enabled = false`) để không làm rối các công ty chỉ dùng quản lý việc nội bộ.
   - Khi cần, chủ sở hữu hoặc quản trị viên bấm bật bảng công khai trong 1 chạm với cấu hình sẵn sàng cho doanh nghiệp nhỏ: cho phép gửi ý tưởng, cho phép bình chọn, và luôn qua hàng đợi kiểm duyệt (`require_moderation = true`).

## 3. Tách biệt bảo mật và không rò rỉ dữ liệu nội bộ

- **Trang công khai tuyệt đối không đọc bảng dự án hay công việc lõi (`crove_projects.project`, `crove_kernel.task`):** Toàn bộ dữ liệu công khai nằm riêng trong các bảng `roadmap_board`, `roadmap_item`, `roadmap_vote` và `roadmap_announcement`.
- **Khóa cứng dự án riêng tư (`#2604`, `ADR-0056`):** Hệ thống và cơ sở dữ liệu chặn thẳng việc gắn một dự án chế độ riêng tư (`visibility = 'private'`) vào bảng lộ trình công khai, đồng thời chặn việc chuyển một dự án đang gắn bảng công khai sang chế độ riêng tư. Nếu một mục lộ trình có liên kết tới công việc nội bộ (`linked_task_id`), hệ thống chỉ đồng bộ trạng thái tiến độ chứ **không bao giờ** lộ người phụ trách, bình luận, tệp đính kèm hay ghi chú nội bộ.
- **Ẩn danh email người bình chọn và khóa bảng `MACHINERY` (chỉ hàm đặc quyền trong CSDL được chạm):**
  - Bảng phiếu bầu (`roadmap_vote`) chỉ lưu mã băm một chiều (`voter_email_hash`), không lưu email gốc.
  - Hai bảng nhạy cảm là `roadmap_otp` (mã OTP 6 số dạng băm SHA-256, hết hạn sau 10 phút, khóa sau 5 lần sai, giới hạn tần suất theo IP/bảng/email) và `roadmap_subscriber` (email người đăng ký nhận tin đã niêm phong cùng mã hủy đăng ký dạng băm) nằm trong nhóm `MACHINERY` (không cấp quyền đọc/ghi cho tài khoản ứng dụng thông thường).
- **Tôn trọng công tắc tắt ứng dụng (`ADR-0053`) và danh sách chặn gửi thư (`mail_suppression`):** Nếu công ty tắt ứng dụng Dự án hoặc chưa bật bảng công khai, đường dẫn công khai trả về mã `404` giống hệt trang không tồn tại để không lộ thông tin doanh nghiệp. Mọi email OTP và email báo phát hành đều kiểm tra danh sách chặn gửi thư.

## 4. Vai trò của Vy (AI) và cổng kết nối MCP

- **Tắt AI vẫn chạy đủ 100%:** Toàn bộ việc duyệt trang, gửi OTP, bình chọn, gửi ý tưởng, hàng đợi kiểm duyệt, gộp ý tưởng trùng, chuyển thành việc nội bộ, xuất bản Nhật ký thay đổi và gửi thông báo phát hành đều hoạt động bằng mã cố định khi tắt AI hoặc hết ngân sách AI.
- **Nội dung khách gửi là dữ liệu chưa kiểm chứng (`tainted = true`):** Mọi ý tưởng từ bên ngoài luôn ở trạng thái chờ duyệt (`pending`) và được đánh dấu `tainted` (dữ liệu bên ngoài, [ADR-0018](../adr/0018-untrusted-content.md)) để tránh chèn mã độc hay câu lệnh lừa AI.
- **Hai việc Vy hỗ trợ (đi qua đồng hồ ngân sách AI `AI_FEATURES` ở Gói 2 `#4400`):**
  1. **Gom nhóm trùng lặp và chủ đề nhu cầu (`projects.roadmap_dedupe`):** Vy đọc các ý tưởng công khai như dữ liệu thô (`tools: []`), gợi ý các mục trùng nhau và chủ đề khách hỏi nhiều nhất. Con người vẫn là người bấm xác nhận gộp hoặc chuyển thành công việc nội bộ.
  2. **Soạn thảo Nhật ký thay đổi (`projects.roadmap_changelog_draft`):** Từ danh sách các mục đã `Shipped` mà người dùng chọn, Vy soạn bản nháp tiếng Việt gọn rõ theo phong cách Frill; bộ kiểm tra số liệu (`summaryNumbersOutside`) chặn mọi con số bịa đặt không có trong dữ liệu đầu vào. Con người sửa và bấm **Xuất bản** mới hiển thị và gửi email thông báo.
- **Sẵn sàng cho tác tử qua MCP (`ADR-0051`):** Gói 2 mở các truy vấn chỉ đọc chuẩn MCP (như đọc danh sách ý tưởng, lượt bình chọn, chủ đề nổi bật) để các tác tử AI của công ty tra cứu nhu cầu khách hàng mà không chạm vào email người dùng.
- **Mở rộng tương lai (chưa xây trong M3 này):** Tài liệu giữ sẵn thiết kế tách biệt để sau này có thể gom thêm đề xuất tính năng từ CRM, Hộp thư và Cuộc họp vào hàng đợi kiểm duyệt.

## 5. Các bước thực hiện (mỗi bước một issue, một PR)

Giải thích từ ngữ: **ADR** là văn bản ghi quyết định kiến trúc; **PR** là gói thay đổi mã chờ duyệt; **`shared-core`** là vùng mã dùng chung cần PO Nền tảng duyệt chéo.

| Bước | Issue | Nội dung chính | Lưu ý bảo mật và điều kiện tiên quyết |
| --- | --- | --- | --- |
| Kế hoạch & ADR | [#4397](https://github.com/DOS/Ludy/issues/4397) | Kế hoạch song ngữ (`projects-public-roadmap.md`, `projects-public-roadmap.vi.md`), `ADR-0057`, cập nhật tham chiếu trong `projects.md` và `projects-v2.md` | Chỉ sửa tài liệu (`pnpm docs:check`) |
| Bước 0 (Chuẩn bị kiểm thử) | [#4398](https://github.com/DOS/Ludy/issues/4398) | Đăng ký trước 6 bảng mới (`roadmap_board`, `roadmap_item`, `roadmap_vote`, `roadmap_announcement`, `roadmap_otp`, `roadmap_subscriber`) vào bộ kiểm thử quyền (`rls-matrix.db.test.ts` `PENDING_TABLES` và `MACHINERY`) và 5 đường dẫn API công khai vào `route-coverage.test.ts` `PENDING` | Chạm vùng kiểm thử bảo mật và `shared-core`; gộp trước Gói 1 và Gói 2 |
| Gói 1 (Luồng lõi) | [#4399](https://github.com/DOS/Ludy/issues/4399) | Tạo 5 bảng lõi và cập nhật `org_purge`, chặn dự án riêng tư, xác thực email OTP 6 số, 5 API công khai, giao diện `/-/roadmap/:orgSlug/:boardSlug` (2 thẻ `Ideas` và `Roadmap`), màn hình bật bảng và kiểm duyệt nội bộ | Phụ thuộc `#4398`; chạy đủ 100% không cần AI |
| Gói 2 (Changelog, Nhúng & AI) | [#4400](https://github.com/DOS/Ludy/issues/4400) | Tạo bảng `roadmap_announcement`, thẻ `Changelog`, chế độ nhúng `?embed=1` với khóa tên miền CSP `frame-ancestors`, gửi email thông báo khi phát hành (có bước con người bấm xác nhận và hủy đăng ký 1 chạm), Vy gom trùng (`roadmap_dedupe`), Vy soạn thảo (`roadmap_changelog_draft`), và công cụ đọc MCP | Phụ thuộc `#4398` và `#4399`; chạy đủ 100% không cần AI |
