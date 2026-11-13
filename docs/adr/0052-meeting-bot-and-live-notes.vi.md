# Bot họp và ghi chú trực tiếp (L4): tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [ADR-0052](https://github.com/DOS/Ludy/blob/main/docs/adr/0052-meeting-bot-and-live-notes.md), ngày 2026-11-13. Bản tiếng Anh là bản chính. Trạng thái: **đề xuất, chưa quyết, chưa làm gì**. Cần anh trả lời tám câu ở cuối. Việc này là issue [#2592](https://github.com/DOS/Ludy/issues/2592) (L4), đang nằm ở Icebox (kho tạm, chưa làm).

## Vấn đề

Hiện nay Ludy ghi cuộc họp trực tuyến bằng tiện ích Chrome hoặc Edge (ghi âm thanh của tab), bằng micro trong app, hoặc bằng tải file lên. Anh đã chọn cách này thay vì bot vì bot làm phiền người khác. L4 hỏi: có nên làm một **bot tự vào cuộc họp Meet, Zoom hoặc Teams**, và **ghi chú ngay trong lúc họp** không?

Bot chỉ thêm được ba thứ mà tiện ích chưa có: (1) ghi được cuộc họp trong **app Zoom và app Teams trên máy tính** (hiện phải tải file lên); (2) ghi cuộc họp khi người ghi không ngồi trước máy; (3) **ghi chú trực tiếp** (hiện bản chép lời đến sau cuộc họp vài phút).

## Điều đã tra được (ngày 2026-11-13)

Lưu ý: phiên làm việc này bị chặn không mở được trang của Google và Microsoft, nên số liệu lấy từ kết quả tìm kiếm có trích trang gốc, kèm một số bài trên diễn đàn (không chính thức). **Mọi điểm đánh dấu chưa kiểm chứng phải đọc lại trên trang nhà cung cấp trước khi làm.**

- **Google Meet: không còn đường chính thức để lấy âm thanh trực tiếp.** Google đã báo ngừng Meet Media API (cách duy nhất), tắt hẳn ngày **2027-01-15**. Còn lại: lấy bản chép lời **sau cuộc họp** qua Meet REST API, nhưng chỉ khi chủ cuộc họp dùng gói Workspace trả phí và có người bật chép lời. Muốn bot vào Meet chỉ còn cách không chính thức (trình duyệt tự vào bằng link), không có hợp đồng nào đảm bảo.
- **Zoom: có đường chính thức, tên là RTMS** (luồng âm thanh theo thời gian thực cho app của bên thứ ba). Cần tạo app Zoom, mua "credit" dành cho nhà phát triển, và Zoom duyệt app nếu cho người ngoài tài khoản mình dùng. Giá chưa rõ (diễn đàn nói khoảng 0,01 USD một phút, các bài nói khác nhau, chỉ gói trả phí). Zoom nói có thông báo trong cuộc họp khi một app đang đọc dữ liệu.
- **Microsoft Teams: có đường chính thức nhưng nặng nhất.** Bot phải chạy trên máy Windows trên Azure, và **quản trị viên của từng công ty khách** phải đồng ý. Công ty nhỏ hiếm có người làm việc đó.
- **Cách không cần ai duyệt:** dùng dịch vụ bot của bên thứ ba (một nhà cung cấp tính 0,50 USD một giờ ghi, cộng 0,15 USD một giờ chép lời): tiện nhưng âm thanh đi qua công ty đó, có thể ra nước ngoài; hoặc tự viết bot bằng trình duyệt: dễ hỏng, chưa đọc điều khoản.

## Đề xuất

