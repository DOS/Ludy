# Lấy hóa đơn gốc từ trang tra cứu của nhà cung cấp: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [einvoice-lookup.md](einvoice-lookup.md) (kế hoạch cho [#2258](https://github.com/DOS/Ludy/issues/2258), 2026-11-01). Bản đầy đủ và bảng nhà cung cấp viết bằng tiếng Anh.

## Vấn đề

Nhiều người bán chỉ gửi file PDF, hoặc chỉ gửi email có đường dẫn tra cứu và mã tra cứu. Khi đó Ludy không có file XML nên không kiểm tra được chữ ký số của người bán và không đọc số tiền chính xác được. MISA có màn "Kết nối nhà cung cấp" để lấy hóa đơn gốc về.

## Khảo sát: trang tra cứu của các nhà cung cấp

Tôi chỉ đọc các trang công khai, không nhập mã tra cứu nào và chưa dùng hóa đơn thử. Kết quả:

- **Mọi trang đọc được đều bắt nhập mã xác nhận bằng hình (CAPTCHA).** MISA và EasyInvoice thì chính trang nói vậy; Viettel và VNPT thì chỉ các bài blog nói vậy. Ludy không bao giờ tự giải CAPTCHA, nên cách duy nhất là có người giải, giống cổng thuế (ADR-0036).
- MISA và EasyInvoice dùng một địa chỉ chung cho mọi người bán. VNPT dùng một địa chỉ riêng cho mỗi người bán (mã số thuế người bán nằm trong tên miền).
- Không trang nào mô tả cách lấy tự động hay giới hạn tần suất. Điều khoản của MISA bị lỗi 404. Không có thông tin không có nghĩa là được phép, nên mọi cách làm đều để người dùng là người thao tác.
- Với Viettel, BKAV, VNPT và FPT, tôi chưa kiểm chứng được từ trang chính thức (trang không đọc được, hoặc chỉ có bài blog). Cần người thử tay bằng hóa đơn thử.

## Kế hoạch: làm gì trước, gì sau

**Bước 1, làm trước, không gọi ra ngoài:** Ludy đọc mã tra cứu và đường dẫn từ chữ trong PDF hoặc trong email, rồi hiện một thẻ "Cần hóa đơn gốc (XML)" ở Inbox: tên nhà cung cấp, mã (có nút sao chép), nút "Mở trang tra cứu" và chỗ kéo thả file XML. Người dùng mở trang của nhà cung cấp, tự giải CAPTCHA, tải XML rồi thả vào thẻ. Ludy không gọi ai cả. Với doanh nghiệp một người và SME, đây là phần lớn giá trị mà gần như không có rủi ro pháp lý hay bảo trì. Đường dẫn trong PDF hay email chỉ bấm được khi địa chỉ nằm trong danh sách nhà cung cấp đã biết.

**Khi XML đến sau PDF:** nếu đề xuất làm từ PDF còn chờ duyệt, XML trở thành một bản sửa mới của chính đề xuất đó (người duyệt thấy một đề xuất, không phải hai). Nếu đã ghi sổ, XML được đính kèm làm bằng chứng và có cảnh báo nếu số tiền khác nhau; không ghi sổ lại.

**Bước 2, để sau:** Ludy tự lấy CAPTCHA về cho người dùng gõ rồi tải XML (như cổng thuế). Việc này gọi ra ngoài tới trang chưa có tài liệu và điều khoản chưa đọc được, nên chỉ làm khi bước 1 chưa đủ, sau khi người thử tay từng nhà cung cấp, và tắt mặc định. Đã ghi thành ADR-0042, trạng thái Đề xuất.

## Các việc dựng (đã tạo, nối từ #2258)

| Thứ tự | Việc | Mốc, ưu tiên | Issue |
|---|---|---|---|
| 1 | Đọc mã và đường dẫn tra cứu từ PDF và email | M3 Paid pilot, P2 | [#2267](https://github.com/DOS/Ludy/issues/2267) |
| 2 | Email chỉ có đường dẫn và mã trở thành mục Inbox; thẻ "Cần hóa đơn gốc" | M3 Paid pilot, P2 | [#2268](https://github.com/DOS/Ludy/issues/2268) |
| 3 | XML đến sau PDF: nâng cấp đề xuất đang chờ, hoặc đính kèm vào chứng từ đã ghi | M3 Paid pilot, P2 | [#2269](https://github.com/DOS/Ludy/issues/2269) |
| 4 | Thử tay các trang tra cứu bằng hóa đơn thử, điền bảng khảo sát | Icebox, P3, việc của con người | [#2270](https://github.com/DOS/Ludy/issues/2270) |
| 5 | Lõi lấy hóa đơn có người giải CAPTCHA | Icebox, P3 | [#2271](https://github.com/DOS/Ludy/issues/2271) |
| 6 | Bộ nối đầu tiên (MISA meInvoice) | Icebox, P3 | [#2272](https://github.com/DOS/Ludy/issues/2272) |

## Việc cần ai

- **Người thử tay (kế toán đối tác #61 hoặc chủ sở hữu tạo tài khoản thử):** thử từng trang tra cứu bằng một hóa đơn thử và đọc điều khoản ([#2270](https://github.com/DOS/Ludy/issues/2270)). Chỉ cần khi muốn làm bước 2.
- **Chủ sở hữu hoặc PO Kế toán:** chấp nhận hay chưa ADR-0042 (bước 2). Nếu không trả lời, bước 2 không được dựng.
