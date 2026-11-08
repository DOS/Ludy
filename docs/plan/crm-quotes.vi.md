# CRM lát cắt 2: báo giá và đơn bán từ cơ hội: tóm tắt cho JOY

Xong (bản nháp để anh xem, chưa xây gì). Viết ngày 2026-11-06 cho issue #2690, theo quyết định của anh trong cuộc trò chuyện với PO Engage cùng ngày. Bản đầy đủ bằng tiếng Anh, có bảng dữ liệu, các bước và nguồn, là bản chính: [crm-quotes.md](crm-quotes.md). Trang này trả lời câu CRM-Q3 trong [crm.vi.md](crm.vi.md) ("cơ hội thắng thì có nên có nút tạo hóa đơn?") và khoảng trống số một trong [competitors.vi.md](../product/competitors.vi.md).

Đây là kế hoạch thiết kế. Không có giá, ngày giao hay lời hứa nào với khách. Muốn xây thì anh duyệt, rồi PO mở issue theo danh sách bước.

## Làm được gì sau lát cắt này

Hiện nay cơ hội trong Ludy dừng ở chỗ hóa đơn bắt đầu: người bán gõ báo giá bằng Word hoặc Zalo, rồi gõ lại lần nữa khi làm hóa đơn. Sau lát cắt này, một công ty một người hoặc đội nhỏ làm được trong Ludy Engage (nhóm Khách hàng & Bán hàng):

1. **Tạo báo giá từ cơ hội** bằng một cú nhấp: khách và tên cơ hội đã điền sẵn; dòng hàng gõ tay, chép từ báo giá cũ, hoặc để Dy gợi ý từ cuộc trò chuyện; tổng tiền và VAT do mã tính, không do người gõ.
2. **Gửi báo giá**, luôn do một người bấm gửi: dưới dạng đường dẫn trong cuộc trò chuyện Zalo hoặc Messenger của khách, hoặc qua email (kèm PDF), bằng tiếng Việt, có thông tin của chính công ty.
3. **Ghi nhận khách đồng ý hoặc từ chối**; khi đồng ý, **đơn bán** được tạo ngay trong cùng một cú nhấp.
4. **Trên đơn đã xác nhận, bấm "Lập hóa đơn"**: Kế toán tạo bản nháp hóa đơn điện tử từ các dòng của đơn (cả đơn, hoặc từng dòng khi giao hàng từng phần), các dòng đã có sẵn, để không ai gõ một lần bán hai lần. Phát hành vẫn do Kế toán duyệt.
5. **Đánh dấu một dòng đã giao**: kho chỉ trừ khi hàng rời đi, không trừ khi xác nhận đơn.

