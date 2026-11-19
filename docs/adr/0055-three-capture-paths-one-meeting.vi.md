# Ba cách ghi cuộc họp, một cuộc họp chỉ ghi một lần: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [ADR-0055](https://github.com/DOS/Ludy/blob/main/docs/adr/0055-three-capture-paths-one-meeting.md), ngày 2026-11-19. Bản tiếng Anh là bản chính. Trạng thái: **Đề xuất, chưa làm gì và chưa được duyệt**. Số 0054 đã có người dùng (PR #3980, đổi tên Ludy), nên tài liệu này là 0055.

## Vấn đề

Bạn muốn có đủ **ba cách ghi trực tiếp**: tiện ích trình duyệt, app máy tính (desktop) và bot vào cuộc họp, nhưng **không bao giờ ghi một cuộc họp hai lần**. Bạn cũng nói app máy tính sẽ thành bắt buộc nếu sau này Ludy làm mô-đun chat kiểu Slack hoặc Lark (mô-đun đó hiện chưa có trong kế hoạch nào; tài liệu chỉ chừa chỗ).

Rủi ro có thật: một người bấm tiện ích trên tab Meet, lúc đó bot lịch cũng sắp vào, và app máy tính tự thấy cuộc gọi: ba bản ghi, ba lần trả tiền chép lời, ba bản chép khác nhau, nhiều bản xác nhận thông báo cho một cuộc nói chuyện. Theo những gì tôi đọc trong mã, hiện chưa có chỗ nào từ chối bản ghi thứ hai của cùng một cuộc họp.

## Thị trường (đọc ngày 2026-11-19)

Tôi đọc trang trợ giúp và blog chính thức của tám sản phẩm: Granola, Notion AI Meeting Notes, Fireflies, Otter, tl;dv, Read.ai, Jamie, Noota. Trang của Otter và Read.ai chặn không mở được, nên phần về hai hãng này chỉ lấy từ tóm tắt tìm kiếm (đã đánh dấu). "Không thấy tài liệu" nghĩa là tôi không tìm thấy, chứ chưa chắc là không có.

- **Chỉ có bot mới được chống ghi trùng, và chỉ theo sự kiện lịch.** tl;dv, Otter, Noota có quy tắc rõ (người tổ chức được ưu tiên, rồi gói cao hơn hoặc quản trị viên chọn). Fireflies: người mời đầu tiên thắng. **Tôi không thấy hãng nào nói rõ quy tắc giữa bot và app máy tính của chính họ, hoặc giữa hai người cùng dùng app máy tính.** Granola, Notion, Jamie tránh trùng chủ yếu bằng cách không bao giờ tự ghi, hoặc không tự bắt đầu lần thứ hai. Vì vậy quy tắc của Ludy không sao chép từ ai, mà dựa trên phần khớp lịch Ludy đã có.
- **Mọi cách ghi không bot đều đẩy trách nhiệm thông báo sang người dùng**, kèm công cụ tùy chọn: tin nhắn tự gửi vào chat cuộc họp, đọc thông báo vào cuộc gọi, hình mờ trên camera ảo, email báo trước từ lịch. tl;dv nói thẳng: khi không có bot, việc báo cho mọi người là của người dùng.
- Kỹ thuật: âm thanh hệ thống cộng micro (Core Audio hoặc ScreenCaptureKit trên macOS, WASAPI loopback trên Windows). Dữ liệu của bên thứ ba cho thấy Granola và Notion dùng Electron (hai hãng không tự nói). Với sáu hãng còn lại tôi **không xác nhận được** họ dùng gì.

## Vai trò từng cách ghi

