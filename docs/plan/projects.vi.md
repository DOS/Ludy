# Dự án và bảng công việc: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [projects.md](projects.md) và [ADR-0048](../adr/0048-projects-on-kernel-tasks.md), ngày 2026-11-03. Đây là đề xuất để anh bàn: chưa xây gì, chưa tạo issue nào. Làm gọn, tính năng lõi trước, AI đi kèm ngay trong từng màn hình (đúng lời anh dặn).

## Người dùng được gì

Chủ một công ty một người hoặc một nhóm nhỏ (2 đến khoảng 20 người) gom việc theo **dự án** (ví dụ: khai trương cửa hàng, một đơn hàng lớn, quyết toán cuối năm của một khách), xem ai làm gì, hạn khi nào, kéo việc qua các cột, và biết sớm việc nào trễ hoặc bị kẹt.

- Mở một dự án, xem việc dạng **bảng cột** (kéo thả thẻ việc) hoặc dạng danh sách.
- Thêm việc, **sửa việc** (tên, mô tả, hạn, người nhận); hôm nay Ludy chưa cho sửa việc sau khi giao.
- Trong "Việc của tôi" thấy mọi việc của mình ở mọi dự án, có tên dự án kèm theo.
- Gắn một ghi chú hoặc việc riêng vào đúng việc hay dự án mà nó nói tới.
- **Vy** (đồng nghiệp AI tổng quản) giúp ngay trong màn hình dự án: báo việc trễ và việc kẹt trên trang chủ, viết tình hình tuần của dự án bằng vài câu dễ hiểu, và đề xuất danh sách việc từ một ghi chú.

## Phần đầu tiên (gọn nhất)

1. **Dự án**: tên, người phụ trách, thành viên, trạng thái (đang làm, tạm dừng, xong, lưu trữ).
2. **Bảng và danh sách**: các cột chính là trạng thái sẵn có của việc (Cần làm, Đang làm, Đang chờ, Chờ duyệt, Xong). Mỗi thẻ có người nhận, hạn, dấu trễ hạn. Chưa có danh sách bước con trong một việc, vì mô hình việc hiện tại không có; ai cần thì dùng các bước trong việc riêng của mình và gắn vào việc đó.
3. **Việc của tôi** trên mọi dự án.
4. **Liên kết** từ ghi chú và việc riêng tới việc hoặc dự án. Việc riêng vẫn chỉ mình người viết thấy, kể cả khi đã gắn vào việc chung.
5. **Phần của Vy**:
   - Báo việc trễ, việc đến hạn hôm nay, việc "Đang chờ" quá 3 ngày, trong mục "Hôm nay cần bạn". Phần này chỉ dùng quy tắc cố định, không gọi AI, không tốn tiền.
   - Tình hình tuần: máy đếm số việc xong, trễ, đang chờ; Vy chỉ viết lời. Câu nào có con số không khớp với số máy đếm thì bị loại.
   - Đề xuất việc từ ghi chú: Vy đưa ra danh sách, người dùng sửa, bỏ chọn rồi bấm xác nhận một lần. Vy không tự tạo việc.

Mọi lần gọi AI đều đi qua **đồng hồ đo ngân sách AI** (bộ đếm chi phí AI theo tổ chức, có mức dừng). Tắt AI thì dự án, bảng và "Việc của tôi" vẫn dùng đủ.

## Những quyết định anh cần đưa ra (đề xuất đặt trước)

