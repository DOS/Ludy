<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Đề xuất Giai đoạn 6 cho Ludy eSign (`ludy_sign`): Ký nhanh trên điện thoại, Nhận file Word `.docx`, Gói nhiều tài liệu & Đặt cọc VietQR (2026-11-24)

Trạng thái: **Đợt 1 (`6a` [#4720](https://github.com/DOS/Ludy/issues/4720)/[#4727](https://github.com/DOS/Ludy/pull/4727), `6b` [#4721](https://github.com/DOS/Ludy/issues/4721)/[#4728](https://github.com/DOS/Ludy/pull/4728)), Đợt 2 (`6c` [#4722](https://github.com/DOS/Ludy/issues/4722)/[#4731](https://github.com/DOS/Ludy/pull/4731), `6d` [#4723](https://github.com/DOS/Ludy/issues/4723)/[#4732](https://github.com/DOS/Ludy/pull/4732)), Wave A1 ([#4636](https://github.com/DOS/Ludy/issues/4636), [#4682](https://github.com/DOS/Ludy/issues/4682), [#4729](https://github.com/DOS/Ludy/issues/4729), [#4837](https://github.com/DOS/Ludy/issues/4837), [#5024](https://github.com/DOS/Ludy/issues/5024)), đồng bộ trang `ludy.vn/esign` ([#5109](https://github.com/DOS/Ludy/issues/5109)/[#5115](https://github.com/DOS/Ludy/pull/5115)) và E2E Slice 6a-6d ([#5110](https://github.com/DOS/Ludy/issues/5110)/[#5114](https://github.com/DOS/Ludy/pull/5114)) đã hoàn thành trên `dev` / `main` (chưa triển khai lên `pilot`); mục số 5 (`Slice 6e`, `VNeID`/C06 & chứng thư số công cộng thật) tiếp tục tạm hoãn chờ luật sư [#62](https://github.com/DOS/Ludy/issues/62) và tài khoản đối tác.** (Issue đề xuất gốc [#4607](https://github.com/DOS/Ludy/issues/4607), Epic [#3318](https://github.com/DOS/Ludy/issues/3318)). Bản tiếng Anh: [esign-slice6-proposal.md](esign-slice6-proposal.md). Bảng so sánh đối thủ 2026 `v4` (`2026-11-27`): [esign-competitors-and-ai-2026.vi.md](esign-competitors-and-ai-2026.vi.md) ([bản tiếng Anh](esign-competitors-and-ai-2026.md)).

---

## 1. Ludy eSign đang có gì sau Giai đoạn 1 đến 5?

Qua kiểm tra trực tiếp mã nguồn trên nhánh `main` (`e5e0953aa`), Ludy eSign đã hoàn thiện và gộp xong trọn bộ **Giai đoạn 1 đến 5** trên **`22` bảng dữ liệu `ludy_sign.*`** (vừa đổi tên đồng bộ từ `crove_sign.*` ở [#4484](https://github.com/DOS/Ludy/pull/4484)), **`5` màn hình quản trị**, **`3` trang ký công khai không cần đăng nhập**, **`4` công cụ đọc cho AI (`MCP`)**, **`6` cổng kết nối API bên ngoài**, và **`9` tính năng trợ lý `Vy` có đồng hồ đo chi phí**:

- **Giai đoạn 1 & 2 (nền tảng & mẫu chuẩn):** tải PDF kiểm tra trong hộp cát an toàn (môi trường tách biệt không ra mạng ngoài), vẽ/gõ chữ ký trên điện thoại qua link dán Zalo không bị hỏi CAPTCHA, mã xác nhận OTP qua email, khóa chống ký trùng, niêm phong tệp bằng mã băm `SHA-256` kèm trang chứng nhận kiểm toán, mẫu dùng lại nhiều lần, link ký công khai 1 người (`/-/sign/d`), nhận thẻ vị trí ký tự động trong PDF, nối từ Báo giá (`Ludy Engage`) & Hợp đồng nhân sự (`Ludy Nhân sự` có khóa riêng tư chặt chẽ), và sẵn khung kết nối Nhà cung cấp chữ ký số công cộng Việt Nam (`VNPT SmartCA`, `Viettel MySign`, `MISA WeSign`, bản thật chờ luật sư duyệt ở [#62](https://github.com/DOS/Ludy/issues/62)).
- **Giai đoạn 3 & 4 (nghiệp vụ SME Việt Nam & vòng đời hợp đồng):** đẩy Biên bản họp (`Ludy Ghi chú`) và Biên bản nghiệm thu (`Ludy Dự án`) sang ký rồi mở nháp hóa đơn bên `Ludy Kế toán`; cảnh báo hồ sơ sắp hết hạn / bị từ chối lên màn `Hôm nay` của `Vy`; nút bấm 1 chạm **ký nháy tất cả các trang**, **con dấu đỏ công ty/chức danh**, danh sách chọn (`dropdown`/`radio`) và bắt khách tải đính kèm `CCCD`/`ĐKKD`; sửa email người nhận khi hồ sơ đã gửi mà không phải hủy chữ ký của người ký trước; ủy quyền ký cho Giám đốc; ký trực tiếp tại quầy trên máy tính bảng tách biệt; trang danh mục mẫu công khai (`/-/sign/p/...`); trích xuất nghĩa vụ/hạn gia hạn lên `Vy Hôm nay`; so sánh 2 bản PDF sửa đổi và **5 mẫu hợp đồng SME Việt Nam soạn nhanh chạy ngoại tuyến**.
- **Giai đoạn 5 (tuân thủ & kiểm soát rủi ro 2026):** cảnh báo pháp lý **Nghị định `337/2025/NĐ-CP`** trên hợp đồng lao động (tránh hiểu nhầm thay thế hợp đồng lao động nộp Bộ Nội vụ), hỏi đáp kho hợp đồng đúng phân quyền (`Contract Vault Q&A`), **bộ kiểm tra điều khoản chuẩn SME Việt Nam** (6 luật mặc định như trần phạt tối đa 8% theo Luật Thương mại, hạn thanh toán <= 30 ngày) kèm gợi ý câu sửa có trích dẫn trang, kiểm tra đối chiếu mã số thuế/`CCCD` trên tệp đính kèm `KYC`, và cổng `Webhook` ký bảo mật + `API` / `MCP` cho tự động hóa.

*(Ghi chú triển khai thật: eSign đang có hướng dẫn bật trên máy chạy thử `pilot` ở [pilot-enable-sign.md](../runbooks/pilot-enable-sign.md); bản thật cho chữ ký số công cộng từ xa vẫn đợi luật sư kiểm tra tại [#62](https://github.com/DOS/Ludy/issues/62).)*

---

## 2. Đối chiếu thị trường 2026 (`2026-11-24`): Còn 4 điểm vướng thực tế nào cho hộ/SME Việt Nam?

Từ khảo sát mới nhất trên **DocuSign (IAM/Iris/Maestro)**, **Documenso**, **DocuSeal**, **PandaDoc**, **Dropbox Sign**, **Adobe Acrobat Sign**, nhóm Việt Nam (**MISA AMIS WeSign**, **FPT.eContract**, **VNPT eContract**, **Viettel vContract**), và nhóm AI mới (**Agree.com**, **Juro**, **SpotDraft**, **Spellbook**, **Ironclad**, **Concord**), các khoảng trống thực tế còn lại là:

1. **Ký bằng điện thoại qua mã QR & nhắc ký trong Zalo OA:** mở link trên máy tính để ký bằng chuột rất khó, còn lúc ký tại quầy thì khách ngại chạm vào máy tính bảng của nhân viên; đồng thời sale muốn bấm 1 nút để chèn ngay link ký vào khung trả lời **Zalo OA** trong `Ludy Engage` (chứ không phụ thuộc gói tin nhắn trả phí `Zalo ZNS`).
2. **Tải thẳng file Word `.docx` lên ký (nhiều bên vẫn gửi `.docx` qua Zalo):** hiện Ludy eSign chỉ nhận file `PDF`, bắt người dùng phải mở Word tự xuất sang PDF (dễ lỗi phông chữ hoặc lỗi định dạng PDF phức tạp). Documenso, DocuSeal, MISA WeSign và FPT.eContract đều cho tải thẳng `.docx`.
3. **Ký một gói gồm nhiều tài liệu trong một lần (`Hợp đồng chính + Phụ lục báo giá + NDA`):** hiện mỗi hồ sơ ký của Ludy mới gắn `1` file PDF, khiến người dùng phải gửi nhiều link riêng lẻ hoặc ghép file bằng web ngoài. DocuSeal (*Add Document*), Documenso, DocuSign, Agree.com và MISA WeSign đều gộp nhiều file vào 1 lần ký.
4. **Thu tiền đặt cọc ngay khi ký bằng `VietQR` (nối về `Ludy Kế toán`):** Agree.com thắng lớn ở Mỹ nhờ nối thẳng lúc ký hợp đồng sang thu tiền (`contract-to-cash`), DocuSeal gắn thanh toán Stripe. Ở Việt Nam, SME ký xong hay phải đợi chuyển khoản cọc `30%-50%` riêng lẻ dễ bị nguội giao dịch. Ludy đã có sẵn bộ tạo mã QR ngoại tuyến (`qr-svg.ts`), bảng ngân hàng Việt Nam và bộ đọc sao kê/giao dịch ngân hàng trong `Ludy Kế toán`.
5. **Điểm pháp lý 2026 mới (`Nghị định 337/2025/NĐ-CP` & `Thông tư 08/2026/TT-BNV` từ `01/07/2026`):** quy định hợp đồng lao động điện tử chính thức phải đăng nhập cổng Bộ Nội vụ bằng **`VNeID` (`C06`)** và nộp lấy **mã định danh `13` ký tự** trong 24 giờ. Tuy nhiên cổng `VNeID`/C06 và Bộ Nội vụ **không mở tự do**, cần hợp đồng pháp nhân, trả phí định danh từng lượt và giấy phép luật sư `#62`, nên không thể làm mặc định chạy ngay trên `docker compose up` cho doanh nghiệp nhỏ.

---

## 3. Bảng chấm điểm & Xếp hạng 5 đề xuất cho Giai đoạn 6 (lọc theo [scope.md](../product/scope.md))

| Thứ hạng & Đợt | Đề xuất | Lợi ích cho OPC/SME hàng tháng | Chạy ngay với mặc định (không cần mua cổng ngoài)? | Vai trò AI (`Vy`) & Chạy khi tắt AI | Công sức / Rủi ro | Khuyến nghị |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Số 1 (`Đợt 1a`)** | **Quét mã QR ký ngay trên điện thoại + Nút chèn link vào Zalo `Ludy Engage`** *(Mục 4)* | **Rất cao:** khách đang ngồi máy tính hoặc đứng tại quầy chỉ cần giơ điện thoại quét QR để ký ngón tay mượt; sale chèn link vào chat Zalo 1 chạm. | **Đạt 100%:** dùng bộ vẽ QR ngoại tuyến và kênh Zalo OA có sẵn trong Ludy; **không bắt buộc mua gói Zalo ZNS** (ai có ZNS riêng thì nối qua `Webhook` có sẵn). | Không tốn lượt AI; tùy chọn gợi ý câu nhắn lịch sự để người dùng tự bấm gửi. Tắt AI vẫn chạy `100%`. | **Nhỏ (`S`)** / **Thấp** | **Làm ngay ở Đợt 1a** |
| **Số 2 (`Đợt 1b`)** | **Tải thẳng file Word `.docx` lên tự chuyển sang PDF gắn sẵn vị trí ký** *(Mục 1)* | **Rất cao:** khách/đối tác gửi file Word qua Zalo là đẩy thẳng lên ký, bỏ bước tự xuất PDF thủ công. | **Đạt 100%:** mở rộng bộ đọc `.docx` an toàn trong hộp cát `crove-extract` bằng mã JS thuần (`pdf-lib` + font tiếng Việt `Be Vietnam Pro`), không nhồi gói LibreOffice nặng vào Docker; chặn file có sửa đổi ẩn (`Track Changes`) chưa duyệt. | `Vy` tự chạy rà khung ký, tóm tắt rủi ro và kiểm tra điều khoản ngay trên PDF vừa chuyển. Tắt AI vẫn chuyển Word -> PDF và ký `100%`. | **Trung bình (`M`)** / **Thấp-TB** | **Làm ngay ở Đợt 1b** |
| **Số 3 (`Đợt 2a`)** | **Gói nhiều tài liệu trong 1 lần ký (`Hợp đồng + Phụ lục + Báo giá`)** *(Mục 2)* | **Cao:** ký 1 lượt, nhập 1 mã OTP, 1 trang chứng nhận kiểm toán liệt kê đủ mã băm `SHA-256` từng file trong gói (`1..5` file, tổng `<= 200` trang). | **Đạt 100%:** niêm phong gọn trong hộp cát `crove-extract`, giữ nguyên khóa bảo mật cho hợp đồng nhân sự và biên bản họp. | `Vy` cảnh báo chênh lệch giữa hợp đồng chính và phụ lục (ví dụ tổng tiền khác nhau hoặc phụ lục thiếu ô ký). Tắt AI vẫn gộp gói ký `100%`. | **TB-Cao (`M-L`)** / **Trung bình** | **Làm ở Đợt 2a** |
| **Số 4 (`Đợt 2b`)** | **Hiện mã `VietQR` đặt cọc sau khi ký & Gợi ý khớp tiền bên `Ludy Kế toán`** *(Mục 3)* | **Cao:** biến khoảnh khắc vừa ký xong thành tiền cọc về tài khoản ngân hàng ngay, kế toán thấy gợi ý đối chiếu theo mã nội dung `CK-...`. | **Đạt (dùng ảnh QR hoặc chuỗi QR khi `#2535` chốt mã ngân hàng NAPAS):** khóa cứng thông tin tài khoản người bán lúc bấm gửi ký để chống sửa trộm; **Ludy không giữ tiền hộ hay làm trung gian thanh toán**. | `Vy` đọc điều khoản cọc trong hợp đồng để điền sẵn số tiền gợi ý và giải thích dòng tiền khớp bên Kế toán. Tắt AI vẫn hiện QR và đối chiếu tay `100%`. | **Trung bình (`M`)** / **Trung bình** | **Làm ở Đợt 2b** |
| **Số 5 (`Để sau / Chờ cổng`)** | **Kết nối định danh `VNeID` / C06 & Cổng Bộ Nội vụ (`Thông tư 08/2026`) + Test chữ ký số thật** *(Mục 5)* | **Thấp cho đa số OPC/SME** hiện tại (chỉ dùng cho HĐLĐ điện tử nộp nhà nước, còn hợp đồng B2B/CTV không bắt buộc). | **Chưa đạt điều kiện mặc định:** cổng `C06 / VNeID` và Bộ Nội vụ đòi hợp đồng pháp nhân, trả phí lượt và chữ ký luật sư `#62`, không tự chạy thử được. | Chưa viết mã gọi API nhà nước khi chưa có tài liệu kỹ thuật & tài khoản thử nghiệm chính thức. | **Lớn (`L`)** / **Cao (Pháp lý)** | **Hoãn chờ `#62` & tài khoản đối tác** |

---

## 4. Những thứ kiên quyết giữ ở `Icebox` (không làm để tránh phình sản phẩm)

Theo đúng cổng [scope.md](../product/scope.md), Ludy eSign **không làm** các mục sau trong Giai đoạn 6:

1. **Bắt buộc mua gói `Zalo ZNS` hoặc cổng SMS trả phí mới dùng được tính năng nhắc ký** (chỉ mở qua `Webhook` có sẵn cho đơn vị tự nối nếu họ đã có hợp đồng ZNS).
2. **Tiện ích cài thêm vào Microsoft Word trên Windows/Mac (`Word COM add-in`)** hoặc nhồi `LibreOffice` hàng trăm MB vào hệ thống chạy.
3. **Làm trung gian thu hộ / giữ tiền (`escrow`) hay cổng quẹt thẻ quốc tế:** chỉ hiện `VietQR` chuyển thẳng về tài khoản ngân hàng của doanh nghiệp và hỗ trợ Kế toán đối chiếu.
4. **Trình cài USB Token ký số trên máy tính, đăng nhập `SSO/SCIM` cho người ký ngoài, gửi thư rác hàng loạt từ file CSV, giao diện đại lý (`white-label`) hoặc tự nhận danh nghĩa tổ chức chứng thực `CeCA` / `TSA` khi chưa có giấy phép.**

---

## 5. Phương án trình `JOY` chọn

1. **Duyệt Đợt 1 (`6a` Quét QR ký trên điện thoại + chèn link Zalo trong `Ludy Engage`, và `6b` tải thẳng Word `.docx` sang PDF) làm trước, sau đó làm tiếp Đợt 2 (`6c` Gói nhiều tài liệu & `6d` Đặt cọc VietQR nối Kế toán); hoãn mục `VNeID`/Bộ Nội vụ (`6e`) chờ luật sư `#62` và tài khoản đối tác *(Khuyến nghị)*.**
2. **Chỉ mở Đợt 1 (`6a` và `6b`) trước** để ra mắt gọn nhẹ, đánh giá phản hồi thật rồi mới mở tiếp Đợt 2.
3. **Ưu tiên Đợt 2 (`6c` Gói nhiều tài liệu và `6d` Đặt cọc VietQR) trước**, làm `.docx` và QR sau.
4. **Chưa mở Giai đoạn 6 vội**, tập trung hoàn tất kiểm thử tự động (`#4606`), đồng bộ trang `ludy.vn/esign` (`#4605`), bật eSign lên bản chạy thử `pilot` và đợi luật sư `#62`.
