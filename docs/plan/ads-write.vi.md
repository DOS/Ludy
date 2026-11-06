# Ludy Ads: chạy quảng cáo ngay trong Ludy (tóm tắt cho JOY)

> Bản tóm tắt tiếng Việt của [ads-write.md](ads-write.md) và [ADR-0043](../adr/0043-ads-write-running-ads.md), ngày 2026-11-01, issue [#2283](https://github.com/DOS/Ludy/issues/2283). Bản tiếng Anh là bản chuẩn. **Đây mới là kế hoạch, chưa xây gì.** Quyết định của JOY ngày 2026-11-01: người dùng chạy quảng cáo ngay trên Ludy, với chiến dịch đầy đủ. JOY đã trả lời 8 câu hỏi cùng ngày: câu 1 chọn A (xây W0, W1, W2 theo thứ tự), các câu 2 đến 8 "nhận hết" tức theo đúng khuyến nghị (ghi trong #2283). PO Nền tảng đã duyệt thiết kế và yêu cầu thêm 5 điểm (ghi bên dưới). Issue xây W0 đến W2 mở sau khi bản sửa kế hoạch này được gộp; W3 đến W6 chờ.

## Thay đổi gì

Bản v1 đã duyệt chỉ đọc số liệu quảng cáo. Giờ Ludy sẽ cho chủ doanh nghiệp **tự chạy quảng cáo**: dựng chiến dịch (mục tiêu, nhóm quảng cáo có ngân sách và lịch, đối tượng, quảng cáo lấy từ bài đăng hoặc thư viện ảnh của Ludy), bấm chạy, theo dõi, đổi ngân sách, tạm dừng. Mẫu tham chiếu là Hootsuite Ads.

**Không đổi:** Ads vẫn **không bao giờ ghi vào sổ kế toán**; chi tiêu vẫn vào sổ qua chứng từ như đã quyết. Phần đọc vẫn chỉ đọc. Phần ghi nằm ở một giao diện riêng, có kiểm tra riêng.

## Nguyên tắc tiền bạc: không ai duyệt, không tiêu một đồng

- **Mọi thao tác có thể bắt đầu hoặc tăng chi tiêu** (chạy chiến dịch, bật lại, tăng ngân sách, kéo dài lịch) là lệnh mức **R3**, đi qua cơ chế duyệt của Ludy: người duyệt **không được là người soạn kế hoạch**, phải xác thực hai lớp vừa xong, và phiếu duyệt **ghi rõ số tiền tối đa kế hoạch có thể tiêu**. Duyệt xong chỉ chạy đúng kế hoạch đó một lần, không cấp quyền tiêu tiền lâu dài.
- **Chỉ chủ sở hữu mới được đề nghị mở đường chi tiêu** (bật chạy quảng cáo cho tổ chức, cho một tài khoản, đặt hoặc tăng hạn mức, mở lại các lần chạy sau khi bị chặn). Quản trị viên hay thành viên không đề nghị được. Chủ sở hữu hoặc quản trị viên duyệt, nhưng không bao giờ là chính người đã đề nghị (trừ công ty một người). Nhờ vậy hai quản trị viên không thể tự mở chi tiêu với nhau khi chủ sở hữu không biết.
- Thao tác chỉ **giảm hoặc dừng** chi tiêu (tạm dừng, giảm ngân sách, rút ngắn, lưu trữ) không cần duyệt nhưng luôn được ghi nhật ký.
- **Hạn mức chi tiêu**: JOY đặt hạn mức theo ngày và theo tháng cho từng tài khoản quảng cáo. **Chưa đặt hạn mức thì không chạy được.** Mỗi lần duyệt và mỗi lần thực hiện, Ludy cộng cả chi tiêu đã cam kết của các chiến dịch đang chạy hoặc đã lên lịch; vượt hạn mức thì từ chối. Hạn mức chi tiêu của chính Meta được đọc và hiển thị bên cạnh, Ludy chỉ là lớp rào thứ hai.
- **Gọi nền tảng đúng một lần**: mỗi bước tạo trên Meta đi qua sổ `external_call` có khóa cố định. Các đối tượng được tạo ở trạng thái **tạm dừng**, bật cuối cùng, nên một lần chạy dở dang chưa tiêu gì. Nếu mất kết quả một bước, Ludy hỏi lại Meta (theo nhãn `ludy:` trong tên đối tượng) trước khi thử lại, không tạo trùng.
- **Trợ lý AI chỉ soạn nháp**, không bao giờ chạy, bật lại, tăng ngân sách hay đặt hạn mức.

## Năm điểm bổ sung theo yêu cầu của PO Nền tảng

1. **Công ty một người:** tổ chức chỉ có một người đủ quyền thì chủ sở hữu tự duyệt kế hoạch của mình (đánh dấu `self_approved` trong nhật ký). Mọi thứ khác giữ nguyên: vẫn phải xác thực hai lớp vừa xong, phiếu vẫn ghi số tiền tối đa, hạn mức vẫn chặn. Chủ chưa có yếu tố xác thực thứ hai thì chưa bật được quyền ghi. Khi có người thứ hai đủ quyền, chủ không còn tự duyệt kế hoạch mình soạn.
2. **Hạn mức kiểm tra dưới khóa:** lúc thực hiện, Ludy khóa theo tổ chức, tính lại chi tiêu đã cam kết và ghi cam kết của kế hoạch trong cùng một giao dịch, trước khi gọi Meta. Hai chiến dịch được duyệt cùng lúc sẽ xếp hàng, cái sau thấy cái trước và bị từ chối nếu cộng lại vượt hạn mức. Kiểm tra lúc duyệt chỉ để cảnh báo sớm.
3. **Hạn mức có đơn vị tiền:** hạn mức tính theo tiền của tài khoản quảng cáo; hạn mức của tổ chức có đơn vị riêng (mặc định VND). Tài khoản khác đơn vị tiền với hạn mức tổ chức thì chưa cho chạy (mã `ADS_CAP_CURRENCY`); quy đổi tiền là quyết định sau, để người duyệt không bị lệch tỷ giá mà họ chưa thấy.
4. **Token ghi quảng cáo:** niêm phong riêng, tách khỏi token đọc; mọi lệnh gọi ghi kèm `appsecret_proof` và ứng dụng bật "Require App Secret"; ngắt kết nối hoặc tắt công tắc thì thu hồi token ở Meta rồi xóa bản niêm phong (thu hồi lỗi thì thử lại và hiện "chưa thu hồi"); tắt công tắc thì mọi bước ghi đang xếp hàng bị hủy, bước đang chạy dở hoàn tất, đối tượng đã tạo vẫn ở trạng thái tạm dừng.
5. **Nút dừng khẩn cấp:** lệnh `ads.pause_all` (mức R2, không cần duyệt vì chỉ dừng chi tiêu) tạm dừng mọi chiến dịch Ludy đã chạy trong tổ chức, đặt cờ chặn chạy mới cho tới khi chủ sở hữu gỡ (R3, xác thực hai lớp). Tắt công tắc tổ chức cũng chạy bước dừng này trước.

## Quyền hạn: bật theo từng lớp

1. **Triển khai**: ứng dụng Meta. Khuyến nghị dùng **một ứng dụng riêng chỉ để chạy quảng cáo**, để token ghi quảng cáo không dùng chung với đăng bài lên Page.
2. **Công tắc của tổ chức** (chủ sở hữu bật, xác thực hai lớp, mặc định tắt). Tắt: giữ nguyên chốt chặn của PR #2275, tức **từ chối mọi token có quyền `ads_management` hoặc `business_management`**. Bật: Ludy xin và chấp nhận các quyền đó. Chốt chặn không bị bỏ, chỉ trở thành có điều kiện.
3. **Từng tài khoản quảng cáo**: chủ sở hữu bật quyền ghi cho tài khoản đó (mặc định tắt), qua một bước kết nối mới đi lại hộp thoại của Meta, không nâng cấp ngầm kết nối cũ.

Quyền mới: soạn nháp (chủ sở hữu, quản trị viên, thành viên marketing); duyệt (chủ sở hữu, quản trị viên, người soạn không được tự duyệt); tạm dừng và giảm (như soạn nháp); đặt hạn mức và bật công tắc (chỉ chủ sở hữu).

## Thứ tự các lát cắt (Meta trước)

| Lát | Làm được gì | Tiêu tiền? |
|---|---|---|
| W0 | Công tắc, kết nối có quyền ghi, vai trò, hạn mức. Nền tảng `sandbox` cũng có phần ghi (chạy offline) | Chưa gọi nền tảng |
| W1 | Soạn nháp chiến dịch, kiểm tra tại chỗ, xem trước, gửi duyệt | Không, chưa rời Ludy |
| W2 | Sau khi duyệt: tạo và bật trên Meta, hiện trạng thái duyệt của Meta (đang duyệt, bị từ chối, đang chạy) | **Có, chỉ sau khi duyệt đúng kế hoạch** |
| W3 | Boost một bài đã đăng | Có, cùng cổng |
| W4 | Tạm dừng, bật lại, đổi ngân sách và lịch, lưu trữ | Tăng, bật lại, kéo dài phải duyệt |
| W5 | Quảng cáo hiện trên lịch Social | Như W2 |
| W6 | Automated Boost (quy tắc trong hạn mức đã duyệt); Google Ads ghi (ADR riêng) | Có giới hạn |

**Mục tiêu đầu tiên**: Lưu lượng truy cập, Tương tác với bài đăng, và Tin nhắn Messenger (khuyến nghị): không cần pixel hay dữ liệu khách hàng. Mục tiêu Bán hàng và Khách hàng tiềm năng đến sau.

**Để ngoài và vì sao:** tệp đối tượng khách hàng, lookalike, pixel, Conversions API và biểu mẫu khách tiềm năng (dữ liệu cá nhân của người khác); nhóm quảng cáo đặc biệt (tín dụng, việc làm, nhà ở, chính trị) cho tới khi luật sư đọc luật Việt Nam; quy tắc tự động của nền tảng; sửa nội dung quảng cáo đang chạy; thanh toán với Meta (làm trên Meta); nhiều khách hàng đại lý; LinkedIn, X, TikTok, Google.

## Dữ liệu cá nhân

Nhắm theo vị trí, độ tuổi, giới tính, ngôn ngữ, sở thích và vị trí hiển thị chỉ là **tham số của một nhóm đối tượng, không lưu người nào**. **Tệp đối tượng từ danh sách khách hàng là dữ liệu cá nhân của bên thứ ba** và là quyết định riêng (câu 6): cần cơ sở pháp lý, thông báo, thỏa thuận xử lý dữ liệu và luật sư đọc trước. Khuyến nghị: để ngoài các lát đầu.

## Sổ kế toán

Chi tiêu vẫn vào sổ qua chứng từ như cũ; Ads không ghi sổ. Ludy chỉ thêm con số **chi tiêu đã cam kết** (số tiền các kế hoạch đang chạy hoặc đã lên lịch còn có thể tiêu trong tháng) cạnh chi tiêu thực tế.

## Việc chỉ JOY làm được (Meta)

- **Tài khoản quảng cáo của chính JOY, ứng dụng Meta cổ điển đang có (mức Limited):** quyền `ads_management` mức tiêu chuẩn đủ cho ứng dụng chỉ quản lý tài khoản của chủ app. Cần: người kết nối có vai trò trên app, tài khoản quảng cáo có phương thức thanh toán ở Meta. JOY làm được **ngay sau khi xây xong W0 đến W2**.
- **Tài khoản của doanh nghiệp khác (Ludy Cloud):** cần quyền truy cập nâng cao `ads_management` qua **App Review** của Meta, kèm **Business Verification** của portfolio doanh nghiệp, video quay toàn bộ luồng tạo và chạy quảng cáo, đường dẫn chính sách quyền riêng tư và địa chỉ xóa dữ liệu. Thứ tự: (1) quyết định thời điểm (câu 5); (2) xác nhận portfolio đã được xác minh; (3) tạo ứng dụng riêng để ghi (câu 7); (4) quay video từ bản W2 trên tài khoản của JOY; (5) nộp; (6) trả lời câu hỏi bổ sung của Meta.
- Luật Quảng cáo của Việt Nam áp dụng cho quảng cáo của chủ doanh nghiệp; Ludy chưa kiểm tra nội dung theo luật đó, luật sư cần đọc trước khi Ludy gợi ý mẫu hay câu chữ.

## Câu hỏi cho JOY (mỗi câu: lựa chọn, khuyến nghị, nếu không trả lời)

**Đã trả lời ngày 2026-11-01: câu 1 chọn A; các câu 2 đến 8 "Nhận hết", tức chọn A theo khuyến nghị** (câu 7, chỉnh ngày 2026-11-02: với tài khoản của chính JOY thì dùng chung ứng dụng Meta cổ điển đang có (lựa chọn B); trước khi phục vụ doanh nghiệp khác thì tách một ứng dụng riêng chỉ để chạy quảng cáo (lựa chọn A). Cặp biến môi trường để ghi quảng cáo là riêng và được phép trỏ cùng ứng dụng với bên đọc). Nội dung câu hỏi giữ nguyên như đã hỏi:

1. **Lát ghi nào làm trước, có được mở W0 đến W2 không?** A. W0, W1, W2 theo thứ tự: dựng, soạn và duyệt chưa tiêu gì, rồi chạy một chiến dịch (**khuyến nghị**). B. Boost bài đăng trước (cũng cần công tắc, hạn mức và duyệt như W2). C. Giữ chỉ đọc. *Không trả lời: chưa mở issue xây dựng nào.*
2. **Ai duyệt một lần chạy?** A. Chủ sở hữu và quản trị viên, không bao giờ là người soạn; tổ chức chỉ có một người thì chủ sở hữu tự duyệt và được đánh dấu (**khuyến nghị**, đúng quy tắc P10). B. Thêm một người duyệt marketing do chủ chỉ định. *Không trả lời: A.*
3. **Hạn mức chi tiêu mặc định?** A. Không đặt hạn mức thì không chạy được (**khuyến nghị**). B. Có hạn mức mặc định, chủ đổi được; ít vướng nhưng hạn mức cao thì dễ ra hóa đơn bất ngờ. *Không trả lời: A.*
4. **Mục tiêu nào trước?** A. Lưu lượng truy cập, Tương tác và Tin nhắn Messenger (**khuyến nghị**). B. Thêm Bán hàng và Khách hàng tiềm năng ngay (cần pixel, Conversions API hoặc biểu mẫu, tức dữ liệu cá nhân). *Không trả lời: A.*
5. **Khi nào bắt đầu Business Verification và App Review của Meta cho phần ghi (Ludy Cloud)?** A. Sau khi W2 chạy được trên tài khoản của JOY (**khuyến nghị**, vì video quay luồng thật). B. Ngay bây giờ, song song (nhanh hơn cho Cloud nhưng Meta xem một luồng chưa xây). *Không trả lời: A. Tài khoản của JOY không cần review.*
6. **Tệp đối tượng khách hàng, lookalike, pixel, biểu mẫu khách tiềm năng?** (JOY và luật sư) A. Để ngoài các lát này, mở sau bằng một bản sửa kế hoạch có luật sư trước (**khuyến nghị**). B. Đưa tệp đối tượng khách hàng vào W2 (cần cơ sở pháp lý, thông báo, thỏa thuận xử lý dữ liệu và luật sư đọc trước). *Không trả lời: A.*
7. **Dùng ứng dụng Meta nào để ghi?** (việc của JOY) A. Một ứng dụng riêng chỉ để chạy quảng cáo (**khuyến nghị**): token ghi quảng cáo không dùng chung với đăng bài, và nếu Meta từ chối review bên này thì bên kia không bị chặn. B. Dùng chính ứng dụng cổ điển JOY đang có, chung với đăng bài và đọc (không phải tạo app mới; token khi đó cũng giữ các quyền đăng Page, màn hình sẽ nói rõ). *Không trả lời: B để JOY thử trên tài khoản của mình, A trước khi lên Ludy Cloud.*
8. **Automated Boost?** A. Có, sau này, dưới dạng quy tắc trong hạn mức chủ đã duyệt, mỗi lần chi vẫn được ghi (**khuyến nghị**). B. Không bao giờ: Boost luôn thủ công. *Không trả lời: chờ.*

Ngoài ra ADR-0043 đề xuất **trợ lý AI chỉ soạn nháp, không bao giờ chạy** (đây là khuyến nghị của PO Marketing; JOY có thể đảo lại).
