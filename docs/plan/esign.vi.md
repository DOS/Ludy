# Kế hoạch Ludy eSign (`Ký kết` / `sign`)

- **Trạng thái:** Bản kế hoạch nháp (2026-11-15)
- **Epic:** https://github.com/DOS/Ludy/issues/3318
- **Issue kế hoạch:** https://github.com/DOS/Ludy/issues/3319
- **Mốc triển khai / Mức ưu tiên:** `M3 Paid pilot` / `priority:P2`
- **Tài liệu kỹ thuật chi tiết (tiếng Anh):** [esign.md](esign.md)
- **Tài liệu nền tham chiếu:** [scope.md](../product/scope.md), [competitors.md](../product/competitors.md), [crove-os-kernel.md](crove-os-kernel.md), [meetings.vi.md](meetings.vi.md), [DESIGN.md](../../DESIGN.md), [ADR-0013](../adr/0013-evidence-storage-and-integrity.md), [ADR-0018](../adr/0018-untrusted-content.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0034](../adr/0034-outbound-email.md), [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md), [ADR-0053](../adr/0053-per-org-app-enablement.md)

## Các quyết định đã chốt của JOY (2026-11-15)

1. **Loại chữ ký (Giai đoạn 1 so với Giai đoạn 2):** Giai đoạn 1 (Slice 1) tự xây dựng hoàn chỉnh chữ ký điện tử kiểu Documenso (vẽ tay hoặc gõ tên tạo chữ ký, tùy chọn xác thực mã OTP qua email, niêm phong PDF chống sửa bằng mã băm `SHA-256` và xuất chứng nhận đối chiếu độc lập). Toàn bộ quy trình chạy 100% nội bộ khi khởi động `docker compose up`, không phụ thuộc nhà cung cấp bên ngoài hay khóa trả phí nào. Giai đoạn 2 (Slice 2) mới mở rộng qua cổng kết nối có thể thay thế cho các nhà cung cấp chữ ký số công cộng tại Việt Nam (VNPT SmartCA, Viettel MySign, MISA WeSign).
2. **Vị trí ứng dụng và trợ lý AI:** Ludy eSign là một ứng dụng độc lập mang tên **Ký kết** (`eSign`) trong thanh chuyển ứng dụng, bật hoặc tắt riêng cho từng tổ chức ([ADR-0031](../adr/0031-module-enablement.md), [ADR-0053](../adr/0053-per-org-app-enablement.md)). **Vy** (`gm`, trợ lý dùng chung toàn Ludy theo [DESIGN.md](../../DESIGN.md) mục 1.1) đọc tệp PDF tải lên, gợi ý vị trí đặt khung chữ ký và tóm tắt điều khoản quan trọng hoặc nhiều rủi ro qua đồng hồ đo ngân sách AI (`packages/agent`). Khi tắt AI, việc ký kết thủ công vẫn hoạt động giống hệt và người dùng luôn phải tự duyệt khung, bấm nút gửi trước khi gửi đi.
3. **Phạm vi Giai đoạn 1:** Tải tệp PDF lên, đặt ô cần điền (có gợi ý của Vy), tạo đường dẫn ký để chép gửi qua Zalo/tin nhắn hoặc gửi email tự động cho 1 hoặc nhiều người ký (ký song song hoặc theo thứ tự), trang ký công khai thân thiện trên điện thoại (mã khóa đặt sau dấu `#` trong URL, chặn trình duyệt rò nguồn giới thiệu qua `Referrer-Policy: no-referrer`, từ chối dùng lại đường dẫn sau khi đã ký, tùy chọn OTP email, **không gắn CAPTCHA bắt buộc** theo quyết định `#203`), và xuất bản PDF đã niêm phong kèm chứng nhận kiểm toán lưu trong kho bằng chứng chung ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md)). Kho mẫu tài liệu dùng lại và luồng đẩy trực tiếp từ báo giá Engage hoặc hợp đồng Nhân sự được tách sang Giai đoạn 2.

---

## 1. Phù hợp với OPC / SME Việt Nam & So sánh đối thủ

### 1.1 Việc ký kết hằng tháng của doanh nghiệp nhỏ

