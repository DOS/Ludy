# Bộ não của Vy là một agent DOS Claw, Ludy là người gác cổng: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [ADR-0051](0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md), ngày 2026-11-10. Bản tiếng Anh là bản chính. Trạng thái: **đã chấp nhận hướng đi** ngày 2026-11-10, theo quyết định của JOY trong cuộc trò chuyện với Platform PO (anh chọn "Đồng ý"). Phần cách làm cụ thể sẽ được Platform PO duyệt cùng với từng bản làm ra nó.

## Anh đã quyết gì

**Bộ não của Vy (phần suy nghĩ, ghi nhớ lâu dài, trò chuyện qua Telegram hoặc Zalo, giao việc cho Ly, Dy, Uy) là một agent DOS Claw chạy trên work.dos.ai. Ludy không tự làm bộ não đó.**

Nói đơn giản: DOS đã có sẵn "người làm việc" (agent). Ludy không làm thêm một người thứ hai. Ludy giữ phần mà chỉ Ludy giữ được: **dữ liệu của công ty, ranh giới quyền, và việc duyệt tiền, tin nhắn, chi tiêu.** Ludy là **người gác cổng và là nơi giữ sự thật**.

(Giải thích vài từ: *agent* là phần mềm AI tự làm việc theo mục tiêu. *DOS Claw* là loại agent của DOS, mỗi agent chạy trong một hộp riêng. *work.dos.ai* là nơi DOS xếp các agent vào sơ đồ tổ chức, giao việc và đánh thức chúng. *MCP* là một cách chuẩn để một agent gọi các chức năng của phần mềm khác.)

## Cách đóng gói trên Ludy Cloud (anh quyết cùng ngày)

JOY nói: "Tao nghĩ bản cloud cứ có mặc định Vy đi. Rồi ai cần thì mua thêm Ly, Uy, Hy gì đó thôi. Là 1 addon, ai ko cần AI thì khỏi xài".

Nghĩa là:
- **Ludy Cloud tặng sẵn một agent Vy** (một agent DOS Claw) cho mọi tổ chức.
- Các đồng nghiệp AI khác (Ly, Dy, Uy, sau này có thể thêm Hy) là **tiện ích mua thêm, tính theo từng tổ chức**. Mỗi tiện ích là một agent DOS Claw riêng, đứng dưới Vy trên sơ đồ của work.dos.ai.
- Tổ chức nào không cần AI thì không dùng, và **phần còn lại của Ludy chạy đầy đủ mà không cần agent nào**.
- Bản Ludy tự cài không đổi: cảnh báo theo luật trên trang chủ, và nối được với bất kỳ agent MCP nào.

Lý do về chi phí: agent DOS Claw tính tiền theo từng agent mỗi tháng, cộng với lượng AI dùng, nên mặc định chỉ một agent. Agent chỉ được đánh thức bởi các luật cố định của Ludy và các lịch tổ chức tự đặt, nên ngày yên ắng gần như không tốn gì. Cách đóng gói và giá là quyết định của DOS.AI và Ludy Cloud, không phải mã Ludy: mã nguồn mở không chứa giá hay phần kiểm tra gói, chỉ có giấy phép (một tiện ích là thêm một agent được ghép với giấy phép riêng).

## Ludy làm đúng ba việc

1. **Một cổng MCP trong máy chủ Ludy.** Agent gọi các chức năng mà app vẫn dùng, qua đúng đường ghi duy nhất của Ludy, kèm một "giấy phép" gắn với tổ chức, loại ứng dụng khách và agent. Giấy phép có thể gắn với **một người**: khi đó agent chỉ thấy đúng những gì người đó được xem, giống quy tắc anh đã đặt cho Vy riêng từng người (ADR-0049). Việc duyệt vẫn là của **người trong Ludy**. Một lần "duyệt" ở Paperclip hay DOS Claw **không bao giờ** được tính là duyệt trong Ludy. Thu hồi giấy phép, tạm dừng agent hoặc bật công tắc dừng là agent mất quyền ngay.
2. **Các luật cảnh báo cố định, không dùng AI** (V4, V5: deal đã thắng mà chưa có hóa đơn, công nợ quá hạn mà còn deal mở, nhà cung cấp đổi tài khoản ngân hàng khi còn khoản thanh toán chờ). Luật chạy trong Ludy, hiện trên trang chủ, và cũng là lý do để đánh thức agent.
3. **Một tín hiệu gửi ra có chữ ký.** Khi có cảnh báo, hoặc đến giờ một lịch tổ chức đã đặt, Ludy gửi một tin ngắn tới work.dos.ai để đánh thức agent. Tin chỉ có mã số, loại sự kiện, ngày và số tiền, **không có chữ nào của khách hay ghi chú**. Tin có chữ ký (HMAC), có dấu thời gian và mã sự kiện, nên gửi lại tin cũ sẽ bị từ chối. Ludy chỉ **báo tin**; agent tự quyết làm gì, rồi đọc chi tiết qua cổng ở mục 1.

