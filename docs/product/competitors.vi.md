# So sánh Ludy với MISA AMIS, Base.vn, HubSpot, Odoo và Pancake: tóm tắt cho JOY

Xong (bản nháp để anh xem). Viết ngày 2026-11-04, đã thêm Pancake theo yêu cầu của anh. Bản đầy đủ bằng tiếng Anh, có bảng chi tiết và nguồn, là bản chính: [competitors.md](competitors.md). Trang này chỉ là bản đồ thị trường, chưa quyết định hay xây gì. Theo AGENTS.md, không mở issue và không xây gì cho các chỗ thiếu bên dưới cho đến khi anh đồng ý.

## Năm đối thủ là ai

- **MISA AMIS:** dẫn đầu thị trường phần mềm kế toán Việt Nam, bán thành bộ hơn 25 phân hệ: kế toán (cả hộ kinh doanh và hợp tác xã), hóa đơn điện tử, thuế, ngân hàng, CRM, nhân sự và tiền lương, văn phòng số, mua hàng, kho, sản xuất. Mạnh nhất ở luật Việt Nam. Không mã nguồn mở. Bảng giá chia ba gói theo quy mô, trả tối thiểu 12 tháng.
- **Base.vn:** bộ 69 ứng dụng, mạnh về công việc, nhân sự, bán hàng, giao tiếp. Cả nhóm Tài chính (Kế toán, Hóa đơn, Bankfeed...) vẫn ghi "Coming soon", tức là chưa có kế toán. Giá tính theo tài khoản mỗi tháng, công khai.
- **HubSpot:** nền tảng khách hàng của Mỹ (Marketing, Sales, Service, Content, Data, Revenue) có các tác tử AI. Không có kế toán hay sổ cái. Có bản miễn phí, các gói trả phí theo từng hub, AI tính bằng "credits".
- **Odoo:** bộ phần mềm mã nguồn mở, khoảng 60 ứng dụng, giống Ludy nhất về cách xây (một nền tảng, một cơ sở dữ liệu, cài thêm ứng dụng). Có mô-đun kế toán Việt Nam và kết nối hóa đơn điện tử Viettel S-Invoice. Giá theo người dùng mỗi tháng; bản Community miễn phí.
- **Pancake:** nền tảng bán hàng qua chat của Việt Nam (hãng nói có hơn 260.000 doanh nghiệp). Là một họ ứng dụng dùng chung một tài khoản:
  - **Pancake:** một hộp thư cho tin nhắn và bình luận từ mạng xã hội, Zalo, TikTok, WhatsApp, sàn thương mại điện tử; tạo đơn ngay trong chat.
  - **Pancake POS:** đơn đa kênh, tồn kho thời gian thực, nối đơn vị vận chuyển, mã QR thanh toán mỗi đơn, ghi âm cuộc gọi.
  - **Pancake CRM, Botcake** (chatbot AI và nhắn tin hàng loạt), **Webcake** (landing page và website bán hàng), **Pancake Work** (chat nội bộ, bảng công việc, chấm công).
  - **Fintab:** kế toán đơn giản và kê khai thuế 2026 cho hộ kinh doanh. Cùng dịch vụ WhatsApp.
  - Không thấy lương, phát hành hóa đơn điện tử, đọc hóa đơn mua vào hay đăng bài mạng xã hội trên các trang đã đọc. Giá theo số trang kết nối và số nhân viên, dùng thử 14 ngày; gói nhỏ nhất ghi từ 550.000 đ cho 6 tháng. Không mã nguồn mở.

## Pancake chồng lấn với Ludy ở đâu

- **Hộp thư (Engage, Dy):** đây là sản phẩm lõi của Pancake, và Ludy đang xây việc tương tự. Pancake hơn về số kênh; khác biệt của Ludy là bản nháp trả lời do AI soạn và người duyệt.
- **Đăng bài và quảng cáo:** ít chồng lấn. Pancake không đăng bài, chỉ gửi sự kiện chuyển đổi cho Meta và Google. Ludy đăng bài rồi và đang xây việc tạo quảng cáo.
- **Đơn hàng và kho:** chồng lấn lớn nhất và là sân mạnh nhất của Pancake (đơn tạo ngay trong chat, đơn từ sàn, tồn kho, vận chuyển). Ludy chưa có đơn hàng nào; kế hoạch kho của Ludy (đang xây) bắt đầu từ hóa đơn và file báo cáo của sàn, không từ đơn trong chat, và chưa có nối đơn vị vận chuyển.
- **Sổ sách hộ kinh doanh:** Fintab nhắm cùng nhóm khách với kế hoạch hộ kinh doanh của Ludy. Ludy khác ở chỗ đọc chứng từ bằng AI và giữ sổ cái đầy đủ.
- **Việc nội bộ:** Pancake Work chồng lấn với kế hoạch dự án và chấm công của Ludy; chat nội bộ thì Ludy không có kế hoạch.

