# Hội thoại dùng chung: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [conversations.md](conversations.md) và [ADR-0041](../adr/0041-conversation-core.md), ngày 2026-11-01 (#2213), cập nhật 2026-11-03 theo quyết định của JOY (#2437): hộp thư theo kiểu Crisp và Intercom. Phần mới (email, phân loại ý định, bố cục Ludy Engage) chưa có dòng code nào và chưa mở issue build nào; trạng thái các việc build cũ nằm trong conversations.md. Sẽ không build gì cho đến khi JOY duyệt (bảy câu hỏi ở cuối).

## Quyết định của JOY và nó có nghĩa là gì

Quyết định ngày 2026-11-03 (ghi trên #2213, làm từ #2437) thay cho cách chia ngày 2026-11-01 (bình luận ở Social, tin nhắn riêng ở Service): **hộp thư theo kiểu Crisp và Intercom, không theo Zendesk.**

- **Mọi tương tác của khách là một mô hình duy nhất: hội thoại.** Gồm chat (Messenger, tin nhắn Instagram, chat Zalo OA), bình luận trên bài đăng của chính doanh nghiệp (Facebook, Instagram) và email của khách, cả chiều đến lẫn chiều đi.
- **Một hộp thư: Hộp thư.** Mỗi hội thoại hiện như một chuỗi chat với ba tab **Mới, Đang chờ, Đã xử lý**. Email cũng hiện như các bong bóng chat (phần trích dẫn cũ được gập lại). Nhân viên trả lời trong cùng một ô, bất kể kênh nào.
- **Không còn vụ việc, phiếu hay SLA.** Hội thoại cần việc nội bộ thì nối với một nhiệm vụ (`crove_kernel.task`); nó không bao giờ biến thành một bản ghi có số thứ tự, và không có đồng hồ đếm thời gian trả lời.
- **Trang bài đăng vẫn có tab Bình luận:** cùng những hội thoại đó, lọc theo bài. Đó là một cách nhìn vào hộp thư, không phải hộp thư thứ hai, nên mỗi bình luận chỉ có một bộ đếm chưa đọc.
- **Một lõi dùng chung ở dưới**, để hộp thư và phần đăng bài chạy từ cùng một dữ liệu, không bên nào giữ bản sao thứ hai.
- **Đồng nghiệp AI trong Hộp thư** (Uy trong Ludy Engage; tên nằm sau bảng danh sách đồng nghiệp và khóa i18n) phân loại ý định của khách, gợi ý hồ sơ liên hệ khớp và soạn bản nháp để người bấm Gửi. Không tự gửi, và lõi vẫn chạy khi tắt AI.

Kế hoạch cũ ghi ngược lại (bình luận thuộc hộp thư của Service, rồi ngày 2026-11-01 là bình luận ở Social). Dòng "Not in Social" trong [social.md](social.md) và đoạn Service và Social trong kế hoạch lõi được sửa theo (kế hoạch lõi trong cùng PR này, social.md trong PR của CV3).

## Lõi dùng chung gồm những gì

- Đặt trong **kernel** (cùng chỗ với kết nối kênh, `party`, nhiệm vụ, nhật ký hoạt động), vì hộp thư và phần đăng bài đều phải chạy riêng được, không bên nào được sở hữu kho dữ liệu.
- Một kho hội thoại và tin nhắn, có phân **loại**: chuỗi bình luận, tin nhắn riêng hoặc email. Mỗi bình luận cấp một là một hội thoại.
- Liên hệ (người dùng nền tảng nối với `party`), giao việc, trạng thái **Mới, Đang chờ, Đã xử lý**, ghi chú nội bộ, câu trả lời mẫu, bản nháp do AI soạn (người bấm Gửi), trạng thái đã đọc.
- **Tránh hai người cùng trả lời:** giao việc là khóa mềm, có dấu "Linh đang trả lời" hết hạn sau 60 giây, và khi gửi hệ thống kiểm tra có tin mới hơn không (nếu có thì từ chối và hiện tin mới).
- **Công tắc rảnh/bận** của từng thành viên, dùng để biết báo cho ai, chưa tự chia việc xoay vòng.

## Bố cục: một ứng dụng, Ludy Engage (đã quyết)

- JOY chốt: **một ứng dụng trên thanh bên tên Ludy Engage** (mã ứng dụng `social`), gom CRM, hộp thư, đăng bài và quảng cáo. Mỗi nhóm chỉ hiện khi module của nó được bật; dữ liệu và công tắc module không đổi.
- Các nhóm trên thanh bên:
  - **Hộp thư:** mọi hội thoại (chat, bình luận, email) với Mới, Đang chờ, Đã xử lý.
  - **Khách hàng & Bán hàng:** **Người liên hệ**, **Công ty** (mã số thuế dùng chung với Kế toán; một người có thể thuộc một công ty), **Cơ hội** (bảng Kanban), **Lịch hẹn**.
  - **Marketing:** **Bài đăng** (Social), **Quảng cáo** (Ads).
  - **Báo cáo:** một nhóm, mỗi lĩnh vực một tab.
- Hootsuite cũng để Ads làm một nhóm bên trong Perch. Khung giao diện hiện tại đã dựng ứng dụng và nhóm từ khai báo của từng module; việc đổi tên, gom nhóm và chuyển hướng các địa chỉ /crm cũ là #2435, sau #2416. Màn hình hộp thư là CV3 (#2306).
- Tài liệu Ads đã nói "một nhóm bên trong ứng dụng Social": ứng dụng đó chính là ứng dụng này, nên các tài liệu khớp nhau.

## Bình luận trong hộp thư và các cầu nối

**Đã quyết (JOY, 2026-11-03): có, bình luận là một hội thoại như mọi hội thoại khác và hiện trong Hộp thư.** Người chăm sóc khách có một danh sách duy nhất cho mọi thứ khách đã viết, trên mọi kênh. Tab Bình luận ở trang bài đăng hiện cùng chuỗi đó: một kho, một bộ đếm chưa đọc, hai lối vào cùng một hội thoại. Ba cầu nối:
1. **Trả lời riêng:** từ một bình luận, gửi tin nhắn riêng cho người bình luận (Meta cho một tin trong 7 ngày). Hệ thống tạo một hội thoại tin nhắn riêng nối với chuỗi bình luận; cả hai nằm trong Hộp thư và trỏ qua lại.
2. **Việc cần làm tiếp là một nhiệm vụ:** từ bất kỳ hội thoại nào, "Tạo nhiệm vụ" tạo một nhiệm vụ (tiêu đề, người nhận, hạn) nối ngược về hội thoại. Hội thoại vẫn tự là Mới, Đang chờ hay Đã xử lý; nhiệm vụ là việc bình thường trong danh sách của tổ chức.
3. **Liên hệ chung:** mọi luồng nối với cùng một người, nên bảng liên hệ hiện bình luận, tin nhắn và email của người đó cho ai có quyền xem.
Doanh nghiệp có hộp thư nhưng chưa dùng phần đăng bài vẫn thấy bình luận của các Trang đã kết nối, chỉ không có trang bài đăng để mở từ đó.

## Email là một kênh hội thoại (thiết kế, chưa làm)

- Email của khách là hội thoại loại `email`, hiện như chuỗi chat trong Hộp thư và trả lời trong cùng ô. Đây là việc CV10, chưa mở issue.
- **Đến:** dùng lại bộ máy của đường nhận email hiện có (khóa bí mật chung, giới hạn kích thước, đọc MIME trong khu cách ly, tìm tổ chức từ địa chỉ đã lưu chứ không từ tiêu đề thư) nhưng với **một địa chỉ hội thoại riêng cho mỗi tổ chức**, tách khỏi địa chỉ nhận chứng từ, để thư của khách không bao giờ vào bộ đọc hóa đơn. Chuyển tiếp thư hay nối hộp thư thật (IMAP, Gmail, Microsoft 365) là câu hỏi đầu của issue build [U].
- **Gom luồng** theo Message-ID, In-Reply-To và References. Không gộp luồng chỉ vì trùng tiêu đề ở v1, vì gộp nhầm là cho khách này thấy thư của khách kia [U].
- **Hiển thị:** phần mới ở trên, phần trích dẫn và chữ ký gập lại sau "hiện phần trích dẫn"; nội dung lưu đầy đủ, việc cắt chỉ là cách hiển thị. Không bao giờ hiển thị HTML.
- **Tệp đính kèm:** ảnh đi qua kho ảnh của hội thoại (có giới hạn kích thước, đọc loại từ nội dung); loại khác chỉ hiện tên, kích thước và loại ở v1 [U].
- **Đi:** qua đường gửi thư của kernel (ghi trước khi gọi, kiểm tra danh sách chặn, một thư gửi đúng một lần), có In-Reply-To và References để hộp thư của khách gom đúng luồng. Người bấm Gửi; tác nhân không bao giờ gửi. Thư tự động hoặc hàng loạt không mở hội thoại và không được trả lời.
- Địa chỉ người gửi là dữ liệu cá nhân (`pii`); email cũng được xem, trả lời và xóa bởi cùng những người như tin nhắn riêng, vì thư gửi doanh nghiệp là riêng tư.

## Bình luận và tin nhắn đến và đi như thế nào

- **Đến:** nền tảng gọi một địa chỉ webhook công khai; hệ thống kiểm tra chữ ký rồi chỉ xếp vào hàng đợi; một tác vụ nền tìm đúng kết nối (từ mã trang của nền tảng, không từ nội dung thông báo) rồi lưu. **Lưu luôn nội dung trong webhook** vì Meta không có API xem lại lịch sử (thử lại 36 giờ, chỉ đọc lại được 20 tin gần nhất), Zalo không thử lại khi lỗi. Có tác vụ đối chiếu định kỳ làm lưới an toàn.
- **Đi:** cùng đường đi "đúng một lần" như đăng bài: ghi trước khi gọi, không bao giờ gửi lại mù quáng, kết quả không rõ thì đối chiếu bằng sự kiện "tin của chính Trang" hoặc đọc lại cuộc trò chuyện. Hệ thống kiểm tra cửa sổ trả lời của nền tảng trước khi gửi (Meta 24 giờ, 7 ngày với thẻ nhân viên thật; Zalo 48 giờ theo nguồn thứ cấp).
- **Facebook Page:** bình luận qua webhook `feed`, tin nhắn qua `messages`; trả lời bình luận, ẩn bình luận, trả lời riêng đều có tài liệu chính thức. Mọi quyền liên quan cần App Review nếu phục vụ Trang của người khác. Kết nối Facebook hiện có phải kết nối lại để cấp thêm quyền (một lựa chọn bật thêm trên màn hình kết nối).
- **Zalo OA:** chỉ tin nhắn riêng. **Không thấy API bình luận nào** (chưa phải bằng chứng là không có). Trang tài liệu nhà phát triển của Zalo không đọc được nên gần như mọi chi tiết Zalo là nguồn thứ cấp và được ghi rõ [S] hoặc [U]; buổi chạy thử thật sẽ xác nhận. Gửi tin qua API cần OA đăng ký gói trả phí có tích hợp API (Growth trở lên theo trang giá của Zalo).
- Các điểm chưa chắc, như Meta xử lý Page Inbox thế nào khi Ludy cũng đọc Trang, và webhook `feed` có chạy ở chế độ phát triển không, được liệt kê [U] trong kế hoạch.

## Ai được xem gì

- **Bình luận** xem được như bài đăng chứa nó: chủ, quản trị, thành viên và người xem có quyền với kênh đó.
- **Tin nhắn riêng và email** chỉ chủ, quản trị và người giữ vai trò `desk.agent`. Người xem không bao giờ xem được. Quy tắc này được cơ sở dữ liệu ép, không chỉ ẩn trên màn hình.
- Giới hạn "thành viên này chỉ thấy một số kênh" hiện nằm trong Social nên **chuyển vào kernel** để lõi áp dụng được.
- AI chỉ soạn bản nháp, gợi ý ý định và gợi ý liên hệ; **luôn là người bấm Gửi và người xác nhận**, tác nhân không bao giờ gửi, ẩn, đóng hay nối liên hệ.

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
| CV3 | Ứng dụng Ludy Engage và hộp thư Hộp thư ba khung trên kênh giả, cho mọi loại hội thoại: Mới, Đang chờ, Đã xử lý, giao việc, dấu "đang trả lời", bảng liên hệ, ghi chú, câu mẫu, "Tạo nhiệm vụ"; hộp bình luận của CV1 gộp vào đây |
| CV4 | Tin nhắn Messenger thật và "trả lời riêng" từ bình luận, hiện trong Hộp thư |
| CV5 | Tin nhắn Zalo OA thật trong cửa sổ miễn phí, hiện trong Hộp thư |
| CV6 | Thời gian giữ, xóa dữ liệu một người, gọi lại xóa dữ liệu của Meta |
| CV7 | Bình luận và tin nhắn Instagram trong Hộp thư |
| CV8 | Bản nháp AI và câu mẫu (đã làm) |
| CV9 | Bỏ (quyết định 2026-11-03, #2311): việc tiếp theo là một nhiệm vụ nối với hội thoại, làm cùng CV3 |
| CV10 | Email của khách là một kênh hội thoại (chưa mở issue) |
| CV11 | Phân loại ý định và gợi ý liên hệ của đồng nghiệp AI (chưa mở issue) |

Việc của JOY khi bắt đầu build (không agent nào tự làm): thêm quyền Trang vào ứng dụng Meta (hoặc tạo ứng dụng Messenger riêng nếu Meta bắt buộc), trỏ webhook về địa chỉ triển khai, OA Zalo dùng gói có API, đặt địa chỉ gọi lại và khóa bí mật OA; về sau với Ludy Cloud là App Review và Business Verification, và nhờ luật sư đọc điều khoản Meta về tin nhắn khách lưu trữ.

## Câu hỏi cho JOY

Mỗi câu có phương án, đề xuất và hệ quả nếu không trả lời. Chi tiết trong [mục 16 của conversations.md](conversations.md#16-questions-for-joy).

1. **Bố cục: một ứng dụng với nhiều nhóm hay các mục riêng trên thanh bên? (Đã trả lời 2026-11-01: một ứng dụng; các nhóm như phần Bố cục ở trên.)** Đề xuất: **một ứng dụng với nhiều nhóm** (khung giao diện đã làm sẵn kiểu này, thanh bên ngắn, Hootsuite cũng đặt Ads làm nhóm). Không trả lời: làm như đề xuất, tên tạm "Kênh".
2. **Bình luận có hiện luôn trong hộp thư không? (Đã trả lời khác đề xuất, 2026-11-03: có, hiện trong Hộp thư, tab ở trang bài là lối vào thứ hai; phần dưới là bản ghi câu hỏi như đã hỏi.)** Đề xuất lúc đó: **không**, chỉ ở Social, có cầu nối "trả lời riêng" và "chuyển sang Service". Khác: hiện bình luận trong Service khi Social tắt; hoặc luôn hiện ở cả hai (hai bộ đếm chưa đọc). Không trả lời: như đề xuất.
3. **Ứng dụng tên gì? (Đã trả lời 2026-11-02: Ludy Engage.)** (JOY cùng nhóm Frontend.) Đề xuất: **Kênh**; hoặc Ludy Channels. Chỉ là nhãn nên đổi sau được. Không trả lời: "Kênh" làm tên tạm.
4. **Thành viên trả lời bình luận công khai có cần duyệt không?** Đề xuất: **không duyệt ở v1**, nhưng bản nháp AI luôn cần người bấm Gửi. Khác: cần chủ hoặc quản trị duyệt như bài đăng (an toàn hơn cho agency, chậm với công ty một người). Không trả lời: không duyệt.
5. **Giữ bình luận và tin nhắn bao lâu?** (JOY, luật sư về mặt pháp lý.) Đề xuất: **24 tháng sau tin cuối**, chủ chọn 6, 12, 24 tháng hoặc giữ đến khi xóa. Khác: 12 tháng; hoặc giữ mãi. Không trả lời: 24 tháng, và luật sư đọc điều khoản Meta trước khi chạy Ludy Cloud.
6. **Zalo OA gửi tin cần gói OA trả phí có API của khách. Chấp nhận không?** Đề xuất: **chấp nhận**, báo rõ "gói OA của bạn chưa có tích hợp API" và ghi tên gói vào tài liệu. Khác: hoãn Zalo đến khi giá xác nhận trên trang chính thức đọc được. Không trả lời: như đề xuất, buổi chạy thử thật xác nhận tên gói và hạn mức.
7. **Thứ tự build?** Đề xuất: **lõi và bình luận trên kênh giả, bình luận Facebook Page, ứng dụng Ludy Engage và Hộp thư trên kênh giả, Messenger, Zalo, rồi thời gian giữ dữ liệu**. Khác: Zalo trước Messenger (nhưng cần hộp thư trước nên kết quả nhìn thấy đầu tiên đến muộn hơn). Ở mọi thứ tự, **kênh thật chưa xử lý tin nhắn của khách thật trước khi xong thời gian giữ, xóa dữ liệu, xuất và dọn dữ liệu (CV6)**: trước đó chỉ chạy trên Trang và OA của chính JOY. Không trả lời: như đề xuất.
