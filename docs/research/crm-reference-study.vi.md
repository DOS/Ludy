# Nghiên cứu CRM: tóm tắt cho chủ sở hữu

Trạng thái: xong phần nghiên cứu, ngày 2026-10-31; bổ sung phần 3 CRM AI ngày 2026-11-02. Đây là nghiên cứu (không có mã, chưa cam kết lộ trình). Bản đầy đủ bằng tiếng Anh: [crm-reference-study.md](crm-reference-study.md). Issue: [#2122](https://github.com/DOS/Ludy/issues/2122).

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

## 3 CRM AI dưới góc nhìn cộng đồng và chuyên gia

Bổ sung ngày 2026-11-02 (issue [#2343](https://github.com/DOS/Ludy/issues/2343)), chi tiết ở mục 4.7 của bản tiếng Anh. Giá đổi theo tỷ giá 25.800 VND mỗi USD (tỷ giá thị trường ngày 2026-11-01, chưa gồm phí thẻ và thuế).

- **Đánh giá của cộng đồng còn rất ít.** Hầu hết bài "review" do đối thủ hoặc nhà đầu tư viết, nên cần đọc có nghi ngờ. Clarify được 4,9 sao trên G2 (21 đánh giá, theo blog của chính hãng) và trên Product Hunt (10 đánh giá). Lightfield và Day AI chưa có điểm đáng tin. Chưa tìm được cuộc thảo luận thật nào trên Reddit hay Hacker News về cả ba.
- **Được khen:** tự điền dữ liệu từ email, lịch và cuộc họp, cài đặt nhanh (Day AI và Lightfield nói khoảng 7 đến 10 phút), Clarify không tính theo số người dùng.
- **Bị chê:** Clarify bị chê nhiều nhất là hóa đơn tính theo "tín dụng" (credit) khó đoán trước. Lightfield bị chê giá và cách tính tín dụng không rõ, thỉnh thoảng tạo nhầm bản ghi. Day AI bị chê yếu phần pipeline và dự báo.
- **Chuyên gia và nhà đầu tư:** khen ý tưởng "CRM tự làm" và đội sáng lập, nhưng cũng nêu nghi ngờ: số liệu tăng trưởng do hãng tự công bố, khách hàng chủ yếu là công ty khởi nghiệp nhỏ, CRM cũ (HubSpot, Salesforce) cũng đang thêm AI.
- **Tiền và sức mạnh:** Lightfield vừa huy động 47 triệu USD (vòng A, a16z dẫn đầu, 2026-09), khoảng 40 người. Day AI gọi vốn 20 triệu USD (vòng A, Sequoia dẫn đầu, 2026-02), đội rất nhỏ. Clarify gọi 15 triệu USD (vòng A, 2025-06) và mua Seam AI (2026-07), khoảng 25 đến 35 người. Cả ba ra bản mới đều đặn khoảng mỗi tuần một lần.
- **Giá cho nhóm 3 người, mỗi tháng:**
  - Chỉ ghi chép, tóm tắt, không chạy việc ngầm: Clarify khoảng 1,29 triệu VND (Starter 50 USD); Day AI khoảng 2,8 đến 3,5 triệu VND; Lightfield khoảng 6,9 triệu VND (Starter, không có tự động hóa).
  - **Có agent chạy việc ngầm:** Clarify cần gói Growth từ 1.000 USD, khoảng 25,8 triệu VND, trả theo năm; Lightfield cần gói Pro 999 USD, khoảng 25,8 triệu VND, trả theo năm; Day AI chỉ khoảng 1,9 đến 2,3 triệu VND (3 gói Turbo, mỗi gói 2 "kỹ năng" chạy ngầm). Giá Day AI chưa chắc là giá tháng hay giá năm, cần xác nhận khi dùng thử.
  - Giá Lightfield đã đổi 5 lần từ cuối tháng 7 (theo một đối thủ). Clarify bỏ bảng giá tín dụng khỏi trang giá hồi tháng 9.
- **Tiếng Việt và Zalo:** cả ba chưa có Zalo, giao diện chỉ tiếng Anh, chưa hãng nào nói rõ có hỗ trợ phiên âm tiếng Việt. Khoảng trống này vẫn để ngỏ cho Ludy.
- **Ý kiến riêng của tôi cho 2 đến 3 năm tới:** việc "tự thu thập và tóm tắt" sẽ ai cũng có, nên lợi thế sẽ nằm ở dữ liệu do khách tự giữ, độ tin cậy và kênh địa phương như Zalo. Ba hãng này có thể bị mua lại hoặc phải đổi cách tính giá.
- **Điều đổi trong đề xuất:** (1) đồng hồ đo chi phí và nút dừng cứng phải ra cùng agent đầu tiên có dùng mô hình ngôn ngữ; (2) thêm quy tắc "sửa tay của người luôn thắng suy đoán AI về sau". Các quyết định ở dưới không đổi.

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
