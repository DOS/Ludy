# Hội thoại dùng chung: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [conversations.md](conversations.md) và [ADR-0041](../adr/0041-conversation-core.md), ngày 2026-11-01 (#2213). Chưa có dòng code nào được viết và chưa mở issue build nào. Sẽ không build gì cho đến khi JOY duyệt (bảy câu hỏi ở cuối).

## Quyết định của JOY và nó có nghĩa là gì

- **Trả lời bình luận** trên bài đăng của chính doanh nghiệp nằm trong **Social**.
- **Tin nhắn riêng** (Messenger, tin nhắn Instagram, chat Zalo OA) nằm trong **Service** (hiện ra dưới tên Hộp thư).
- **Một lõi dùng chung ở dưới**, để Social và Service mỗi bên bán và chạy riêng được, bên kia thêm màn hình chứ không thêm một bản dữ liệu thứ hai.

Kế hoạch cũ ghi ngược lại (bình luận thuộc hộp thư của Service). Hai chỗ đó đổi theo quyết định của JOY: dòng "Not in Social" trong [social.md](social.md) và đoạn Service và Social trong kế hoạch lõi.

## Lõi dùng chung gồm những gì

- Đặt trong **kernel** (cùng chỗ với kết nối kênh, `party`, nhiệm vụ, nhật ký hoạt động), vì cả Social và Service đều phải chạy riêng được, không bên nào được sở hữu kho dữ liệu.
- Một kho hội thoại và tin nhắn, có phân **loại**: chuỗi bình luận hoặc tin nhắn riêng. Mỗi bình luận cấp một là một hội thoại.
- Liên hệ (người dùng nền tảng nối với `party`), giao việc, trạng thái **Mới, Đang chờ, Đã xử lý**, ghi chú nội bộ, câu trả lời mẫu, bản nháp do AI soạn (người bấm Gửi), trạng thái đã đọc.
- **Tránh hai người cùng trả lời:** giao việc là khóa mềm, có dấu "Linh đang trả lời" hết hạn sau 60 giây, và khi gửi hệ thống kiểm tra có tin mới hơn không (nếu có thì từ chối và hiện tin mới).
- **Công tắc rảnh/bận** của từng thành viên, dùng để biết báo cho ai, chưa tự chia việc xoay vòng.

## Bố cục: một ứng dụng trên thanh bên có nhiều nhóm (đề xuất)

- Hootsuite để mỗi sản phẩm một mục trên thanh bên, nhưng chính Hootsuite cũng để Ads làm một nhóm bên trong Perch (sản phẩm đăng bài).
- **Đề xuất (a):** một ứng dụng trên thanh bên (tên tạm **Kênh**) có ba nhóm: **Đăng bài** (Social), **Hộp thư** (Service), **Quảng cáo** (Ads). Mỗi nhóm chỉ hiện khi module của nó được bật, nên doanh nghiệp chỉ dùng Service chỉ thấy nhóm Hộp thư.
- Khung giao diện hiện tại **đã làm đúng như vậy**: mỗi module khai báo ứng dụng và nhóm của mình, nhóm của module chưa bật bị ẩn. Cái giá chỉ là đổi tên mã ứng dụng "social" và các nhãn menu, không đổi địa chỉ trang.
- Phương án (b) là ba mục riêng như Hootsuite: giống ảnh chụp hơn nhưng thanh bên dài hơn (với doanh nghiệp nhỏ), và chuyển ứng dụng khi đi từ bình luận sang tin nhắn riêng của chính người đó.
- Tài liệu Ads đã nói "một nhóm bên trong ứng dụng Social": ứng dụng đó chính là ứng dụng này, nên hai tài liệu khớp nhau.

## Bình luận có hiện trong hộp thư Service không?

**Đề xuất: không**, bình luận chỉ ở Social (dưới bài và trong hộp bình luận), Service chỉ có tin nhắn riêng. Ba cầu nối:
1. **Trả lời riêng:** từ một bình luận, gửi tin nhắn riêng cho người bình luận (Meta cho một tin trong 7 ngày). Từ lúc đó là hội thoại tin nhắn riêng, hiện trong Service.
2. **Chuyển sang Service:** biến bình luận thành một ca (khi Service có ca; trước đó là một nhiệm vụ).
3. **Liên hệ chung:** hai luồng cùng nối với một người.
Doanh nghiệp chỉ bật Service sẽ chưa thấy bình luận trong v1 (câu hỏi 2).

