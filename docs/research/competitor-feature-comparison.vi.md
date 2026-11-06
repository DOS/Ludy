# So sánh tính năng: Ludy với MISA, Fast và Odoo (bản tóm tắt cho chủ sở hữu)

Trạng thái: xong phần nghiên cứu, ngày 2026-11-06, theo yêu cầu của chủ sở hữu (JOY). Đây là tài liệu nghiên cứu, không có mã và không cam kết lộ trình nào. Bản tiếng Anh đầy đủ (có từng nguồn, từng đường dẫn mã) là [competitor-feature-comparison.md](competitor-feature-comparison.md); bản này đứng riêng được, không cần đọc bản kia. Bản đồ thị trường rộng hơn (6 sản phẩm, có CRM và marketing) nằm ở [competitors.vi.md](../product/competitors.vi.md).

## 1. Cách đọc

- **Cột Ludy** chỉ lấy từ kho mã nguồn (commit `b473ad3`, đầu nhánh `main` ngày 2026-11-06): mã, màn hình, chuỗi giao diện, PR đã gộp, kế hoạch và ADR (quyết định kiến trúc). Không dùng lời quảng cáo.
- **Cột MISA, Fast, Odoo** chỉ lấy từ trang và tài liệu chính thức của hãng, đọc ngày 2026-11-06. Điều gì không có trang chính thức xác nhận thì ghi **Chưa xác minh**.
- Giá trị trong ô: **Có**; **Không**; **Đang làm #số** (chỉ cho Ludy, kèm số issue); **Thêm phí** (bán thêm tiền, hoặc là sản phẩm riêng của cùng hãng); **Chưa xác minh**.
- Thuật ngữ: *HTKK* là phần mềm kê khai thuế của Tổng cục Thuế; *TT133, TT200, TT99* là các chế độ kế toán (TT99 thay TT200 từ 2026-01-01); *PIT* là thuế thu nhập cá nhân (TNCN); *môi trường thử (sandbox)* là bản giả chạy ngoại tuyến, không nối ra nhà cung cấp thật; *Enterprise (suy ra)* nghĩa là Odoo không ghi rõ, nhưng tính năng nằm trong ứng dụng Kế toán và không có trong mã Community công khai.

## 2. Điều quan trọng nhất

