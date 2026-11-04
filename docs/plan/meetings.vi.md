# Ghi chú cuộc họp bằng AI: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [meetings.md](meetings.md) và [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) (epic [#932](https://github.com/DOS/Ludy/issues/932), ngày 2026-11-03, đã sửa cùng ngày theo ý JOY về tiện ích trình duyệt và video). Bản tiếng Anh là bản chuẩn. **Đây mới là đề xuất để JOY bàn: chưa xây gì, chưa mở issue xây nào, chưa tốn tiền, chưa liên hệ nhà cung cấp nào.** Theo lời JOY: làm gọn, tính năng lõi trước, AI làm việc ngay trong luồng.

## Người dùng được gì

Chủ một công ty một người hoặc một nhóm nhỏ họp hằng tuần: với nhân viên, với khách chốt báo giá, với nhà cung cấp. Hôm nay những gì đã hứa thường bị quên. Sau lát cắt đầu tiên, người đó:

1. ghi lại cuộc họp theo một trong ba cách (xem mục dưới);
2. xác nhận mọi người trong cuộc họp đã được báo là đang ghi;
3. vài phút sau có **bản chép lời** (toàn bộ lời nói thành chữ, tiếng Việt trước, có mốc thời gian, có tách người nói khi nhà cung cấp hỗ trợ), một **tóm tắt** ngắn, các **quyết định** đã chốt và các **việc cần làm** (ai làm, hạn khi nào). Lúc đầu chỉ người ghi thấy; người ghi xem lại, sửa nếu cần, rồi bấm một nút để chia sẻ cho người dự họp;
4. biến việc cần làm thành việc của nhóm bằng một cú bấm mỗi việc, hoặc một cú bấm cho tất cả các việc "sạch" (đã qua kiểm tra tự động);
5. giữ cả video nếu tích ô "Ghi cả video" cho cuộc họp đó (mặc định chỉ ghi âm thanh);
6. yên tâm là âm thanh tự xóa sau 30 ngày, video (nếu giữ) sau 7 ngày, bản chép lời sau thời hạn tổ chức chọn.

## Ba cách ghi cuộc họp

- **(a) Tiện ích Ludy cho trình duyệt** (cách chính cho họp trực tuyến): một "tiện ích" (extension, phần mềm nhỏ cài vào Chrome hoặc Edge). Khi người dùng bấm nút trên thẻ đang họp, tiện ích ghi âm thanh của thẻ đó, cộng giọng của chính người dùng từ micro, và ghi cả hình nếu tích chọn. Dùng được với Google Meet, và với Teams, Zoom khi mở trên trình duyệt. **Không cần bot** (tài khoản máy tự vào họp) và **không cần cài ứng dụng máy tính**. Luôn hiện dấu đang ghi và bắt xác nhận đồng ý trước khi ghi.
- **(b) Ghi bằng micro trong ứng dụng Ludy** cho cuộc họp trực tiếp trong phòng, trên máy tính hoặc điện thoại, không cần tiện ích.
- **(c) Tải lên file ghi âm hoặc ghi hình** có sẵn.

**Giới hạn, nói thẳng:**
- Ứng dụng Zoom và Teams cài trên máy tính thì không ghi được; người dùng tải lên bản ghi mà các ứng dụng đó tạo ra.
- Safari và Firefox chỉ ghi được bằng micro (cách b).
- Tiện ích phải lên Chrome Web Store (cửa hàng tiện ích của Google). Ludy tự chịu trách nhiệm duyệt, quyền truy cập, cập nhật và an toàn của tiện ích. JOY cần mở tài khoản nhà phát triển trên cửa hàng đó.

## Tiện ích Ludy dùng chung cho các ứng dụng

Theo lời JOY: "nên xài extension Ludy đi, extension còn có tác dụng cho App Engage nữa". Vậy đây là **một tiện ích Ludy chung**, ghi cuộc họp là tính năng đầu tiên. Phần khung gồm: đăng nhập vào tổ chức, chọn tổ chức (nếu thuộc nhiều tổ chức), chỉ hiện tính năng khi ứng dụng tương ứng đang bật trong tổ chức, và mỗi tính năng chỉ xin quyền trình duyệt khi người dùng bật nó.

Khung cũng có sẵn một đường chung "gửi trang đang xem vào Ludy": chỉ khi người dùng bấm, lấy địa chỉ, tiêu đề và đoạn chữ đang chọn của trang trước mặt, gửi vào đúng một lệnh của Ludy dưới tên người dùng và tổ chức của họ, có kiểm tra quyền và ghi nhật ký. **Ý tưởng cho sau, không phải cam kết**: Ludy Engage có thể dùng để đưa một khách tiềm năng hoặc một cuộc trò chuyện từ trang web vào Hộp thư. Việc đó do nhóm Engage lên kế hoạch; kế hoạch này không xây tính năng Engage nào.

