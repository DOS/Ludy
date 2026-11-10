# Vy, đồng nghiệp AI tổng quản: tóm tắt kế hoạch cho chủ sở hữu

> Tóm tắt tiếng Việt của [vy.md](vy.md), ngày 2026-11-10, viết sau khi anh chốt "Vy thuộc Platform nha" (Vy thuộc nhóm Nền tảng). Bản tiếng Anh là bản chuẩn. **Đây là bản nháp, anh chưa duyệt**: các câu hỏi cho anh nằm ở cuối. Chưa mở issue nào cho các bước mới; chưa tốn tiền. Kế hoạch dựa trên những gì Ludy đã có thật trong mã, không hứa tính năng chưa xây.

## Vy là ai với người dùng

- **Vừa là đồng nghiệp, vừa là trợ lý** (anh quyết ngày 2026-11-10: "Vy là đồng nghiệp và trợ lý luôn"). Chỉ Vy được gọi là trợ lý; Ly, Dy, Uy vẫn chỉ là đồng nghiệp. Tên quyền vẫn là "Làm việc với Vy". Vy là tổng quản AI, làm việc trên mọi ứng dụng và trong Ludy Notes. Tổ chức đổi được tên Vy; tên chỉ nằm ở một chỗ trong mã.
- **Vy và Ly, Dy, Uy.** Theo DESIGN.md: Vy điều phối trên mọi ứng dụng, và mỗi ứng dụng có đồng nghiệp riêng. Ly làm Ludy Kế toán; Dy làm Hộp thư, khách hàng và bán hàng của Ludy Engage; Uy làm marketing (đăng bài, quảng cáo) của Ludy Engage; Hy để dành, chưa hiện ở đâu. Quy tắc gọi tên: việc trong một ứng dụng thì gọi tên đồng nghiệp của ứng dụng đó (Ly soạn thư nhắc nợ, Dy soạn câu trả lời khách); việc trải qua nhiều ứng dụng thì gọi Vy (bản tin buổi sáng, câu hỏi về cả doanh nghiệp, biến một ghi chú thành việc cho nhiều nơi).
- **Một Vy, hai cách làm việc** (theo ADR-0049, "ADR" là bản ghi quyết định kỹ thuật):
  - **làm cho cả công ty**: Vy giữ một vị trí trong sơ đồ tổ chức như một nhân viên AI; không bao giờ đọc dữ liệu riêng của ai;
  - **làm cho một người**: Vy có đúng quyền của người đó, không hơn; điều Vy tìm thấy trong dữ liệu riêng chỉ trả về cho người đó.
- **Vy không bao giờ tự** ghi sổ tiền, gửi tin nhắn hay chi tiền: người bấm duyệt. Mọi con số do máy tính tính, không do AI bịa. Tắt AI thì mọi màn hình vẫn chạy.

## Anh đã quyết những gì

