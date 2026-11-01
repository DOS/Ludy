# Ludy CRM, lát cắt 1: tóm tắt kế hoạch cho JOY

> Bản tóm tắt tiếng Việt của [crm.md](crm.md), ngày 2026-11-01. JOY đã quyết "Mở ngay" cho lát cắt đầu tiên của CRM (quyết định 21 trong kế hoạch kernel, issue [#2223](https://github.com/DOS/Ludy/issues/2223)). Đây là ngoại lệ của Quyết định 2, giống Quyết định 20 đã làm cho Calendar. Lát này chưa hiện ra với khách hàng nào vì bản chạy thử chỉ có kế toán.

## Lát cắt 1 làm gì, cho ai

Công ty một người hoặc doanh nghiệp nhỏ cần một chỗ để thấy mình có thể bán cho ai, bao nhiêu tiền, và mỗi thương vụ đã đến đâu, ngay cạnh sổ sách đã có trong Ludy.

Sau lát này, một thành viên có thể:
- ghi **cơ hội bán hàng** (deal) gắn với liên hệ hoặc công ty đã có trong Ludy, kèm số tiền và ngày dự kiến chốt;
- xem mọi cơ hội đang mở trên **một bảng quy trình bán hàng** (pipeline), kéo thẻ từ giai đoạn này sang giai đoạn khác (trên điện thoại dùng menu), rồi đóng là Thắng hoặc Thua;
- **lưu chế độ xem** cho cơ hội và cho liên hệ (một bộ lọc và một cách sắp xếp), riêng tư hoặc chia sẻ cả tổ chức;
- **nhập liên hệ và công ty** từ tệp CSV hoặc Excel, có kiểm tra trùng (mã số thuế, email, số điện thoại) và xem trước trước khi ghi bất cứ thứ gì.

## Ngoài lát này (chờ JOY)

AI dưới mọi hình thức, thu thập từ email, lịch hay Zalo, trường tùy chỉnh và đối tượng tùy chỉnh, quy trình thứ hai, tự động hóa, sản phẩm hoặc báo giá trên cơ hội, chia sẻ bản ghi, API công khai, ứng dụng di động riêng.

## Cách làm (tóm tắt kỹ thuật)

- Cơ hội và giai đoạn nằm trong module `crm`; chế độ xem đã lưu nằm ở kernel vì mọi module dùng chung. Số tiền luôn là số thập phân (NUMERIC), chỉ VND ở giai đoạn này.
- Mỗi tổ chức có đúng một quy trình, các giai đoạn mặc định: Mới, Đã liên hệ, Báo giá, Thương lượng, Thắng, Thua.
- Mọi thay đổi đi qua một đường ghi duy nhất (command). Tác nhân AI không ghi vào các bảng mới.
- Nhập tệp: tải lên, ghép cột, xem trước (mới, trùng, xung đột, lỗi), rồi mới nhập bằng một lệnh có ghi nhật ký. Dòng tạm bị xóa sau khi nhập, khi hủy hoặc sau 7 ngày. Không bao giờ ghi đè dữ liệu đã có.

## Các bước (mỗi bước một PR, làm xong từ đầu đến cuối)

| Bước | Nội dung |
|---|---|
| K1 | Cơ hội và quy trình: bảng dữ liệu, lệnh tạo, sửa, chuyển, xóa, màn hình danh sách "Cơ hội" |
| K2 | Bảng kéo thả, menu chuyển giai đoạn, Thắng và Thua, cài đặt giai đoạn |
| K3 | Chế độ xem đã lưu và bộ lọc cho cơ hội |
| K4 | Màn hình "Liên hệ": tạo liên hệ, tìm không dấu, chuẩn hóa số điện thoại, chế độ xem cho liên hệ |
| K5 | Nhập liên hệ từ CSV |
| K6 | Nhập liên hệ từ Excel |
| K7 | Kiểm tra toàn bộ lát cắt từ đầu đến cuối, hướng dẫn sử dụng |

K1, K3, K4, K5, K6 đụng vào đường dẫn được bảo vệ (migration hoặc `package.json`), nên phải qua kiểm tra bảo mật của bộ điều phối trước khi gộp.

## Việc cần JOY quyết

Hiện không có gì chặn. Các giả định mặc định (đổi được trước khi bước tương ứng bắt đầu): chỉ VND; chưa có hoàn tác cho việc nhập tệp; chưa nối cơ hội thắng với hóa đơn (việc của dòng Kế toán); chưa nối người với công ty; lý do thua là văn bản tự do. Danh sách đầy đủ ở mục 9 của [crm.md](crm.md).