Một công ty một thành viên (OPC) hoặc doanh nghiệp vừa và nhỏ (SME) ở Việt Nam thường xuyên phải xử lý ít nhất vài lần mỗi tháng các giấy tờ dễ bị kẹt ở khâu in - ký - chụp ảnh hoặc gửi qua lại khó kiểm chứng trên Zalo:

- **Hợp đồng thương mại và thỏa thuận bảo mật (NDA):** hợp đồng dịch vụ, thuê ngoài, triển khai phần mềm gửi khách hàng B2B.
- **Biên bản nghiệm thu, bàn giao:** chốt khối lượng công việc để bên kế toán xuất hóa đơn và ghi nhận doanh thu.
- **Hợp đồng nhà cung cấp, thuê văn phòng, cộng tác viên:** ký gọn với đối tác không cần dùng phần mềm kế toán phức tạp.

### 1.2 Kiểm tra theo cổng phạm vi ([scope.md](../product/scope.md))

- **Đúng nhu cầu hằng tháng:** tập trung 1 đến 5 người ký trên mỗi bộ hồ sơ. Các tính năng cồng kềnh cho tập đoàn (quản trị hạ tầng khóa công khai đa chi nhánh, bắt người ký đăng nhập SSO doanh nghiệp, gửi thư trộn hàng nghìn người một lúc) được xếp ngoài phạm vi / Icebox.
- **Lát cắt nhỏ nhất dùng được ngay:** chạy `docker compose up` là dùng được luôn, không cần tài khoản bên thứ ba. Một người chỉ cần tải PDF lên, đặt 1 khung chữ ký, sao chép link dán sang Zalo để đối tác ký trên điện thoại và tải về bản niêm phong kèm chứng nhận.
- **AI rõ vai trò và không bắt buộc:** Vy gợi ý vị trí khung và lọc điều khoản đáng chú ý dưới dạng `"Đề xuất"` qua đồng hồ đo chi phí; mọi thao tác thủ công đều chạy đầy đủ ngay cả khi tắt AI.

### 1.3 So sánh nhanh với thị trường ([competitors.md](../product/competitors.md))

| Tiêu chí | Documenso (Mã nguồn mở) | Docusign | MISA WeSign (VN) | Ludy Ký kết (`sign`) |
| :--- | :--- | :--- | :--- | :--- |
| **Tự chạy bằng `docker compose up`** | Có (cần tự cấu hình SMTP/đăng nhập) | Không (chỉ có bản cloud trả phí) | Không (cloud theo tài khoản MISA) | **Có sẵn 100%**, dùng chung hệ thống email và lưu trữ của Ludy |
| **Gửi link qua Zalo / chat** | Thiên về email | Thiên về email | Email / SMS / thông báo app | **Ưu tiên sao chép link Zalo** ngang hàng với gửi email, mở mượt trên điện thoại (`375px`+) |
| **Chống sửa & chữ ký số VN** | Đóng khung PDF, có tùy chọn chứng thư số | Chứng nhận cloud riêng | Chữ ký số công cộng VN | **Slice 1:** Niêm phong băm `SHA-256` + chứng nhận kiểm toán nối chuỗi; **Slice 2:** Cổng VNPT SmartCA, Viettel MySign, MISA WeSign |
| **Trợ lý đọc hợp đồng** | Chưa có sẵn | Gói doanh nghiệp tốn phí thêm | Chưa có ở gói cơ bản | **Vy** gợi ý ô ký và cảnh báo điều khoản rủi ro qua đồng hồ đo ngân sách |

---

## 2. Cấu trúc dữ liệu (`crove_sign`) & Lưu giữ bằng chứng

Toàn bộ dữ liệu nằm trong lược đồ riêng `crove_sign` của PostgreSQL, tuân thủ nguyên tắc mỗi bảng nghiệp vụ đều có `org_id`, khóa chính ghép `(org_id, id)`, khóa cách ly dữ liệu theo tổ chức (Row-Level Security) và không tạo khóa ngoại cứng sang mô-đun khác.

### 2.1 Các bảng chính trong Giai đoạn 1