## Bảng tóm tắt (đã rút gọn)

Trạng thái của Ludy: **đã có** (trên nhánh main), **đang xây** (có kế hoạch và issue mở), **mới lên kế hoạch** (chỉ có trong kế hoạch hoặc ADR), **chưa có**.

| Mảng | Ludy | Ai đang mạnh |
|---|---|---|
| Kế toán TT133, hóa đơn mua vào đọc bằng AI, tờ khai VAT, báo cáo tài chính, tài sản cố định, đối chiếu ngân hàng | Đã có | MISA AMIS (đầy đủ hơn), Odoo (một phần) |
| Phát hành hóa đơn bán ra | Đang xây | MISA AMIS, Odoo (qua Viettel) |
| Lấy sao kê ngân hàng tự động | Đang xây | MISA AMIS |
| Sổ sách hộ kinh doanh | Đang xây | MISA AMIS, Pancake Fintab |
| Khách hàng, cơ hội bán, bảng pipeline, trang đặt lịch | Đã có | Cả năm |
| Đăng bài mạng xã hội, xem quảng cáo | Đã có | HubSpot, Odoo |
| Chạy quảng cáo ngay trong Ludy | Đang xây | HubSpot |
| Hộp thư chung (Zalo OA, Facebook, Messenger) | Đang xây (Zalo OA đã có) | Pancake (mạnh nhất), HubSpot |
| Email marketing | Mới lên kế hoạch (epic đang ở Icebox) | HubSpot, Odoo, MISA |
| Dự án, bảng công việc | Đang xây | Base, MISA, Odoo, Pancake Work |
| Ghi chú và việc cần làm cá nhân | Đã có | Hầu hết (Pancake chỉ có công việc, chưa thấy ghi chú) |
| Ghi chú cuộc họp bằng AI | Đang xây | Base |
| Lương, BHXH, thuế TNCN, nhân sự, chấm công | Đang xây (sẽ thành app Ludy Nhân sự) | MISA AMIS, Base |
| Kho, giá vốn, đơn hàng Shopee, TikTok Shop, Lazada | Đang xây | MISA AMIS, Base, Odoo, Pancake POS |
| Đơn tạo ngay trong chat, nối đơn vị vận chuyển, nhắn hàng loạt cho khách | Chưa có | Pancake (mạnh nhất) |
| Landing page, website bán hàng | Chưa có | Pancake (Webcake), HubSpot, Odoo |
| Chatbot AI trả lời khách không cần người | Chưa có (và đang trái quy tắc người duyệt mọi tin nhắn gửi đi) | Pancake (Botcake), HubSpot |
| Ký điện tử | Mới lên kế hoạch | MISA, Base, Odoo |
| Mua hàng, sản xuất, POS, tuyển dụng, OKR, chat nội bộ | Chưa có | MISA, Base, Odoo, Pancake (POS, chat nội bộ) |
| Mã nguồn mở, tự cài | Đã có | Chỉ Odoo Community |
| AI nằm trong từng quy trình, con người duyệt, có hạn mức chi tiêu AI | Đã có phần lớn (Vy, Ly, Dy, Uy) | HubSpot (có AI nhưng tính tiền theo credits), MISA (AVA, OneAI), Pancake (Botcake) |

## Ludy khác ở đâu

