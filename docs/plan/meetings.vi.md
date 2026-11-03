# Ghi chú cuộc họp bằng AI: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [meetings.md](meetings.md) và [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) (epic [#932](https://github.com/DOS/Ludy/issues/932), ngày 2026-11-03). Bản tiếng Anh là bản chuẩn. **Đây mới là đề xuất để JOY bàn: chưa xây gì, chưa mở issue xây nào, chưa tốn tiền, chưa liên hệ nhà cung cấp nào.** Theo lời JOY: làm gọn, tính năng lõi trước, AI làm việc ngay trong luồng.

## Người dùng được gì

Chủ một công ty một người hoặc một nhóm nhỏ họp hằng tuần: với nhân viên, với khách chốt báo giá, với nhà cung cấp. Hôm nay những gì đã hứa thường bị quên. Sau lát cắt đầu tiên, người đó:

1. bấm "Ghi âm" ngay trên trình duyệt, hoặc tải lên file ghi âm từ điện thoại, Zoom, Meet;
2. xác nhận mọi người trong cuộc họp đã được báo là đang ghi âm;
3. vài phút sau có **bản chép lời** (toàn bộ lời nói thành chữ, tiếng Việt trước, có mốc thời gian, có tách người nói khi nhà cung cấp hỗ trợ), một **tóm tắt** ngắn, các **quyết định** đã chốt và các **việc cần làm** (ai làm, hạn khi nào);
4. biến việc cần làm thành việc của nhóm bằng một cú bấm mỗi việc, hoặc một cú bấm cho tất cả các việc "sạch" (đã qua kiểm tra tự động);
5. yên tâm là file ghi âm tự xóa sau 30 ngày, bản chép lời sau thời hạn tổ chức chọn.

## Lát cắt đầu tiên làm gì

- **Vy làm việc ngay trên màn hình cuộc họp**: chép lời, tóm tắt, liệt kê quyết định, soạn việc cần làm. Mỗi việc có đường dẫn tới đúng đoạn trong bản chép lời để người dùng kiểm tra trong một cú bấm.
- **Mọi thứ AI viết đều là "Đề xuất"**: AI không tự tạo việc. Mã máy kiểm tra trước (số liệu trong tóm tắt phải có trong bản chép lời, ngày hạn do máy tính tính, người được giao phải là người dự họp). Người dùng bấm duyệt.
- **Ai đó nói trong cuộc họp kiểu "Vy, chuyển tiền cho..."** thì cũng chỉ thành một đề xuất bị đánh dấu nghi vấn, không có gì tự chạy.
- **Tắt AI vẫn dùng được**: vẫn ghi âm, nghe lại, gõ ghi chú, tạo việc bằng tay.
- **Chi phí AI** đi qua đồng hồ đo ngân sách AI hiện có, cộng thêm phần đo theo số phút ghi âm. Hết ngân sách thì cuộc họp chờ, không mất gì. Nút "Dừng AI" có sẵn cũng dừng được phần này.
- Nằm trong ứng dụng **Ludy Notes** (ứng dụng của Vy), thành một thẻ "Cuộc họp".

## An toàn dữ liệu, nói đơn giản