- **`crove_sign.envelope` (Hồ sơ ký):** đại diện một bộ tài liệu gửi ký. Lưu tiêu đề, tin nhắn, trạng thái (`draft`, `sent`, `partially_signed`, `completed`, `declined`, `voided`, `expired`), chế độ ký (`parallel` song song hay `sequential` tuần tự), nguồn tham chiếu lỏng (`standalone`, sang Slice 2 thêm `crm_quote` / `hr_contract`), thông tin kiểm tra tệp gốc (số trang, kích thước từng trang tính bằng point PDF), mã băm `SHA-256` tệp gốc, và bộ thông tin niêm phong sau khi ký xong (tệp PDF đã niêm phong, tệp chứng nhận, mã tra cứu `SIG-2026-...`).
- **`crove_sign.signer` (Người ký):** thông tin từng người ký, thứ tự ký (`routing_order`), vai trò (`Bên A`, `Bên B`), kênh gửi (`link` để sao chép sang Zalo hoặc `email`), cờ bật xác thực OTP qua email (`require_email_otp`), trạng thái (`waiting`, `pending`, `viewed`, `signed`, `declined`), hình thức ký (`draw` hay `type`), mã băm IP người ký (tránh lưu IP thô) và trình duyệt lúc ký. Nếu người gửi chỉ gửi link qua Zalo và không bật OTP thì không bắt buộc nhập email.
- **`crove_sign.field` (Ô điền trên trang PDF):** loại ô (`signature`, `initial`, `date`, `text`, `checkbox`), số trang và tọa độ chuẩn hóa trong đoạn `[0, 1]` theo bề rộng/cao trang để đặt chính xác giữa màn hình trình duyệt và lúc đóng dấu PDF. Lưu ảnh PNG chữ ký (đã kiểm định dung lượng và định dạng) cùng giá trị văn bản/ngày khi hoàn tất.
- **`crove_sign.ai_analysis` (Kết quả nháp từ Vy):** lưu danh sách khung gợi ý và tóm tắt điều khoản rủi ro gắn với đúng mã băm tệp PDF gốc (`source_sha256`). Dữ liệu ở đây chỉ là gợi ý nháp, chưa phải ô ký chính thức cho đến khi người dùng bấm áp dụng.
- **`crove_sign.signing_token` (Thẻ mở link ký):** **không bao giờ lưu chuỗi token thật vào cơ sở dữ liệu**; bảng chỉ lưu mã băm một chiều (`token_sha256`), hạn dùng, thời điểm thu hồi (`revoked_at`) và thời điểm đã sử dụng (`used_at`). Có bẫy chặn cấp cơ sở dữ liệu (`trigger`) đảm bảo mỗi thẻ chỉ được đánh dấu đã dùng đúng một lần duy nhất và không thể mở lại.
- **`crove_sign.signing_otp` (Mã OTP xác thực email):** lưu mã OTP 6 chữ số dưới dạng mã băm một chiều, thời hạn 10 phút, tối đa 5 lần nhập sai. Mã OTP thật được sinh ngay tại thời điểm bộ phát thư chuẩn bị gửi email nên hàng đợi công việc nền cũng không lưu mã thô.
- **`crove_sign.signing_event` (Nhật ký bằng chứng nối chuỗi):** ghi lại từng bước từ tạo hồ sơ, mở link, gửi/nhập OTP, ký, từ chối đến niêm phong. Mỗi dòng nối đuôi mã băm của dòng trước đó (kiểu sổ cái chỉ cho thêm mới, cấm tuyệt đối lệnh sửa hoặc xóa).

### 2.2 Bảng dự phòng cho Giai đoạn 2 (Slice 2)

- `template`, `template_role`, `template_field`: lưu mẫu hợp đồng hay dùng để tạo nhanh bộ hồ sơ ký mới.
- `ca_connection`, `ca_signing_request`: lưu cấu hình tài khoản chữ ký số công cộng của từng tổ chức (khóa bí mật mã hóa theo chuẩn chung của kernel) và nhật ký đối soát giao dịch ký số từ xa (`VNPT SmartCA`, `Viettel MySign`, `MISA WeSign`).

### 2.3 Phân loại dữ liệu cá nhân, xóa dữ liệu & điểm cần luật sư chốt

