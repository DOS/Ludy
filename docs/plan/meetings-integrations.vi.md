# Kế hoạch tích hợp cho Ludy Meetings: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [meetings-integrations.md](meetings-integrations.md) (ngày 2026-11-14), dựa trên quyết định của JOY cùng ngày: duyệt cả bốn nhóm (A đến D) mà báo cáo nghiên cứu ([meetings-research.vi.md](meetings-research.vi.md)) đề xuất. Chưa có dòng mã nào được viết; kế hoạch chỉ tạo ra các việc cần xây (issue).
>
> **Lưu ý quan trọng:** khi nghiên cứu, không mở được trang nào của Google, Zoom, Microsoft, Slack, Zalo, Chrome hay Edge. Mọi thông tin lấy từ phần tóm tắt trong kết quả tìm kiếm, **mọi mức giá chưa được kiểm chứng**. Vì vậy mỗi việc cần xây bắt đầu bằng bước đọc lại đúng trang chính thức và ghi kết quả lên issue. Các điểm về luật Việt Nam cần luật sư xác nhận.

## Nguyên tắc chung cho cả bốn nhóm

- **Không bao giờ tự làm thay người.** Không tự vào cuộc họp, không tự bắt đầu ghi, không tự nhập bản ghi, không tự gửi tin, không tự tiêu tiền. Lịch chỉ **gợi ý**, thông báo từ Zoom chỉ **gợi ý** nhập; mọi tin gửi đi là cú bấm của người ghi họp.
- **Chỉ gửi biên bản đã được duyệt.** Mọi kênh gửi (Slack, Teams, Zalo, webhook) chỉ gửi kết quả mà người ghi họp đã bấm "Chia sẻ"; không bao giờ gửi bản chép lời, âm thanh hay video.
- **Mỗi tích hợp là tuỳ chọn, mặc định tắt.** Ludy Meetings vẫn đủ dùng khi không có tài khoản nền tảng nào (tiện ích, micro, tải file lên).
- **AI là bản nháp.** Mỗi việc nói rõ AI làm gì, hoặc "không dùng AI, có chủ ý". Mọi lần gọi AI tính vào ngân sách AI, tắt AI thì phần lõi vẫn chạy.

## Nhóm A: học từ đối thủ, không cần tài khoản ngoài (giai đoạn M3, ưu tiên P2)

| Việc | Người dùng thấy gì | AI làm gì |
|---|---|---|
| **A1** Thông báo ghi âm và chỉ báo "đang ghi" | Nút "Sao chép thông báo ghi âm": câu tiếng Việt soạn sẵn để dán vào khung chat cuộc họp; thêm cách xác nhận mới "đã dán thông báo vào chat". Thanh trên cùng của ứng dụng luôn hiện "Đang ghi 12:31" khi đang ghi; nếu ghi âm dừng bất ngờ thì báo rõ. | Không dùng AI, có chủ ý: thông báo là hành vi pháp lý, không phải bản nháp |
| **A2** Cài đặt công ty "Cần xác nhận trước khi ghi" | Chủ hoặc quản trị chọn "Thường" (như hiện nay) hoặc "Chặt": chỉ chấp nhận cách báo bằng văn bản (dán vào chat, ghi trong thư mời, đồng ý bằng văn bản); chỉ nói miệng ở đầu cuộc họp thì máy chủ từ chối. | Không dùng AI |
| **A3** Hỏi đáp xuyên các cuộc họp, có dẫn nguồn | Ô "Hỏi về các cuộc họp": Vy trả lời ngắn, mỗi câu kèm dấu dẫn tới đúng dòng trong bản chép lời. Hiện sẵn ngân sách AI còn lại trước khi hỏi. Không lưu câu trả lời. | Vy đọc tối đa 40 dòng tìm được trong các cuộc họp người hỏi đọc được và viết câu trả lời; mã kiểm tra mọi dẫn nguồn là dòng thật và số liệu có trong dòng đó |
| **A4** Mẫu biên bản tiếng Việt | Chọn loại họp (chung, giao ban, khách hàng, nhà cung cấp, 1:1); "Xem biên bản" ra trang đúng khuôn văn phòng Việt Nam, in ra PDF, có chỗ ký tên. Mẫu riêng của từng công ty để sau. | Vy điền các mục từ bản chép lời; ngày, nơi họp, người dự, người phụ trách do mã điền, không do AI |
| **A5** Ghi chú của tôi, AI viết lại | Người ghi gõ vài ý thô; "Viết lại đầy đủ": ý của mình giữ nguyên, phần Vy thêm có kiểu riêng và dẫn tới dòng gốc. | Vy ghép ghi chú thô với bản chép lời thành bản nháp chỉ người ghi thấy tới khi duyệt |
| **A6** Webhook khi biên bản được duyệt | Mỗi thành viên có thể đặt một địa chỉ https của riêng mình (cho Zapier, Make, n8n hay hệ thống riêng); mỗi lần duyệt, một tin có chữ ký được gửi tới đó. Người ghi chọn trường gửi (tiêu đề, tóm tắt, quyết định, việc cần làm); không bao giờ gửi bản chép lời hay thông tin liên hệ người dự. | Không dùng AI, có chủ ý |