- **Tiện ích** (Chrome, Edge): họp trong trình duyệt và máy không cài được app. Đã có.
- **Ghi trong app và tải file lên**: họp quanh bàn, file bất kỳ. Đã có.
- **App máy tính "Ludy Desktop"**: Zoom, Teams, Zalo PC, huddle Slack và họp trực tiếp trên laptop (âm thanh hệ thống cộng micro). Đây là đường duy nhất cho Zalo PC và huddle Slack. Chưa làm.
- **Bot** (ADR-0052, L4b): họp khi người ghi không ngồi trước máy. Vẫn là đề xuất; các câu 2, 3, 4, 6, 7, 8 của ADR-0052 chưa trả lời và tài liệu này **không trả lời hộ**.
- **Nhập bản ghi của nền tảng** (C1 đến C3): ghi sau cuộc họp.

## Quy tắc "một cuộc họp, một lần ghi"

1. **Thế nào là "cùng một cuộc họp":** theo thứ tự: sự kiện lịch đã gắn; hoặc "mã cuộc họp" (băm từ địa chỉ vào họp: mã Meet, số Zoom, thread Teams); hoặc trùng giờ trong 15 phút với đúng một sự kiện lịch của người ghi (cách khớp B1 đang dùng, và người ghi bấm xác nhận).
2. **Máy chủ quyết định, không tin máy khách.** Một bảng mới "phiên ghi" (đề xuất): mỗi cuộc họp chỉ có một phiên đang mở. Mọi cách ghi phải xin bắt đầu trước khi gửi âm thanh. Nếu đã có phiên khác, máy chủ từ chối và nói **ghi bằng cách nào và từ lúc nào** ("Tiện ích đang ghi cuộc họp này từ 14:02"), không nói tên ai. Phiên không có tín hiệu sống 90 giây thì tự đóng (trình duyệt sập, laptop gập lại không khóa cuộc họp). Phải có bản xác nhận thông báo trước khi bắt đầu, như hiện nay.
3. **Bot đã hẹn và ghi trên máy:** ghi trên máy thắng **nếu bot chưa bắt đầu**: bot không vào, hoặc lệnh hẹn bị hủy. Nếu bot đã vào và đang ghi thì bản ghi đầu tiên được giữ; ghi trên máy bị từ chối và nói bot đang ghi; người dùng có thể bấm "Dừng bot" rồi ghi trên máy. Không bao giờ tự động.
4. **Nhập bản ghi nền tảng** không bao giờ tạo cuộc họp thứ hai cho cuộc gọi Ludy đã ghi: dòng nhập sẽ báo "Ludy đã có bản ghi của cuộc họp này". Sau này có thể cho gắn bản chép lời của nền tảng vào cuộc họp đó (ghi rõ là của nền tảng).
5. **Hai người cùng công ty:** người thứ hai nhận cùng câu từ chối (ghi bằng cách nào, từ lúc nào) và gợi ý xin chia sẻ cuộc họp đang ghi.

## App máy tính: một khung dùng chung, ghi cuộc họp là việc đầu tiên

"Ludy Desktop" là **khung app chung của Ludy do nhóm Platform sở hữu**, không phải app riêng của Họp. Ghi cuộc họp là khả năng đầu tiên; chừa chỗ (chưa làm) cho phím tắt Thêm nhanh toàn hệ thống, thông báo ở khay, mô-đun chat nếu bạn thêm sau này, và ký bằng USB token sau này.

**Electron hay Tauri** (số đo trong tài liệu chỉ là bài thử đơn lẻ, phải đo lại trên khung thật):