- Dữ liệu nháp chưa gửi hoặc đã hủy, cùng thẻ link và mã OTP hết hạn quá 30 ngày sẽ được việc nền ban đêm (`sign-cleanup`) tự động dọn sạch.
- Với hồ sơ **đã ký hoàn tất**, tên người ký, ảnh chữ ký, tệp PDF niêm phong và nhật ký kiểm toán được xếp vào nhóm cần bảo toàn làm bằng chứng (`keep_legal` trong cấu hình dữ liệu cá nhân).
- **`[commentary]` Đầu việc cần luật sư `#62` rà soát trước khi chạy pilot thu phí:** kiểm tra theo **Luật Giao dịch điện tử 20/2023/QH15**, **Nghị định 23/2025/NĐ-CP** và **Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 / Nghị định 356/2025/NĐ-CP** về hai điểm: (a) phạm vi loại hợp đồng SME được dùng chữ ký điện tử đơn giản ở Slice 1 so với các loại chứng từ bắt buộc chữ ký số công cộng ở Slice 2, và (b) câu chữ cam kết đồng ý giao dịch điện tử + thời hạn lưu giữ tối thiểu để hợp thức hóa quy tắc không tự ý xóa bằng chứng hợp đồng đã ký.

---

## 3. Luồng lệnh một cửa & Bật/tắt theo từng tổ chức

Mọi thay đổi dữ liệu đều đi qua một cửa ghi duy nhất `Runtime.execute()` của `packages/kernel-runtime` để tự động ghi kiểm toán WORM và bảo vệ ranh giới giữa các tổ chức.

- **Các lệnh phía người gửi (đã đăng nhập):** tạo hồ sơ (`sign.envelope.create`), sửa thông tin nháp, thêm/xóa người ký, lưu danh sách ô ký (`sign.field.replace_all`), yêu cầu hoặc áp dụng gợi ý của Vy (`sign.ai.analyze`, `sign.ai.apply_proposals`), bấm gửi chính thức (`sign.envelope.send` - chỉ người dùng thật mới gọi được, khóa cứng tệp và các ô ký), tạo đường link Zalo dùng ngay (`sign.signer.create_link` - trả link thật duy nhất một lần lúc bấm tạo), gửi nhắc ký và hủy hồ sơ (`void`).
- **Các lệnh từ trang ký công khai (`sign.public.*`):** người ký ngoài hệ thống không có phiên đăng nhập; máy chủ nhận mã link trong thân `POST`, dùng hàm tra cứu hẹp ở mức nền (`runtime.orgless`) chỉ nhận mã băm link để xác định đúng tổ chức và kiểm tra tổ chức đó có đang bật ứng dụng **Ký kết** không ([ADR-0053](../adr/0053-per-org-app-enablement.md)). Nếu link sai, hết hạn, đã ký, hoặc công ty đã tắt ứng dụng, hệ thống đều trả chung một lỗi `404` giống hệt nhau để tránh dò thông tin khách hàng.
- **Tác vụ nền (`work` so với `keeping` theo [ADR-0053](../adr/0053-per-org-app-enablement.md)):**
  - Nhóm việc nghiệp vụ (`work`, tự dừng khi tổ chức tắt app): kiểm tra PDF (`sign-pdf-inspect`), chạy Vy (`sign-ai-analyze`), niêm phong PDF (`sign-pdf-seal`).
  - Nhóm dọn dẹp / giữ vệ sinh (`keeping`, vẫn chạy cả khi tổ chức đã tắt app): quét hồ sơ quá hạn để thu hồi các link chưa ký (`sign-expire-sweep`), dọn thẻ link và OTP hết hạn quá 30 ngày (`sign-cleanup`).

---

## 4. Lưu trữ bằng chứng, Niêm phong PDF & Cổng chữ ký số

