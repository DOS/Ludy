# Hộp thư thêm WhatsApp và các kênh nhắn tin phổ biến: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [conversations-channels.md](conversations-channels.md), ngày 2026-11-13, làm cho issue [#3128](https://github.com/DOS/Ludy/issues/3128) theo quyết định của JOY cùng ngày: "Làm whatsapp và tất cả các channel phổ biến đi". Đây mới là **kế hoạch**: chưa có dòng code nào, chưa tạo tài khoản nào, chưa gọi API nền tảng nào. Các issue build nằm ở cuối.

## Điều cần biết trước

- **Chưa đọc được trang tài liệu chính thức nào.** Hôm nay môi trường làm việc chặn các trang tài liệu của Meta, Telegram và Google, nên mọi thông tin về nền tảng trong kế hoạch lấy từ kết quả tìm kiếm (có đánh dấu rõ [O] là trang chính thức có xuất hiện trong kết quả, [S] là nguồn phụ, [M] là nhớ lại, [U] là chưa biết). Không có thông tin nào được ghi là "đã đọc tài liệu". Bước đầu của mỗi issue build là đọc trang chính thức rồi sửa kế hoạch nếu khác. Muốn đọc thật ngay: JOY thêm các trang đó vào danh sách tên miền được phép của môi trường (Network access).
- **Không kênh nào làm Ludy tốn tiền theo từng tin nhắn.** Mỗi kênh chạy bằng tài khoản của chính doanh nghiệp. Khoản duy nhất Ludy trả là tiền AI soạn bản nháp, vốn đã đi qua đồng hồ ngân sách AI.

## Xếp hạng cho hộ kinh doanh và doanh nghiệp nhỏ ở Việt Nam