## Bình luận và tin nhắn đến và đi như thế nào

- **Đến:** nền tảng gọi một địa chỉ webhook công khai; hệ thống kiểm tra chữ ký rồi chỉ xếp vào hàng đợi; một tác vụ nền tìm đúng kết nối (từ mã trang của nền tảng, không từ nội dung thông báo) rồi lưu. **Lưu luôn nội dung trong webhook** vì Meta không có API xem lại lịch sử (thử lại 36 giờ, chỉ đọc lại được 20 tin gần nhất), Zalo không thử lại khi lỗi. Có tác vụ đối chiếu định kỳ làm lưới an toàn.
- **Đi:** cùng đường đi "đúng một lần" như đăng bài: ghi trước khi gọi, không bao giờ gửi lại mù quáng, kết quả không rõ thì đối chiếu bằng sự kiện "tin của chính Trang" hoặc đọc lại cuộc trò chuyện. Hệ thống kiểm tra cửa sổ trả lời của nền tảng trước khi gửi (Meta 24 giờ, 7 ngày với thẻ nhân viên thật; Zalo 48 giờ theo nguồn thứ cấp).
- **Facebook Page:** bình luận qua webhook `feed`, tin nhắn qua `messages`; trả lời bình luận, ẩn bình luận, trả lời riêng đều có tài liệu chính thức. Mọi quyền liên quan cần App Review nếu phục vụ Trang của người khác. Kết nối Facebook hiện có phải kết nối lại để cấp thêm quyền (một lựa chọn bật thêm trên màn hình kết nối).
- **Zalo OA:** chỉ tin nhắn riêng. **Không thấy API bình luận nào** (chưa phải bằng chứng là không có). Trang tài liệu nhà phát triển của Zalo không đọc được nên gần như mọi chi tiết Zalo là nguồn thứ cấp và được ghi rõ [S] hoặc [U]; buổi chạy thử thật sẽ xác nhận. Gửi tin qua API cần OA đăng ký gói trả phí có tích hợp API (Growth trở lên theo trang giá của Zalo).
- Các điểm chưa chắc, như Meta xử lý Page Inbox thế nào khi Ludy cũng đọc Trang, và webhook `feed` có chạy ở chế độ phát triển không, được liệt kê [U] trong kế hoạch.

## Ai được xem gì

- **Bình luận** xem được như bài đăng chứa nó: chủ, quản trị, thành viên và người xem có quyền với kênh đó.
- **Tin nhắn riêng** chỉ chủ, quản trị và người giữ vai trò `desk.agent`. Người xem không bao giờ xem được. Quy tắc này được cơ sở dữ liệu ép, không chỉ ẩn trên màn hình.
- Giới hạn "thành viên này chỉ thấy một số kênh" hiện nằm trong Social nên **chuyển vào kernel** để lõi áp dụng được.
- AI chỉ soạn bản nháp, **luôn là người bấm Gửi**, tác nhân không bao giờ gửi, ẩn hay đóng hội thoại.

## Dữ liệu cá nhân (bình luận và tin nhắn là dữ liệu của người khác)

- Tên, ảnh, mã người dùng và nội dung đều xếp loại `pii`. Hệ thống **không tự tạo liên hệ**: một người tự nối hoặc tạo.
- Không để nội dung trong bản ghi kiểm toán, nhật ký hoạt động hay log, chỉ mã và độ dài (bản kiểm toán không xóa được).
- **Thời gian giữ** là cài đặt của tổ chức, mặc định 24 tháng sau tin cuối, có tác vụ xóa hằng ngày. Có lệnh **xóa dữ liệu một người** (mức R3, không hoàn tác) để trả lời yêu cầu theo luật bảo vệ dữ liệu cá nhân. Nếu nền tảng báo bình luận hay tin đã bị xóa thì nội dung được xóa theo.
- **Gọi lại xóa dữ liệu của Meta** nói về người dùng ứng dụng (thành viên Ludy đã kết nối Trang), không phải khách nhắn tin. Cách đọc thận trọng: nhận được thì ngắt kết nối của thành viên đó và xóa dữ liệu đọc qua các kết nối ấy, trừ khi chủ tổ chức nhận lại kết nối trước. Một luật sư cần xác nhận trước khi chạy Ludy Cloud cho doanh nghiệp khác.
- Ảnh khách gửi được lưu (có giới hạn kích thước, không bao giờ hiển thị như HTML); video, âm thanh, tệp chỉ hiện liên kết "mở trên nền tảng".