1. **Tách biệt khỏi luồng đọc hóa đơn kế toán:** thêm mục đích tải lên riêng (`sign_document`, `sign_sealed`, `sign_certificate`) trong kho tệp chung [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) nhưng giữ nguyên danh sách nguồn hóa đơn tài chính (`isDocumentSource`), nhờ vậy hợp đồng tải lên Ký kết không bị bộ OCR kế toán đem đi bóc tách nhầm.
2. **Cách ly xử lý tệp PDF không đáng tin ([ADR-0018](../adr/0018-untrusted-content.md)):** quy tắc kiểm tra mã nguồn của Ludy cấm đưa các thư viện đọc/ghi PDF vào kernel hay các mô-đun nghiệp vụ. Toàn bộ hai bước:
   - **`pdf_inspect` (kiểm tra đầu vào):** chạy trong thùng chứa cô lập `crove-extract` (không nối mạng internet, không giữ khóa bí mật, giới hạn 25 MiB và 25 giây). Bước này kiểm tra định dạng PDF, chặn tệp có mã nhúng JavaScript nguy hiểm hoặc khóa mật khẩu ở Slice 1, lấy chính xác số trang, kích thước từng trang và phần chữ phục vụ Vy.
   - **`pdf_seal` (niêm phong đầu ra):** khi người ký cuối hoàn tất, kernel đọc lại tệp gốc đã xác thực đúng mã băm `SHA-256` cùng ảnh chữ ký PNG và dữ liệu chữ viết đã điền, chuyển sang `crove-extract` để vẽ cố định (flatten) chữ ký và phông chữ tiếng Việt (`Be Vietnam Pro`) thẳng vào nội dung trang PDF (xóa bỏ trạng thái ô nhập sửa được), đồng thời nối thêm ở cuối tệp một trang **Chứng nhận ký kết điện tử** ghi mã tra cứu, mã băm bản gốc, danh sách người ký, thời gian theo múi giờ Việt Nam, trạng thái OTP và mã băm đỉnh của chuỗi nhật ký. Kernel lưu lại tệp PDF đã niêm phong cùng tệp JSON chứng nhận độc lập.
3. **Kiểm tra toàn vẹn không cần tin tưởng máy chủ:** bất kỳ kế toán, đối tác hay cơ quan kiểm tra nào cũng có thể tự tính mã `SHA-256` của bản PDF trên máy mình (hoặc dùng màn hình **Kiểm tra tệp** ngay trên trình duyệt mà không cần tải tệp nhạy cảm lên mạng) để đối chiếu khớp từng byte với chứng nhận đối chiếu.
4. **Cổng chữ ký số công cộng Việt Nam ở Slice 2 (`packages/sign`):** thiết kế theo khuôn mẫu `@crove/einvoice`, định nghĩa giao diện chuẩn cho `VNPT SmartCA`, `Viettel MySign`, `MISA WeSign` với cơ chế đối soát an toàn khi mạng chập chờn (`reconcile_only`, tránh ký hoặc trừ lượt hai lần). Kernel gọi API nhà cung cấp để lấy chữ ký số CMS/dấu thời gian, rồi gửi về `crove-extract` nhúng vào PDF theo chuẩn PAdES-LTV, giữ nguyên nguyên tắc `crove-extract` không bao giờ tự ra mạng.

---

## 5. Bảo mật đường link ký công khai (`/-/sign#<token>`)

Kế thừa cơ chế link báo giá bảo mật đang chạy ở `quote-document.tsx` và `review-link.ts`:

- **Token nằm sau dấu `#`:** địa chỉ gửi người ký có dạng `https://<tên-miền>/-/sign#<mã-khóa>`. Mã khóa 32 byte ngẫu nhiên không nằm ở đường dẫn hay dấu `?`, nên máy chủ web hay trang web trung gian không ghi lọt vào nhật ký truy cập hoặc tiêu đề `Referer`. Ngay khi trang mở ra, trình duyệt giữ mã trong bộ nhớ, xóa phần `#...` khỏi thanh địa chỉ và gửi mã qua thân `POST` với `Referrer-Policy: no-referrer`, `credentials: 'omit'`.
- **Khóa đúng thứ tự ký (tuần tự):** nếu hồ sơ cấu hình ký lần lượt (người 1 ký xong mới đến người 2), máy chủ không trả tệp PDF và không hiển thị danh sách người khác khi người ký vẫn ở trạng thái chờ lượt (`waiting`).
- **Tùy chọn OTP qua email (chống lộ link khi chuyển tiếp nhầm trên Zalo):** khi bật tùy chọn này, mở link chỉ thấy màn hình nhập mã 6 số gửi về email đúng của người ký (hiện email đã che một phần, ví dụ `a***@congty.vn`). Trước khi nhập đúng OTP, máy chủ tuyệt đối không cho tải tệp PDF.
- **Chống dùng lại (single-use replay rejection):** câu lệnh xác nhận ký `UPDATE ... WHERE used_at IS NULL` chạy ngay trong giao dịch khóa dữ liệu; nếu bấm gửi đúp hoặc dùng lại link cũ sau khi đã ký xong, hệ thống từ chối ngay.
- **Chữ ký an toàn (cấm SVG):** nét vẽ tay trên canvas hoặc tên gõ đều được chuẩn hóa thành ảnh PNG có kiểm tra định dạng và dung lượng (tối đa 256 KB), từ chối hoàn toàn tệp SVG để triệt tiêu nguy cơ chèn mã độc XSS.
- **Không dùng CAPTCHA bắt buộc (quyết định `#203`):** người dùng tự cài bằng `docker compose up` hoặc bộ kiểm thử tự động có thể ký trơn tru không bị vướng ô kiểm tra robot bên ngoài; chống lạm dụng dựa vào giới hạn tần suất theo IP/mã link và OTP email tùy chọn.

