# So sánh Ludy với MISA AMIS, Base.vn, HubSpot và Odoo: tóm tắt cho JOY

Xong (bản nháp để anh xem). Viết ngày 2026-11-04. Bản đầy đủ bằng tiếng Anh, có bảng chi tiết và nguồn, là bản chính: [competitors.md](competitors.md). Trang này chỉ là bản đồ thị trường, chưa quyết định hay xây gì. Theo AGENTS.md, không mở issue và không xây gì cho các chỗ thiếu bên dưới cho đến khi anh đồng ý.

## Bốn đối thủ là ai

- **MISA AMIS:** dẫn đầu thị trường phần mềm kế toán Việt Nam, bán thành bộ hơn 25 phân hệ: kế toán (cả hộ kinh doanh và hợp tác xã), hóa đơn điện tử, thuế, ngân hàng, CRM, nhân sự và tiền lương, văn phòng số, mua hàng, kho, sản xuất. Mạnh nhất ở luật Việt Nam. Không mã nguồn mở. Bảng giá chia ba gói theo quy mô, trả tối thiểu 12 tháng.
- **Base.vn:** bộ 69 ứng dụng, mạnh về công việc, nhân sự, bán hàng, giao tiếp. Cả nhóm Tài chính (Kế toán, Hóa đơn, Bankfeed...) vẫn ghi "Coming soon", tức là chưa có kế toán. Giá tính theo tài khoản mỗi tháng, công khai.
- **HubSpot:** nền tảng khách hàng của Mỹ (Marketing, Sales, Service, Content, Data, Revenue) có các tác tử AI. Không có kế toán hay sổ cái. Có bản miễn phí, các gói trả phí theo từng hub, AI tính bằng "credits".
- **Odoo:** bộ phần mềm mã nguồn mở, khoảng 60 ứng dụng, giống Ludy nhất về cách xây (một nền tảng, một cơ sở dữ liệu, cài thêm ứng dụng). Có mô-đun kế toán Việt Nam và kết nối hóa đơn điện tử Viettel S-Invoice. Giá theo người dùng mỗi tháng; bản Community miễn phí.

## Bảng tóm tắt (đã rút gọn)

Trạng thái của Ludy: **đã có** (trên nhánh main), **đang xây** (có kế hoạch và issue mở), **mới lên kế hoạch** (chỉ có trong kế hoạch hoặc ADR), **chưa có**.

| Mảng | Ludy | Ai đang mạnh |
|---|---|---|
| Kế toán TT133, hóa đơn mua vào đọc bằng AI, tờ khai VAT, báo cáo tài chính, tài sản cố định, đối chiếu ngân hàng | Đã có | MISA AMIS (đầy đủ hơn), Odoo (một phần) |
| Phát hành hóa đơn bán ra | Đang xây | MISA AMIS, Odoo (qua Viettel) |
| Lấy sao kê ngân hàng tự động | Đang xây | MISA AMIS |
| Sổ sách hộ kinh doanh | Đang xây | MISA AMIS |
| Khách hàng, cơ hội bán, bảng pipeline, trang đặt lịch | Đã có | Cả bốn |
| Đăng bài mạng xã hội, xem quảng cáo | Đã có | HubSpot, Odoo |
| Chạy quảng cáo ngay trong Ludy | Đang xây | HubSpot |
| Hộp thư chung (Zalo OA, Facebook, Messenger) | Đang xây (Zalo OA đã có) | HubSpot |
| Email marketing | Mới lên kế hoạch (epic đang ở Icebox) | HubSpot, Odoo, MISA |
| Dự án, bảng công việc | Đang xây | Base, MISA, Odoo |
| Ghi chú và việc cần làm cá nhân | Đã có | Cả bốn |
| Ghi chú cuộc họp bằng AI | Đang xây | Base |
| Lương, BHXH, thuế TNCN, nhân sự, chấm công | Đang xây (sẽ thành app Ludy Nhân sự) | MISA AMIS, Base |
| Kho, giá vốn, đơn hàng Shopee, TikTok Shop, Lazada | Đang xây | MISA AMIS, Base, Odoo |
| Ký điện tử | Mới lên kế hoạch | MISA, Base, Odoo |
| Mua hàng, sản xuất, POS, tuyển dụng, OKR, chat nội bộ | Chưa có | MISA, Base, Odoo |
| Mã nguồn mở, tự cài | Đã có | Chỉ Odoo Community |
| AI nằm trong từng quy trình, con người duyệt, có hạn mức chi tiêu AI | Đã có phần lớn (Vy, Ly, Dy, Uy) | HubSpot (có AI nhưng tính tiền theo credits), MISA (AVA, OneAI) |

## Ludy khác ở đâu

