# CRM lát cắt 2: báo giá và đơn bán từ cơ hội: tóm tắt cho JOY

Xong (bản nháp để anh xem, chưa xây gì). Viết ngày 2026-11-06 cho issue #2690, theo quyết định của anh trong cuộc trò chuyện với PO Engage cùng ngày. Bản đầy đủ bằng tiếng Anh, có bảng dữ liệu, các bước và nguồn, là bản chính: [crm-quotes.md](crm-quotes.md). Trang này trả lời câu CRM-Q3 trong [crm.vi.md](crm.vi.md) ("cơ hội thắng thì có nên có nút tạo hóa đơn?") và khoảng trống số một trong [competitors.vi.md](../product/competitors.vi.md).

Đây là kế hoạch thiết kế. Không có giá, ngày giao hay lời hứa nào với khách. Muốn xây thì anh duyệt, rồi PO mở issue theo danh sách bước.

## Làm được gì sau lát cắt này

Hiện nay cơ hội trong Ludy dừng ở chỗ hóa đơn bắt đầu: người bán gõ báo giá bằng Word hoặc Zalo, rồi gõ lại lần nữa khi làm hóa đơn. Sau lát cắt này, một công ty một người hoặc đội nhỏ làm được trong Ludy Engage (nhóm Khách hàng & Bán hàng):

1. **Tạo báo giá từ cơ hội** bằng một cú nhấp: khách và tên cơ hội đã điền sẵn; dòng hàng gõ tay, chép từ báo giá cũ, hoặc để Dy gợi ý từ cuộc trò chuyện; tổng tiền và VAT do mã tính, không do người gõ.
2. **Gửi báo giá**, luôn do một người bấm gửi: dưới dạng đường dẫn trong cuộc trò chuyện Zalo hoặc Messenger của khách, hoặc qua email (kèm PDF), bằng tiếng Việt, có thông tin của chính công ty.
3. **Ghi nhận khách đồng ý hoặc từ chối**; khi đồng ý, **đơn bán** được tạo ngay trong cùng một cú nhấp.
4. **Từ đơn, tạo bản nháp hóa đơn điện tử** bên Kế toán chỉ bằng một cú nhấp, các dòng đã có sẵn, để không ai gõ một lần bán hai lần.

Một người dùng mặc định, không cài đặt gì, làm được bước 1 đến 3 trong vài phút. Tắt AI thì phần lõi vẫn chạy. Báo giá và đơn không ghi gì vào sổ: tiền chỉ vào sổ khi phát hành hóa đơn, theo đường của Kế toán hiện có.

## Các đối thủ làm thế nào (đọc trang công khai ngày 2026-11-06)

| Sản phẩm | Điều đáng học |
|---|---|
| **HubSpot Quotes** | Báo giá dựng từ dữ liệu cơ hội, có thư dẫn, dòng hàng từ thư viện sản phẩm hoặc dòng tự do, ngày hết hạn, có thể bật duyệt. Khách đồng ý mặc định bằng chữ ký điện tử. Tài liệu cho nhà phát triển cảnh báo: dùng chung dòng hàng của cơ hội cho báo giá sẽ gây lỗi khó đoán, nên mỗi bên giữ bản sao riêng |
| **Odoo Sales** | Có nút "New Quotation" ngay trên cơ hội CRM, báo giá liên kết ngược về cơ hội. Báo giá có ngày hết hạn, mẫu, thuế, giá theo bảng giá. Xác nhận thì "chính thức thành đơn bán", rồi hóa đơn và phiếu giao hàng. Có thể bắt buộc ký online hoặc trả trước mới xác nhận |
| **MISA AMIS CRM** | "Sinh báo giá" trên cơ hội, dữ liệu được chép sang. Đơn giá mặc định là giá bán gần nhất của khách; có tùy chọn hiện đơn giá sau thuế; báo giá thành đơn hàng chỉ một thao tác; báo giá hoặc đơn tải được dạng hình ảnh để gửi qua công cụ chat; đơn sang hóa đơn, đồng bộ sang AMIS Kế toán. Gửi báo giá qua email: chưa xác nhận |
| **Base.vn** | Báo giá và hợp đồng quản lý chung, giữ mọi phiên bản; báo giá đã ký thành hợp đồng; chiết khấu trên 10% chuyển phòng duyệt. Chi tiết nút tạo từ cơ hội: chưa xác nhận |
| **Pancake POS** | Không thấy tính năng báo giá. Đơn tạo ngay trong chat; chatbot tóm tắt đơn cho khách xác nhận; POS xuất hóa đơn điện tử từ đơn |