---

## 6. Trợ lý AI Vy & Đồng hồ đo ngân sách

- Dùng đúng nhân vật trợ lý dùng chung **Vy** (`gm`), không tạo thêm tên trợ lý mới.
- Đăng ký hai tính năng vào bảng theo dõi chi phí `AI_FEATURES` trong `packages/agent`: `sign.field_propose` (gợi ý đặt ô chữ ký, ngày ký, tên) và `sign.clause_summary` (tóm tắt nội dung chính và các điều khoản dễ gây bất lợi kèm số trang + câu trích nguyên văn).
- Toàn bộ chữ trích ra từ PDF hợp đồng của đối tác được coi là dữ liệu không đáng tin ([ADR-0018](../adr/0018-untrusted-content.md)): Vy chạy ở chế độ không có công cụ hành động (`tools: []`), kết quả trả về được bộ kiểm tra bằng mã lệnh thường rà lại số trang, tọa độ `[0, 1]` và xác minh câu trích thực sự nằm trong văn bản trước khi hiển thị.
- Mọi ô do Vy gợi ý mang nhãn nổi bật `"Đề xuất"`; người dùng phải xem và bấm chấp nhận, và Vy **không bao giờ** có quyền tự gửi hồ sơ. Khi tắt AI hoặc dùng hết hạn mức, toàn bộ quy trình gửi ký tay vẫn chạy hoàn hảo.

---

## 7. Giao diện & Trải nghiệm ([DESIGN.md](../../DESIGN.md))

- Bổ sung ứng dụng **Ký kết** (`eSign`) vào thanh chuyển ứng dụng của hệ thống, tuân thủ bảng màu semantic OKLCH, phông chữ tiếng Việt `Be Vietnam Pro` (và `JetBrains Mono` cho mã `SHA-256` / mã chứng nhận), menu gọn trong chiều cao `1366x768`: **Hồ sơ ký**, **Kiểm tra tệp** (và Slice 2 thêm **Mẫu tài liệu**).
- **Danh sách hồ sơ ký (`/sign/envelopes`):** lọc theo trạng thái (`Nháp`, `Đang chờ ký`, `Hoàn tất`, `Từ chối / Hết hạn`), bấm một lần để chép link gửi Zalo, gửi nhắc hoặc tải bản đã niêm phong.
- **Màn hình đặt khung (`/sign/envelopes/:id`):** cột trái chọn người ký, thứ tự ký và bật/tắt OTP; vùng giữa hiển thị PDF rõ nét (dùng bộ dựng thuần JS, không đóng gói tệp `.wasm` vào bản build để vượt qua bước kiểm tra container); các gợi ý của Vy hiện viền nét đứt màu `proposal` chờ duyệt.
- **Màn hình ký công khai (`/-/sign#<token>`):** thiết kế ưu tiên điện thoại (`375px`+), đọc hợp đồng dễ trên trình duyệt tích hợp của Zalo, thanh nổi báo số ô còn thiếu và nhảy nhanh đến ô tiếp theo, vẽ ngón tay mượt hoặc gõ tên với phông tiếng Việt rõ dấu, hộp tích đồng ý giao dịch điện tử trước nút **Hoàn tất ký**.
- **Màn hình kiểm tra tệp (`/sign/verify`):** kéo thả tệp PDF để trình duyệt tự tính `SHA-256` tại chỗ và báo xanh **Toàn vẹn** hoặc đỏ **Đã bị thay đổi**.

---