| Hạng | Kênh | Hợp với người Việt đến đâu | Rào cản | Ai trả tiền | Kết luận |
|---|---|---|---|---|---|
| 1 | **WhatsApp Business** (Cloud API) | Vừa trong nước, cao với khách nước ngoài, du lịch, xuất khẩu. Zalo và Messenger vẫn dẫn đầu | Cần tài khoản WhatsApp Business và một số điện thoại; với Ludy Cloud phục vụ doanh nghiệp khác cần Meta xác minh doanh nghiệp và duyệt ứng dụng | Doanh nghiệp trả cho Meta bằng tài khoản của mình; trả lời trong 24 giờ có mất phí hay không **chưa chắc** (các nguồn phụ nói khác nhau), lần kiểm tra thật sẽ xem hóa đơn của doanh nghiệp | **Làm trước**, ưu tiên P1 |
| 2 | **Chat người mua trên Shopee, Lazada, TikTok Shop** | Rất cao với hộ kinh doanh bán trên sàn | Chưa xác nhận có API chat chính thức; cần Ludy đăng ký làm đối tác của từng sàn (quyết định #2523); dữ liệu người mua bị che và chỉ giữ khoảng 90 ngày | Chưa rõ | **Chưa làm bây giờ**, xem lại sau #2523 |
| 3 | **TikTok** (bình luận và tin nhắn riêng) | Cao | Phải xin quyền dùng API tin nhắn doanh nghiệp; có quy định theo vùng; chưa thấy API liệt kê bình luận cho tài khoản doanh nghiệp | Doanh nghiệp, tài khoản TikTok Business của mình | **Làm, nhưng chờ được cấp quyền**, P2 |
| 4 | **Telegram** (chat với bot, sau đó Telegram Business) | Thấp đến vừa | Không cần duyệt; chế độ Business cần chủ shop có Telegram Premium | Miễn phí (Premium do chủ shop tự trả) | **Làm**, P2 |
| 5 | **Threads** (trả lời bình luận) | Thấp đến vừa, nhưng rẻ vì dùng lại phần của Meta | Thêm quyền mới nên phải kết nối lại | Miễn phí | **Làm**, P2 |
| 6 | **YouTube** (bình luận) | Vừa, hợp người làm nội dung | Hạn mức 10.000 đơn vị mỗi ngày cho mỗi dự án Google; mỗi lần trả lời tốn 50 đơn vị, tức chỉ khoảng 200 lần trả lời mỗi ngày cho cả dự án. Ludy Cloud cần xin tăng hạn mức | Miễn phí trong hạn mức | **Làm**, P2 |

## Mỗi kênh gắn vào lõi hiện có thế nào

Không có mô hình tenancy mới. Mỗi kênh chỉ là một "nhà cung cấp" mới của lõi hội thoại: một bộ đọc tin đến (webhook có kiểm chữ ký, hoặc quét định kỳ), một bộ gửi trả lời, một dòng quy tắc (độ dài tối đa, cửa sổ trả lời), tất cả đi qua đường ghi duy nhất của lõi. Lưu trữ, xóa dữ liệu theo yêu cầu, xuất dữ liệu đều dùng lại phần đã làm xong ở CV6.

**Phần AI, giống nhau ở mọi kênh:** đồng nghiệp AI của Hộp thư (Dy) soạn bản nháp trả lời từ nội dung khách viết, gợi ý nhãn ý định và gợi ý hồ sơ liên hệ. Mỗi lần gọi mô hình đi qua đồng hồ ngân sách AI. Bản nháp tự động khi có hội thoại mới đi qua công tắc AI của tổ chức; bản nháp do thành viên tự bấm "Soạn nháp" thì không đi qua công tắc này (đúng như đã làm ở CV8). **Người bấm Gửi**, AI không tự gửi, không tự ẩn, không tự đóng; tắt AI thì hộp thư vẫn chạy bình thường.

## Điểm riêng từng kênh

- **WhatsApp.** Khách nhắn trước thì mở cửa sổ 24 giờ; trong cửa sổ trả lời tự do, ngoài cửa sổ chỉ được gửi tin mẫu (template) đã duyệt và có tính phí cho doanh nghiệp. **Bản đầu không gửi tin mẫu**: quá 24 giờ thì nút Gửi bị khóa kèm lý do, để doanh nghiệp không vô tình mua một tin nhắn. Mỗi tin của khách có số điện thoại, nên gợi ý hồ sơ liên hệ theo số điện thoại chạy chắc chắn, không cần mô hình. Cách kết nối bản đầu là doanh nghiệp tự dán mã truy cập và mã số điện thoại; đăng nhập qua Meta ngay trong Ludy (Embedded Signup) để sau, cần JOY quyết. Số điện thoại đang dùng trong ứng dụng WhatsApp Business chỉ dùng thêm cho API được qua chế độ cùng tồn tại (coexistence), nên thử nghiệm đầu tiên dùng **một số điện thoại dự phòng**. Không có API lịch sử tin nhắn nên tin bị lỡ trong lúc webhook hỏng sẽ không lấy lại được.
- **Telegram.** Một URL webhook chung không biết bot nào vừa gửi, nên cần một đoạn bí mật riêng cho mỗi kết nối trong đường dẫn; đây là quyết định thiết kế đầu tiên của issue, có rà soát bảo mật. **Đã chốt và đã được PO rà soát bảo mật (2026-11-13):** mỗi kết nối có một mã ngẫu nhiên trong đường dẫn, còn "mật khẩu" Telegram gửi kèm được tính từ khóa mã hóa của máy chủ và không lưu ở đâu cả; máy chủ kiểm tra nó trước khi đọc nội dung hay hỏi cơ sở dữ liệu. Bot không tự bắt chuyện với khách được. Nhóm chat không làm trong bản đầu.
- **TikTok.** Bước đầu của issue không phải code: đọc tài liệu, xin quyền API tin nhắn doanh nghiệp (việc chỉ người làm được vì phải ký điều khoản của TikTok), ghi lại vùng nào được dùng.
- **Threads.** Chỉ có trả lời bình luận trên bài của chính doanh nghiệp, mỗi hồ sơ tối đa 1.000 lần trả lời qua API mỗi 24 giờ.
- **YouTube.** Không thấy cách đẩy bình luận về, nên phải quét định kỳ; mỗi kết nối có ngân sách đơn vị mỗi ngày và màn hình cho thấy còn bao nhiêu.

## Những gì cố ý để ngoài, và lý do

Tin mẫu và gửi hàng loạt của WhatsApp (doanh nghiệp bị tính phí từng tin); chat người mua trên sàn (chờ #2523 và #2522); Zalo cá nhân (không có API chính thức); Viber, LINE, SMS (chưa nghiên cứu, không nằm trong danh sách JOY, một số tính phí theo tin); nhóm Telegram; tự động trả lời; xóa nội dung của người khác trên nền tảng.

## Việc cần người làm

| Ai | Việc |
|---|---|
| JOY | Thêm tên miền tài liệu của Meta, Telegram, Google (và TikTok, các sàn nếu muốn đọc) vào danh sách được phép, nếu muốn kế hoạch được cập nhật từ trang chính thức |
| JOY | Chuẩn bị một số điện thoại dự phòng và tài khoản Meta Business cho lần kiểm tra thật đầu tiên của WhatsApp |
| JOY | Xin quyền API tin nhắn doanh nghiệp của TikTok (việc của người, ký điều khoản) |
| JOY | Quyết định có đăng ký Ludy làm đối tác của Meta (Tech Provider) cho Ludy Cloud và xin Google tăng hạn mức YouTube hay không (thời gian, chưa thấy phí) |
| Agent | Mỗi issue build đọc trang chính thức, viết runbook kiểm tra thật cho kênh của mình |

## Thứ tự làm và các issue

1. WhatsApp (P1) 2. Telegram 3. Threads 4. YouTube 5. TikTok (chờ quyền) 6. Chat sàn thương mại điện tử (sau #2523). Các issue build: [#3131](https://github.com/DOS/Ludy/issues/3131) WhatsApp (P1), [#3132](https://github.com/DOS/Ludy/issues/3132) Telegram, [#3133](https://github.com/DOS/Ludy/issues/3133) Threads, [#3134](https://github.com/DOS/Ludy/issues/3134) YouTube, [#3135](https://github.com/DOS/Ludy/issues/3135) TikTok (chờ quyền); chat sàn thương mại điện tử chưa có issue.