1. **Trợ lý AI nằm trong từng việc, kết quả AI luôn là đề xuất, người duyệt** (đã có phần lớn; Vy riêng cho từng thành viên mới là đề xuất, ADR-0049).
2. **Mã nguồn mở, tự cài bằng `docker compose up`** (đã có). Trong năm đối thủ chỉ Odoo Community mở. Ludy Cloud "sắp ra mắt".
3. **Đặc thù Việt Nam:** TT133, hóa đơn điện tử XML, tờ khai VAT và HTKK, đối chiếu ngân hàng (đã có); phát hành hóa đơn bán ra, bank feed, hộ kinh doanh, lương và BHXH, kho (đang xây). MISA AMIS đã phủ rộng hơn Ludy (chữ ký số, nộp thuế, kiểm toán, vay vốn), nên lợi thế của Ludy là AI đọc chứng từ và mã nguồn mở, không phải độ phủ.
4. **Một đường ghi dữ liệu, có duyệt, nhật ký không sửa được, cô lập từng tổ chức** (đã có). Năm đối thủ không công bố điều tương đương trên các trang đã đọc, nên bảng ghi "chưa xác nhận" chứ không ghi "không có".
5. **Điểm yếu thẳng thắn:** độ phủ. MISA có hơn 25 phân hệ, Base 69 ứng dụng, Odoo khoảng 60; Ludy mới có 3 app trên main (Kế toán, Engage, Notes) và vài app đang xây.

## Danh sách còn thiếu (đề xuất, anh quyết)

Đây là thứ đối thủ có mà Ludy chưa có, chưa lên kế hoạch, chưa có issue. Mức ưu tiên là gợi ý của tôi cho OPC và SME, AI-first. Chưa xây gì cho đến khi anh đồng ý. Cột cuối ghi rõ chỗ nào Pancake làm mức ưu tiên thay đổi.

| Chỗ thiếu | Giá trị cho SME | Gợi ý |
|---|---|---|
| Báo giá và đơn bán hàng từ cơ hội | Người bán nào cũng báo giá mỗi tuần; hiện cơ hội dừng ở chỗ trước hóa đơn. AI có thể soạn báo giá từ tin nhắn | Cao (giữ nguyên) |
| Đơn tạo ngay trong chat | Cách nhiều người bán nhỏ ở Việt Nam bán thật: khách nhắn Messenger hoặc Zalo rồi nhân viên gõ đơn vào bảng tính. Dy có thể đề xuất đơn từ cuộc trò chuyện, người duyệt. Cần có đối tượng "đơn hàng" ở dòng trên | Cao (mới, vì Pancake) |
| Nối đơn vị vận chuyển, theo dõi giao hàng | Có đơn rồi thì người bán hàng hóa cần tạo vận đơn, theo dõi trạng thái, ghi phí ship. Mỗi bên vận chuyển là một hợp đồng đối tác | Trung bình (mới, vì Pancake) |
| Nhắn hàng loạt cho khách đã đồng ý (Zalo, Messenger, WhatsApp, SMS) | Nhắn lại khách cũ là công cụ bán hàng chính của người bán qua mạng xã hội. Giới hạn của nền tảng và quy định về sự đồng ý của khách; người duyệt từng lần gửi | Cao (trước là Trung bình, vì Pancake) |
| Chatbot trả lời và nhận đơn không cần người | Trả lời ngoài giờ giúp bán nhiều hơn, nhưng trái quy tắc hiện nay là người duyệt mọi tin gửi đi. Cần anh quyết trước khi lên kế hoạch, ví dụ bot chỉ trả lời nội dung cố định (giờ mở cửa, giá, còn hàng) | Trung bình (mới, cần anh quyết) |
| Website, landing page, biểu mẫu thu khách | Landing page là nơi khách bấm quảng cáo Facebook vào. Ludy đang xây việc tạo quảng cáo nên thiếu trang đích là thiếu nửa đường. Nên làm trang một màn hình, không làm website đầy đủ | Trung bình (trước là Thấp, vì Pancake và việc quảng cáo của Ludy) |
| Live chat trên website | Phụ thuộc có website; Zalo OA và Messenger đã đủ cho phần lớn người bán nhỏ | Thấp (giữ nguyên) |
| Gọi điện có ghi âm, gắn với đơn hoặc cơ hội | Telesales phổ biến trong bán lẻ nhưng cần hợp đồng tổng đài | Thấp (mới) |
| Đơn mua hàng và danh sách nhà cung cấp | Đi cùng kho và hóa đơn mua vào | Trung bình |
| Thanh toán chi phí, tạm ứng | Đội 5 đến 20 người hay tự ứng tiền; AI đọc biên lai và đề xuất bút toán | Trung bình |
| Link thanh toán, mã QR mỗi đơn, thu tiền định kỳ | Thu tiền nhanh hơn; cần đối tác thanh toán và anh duyệt chi tiêu. Mã QR mỗi đơn là lát cắt nhỏ, có ích | Trung bình (giữ nguyên) |
| Cổng khách hàng, kho kiến thức | Anh đã quyết không làm ticket và SLA | Thấp |
| Chat nội bộ, bảng tin công ty | Đội nhỏ đã dùng nhóm Zalo; khó thắng | Thấp |
| Tuyển dụng | Đội nhỏ ít tuyển | Thấp |
| Mục tiêu OKR, đánh giá nhân sự | Hợp với công ty lớn hơn | Thấp |
| Trình tạo quy trình tự động | Các AI đã tự làm trong từng app; thêm trình tạo là thêm cấu hình | Thấp |
| POS bán tại quầy và nhà hàng | Khác với đơn online: quầy thu tiền, biên lai, ca làm. MISA, Odoo, Pancake đã chiếm | Thấp |
| Sản xuất, bảo trì, đội xe | Thiên về doanh nghiệp lớn, ngoài cổng sàng lọc | Thấp |
| Sổ sách hợp tác xã | Thị trường hẹp | Thấp |
| Chữ ký số (CA), nộp thuế trực tiếp, kiểm toán, vay vốn | Cần giấy phép hoặc hợp đồng đối tác; ký điện tử đã có kế hoạch | Thấp |
| Gói theo ngành | Để sau khi các app lõi chạy | Thấp |
| Chợ ứng dụng và API công khai | Cần khi có đối tác muốn tích hợp; máy chủ OAuth mới ở mức đề xuất | Thấp |
| Công cụ tự dựng AI hoặc ứng dụng | Không dành cho OPC; các trợ lý có tên mới là sản phẩm | Thấp |