1. **Trợ lý AI nằm trong từng việc, kết quả AI luôn là đề xuất, người duyệt** (đã có phần lớn; Vy riêng cho từng thành viên mới là đề xuất, ADR-0049).
2. **Mã nguồn mở, tự cài bằng `docker compose up`** (đã có). Trong bốn đối thủ chỉ Odoo Community mở. Ludy Cloud "sắp ra mắt".
3. **Đặc thù Việt Nam:** TT133, hóa đơn điện tử XML, tờ khai VAT và HTKK, đối chiếu ngân hàng (đã có); phát hành hóa đơn bán ra, bank feed, hộ kinh doanh, lương và BHXH, kho (đang xây). MISA AMIS đã phủ rộng hơn Ludy (chữ ký số, nộp thuế, kiểm toán, vay vốn), nên lợi thế của Ludy là AI đọc chứng từ và mã nguồn mở, không phải độ phủ.
4. **Một đường ghi dữ liệu, có duyệt, nhật ký không sửa được, cô lập từng tổ chức** (đã có). Bốn đối thủ không công bố điều tương đương trên các trang đã đọc, nên bảng ghi "chưa xác nhận" chứ không ghi "không có".
5. **Điểm yếu thẳng thắn:** độ phủ. MISA có hơn 25 phân hệ, Base 69 ứng dụng, Odoo khoảng 60; Ludy mới có 3 app trên main (Kế toán, Engage, Notes) và vài app đang xây.

## Danh sách còn thiếu (đề xuất, anh quyết)

Đây là thứ đối thủ có mà Ludy chưa có, chưa lên kế hoạch, chưa có issue. Mức ưu tiên là gợi ý của tôi cho OPC và SME, AI-first. Chưa xây gì cho đến khi anh đồng ý.

| Chỗ thiếu | Giá trị cho SME | Gợi ý |
|---|---|---|
| Báo giá và đơn bán hàng từ cơ hội | Người bán nào cũng báo giá mỗi tuần; hiện cơ hội dừng ở chỗ trước hóa đơn. AI có thể soạn báo giá từ tin nhắn | Cao |
| Đơn mua hàng và danh sách nhà cung cấp | Đi cùng kho và hóa đơn mua vào | Trung bình |
| Thanh toán chi phí, tạm ứng | Đội 5 đến 20 người hay tự ứng tiền; AI đọc biên lai và đề xuất bút toán | Trung bình |
| Link thanh toán, thu tiền định kỳ | Thu tiền nhanh hơn; cần đối tác thanh toán và anh duyệt chi tiêu | Trung bình |
| Tin nhắn SMS, WhatsApp, Zalo thông báo | Tiếp cận khách không đọc email; cần hợp đồng nhà cung cấp | Trung bình |
| Website, landing page, biểu mẫu thu khách | Nhiều người dùng trang Facebook và Zalo OA thay thế | Thấp |
| Live chat và chatbot trên website | Phụ thuộc có website | Thấp |
| Cổng khách hàng, kho kiến thức | Anh đã quyết không làm ticket và SLA | Thấp |
| Chat nội bộ, bảng tin công ty | Đội nhỏ đã dùng nhóm Zalo; khó thắng | Thấp |
| Tuyển dụng | Đội nhỏ ít tuyển | Thấp |
| Mục tiêu OKR, đánh giá nhân sự | Hợp với công ty lớn hơn | Thấp |
| Trình tạo quy trình tự động | Các AI đã tự làm trong từng app; thêm trình tạo là thêm cấu hình | Thấp |
| POS bán lẻ và nhà hàng | Sản phẩm khác, MISA đã chiếm | Thấp |
| Sản xuất, bảo trì, đội xe | Thiên về doanh nghiệp lớn, ngoài cổng sàng lọc | Thấp |
| Sổ sách hợp tác xã | Thị trường hẹp | Thấp |
| Chữ ký số (CA), nộp thuế trực tiếp, kiểm toán, vay vốn | Cần giấy phép hoặc hợp đồng đối tác; ký điện tử đã có kế hoạch | Thấp |
| Gói theo ngành | Để sau khi các app lõi chạy | Thấp |
| Chợ ứng dụng và API công khai | Cần khi có đối tác muốn tích hợp; máy chủ OAuth mới ở mức đề xuất | Thấp |
| Công cụ tự dựng AI hoặc ứng dụng | Không dành cho OPC; các trợ lý có tên mới là sản phẩm | Thấp |

Nhận xét ngắn: Base.vn chưa có kế toán và HubSpot không có sổ cái, nên về kế toán chỉ MISA AMIS và Odoo cạnh tranh trực tiếp với Ludy Kế toán, và chỉ MISA AMIS có đủ chuỗi thuế Việt Nam đang chạy. Chỗ trống rộng nhất là kế toán và chăm sóc khách hàng cho doanh nghiệp nhỏ nhất, làm bằng AI. Thiếu sót dễ làm khách trả tiền chùn chân nhất là báo giá, và với người bán hàng hóa là kho và mua hàng.

Giới hạn: bảng chỉ đọc danh sách sản phẩm trên trang của mỗi hãng, không đo độ sâu tính năng. Trang Odoo đọc qua bản tóm tắt vì trình duyệt tích hợp không mở được. Mục ghi "chưa xác nhận" cần xem kỹ trước khi dựa vào. Nguồn và ngày đọc nằm ở cuối [bản tiếng Anh](competitors.md).