- **Electron:** bản cài khoảng 100 MB trở lên; ghi âm thanh hệ thống có sẵn (Windows loopback, macOS Core Audio tap từ Electron 39); cập nhật tự động có sẵn; một ngôn ngữ (TypeScript) như phần còn lại của dự án. Nhược điểm: nặng hơn; trên macOS nếu thiếu quyền thì âm thanh im lặng chứ không báo lỗi.
- **Tauri 2:** bản cài chỉ vài MB, nhẹ hơn; nhưng không có API ghi âm thanh hệ thống sẵn (plugin của bên thứ ba chỉ ghi micro trên macOS), nên phải tự viết bằng Rust; hai bộ vẽ giao diện khác nhau (WebView2 và WKWebView).
- **Ký phần mềm:** macOS cần tài khoản Apple Developer 99 USD một năm, công ty có mã D-U-N-S và website, rồi ký và "notarize". Windows: dịch vụ Azure Artifact Signing (khoảng 9,99 USD một tháng) **không liệt kê Việt Nam**, nên nhiều khả năng phải mua chứng chỉ EV hoặc OV từ một tổ chức cấp chứng chỉ (một bài báo 2026 nêu khoảng 290 đến 500 USD một năm cho EV; chưa có giá OV đáng tin). Tài khoản, tiền và khóa ký là việc của chủ sở hữu, không ai trong nhóm tự làm.
- **Đề xuất: Electron cho lát đầu**, vì có sẵn ghi âm thanh hai hệ điều hành và cập nhật, một ngôn ngữ, giao diện của tiện ích dùng lại được. Giữ khối ghi âm sau một giao diện hẹp để sau này đổi sang Tauri nếu kích thước hoặc bộ nhớ thành vấn đề.