1. **Tách L4 làm hai.** **L4a: ghi chú trực tiếp, không cần bot**, chạy trên âm thanh mà tiện ích hoặc app đã ghi sẵn (cứ khoảng 15 giây gửi lên một đoạn). Không cần tài khoản hay duyệt của hãng nào, dùng được cho Meet, và Teams, Zoom mở trong trình duyệt. **L4b: bot Zoom qua RTMS**, chỉ làm khi có khách thí điểm đòi. Bot Meet và bot Teams: không lên kế hoạch.
2. **Ghi chú trực tiếp** bật riêng cho từng cuộc họp (mặc định tắt), chỉ người ghi thấy. Vy (người đồng nghiệp AI của người ghi trong app Notes) chép lời từng đoạn và cứ 5 phút cập nhật ghi chú nháp: tóm tắt tới giờ, quyết định, việc cần làm (mỗi mục là "Đề xuất", không có việc nào được tạo nếu người ghi không bấm). Bản chép lời trực tiếp chỉ là **bản nháp**, sẽ được thay bằng bản chép lời đầy đủ sau cuộc họp.
3. **Độ trễ mục tiêu** (sẽ đo, chưa hứa): dòng chữ hiện sau lời nói khoảng 30 giây; ghi chú làm mới trong khoảng một phút sau mỗi 5 phút.
4. **Chi phí AI:** mỗi đoạn được kiểm với ngân sách AI **trước khi gọi** (cơ chế vừa làm ở PR #3067). Hết ngân sách hoặc bấm "Dừng AI" thì ghi chú dừng, ghi âm vẫn tiếp tục. Vì chép lời hai lần (nháp trực tiếp rồi bản đầy đủ), một cuộc họp trực tiếp tốn **tới gấp đôi** số phút âm thanh.
5. **Báo cho người trong cuộc họp (đồng ý trong cuộc gọi):** bước xác nhận hiện có của Ludy giữ nguyên. Với bot Zoom thêm: chưa lưu âm thanh nào trước khi thông báo đã hiện trong cuộc gọi bằng cách Zoom cho phép (nếu không xác nhận được cách nào thì không làm); người ghi bấm một nút là dừng và xóa; chủ cuộc họp có thể đuổi app bằng công cụ của Zoom. Thông báo như vậy đã đủ theo luật bảo vệ dữ liệu cá nhân chưa là câu hỏi cho luật sư.
6. **Âm thanh đi đâu:** vẫn mã hóa ngay bằng khóa riêng của từng cuộc họp, giữ 30 ngày rồi xóa khóa (như ADR-0047). Bot Zoom đọc luồng trong một container riêng, chỉ gửi đoạn âm thanh vào Ludy qua một lệnh duy nhất, và chỉ khi người ghi đã bấm cho phép cuộc họp đó.

## Tám câu cần anh trả lời

Trả lời từng câu một. Mỗi câu có đề xuất của tôi trước.

1. **Làm ghi chú trực tiếp không cần bot (L4a) tiếp theo không?** Đề xuất: **có.** Lý do: không cần hãng nào duyệt, không tốn tiền cho hãng, dùng được cho cả Meet. Nếu không trả lời: L4 vẫn nằm ở Icebox.
2. **Bot Zoom (L4b): làm ngay hay chờ khách thí điểm đòi?** Đề xuất: **chờ khách đòi**; nếu làm thì Zoom trước, vì là đường chính thức duy nhất và lấp được chỗ trống của app Zoom trên máy tính.
3. **Bot Meet và bot Teams: xác nhận "không lên kế hoạch"?** Đề xuất: **có.** Meet sắp hết đường chính thức, Teams quá nặng với công ty nhỏ.
4. **Có dùng dịch vụ bot của bên thứ ba (tùy chọn cho Ludy Cloud) không?** Đề xuất: **chưa.** Âm thanh đi qua công ty khác (có thể ra nước ngoài) và Ludy phải phụ thuộc một khoản phí.
5. **Chấp nhận ghi chú trực tiếp tốn tới gấp đôi phút âm thanh, mặc định tắt, bật riêng từng cuộc họp?** Đề xuất: **có.** Nếu không trả lời: không làm L4a.
6. **Ai được cho bot vào họp: chỉ người ghi, từng cuộc một, không tự vào theo lịch?** Đề xuất: **đúng như vậy.**
7. **Chi tiêu và tài khoản Zoom cho Ludy Cloud (chỉ khi câu 2 là làm):** ai mở tài khoản nhà phát triển Zoom, đăng ký app, qua vòng duyệt, và trả credit. Việc này là của anh (tiền mới). Đề xuất: chờ câu 2.
8. **Hỏi luật sư (#62)** xem thông báo hiện trong cuộc gọi có đủ cho bot không, hay từng người phải đồng ý. Đề xuất: **có**, thêm vào danh sách câu hỏi cho luật sư (mục 7 của kế hoạch) trước khi làm bot.

**Ai làm gì tiếp:** anh trả lời; Meetings PO mở issue L4a nếu anh đồng ý câu 1, 5 và 6; luật sư nhận câu 8; Platform PO duyệt bảo mật nếu sau này làm bot.
