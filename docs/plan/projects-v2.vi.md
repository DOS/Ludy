# Dự án v2: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [projects-v2.md](projects-v2.md) và [ADR-0056](../adr/0056-projects-v2-cycles-columns-dependencies-privacy.md) (`Accepted`), ngày 2026-11-22. Anh JOY đã chốt các quyết định `A1`, `A2`, `A3` ngày 2026-11-22 trong phiên `Projects & Notes Product Owner` ([#1210](https://github.com/DOS/Ludy/issues/1210#issuecomment-7072041736)). Bản v1 từ [projects.md](projects.md) cùng 5 mục nâng cao đầu tiên (`#2606` đến `#2610`) đã xong trên nhánh chính; bản v2 mở rộng theo 2 đợt để ngang tầm Linear, Plane và Jira mà vẫn giữ mặc định gọn nhẹ cho công ty một người.

## Quyết định đã chốt (2026-11-22)

1. **`A1` - Phạm vi và thứ tự 2 đợt (`M3 Paid pilot`):**
   - **Đợt 1 (`priority:P1`):**
     - **Chu kỳ / Sprint và Điểm công việc (`#4361`):** Bật tùy chọn theo từng dự án (`1` đến `4` tuần, điểm `0` đến `100`), biểu đồ tiến độ và tốc độ xử lý tính bằng mã, kết thúc chu kỳ bắt buộc người dùng chọn chuyển việc dang dở sang backlog hay chu kỳ kế tiếp.
     - **Cột tùy chỉnh theo dự án (`#2605`):** Mặc định vẫn giữ 5 cột trạng thái sẵn có; khi cần, dự án mở rộng tối đa 12 cột (có giới hạn số việc WIP, màu theo bảng màu chuẩn), mỗi cột ánh xạ về trạng thái chuẩn của việc để người và tác tử AI hiểu thống nhất.
     - **Phụ thuộc giữa các việc (`#2601`):** Gắn quan hệ "chặn / bị chặn" trong cùng dự án, tự kiểm tra không tạo vòng lặp, cảnh báo nút thắt cổ chai, giữ nguyên cấu trúc giao việc của tác tử AI.
     - **Dự án riêng tư (`#2604`):** Chế độ `private` chỉ cho thành viên được mời vào dự án, người phụ trách dự án, chủ sở hữu / quản trị viên tổ chức và tác tử AI được giao đúng vị trí xem; người ngoài dự án không thấy cả việc, bình luận lẫn ghi chú liên kết.
   - **Đợt 2 (`priority:P2`):**
     - **Biểu đồ tiến độ Timeline / Gantt (`#2599`, sau `#2601`):** Xem theo tuần/tháng, kéo hoặc dùng bàn phím chỉnh ngày bắt đầu và hạn chót, mũi tên phụ thuộc, cảnh báo xung đột ngày bằng mã.
     - **Chấm giờ làm và giờ tính tiền bản gọn (`#2600`):** Bấm giờ trực tiếp (tối đa 1 đồng hồ đang chạy mỗi người) hoặc nhập tay, đánh dấu giờ tính phí và đơn giá, tổng hợp số tiền chính xác bằng `decimal.js` và xuất CSV; **chưa tự xuất hóa đơn sang Kế toán hay đồng bộ bảng lương**.
   - **Giữ nguyên trong Icebox (`priority:P3`):** Lập kế hoạch nhân lực đa dự án (`#2602`) và Cổng cho khách hàng ngoài tổ chức (`#2603`).
2. **`A2` - Sửa quy tắc bảo mật cho dự án riêng tư (`#2604`):** Đồng ý sửa quyết định `D-2` của [ADR-0048](../adr/0048-projects-on-kernel-tasks.md) và thêm lớp khóa RLS `RESTRICTIVE` (`private_project_scope`) trên bảng việc lõi theo quy trình kiểm thử bảo mật hai bước và rà soát `shared-core`.
3. **`A3` - Đưa Dự án v1 và Ghi chú v2 lên hệ thống thí điểm (`v0.3.6`):** Ngay khi gói cuối của Ghi chú v2 (`#4320`) gộp vào nhánh chính và kiểm thử xanh, trình anh danh sách bước cụ thể từ tài liệu vận hành để anh duyệt một lần trước khi chạy.

## Vai trò của Vy (AI) và nguyên tắc an toàn

- **Tắt AI vẫn chạy đủ 100%:** Mọi phép tính (tốc độ chu kỳ, biểu đồ giảm dần, cảnh báo vượt giới hạn cột, nút thắt phụ thuộc, xung đột lịch, tổng giờ và tiền tính phí) đều do mã tính cố định, không dùng mô hình AI làm toán.
- **Vy chỉ tóm tắt từ số liệu máy đã tính (`projects.cycle_summary`, `projects.weekly_status`):** Câu trả lời tiếng Việt bị kiểm tra chặt mọi con số (`summaryNumbersOutside`), không đọc ghi chú riêng tư của người khác, gắn nhãn văn bản AI, và mọi thao tác chuyển việc sang chu kỳ mới hay chỉnh lịch đều cần người dùng bấm xác nhận.
- **Bước 0 (`#4360`) làm trước:** Đăng ký trước 4 bảng mới (`project_column`, `project_cycle`, `task_dependency`, `time_entry`) vào bộ kiểm thử bảo mật ma trận quyền (`rls-matrix.db.test.ts`) để các nhánh Đợt 1 và Đợt 2 chạy kiểm thử song song an toàn.