## Xin phép người tham gia khi không có bot nhìn thấy được

Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (hiệu lực 2026-01-01) và Nghị định 356/2025/NĐ-CP **đã thay Nghị định 13/2023**; kế hoạch của Ludy đọc theo cặp mới và vẫn chỉ là bình luận cho tới khi luật sư (#62) trả lời. Bot thấy được thì tự báo cho mọi người; tiện ích và app máy tính thì không báo ai. Nên app phải, **trước khi lưu bất kỳ âm thanh nào**:

1. Chặn ghi cho tới khi người ghi xác nhận như mọi nơi khác (ai, lúc nào, báo bằng cách nào, bản thông báo nào); máy chủ đã từ chối âm thanh nếu thiếu bản xác nhận này.
2. Hiện câu thông báo để đọc to và cho sao chép để dán vào chat cuộc họp. App không đăng được vào Zoom, Teams, Zalo (không có API chính thức) và không được làm như thể làm được.
3. Có biểu tượng đang ghi **không ẩn được** (khay và một thanh nhỏ luôn nổi có đồng hồ và nút dừng).
4. **Không bao giờ tự bắt đầu.** App có thể gợi ý "Ghi cuộc họp này" khi thấy cửa sổ họp, nhưng phải có cú bấm.
5. Chỉ ghi tiếng của app họp, không ghi cả máy, nếu hệ điều hành cho phép (nhạc, cuộc gọi cá nhân không bị ghi). Điểm này là suy luận, sẽ thử ở lát đầu.
6. Không nhận diện giọng giữa các cuộc họp.

**Câu hỏi thêm cho luật sư (danh sách #2585 và #62):** thông báo do người ghi đọc to hoặc dán vào chat có đủ cho cách ghi không bot không, hay từng người phải đồng ý; thông báo phải hiện trước âm thanh đầu tiên không và bản xác nhận của người ghi có đủ làm bằng chứng không; ghi âm thanh hệ thống của cuộc gọi mà người ghi tham gia nhưng không phải người tổ chức (Zoom của khách, cuộc gọi Zalo với nhà cung cấp) có nằm trong mục đích hợp pháp của công ty không; họp trực tiếp trên laptop có dùng cùng một thông báo không; và văn bản nào là căn cứ (91/2025 kèm 356/2025, hay 13/2023).

## Lát đầu tiên và rủi ro

- **Lát 1: quy tắc "một cuộc họp, một lần ghi" cho các cách ghi đang có** (tiện ích và ghi trong app), thêm dòng "Ludy đã có bản ghi" khi nhập. Không cần app mới, có ích ngay, và là điều kiện cho app máy tính và bot.
- **Lát 2: khung Ludy Desktop chưa có ghi âm** (đăng nhập bằng token giới hạn, kho khóa của hệ điều hành, tự cập nhật, khay, bộ cài đã ký cho một hệ điều hành). **Lát 3: ghi âm trên Windows trước** (loopback theo từng app không hiện hộp xin quyền; Windows là nơi có Zalo PC, app Teams và Zoom, là giả định về doanh nghiệp nhỏ ở Việt Nam, chưa kiểm chứng), rồi macOS.
- **Rủi ro chính:** macOS im lặng khi thiếu quyền (app phải kiểm tra mức âm và báo trong vài giây); ký phần mềm và notarize tốn tiền và thời gian; Apple hay Microsoft đổi quy định; hai khối âm thanh và hệ thống phát hành là chi phí bảo trì lâu dài; ghi không bot thì người khác không thấy, luật sư chưa trả lời.
- **Đường dẫn được bảo vệ khi làm:** migration, `packages/kernel-contract`, tuyến cho phạm vi của token tiện ích (`http.ts`, phần lõi dùng chung); lát 2 thêm thư mục `apps/desktop`, `package.json` và khóa pnpm, workflow CI ký và phát hành (có bí mật ký: không worker nào chạy; chỉ điều phối viên chạy đúng danh sách bước bạn đã duyệt), `tools/deploy/**` nếu tự host máy chủ cập nhật, và đăng nhập bằng token (ADR-0032). Tất cả cần rà soát bảo mật.

## Mười câu cần bạn trả lời

Mỗi câu có đề xuất đứng đầu. Không có câu trả lời thì không làm gì.

1. **Có làm app máy tính không (đảo lại quyết định "không làm app máy tính" ngày 2026-11-03)?** Đề xuất: **có, là khung chung của nhóm Platform, ghi cuộc họp trước, sau lát 1.** Không trả lời thì kế hoạch giữ nguyên "chưa làm".
2. **Làm quy tắc "một cuộc họp, một lần ghi" trước (lát 1), trước mọi việc về app máy tính hay bot?** Đề xuất: **có.**
3. **Electron hay Tauri cho khung app?** Đề xuất: **Electron cho lát ghi âm đầu**; nhóm Platform và bạn xác nhận sau khi đo kích thước và bộ nhớ bản đầu.
4. **Hai người cùng công ty cùng ghi một cuộc họp: từ chối bản thứ hai và gợi ý chia sẻ bản đang chạy?** Đề xuất: **có** (nếu để mỗi người ghi riêng thì tốn gấp đôi tiền và thông báo cho cùng một cuộc nói chuyện).
5. **Ghi trên máy gặp bot đã hẹn: ghi trên máy thắng nếu bot chưa bắt đầu, bản ghi đầu tiên được giữ nếu bot đã vào?** Đề xuất: **có.** Chỉ cần khi có làm bot.
6. **Làm Windows trước rồi macOS?** Đề xuất: **có** (giả định về máy của khách chưa kiểm chứng; bạn biết máy của khách dùng thử).
7. **Tài khoản ký phần mềm (việc của chủ sở hữu, chi tiền mới):** tài khoản Apple Developer (99 USD một năm) và chứng chỉ Windows từ một tổ chức cấp chứng chỉ (Azure Artifact Signing không liệt kê Việt Nam). Đề xuất: chỉ mở khi lát 2 được duyệt.
8. **Thêm các câu hỏi luật sư ở trên vào danh sách (#2585, #62)?** Đề xuất: **có, ngay**; câu hỏi rẻ và chặn lát 3.
9. **Các câu hỏi về bot của ADR-0052 vẫn mở, tài liệu này không trả lời:** 2 (bot Zoom ngay hay khi khách thử nghiệm đòi), 3 (bot Meet và bot Teams: xác nhận "chưa làm"), 4 (dịch vụ bot của bên thứ ba), 6 (ai được gửi bot, không tự vào), 7 (chi phí và tài khoản Zoom), 8 (thông báo trong cuộc gọi cho bot).
10. **Mô-đun chat khiến app máy tính thành bắt buộc:** chưa có trong kế hoạch. Đề xuất: **chỉ ghi chú lại**; mở ra là một quyết định khác của bạn, kèm ADR riêng.

## Nếu không trả lời

Không làm gì. Ghi âm vẫn chạy bằng tiện ích, ghi trong app và tải file lên như hiện nay; vẫn có thể ghi trùng một cuộc họp bằng hai cách vì chưa có quy tắc của lát 1.