1. **Ludy chưa phát hành được hóa đơn điện tử thật và chưa đọc được sao kê ngân hàng trực tiếp.** Mã đã xây xong nhưng nhà cung cấp duy nhất trong kho là bản thử ngoại tuyến, và bản chạy công khai từ chối bật nó. Cả ba đối thủ đều phát hành hóa đơn điện tử được (Odoo chỉ qua Viettel). Đây là khoảng cách lớn nhất với một kế toán đang làm việc.
2. **Ludy là sản phẩm duy nhất mở mã nguồn và tự cài được toàn bộ phần kế toán.** MISA chỉ chạy trên đám mây hoặc cài trên máy. Fast không mở mã (bản máy tính và bản ERP khách tự cài được). Odoo Community mở mã, nhưng ứng dụng Kế toán, nối ngân hàng, tài sản cố định, nhắc nợ, tính lương và AI không có trong mã Community (Enterprise, suy ra).
3. **Cách duyệt của Ludy chặt hơn MISA.** Mọi kết quả AI đều chưa tin cậy; kiểm tra bằng quy tắc quyết định, và người duyệt mọi việc ghi sổ, gửi tin, chi tiền. MISA mô tả tự hạch toán hóa đơn đầu vào mà không nêu bước duyệt. AI của Fast trong bản online chỉ là trợ lý hướng dẫn.
4. **TT133:** Odoo không có gói chính thức (chỉ có bản TT200 đã chuyển sang khung TT99). Ludy có báo cáo TT133 nhưng còn gắn nhãn "bản nháp" đến khi kế toán xác nhận (issue #154).
5. **Tính lương, bảo hiểm xã hội, thuế TNCN, nhân sự:** MISA có; Fast bán riêng; Odoo không có tính lương cho Việt Nam; Ludy đang xây thành một ứng dụng riêng (bộ tính toán đã gộp, phần còn lại còn mở).
6. **Xuất tờ khai cho HTKK:** lời của cả bốn bên đều mỏng. Ludy xuất bản nháp 01/GTGT chưa được kế toán kiểm (#332). Trang trợ giúp của MISA chỉ nói cổng thuế. Odoo có XML 01/GTGT từ bản 19.4 và 20.
7. **Giá:** Ludy tự cài không mất tiền bản quyền; chưa có giá Ludy Cloud. Doanh nghiệp nhỏ trả MISA khoảng 2,5 đến 3,7 triệu đồng một năm cho AMIS Kế toán gói Starter (chưa gồm hóa đơn, lương, CRM), Fast khoảng 1,75 triệu đồng một năm cho mỗi người dùng bản online, Odoo 9 đến 20 đô la Mỹ mỗi người mỗi tháng cho Enterprise.

## 3. Bảng so sánh

Số trong ngoặc như `#2503` là issue hoặc PR của Ludy. Nguồn chi tiết của từng ô nằm ở bản tiếng Anh.

### 3.1 Chứng từ và hóa đơn

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Hóa đơn vào: tệp XML | **Có.** Đọc bằng quy tắc, không dùng AI, kiểm chữ ký người bán và cơ quan thuế; người duyệt mới ghi sổ | **Chưa xác minh** | **Thêm phí** (mô-đun quản lý hóa đơn đầu vào) | **Chưa xác minh** |
| Hóa đơn vào: PDF và ảnh | **Có, có giới hạn.** Dùng mô hình AI do bên vận hành cấu hình; không có OCR riêng; PDF dạng ảnh quét bị từ chối | **Chưa xác minh** (chỉ thấy nhập tay) | **Chưa xác minh** | **Thêm phí** (mua điểm dùng; Enterprise, suy ra) |
| Hóa đơn vào: hộp thư | **Có, cần thiết lập.** Mỗi tổ chức có một địa chỉ riêng để chuyển tiếp thư; chưa kéo thư từ hộp thư | **Thêm phí** (cần dịch vụ meInvoice) | **Thêm phí** | **Có** (địa chỉ thư theo sổ nhật ký; chưa rõ bản nào) |
| Hóa đơn vào: đồng bộ cổng thuế | **Có, có giới hạn.** Có người hỗ trợ (gõ mật khẩu, giải CAPTCHA), mặc định tắt, người xây chưa chạy trên cổng thật; lần chạy thử có giám sát còn mở (#1100) | **Thêm phí** (qua meInvoice) | **Thêm phí** | **Chưa xác minh** |
| Hóa đơn bán ra | **Đang làm #2503, #2509.** Luồng lập, duyệt, phát hành, hỏi trạng thái, lưu XML đã ký và ghi sổ bán hàng đã xây (#2502), nhưng nhà cung cấp duy nhất là bản thử; MISA meInvoice #2503, Viettel #2509 | **Thêm phí** (meInvoice, bán theo gói hóa đơn) | **Thêm phí** (Fast e-Invoice, tích hợp với phần mềm Fast miễn phí) | **Có** (chỉ Viettel S-Invoice; nhà khác chỉ qua mô-đun bên thứ ba trả phí) |

### 3.2 Ngân hàng và công nợ

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Nhập sao kê từ tệp | **Có.** Excel và CSV, tự nhận cột nên ngân hàng nào cũng nhập được; chưa có MT940, OFX | **Có** | **Có** (chỉ mẫu Excel) | **Chưa xác minh** (chưa rõ bản nào) |
| Nối ngân hàng trực tiếp | **Đang làm #2045.** Cổng, ánh xạ tài khoản, webhook ký đã xây; bộ nối Tingee còn mở; chưa nối ngân hàng thật | **Có** (11 ngân hàng đầy đủ, khoảng 11 ngân hàng chỉ báo biến động số dư) | **Thêm phí** (OCB, BIDV, TPBank, MBBank) | **Có** (chỉ Enterprise; chưa thấy ngân hàng Việt Nam được nêu: Chưa xác minh) |
| Đối chiếu | **Có.** Xếp hạng bằng quy tắc, nhóm các dòng sạch để duyệt hàng loạt, hoàn tác bằng bút toán đảo; không dùng AI | **Có** (kèm trợ lý AVA) | **Có** | **Có** (Enterprise, suy ra) |
| Công nợ phải thu, nhắc nợ | **Có.** Danh sách quá hạn, thư nhắc soạn từ mẫu, AI chỉ viết câu mở đầu và kết, **người bấm gửi**; không tự gửi | **Có** (tự gửi thư nhắc; điều kiện gói chưa rõ) | **Chưa xác minh** (nhắc nợ bằng AI chỉ có ở Fast Business Online) | **Có** (Enterprise, suy ra; qua thư, WhatsApp, SMS) |

### 3.3 Thuế, báo cáo, sổ sách

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Xuất tờ khai GTGT cho HTKK | **Có, bản nháp.** Chỉ mẫu 01/GTGT; các chỉ tiêu cần phán đoán để 0; chưa kiểm trên HTKK hay eTax (#332 còn mở); Ludy không nộp thay | **Chưa xác minh** (trang trợ giúp chỉ nói cổng thuế) | **Có** (lời của hãng) | **Có** nhưng chỉ từ bản 19.4 và 20 |
| Thuế TNCN | **Đang làm #2533** (và #2518 cho hộ kinh doanh); mới có bộ tính, chưa có tờ khai | **Có** (quyết toán 05/QTT-TNCN) | **Có** ở Fast Accounting; bản online: Chưa xác minh | **Chưa xác minh** (không thấy) |
| Báo cáo tài chính | TT133: **Có, bản nháp** (B01, B02, XML cho HTKK; chưa có lưu chuyển tiền tệ; #154, #920). TT99: **Đang làm #1403**. TT200: **Không** | TT99: **Có**. TT200: **Có** (dữ liệu cũ). TT133: **Có** ở MISA SME; AMIS Kế toán: Chưa xác minh | TT99: **Có**. TT133: **Có**. TT200 được TT99 thay | Khung tài khoản TT99: **Có**. TT133: **Không** có gói chính thức (có bản bên thứ ba trả phí) |
| Sổ sách cơ bản | **Có:** số dư đầu kỳ, khóa kỳ theo tháng, tài sản cố định và phân bổ chi phí trả trước, kết chuyển cuối năm | **Có** cả bốn (tài sản cố định từ gói Professional) | **Có** cả bốn | Khóa kỳ **Có**; tài sản cố định **Có** (Enterprise, suy ra); chi phí trả trước **Có** (chưa rõ bản); số dư đầu kỳ **Chưa xác minh** |

### 3.4 Kho và sàn thương mại điện tử

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Kho và đơn hàng sàn | **Có, qua tệp.** Hàng hóa, nhập xuất tồn tạm tính, thẻ kho; đơn Shopee, TikTok Shop, Lazada nhập từ tệp báo cáo. **Đang làm #2519** (nối trực tiếp) và **#2513** (chốt tháng, giá vốn) | **Có** (Shopee, TikTok Shop nối trực tiếp; Lazada chỉ qua AMIS CRM) | **Có** (Shopee, TikTok, Lazada; giá Chưa xác minh) | **Có** (kho trong Community; có bộ nối chính thức cho cả ba sàn; chưa rõ bản) |

### 3.5 Nhân sự và bán hàng

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Lương, bảo hiểm xã hội, TNCN | **Đang làm #2531.** Mới gộp bộ tính và bảng quy tắc (#2529); chưa quy tắc nào được kế toán xác nhận (#2535); ứng dụng riêng | **Có** (gói cơ bản trong Professional; ứng dụng AMIS Tiền lương là **Thêm phí**, 5,1 triệu đồng một năm) | **Thêm phí** (Fast HRM Online, sản phẩm riêng) | **Không** cho Việt Nam |
| Nhân sự | **Đang làm #2530** (hồ sơ nhân viên; nghỉ phép #2540); chưa có mã | **Thêm phí** (AMIS Nhân sự) | **Thêm phí** (Fast HRM Online) | **Có** (Community; Appraisals là Enterprise, suy ra) |
| CRM và bán hàng | **Có.** Liên hệ, bảng cơ hội, đặt lịch, hộp thư Facebook, Instagram, Zalo, email; **chưa có báo giá và đơn bán hàng** | **Thêm phí** (AMIS CRM) | **Thêm phí** (Fast CRM Online) | **Có** (Community) |

### 3.6 Nền tảng

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| AI và việc duyệt | **Có.** Đọc hóa đơn, viết thư nhắc, giải thích tổng quan, bản tin đầu ngày; mỗi lời gọi tính vào ngân sách, có nút dừng AI; **người duyệt** mọi việc ghi sổ, gửi tin, chi tiền. Đồng nghiệp AI: Vy, Ly | **Có** (AVA). Ghi sổ ngân hàng có bước duyệt kèm mức tin cậy; ghi sổ hóa đơn vào không mô tả bước duyệt | **Có, hạn chế** (bản online: trợ lý hướng dẫn, không đổi dữ liệu; bước duyệt: Chưa xác minh) | **Thêm phí** (Enterprise, suy ra; mua điểm dùng); không có chính sách duyệt chính thức |
| Nhiều pháp nhân | **Có**, chưa có hợp nhất; việc mới về mảng này nằm trong Icebox | **Có** cho chi nhánh trong một công ty; công ty riêng, hợp nhất: Chưa xác minh | **Có** ở bản dành cho dịch vụ kế toán (cơ sở dữ liệu tách rời); hợp nhất chỉ ở Fast Business Online | **Có** (nhiều công ty; hợp nhất qua ánh xạ tài khoản) |
| Tự cài và mã nguồn mở | **Có.** AGPL-3.0, `docker compose up` chạy cả hệ thống, không cần dịch vụ của DOS | **Không** | **Không** mở mã (bản máy tính, ERP khách tự cài được) | **Có** (Community mở mã; Enterprise có thể tự cài; ứng dụng Kế toán không nằm trong Community) |
| Di động | **Có, chỉ web.** Ứng dụng web cài được (PWA), có thông báo đẩy; chưa có ứng dụng riêng (#65, #64 còn mở, ưu tiên thấp) | **Có** (nhiều ứng dụng) | **Không** có cho Fast Accounting Online (có cho hóa đơn, hộ kinh doanh, ERP) | **Có** (PWA) |
| Tích hợp và API | **Không** có API công khai, webhook gửi ra, máy chủ OAuth hay MCP (epic #68); có kết nối kênh (Facebook, Zalo, Google) | **Có** (API đẩy chứng từ vào; meInvoice có API mở) | **Có** (không thấy tài liệu cho lập trình viên) | **Có** (API JSON-2; truy cập API thuộc gói Custom trên Odoo Online) |

### 3.7 Giá công bố cho doanh nghiệp nhỏ

| Mục | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| Giá | Tự cài: không mất bản quyền (AGPL). Chưa có giá Ludy Cloud | AMIS Kế toán Starter 3 người: 3.650.000 đồng một năm (trang khác ghi 2.450.000 cho 1 người: mâu thuẫn); MISA SME Standard 6.150.000 một năm cho 3 người; tối thiểu 12 tháng; hóa đơn, lương, CRM tính thêm | Fast Accounting Online từ 1.100.000 đồng mỗi người cho 6 tháng, 1.750.000 cho một năm; bản máy tính 5.900.000 cộng 2.950.000 cài đặt | Community miễn phí; Odoo Online một ứng dụng 0 đô la; Enterprise 8,95 đến 20,40 đô la mỗi người mỗi tháng (trang không ghi rõ giá nào là theo tháng) |

## 4. Ludy dẫn ở đâu, tụt ở đâu, nên xây gì tiếp

Đề xuất chỉ nêu issue đã có trong kế hoạch. Cái gì mới thì ghi **chủ sở hữu quyết định**; tài liệu này không mở issue nào.

**Ludy dẫn:**
- Mã nguồn mở và tự cài toàn bộ phần kế toán (không đối thủ nào có).
- Cách duyệt chặt: người duyệt mọi việc ghi sổ, gửi tin, chi tiền; chi phí AI có đồng hồ đo và có nút dừng; lõi vẫn chạy khi tắt AI.
- Đọc hóa đơn XML bằng quy tắc và kiểm chữ ký trên máy (trang đối thủ đã đọc không mô tả việc này).
- Đối chiếu ngân hàng duyệt hàng loạt, có hoàn tác; thư nhắc nợ do người gửi.
- Có TT133 trong một sản phẩm mở, trong khi Odoo chưa có gói chính thức.

**Ludy tụt:**
- Chưa phát hành hóa đơn điện tử thật, chưa nối ngân hàng trực tiếp.
- Tính lương, bảo hiểm xã hội, thuế TNCN, nhân sự chưa dùng được.
- Chưa có báo cáo TT99, không có TT200.
- Báo cáo tài chính và tờ khai XML chưa được kế toán xác nhận.
- Chưa có ứng dụng di động riêng, chưa có API công khai, CRM chưa có báo giá và đơn bán hàng, chưa có giá công bố hay bản đám mây.
- Đọc ảnh và PDF quét phụ thuộc mô hình AI của bên vận hành.

**Nên xây tiếp (issue đã có, theo thứ tự đau nhất):**
1. Phát hành hóa đơn thật: #2503 (MISA) và #2509 (Viettel), kèm việc của chủ sở hữu #2507 và #2508 (tạo tài khoản thử và hỏi hãng bằng văn bản); sau đó #2504 (điều chỉnh, thay thế).
2. Nối ngân hàng trực tiếp: #2045 (Tingee).
3. Kế toán xác nhận những gì đã có: #154, #920, #332, và lần chạy thử có giám sát đồng bộ cổng thuế #1100.
4. Sổ TT99: #1403.
5. Lương và nhân sự thành ứng dụng riêng: #2531, #2532, #2533, hồ sơ nhân viên #2530; cần kế toán kiểm quy tắc (#2535); #2643 đang chặn lương trên Cloud.
6. Sàn và kho: #2519 (nối trực tiếp), #2513 (chốt tháng, giá vốn).
7. **Chủ sở hữu quyết định** (chưa có issue): có cần hỗ trợ TT200 không khi TT99 đã thay; báo giá và đơn bán hàng trong CRM; API công khai ngoài epic #68; giá Ludy Cloud; ứng dụng di động riêng ngoài #64 và #65.

## 5. Giới hạn của nghiên cứu

- Các trang được đọc qua công cụ trả bản tóm tắt, nên muốn trích số nào thì mở lại trang đó. Vài nguồn MISA, Odoo chỉ thấy trong kết quả tìm kiếm, không mở được (bản tiếng Anh đánh dấu từng cái).
- Trang MISA mâu thuẫn nhau về giá gói Starter và về gói nào có thư nhắc nợ; bảng báo giá meInvoice tự ghi hiệu lực từ 2020 nên có thể đã cũ.
- Nhiều trang Fast không ghi ngày; trang giá chưa nói đã gồm VAT hay chưa.
- Odoo không ghi rõ bản nào của tính năng nào, nên "Enterprise (suy ra)" là suy luận từ mã công khai, không phải câu chữ của Odoo. Odoo 20 ra tháng 9 năm 2026; hầu hết dòng dẫn tài liệu 19.0.
- Cột Ludy chỉ phản ánh phần mã mở; lớp Ludy Cloud riêng tư có thể có bộ nối mà tài liệu này không thấy. Việc kế toán đã kiểm sau thời điểm chụp không thể biết từ kho mã.
- Giá là giá niêm yết theo đơn vị tiền của hãng, không quy đổi, không phải báo giá.

## 6. Các trang chính (đọc ngày 2026-11-06)

Danh sách đầy đủ có số thứ tự nằm ở bản tiếng Anh. Các trang chính thức chính:

- MISA: bảng giá https://amis.misa.vn/20355/bao-gia-phan-mem-ke-toan-online-misa-amis/ ; giới thiệu https://amis.misa.vn/amis-ke-toan/ ; MISA SME https://sme.misa.vn/ ; meInvoice https://www.meinvoice.vn/ ; các tính năng AI https://helpact.misa.vn/?p=68849 ; ngân hàng điện tử https://helpact.misa.vn/?p=12062 ; Thông tư 99 https://helpact.misa.vn/kb/cac-cau-hoi-thuong-gap-ve-thong-tu-99-2025-tt-btc/ ; lương https://amis.misa.vn/amis-tien-luong/ ; CRM https://amis.misa.vn/293039/bao-gia-phan-mem-amis-crm/ .
- Fast: https://faonline.vn/fast-accounting-online/ ; giá https://faonline.vn/bang-gia/ ; bản máy tính https://fast.com.vn/phan-mem-ke-toan-fast-accounting/ ; hóa đơn đầu vào https://fast.com.vn/chuc-nang-quan-ly-hoa-don-dau-vao-tren-phan-mem-ke-toan-fast-accounting-online/ ; sao kê https://help.faonline.vn/faohelp/sao-ke-tai-khoan-ngan-hang/ ; Thông tư 99 https://help.faonline.vn/faohelp/cac-cau-hoi-thuong-gap-ve-viec-ap-dung-thong-tu-99-2025-tt-btc/ ; sàn thương mại điện tử https://fast.com.vn/phan-mem-ke-toan-fast-tich-hop-voi-cac-san-thuong-mai-dien-tu/ ; nhân sự và lương https://fast.com.vn/phan-mem-erp-fast-business-online-fast-hrm-quan-ly-nhan-su-cham-cong-tinh-luong/ .
- Odoo: Việt Nam https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/vietnam.html ; giá https://www.odoo.com/pricing ; bản phát hành 19.4 https://www.odoo.com/odoo-19-4-release-notes ; bản phát hành 20 https://www.odoo.com/odoo-20-release-notes ; nối ngân hàng https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/bank_synchronization.html ; số hóa hóa đơn https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/invoice_digitization.html ; mô-đun `l10n_vn` https://raw.githubusercontent.com/odoo/odoo/19.0/addons/l10n_vn/__manifest__.py .