**An toàn của tiện ích:** xin ít quyền nhất có thể; mặc định không có quyền đọc các trang web; không bao giờ đọc trang hay thẻ khác nếu người dùng không bấm; không biết mật khẩu hay phiên đăng nhập của người dùng, chỉ giữ một "mã truy cập" (token) riêng, gắn với đúng một người và một tổ chức, chỉ làm được đúng những việc của tính năng đã bật, hết hạn sau 90 ngày, thu hồi được bằng một cú bấm và tự mất hiệu lực khi người đó bị xóa khỏi tổ chức.

## Lát cắt đầu tiên làm gì

- **Vy làm việc ngay trên màn hình cuộc họp**: chép lời, tóm tắt, liệt kê quyết định, soạn việc cần làm. Mỗi việc có đường dẫn tới đúng đoạn trong bản chép lời để kiểm tra trong một cú bấm.
- **Kết quả của Vy về tay người ghi trước**: Vy làm việc với tư cách "Vy của người ghi", nên bản chép lời, tóm tắt và việc cần làm nằm trong phần riêng của người ghi, chưa ai khác thấy. Người ghi bấm "Chia sẻ với người dự họp" thì người dự họp mới thấy. Không có gì Vy viết ra tự đến tay người khác. Kết quả không được chia sẻ sẽ tự xóa sau 30 ngày.
- **Mọi thứ AI viết đều là "Đề xuất"**: AI không tự tạo việc. Mã máy kiểm tra trước (số liệu trong tóm tắt phải có trong bản chép lời, ngày hạn do máy tính tính, người được giao phải là người dự họp). Người dùng bấm duyệt.
- **Ai đó nói trong cuộc họp kiểu "Vy, chuyển tiền cho..."** cũng chỉ thành một đề xuất bị đánh dấu nghi vấn, không có gì tự chạy.
- **Tắt AI vẫn dùng được**: vẫn ghi, nghe lại, gõ ghi chú, tạo việc bằng tay.
- **Chi phí AI** đi qua đồng hồ đo ngân sách AI hiện có, cộng thêm phần đo theo số phút ghi âm. Video chỉ tốn chỗ lưu, không tốn AI, vì chỉ phần âm thanh được chép lời. Hết ngân sách thì cuộc họp chờ, không mất gì. Nút "Dừng AI" có sẵn cũng dừng được phần này.
- Nằm trong ứng dụng **Ludy Notes** (ứng dụng của Vy), thành một thẻ "Cuộc họp".

## An toàn dữ liệu, nói đơn giản

