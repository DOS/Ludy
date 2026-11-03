# Phát hành hóa đơn bán ra qua nhà cung cấp của chính người bán: tóm tắt cho chủ sở hữu

> Bản tóm tắt tiếng Việt của [einvoice-issue.md](einvoice-issue.md) (kế hoạch cho [#2497](https://github.com/DOS/Ludy/issues/2497), ngày 2026-11-03) và của [ADR-0044](../adr/0044-einvoice-provider-adapters.md). Chỉ là thiết kế: chưa xây gì, chưa chi tiền, chưa dùng khóa truy cập nào, mọi thông tin về nhà cung cấp lấy từ trang công khai đọc ngày 2026-11-03.

## Ludy làm gì

Ludy ghi nhận hóa đơn bán ra nhưng chưa phát hành được. Theo chỉ đạo của chủ sở hữu, **Ludy không tự làm nhà cung cấp hóa đơn điện tử**. Mỗi tổ chức mang tài khoản nhà cung cấp của chính mình vào mục **Tích hợp** trong cài đặt Kế toán; Ludy gọi API của nhà cung cấp đó thay cho người bán. Nhà cung cấp mới đánh số, ký và lấy mã của cơ quan thuế; người bán vẫn là người phát hành và chịu trách nhiệm về từng hóa đơn.

Sau khi làm xong, một doanh nghiệp nhỏ có thể: kết nối tài khoản nhà cung cấp một lần và bấm "Kiểm tra kết nối", xem mẫu số và ký hiệu kéo từ nhà cung cấp về, soạn nháp hóa đơn (gõ tay, lấy từ hóa đơn cũ, hoặc để đồng nghiệp AI soạn từ một deal, một lịch hẹn, một dòng chat), bấm **Phát hành**, rồi thấy hóa đơn về có số, có chữ ký, có mã cơ quan thuế, tệp XML đã ký được lưu làm chứng từ gốc và bút toán ghi qua đường đề xuất hiện có. Điều chỉnh và thay thế làm từ hóa đơn đã phát hành, không bao giờ sửa trực tiếp.

## Điều quan trọng cần biết

1. **Quy định đã đổi trong năm nay.** Nghị định 254/2026/NĐ-CP (có hiệu lực từ 2026-07-01) thay Nghị định 123/2020 và 70/2025; Thông tư 91/2026/TT-BTC thay Thông tư 32/2025. Bản gốc nghị định chỉ có dạng ảnh quét nên không đọc được; các số điều trong kế hoạch lấy từ trang của Chính phủ, ghi chú của EY và bình luận kế toán. **Cần kế toán của đối tác thí điểm (#61) đọc văn bản gốc và sửa bảng quy tắc** trước khi lệnh phát hành được gộp ([#2506](https://github.com/DOS/Ludy/issues/2506)).
2. **Hủy hóa đơn điện tử có vẻ không còn.** Các nguồn chỉ nói thông báo, điều chỉnh, thay thế. Kế hoạch không có nút "Hủy"; chỉ thêm nếu văn bản gốc cho thấy còn.
3. **Chỉ MISA công bố đặc tả API đầy đủ, chính thức, công khai.** Viettel chỉ có bản chép không chính thức; VNPT và BKAV chỉ có tài liệu cộng đồng; EasyInvoice và FPT không có tài liệu công khai. SePay và Pay2S có tài liệu mở nhưng là bên trung gian đứng giữa Ludy và nhà cung cấp của người bán.
4. **Chưa nhà cung cấp nào cho thấy rõ cả hai điều bạn hỏi:** khách dùng API bằng khóa riêng mà không cần hợp đồng với Ludy, và doanh nghiệp nhỏ tự bật môi trường thử. Viettel (khóa và danh sách IP do khách tự đặt) và SePay (khóa riêng của khách) gần nhất về điều thứ nhất; điều thứ hai không nơi nào nói rõ.
5. **Không nhà cung cấp nào có webhook** (phải hỏi trạng thái định kỳ, có khi đợi hai giờ). **Ký không cần người** chỉ làm được bằng chữ ký số trên máy chủ của nhà cung cấp; chữ ký USB cần người và máy tính nên Ludy từ chối kiểu kết nối đó. Mẫu số và ký hiệu do người bán tạo sẵn trên trang nhà cung cấp; Ludy không tạo được.
6. **Giá:** gói theo số hóa đơn, hàng trăm nghìn đồng một năm với doanh nghiệp nhỏ; phí API là báo giá riêng ở nơi nào có nhắc, và không nói ở nơi còn lại.

## Nhà cung cấp đầu tiên

**MISA meInvoice**, sau một bước kiểm tra chỉ người thật làm được: đăng ký một ứng dụng thử trên cổng nhà phát triển của MISA, gửi yêu cầu tích hợp, ghi lại điều gì xảy ra, và hỏi MISA bằng văn bản ba câu (khách có dùng API bằng khóa riêng không cần thỏa thuận đối tác không; phí API; môi trường thử có tự bật và miễn phí không) ([#2507](https://github.com/DOS/Ludy/issues/2507)). Lý do chọn: đây là nhà cung cấp duy nhất có đặc tả chính thức công khai, có thay thế và điều chỉnh, và có ký bằng HSM không cần người. Thứ hai là Viettel (cần kiểm tra tương tự, [#2508](https://github.com/DOS/Ludy/issues/2508)). Trong lúc chờ, **toàn bộ luồng được xây và kiểm thử trên một nhà cung cấp giả chạy ngoại tuyến**, nên không việc gì phải chờ.

## Cách xây (ADR-0044)

- Một giao diện chung (`EInvoiceProvider`) và một bộ chuyển đổi cho mỗi nhà cung cấp; khóa của tổ chức lưu niêm phong như kênh mạng xã hội (ADR-0025), chỉ worker mở, không hiện lại, chủ sở hữu và quản trị viên gỡ được.
- Mỗi bản nháp có một khóa do Ludy tạo; gọi nhà cung cấp mất kết quả thì **hỏi lại nhà cung cấp theo khóa đó trước khi gửi lại**, không bao giờ gửi mù.
- Bút toán chỉ ghi **từ XML đã ký** nhà cung cấp trả về, qua đường nhập chứng từ hiện có. Bấm Phát hành đồng thời là duyệt bút toán **chỉ khi** tổng, mã số thuế người mua, các dòng và thuế GTGT của XML khớp đúng bản nháp; lệch thì chờ một người xem. Quy tắc này chạm vào đường duyệt sổ nên cần Platform PO duyệt bảo mật riêng.
- Đồng nghiệp AI chỉ **soạn** các dòng, thuế suất và người mua; mọi con số nó nêu phải có trong nguồn nó được đưa; tổng tiền do mã tính; nó không bao giờ bấm Phát hành.

## Việc cần người thật (không phải tác nhân)

| Việc | Ai | Issue |
|---|---|---|
| Đọc Nghị định 254 và Thông tư 91 bản gốc, sửa bảng quy tắc (ngày lập, các dạng điều chỉnh, còn hủy hay không, mẫu 04/SS-HĐĐT, điều kiện nhà cung cấp) | Kế toán của đối tác thí điểm (#61), có thể kèm luật sư | [#2506](https://github.com/DOS/Ludy/issues/2506) |
| Tạo ứng dụng thử MISA và hỏi ba câu bằng văn bản | Chủ sở hữu hoặc kế toán đối tác | [#2507](https://github.com/DOS/Ludy/issues/2507) |
| Kiểm tra tương tự với Viettel | Như trên | [#2508](https://github.com/DOS/Ludy/issues/2508) |
| Xác nhận với luật sư rằng Ludy, là bên xử lý dữ liệu của người bán, không cần giấy phép riêng để gọi API của nhà cung cấp, và điều khoản xử lý dữ liệu của Ludy Cloud bao gồm việc phát hành | Chủ sở hữu, cùng luật sư | trong #2506 |

Không khóa truy cập thật nào của chủ sở hữu, đối tác hay khách hàng được tác nhân dùng.

## Các issue xây dựng

| Thứ tự | Việc | Mốc, ưu tiên | Issue |
|---|---|---|---|
| 1 | Giao diện chung, nhà cung cấp giả, bảng nháp, máy trạng thái, màn "Hóa đơn bán ra" với các kiểm tra | M3 Paid pilot, P2 | [#2500](https://github.com/DOS/Ludy/issues/2500) |
| 2 | Tích hợp: kết nối bằng khóa của tổ chức, kiểm tra kết nối, kéo mẫu số và ký hiệu | M3 Paid pilot, P2 | [#2501](https://github.com/DOS/Ludy/issues/2501) |
| 3 | Lệnh phát hành, theo dõi trạng thái, lưu XML đã ký, ghi sổ | M3 Paid pilot, P2 | [#2502](https://github.com/DOS/Ludy/issues/2502) |
| 4 | Bộ chuyển đổi MISA meInvoice (chờ kiểm tra của chủ sở hữu) | M3 Paid pilot, P2 | [#2503](https://github.com/DOS/Ludy/issues/2503) |
| 5 | Điều chỉnh và thay thế từ hóa đơn đã phát hành, nối với #916 | M3 Paid pilot, P2 | [#2504](https://github.com/DOS/Ludy/issues/2504) |
| 6 | Đồng nghiệp AI soạn dòng hàng, thuế suất, người mua | M3 Paid pilot, P2 | [#2505](https://github.com/DOS/Ludy/issues/2505) |
| 7 đến 8 | Hai việc của người thật ở trên | M3 Paid pilot, P2 | #2506, #2507 |
| 9 | Kiểm tra Viettel | Icebox, P3 | [#2508](https://github.com/DOS/Ludy/issues/2508) |
| 10 | Bộ chuyển đổi Viettel S-Invoice | Icebox, P3 | [#2509](https://github.com/DOS/Ludy/issues/2509) |
| 11 | Hóa đơn từ máy tính tiền và hóa đơn không mã (một sản phẩm khác: máy bán hàng) | Icebox, P3 | [#2510](https://github.com/DOS/Ludy/issues/2510) |

Các việc 1 đến 3 xây trên nhà cung cấp giả và không cần chủ sở hữu làm gì; việc 4 chờ #2507 và #2506; việc 5 chờ #2506.