## Các việc build (chưa mở issue)

| Mã | Người dùng thấy gì |
|---|---|
| CV1 | Lõi, kênh giả (`sandbox`), bình luận trong Social: trả lời, ẩn, đóng, giao việc, ghi chú |
| CV2 | Bình luận Facebook Page thật, trả lời hiện trên Facebook |
| CV3 | Ứng dụng "Kênh" và hộp thư Service ba khung trên kênh giả: Mới, Đang chờ, Đã xử lý, giao việc, dấu "đang trả lời", bảng liên hệ, ghi chú, câu mẫu |
| CV4 | Tin nhắn Messenger thật và "trả lời riêng" từ bình luận |
| CV5 | Tin nhắn Zalo OA thật trong cửa sổ miễn phí |
| CV6 | Thời gian giữ, xóa dữ liệu một người, gọi lại xóa dữ liệu của Meta |
| CV7 đến CV9 | Instagram, bản nháp AI, chuyển bình luận sang Service thành ca (sau) |

Việc của JOY khi bắt đầu build (không agent nào tự làm): thêm quyền Trang vào ứng dụng Meta (hoặc tạo ứng dụng Messenger riêng nếu Meta bắt buộc), trỏ webhook về địa chỉ triển khai, OA Zalo dùng gói có API, đặt địa chỉ gọi lại và khóa bí mật OA; về sau với Ludy Cloud là App Review và Business Verification, và nhờ luật sư đọc điều khoản Meta về tin nhắn khách lưu trữ.

## Câu hỏi cho JOY

Mỗi câu có phương án, đề xuất và hệ quả nếu không trả lời. Chi tiết trong [mục 16 của conversations.md](conversations.md#16-questions-for-joy).

1. **Bố cục: một ứng dụng với nhiều nhóm hay các mục riêng trên thanh bên?** Đề xuất: **một ứng dụng với ba nhóm** (khung giao diện đã làm sẵn kiểu này, thanh bên ngắn, Hootsuite cũng đặt Ads làm nhóm). Không trả lời: làm như đề xuất, tên tạm "Kênh".
2. **Bình luận có hiện luôn trong hộp thư Service không?** Đề xuất: **không**, chỉ ở Social, có cầu nối "trả lời riêng" và "chuyển sang Service". Khác: hiện bình luận trong Service khi Social tắt; hoặc luôn hiện ở cả hai (hai bộ đếm chưa đọc). Không trả lời: như đề xuất.
3. **Ứng dụng tên gì?** (JOY cùng nhóm Frontend.) Đề xuất: **Kênh**; hoặc Ludy Channels. Chỉ là nhãn nên đổi sau được. Không trả lời: "Kênh" làm tên tạm.
4. **Thành viên trả lời bình luận công khai có cần duyệt không?** Đề xuất: **không duyệt ở v1**, nhưng bản nháp AI luôn cần người bấm Gửi. Khác: cần chủ hoặc quản trị duyệt như bài đăng (an toàn hơn cho agency, chậm với công ty một người). Không trả lời: không duyệt.
5. **Giữ bình luận và tin nhắn bao lâu?** (JOY, luật sư về mặt pháp lý.) Đề xuất: **24 tháng sau tin cuối**, chủ chọn 6, 12, 24 tháng hoặc giữ đến khi xóa. Khác: 12 tháng; hoặc giữ mãi. Không trả lời: 24 tháng, và luật sư đọc điều khoản Meta trước khi chạy Ludy Cloud.
6. **Zalo OA gửi tin cần gói OA trả phí có API của khách. Chấp nhận không?** Đề xuất: **chấp nhận**, báo rõ "gói OA của bạn chưa có tích hợp API" và ghi tên gói vào tài liệu. Khác: hoãn Zalo đến khi giá xác nhận trên trang chính thức đọc được. Không trả lời: như đề xuất, buổi chạy thử thật xác nhận tên gói và hạn mức.
7. **Thứ tự build?** Đề xuất: **lõi và bình luận trên kênh giả, bình luận Facebook Page, ứng dụng Kênh và hộp thư Service trên kênh giả, Messenger, Zalo, rồi thời gian giữ dữ liệu**. Khác: Zalo trước Messenger (nhưng cần hộp thư Service trước nên kết quả nhìn thấy đầu tiên đến muộn hơn). Không trả lời: như đề xuất.
