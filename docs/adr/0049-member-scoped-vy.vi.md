# Vy của từng thành viên: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [ADR-0049](0049-member-scoped-vy.md), ngày 2026-11-04 (#1677). Bản tiếng Anh là bản chính. Trạng thái: **đề xuất**, chờ Platform PO duyệt bảo mật. Chưa có dòng mã nào được viết.

## Quyết định của JOY và nó có nghĩa là gì

Ngày 2026-11-03 JOY quyết trên #1677: "Với những data riêng thì Vy chỉ trả lời cho user đó thôi chứ. Nôm na là data nào user có access thì Vy (của người đó) có."

- **Mỗi thành viên có Vy của riêng mình.** Vy đó thấy đúng những gì thành viên thấy: ghi chú riêng của họ, ghi chú chung họ được xem, dữ liệu các app khác theo quyền của họ. Không hơn.
- **Cái Vy tìm thấy trong dữ liệu riêng chỉ trả về cho đúng người đó.** Trí nhớ và kết quả của Vy cũng là của riêng từng thành viên. Chủ tổ chức, quản trị viên, thành viên khác, hệ thống đều không đọc được.
- **Việc chung của cả tổ chức vẫn không đọc gì riêng tư.** Bản tin hằng ngày cho cả nhóm, đề xuất để người khác duyệt, việc của các tác tử AI trong sơ đồ tổ chức: không đụng vào ghi chú riêng.
- Quyết định này sửa điều N-6 của ADR-0037 ("tác tử không đọc ghi chú") chỉ cho Vy của từng thành viên. Các tác tử khác giữ N-6.

## Cách làm, nói ngắn

1. **Chạy trong quyền của chính thành viên, không bao giờ trong quyền hệ thống.** Khi thành viên bấm "Tóm tắt" trên một ghi chú, máy chủ xử lý ngay trong phiên của họ. Với việc chạy nền (ví dụ chép lời một cuộc họp), tác vụ vào một ngữ cảnh riêng gắn với đúng thành viên đó, và dừng ngay khi thành viên bị gỡ khỏi tổ chức, kể cả đang chạy giữa chừng.
2. **Hai loại tác tử tách bạch.** Vy của tổ chức giữ danh sách bảng được ghi như cũ (#285). Vy của thành viên có danh sách ngắn riêng: chỉ ghi kết quả và trí nhớ của chính thành viên đó. Không ghi được nhiệm vụ, đề xuất hay bảng nào người khác đọc.
3. **Trí nhớ và kết quả nằm trong bảng khóa theo từng thành viên**, có khóa dòng ở mức cơ sở dữ liệu. Khi thành viên rời tổ chức, chúng bị xóa cùng lúc với ghi chú riêng (sau 30 ngày). Xóa tổ chức hay yêu cầu xóa dữ liệu cá nhân cũng xóa chúng. Khi xuất dữ liệu tổ chức chỉ có số đếm. Trí nhớ chỉ gồm điều thành viên tự ghi hoặc xác nhận, và có màn hình "Vy nhớ gì về tôi" để sửa, xóa.
4. **Chặn rò rỉ ra ngoài bằng ba lớp, không dựa vào lời dặn trong lời nhắc.** Bản tin chung và tác tử của tổ chức không đọc nổi kết quả riêng của thành viên. Mỗi lần chạy có cờ "đã đọc dữ liệu riêng", và chữ đó chỉ đến chỗ mọi người thấy khi chính thành viên bấm xác nhận sau khi thấy đúng nội dung. Các hàm đọc dữ liệu riêng dùng một kiểu dữ liệu riêng mà phần việc chung không được dùng, có kiểm thử tĩnh.
5. **Chống lời chèn vào ghi chú.** Mô hình AI không có công cụ nào: mã đọc dữ liệu, gọi mô hình một lần, rồi kiểm kết quả theo khuôn. Ghi chú nói "tạo việc cho X" thì cùng lắm thành một đề xuất có nhãn "Đề xuất", không tự làm gì. Ghi chú chung của người A mà Vy của người B đọc thì chỉ ảnh hưởng đến gợi ý hiện cho B, không đọc được ghi chú riêng của A và không gửi gì cho A.
6. **Ngân sách đi qua bộ đếm AI như mọi lời gọi khác**, tính vào ngân sách tổ chức và ngân sách của app. Chi phí ghi theo từng thành viên để chủ tổ chức thấy tiền đi đâu (chỉ số tiền, không có nội dung). **Mặc định không đặt trần riêng cho từng thành viên** (công ty nhỏ không cần cài đặt). Chủ tổ chức muốn thì đặt trần cho Vy của một người, công tắc dừng khẩn cấp cũng áp dụng.
7. **Đường đi bằng các bước kiểm thử bất biến (invariant), mỗi giai đoạn hai bước.** Bước một chỉ sửa bộ kiểm thử cho chấp nhận cả hai cách ứng xử, Platform PO gộp. Bước hai mới đổi hành vi. Bản ADR liệt kê từng thay đổi lên các quy tắc đã chấp nhận. Chỉ có một chỗ nới có chủ ý: N-6 như trên, theo đúng quy tắc của JOY.

## Hai giai đoạn

- **Giai đoạn A, cho N8 (tóm tắt ghi chú, gợi ý việc cần làm):** chạy trong phiên của người bấm. Không đổi chính sách của ghi chú, không đổi danh sách bảng của tác tử tổ chức. Không cần đường dẫn đặc biệt nào để worker đọc ghi chú, nên đơn giản hơn kế hoạch cũ.
- **Giai đoạn B, cho việc chạy nền (cuộc họp, #2554, và việc về sau):** ngữ cảnh riêng của Vy thành viên, danh sách ghi riêng, và bước nới N-6 có kiểm thử. Làm khi cuộc họp cần, với bước kiểm thử bất biến đi trước.

Kế hoạch cuộc họp (#2554) và kế hoạch dự án (#2556, bước P7) đều dùng chung cơ chế này, làm một lần.

## Việc cần ai quyết

- **Platform PO** duyệt: chọn hình dạng "tác tử gắn với một thành viên" (an toàn hơn vì mặc định từ chối) hay "ngữ cảnh người dùng kèm dấu tác tử" như ý ban đầu; cách liệt kê các bảng được phép dùng `ctx_acting_user_id()`; thời hạn xóa 30 ngày chung với ghi chú; tên `member_vy`, `vy_result`, `vy_memory`.
- **JOY** không phải quyết thêm gì: ADR giữ đúng quy tắc của JOY. Nếu muốn trần chi phí mặc định cho từng thành viên, hay quyền "mở khóa khẩn cấp" cho chủ tổ chức, đó là quyết định mới.

## Việc tiếp theo sau khi được duyệt

N8-1 (kiểm thử bất biến, PR bảo vệ) rồi N8-2 (cơ chế phía máy chủ, PR bảo vệ) rồi N8-3 (tính năng trên màn hình ghi chú). Chi tiết trong bảng N8 của [notes.md](../plan/notes.md).