Hai điểm JOY nên biết:

1. **A2:** hiện nay máy chủ đã từ chối âm thanh khi chưa có xác nhận, nên cài đặt mới chỉ làm chặt hơn cách xác nhận được chấp nhận (PO Meetings đã quyết như vậy).
2. **A6 là webhook của từng thành viên, không phải của cả công ty,** vì một cuộc họp chỉ người ghi và người dự đọc được; webhook của cả công ty do chủ đặt sẽ gửi cuộc họp riêng tư tới nơi người dự không chọn. Cách làm giống các kết nối AI của từng thành viên đã có; công ty phải bật công tắc (mặc định tắt).

Việc cần người thật: không cần tài khoản nào. Luật sư đọc câu thông báo và chính sách "chặt" qua việc #2585 đã có.

## Nhóm B: lịch và kênh gửi kết quả (giai đoạn M3)

- **B1, B2: đọc lịch Google để gợi ý "ghi cuộc họp này" (P2).** Dùng lại kết nối Google Calendar đã có, **không thêm kết nối Google thứ hai**. Hiện kết nối chỉ đọc giờ bận, không đọc tên cuộc họp; muốn đọc tên và giờ thì người dùng phải bật một công tắc riêng và đồng ý lại với Google. Trong tiện ích hiện thẻ "Sắp họp: Họp giao ban 9:00 (Google Meet)" với nút "Ghi cuộc họp này"; sau khi ghi xong, Ludy gợi ý "Gắn vào sự kiện lịch này?" khi đúng một sự kiện trùng giờ. **Ludy không bao giờ tự vào họp hay tự ghi theo lịch.** Chỉ lưu tên, giờ, địa chỉ cuộc họp và số người mời (không lưu địa chỉ người mời, không lưu mô tả), trong 1 ngày trước đến 7 ngày sau, chỉ chính thành viên đó đọc được, xoá ngay khi ngắt kết nối. Không dùng AI, có chủ ý: khớp theo giờ trùng, người bấm xác nhận.
- **B3: lịch Outlook (Microsoft Graph) (P2).** Cùng hình dạng như B1. **Đã được PO Meetings quyết giữ ở P2.** Lưu ý: tài liệu phạm vi sản phẩm ([scope.md](../product/scope.md)) xếp lịch Microsoft 365 vào mức "ít doanh nghiệp nhỏ dùng"; vì JOY nêu đích danh Outlook nên vẫn lên kế hoạch, nhưng tách riêng để có thể hạ xuống P3 mà không ảnh hưởng phần còn lại nếu cần.
- **B4: đăng biên bản đã duyệt lên Slack và Teams (P2).** Chủ hoặc quản trị dán một địa chỉ webhook (Slack "Incoming Webhook", Teams "Workflows"), cất kín như mật khẩu. Người ghi họp đọc đúng nội dung sẽ đăng rồi bấm "Gửi". Cách này **không cần Ludy đăng ký ứng dụng Slack hay lên Slack Marketplace**, không cần duyệt; chỉ đăng, không bao giờ đọc lịch sử kênh. Không dùng AI: văn bản đã duyệt được gửi nguyên.
- **B5: gửi biên bản cho khách qua Zalo OA, trong cửa sổ trả lời miễn phí (P2).** Dùng lại Zalo OA đã có trong Hộp thư, **không xây thêm một kết nối Zalo thứ hai**. Nút "Gửi qua Zalo" tạo một bản nháp trả lời trong cuộc trò chuyện của khách (các dòng người ghi chọn), người ghi bấm gửi bằng nút Gửi sẵn có. Quá cửa sổ trả lời thì nút bị khoá kèm lý do, **không gửi tin mẫu hay tin tính tiền**. Không dùng AI.
- **B6: ZNS (tin thông báo tính tiền của Zalo) (Icebox, P3).** Mỗi tin là tiền thật (báo cáo thấy khoảng 250 đến 360 đồng một tin ở một đối tác, chưa kiểm chứng), cần mẫu Zalo duyệt trước, không có môi trường thử. Chỉ làm khi JOY quyết định chi tiền: khi đó mỗi tin phải đi qua một đồng hồ ngân sách chi tiêu, bị từ chối khi hết ngân sách, và chỉ gửi khi người bấm.
- **Email** đã có (L3); kế hoạch này không thêm gì.