- **Ai đọc được cuộc họp**: người ghi và các thành viên được ghi là người dự họp. Người ghi có thể chia sẻ cho cả tổ chức. Chủ và quản trị viên thấy là có cuộc họp (ngày, độ dài, ai ghi), có quyền xóa, nhưng không đọc nội dung nếu không được chia sẻ. Các AI agent của tổ chức không đọc gì.
- **Vy của ai thì chỉ thấy cái người đó thấy**, đúng quyết định của JOY ngày 2026-11-03 (#1677). Cơ chế chung cho việc này đang được viết thành ADR-0049 (PR [#2572](https://github.com/DOS/Ludy/pull/2572), "ADR" là bản ghi quyết định kỹ thuật), dùng chung cho Notes, Cuộc họp và Dự án; PO Nền tảng đã chốt cách Cuộc họp dùng nó như mô tả ở trên.
- **Âm thanh và video được mã hóa** (biến thành dữ liệu không đọc được nếu không có khóa), mỗi cuộc họp một khóa cho âm thanh và một khóa riêng cho video. **Xóa bằng cách hủy khóa**: khi hết hạn hoặc khi xóa, Ludy hủy khóa, thế là mọi bản sao (cả bản cũ trong kho lưu trữ và bản sao lưu) không ai mở được nữa. Lý do: kho lưu trữ file giữ cả các phiên bản cũ và Ludy không có quyền xóa chúng.
- **Video chỉ được giữ khi tích ô "Ghi cả video"** (có trong tiện ích và trong phần ghi của ứng dụng, chọn cho từng cuộc họp); không tích thì phần hình bị bỏ ngay, không lưu.
- **File chỉ được mở trong một "hộp cách ly" riêng** (một container mới, không có mạng, không có mật khẩu nào), nơi cũng tách âm thanh ra khỏi video để chép lời.
- **Nhà cung cấp chép lời** thay được. Người tự cài Ludy có thể dùng mô hình chép lời chạy trên máy của mình (họ mô hình Whisper), để âm thanh không ra khỏi máy.

## Luật dữ liệu cá nhân

Luật Bảo vệ dữ liệu cá nhân 91/2025 và Nghị định 356/2025 (thay Nghị định 13/2023). Phần này mới đọc qua bình luận, **luật sư (#62) phải xác nhận**.

- Tổ chức ghi chịu trách nhiệm báo cho mọi người có giọng nói trong bản ghi: nhân viên, khách, nhà cung cấp, người họp từ xa. Với tiện ích không có bot báo trong cuộc gọi, nên lời báo của người ghi là lời báo duy nhất. Im lặng không phải là đồng ý, và người ta có quyền rút lại.
- Ludy bắt buộc bước xác nhận trước khi nhận âm thanh, và lưu lại: ai xác nhận, lúc nào, báo bằng cách nào. Màn hình có sẵn một câu thông báo để đọc to.
- Không lưu "dấu vân giọng nói" và không nhận diện người nói giữa các cuộc họp, vì giọng nói dùng để nhận diện có thể là dữ liệu sinh trắc học, loại nhạy cảm.

## JOY cần quyết

| # | Quyết định | Đề xuất | Nếu chưa trả lời |
|---|---|---|---|
| 1 | Khi nào xây lát cắt đầu tiên? | Các bước M1 đến M11 trong mốc M3 (thí điểm có trả phí), độ ưu tiên P2, sau các việc P0 và P1 của M3; phần còn lại để sau (Icebox) | Giữ trong Icebox như mặc định cũ |
| 2 | Ai đọc được một cuộc họp? | Người ghi và thành viên dự họp; có thể chia sẻ cho cả tổ chức; chủ và quản trị viên được xóa, không được đọc nếu không chia sẻ | Làm theo đề xuất |
| 3 | Giữ âm thanh, video và bản chép lời bao lâu mặc định? | Âm thanh 30 ngày sau khi có bản chép lời; video (nếu giữ) 7 ngày, hoặc 30 ngày; bản chép lời và tóm tắt 12 tháng; tổ chức đổi được | Làm theo đề xuất |
| 4 | Bước xác nhận đồng ý chặt đến đâu? | Bắt buộc tích xác nhận, chọn cách đã báo, có câu đọc to; chưa cần từng người ký | Làm theo đề xuất, chờ luật sư |
| 5 | Trên Ludy Cloud, âm thanh gửi đi chép lời ở đâu? | Một mô hình họ Whisper chạy tại Việt Nam, không lưu lại âm thanh, chọn trong phần riêng của Ludy Cloud; chưa chọn thì tắt tính năng trên Cloud | Người tự cài tự chọn; Cloud để tắt |
| 6 | Đặt ở đâu trong ứng dụng? | Thẻ "Cuộc họp" trong Ludy Notes, do Vy làm | Làm theo đề xuất |

Đã quyết: **video** (JOY, 2026-11-04: "Có option cho cái extension là được mà? mặc định voice only, có thêm nút check record video thôi"): mặc định chỉ ghi âm thanh; có ô "Ghi cả video" trong tiện ích và trong phần ghi của ứng dụng, chọn cho từng cuộc họp; video giữ lại có khóa riêng; chép lời luôn dùng âm thanh.

## Việc chỉ người làm được

- **JOY**: mở tài khoản nhà phát triển Chrome Web Store, điền trang giới thiệu và câu hỏi quyền riêng tư của cửa hàng, bấm phát hành mỗi bản mà hệ thống tự động đã đóng gói. Không agent nào giữ tài khoản này.
- **Luật sư (#62)**: các câu hỏi về đồng ý ghi âm, giọng nói có phải dữ liệu sinh trắc học không, gửi âm thanh ra nước ngoài.
- **JOY hoặc người JOY nhờ**: ghi 5 đến 10 cuộc họp mẫu theo kịch bản, có giấy đồng ý của từng giọng nói, để đo độ chính xác của bản chép lời. Âm thanh để ngoài kho mã công khai.

## Các bước xây (mỗi bước một issue, một PR)

1. Bài kiểm thử an toàn trước: chứng minh người không được đọc thì không đọc được.
2. Cuộc họp, âm thanh và video: tải lên, xác nhận đồng ý, mã hóa, nghe và xem lại, xóa bằng hủy khóa.
3. Hộp cách ly xử lý âm thanh và video.
4. Chép lời bằng Vy của người ghi (kết quả chỉ người ghi thấy), đo ngân sách theo phút, nút dừng AI, đo độ chính xác.
5. Thời hạn lưu giữ và hủy khóa tự động, xóa khi đóng tổ chức.
6. Tóm tắt, quyết định, việc cần làm; nút chia sẻ cho người dự họp; việc cần làm thành việc của nhóm.
7. Ghi bằng micro ngay trong ứng dụng.
8. Mã truy cập (token) riêng cho tiện ích, thu hồi được.
9. Tiện ích Ludy với khung chung và tính năng ghi cuộc họp.
10. Việc của JOY: tài khoản Chrome Web Store.
11. Việc của người: luật sư, cuộc họp mẫu.

## Để sau, và không làm

- **Để sau**: gắn cuộc họp với khách hàng, cơ hội bán hàng, lịch hẹn; tìm kiếm trong các cuộc họp; Vy soạn email sau họp (người bấm gửi); bot tự vào Meet, Zoom, Teams và ghi chú trực tiếp (JOY thấy bot phiền nên để sau); tìm dữ liệu cá nhân trong bản chép lời khi có yêu cầu xóa; ghi âm bằng ứng dụng điện thoại; đưa tiện ích lên cửa hàng của Edge nếu cần.
- **Không làm**: ứng dụng cài trên máy tính (một ứng dụng chỉ để ghi âm không đáng công duy trì, và Ludy hiện chưa có ứng dụng máy tính nào); nhận diện giọng nói giữa các cuộc họp; ghi mà không báo trước.
