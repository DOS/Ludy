# Tín hiệu Lộ trình đa kênh và Hộp thư Phân loại Dự án (Triage Inbox): tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [projects-signals-triage.md](projects-signals-triage.md) và quyết định kiến trúc [ADR-0058](../adr/0058-projects-omnichannel-signals-and-triage.md) (`Accepted`), ngày 2026-11-23. Anh JOY đã duyệt hướng triển khai (lựa chọn `A1`) vào `2026-11-23T10:20+07:00` trong phiên `Projects & Notes Product Owner` ([#1210](https://github.com/DOS/Ludy/issues/1210#issuecomment-7090763080)) cho cột mốc `M3 Paid pilot` (`line:projects`, `priority:P1`). Tài liệu bao phủ chuỗi 4 việc: [#4490](https://github.com/DOS/Ludy/issues/4490) (Kế hoạch & ADR-0058), [#4491](https://github.com/DOS/Ludy/issues/4491) (Bước 0 kiểm thử bảo mật), [#4492](https://github.com/DOS/Ludy/issues/4492) (Gói 1: Tín hiệu đa kênh) và [#4493](https://github.com/DOS/Ludy/issues/4493) (Gói 2: Hộp thư Phân loại Dự án, Vy AI và MCP).

## 1. Doanh nghiệp nhỏ (OPC / SME) nhận được gì

Hiện tại Ludy đã có Bảng lộ trình công khai (Public Roadmap theo `ADR-0057`) và Dự án v2 (`ADR-0056`), nhưng góp ý từ khách hàng thật thường nằm rải rác ở Cơ hội bán hàng (CRM), Hộp thư hội thoại (Inbox) và Cuộc họp (Meetings). Đợt nâng cấp này giải quyết hai việc lặp lại hàng tuần mà không làm rối bảng việc của nhóm nhỏ:

1. **Gói 1 - Tín hiệu Lộ trình đa kênh ([#4492](https://github.com/DOS/Ludy/issues/4492), lấy cảm hứng từ Productlane và Cycle):**
   - Nhân viên bán hàng, chăm sóc khách hàng hoặc chủ doanh nghiệp có thể bấm gắn trực tiếp một **Cơ hội bán hàng (`crm.deal`)**, **Hội thoại khách hàng (`kernel.conversation`)** hoặc **Cuộc họp (`meetings.meeting`)** vào một mục trong Lộ trình nội bộ (`roadmap_item`) chỉ với 1-2 thao tác.
   - Mỗi tín hiệu (`roadmap_signal`) lưu tên khách hàng tham chiếu (`account_label`), trích đoạn lời khách (`quote_excerpt`) và giá trị cơ hội bán hàng (`deal_value` kèm mã tiền tệ ISO như `VND`, `USD`).
   - Hệ thống tự cộng tổng giá trị nhu cầu **tách riêng theo từng loại tiền tệ** (dùng phép tính số thập phân chính xác `decimal.js` qua `@ludy/l10n-vn`, tuyệt đối không cộng gộp `VND` với `USD` hay dùng số thực trôi nổi của JavaScript).
2. **Gói 2 - Hộp thư Phân loại Dự án - Triage Inbox ([#4493](https://github.com/DOS/Ludy/issues/4493), lấy cảm hứng từ Linear Triage):**
   - Mọi yêu cầu thô từ Lộ trình công khai, Hộp thư hội thoại, Cuộc họp hoặc ghi nhận nhanh được gom vào bảng đệm riêng (`project_triage_item`), hoàn toàn tách biệt khỏi bảng công việc chính (`ludy_kernel.task`), màn hình Việc của tôi, giới hạn cột WIP, Chu kỳ (Cycles) hay biểu đồ Gantt.
   - Người phụ trách rà soát và bấm một trong các nút rõ ràng: **Chấp nhận (`Accept` - tạo thành việc thật trên bảng)**, **Gộp vào việc có sẵn (`Merge`)**, **Tạm hoãn (`Snooze`)**, **Từ chối (`Decline`)** hoặc **Mở lại (`Reopen`)** đối với các mục đang hoãn hoặc đã từ chối.

## 2. Nguyên tắc bảo mật, tách biệt mô-đun và quyền riêng tư

Giải thích nhanh thuật ngữ kỹ thuật:
- **ADR (Architecture Decision Record):** Văn bản ghi lại quyết định thiết kế kiến trúc lâu dài.
- **oRPC:** Kênh gọi hàm nội bộ có xác thực đăng nhập giữa giao diện web và máy chủ Ludy (không mở đường dẫn web công khai).
- **RLS (Row-Level Security):** Luật khóa dữ liệu ở từng dòng ngay trong cơ sở dữ liệu PostgreSQL, đảm bảo công ty này không bao giờ thấy dữ liệu công ty khác và người ngoài dự án mật không đọc được dự án mật.
- **MCP (Model Context Protocol):** Cổng kết nối chỉ đọc có cấp phép để tác tử AI bên ngoài (như trợ lý làm việc của chủ doanh nghiệp) tra cứu tóm tắt dữ liệu an toàn.
- **PDPL & `org_purge`:** Quy trình tìm/xóa dữ liệu cá nhân theo luật bảo vệ dữ liệu cá nhân (PDPL) và hàm xóa sạch dữ liệu khi công ty rời hệ thống.
- **`shared-core`:** Vùng mã lõi dùng chung của nền tảng, khi sửa bắt buộc có PO Nền tảng duyệt chéo.

Các rào chắn an toàn áp dụng cho cả 2 gói:

1. **Đọc chéo ứng dụng đúng quyền người bấm (`ctxQueryFn`):** Dự án (`modules/projects`) không nhập trực tiếp mã nguồn của CRM hay Cuộc họp và không nối bảng SQL chéo mô-đun. Mọi lượt đọc cơ hội, hội thoại hay cuộc họp đều đi qua hàm truy vấn theo đúng ngữ cảnh người dùng đang bấm (`ctxQueryFn`), nên hội thoại riêng tư hay biên bản cuộc họp mật mà người đó không có quyền xem sẽ bị chặn ngay từ gốc.
2. **Không lộ thông tin thương mại ra Lộ trình công khai:** Bảng công khai `/-/roadmap/:orgSlug/:boardSlug` (`public_roadmap_view`) tuyệt đối không đọc bảng `roadmap_signal`, không bao giờ để lộ tên khách hàng (`account_label`), giá trị hợp đồng (`deal_value`) hay trích dẫn nội bộ (`quote_excerpt`).
3. **Cách ly dự án riêng tư (`#2604`) cho Hộp thư Triage:** Bảng `project_triage_item` gắn thẳng khóa bảo mật `RESTRICTIVE` (`project_visibility`) giống các bảng khác của Dự án v2. Thành viên không được mời vào dự án riêng tư (`visibility = 'private'`) sẽ thấy 0 dòng dữ liệu cả trên giao diện, truy vấn SQL lẫn cổng MCP.
4. **Không mở thêm đường dẫn web không cần đăng nhập:** Toàn bộ API tín hiệu và hộp thư Triage chạy qua kênh `oRPC` có xác thực phiên đăng nhập, không mở thêm route ngoài `apps/kernel/src/http.ts`.
5. **Thứ tự khóa dữ liệu chống kẹt (`position -> project`):** Khi người dùng bấm **Chấp nhận (`Accept`)** một mục trong Triage thành công việc thật, máy chủ luôn khóa hàng vị trí phụ trách (`ludy_kernel.position`) trước rồi mới khóa hàng dự án (`project`), tránh xung đột khóa chéo (deadlock) với các luồng sửa dự án khác.

## 3. Vai trò của Vy (AI) và cổng MCP

- **Tắt AI vẫn chạy đủ 100%:** Toàn bộ việc gắn tín hiệu từ CRM/Inbox/Meetings, tính tổng tiền theo từng loại tiền tệ, và các thao tác `Accept`, `Merge`, `Snooze`, `Decline`, `Reopen` đều hoạt động bình thường bằng mã cố định khi tắt AI hoặc hết ngân sách AI.
- **Hai trợ giúp của Vy qua đồng hồ ngân sách AI (`AI_FEATURES` nhóm `'projects'`):**
  1. **`projects.roadmap_signal_match` (Gói 1, `#4492`):** Vy đọc nội dung tín hiệu đã bọc khung dữ liệu chưa kiểm chứng (`<<< >>>`) và gợi ý các mục lộ trình phù hợp để gắn (hoặc phác thảo tên ý tưởng mới). Mã kiểm tra đối chiếu chặt từng mã UUID trả về với danh sách thật trên bảng, chặn liên kết ngoài (`draftLinksOutside`) và luôn chờ con người bấm xác nhận mới lưu.
  2. **`projects.triage_assist` (Gói 2, `#4493`):** Vy gợi ý xem mục Triage mới có bị trùng với công việc đang mở nào không, kèm gợi ý mức ưu tiên, người phụ trách phù hợp trong dự án và chu kỳ đang chạy. Mọi mã gợi ý đều phải nằm trong danh sách hợp lệ của chính dự án đó; con người vẫn là người bấm **Chấp nhận** hoặc **Gộp**.
- **Truy vấn đọc MCP (`projects.mcp.triage_summary`, Gói 2 `#4493`):** Chỉ mở cho kết nối cấp công ty của chủ sở hữu hoặc quản trị viên (`ludy.read`), loại bỏ toàn bộ dự án riêng tư (`visibility = 'private'`), ẩn lý do từ chối và làm sạch từng dòng văn bản (`plainLine`) kèm nhãn nguồn tin cậy/chưa kiểm chứng (`tainted`).

## 4. Lộ trình thực hiện theo từng PR

Lưu ý tên lược đồ SQL (`ADR-0054`): hiện tại trên nhánh chính (`main`), lõi hệ thống đã đổi sang `ludy_kernel` và vai trò `ludy_tenant` (`#3970`), còn bảng của Dự án vẫn dùng `crove_projects` trong lúc chờ gói `#3971` đổi sang `ludy_projects`. Nếu `#3971` gộp vào `main` trước, các PR dưới đây dùng ngay tiền tố `ludy_projects`.

| Bước | Issue | Nội dung chính | Yêu cầu kiểm thử & rà soát |
| --- | --- | --- | --- |
| Kế hoạch & ADR-0058 | [#4490](https://github.com/DOS/Ludy/issues/4490) | Kế hoạch song ngữ (`projects-signals-triage.md`, `projects-signals-triage.vi.md`), `ADR-0058`, cập nhật tham chiếu trong `projects-public-roadmap.md` và `projects-v2.md` | Chỉ sửa tài liệu (`pnpm docs:check`) |
| Bước 0 (Chuẩn bị kiểm thử) | [#4491](https://github.com/DOS/Ludy/issues/4491) | Đăng ký trước 2 bảng `roadmap_signal` và `project_triage_item` vào `PENDING_TABLES` và `ROW_FACTORIES` trong `rls-matrix.db.test.ts` | Bảo vệ vùng invariant; duyệt bảo mật độc lập; gộp trước Gói 1 và Gói 2 |
| Gói 1 (Tín hiệu đa kênh) | [#4492](https://github.com/DOS/Ludy/issues/4492) | Bảng `roadmap_signal`, mở rộng `ctxQueryFn` đọc CRM/Inbox/Meetings, tổng hợp tiền tệ `decimal.js` qua `@ludy/l10n-vn`, gộp tín hiệu khi gộp ý tưởng, Vy `roadmap_signal_match`, PDPL/offboarding/`org_purge`, giao diện gắn tín hiệu & xem tổng nhu cầu | Phụ thuộc `#4490`, `#4491`; duyệt `shared-core` (PO Nền tảng) + duyệt bảo mật độc lập |
| Gói 2 (Hộp thư Triage, Vy & MCP) | [#4493](https://github.com/DOS/Ludy/issues/4493) | Bảng `project_triage_item` với khóa RLS dự án riêng tư `#2604`, các lệnh `create/list/accept/merge/snooze/decline/reopen`, Vy `triage_assist`, công cụ đọc MCP `projects.mcp.triage_summary`, PDPL/offboarding/`org_purge`, giao diện tab Triage trong dự án và hộp thư Triage chung | Phụ thuộc `#4490`, `#4491`; duyệt `shared-core` (PO Nền tảng) + duyệt bảo mật độc lập |