## 8. Lộ trình chia lát cắt dựng tính năng (`M3 Paid pilot`, `priority:P2`)

Mỗi lát cắt được thiết kế để tách thành từng issue và PR hoàn chỉnh chạy song song/nối tiếp dưới Epic `#3318`:

| Lát cắt | Tên issue dự kiến | Nội dung chính | Tệp / vùng thay đổi chính | Đường dẫn bảo vệ cần security review |
| :--- | :--- | :--- | :--- | :--- |
| **Slice 1a** | `feat(sign): add crove_sign schema, crove-extract pdf_inspect/seal, and envelope commands` | Migration `crove_sign`, tách `sign_document` khỏi OCR kế toán, bổ sung `pdf_inspect` và `pdf_seal` trong `crove-extract`, lệnh xử lý hồ sơ & dọn dẹp theo [ADR-0053](../adr/0053-per-org-app-enablement.md). | `supabase/migrations/*`, `packages/kernel-contract`, `packages/kernel/src/{files,personal-data}.ts`, `apps/extract/*`, `apps/kernel/src/{config,jobs-schema,kernel,retention,org-purge}.ts`, `modules/sign/*` | Có (migration, `files.ts`, `kernel-contract`, `crove-extract`, `package.json` mới) |
| **Slice 1b** | `feat(sign): add orgless public signing links, replay protection, and email OTP` | Đường dẫn `/-/sign#<token>`, hàm phân giải `runtime.orgless` ẩn `MODULE_OFF`, ký tuần tự, OTP qua [ADR-0034](../adr/0034-outbound-email.md) không lưu bí mật trong queue, khóa dùng lại 1 lần, không CAPTCHA (`#203`), bộ test bất biến bảo mật. | `supabase/migrations/*`, `packages/kernel-contract`, `apps/kernel/src/{http,sign-link,mail-templates}.ts`, `modules/sign/src/{public-commands,sign-mail}.ts`, `modules/sign/test/invariant/*` | Có (migration, `http.ts`, `test/invariant/`) |
| **Slice 1c** | `feat(sign): build Ky ket app UI, PDF field placer, mobile signing ceremony, and Vy proposals` | Giao diện ứng dụng **Ký kết**, màn hình đặt khung PDF (không kèm `.wasm`), trang ký di động, kiểm tra `SHA-256`, tích hợp Vy trong `packages/agent` + redteam test + E2E smoke trên `docker compose`. | `packages/agent/*`, `apps/app/src/{lib,routes,components/sign,i18n}/*`, `modules/sign/src/ai.ts`, `packages/e2e/tests/sign.spec.ts` | Có nếu thêm dependency vào `apps/app/package.json` + shared-core `packages/agent` |
| **Slice 2a** | `feat(sign): add reusable eSign templates and role presets` | Bảng `template*`, tạo nhanh hồ sơ từ mẫu có sẵn, giao diện `/sign/templates`. | `supabase/migrations/*`, `modules/sign/src/templates.ts`, `apps/app/src/routes/sign-templates.tsx` | Có (migration) |
| **Slice 2b** | `feat(sign): hand off Engage quotes and HR contracts to Ludy eSign` | Nút chuyển sang Ký kết từ báo giá Engage ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md)) và hợp đồng lao động Nhân sự; phát sự kiện hoàn tất cập nhật trạng thái đã ký mà không tạo khóa ngoại chéo. | `modules/crm/src/quotes.ts`, `modules/hr/*`, `modules/sign/src/handoff.ts`, giao diện Engage/HR | Thấp (không đụng kernel/migration lõi nếu dùng sẵn `source_kind`/`source_id`) |
| **Slice 2c** | `feat(sign): add pluggable Vietnam CA adapter (VNPT SmartCA, Viettel MySign, MISA WeSign)` | Gói `@crove/sign` chuẩn hóa cổng ký số công cộng VN, đối soát an toàn `reconcile_only`, nhúng PAdES-LTV trong `crove-extract`, và **cổng rà soát pháp lý của luật sư `#62`** (`owner-action`) trước khi mở pilot thu phí. | `packages/sign/*`, `supabase/migrations/*`, `apps/extract/src/seal.ts`, `modules/sign/src/ca.ts`, `apps/app/src/routes/sign-settings.tsx` | Có (migration, `packages/sign/package.json`, `crove-extract`) |
