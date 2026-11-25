# Ludy CRM, lát cắt 1: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [crm.md](crm.md), cập nhật khi đóng lát cắt (bước K7), ngày 2026-11-01, và làm mới ngày 2026-11-16 (issue #3479) cho khớp với `main`. JOY đã quyết "Mở ngay" cho lát cắt đầu tiên của CRM (quyết định 21 trong kế hoạch kernel, issue [#2223](https://github.com/DOS/Ludy/issues/2223)). Đây là ngoại lệ của Quyết định 2, giống Quyết định 20 đã làm cho Calendar. Lát này chưa hiện ra với khách hàng nào vì bản chạy thử chỉ có kế toán.

## Lát cắt 1 làm gì, cho ai

Công ty một người hoặc doanh nghiệp nhỏ cần một chỗ để thấy mình có thể bán cho ai, bao nhiêu tiền, và mỗi thương vụ đã đến đâu, ngay cạnh sổ sách đã có trong Ludy.

Một thành viên làm được:
- ghi **cơ hội bán hàng** (deal) gắn với liên hệ hoặc công ty đã có trong Ludy, kèm số tiền (đồng) và ngày dự kiến chốt;
- xem mọi cơ hội trên **một bảng quy trình bán hàng** (pipeline): kéo thẻ sang cột khác hoặc đổi thứ tự trong cột (trên điện thoại và bằng bàn phím dùng menu giai đoạn trên thẻ), đóng là Thắng hoặc Thua, ghi lý do thua; chủ sở hữu và quản trị viên đổi tên, thêm, sắp xếp, xóa các giai đoạn đang mở;
- tìm liên hệ **không cần gõ dấu** ("nguyen" ra "Nguyễn"), và **lưu chế độ xem** (bộ lọc và cách sắp xếp), riêng tư hoặc chia sẻ cả tổ chức;
- **nhập liên hệ và công ty từ tệp Excel hoặc CSV**: đọc ngay trên máy, ghép cột, xem trước từng dòng (mới, trùng, xung đột, lỗi) rồi mới nhập; không ghi đè thông tin đã có; tải về các dòng chưa nhập kèm lý do; tệp Excel có macro hoặc ô công thức bị từ chối kèm hướng dẫn;
- xem **dòng thời gian** của liên hệ: thêm, nhập từ tệp, tạo cơ hội, chuyển giai đoạn, thắng, thua (không kèm tên cơ hội hay số tiền).

## An toàn và dữ liệu

- Mọi thay đổi đi qua một đường ghi duy nhất (command). Tác nhân AI không ghi vào các bảng này.
- Số tiền luôn là số thập phân, chỉ VND ở giai đoạn này. Hai người sửa cùng một cơ hội: người lưu sau được báo, không ghi đè.
- Tệp nhập không được lưu lại. Các dòng xem trước chứa dữ liệu cá nhân nên bị xóa khi nhập, khi hủy, và sau 7 ngày (bước K5b quét hằng ngày cả những tổ chức không nhập nữa).
- Nhật ký chỉ ghi số lượng và mã, không ghi tên, email, số điện thoại hay số tiền.

## Các bước đã làm

