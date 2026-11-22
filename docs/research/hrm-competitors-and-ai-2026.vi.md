<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# So sánh Ludy Nhân sự với thị trường HRM Việt Nam, Quốc tế và Nhóm AI-Native (2026-11-22)

Trạng thái: tài liệu nghiên cứu ngày `2026-11-22` theo yêu cầu của chủ sở hữu (`JOY`) để phục vụ đánh giá Giai đoạn 5 sau khi hoàn tất Giai đoạn 4 và đưa lên bản thử nghiệm thật (`v0.3.7`). **Chỉ là tài liệu nghiên cứu, không mở issue mới và không viết mã cho đến khi chủ sở hữu quyết định.** Bản đầy đủ tiếng Anh với danh sách nguồn chi tiết: [hrm-competitors-and-ai-2026.md](hrm-competitors-and-ai-2026.md).

Góc nhìn đánh giá: doanh nghiệp một người (`OPC`), hộ kinh doanh và doanh nghiệp nhỏ và vừa (`SME`) tại Việt Nam ([scope.md](../product/scope.md)), tuân thủ năm nguyên tắc cố định của Ludy: dùng tốt khi tắt AI, AI (`Ly` và `Vy`) đi qua đồng hồ đo ngân sách, mọi con số do mã tính chứ AI không tự bịa số, con người luôn duyệt mọi giao dịch tiền/lương/tuyển dụng, và tự cài trọn bộ mã nguồn mở (`AGPL-3.0`, `docker compose up`) theo Luật Bảo vệ dữ liệu cá nhân `91/2025/QH15` và Luật Trí tuệ nhân tạo `134/2025/QH15`.

---

## 1. Ludy Nhân sự đã làm được gì (`main` / `v0.3.7`)

Đã xây hoàn chỉnh 4 giai đoạn trên 11 bảng dữ liệu riêng (`crove_hr.*`), 6 màn hình ứng dụng, mã hóa cột nhạy cảm và 5 tính năng AI có đồng hồ đo của đồng nghiệp `Ly`:

