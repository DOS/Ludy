# Nghiên cứu CRM: tóm tắt cho chủ sở hữu

Trạng thái: xong phần nghiên cứu, ngày 2026-10-31. Đây là nghiên cứu (không có mã, chưa cam kết lộ trình). Bản đầy đủ bằng tiếng Anh: [crm-reference-study.md](crm-reference-study.md). Issue: [#2122](https://github.com/DOS/Ludy/issues/2122).

## Đã so sánh những gì

- CRM toàn cầu: HubSpot, Twenty, Attio, Pipedrive.
- CRM dùng ở Việt Nam: Getfly, Bitrix24, Base CRM, MISA AMIS CRM.
- CRM "AI từ gốc": Clarify (bạn chọn), Lightfield, Day AI và phần AI của Attio.
- Mọi dữ kiện đều có nguồn công khai và ngày kiểm tra (2026-10-31). Chỗ nào chưa xác minh được thì ghi "UNVERIFIED" (chưa xác minh) trong bản đầy đủ.

## Điều rút ra, nói ngắn gọn

1. **CRM AI đều tự thu thập trước, hỏi sau.** Họ tự tạo người liên hệ và công ty từ email và lịch. Nhưng khi gửi email hoặc đổi dữ liệu theo gợi ý, các hãng có tài liệu rõ (Lightfield, Attio, Day AI) vẫn để người bấm đồng ý. Phần Clarify tự duyệt chưa được tài liệu của chính hãng xác nhận.
2. **Quy tắc thu thập là phần quan trọng nhất.** Lightfield và Attio mặc định chỉ thu thập người mà nhóm đã thật sự trao đổi, bỏ thư tự động và thư quảng cáo, và có nút tắt. Ludy nên theo cách này để danh bạ không đầy rác.
3. **"Hoàn tác" (undo) là điểm yếu chung.** Chưa hãng AI nào mô tả nút hoàn tác tổng quát. Kế hoạch của Ludy có hoàn tác 24 giờ cho việc agent ghi, nhưng chưa xây. Nếu xây, đây là điểm hơn hẳn.
4. **Luật an toàn của Ludy chặt hơn tất cả họ.** Mọi thứ lấy từ email hoặc tin nhắn bên ngoài là dữ liệu "nhiễm" (tainted, chưa đáng tin). Ghi từ dữ liệu đó luôn là đề xuất để người duyệt. Vì vậy việc "tự tạo liên hệ từ email" không thể tự duyệt. Cách đuổi kịp tốc độ của họ là làm cho việc duyệt rẻ: duyệt cả nhóm một lần, không nới luật.
5. **Agent chạy ngầm được tự động ngay hôm nay** chỉ gồm: đọc, tóm tắt, nhắc việc (ví dụ nhắc deal bị bỏ quên) và đề xuất giờ hẹn mới, từ dữ liệu của chính tổ chức. Việc đã có: agent `crm.scheduler` đề xuất giờ trống khi khách hủy lịch.
6. **Ở Việt Nam, CRM luôn đi kèm Zalo, tổng đài điện thoại và liên kết hóa đơn.** Cả bốn CRM Việt Nam đều bán Zalo và tổng đài như gói cộng thêm hoặc gói cao. MISA gắn CRM vào kế toán và hóa đơn điện tử của họ. Ludy đã có kết nối Zalo OA (để đăng bài) và lõi kế toán, nên còn thiếu hộp thư tin nhắn và nhật ký cuộc gọi.
7. **Tự lưu trữ (self-host):** trong các CRM toàn cầu chỉ Twenty làm được, và giấy phép của họ pha lẫn mã miễn phí và mã trả phí. Ludy là AGPL toàn bộ và chạy bằng `docker compose up`, không giới hạn người dùng hay số bản ghi. Gói miễn phí của HubSpot giới hạn 2 người dùng và 1.000 liên hệ.

## Điều Ludy đã có và còn thiếu

- Đã có: danh bạ `party`, dòng thời gian `activity`, một đường ghi duy nhất, đề xuất và phê duyệt, lịch C1-C8 (kể cả đồng bộ Google vừa xong), ghi chú, kênh Social (Facebook, Instagram, Zalo OA).
- Còn thiếu so với kế hoạch CRM: deal và pipeline, bộ lọc đã lưu dùng chung, trường tùy chỉnh, nhập CSV hoặc Excel cho danh bạ, dòng thời gian có email và tin nhắn, tìm kiếm không dấu, và các mảnh cho agent chạy ngầm (quy tắc thu thập, duyệt hàng loạt, hoàn tác 24 giờ, xem việc agent đã làm).

## 4 quyết định cần bạn chọn

Mỗi mục: đề xuất của tôi đứng đầu. Nếu bạn không trả lời thì chưa có việc nào bắt đầu.

1. **Khi khách đầu tiên đòi CRM, làm phần nào trước?** Đề xuất: deal với một pipeline dạng bảng kéo thả, bộ lọc đã lưu đơn giản, nhập CSV hoặc Excel có kiểm tra trùng. Bỏ qua đối tượng tùy chỉnh và nhiều pipeline cho đến khi có người hỏi.
2. **Agent chạy ngầm được nhanh đến đâu?** Đề xuất: giữ luật hiện nay (mọi thứ lấy từ nội dung bên ngoài đều là đề xuất để người duyệt), và xây duyệt hàng loạt cùng quy tắc thu thập chọn lọc cho nhanh. Chưa thêm ngoại lệ tự duyệt nào trước khi pilot cho thấy duyệt hàng loạt vẫn chậm. Thêm ngoại lệ là đổi một luật bất biến, nên cần bạn quyết.
3. **"Tự thu thập khách hàng từ email và lịch" có là tính năng AI chủ lực của CRM không?** Đề xuất: có, sau khi đã có deal, mặc định ở mức "chọn lọc", bỏ thư tự động và thư quảng cáo, có nút tắt rõ ràng. Cả bốn CRM AI đều lấy đây làm điểm mạnh nhất. Không trả lời thì CRM AI chỉ dừng ở tóm tắt và soạn nháp.
4. **Kênh Việt Nam nào làm trước?** Đề xuất: tin nhắn Zalo OA hiện trên dòng thời gian khách, rồi bấm gọi điện kèm ghi chú cuộc gọi, rồi liên kết yêu cầu xuất hóa đơn với kế toán. Zalo cá nhân chỉ làm sau khi bạn hoặc luật sư kiểm tra điều khoản của Zalo. Không trả lời thì giữ thứ tự hiện có trong kế hoạch.

## Chưa xác minh được

Giá Zalo OA hiện hành, điều khoản Zalo cho tài khoản cá nhân, giá VND của Base CRM và Bitrix24, cách Getfly và Bitrix24 nối hóa đơn điện tử, cơ chế hoàn tác của các CRM AI. Danh sách đầy đủ ở cuối bản tiếng Anh.