| Bước | Nội dung | Trạng thái khi viết bản này |
|---|---|---|
| Kế hoạch | Tài liệu kế hoạch và quyết định 21 | Đã gộp (#2224) |
| K1 | Cơ hội và quy trình, màn hình "Cơ hội" dạng danh sách | Đã gộp (#2240) |
| K2 | Bảng kéo thả, menu giai đoạn, Thắng và Thua, cài đặt giai đoạn | Đã gộp (#2244) |
| K3 | Chế độ xem đã lưu và bộ lọc | Đã gộp (#2239, #2252), worker khác |
| K4 | Màn hình "Liên hệ", tìm không dấu, chuẩn hóa số điện thoại | Đã gộp (#2241), worker khác |
| K5 | Nhập liên hệ từ CSV | Đã gộp (#2254) |
| K5b | Quét hằng ngày xóa dòng nhập quá 7 ngày | Đã gộp (#2259) |
| K6 | Nhập liên hệ từ Excel (đọc ngay trên trình duyệt, không thêm gói mới) | Đã gộp (#2277) |
| K7 | Kiểm tra cả luồng bằng một bài e2e, kiểm tra module `crm` chạy riêng và khi tắt, hướng dẫn sử dụng, bản tóm tắt này | Đã gộp (#2279) |

## Ngoài lát này (chờ JOY)

AI dưới mọi hình thức, thu thập từ email, lịch hay Zalo, trường tùy chỉnh và đối tượng tùy chỉnh, quy trình thứ hai, tự động hóa, sản phẩm trên cơ hội (báo giá đã làm ở lát cắt 2, xem [crm-quotes.vi.md](crm-quotes.vi.md)), chia sẻ bản ghi, API công khai, ứng dụng di động riêng.

## Việc cần JOY quyết

Hiện không có gì chặn. Các giả định mặc định (đổi được sau): chỉ VND; chưa có hoàn tác cho việc nhập tệp; lý do thua là văn bản tự do. Các giả định cũ sau đây đã đổi (cập nhật 2026-11-16): cơ hội thắng nối với hóa đơn qua báo giá và đơn hàng (nút "Lập hóa đơn" trên đơn, xem [crm-quotes.vi.md](crm-quotes.vi.md)); người đã nối được với công ty (CRM-Q5, #2438: công ty của một người, số người của một công ty, gợi ý công ty, cột công ty khi nhập tệp); bảng cơ hội cập nhật gần như tức thời khi người khác chuyển thẻ (#3293). Danh sách đầy đủ ở mục 9 của [crm.md](crm.md).

## Quyết định của chủ sở hữu 2026-11-25: điền theo mã số thuế, chuẩn bị trước cuộc hẹn, tín hiệu

Ngày 2026-11-25, JOY xem Clay (clay.com: làm giàu dữ liệu, tác nhân nghiên cứu Claygent, tín hiệu, MCP cho nhân viên bán hàng) và quyết định đưa ba ý vào kế hoạch CRM, theo hướng gọn: công ty một người và doanh nghiệp nhỏ trước, lát cắt nhỏ nhất, phần dành cho doanh nghiệp lớn để vào Icebox (kho để dành). Theo dõi ở [#4987](https://github.com/DOS/Ludy/issues/4987). Chi tiết đầy đủ ở mục 10 của [crm.md](crm.md). Mục 2 và 3 là phần của quyết định 2 và 3 trong [nghiên cứu CRM](../research/crm-reference-study.md) mà JOY duyệt, chỉ trong phạm vi này; phần còn lại của hai quyết định đó vẫn chờ. Mọi bước đều là P2, không gắn mốc (milestone), nhãn `crm` và `line:notes-crm`.

Quy tắc AI không đổi: gọi mô hình chỉ trong `packages/agent`, qua bộ đo ngân sách AI; tắt AI thì phần lõi vẫn chạy; kết quả của AI là dữ liệu chưa tin cậy, mã quyết định; mọi thao tác ghi, gửi tin và chi tiền đều do một người duyệt.

### 1. Điền công ty theo mã số thuế

- **Làm gì.** Khi tạo hoặc sửa liên hệ, và ở bước xem trước của việc nhập tệp, gõ mã số thuế 10 số hoặc 13 số (10-3, chi nhánh) thì Ludy tra tên, địa chỉ và tình trạng hoạt động của công ty. Kết quả chỉ là **gợi ý**: người dùng bấm "Điền" từng ô, ô nào đã có chữ thì không bao giờ bị ghi đè. Mã 12 số là số căn cước nên không bao giờ gửi đi đâu.
- **Nguồn đã xem (ngày 2026-11-25).** Dùng **Casso Open Platform** (API tra mã số thuế IDKit mà trang của VietQR chỉ tới): có khóa riêng, hạn mức miễn phí 1.000 lượt (cá nhân, hộ kinh doanh) hoặc 5.000 lượt (doanh nghiệp) mỗi khóa, không hồi theo tháng. Chưa tìm thấy điều khoản riêng cho Open Platform và trang không nói dữ liệu lấy từ đâu, nên **một người phải hỏi Casso bằng văn bản** (địa chỉ hỗ trợ có trên [trang chính sách bảo mật](https://casso.vn/chinh-sach-bao-mat-thong-tin/) của Casso) về lưu tạm, phân phối lại, nguồn và dữ liệu hộ kinh doanh trước khi tài liệu khuyên bật. API cũ của VietQR sẽ tắt ngày 2026-12-31 nên không làm. Khóa "Public Starter Key" dùng chung không bao giờ được dùng. Trang Tổng cục Thuế có CAPTCHA (Ludy không bao giờ giải CAPTCHA). Cổng đăng ký doanh nghiệp quốc gia cấm kinh doanh thông tin đăng ký khi chưa được cơ quan cấp phép và không có API công bố. masothue.com chặn truy cập tự động và chưa đọc được điều khoản. Cả ba đều không dùng.
- **Thiết kế.** Nhà cung cấp cắm thêm được, bật bằng một biến cấu hình (`TAX_LOOKUP_PROVIDER=off|casso`). Mặc định **tắt**: không có yêu cầu nào ra khỏi máy, `docker compose up` chạy bình thường không cần mạng hay dịch vụ của DOS. Mỗi tổ chức có công tắc riêng (chủ sở hữu hoặc quản trị viên bật, mặc định tắt) và được báo rõ rằng mã số thuế sẽ gửi cho nhà cung cấp. Mọi lệnh gọi đi qua lớp bảo vệ lệnh gọi ra ngoài (egress guard) của runtime. Giới hạn mỗi tổ chức 30 lượt mỗi giờ và 200 lượt mỗi ngày; kết quả được lưu tạm 24 giờ (không tìm thấy: 1 giờ) nên tra lại không tốn lượt.
- **Dữ liệu cá nhân.** Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 và Nghị định 356/2025/NĐ-CP (có hiệu lực từ 2026-01-01) đã thay Nghị định 13/2023/NĐ-CP mà JOY nhắc tới; luật sư (#62) sẽ xác nhận. Tên, địa chỉ, mã số thuế của công ty không phải dữ liệu cá nhân. Nhưng hộ kinh doanh dùng mã số thuế cá nhân của chủ hộ và tên thường mang tên chủ hộ, nên: mã 12 số không bao giờ gửi; kết quả mang tên hộ kinh doanh chỉ hiện một lần, **không lưu tạm**; thứ duy nhất được lưu là dòng lưu tạm (mã, tên, địa chỉ, tình trạng, giờ tra), có đánh dấu loại dữ liệu, **bị xóa cùng liên hệ khi xóa dữ liệu cá nhân**, cùng khi xóa tổ chức và khi hết hạn; nhật ký không ghi tên hay địa chỉ; tình trạng chỉ hiện, không lưu.
- **AI làm gì.** Không có. Việc tra là xác định, tắt AI vẫn chạy. Chuẩn hóa địa chỉ bằng mô hình để dành cho sau (Icebox).
- **Các bước.** TC1 [#4988](https://github.com/DOS/Ludy/issues/4988) (nhà cung cấp, bảo vệ lệnh gọi, giới hạn, lưu tạm, công tắc; có migration nên là đường dẫn được bảo vệ); TC2 [#4989](https://github.com/DOS/Ludy/issues/4989) (thẻ gợi ý trên form liên hệ); TC3 [#4990](https://github.com/DOS/Ludy/issues/4990) (gợi ý ở bước xem trước khi nhập tệp, tối đa 50 dòng mỗi lô). P2, không mốc.

### 2. Chuẩn bị trước cuộc hẹn

- **Làm gì.** Hiện chỉ có bản chuẩn bị cho lịch hẹn đã gắn với một cơ hội (#3115). Việc này mở rộng cho mọi sự kiện lịch hoặc cuộc họp có một liên hệ: cơ hội, báo giá, hóa đơn, các cuộc trò chuyện gần đây, và (nếu bạn đồng ý) trang web công khai của công ty, kết thúc bằng một **bản nháp** trong ghi chú cuộc họp. Người dùng tự xem; không có gì được gửi đi.
- **Hai bước.** PM1 [#4991](https://github.com/DOS/Ludy/issues/4991): phần dữ kiện do mã dựng (không AI), có thể giữ làm bản nháp riêng rồi đưa vào ghi chú bằng một cú bấm. PM2 [#4992](https://github.com/DOS/Ludy/issues/4992): Dy, trợ lý bán hàng, viết tóm tắt và 2 đến 3 điểm cần nêu khi người dùng bấm "Nhờ Dy chuẩn bị" (người dùng duyệt chi phí). Trang web chỉ được đọc khi người dùng xác nhận địa chỉ, một yêu cầu cho trang chủ, qua lớp bảo vệ lệnh gọi ra ngoài, và coi là dữ liệu không tin cậy.
- **AI làm gì.** Dy chỉ viết lời; mọi dữ kiện do mã dựng. Lời của mô hình bị từ chối cả bản (không sửa) nếu có con số, đường dẫn hay tên riêng mà dữ kiện và trang web không có. Mỗi lệnh gọi mô hình tính vào khóa tính năng riêng `crm.meeting_research`, thuộc ngân sách CRM. Tắt AI, hết ngân sách hoặc lỗi thì chỉ hiện dữ kiện.
- P2, không mốc.

### 3. Tín hiệu: danh sách "Cần chú ý"

- **Làm gì.** Một danh sách nhỏ trên liên hệ, sau đó trên Trang chủ, báo khi khách hàng có hành động, chỉ dựa trên sự kiện Ludy đã có: khách mở báo giá, báo giá sắp hết hạn hoặc chưa được trả lời, hóa đơn quá hạn, khách trả lời sau từ 7 ngày im lặng, khách mở phong bì ký. **Không** có dữ liệu ý định mua từ bên ngoài, không dữ liệu mua về, không theo dõi của bên thứ ba (kể cả điểm ảnh theo dõi việc mở email).
- **Hai bước.** SG1 [#4993](https://github.com/DOS/Ludy/issues/4993): `crm.party.attention` và thẻ trên liên hệ, có nút "Đã xem" riêng cho từng người (migration, đường dẫn được bảo vệ). SG2 [#4994](https://github.com/DOS/Ludy/issues/4994): đưa lên Trang chủ qua phần ghép tín hiệu của kernel (cần Platform PO xem lại phần lõi dùng chung), thêm hóa đơn quá hạn và phong bì đã mở.
- **AI làm gì.** Dy có thể gợi ý bước tiếp theo bằng cách dùng lại bản nháp theo dõi có sẵn (`crm.followup`); người dùng sửa và tự gửi. Danh sách và Trang chủ không gọi mô hình.
- P2, không mốc.

### Không lấy từ Clay

Chợ dữ liệu và chuỗi nhiều nhà cung cấp trả phí, danh sách mua hoặc cào về, tín hiệu ý định (đổi việc, gọi vốn, khách ghé web), theo dõi của bên thứ ba, chuỗi email gửi tự động, đồng bộ liên hệ sang tệp khán giả quảng cáo, tác nhân tự duyệt nhiều trang web, bảng làm giàu hàng nghìn dòng. Lý do: quy mô doanh nghiệp lớn (không hợp quy tắc gọn), dữ liệu cá nhân của người không có quan hệ với tổ chức (Luật 91/2025/QH15, Nghị định 356/2025/NĐ-CP), và mọi tin nhắn gửi đi phải do một người duyệt. Gộp thành một issue Icebox P3: [#4995](https://github.com/DOS/Ludy/issues/4995).

### Việc chỉ người làm được

Hỏi Casso bằng văn bản về điều khoản của Open Platform; luật sư (#62) kiểm tra cách xử lý hộ kinh doanh; chủ hoặc quản trị viên mỗi bản triển khai tự mang khóa nhà cung cấp của mình.