Rút ra:
- Ai cũng mang dữ liệu từ cơ hội sang báo giá, rồi sang đơn và hóa đơn. Đó là giá trị cốt lõi. Ludy khác ở phần AI, tổng tiền được kiểm tra bằng mã, và mã nguồn mở.
- Báo giá giữ **bản sao dòng hàng** tại lúc gửi; không dùng chung với cơ hội.
- Mặc định **giá bán gần nhất** của MISA hợp người bán Việt, không cần mô hình AI.
- Báo giá của người Việt đi qua chat, nên Ludy gửi **đường dẫn** ngay trong cuộc trò chuyện.
- Khách tự bấm đồng ý là một thao tác công khai tạo cam kết; kế hoạch này để ngoài lát cắt đầu (câu hỏi O1).

## Thiết kế gọn

- **Dữ liệu** (module CRM, mọi bảng có `org_id` và RLS như các bảng khác): báo giá (mỗi bản sửa là một dòng mới, cùng số, ví dụ `BG-2026-0007-R2`), dòng hàng (mô tả, đơn vị, số lượng, đơn giá, % chiết khấu, VAT theo dòng), đơn bán (`DH-2026-0003`, bản sao đóng băng của báo giá đã đồng ý), đường dẫn công khai có mã bí mật (chỉ lưu băm), và một dòng cài đặt tùy chọn cho đầu thư (điện thoại, email, logo, ghi chú ngân hàng).
- **Trạng thái:** nháp, đã gửi, đã đồng ý, đã từ chối, bị thay thế. **Hết hạn không lưu**: báo giá đã gửi mà quá ngày hiệu lực thì hiện là hết hạn và không cho ghi đồng ý cho đến khi gửi bản sửa. Báo giá đã gửi không bao giờ đổi; muốn sửa thì tạo bản mới.
- **Tiền và thuế:** thập phân từ đầu đến cuối, chỉ đồng Việt Nam, qua các hàm tiền trong `@crove/l10n-vn`, không dùng số JavaScript cho tiền. Mỗi dòng làm tròn nửa lên về đồng; VAT mỗi dòng cũng làm tròn như vậy; tổng là tổng các dòng đã tròn. Đây chính là cách bản nháp hóa đơn hiện làm, nên tổng báo giá bằng tổng hóa đơn. VAT: 0, 5, 8, 10 phần trăm và không chịu thuế, lấy từ danh sách chung; ngày nào áp mức nào là luật của bên Kế toán.
- **Gửi:** đường dẫn đọc được, in được, không cần đăng nhập, mã 32 byte ngẫu nhiên, một mã chỉ mở đúng một báo giá, sửa báo giá thì đường dẫn cũ bị thu hồi. Email đi qua đường gửi thư của hệ thống (ADR-0034), luôn do người bấm. PDF phía máy chủ cần thêm một thư viện và phông tiếng Việt, nên làm sau đường dẫn.
- **Dy** (đồng nghiệp AI của hộp thư, khách hàng và bán hàng) giúp ở một chỗ: **gợi ý dòng hàng** khi người dùng bấm. Dy đọc cơ hội, tin nhắn gần đây của khách (chỉ khi tổ chức cho phép AI đọc lời khách) và các báo giá cũ. Gợi ý không được lưu: người dùng áp dụng, sửa hoặc bỏ từng dòng. Mã kiểm tra: mọi con số Dy nêu phải có trong nguồn; giá nào nguồn không có thì để trống; VAT ngoài danh sách bị từ chối; tổng do mã tính. Dy không bao giờ gửi, không ghi đồng ý, không tạo đơn. Mỗi lần gọi mô hình đi qua đồng hồ ngân sách AI; tắt AI thì trình soạn vẫn dùng bình thường.
- **Bàn giao sang Kế toán và kho:** Engage chỉ phát ra một gói dữ liệu đơn (khách, các dòng, tổng). Kế toán có một lệnh "tạo bản nháp hóa đơn từ nguồn", **kiểm tra lại mọi thứ** và vẫn do người đọc rồi bấm Phát hành. Đơn không di chuyển kho và không ghi sổ; kho nhận từ các dòng của hóa đơn đã phát hành, theo đường hiện có. Cần thêm một ADR ngắn cho hợp đồng này, viết ở đầu bước Q4 sau khi PO Kế toán trả lời.