| # | Câu hỏi | Đề xuất | Lý do | Nếu anh chưa trả lời |
| --- | --- | --- | --- | --- |
| D-1 | Khi nào xây? | Mốc M3 (giai đoạn thí điểm có trả phí), ưu tiên P2, sau việc chốt sổ tháng của M2 | Có ích hằng tuần, nhưng đối tác thí điểm chưa hỏi tới, và chốt sổ tháng đang quan trọng hơn | Không bắt đầu xây |
| D-2 | Ai thấy một dự án? | Mọi thành viên trong tổ chức, giống việc hiện nay; dự án riêng để sau | Nhóm nhỏ thường làm chung; muốn giấu việc thì phải đổi một quy tắc bảo mật lõi đang được kiểm thử | Làm theo đề xuất |
| D-3 | Việc giao cho "vị trí" hay cho "người"? | Giữ **vị trí** (một ô trong sơ đồ tổ chức, do người hoặc tác tử AI giữ). Chủ sở hữu tạo cho mỗi đồng nghiệp một vị trí một lần | Tác tử AI, việc giao từ việc riêng, và việc chuyển giao khi có người nghỉ đều dựa trên vị trí. Công ty một người không cần làm gì | Làm theo đề xuất |
| D-4 | Cột của bảng: theo trạng thái hay mỗi dự án tự đặt cột? | Theo trạng thái | Người và tác tử AI cùng dùng một nghĩa; không cần cấu hình | Làm theo đề xuất |
| D-5 | Vy đọc ghi chú để đề xuất việc: chờ bản bổ sung ADR-0037 không? | Có. Phần báo việc và tình hình tuần làm trước; phần đọc ghi chú làm sau khi bản bổ sung được duyệt | Quy tắc anh chốt hôm 2026-11-03 (#1677, mỗi người có Vy riêng, Vy chỉ thấy những gì người đó thấy) cần được ghi thành văn bản và qua kiểm tra bảo mật trước | Làm theo đề xuất |

Giải thích từ ngữ: **ADR** là văn bản ghi một quyết định thiết kế; **issue** là một mục việc trên GitHub; **PR** là một gói thay đổi mã chờ kiểm tra rồi mới gộp vào; **tác tử AI** là AI giữ một vị trí trong sơ đồ tổ chức; **P2, P3** là mức ưu tiên (P3 thấp nhất); **Icebox** là danh sách để sau, chỉ mở lại khi có người dùng thật cần.

## Rủi ro chính

- **Cả nhóm thấy mọi dự án.** Màn hình tạo dự án sẽ nói rõ điều này.
- **Nhóm nhiều người phải tạo vị trí trước.** Màn hình sẽ chỉ chỗ tạo.
- **Việc tạo từ nội dung chưa kiểm chứng** (ghi chú, tin nhắn khách) mang dấu "nội dung bên ngoài", để không ai làm theo khi chưa đối chiếu.

## Để sau (Icebox)

Biểu đồ Gantt (biểu đồ tiến độ theo thời gian), chấm giờ làm và giờ tính tiền, việc phụ thuộc nhau, sprint (chu kỳ làm việc kiểu đội phần mềm), lập kế hoạch nhân lực, cổng cho khách hàng, dự án riêng, cột tự đặt, danh sách bước trong một việc, việc lặp lại và mẫu dự án, đề xuất việc từ cuộc họp hoặc tin nhắn khách, gửi tình hình tuần qua email. Mỗi mục đã được đối chiếu với tiêu chí phạm vi sản phẩm, lý do nằm ở mục 7 của bản kế hoạch.

## Các bước xây (mỗi bước một issue, một PR)

| Bước | Nội dung | Mốc, ưu tiên |
| --- | --- | --- |
| P0 | Kiểm thử bảo mật cho ba bảng mới, làm trước | M3, P2 |
| P1 | Sửa việc và báo cho người được giao | M3, P2 |
| P2 | Dự án, bảng cột và danh sách | M3, P2 |
| P3 | "Việc của tôi" trên mọi dự án | M3, P2 |
| P4 | Gắn ghi chú và việc riêng vào việc và dự án | M3, P2 |
| P5 | Vy báo việc trễ và việc kẹt trên trang chủ (không gọi AI) | M3, P2 |
| P6 | Vy viết tình hình tuần của dự án | M3, P2 |
| P7 | Vy đề xuất việc từ ghi chú (sau bản bổ sung ADR-0037) | M3, P2 |
| P8 | Các mục để sau, mỗi mục một issue P3 khi có người dùng cần | Icebox, P3 |

Ai cần làm gì: **anh** trả lời D-1 đến D-5; sau đó PO (người điều phối sản phẩm) tạo các issue và giao cho tác tử AI xây.
