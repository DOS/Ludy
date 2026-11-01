# Ludy CRM, lát cắt 1: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [crm.md](crm.md), cập nhật khi đóng lát cắt (bước K7), ngày 2026-11-01. JOY đã quyết "Mở ngay" cho lát cắt đầu tiên của CRM (quyết định 21 trong kế hoạch kernel, issue [#2223](https://github.com/DOS/Ludy/issues/2223)). Đây là ngoại lệ của Quyết định 2, giống Quyết định 20 đã làm cho Calendar. Lát này chưa hiện ra với khách hàng nào vì bản chạy thử chỉ có kế toán.

## Lát cắt 1 làm gì, cho ai

Công ty một người hoặc doanh nghiệp nhỏ cần một chỗ để thấy mình có thể bán cho ai, bao nhiêu tiền, và mỗi thương vụ đã đến đâu, ngay cạnh sổ sách đã có trong Ludy.

Một thành viên làm được:
- ghi **cơ hội bán hàng** (deal) gắn với liên hệ hoặc công ty đã có trong Ludy, kèm số tiền (đồng) và ngày dự kiến chốt;
- xem mọi cơ hội trên **một bảng quy trình bán hàng** (pipeline): kéo thẻ sang cột khác hoặc đổi thứ tự trong cột (trên điện thoại và bằng bàn phím dùng menu giai đoạn trên thẻ), đóng là Thắng hoặc Thua, ghi lý do thua; chủ sở hữu và quản trị viên đổi tên, thêm, sắp xếp, xóa các giai đoạn đang mở;
- tìm liên hệ **không cần gõ dấu** ("nguyen" ra "Nguyễn"), và **lưu chế độ xem** (bộ lọc và cách sắp xếp), riêng tư hoặc chia sẻ cả tổ chức;
- **nhập liên hệ và công ty từ tệp Excel hoặc CSV**: đọc ngay trên máy, ghép cột, xem trước từng dòng (mới, trùng, xung đột, lỗi) rồi mới nhập; không ghi đè thông tin đã có; tải về các dòng chưa nhập kèm lý do; tệp Excel có macro hoặc ô công thức bị từ chối kèm hướng dẫn;
- xem **dòng thời gian** của liên hệ: thêm, nhập từ tệp, tạo cơ hội, chuyển giai đoạn, thắng, thua (không kèm tên cơ hội hay số tiền).

## An toàn và dữ liệu

- Mọi thay đổi đi qua một đường ghi duy nhất (command). Tác nhân AI không ghi vào các bảng này.
- Số tiền luôn là số thập phân, chỉ VND ở giai đoạn này. Hai người sửa cùng một cơ hội: người lưu sau được báo, không ghi đè.
- Tệp nhập không được lưu lại. Các dòng xem trước chứa dữ liệu cá nhân nên bị xóa khi nhập, khi hủy, và sau 7 ngày (bước K5b quét hằng ngày cả những tổ chức không nhập nữa).
- Nhật ký chỉ ghi số lượng và mã, không ghi tên, email, số điện thoại hay số tiền.

## Các bước đã làm

| Bước | Nội dung | Trạng thái khi viết bản này |
|---|---|---|
| Kế hoạch | Tài liệu kế hoạch và quyết định 21 | Đã gộp (#2224) |
| K1 | Cơ hội và quy trình, màn hình "Cơ hội" dạng danh sách | Đã gộp (#2240) |
| K2 | Bảng kéo thả, menu giai đoạn, Thắng và Thua, cài đặt giai đoạn | Đã gộp (#2244) |
| K3 | Chế độ xem đã lưu và bộ lọc | Đã gộp (#2239, #2252), worker khác |
| K4 | Màn hình "Liên hệ", tìm không dấu, chuẩn hóa số điện thoại | Đã gộp (#2241), worker khác |
| K5 | Nhập liên hệ từ CSV | Đã gộp (#2254) |
| K5b | Quét hằng ngày xóa dòng nhập quá 7 ngày | Đã gộp (#2259) |
| K6 | Nhập liên hệ từ Excel (đọc ngay trên trình duyệt, không thêm gói mới) | Đã gộp (#2277) |
| K7 | Kiểm tra cả luồng bằng một bài e2e, kiểm tra module `crm` chạy riêng và khi tắt, hướng dẫn sử dụng, bản tóm tắt này | Đang chờ gộp (#2279) |

## Ngoài lát này (chờ JOY)

AI dưới mọi hình thức, thu thập từ email, lịch hay Zalo, trường tùy chỉnh và đối tượng tùy chỉnh, quy trình thứ hai, tự động hóa, sản phẩm hoặc báo giá trên cơ hội, chia sẻ bản ghi, API công khai, ứng dụng di động riêng.

## Việc cần JOY quyết

Hiện không có gì chặn. Các giả định mặc định (đổi được sau): chỉ VND; chưa có hoàn tác cho việc nhập tệp; chưa nối cơ hội thắng với hóa đơn (việc của dòng Kế toán); chưa nối người với công ty; lý do thua là văn bản tự do; chưa có cập nhật tức thời khi người khác chuyển thẻ (bảng làm mới sau thao tác của chính bạn và khi tải lại). Danh sách đầy đủ ở mục 9 của [crm.md](crm.md).