## Ludy không làm gì nữa

- Không có vòng lặp agent riêng, không có trí nhớ trò chuyện, không có bộ lập lịch agent trong Ludy.
- Không làm "Hỏi Vy" và Vy tự chủ động bằng bộ công cụ AI riêng trong Ludy. Kế hoạch cũ đã bỏ phần này.
- Mẫu "tổng quản" trong Ludy cũng bỏ: Vy, Ly, Dy, Uy là agent DOS Claw trên sơ đồ của work.dos.ai.

Những gì đã làm xong vẫn giữ nguyên: tóm tắt cuộc họp, chép lời cuộc họp, danh sách việc cần bạn và cảnh báo trên trang chủ.

## Điều cần nói thẳng

Ludy vẫn chạy được một mình bằng `docker compose up`, không bị khóa vào một bên thứ ba. Nhưng hệ quả là: **bản Ludy tự cài, không có DOS, giữ các cảnh báo theo luật trên trang chủ và tóm tắt cuộc họp, nhưng không có Vy biết suy luận.** Agent của hãng khác (OpenAI, Anthropic, Google, OpenClaw) vẫn nối được bằng đúng cổng và đúng tín hiệu đó, vì cổng và tín hiệu không gắn riêng với DOS. "Cấu hình sẵn cho DOS" chỉ là giá trị mặc định tùy chọn, **tắt sẵn**.

## Đã cân nhắc và loại

- Tự xây vòng lặp agent trong Ludy: loại, vì DOS đã có và làm thêm sẽ nhân đôi chỗ phải giữ kín dữ liệu của từng người.
- Dùng khung agent khác (Mastra, LangGraph) trong Ludy: loại vì cùng lý do.
- Làm riêng cho từng hãng AI: loại, một cổng chung là đủ.
- Cho việc duyệt ở nơi khác tính là duyệt trong Ludy: loại, vì tiền và tin nhắn phải do người duyệt trong Ludy.

## Việc còn mở, thuộc phía DOS (không phải của Ludy)

- **Bộ nối Ludy trong DOS Claw** (như bộ nối Crove CRM họ đã có).
- **work.dos.ai giai đoạn 3:** đặt các agent DOS Claw lên sơ đồ tổ chức và nhận tín hiệu có chữ ký.
- **Một agent Vy phục vụ nhiều người trong cùng một công ty mà không lộ dữ liệu của người này cho người kia.** Ludy lo phần của mình (giấy phép theo từng người chỉ thấy đúng người đó); phía DOS phải giữ trí nhớ của agent tách riêng từng người. Cho đến khi chứng minh được điều đó, agent dùng chung cho cả công ty chỉ làm việc ở chế độ công ty (không đụng dữ liệu riêng).

## Hệ quả cho kế hoạch

- Kế hoạch Vy ([vy.md](../plan/vy.md), [vy.vi.md](../plan/vy.vi.md)) được viết lại: giai đoạn 2 là cổng MCP và tín hiệu gửi ra, giai đoạn 3 chạy trên work.dos.ai. Hai câu hỏi cũ Q7 (DOS Claw là gì, ghép nối thế nào) và Q8 (cấu hình DOS nằm ở đâu) đã được quyết định này trả lời.
- ADR "tìm kiếm trên văn bản" mà kế hoạch cũ gọi là ADR-0051 nay đánh số **ADR-0052** (đề xuất), chỉ cần nếu Ludy tự lập chỉ mục văn bản. Câu hỏi Q3 (chưa lập chỉ mục trên ghi chú riêng và cuộc họp) vẫn giữ.
- Thứ tự làm: ghép nối và giấy phép, cổng MCP (đọc trước, lệnh sau, việc duyệt giữ nguyên), giấy phép theo từng người, rồi tín hiệu có chữ ký. Phần giấy phép và cổng chạm vào vùng được bảo vệ nên Platform PO duyệt bảo mật.

## Khi nào xem lại

- DOS không giao bộ nối hoặc giai đoạn 3 trong thời gian chạy thử: "Hỏi Vy" trong Ludy được đưa lại cho anh quyết, không tự làm.
- Một ứng dụng khách cần chức năng chưa có: thêm thành lệnh có mức rủi ro rõ ràng trước, không tạo ngoại lệ trong cổng.
- Agent cần giữ văn bản từ Ludy (tìm kiếm trên ghi chú, cuộc họp): làm ADR-0052 và hỏi lại Q3 trước.