Vì sao Pancake đổi thứ tự: với người bán nhỏ ở Việt Nam, cuộc trò chuyện là nơi chốt đơn, nên đơn hàng, vận chuyển và nhắn hàng loạt nằm ngay cạnh hộp thư. Hộp thư của Ludy đang xây, nên thứ người bán sẽ đòi tiếp theo là đơn hàng. Pancake không có lương, hóa đơn điện tử hay sổ cái đầy đủ, nên không đổi thứ tự phần kế toán.

## Báo giá và đơn hàng thuộc về đâu

Chúng thuộc CRM (nhóm Khách hàng và Bán hàng của Engage): cơ hội dẫn đến báo giá, báo giá dẫn đến đơn hàng. Đơn hàng sau đó nối với hai thứ: lần xuất kho (kế hoạch kho) và bản nháp hóa đơn bán ra (kế hoạch phát hành hóa đơn), để một đơn đã xác nhận chạy cả hai và không ai gõ lại. Dịch vụ không có hàng thì bỏ nối kho, đi thẳng từ báo giá sang bản nháp hóa đơn. App POS riêng là việc khác: dành cho bán tại quầy, không dành cho đơn bắt đầu từ cơ hội hay từ chat. Nếu sau này cần POS thì nó nên tạo cùng một đối tượng đơn hàng, không tạo cái thứ hai.

## Nhận xét ngắn

Base.vn chưa có kế toán và HubSpot không có sổ cái; Pancake chỉ có Fintab cho hộ kinh doanh. Nên về kế toán chỉ MISA AMIS và Odoo cạnh tranh trực tiếp toàn diện với Ludy Kế toán, và chỉ MISA AMIS có đủ chuỗi thuế Việt Nam đang chạy. Chỗ trống rộng nhất là kế toán và chăm sóc khách hàng cho doanh nghiệp nhỏ nhất, làm bằng AI. Thiếu sót dễ làm khách trả tiền chùn chân nhất là báo giá và đơn hàng, và với người bán hàng hóa là kho, mua hàng và vận chuyển.

Giới hạn: bảng chỉ đọc danh sách sản phẩm trên trang của mỗi hãng, không đo độ sâu tính năng. Trang Odoo đọc qua bản tóm tắt vì trình duyệt tích hợp không mở được. Giá của Fintab, Botcake và Webcake chưa đọc. Mục ghi "chưa xác nhận" cần xem kỹ trước khi dựa vào. Nguồn và ngày đọc nằm ở cuối [bản tiếng Anh](competitors.md).