Một người dùng mặc định, không cài đặt gì, làm được bước 1 đến 3 trong vài phút. Tắt AI thì phần lõi vẫn chạy. Báo giá và đơn không ghi gì vào sổ và không đụng kho: tiền chỉ vào sổ khi phát hành hóa đơn, hàng chỉ trừ kho khi giao, cả hai theo đường của Kế toán hiện có.

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
- **Bàn giao sang Kế toán và kho** (theo quan điểm của PO Kế toán đăng trên issue #2690 ngày 2026-11-06): Engage không bao giờ ghi vào bảng của Kế toán. Kế toán tự tạo nháp hóa đơn bằng lệnh riêng khi người dùng bấm "Lập hóa đơn" trên **đơn đã xác nhận**, không bao giờ từ báo giá. Đơn mang theo: pháp nhân, người mua (tên, mã số thuế hoặc không có nếu là khách lẻ, địa chỉ, email nhận hóa đơn), tiền tệ, các dòng (mã mặt hàng nếu có, hoặc chữ; đơn vị, số lượng, đơn giá, chiết khấu, VAT, tất cả là chuỗi thập phân), số và ngày đơn. Không có khóa ngoại nào đi qua lược đồ khác: id của đơn chính là tham chiếu nguồn của dòng nháp. Có thể lập hóa đơn cả đơn hoặc từng dòng; dòng đã lập thì lần hai bị từ chối. Bản nháp tự kiểm tra lại mọi thứ nhận vào. Phát hành vẫn cần Kế toán duyệt (chủ hoặc quản trị, hai người). `{finance}` có thể gợi ý VAT và thông tin người mua trên bản nháp nhưng không bao giờ sửa đơn.
- **Giao hàng và kho:** kho chỉ di chuyển khi hàng rời đi, không phải khi xác nhận đơn (cùng quy tắc với nhập đơn từ sàn). Trong Engage người dùng đánh dấu một dòng **đã giao**; lệnh này ghi việc giao rồi chạy lệnh kho của Kế toán với dòng đơn làm nguồn. Giao hai lần không trừ kho hai lần; dòng dịch vụ không trừ kho; trả hàng đảo lại qua cùng đường. Hai lệnh không chung một giao dịch nên dòng có thể hiện "Chưa ghi kho" kèm nút thử lại an toàn.
- Cần thêm một ADR ngắn cho hợp đồng này, viết ở đầu bước Q4 sau khi PO Kế toán trả lời các câu hỏi bên dưới.

## Các bước xây (mỗi bước một PR đầy đủ, ưu tiên P2)

| Bước | Làm gì | Bảo vệ (security review) |
|---|---|---|
| Q1 | Dữ liệu báo giá và trình soạn: tạo từ cơ hội, dòng hàng, chép từ báo giá cũ, giá bán gần nhất, hàm tính tổng dùng chung | có (migration) |
| Q2 | Gửi bằng đường dẫn trong cuộc trò chuyện và bằng email; trang công khai in được; theo dõi lần mở đầu tiên | có (migration, trang công khai) |
| Q3 | PDF phía máy chủ, phông tiếng Việt, đính kèm email | có (đường gửi thư). PO Engage chọn tự viết bộ ghi PDF nhỏ, không thêm thư viện; phông Be Vietnam Pro (giấy phép OFL) nằm trong repo kèm nguồn |
| Q4 | Ghi nhận đồng ý hoặc từ chối, tạo đơn, nút "Lập hóa đơn" trên đơn đã xác nhận (kèm phần Kế toán, do dòng Kế toán làm) | có |
| Q4b | Đánh dấu dòng đã giao và ghi kho (kèm lệnh kho của Kế toán) | có |
| Q5 | Dy gợi ý dòng hàng | không |
| Q6 | Nhắc theo dõi báo giá chưa trả lời hoặc sắp hết hạn, tab báo cáo "Báo giá", kiểm thử toàn luồng, hướng dẫn | không |

Chưa làm, để Icebox (P3) trừ khi anh mở lại: khách tự đồng ý trên đường dẫn, ngưỡng chiết khấu cần người duyệt, ngôn ngữ thứ hai, dòng tùy chọn, chọn hàng từ danh mục kho, giao một phần số lượng của dòng, chứng từ giao hàng và vận chuyển, một cú nhấp "xác nhận và lập hóa đơn", mã QR hoặc link thanh toán trên báo giá.

## Câu hỏi cho anh (JOY): mỗi câu một quyết định

1. **O1. Khách có được tự bấm "Đồng ý" trên đường dẫn báo giá không, hay luôn do một người ghi nhận?** Khuyến nghị: người ghi nhận, trong lát cắt này. Người bán Việt thường chốt trong Zalo hoặc Messenger; một nút công khai tạo cam kết cần security review và quy tắc chống lạm dụng riêng, có thể làm sau khi đã dùng báo giá. Nếu không trả lời: người ghi nhận.
2. **O2. Chiết khấu trên một mức nào đó có cần người thứ hai duyệt không?** Khuyến nghị: không. Công ty một người không có người thứ hai; ngưỡng do chủ đặt có thể thêm sau cho đội. Nếu không trả lời: không duyệt, thành viên nào cũng được chiết khấu.
3. **O3. Hình thức đầu tiên là đường dẫn trong chat, rồi PDF qua email, hay PDF phải đi trước?** Khuyến nghị: đường dẫn trước (Q2), PDF sau (Q3). Đường dẫn không cần thư viện mới và hợp cách báo giá thực sự đi; PDF theo sau cho email doanh nghiệp. Nếu không trả lời: đường dẫn trước.

4. **O4. Có nên cho người bán nhỏ một cài đặt "xác nhận đơn và lập hóa đơn luôn" chỉ bằng một cú nhấp không?** (Điểm PO Kế toán để mở cho anh.) Khuyến nghị: chưa, trong lát cắt đầu giữ hai bước (xác nhận, rồi "Lập hóa đơn"), như PO Kế toán; cài đặt tắt mặc định có thể thêm sau khi đã dùng đơn. Nếu không trả lời: hai bước.

## Câu hỏi còn lại cho PO Kế toán: mỗi câu một quyết định

PO Kế toán đã chốt: ai tạo nháp, khi nào, đơn mang gì, ai phát hành, khi nào kho di chuyển. Còn mở:

1. **A1. Tham chiếu nguồn trên mỗi dòng nháp có đúng dạng này không:** `source_kind` (`crm.sales_order`), `source_id` (id đơn), `source_line_no`, kèm chỉ mục duy nhất trên các dòng của nháp chưa bị từ chối hoặc xóa, để dòng đã lập hóa đơn bị từ chối lần hai; và lệnh `finance.einvoice.draft_from_order` nhận cả đơn hoặc danh sách số dòng? Khuyến nghị: đúng cả hai, dùng lại được cho lịch hẹn hay đơn sàn. Không trả lời: phần Kế toán của Q4 chờ; Q1 đến Q3 không phụ thuộc.
2. **A2. Dòng nháp hóa đơn chưa có cột chiết khấu. Nghị định 254 và API nhà cung cấp lấy chiết khấu theo dòng hay bằng một dòng chiết khấu, và có thể thêm cột `discount_amount` cho dòng không?** Đơn mang cả phần trăm lẫn số tiền đã làm tròn. Việc kế toán đối chiếu nghị định (#2506) quyết định. Khuyến nghị: thêm cột sau khi đọc nghị định; trước đó "Lập hóa đơn" bị tắt với dòng có chiết khấu. Không trả lời: báo giá vẫn cho chiết khấu, bàn giao dòng đó bị tắt.
3. **A3. Mã mặt hàng đến dòng đơn bằng cách nào?** Hoặc Kế toán tự khớp dòng chữ với mặt hàng theo luật bí danh lúc tạo nháp và lúc giao (CRM không đổi gì), hoặc CRM có cổng đọc danh sách mặt hàng để dòng báo giá chọn được hàng. Khuyến nghị: chỉ khớp bí danh trong lát cắt này. Không trả lời: Kế toán khớp, chưa chọn từ danh mục.
4. **A4. Tránh trừ kho hai lần:** kế hoạch kho 8.2 trừ kho từ các dòng của chứng từ bán, mà giao dòng đơn cũng trừ kho. Làm sao tránh lần thứ hai? Khuyến nghị: cột nguồn của dòng nháp đi tiếp sang dòng chứng từ bán, và đường kho theo chứng từ bỏ qua dòng có nguồn là dòng đơn (việc giao giữ việc trừ kho); kiểm thử phát hành và giao một dòng theo thứ tự nào cũng chỉ trừ một lần. Không trả lời: lệnh giao chưa được xây.
5. **A5. Hình dạng lệnh giao `finance.stock.move_from_order_line`:** khóa (id đơn, số dòng), cả dòng, ngày chuyển kho là ngày giao, giá vốn lấy lúc chốt tháng, trả hàng bằng dòng đảo, cho phép tồn âm kèm cảnh báo, dòng dịch vụ không trừ kho. Đúng chưa? Khuyến nghị: đúng, và chưa có giao một phần số lượng. Không trả lời: chỉ cả dòng.
6. **A6. Lập hóa đơn theo dòng: chỉ cả dòng, hay cả một phần số lượng?** Khuyến nghị: cả dòng; người bán nhỏ ít khi giao dở một dòng, nếu cần thì tách dòng trong báo giá trước khi gửi. Không trả lời: cả dòng.

## Rủi ro chính

- Kho bị trừ hai lần cho một lần bán (giao dòng đơn và trừ kho theo chứng từ bán của hóa đơn): câu hỏi A4, và một kiểm thử phát hành rồi giao (hoặc ngược lại) cho ra đúng một lần trừ.
- Bàn giao lệch so với kiểm tra của bản nháp: hàm tính tổng dùng chung và bản nháp tự kiểm tra lại mọi thứ nhận vào.
- Đường dẫn công khai bị lộ: mã 32 byte, chỉ lưu băm, một mã một báo giá, thu hồi khi sửa, hết hạn, mọi mã sai nhận cùng một lời từ chối, và là thay đổi thuộc đường được bảo vệ nên có security review riêng.
- Thư viện PDF và phông: phải qua chính sách chuỗi cung ứng và kiểm tra giấy phép; nếu không đạt thì bỏ Q3.
- Lời của khách đến mô hình AI: chỉ khi tổ chức bật công tắc, được bao như dữ liệu không đáng tin, và kiểm tra bằng con số.
- Cửa sổ chat của Zalo hoặc Messenger có thể đã đóng lúc muốn gửi: nút gửi nói rõ và gợi ý email.

## Nguồn

Đọc ngày 2026-11-06. Danh sách đường dẫn đầy đủ nằm ở mục Sources của [bản tiếng Anh](crm-quotes.md). Một số trang không tải được (một trang HubSpot trả 404, trang tài liệu Pancake hết hạn chứng chỉ, trang Odoo chỉ đọc được một phần) nên đã dùng kết quả tìm kiếm thay; các ô "chưa xác nhận" cần xem kỹ hơn trước khi ai đó dựa vào.