| Ngày | Quyết định |
|---|---|
| 2026-10-28 | Sản phẩm tên Ludy, AI tên Vy (#1682). AI chỉ đọc một ghi chú khi người viết yêu cầu. |
| 2026-10-31 | Ưu tiên công ty một người và doanh nghiệp nhỏ; mô hình doanh nghiệp lớn để sau. |
| 2026-11-02 | AI làm ngay trong từng màn hình: Vy đề xuất, người duyệt, duyệt theo lô khi được. AI là đồng nghiệp, không phải "trợ lý"; mỗi mảng một đồng nghiệp: Vy, Ly, Dy, Uy (Hy để dành). |
| 2026-11-03 | Ludy CRM gộp vào Ludy Engage. Lời anh: "Với những data riêng thì Vy chỉ trả lời cho user đó thôi chứ. Nôm na là data nào user có access thì Vy (của người đó) có." |
| 2026-11-04 | "Bộ não" của Vy (mô hình AI, trí nhớ của từng người, kiến thức của công ty) đặt sau một lớp thay được; Ludy Cloud có thể dùng nhà cung cấp ngoài, nhưng Ludy luôn giữ việc kiểm tra quyền. Ai được làm việc với Vy là một quyền đặt theo vai trò có sẵn, không bắt đặt từng quyền lẻ. |
| 2026-11-10 | "Vy thuộc Platform nha": phần lõi của Vy và việc của Vy trải qua nhiều ứng dụng thuộc nhóm Nền tảng. |

## Những gì đã có

- **"Hôm nay cần bạn" trên trang chủ**: một danh sách gom từ mọi ứng dụng, mỗi người chỉ thấy cái mình mở được (#2383).
- **Bản tin buổi sáng của Vy**: tối đa 4 câu, viết từ con số và ngày hạn, câu nào có số không khớp thì bỏ; gửi qua thư nếu người dùng bật (thư chỉ có số đếm và đường dẫn, #2406).
- **Đồng hồ đo ngân sách AI và nút "Dừng AI"** cho cả tổ chức, từng ứng dụng, từng nhân viên AI.
- **Phần lõi của "Vy làm cho một người"** đã xây phần lớn (#2781, #2782, #2756), nhưng **chưa được bật** cho tới khi xong phần dọn dẹp an toàn #2822.
- **Tóm tắt cuộc họp và việc cần làm từ cuộc họp** đã xây, đang tắt chờ #2822.
- **Ly, Dy, Uy** đã có trong sơ đồ tổ chức dưới dạng nhân viên AI chạy theo quy tắc, chưa dùng mô hình AI (#259 còn mở). Vy chưa có vị trí trong sơ đồ.

## Hai nguyên tắc cho mọi app, và cách Vy chạy với các nền tảng AI bên ngoài (anh quyết ngày 2026-11-10)

1. **Ludy là một hệ điều hành, chạy được độc lập, không bị khóa vào một dịch vụ trả phí của bên thứ ba.** Giống Supabase: mã nguồn mở, tự cài được, có thêm bản dịch vụ. Mỗi dịch vụ bên ngoài đứng sau một "cổng" thay được, và luôn có lựa chọn miễn phí hoặc tự cài.
2. **Tích hợp sâu vào hệ sinh thái DOS:** DOS ID, DOS.AI và các agent của DOS dùng được ngay khi tổ chức chọn dùng.

Với Vy, nghĩa là:
- **Một cổng nhỏ, nhiều bộ nối.** Gọi mô hình AI qua một chuẩn chung (kiểu OpenAI), nên OpenAI, Anthropic, Google, mô hình chạy tại chỗ (Ollama) hay DOS.AI đều chỉ cần cấu hình, không sửa mã. Không tính năng nào gọi thẳng thư viện của một hãng.
- **Nền tảng agent bên ngoài** (Claude, OpenAI, Google, OpenClaw...) điều khiển Vy qua MCP hoặc API, bằng một "giấy phép" gắn với tổ chức và đúng vị trí của Vy. Ludy vẫn giữ quyền quyết định: mọi thao tác đi qua cùng một cửa, cùng mức rủi ro, cùng người duyệt, ngân sách và nút dừng. Dữ liệu riêng của một người chỉ ra ngoài khi Vy làm cho đúng người đó.
- **Gọn nhất:** mỗi tổ chức có một máy chủ MCP, cung cấp đúng các lệnh mà app đang dùng, lọc theo giấy phép. Không làm thêm API thứ hai.
- **Lựa chọn nhanh với DOS Claw:** ghép Vy với agent của DOS trong một bước, ví dụ mở Cài đặt lấy một mã ghép rồi nhập vào DOS Claw. Cách ghép này dùng chung cho mọi agent; với DOS thì điền sẵn địa chỉ và đăng nhập bằng DOS ID.
- **Kiểm thử:** CI chạy với AI giả và agent giả. Hệ thống phải chạy được cả khi tắt AI và khi chỉ có mô hình chạy tại chỗ.

## Vy sẽ làm được gì (sáu ứng viên)

1. **Bản tin buổi sáng trên mọi ứng dụng** (đã có một phần). Thêm: ghi rõ đồng nghiệp nào chuẩn bị việc nào ("Ly đã chuẩn bị 5 đề xuất"), thêm việc trễ của dự án và kết quả cuộc họp, thêm dòng "từ hôm qua các đồng nghiệp AI đã chuẩn bị gì". Không lưu gì, AI chỉ thấy con số. Giống bản tin của QuickBooks và Digits.
2. **"Hỏi Vy"** (mới): "Tháng này lãi bao nhiêu?", "Ai còn nợ mình?", "Việc nào trễ?". Vy chỉ đọc, chỉ trong phạm vi quyền của người hỏi, mỗi câu trả lời có đường dẫn tới chỗ lấy số liệu để anh bấm kiểm tra. Bản đầu chỉ trả lời các câu hỏi về số liệu từ một danh sách nguồn cố định; máy tính chọn nguồn, AI không tự chọn. Giống Intuit Intelligence và MISA AVA.
3. **Biến ghi chú, cuộc họp, tin nhắn thành việc** (đã có một phần cho cuộc họp). Vy đề xuất: một việc cho người hay cho Ly, Dy, Uy, hoặc một bản nháp trong đúng ứng dụng (báo giá cho Dy, thư nhắc nợ cho Ly). Người dùng xem đúng chữ sẽ hiện cho cả nhóm rồi mới bấm. Email để sau, vì Ludy chưa có phần nhận email chung.
4. **Cảnh báo trải qua nhiều ứng dụng** (mới, không dùng AI, không tốn tiền): cơ hội bán hàng đã chốt mà 7 ngày chưa xuất hóa đơn; khách đang nợ quá hạn mà vẫn có báo giá mở; nhà cung cấp vừa đổi số tài khoản ngân hàng trong khi có lệnh thanh toán chờ duyệt. Chỉ báo khi người xem mở được cả hai phía. Giống Xero và MISA meInvoice.
5. **Tình hình tuần** (mới trên trang chủ): máy tính tính số liệu tuần (tiền vào ra, công nợ, cơ hội bán hàng đã chốt, bài đăng, việc xong và trễ), Vy viết 3 đến 5 câu dễ hiểu, câu nào có số sai thì bỏ.
6. **Vy giao việc cho Ly, Dy, Uy** (mới, để sau): Vy giữ vị trí tổng quản trong sơ đồ tổ chức, chuyển việc chưa ai nhận tới đúng đồng nghiệp, việc rủi ro thì gửi lên người. Không đọc dữ liệu riêng.

## Các giai đoạn

**Giai đoạn 1, làm được ngay** (không cần "Vy làm cho một người"):
1. Ghi quyết định ngày 2026-11-10 và ranh giới giữa các nhóm.
2. Ghi tên đồng nghiệp trên từng việc ở trang chủ.
3. Dòng "từ hôm qua".
4. Cảnh báo đầu tiên trải qua hai ứng dụng: cơ hội bán hàng đã chốt mà chưa xuất hóa đơn.
5. Hai cảnh báo tiếp: nợ quá hạn có báo giá mở; đổi tài khoản ngân hàng.
6. Thẻ "Tuần này" trên trang chủ.

**Giai đoạn 2, chờ #2822 xong** (không bật được trước đó):
7. Phần "kiến thức" của Vy đọc đúng các nguồn đã khai báo, trong quyền của người hỏi.
8. "Hỏi Vy" bản đầu: câu hỏi về số liệu, có đường dẫn nguồn.
9. Một bước chung "Vy, chuyển thành việc" cho ghi chú, cuộc họp, tin nhắn.

**Giai đoạn 3, sau khi có bản ghi quyết định riêng**:
10. Vị trí tổng quản của Vy trong sơ đồ tổ chức.
11. Vy chuyển việc cho Ly, Dy, Uy.
12. "Hỏi Vy" tìm cả trong chữ của ghi chú và cuộc họp.

## An toàn dữ liệu, nói đơn giản

Giữ nguyên mọi cam kết của ADR-0049: Vy làm cho ai thì chỉ có quyền của người đó; kết quả và trí nhớ của Vy chỉ người đó xem, chủ và quản trị viên cũng không đọc; chữ riêng chỉ ra ngoài khi người đó tự bấm; AI không có "tay" để tự chạy lệnh; mọi lần gọi AI đều qua đồng hồ ngân sách và nút dừng.

Bốn chỗ **cần bản ghi quyết định mới trước khi xây**:
- **Tìm trong chữ của ghi chú và cuộc họp** (một "chỉ mục", tức bản sao để tìm nhanh, kể cả dạng "embedding"). Đây là chỗ rủi ro lớn nhất: phải bảo đảm bản sao không lộ cho người không có quyền, bị xóa ngay khi người dùng mất quyền, khi bị xóa khỏi tổ chức hoặc khi có yêu cầu xóa dữ liệu cá nhân.
- **Để AI chọn nguồn trả lời**: ADR-0049 hiện cấm; bản đầu dùng máy tính chọn.
- **Thư tình hình tuần có số liệu gửi cho nhiều người**: mỗi người quyền khác nhau, nên bản đầu chỉ hiện trên trang chủ.
- **Vy làm tổng quản trong sơ đồ tổ chức**: cần bổ sung ADR-0029.

## Câu hỏi cho anh

| # | Cần anh quyết | Đề xuất | Nếu anh chưa trả lời |
|---|---|---|---|
| 1 | Làm giai đoạn 1 trước "Hỏi Vy"? | Có | Nhóm Nền tảng chỉ làm giai đoạn 1 |
| 2 | "Hỏi Vy" bản đầu chỉ trả lời câu hỏi về số liệu, chưa tìm trong ghi chú và cuộc họp? | Có | Chưa làm "Hỏi Vy" |
| 3 | Có bao giờ cho lập chỉ mục tìm kiếm trên ghi chú riêng và cuộc họp không? | Chưa; dữ liệu chung trước, chữ riêng chỉ sau khi có bản ghi quyết định | Không lập chỉ mục nào |
| 4 | Cho Vy làm tổng quản trong sơ đồ tổ chức, đứng trên Ly, Dy, Uy: bây giờ hay sau thí điểm? | Sau thí điểm | Để trong danh sách chờ |
| 5 | Tình hình tuần: chỉ trên trang chủ, hay gửi cả thư có số liệu? | Chỉ trang chủ; thư vẫn chỉ có số đếm và đường dẫn | Chỉ trang chủ |
| 6 | Trên trang chủ, ghi tên Ly, Dy, Uy cho từng việc, và Vy cho câu tóm tắt? | Có | Các việc không ghi tên |
| 7 | DOS Claw là gì, và ghép với Vy theo cách nào (mã ghép, đăng nhập DOS ID, hay cách khác)? | Mã ghép trong Cài đặt, dùng chung cho mọi agent | Chưa làm phần DOS Claw |
| 8 | Phần nối với DOS (DOS Claw, DOS.AI điền sẵn) nằm trong mã nguồn mở dưới dạng tùy chọn, hay chỉ trong bản Ludy Cloud riêng như AGENTS.md đang ghi? | Trong mã nguồn mở, tắt mặc định | Theo AGENTS.md: chỉ trong Cloud |

## Nhóm nào làm phần nào

- **Nhóm Nền tảng** (theo lời anh ngày 2026-11-10): phần lõi "Vy làm cho một người", quyền làm việc với Vy, đồng hồ ngân sách và nút dừng phần liên quan tới Vy, trang chủ và bản tin, cảnh báo nhiều ứng dụng, tình hình tuần, "Hỏi Vy", bước chuyển thành việc, Vy tổng quản trong sơ đồ tổ chức, và các bản ghi quyết định ở trên.
- **Mỗi nhóm ứng dụng giữ tính năng trong ứng dụng của mình**, kể cả khi dùng Vy: tóm tắt ghi chú (#1677, nhóm Notes và CRM), chép lời và tóm tắt cuộc họp (#2578, #2580, nhóm Cuộc họp), Vy trong dự án (#2596, #2597, #2598), việc của Ly trong Kế toán (ví dụ #2376) và của Dy, Uy trong Engage. Mỗi nhóm tự làm phần đọc dữ liệu cho trang chủ và cho cảnh báo của mình.
- **Nhóm Giao diện**: Vy trông thế nào trên mọi màn hình, và việc đổi tên (#1682).