Việc cần người thật (JOY): **B-OA1** thêm quyền đọc lịch vào màn hình đồng ý OAuth của Google và làm thủ tục xác minh nếu Google xếp vào loại "nhạy cảm" (video demo, trang chính sách quyền riêng tư; khoảng 3 đến 5 ngày làm việc theo báo cáo); **B-OA2** đăng ký ứng dụng Microsoft Entra cho lịch Outlook. Slack, Teams và Zalo (B4, B5) không cần tài khoản mới của Ludy.

## Nhóm C: nhập bản ghi sau cuộc họp (giai đoạn GA gate, P2)

Ba nền tảng đều đóng hoặc tính tiền đường nghe trực tiếp nhưng còn đường **lấy bản ghi sau cuộc họp**. Ludy chỉ dùng đường này và **ưu tiên lấy file âm thanh** để tự chép tiếng Việt bằng bộ chép lời của Ludy, vì bản chép lời có sẵn của nền tảng có thể kém tiếng Việt.

- **C1 (lõi):** trong Cài đặt, "Kết nối nền tảng họp"; trên tab Cuộc họp hiện danh sách "Bản ghi có sẵn trên nền tảng"; bấm "Nhập" thì chạy bước xác nhận (có cách xác nhận mới: nền tảng đã báo cho mọi người và tôi xác nhận) rồi bản ghi đi vào đúng quy trình thường (chép lời, tóm tắt, duyệt, chia sẻ). **Không tải gì trước khi người bấm "Nhập"**; thông báo từ nền tảng chỉ tạo một gợi ý. Lần nhập đầu tiên so sánh bản chép lời của nền tảng với của Ludy trên cùng một cuộc họp tiếng Việt, ghi số đo lên issue (cần hai file ghi âm mẫu của việc #2585).
- **C2 Google Meet:** dùng Meet REST API và Google Drive. **Điều JOY cần biết:** quyền đọc bản ghi Meet và file Drive có thể thuộc loại "hạn chế", buộc làm đánh giá bảo mật CASA mỗi năm (khoảng 540 USD theo một nguồn cộng đồng, chưa kiểm chứng) và chờ Google duyệt vài tuần. Không ai biết loại nào nếu chưa đọc trang Google, nên **C-OA1 làm trước và quyết định**: nếu là loại hạn chế thì C2 dừng tới khi JOY duyệt khoản chi.
- **C3 Zoom:** webhook `recording.completed` của Zoom chỉ tạo gợi ý, file âm thanh riêng được ưu tiên. Ghi hình lên đám mây của Zoom theo báo cáo là tính năng gói trả phí. Ứng dụng Zoom chưa qua App Review (không có thời hạn công bố) thì chỉ chạy trong tài khoản của chính người làm ứng dụng.
- **C4 Microsoft Teams:** Microsoft Graph tính khoảng 0,003 USD mỗi phút bản ghi và 0,0022 USD mỗi phút bản chép lời, miễn phí 600 phút mỗi tháng, vượt thì cần tài khoản thanh toán Azure; quản trị viên công ty khách phải đồng ý và từ khoảng tháng 7/2026 phải bật thêm một công tắc mới. Ludy hiển thị chi phí trước lần nhập đầu tiên; **quyết định tài khoản Azure là của JOY**.
- Việc nhập dùng đúng đường tải lên hiện có (mã hoá, `crove-media`, thời hạn lưu); Ludy không xoá bản gốc trên nền tảng.

Việc cần người thật (JOY): **C-OA1** (Google: phân loại quyền, quyết định chi CASA, xác minh), **C-OA2** (ứng dụng Zoom và App Review), **C-OA3** (ứng dụng Microsoft, xác minh nhà xuất bản, quyết định thanh toán Azure, hướng dẫn quản trị cho khách). Bản đám mây Crove Cloud giữ một ứng dụng đã duyệt cho mỗi nền tảng ở lớp riêng; người tự cài Ludy đăng ký ứng dụng của mình. Phần lõi của Meetings không cần các ứng dụng này.

## Nhóm D: tiện ích trên Microsoft Edge (giai đoạn M3, P2)

- **D1:** viết bản rà soát tiện ích theo chính sách Chrome Web Store năm 2026 (áp dụng từ 1/8/2026: dữ liệu thu thập phải cần cho một mục đích duy nhất đã công bố, mọi thu thập phải thông báo nổi bật; lý do bị từ chối phổ biến là xin quyền không dùng tới) và sửa các mục chặn. Không thêm tính năng.
- **D2:** thử trên Edge, tạo gói cài cho Edge, bổ sung quy trình và các điều kiện của Edge Add-ons vào tài liệu cho cửa hàng.
- Việc cần người thật (JOY): **D-OA1** tài khoản nhà phát triển Microsoft Partner Center cho Edge Add-ons, đăng bài và nộp duyệt (như việc #2584 đã làm cho Chrome).

## Nhóm E: dịch bản chép lời và bản tóm tắt (giai đoạn M3, P2)

JOY thêm nhóm này ngày 2026-11-14 ("Tính năng dịch transcript và summary nữa chứ nhỉ"). Không cần tài khoản ngoài, chỉ tốn ngân sách AI công ty đã có.

- **Người dùng thấy gì.** Cuộc họp bằng tiếng Anh của một nhóm người Việt (hoặc ngược lại) là trường hợp thường gặp. Trên bản tóm tắt và bản chép lời có nút "Dịch sang English" (hoặc "Dịch sang tiếng Việt"). Bản dịch hiện **ngay cạnh bản gốc**, gắn nhãn "Bản dịch máy", không bao giờ thay bản gốc. Bản chép lời dài được dịch ở nền, từng phần một ("Đã dịch 12/20 phần"). Ai đọc được cuộc họp thì dịch được phần mình đọc; người ghi họp dịch được cả bản nháp chưa chia sẻ.
- **Việc E1 (tóm tắt), E2 (bản chép lời), E3 (tiếng Trung, Nhật, Hàn, để sau).** E1 và E2 ở giai đoạn M3, P2; E3 ở Icebox (P3) tới khi khách thí điểm hỏi tới.
- **AI làm gì.** Vy của chính người bấm dịch. Mỗi lần bấm là một lần gọi AI tính vào ngân sách (khoá riêng `meetings.translate`, để dịch không làm đứt việc chép lời hay tóm tắt). Hiện ước tính chi phí trước khi bấm; từng phần của bản chép lời phải qua bước kiểm tra ngân sách trước khi gọi, hết ngân sách thì dừng, giữ phần đã dịch, tiếp tục được sau. Tắt AI thì nút vẫn còn và nói rõ lý do.
- **Mã kiểm tra bản dịch.** Con số có trong bản dịch mà không có trong bản gốc thì dòng đó bị từ chối (hiện lại bản gốc); con số bị mất hoặc một tên riêng lạ thì hiện dấu cảnh báo "Số liệu có thể khác bản gốc". Bản dịch **không bao giờ là nguồn của việc gì khác**: không tạo việc cần làm, không đi vào thư theo dõi, không đăng lên Slack hay Zalo, không vào webhook, không được tìm kiếm, không được xuất.
- **Lưu thế nào (đã quyết trong kế hoạch):** lưu, và **riêng tư cho từng người**. Nếu chỉ dịch tức thời thì mỗi lần mở lại và mỗi người dự đều tốn thêm ngân sách. Mỗi bản dịch là một dòng dữ liệu phái sinh chỉ người đã bấm đọc được (chủ hoặc quản trị không phải người đọc cuộc họp thì không đọc được), gắn dấu "dịch từ bản nào" để biết bản gốc đã đổi ("Bản dịch cũ, dịch lại"), bị xoá cùng cuộc họp, khi bỏ chia sẻ, khi bản nháp hết hạn, theo thời hạn lưu văn bản, và **bị xoá hẳn (không chỉ che)** khi xử lý yêu cầu xoá dữ liệu cá nhân. Việc chia sẻ một bản dịch cho mọi người dự để chỉ tốn một lần là bước sau, có cú bấm của người ghi họp.
- **Gặp các phần khác.** Ghi chú trực tiếp: chưa dịch trong bản đầu (xem đã ghi xong mới dịch được). Thư theo dõi: vẫn gửi bản gốc; thư đã dịch là bước sau, người ghi đọc và duyệt. Hỏi đáp xuyên cuộc họp (A3): trả lời theo ngôn ngữ của câu hỏi, dẫn về dòng gốc, nên không cần kho dịch.
- **Việc cần người thật.** Một người song ngữ đọc khoảng 20 câu dịch và bản tóm tắt dịch của các cuộc họp mẫu rồi ghi nhận xét lên issue (không chặn việc hợp nhất, chặn việc gọi là xong). Chưa ai đo chất lượng dịch Việt-Anh cho lời nói trong họp, nên không giả định tốt.

## Chưa làm (đã nói rõ)

Dịch ghi chú trực tiếp, thư theo dõi đã dịch, chia sẻ bản dịch cho mọi người dự, biên bản đã dịch và các ngôn ngữ ngoài Việt-Anh (E3) cũng để sau. Ứng dụng máy tính; ứng dụng di động gốc; bot vào cuộc họp (không tự vào họp, không tự gửi tóm tắt cho mọi người được mời); Zoom RTMS và chép lời trực tiếp của Teams (chỉ theo dõi: giá RTMS và ai trả, tài liệu kỹ thuật của mục lộ trình RM570651, Google tắt Media API ngày 15/1/2027). Ba đề xuất khác trong báo cáo chưa được JOY duyệt nên chưa lên kế hoạch: ghi kết quả họp vào giao dịch và liên hệ trong CRM, công bố cấu trúc dữ liệu MCP của cuộc họp, và ứng dụng Slack riêng của Ludy.

## Thứ tự làm

1. Nhóm A trước (không cần tài khoản): A1 và A2, A6 song song với A3 và A4; A5 sau A4.
2. D1 sớm (nhỏ, giảm nguy cơ bị cửa hàng từ chối), D2 sau D1 và sau D-OA1.
3. B1 rồi B2; B4 và B5 làm lúc nào cũng được sau khi có cơ chế webhook của A6; B3 sau B1 và B-OA2.
4. Nhóm C chờ mốc GA gate và chờ ứng dụng nền tảng đầu tiên; thứ tự theo nền tảng khách thí điểm dùng (báo cáo gợi ý Google, Zoom, Microsoft).

## Các câu đã được PO Meetings quyết (2026-11-14) và một câu còn mở

Bốn câu kế hoạch nêu ra đã được PO Meetings quyết, ghi lại ở đây:

1. **A2:** cài đặt "Cần xác nhận trước khi ghi" chỉ làm chặt cách xác nhận được chấp nhận (chế độ "Chặt"), cộng chỉ báo "đang ghi" luôn hiện của A1; không có gì mạnh hơn.
2. **A6:** webhook là của từng thành viên, vì lý do nêu ở trên.
3. **B3:** lịch Outlook giữ ở P2 (JOY đã duyệt nhóm B nguyên khối).
4. **B6:** ZNS ở Icebox (P3) tới khi JOY quyết định chi tiền; PO sẽ hỏi JOY riêng.

Câu còn mở, dành cho PO Meetings: bản dịch (nhóm E) ở bản đầu riêng tư cho từng người đã bấm, thay vì một bản chung cho mọi người đọc; cách này tốn một lần dịch cho mỗi người nhưng không bao giờ để Vy của người này ghi chữ cho người khác đọc.

Số issue: A1 #3159, A2 #3160, A3 #3161, A4 #3162, A5 #3163, A6 #3164; B1 #3165, B2 #3166, B3 #3167, B4 #3168, B5 #3169, B6 #3170, B-OA1 #3171, B-OA2 #3172; C1 #3173, C2 #3174, C3 #3175, C4 #3176, C-OA1 #3177, C-OA2 #3178, C-OA3 #3179; D1 #3180, D2 #3181, D-OA1 #3182; E1 #3184, E2 #3185, E3 #3186. Chưa việc nào được nhận làm.

Danh sách đầy đủ các việc (A1 đến D-OA1, kèm tiêu chí nghiệm thu, tệp liên quan, mốc và độ ưu tiên) nằm ở [mục 11 của bản tiếng Anh](meetings-integrations.md#11-build-steps).