- **Ai đọc được cuộc họp**: người ghi âm và các thành viên được ghi là người dự họp. Người ghi âm có thể chia sẻ cho cả tổ chức. Chủ và quản trị viên thấy là có cuộc họp (ngày, độ dài, ai ghi) để quản lý ngân sách và thời hạn, có quyền xóa, nhưng không đọc nội dung nếu không được chia sẻ. Các AI agent của tổ chức không đọc gì.
- **Vy của ai thì chỉ thấy cái người đó thấy**, đúng quyết định của JOY ngày 2026-11-03 (#1677). Bản tin chung của cả nhóm không mang nội dung cuộc họp.
- **File ghi âm được mã hóa** (biến thành dữ liệu không đọc được nếu không có khóa), mỗi cuộc họp một khóa riêng. **Xóa bằng cách hủy khóa**: khi hết hạn hoặc khi xóa cuộc họp, Ludy hủy khóa, thế là mọi bản sao của file (cả bản cũ trong kho lưu trữ và bản sao lưu) không ai mở được nữa. Lý do: kho lưu trữ file của Ludy giữ cả các phiên bản cũ và Ludy không có quyền xóa chúng, nên xóa file thông thường là không đủ.
- **File gốc và video không được giữ lại**: chỉ giữ phần âm thanh đã chuẩn hóa.
- **File ghi âm chỉ được mở trong một "hộp cách ly" riêng** (một container mới, không có mạng, không có mật khẩu nào), để file độc hại không chạm vào máy chủ chính.
- **Nhà cung cấp chép lời** thay được: mặc định đi qua lớp AI hiện có. Người tự cài Ludy có thể dùng mô hình chép lời chạy trên máy của mình (họ mô hình Whisper), để âm thanh không ra khỏi máy.

## Luật dữ liệu cá nhân

Luật Bảo vệ dữ liệu cá nhân 91/2025 và Nghị định 356/2025 (thay Nghị định 13/2023). Phần này mới đọc qua bình luận, **luật sư (#62) phải xác nhận**.

- Tổ chức ghi âm chịu trách nhiệm báo cho mọi người có giọng nói trong bản ghi: nhân viên, khách, nhà cung cấp, người họp từ xa. Im lặng không phải là đồng ý, và người ta có quyền rút lại.
- Ludy bắt buộc bước xác nhận trước khi nhận âm thanh, và lưu lại: ai xác nhận, lúc nào, báo bằng cách nào (nói lúc bắt đầu, ghi trong lời mời, đồng ý bằng văn bản). Màn hình có sẵn một câu thông báo để đọc to.
- Không lưu "dấu vân giọng nói" và không nhận diện người nói giữa các cuộc họp, vì giọng nói dùng để nhận diện có thể là dữ liệu sinh trắc học, loại nhạy cảm.

## JOY cần quyết

| # | Quyết định | Đề xuất | Nếu chưa trả lời |
|---|---|---|---|
| 1 | Khi nào xây lát cắt đầu tiên? | Các bước 1 đến 8 trong mốc M3 (thí điểm có trả phí), độ ưu tiên P2, sau các việc P0 và P1 của M3; phần còn lại để sau (Icebox) | Giữ trong Icebox như mặc định cũ |
| 2 | Ai đọc được một cuộc họp? | Người ghi âm và thành viên dự họp; có thể chia sẻ cho cả tổ chức; chủ và quản trị viên được xóa, không được đọc nếu không chia sẻ | Làm theo đề xuất |
| 3 | Giữ bao lâu mặc định? | Âm thanh 30 ngày sau khi có bản chép lời; bản chép lời và tóm tắt 12 tháng; tổ chức đổi được | Làm theo đề xuất |
| 4 | Bước xác nhận đồng ý chặt đến đâu? | Bắt buộc tích xác nhận, chọn cách đã báo, có câu đọc to; chưa cần từng người ký | Làm theo đề xuất, chờ luật sư |
| 5 | Trên Ludy Cloud, âm thanh gửi đi chép lời ở đâu? | Một mô hình họ Whisper chạy tại Việt Nam, không lưu lại âm thanh, chọn trong phần riêng của Ludy Cloud; chưa chọn thì tắt tính năng trên Cloud | Người tự cài tự chọn; Cloud để tắt |
| 6 | Đặt ở đâu trong ứng dụng? | Thẻ "Cuộc họp" trong Ludy Notes, do Vy làm | Làm theo đề xuất |

## Việc chỉ người làm được

- **Luật sư (#62)**: các câu hỏi về đồng ý ghi âm, giọng nói có phải dữ liệu sinh trắc học không, gửi âm thanh ra nước ngoài.
- **JOY hoặc người JOY nhờ**: ghi 5 đến 10 cuộc họp mẫu theo kịch bản, có giấy đồng ý của từng giọng nói, để đo độ chính xác của bản chép lời. Âm thanh để ngoài kho mã công khai.

## Các bước xây (mỗi bước một issue, một PR)

1. Bài kiểm thử an toàn trước: chứng minh người không được đọc thì không đọc được.
2. Cuộc họp và file ghi âm: tải lên, xác nhận đồng ý, mã hóa, nghe lại, xóa bằng hủy khóa.
3. Hộp cách ly xử lý âm thanh.
4. Chép lời, đo ngân sách theo phút, nút dừng AI, đo độ chính xác.
5. Thời hạn lưu giữ và hủy khóa tự động, xóa khi đóng tổ chức.
6. Tóm tắt, quyết định, việc cần làm thành việc của nhóm.
7. Ghi âm ngay trên trình duyệt.
8. Hai việc của người: luật sư, cuộc họp mẫu.

## Để sau

Gắn cuộc họp với khách hàng, cơ hội bán hàng, lịch hẹn; tìm kiếm trong các cuộc họp; Vy soạn email cảm ơn và nhắc việc sau họp (người bấm gửi); "bot" tự vào Meet, Zoom, Teams để ghi và ghi chú trực tiếp; tìm dữ liệu cá nhân trong bản chép lời khi có yêu cầu xóa; ghi âm bằng ứng dụng điện thoại. Không làm: nhận diện giọng nói giữa các cuộc họp, ghi âm không báo trước.