## Các bước xây (mỗi bước một PR đầy đủ, ưu tiên P2)

| Bước | Làm gì | Bảo vệ (security review) |
|---|---|---|
| Q1 | Dữ liệu báo giá và trình soạn: tạo từ cơ hội, dòng hàng, chép từ báo giá cũ, giá bán gần nhất, hàm tính tổng dùng chung | có (migration) |
| Q2 | Gửi bằng đường dẫn trong cuộc trò chuyện và bằng email; trang công khai in được; theo dõi lần mở đầu tiên | có (migration, trang công khai) |
| Q3 | PDF phía máy chủ, phông tiếng Việt, đính kèm email | có (thêm thư viện, đường gửi thư). Nếu không thư viện nào đạt thì bỏ bước này, vẫn còn in từ trình duyệt |
| Q4 | Ghi nhận đồng ý hoặc từ chối, tạo đơn, bàn giao sang bản nháp hóa đơn (kèm phần Kế toán, do dòng Kế toán làm) | có |
| Q5 | Dy gợi ý dòng hàng | không |
| Q6 | Nhắc theo dõi báo giá chưa trả lời hoặc sắp hết hạn, tab báo cáo "Báo giá", kiểm thử toàn luồng, hướng dẫn | không |

Chưa làm, để Icebox (P3) trừ khi anh mở lại: khách tự đồng ý trên đường dẫn, ngưỡng chiết khấu cần người duyệt, ngôn ngữ thứ hai, dòng tùy chọn, chọn hàng từ danh mục kho, xuất kho theo đơn, mã QR hoặc link thanh toán trên báo giá.

## Câu hỏi cho anh (JOY): mỗi câu một quyết định

1. **O1. Khách có được tự bấm "Đồng ý" trên đường dẫn báo giá không, hay luôn do một người ghi nhận?** Khuyến nghị: người ghi nhận, trong lát cắt này. Người bán Việt thường chốt trong Zalo hoặc Messenger; một nút công khai tạo cam kết cần security review và quy tắc chống lạm dụng riêng, có thể làm sau khi đã dùng báo giá. Nếu không trả lời: người ghi nhận.
2. **O2. Chiết khấu trên một mức nào đó có cần người thứ hai duyệt không?** Khuyến nghị: không. Công ty một người không có người thứ hai; ngưỡng do chủ đặt có thể thêm sau cho đội. Nếu không trả lời: không duyệt, thành viên nào cũng được chiết khấu.
3. **O3. Hình thức đầu tiên là đường dẫn trong chat, rồi PDF qua email, hay PDF phải đi trước?** Khuyến nghị: đường dẫn trước (Q2), PDF sau (Q3). Đường dẫn không cần thư viện mới và hợp cách báo giá thực sự đi; PDF theo sau cho email doanh nghiệp. Nếu không trả lời: đường dẫn trước.