- **Hồ sơ, hợp đồng, thôi việc và tuân thủ:** hồ sơ nhân viên, người phụ thuộc, phòng ban và trưởng phòng ban duyệt cấp 1; xuất hợp đồng lao động PDF và gửi ký số sang `Ludy Ký kết`; trợ cấp thôi việc (Điều 46) và trợ cấp mất việc làm (Điều 47); theo dõi lao động nước ngoài (thuế TNCN không cư trú `20%` vs cư trú lũy tiến, `BHXH` hợp đồng từ 12 tháng, cảnh báo hạn giấy phép lao động); Sổ quản lý lao động + Báo cáo `01/PLI`; cơ chế xóa dữ liệu cá nhân khi hết thời hạn lưu trữ (bao gồm xóa lý do và ghi chú đơn nghỉ phép).
- **Cổng tự phục vụ nhân viên (`/hr/my`) và duyệt nghỉ phép nhiều cấp:** thành viên được liên kết xem số dư phép năm, gửi/hủy đơn nghỉ phép (kèm cảnh báo trùng lịch cùng phòng ban), xem phiếu lương kỳ đã duyệt kèm giải thích từng khoản chạy hoàn toàn không cần AI; trưởng phòng duyệt cấp 1, chủ sở hữu/quản trị viên duyệt cuối và tự động cộng vào kỳ lương; chặn tự duyệt ở cả máy chủ và cơ sở dữ liệu (trừ doanh nghiệp một chủ có ghi nhật ký kiểm toán); chặn hoàn toàn vai trò chỉ xem (`viewer`).
- **Tính lương Việt Nam, tệp ngân hàng và hạch toán Kế toán (`#2535`):** hỗ trợ lương tháng, lương theo giờ, lương sản phẩm, lương tháng 13, giảm trừ ốm đau/thai sản `BHXH`; xuất tệp chuyển lương theo ngân hàng và mẫu tùy biến; lập đề xuất hạch toán và chi lương sang `Ludy Kế toán` **chỉ theo tổng tài khoản (`334`, `338*`, `3335`, `642*`)**, kế toán duyệt phiếu chi mà không bao giờ thấy lương chi tiết từng người. *(Lưu ý: các quy tắc mới vẫn giữ trạng thái tham khảo cho đến khi kế toán `#61` xác nhận tại [#2535](https://github.com/DOS/Ludy/issues/2535).)*
- **Bảng kê thuế/BHXH và Tuyển dụng:** xuất bảng kê mẫu `D02-LT`, `05KK-TNCN`, `05QTT-TNCN`, `03/TNCN` (chưa xuất XML HTKK vì còn chờ luật sư [#2536](https://github.com/DOS/Ludy/issues/2536)); quản lý vị trí, hồ sơ ứng viên theo từng vòng, chọn người phỏng vấn có kiểm tra trùng lịch, hủy lịch phỏng vấn độc lập, nhận vào làm thành nhân viên, và xóa hồ sơ ứng viên rớt theo luật dữ liệu cá nhân.
- **Đồng nghiệp AI `Ly`:** chuẩn bị nháp kỳ lương tháng từ biến động tháng trước (trên bảng dữ liệu đã ẩn tên thật thành mã `P1`, `P2`), cảnh báo bất thường lương/khấu trừ, giải thích phiếu lương, rà soát sẵn sàng `01/PLI` và tóm tắt sàng lọc ứng viên ẩn danh (`C1`).
- **Khoảng trống lớn nhất trong mã hiện tại:** màn `Hôm nay` (`Vy`) **chưa nối nguồn dữ liệu từ Nhân sự** nên hạn thử việc, hợp đồng sắp hết hạn, giấy phép lao động sắp hết hạn và đơn nghỉ phép chờ duyệt chưa tự nổi lên trang chủ; đồng thời chưa có chấm công trực tiếp trên web/điện thoại (mới nhập CSV), chưa tự trích xuất CV từ PDF khi tuyển dụng, và chưa có kiểm tra thử việc gắn với công việc dự án.

---

## 2. Bảng so sánh thị trường HRM (Việt Nam, Quốc tế và AI-Native)

Ghi chú đọc bảng: cột **Ludy Nhân sự** lấy từ mã thật đã phát hành `v0.3.7`. Giá và tính năng của đối thủ tổng hợp ngày `2026-11-22` từ tài liệu hãng và bản tóm tắt tìm kiếm (`search summary` ở bản tiếng Anh); mục nào chưa có trang chính thức xác nhận ghi rõ `Chưa xác minh`.

### 2.1 Nhóm phần mềm Việt Nam phổ biến nhất

| Tiêu chí | Ludy Nhân sự (`v0.3.7`) | MISA AMIS HRM | Base.vn HRM+ | 1Office HRM | FastWork HRM+ | Tanca AI | Odoo 19 (+ Viindoo VN) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mã nguồn mở và tự cài** | **Có (`AGPL-3.0`)**, trọn bộ `docker compose` | Không (SaaS đám mây) | Không (SaaS đám mây) | Không (SaaS đám mây) | Không (SaaS đám mây) | Không (SaaS đám mây) | Community thiếu Lương, Đánh giá, AI; VN payroll cần gói trả phí `Viindoo` |
| **Hồ sơ, hợp đồng, `01/PLI`** | **Có** (PDF hợp đồng + eSign, Đ46/Đ47, ngoại kiều, `01/PLI`) | **Có** (đầy đủ + danh sách đen nhân sự cũ) | **Có** (vòng đời + đồng bộ giao việc) | **Có** (gắn chữ ký số `1Sign`) | **Có** (kèm quản lý tài sản) | **Có** (kèm hợp đồng điện tử) | **Có** (lịch sử phiên bản hợp đồng; `01/PLI` cần gói VN ngoài) |
| **Chấm công & ca kíp** | **Hạn chế:** nhập CSV từ máy/file, chưa chấm trên web/app | **Mạnh:** GPS, FaceID, vân tay, đa dạng ca | **Mạnh:** Camera AI, GPS, QR, ca gãy bán lẻ/F&B | **Mạnh:** `1AI Timekeeper`, GPS, WiFi, FaceID | **Mạnh (hiện trường):** App GPS + FaceID công trình/chuỗi | **Mạnh:** Camera AI, GPS, WiFi, AI tự xếp ca | Có ở mức chấm công cơ bản/dự án; ca VN cần tùy biến |
| **Nghỉ phép & cổng nhân viên** | **Có:** `/hr/my` xin/hủy phép, duyệt 2 cấp, xem phiếu lương | **Có** (App di động đầy đủ) | **Có** (`Base Me`, nhiều cấp duyệt) | **Có** (Mobile + Web) | **Có** (Mobile + đơn từ) | **Có** (Mobile + Chatbot hỏi phép/lương) | **Có** (nghỉ phép + portal cơ bản) |
| **Tính lương VN, BHXH, TNCN** | **Có** (tháng, giờ, khoán, 13, ốm/thai sản, **chờ #2535**) | **Rất sâu** + `AMIS Bankhub` chi lương trực tiếp | **Tốt** (tự động từ công, duyệt HR->CFO->CEO) | **Tốt** (`1AI Salary`, tính thời gian/khoán/doanh số) | **Tốt** (công thức Excel gắn thẳng điểm KPI) | **Tốt** (công thức từ khóa + chi lương hàng loạt) | **Không sẵn cho VN** (phải cài addon `Viindoo OPL-1`) |
| **Nối sang Kế toán đúng chuẩn VN** | **Có sẵn một cơ sở dữ liệu (`334/338/3335`), giấu lương cá nhân** | **Có sẵn** (bán riêng phân hệ Kế toán) | Yếu (nhóm Tài chính còn hạn chế vs MISA/Ludy) | Kế toán cơ bản nội bộ | Chỉ xuất dữ liệu nối ngoài | Chỉ xuất bảng lương, không có sổ Kế toán | Có ở Enterprise + gói nội địa hóa VN trả phí |
| **Tuyển dụng (ATS) & Đánh giá KPI/OKR** | ATS + lịch phỏng vấn **Có**; OKR/KPI **Chưa** | **Có đủ** (ATS, thi tuyển, KPI/OKR/ASK) | **Có đủ** (`E-Hiring` + `Base Review`) | **Có đủ** (ATS + KPI) | **Có đủ** (`Hiring` + `FastWork KPI`) | ATS & AI lọc CV **Có**; KPI cơ bản | Có ATS (OCR/khớp kỹ năng 0-100%); Đánh giá nằm ở Enterprise |
| **Cách làm AI & Bảo mật** | `Ly` (5 tính năng), ẩn tên thật (`P1`/`C1`), tắt AI vẫn chạy, có đồng hồ đo chi phí | `MISA AVA`: soạn JD, quét/dịch CV, gợi ý KPI, cảnh báo bất thường lương | `Base Agentic OS`: quét sai lệch lương, cảnh báo hợp đồng, Chatbot hỏi đáp | `1AI`: rà soát công/lương, Chatbot nội bộ, tự động duyệt | Tập trung FaceID AI; AI sinh nội dung chuyên sâu **Chưa xác minh** | **Mạnh nhất nhóm VN về AI:** Chatbot 24/7, Compliance AI luật LĐ, AI xếp ca | `Ask Odoo AI`: hỏi đáp số liệu lương tự nhiên (chỉ bản Enterprise) |
| **Giá tham khảo (2026)** | Tự cài: **0đ bản quyền**; chưa có giá Ludy Cloud | ~5,76M - 14,4M đ/năm theo phân hệ (30-100 người) + phí triển khai | Từ ~450k đ/tháng hoặc ~12,6M - 21M+ đ/năm/30 user; gói AI cao ~149k-169k đ/user/tháng | ~40k-150k đ/user/tháng (`1HRM` từ ~60k) + **5M-30M+ đ phí triển khai** | ~10k đ (chấm công) tới ~100k đ/user/tháng (`SME+`) + **2M-10M+ đ cài đặt** | Miễn phí bản khởi đầu; **Mua trọn đời lõi** (+10%/năm); gói AI từ ~500k-647k đ/tháng+ | ~$13,4 - $24,9/user/tháng (Enterprise) + phí đối tác VN |

### 2.2 Nhóm phần mềm HRM SME hàng đầu thế giới và Nhóm AI-Native mới nổi

| Nhóm & Tên | Trọng tâm nổi bật | Điểm AI xuất sắc nhất | Giá tham khảo (2026) | Bài học cho Ludy / Điểm tránh |
| :--- | :--- | :--- | :--- | :--- |
| **Rippling** *(Quốc tế)* | Nối HRIS + Lương toàn cầu (50+ nước) + Cấp phát máy tính/tài khoản IT + Chi tiêu công ty trên 1 đồ thị nhân sự. | **Rippling AI:** Hỏi đáp dữ liệu sống có **trích dẫn bấm về hồ sơ gốc** và giữ đúng phân quyền; kéo thả file Excel bảng thưởng thành luồng duyệt lương (**Spreadsheet-to-Action**). | Từ ~$8/người/tháng bản nền + cộng thêm từng phân hệ; EOR ~$499/tháng. | **Học:** trích dẫn nguồn + kéo file bảng tính thành hành động kiểm lỗi. **Tránh:** quản trị phần cứng IT ngoài phạm vi SME Việt. |
| **Deel** *(Quốc tế)* | Thuê nhân sự xuyên biên giới (EOR 130+ quốc gia), cộng tác viên toàn cầu, gom bảng lương đa quốc gia. | **Deel AI:** kiểm tra tuân thủ luật lao động từng nước, tự soạn hợp đồng theo quốc gia, sàng lọc tuyển dụng & đặt lịch phỏng vấn. | HR cơ bản miễn phí/từ ~$5; CTV ~$49; Global Payroll ~$29; EOR ~$599/người/tháng. | **Học:** kiểm soát hồ sơ tuân thủ theo từng loại lao động (chính thức vs CTV vs ngoại kiều). **Tránh:** EOR đa quốc gia đắt đỏ. |
| **BambooHR** *(Quốc tế)* | Chuẩn mực trải nghiệm đơn giản cho SME 20-300 người (Mỹ): hồ sơ, phép, onboarding, ATS, eNPS. | **Bamboo AI:** trợ lý trả lời chính sách HR, xếp ca, xuất báo cáo nhanh và rà lỗi trước kỳ lương. | Giá công khai: ~$10/$17/$25/người/tháng (`$250-$650/tháng` tối thiểu dưới 25 người). | **Học:** giao diện tự phục vụ tối giản và gói onboarding không rối rắm. |
| **HiBob** *(Quốc tế)* | Nền tảng văn hóa & quản trị thù lao cho SME đang tăng trưởng; mô phỏng quỹ lương & xem trước kỳ lương liên tục. | **Bob AI Companion:** tích hợp Slack/Teams trả lời đúng quyền người hỏi, cam kết không lưu dữ liệu & không huấn luyện AI công khai. | Báo giá riêng theo quy mô. | **Học:** màn **xem trước biến động lương theo thời gian thực** trước ngày chốt kỳ lương. |
| **Warp** (`warp.co`, *AI-Native*) | Lương & tuân thủ thuế startup/SME Mỹ; giải quyết lớp thủ tục nhà nước. | **Warp Agent:** tự đăng ký tài khoản thuế khi tuyển vùng mới, rà lỗi bảng lương và **tự xử lý các thông báo/khiếu nại thuế định kỳ** (có chuyên gia thuế hỗ trợ + bảo hiểm $1M). | ~$19-$35/người/tháng, miễn phí thiết lập ban đầu. | **Học:** cảnh báo sớm thủ tục nhà nước (hạn khai `01/PLI`, hạn đăng ký mã BHXH, hết hạn giấy phép lao động) ngay trên `Vy Hôm nay`. |
| **Ashby** *(AI-Native Tuyển dụng)* | ATS + CRM ứng viên + Tự động đặt lịch + Phân tích phễu tuyển dụng (BI) sâu nhất phân khúc. | Tìm ứng viên bằng ngôn ngữ tự nhiên tự sinh bộ lọc; cá nhân hóa chuỗi email tuyển dụng; thống kê tỷ lệ rớt từng vòng & thời gian tuyển. | ~$300-$400/tháng gói `<100` nhân sự; không có bản miễn phí. | **Học:** chỉ số phễu tuyển dụng tính bằng SQL quyết định (`thời gian tuyển`, `tỷ lệ chuyển vòng`, `hiệu quả nguồn`) trong màn Tuyển dụng. |
| **Lattice AI** *(AI-Native Hiệu suất)* | Đánh giá hiệu suất, OKR, lương thưởng & gắn kết (**đã rút khỏi mảng HRIS/tính lương gốc** để tập trung vào hiệu suất). | AI tổng hợp ghi chú 1:1, góp ý & mục tiêu thành nháp nhận xét kỳ đánh giá; AI phân tích xu hướng khảo sát nội bộ. | $4-$13/người/tháng, tối thiểu hợp đồng **$4.000/năm**. | **Học:** gom việc đã xong ở `Ludy Công tác` làm bằng chứng khi **đánh giá hết thử việc** (nhưng con người tự chấm điểm theo Luật AI `134/2025/QH15`). |
| **Paradox (Olivia)** *(AI-Native, đã bị Workday mua ~$1B)* | Tuyển dụng số lượng lớn qua tin nhắn (bán lẻ, F&B, kho vận). | Ứng viên ứng tuyển qua SMS/WhatsApp/Messenger/QR không cần điền form dài; Olivia sàng lọc tiêu chuẩn 24/7 và tự đặt lịch phỏng vấn vào lịch quản lý. | Đặt riêng doanh nghiệp (từ ~$1.000/tháng; trung vị ~$87.500/năm). | **Học:** tận dụng kênh **`Zalo OA` / `Facebook` đã có sẵn của Ludy Engage** để nhận hồ sơ ứng viên và chốt lịch phỏng vấn, còn quyết định tuyển vẫn thuộc về người duyệt. |

---

## 3. Lợi thế riêng và khoảng trống thực tế của Ludy Nhân sự

**Ludy đang giữ lợi thế khó sao chép ở 3 điểm:**
1. **Lương và Kế toán Việt Nam chung một hệ thống đúng chuẩn bảo mật:** ngoài MISA AMIS (phải mua tách nhiều phân hệ trả phí hằng năm), các phần mềm Việt khác đều yếu sổ sách kế toán `TT133`/`TT99`, còn phần mềm quốc tế không hỗ trợ `BHXH`, `TNCN`, `01/PLI`, `D02-LT`. Ludy tự động đẩy bút toán tổng hợp sang Kế toán mà vẫn giữ bí mật tuyệt đối lương từng nhân viên.
2. **Kiến trúc AI an toàn trước Luật Dữ liệu cá nhân `91/2025/QH15` và Luật AI `134/2025/QH15`:** tự cài dữ liệu tại doanh nghiệp, ẩn danh mã nhân viên/ứng viên trước khi gọi mô hình, không cho AI tự duyệt tiền hay tự loại ứng viên (tránh vi phạm quy định giám sát con người của Luật AI `134/2025/QH15`), và hỗ trợ xóa dữ liệu cá nhân kèm hủy khóa mã hóa khi hết hạn lưu trữ.
3. **Không bị khóa theo phí đầu người hằng tháng:** doanh nghiệp vừa khởi sự hoặc có 30-100 nhân sự thường chịu tổng chi phí `15-100 triệu đồng/năm` bên ngoài khi ghép đủ chấm công, tính lương, tuyển dụng và AI.

**5 điểm Ludy hiện tụt lại so với thị trường:**
1. **Nhân sự chưa xuất hiện trên màn `Hôm nay` (`Vy`):** chưa tự nhắc hết thử việc, hết hợp đồng, sắp hết hạn giấy phép lao động, kỳ báo cáo `01/PLI` hay đơn nghỉ phép đang chờ duyệt.
2. **Chấm công mới qua tệp CSV:** chưa có thao tác check-in/out nhanh trên web hoặc điện thoại (PWA) và đơn xin làm thêm giờ (`OT`) ngay trên cổng `/hr/my`.
3. **Tuyển dụng chưa đọc PDF CV tự động và chưa nối luồng nhận hồ sơ qua Zalo/Facebook:** vẫn phải gõ tay hồ sơ ứng viên và chưa có biểu đồ đo thời gian/tỷ lệ qua vòng tuyển dụng.
4. **Chưa có màn xem trước "Tháng này khác gì tháng trước" liên tục trước khi chốt lương** (tất cả chênh lệch hợp đồng, tăng/giảm công, OT mới tập trung trong nháp kỳ chạy cuối tháng) và chưa gửi phiếu lương qua email (`#2539` đang chờ luật sư `#2536`).
5. **Chưa có kiểm tra hết thử việc và đánh giá định kỳ gọn nhẹ** gắn với công việc đã hoàn thành bên `Ludy Công tác`.

---

## 4. Đề xuất Giai đoạn 5 (Chờ chủ sở hữu duyệt trước khi mở việc)

Mọi mục dưới đây đã lọc qua bộ lọc SME Việt Nam (`scope.md`): việc làm ít nhất hằng tháng, tự chạy không cần phần cứng/tài khoản ngoài, tắt AI vẫn dùng 100%, và đúng Luật `91/2025` + Luật `134/2025`:

1. **5A - Đưa cảnh báo Nhân sự lên màn `Hôm nay` (`Vy`)** *(làm nhanh nhất, giá trị ngay)*: thêm `hr` vào luồng `Hôm nay` để tự nhắc (bằng quy tắc tính toán thuần túy, 0 tốn phí AI): hết hạn thử việc (`<= 7 ngày`), hợp đồng sắp hết hạn (`<= 30 ngày`), giấy phép lao động ngoại kiều sắp hết hạn, kỳ nộp `01/PLI`, và số đơn nghỉ phép chờ trưởng phòng/chủ doanh nghiệp duyệt.
2. **5B - Mở rộng cổng `/hr/my`: Onboarding nhanh, đơn Tăng ca (`OT`) và Đánh giá hết thử việc:** nhân viên tự bổ sung thông tin nhận việc/tài khoản ngân hàng (chờ duyệt); gửi đơn xin tăng ca (`OT`) qua quy trình duyệt 2 cấp nối thẳng vào hệ số lương tháng; trưởng phòng đánh giá hết thử việc có `Ly` tóm tắt việc đã xong từ `Ludy Công tác` (người duyệt quyết định ký chính thức hay không).
3. **5C - Chấm công Web/PWA 1 chạm và mã QR tại văn phòng (tránh sinh trắc học nặng nề):** nhân viên bấm chấm công vào/ra trên trình duyệt hoặc điện thoại, tự tổng hợp công cuối tháng thay thế khâu nhập tay CSV, không lưu dữ liệu khuôn mặt `FaceID` để tránh gánh nặng pháp lý dữ liệu nhạy cảm theo Luật `91/2025/QH15`.
4. **5D - Bóc tách CV PDF bằng `Ly` + Kết nối hồ sơ từ Zalo/Facebook (`Ludy Engage`) + Chỉ số phễu Tuyển dụng:** tải CV PDF/DOCX lên để `crove-extract` + `Ly` đề xuất điền sẵn biểu mẫu (người bấm lưu, tuyệt đối không cho AI tự loại ứng viên); tận dụng kênh `Zalo OA`/`Facebook` của `Ludy Engage` để hẹn slot phỏng vấn; tính sẵn thời gian tuyển và tỷ lệ rớt từng vòng.
5. **5E - Màn đối chiếu "Biến động trước chốt lương" theo thời gian thực + Gỡ các cổng chờ:** hiển thị ngay các thay đổi công, OT, lương, người mới so với tháng trước kèm một dòng giải thích của `Ly`; đồng thời xử lý các tinh chỉnh nhỏ ở [#4351](https://github.com/DOS/Ludy/issues/4351) và mở khóa [#2539](https://github.com/DOS/Ludy/issues/2539) / XML HTKK ngay khi nhận xác nhận từ kế toán ([#2535](https://github.com/DOS/Ludy/issues/2535)) và luật sư ([#2536](https://github.com/DOS/Ludy/issues/2536)).

**Các mảng khuyến nghị giữ ở `Icebox` (không làm ở Giai đoạn 5 để giữ sản phẩm gọn cho SME Việt Nam):**
- Thuê lao động nước ngoài qua pháp nhân đại diện (`EOR`) đa quốc gia kiểu `Deel` / `Rippling`.
- Quản lý cấp phát laptop/MDM kiểu `Rippling IT` / `Warp IT`.
- Chấm công phần cứng camera `FaceID` và chia ca nhà máy/F&B hàng nghìn công nhân.
- AI tự động loại hồ sơ hoặc tự quyết định tăng lương/sa thải không qua người duyệt.
- Hệ thống đào tạo doanh nghiệp (`LMS`) và đánh giá năng lực 360 độ phức tạp kiểu tập đoàn lớn.