## Câu hỏi cho PO Kế toán: mỗi câu một quyết định

1. **A1. Bảng nháp hóa đơn có thể thêm hai cột tham chiếu nguồn (`source_kind`, `source_id`) và một lệnh tạo nháp từ nguồn, tự kiểm tra lại dữ liệu nhận vào không?** Phương án khác là một bảng đơn bán trong kernel mà cả hai module cùng tham chiếu. Khuyến nghị: tham chiếu mềm. Giữ đơn trong CRM, không cần bảng kernel mới, và dùng lại được cho lịch hẹn hay đơn sàn. Bảng kernel chắc hơn về toàn vẹn nhưng đưa một khái niệm CRM vào kernel được bảo vệ. Không trả lời: phần Kế toán của Q4 chờ; Q1 đến Q3 không phụ thuộc.
2. **A2. Dòng nháp hóa đơn hiện chưa có cột chiết khấu. Nghị định 254 và API nhà cung cấp lấy chiết khấu theo dòng hay bằng một dòng chiết khấu, và có thể thêm cột `discount_amount` cho dòng không?** Việc kế toán đối chiếu nghị định (#2506) quyết định. Khuyến nghị: thêm cột sau khi đọc nghị định. Trước đó, đơn có chiết khấu chưa bàn giao được. Không trả lời: báo giá vẫn cho chiết khấu, nút tạo nháp bị tắt với các đơn đó.
3. **A3. Xuất kho khi bán lấy từ các dòng của hóa đơn đã phát hành (đường hiện có) hay từ đơn khi giao hàng?** Khuyến nghị: từ hóa đơn trong lát cắt này, không thêm mã kho, đơn không di chuyển gì. Xuất kho theo đơn thuộc bước giao hàng mà dòng Kế toán chưa lên kế hoạch. Không trả lời: theo hóa đơn.
4. **A4. Có mở cho CRM đọc danh sách mặt hàng của kho (mã, tên, đơn vị, VAT theo ngành) qua một cổng đọc, để dòng báo giá chọn được hàng?** Khuyến nghị: chưa, trong lát cắt này. Dòng tự do cùng giá bán gần nhất là đủ; khi kho dùng thật thì dùng một truy vấn đọc trong hợp đồng, không dùng khóa ngoại. Không trả lời: chưa chọn hàng từ danh mục.

## Rủi ro chính

- Bàn giao lệch so với kiểm tra của bản nháp: hàm tính tổng dùng chung và bản nháp tự kiểm tra lại mọi thứ nhận vào.
- Đường dẫn công khai bị lộ: mã 32 byte, chỉ lưu băm, một mã một báo giá, thu hồi khi sửa, hết hạn, mọi mã sai nhận cùng một lời từ chối, và là thay đổi thuộc đường được bảo vệ nên có security review riêng.
- Thư viện PDF và phông: phải qua chính sách chuỗi cung ứng và kiểm tra giấy phép; nếu không đạt thì bỏ Q3.
- Lời của khách đến mô hình AI: chỉ khi tổ chức bật công tắc, được bao như dữ liệu không đáng tin, và kiểm tra bằng con số.
- Cửa sổ chat của Zalo hoặc Messenger có thể đã đóng lúc muốn gửi: nút gửi nói rõ và gợi ý email.

## Nguồn

Đọc ngày 2026-11-06. Danh sách đường dẫn đầy đủ nằm ở mục Sources của [bản tiếng Anh](crm-quotes.md). Một số trang không tải được (một trang HubSpot trả 404, trang tài liệu Pancake hết hạn chứng chỉ, trang Odoo chỉ đọc được một phần) nên đã dùng kết quả tìm kiếm thay; các ô "chưa xác nhận" cần xem kỹ hơn trước khi ai đó dựa vào.
