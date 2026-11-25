# Tóm tắt thiết kế khung giao diện mới và Trang chủ tùy biến theo vai trò (#4923)

- **Ngày:** 2026-11-25
- **Issue:** https://github.com/DOS/Ludy/issues/4923 (Giai đoạn M3 Paid pilot)
- **Tài liệu kỹ thuật chi tiết:** [ui-shell-top-bar-and-home.md](./ui-shell-top-bar-and-home.md) và [DESIGN.md](../../DESIGN.md) phiên bản 4.5

---

## 1. Mục tiêu thay đổi

Bản thiết kế này thống nhất khung điều hướng của ứng dụng Ludy (`apps/app`) để người dùng chuyển giữa Trang chủ (`Tổng quan`), Thông báo và từng ứng dụng mượt mà, không bị nhảy vị trí nút bấm, đồng thời giúp Trang chủ gọn gàng theo đúng việc của từng người:

1. **Khắc phục lỗi giao diện bị "nhảy" hiện tại:**
   - Hiện tại khi chuyển từ Trang chủ hoặc Thông báo sang một ứng dụng (như Tài chính), thanh biểu tượng bên trái bị tụt xuống `8px` do khác khoảng đệm dọc (`md:py-2` so với `md:py-4`), logo Ludy biến mất ở Trang chủ và Thông báo, còn ô tìm kiếm, nút `+` và menu tài khoản nhảy cột tùy theo màn hình.
   - Thiết kế mới tách các công cụ dùng chung lên một thanh cố định ở trên cùng, giữ thanh ứng dụng bên trái đứng yên tuyệt đối ở mọi màn hình.
2. **Màn hình Thông báo 2 cột (xem và xử lý ngay trong một nơi):**
   - Trước đây bấm một thông báo sẽ rời khỏi danh sách, mất vị trí đang đọc.
   - Thiết kế mới chia 2 cột trên máy tính: bên trái là danh sách thông báo có bộ lọc, bên phải hiện ngay nội dung chi tiết và nút xử lý hoặc mở chứng từ gốc.
3. **Trang chủ (`Tổng quan`) tự lọc theo vai trò và đồng bộ cấu hình:**
   - Trước đây ai mở Trang chủ cũng thấy lịch nộp thuế và khối chứng từ Tài chính ở vị trí cố định, trong khi các ứng dụng khác chỉ có liên kết nhỏ bên dưới.
   - Thiết kế mới giữ phần quan trọng nhất ở trên cùng, các khối ứng dụng tự hiện theo quyền và ứng dụng đã bật, cho phép mỗi người tự ẩn/hiện hoặc đổi thứ tự và lưu đồng bộ giữa máy tính với điện thoại.

---

## 2. Khung giao diện thống nhất

### 2.1 Thanh công cụ cố định phía trên (Global Top Bar, cao `48px`)

Xuất hiện cố định trên **mọi màn hình** trong tổ chức (Trang chủ, Thông báo, các ứng dụng, Cài đặt, Nhật ký hoạt động, Dữ liệu cá nhân):

- **Bên trái:** Logo Ludy (bấm để về Trang chủ) và nút thu gọn/mở rộng menu phụ (phím `[`, chỉ hiện ở màn hình có menu phụ). Logo luôn hiển thị trên cả Trang chủ và Thông báo.
- **Ở giữa:** Thanh tìm kiếm toàn hệ thống (`⌘K` hoặc `Ctrl K`) để mở nhanh màn hình, tìm đối tác, hóa đơn, ghi chú hoặc đổi nhanh tổ chức/giao diện.
- **Cụm công cụ bên phải (thứ tự cố định trên mọi màn hình):**
  1. **Nút mở nhanh Vy:** mở ngăn trợ lý/đồng nghiệp AI **Vy** (dựa trên quyền `Làm việc với Vy` và mức giới hạn AI của tổ chức; tắt AI vẫn dùng mọi tính năng lõi bình thường).
  2. **Nút tạo nhanh `+`:** gom các thao tác tạo thường dùng vào một chỗ gồm **Tải chứng từ lên**, tạo việc mới, ghi chú nhanh, thêm khách hàng/cơ hội, tạo hồ sơ ký eSign (tự ẩn mục nếu ứng dụng tương ứng chưa bật hoặc người dùng không có quyền ghi).
  3. **Chuông Thông báo:** hiển thị số lượng thông báo chưa đọc, bấm để mở màn hình Thông báo.
  4. **Bánh răng Cài đặt:** mở nhanh phần Cài đặt của tổ chức.
  5. **Chỉ báo ngân sách AI:** hiện gọn khi AI đang bật và tổ chức có đặt ngưỡng ngân sách AI.
  6. **Menu tài khoản (`AccountPopover`):** hiển thị ảnh đại diện và tên tổ chức đang mở; bấm vào để đổi tổ chức, xem danh sách doanh nghiệp (`/clients`), chuyển giao diện Sáng / Tối / Theo hệ thống, đổi ngôn ngữ `VI` / `EN`, mở trang Hỗ trợ / Trạng thái hệ thống và Đăng xuất.

### 2.2 Thanh ứng dụng bên trái ổn định (`64px`) và menu phụ theo ngữ cảnh (`224px`)

- **Thanh ứng dụng bên trái (`64px`):** giữ khoảng đệm trên dưới cố định (`md:py-3`) trên tất cả các màn hình, chỉ chứa nút `Tổng quan` và các ứng dụng đang bật mà vai trò được xem (`Cộng tác`, `Tài chính`, `Engage`, `Nhân sự`, `eSign`, `Ludy AI`). Không nhồi nút tìm kiếm, nút `+` hay menu tài khoản vào thanh này nên biểu tượng không bao giờ dịch chuyển khi đổi màn hình.
- **Menu phụ bên cạnh (`224px`):** chỉ mở khi đang ở trong một ứng dụng hoặc trong Cài đặt, có nút chuyển pháp nhân (`EntitySwitcher`) nếu tổ chức có nhiều hơn một pháp nhân kế toán, và thu gọn lại khi ở Trang chủ hoặc Thông báo để không để cột trống.
- **Trên điện thoại (`< 768px`):** giữ thanh tiêu đề dính phía trên với nút bấm tối thiểu `44px` dễ chạm bằng ngón cái, kèm ngăn kéo (`NavDrawer`) cuộn mượt một cột và menu tài khoản nằm gọn trong ngăn kéo.

### 2.3 Màn hình Thông báo 2 cột (Master-Detail)

- **Trên máy tính (`>= 1024px`):** cột trái là danh sách thông báo có bộ lọc (`Tất cả`, `Chưa đọc`, `Theo ứng dụng`), nút `Đánh dấu tất cả đã đọc` và phím mũi tên `J` / `K` để lướt nhanh; cột phải hiển thị ngay nội dung chi tiết của thông báo đang chọn kèm nút hành động trực tiếp (duyệt đề xuất, mở công việc, kiểm tra dòng sao kê ngân hàng) mà không làm mất vị trí cuộn của danh sách bên trái.
- **Trên điện thoại và máy tính bảng nhỏ:** hiển thị danh sách một cột, chạm vào thông báo sẽ mở khung chi tiết trượt từ cạnh phải (`Sheet`).

---

## 3. Trang chủ (`Tổng quan`) theo vai trò và đồng bộ giữa máy tính với điện thoại

### 3.1 Cấu trúc từ trên xuống

1. **Phần cố định trên cùng (không ẩn được):**
   - Lời chào gọn kèm thời điểm hoạt động gần nhất và nút **`Tùy chỉnh`** ở góc phải (nút `Tải chứng từ lên` chuyển vào nút `+` trên thanh công cụ cố định phía trên).
   - Khối **`Hôm nay cần bạn`**: danh sách việc cần xử lý ngay, bản tóm tắt ngắn đầu ngày và ô hỏi nhanh **Vy** (dành cho thành viên có quyền `Làm việc với Vy`; nếu tắt AI hoặc hết ngân sách tháng, phần này ẩn hoặc đổi sang câu tóm tắt cố định không gọi mô hình AI).
   - Dải thông báo vận hành gọn (đếm tệp lỗi, việc chờ, tóm tắt việc đồng nghiệp AI mới làm; tự ẩn nếu trống).
2. **Các khối tóm tắt theo ứng dụng (lọc theo quyền và ứng dụng đang bật):**
   - **Tài chính - Hạn thuế 30 ngày & hóa đơn:** mặc định chỉ hiện cho chủ sở hữu, quản trị viên hoặc người có vai trò/quyền Tài chính.
   - **Tài chính - Chứng từ chờ duyệt:** mặc định hiện cho người phụ trách duyệt hoặc kế toán.
   - **Cộng tác - Việc của tôi & ghi chú:** hiện cho mọi thành viên có quyền làm việc.
   - **Engage - Lịch hẹn, cơ hội bán hàng & hộp thư:** hiện khi các phân hệ tương ứng đang bật và vai trò được truy cập.
   - **Nhân sự - Đơn chờ duyệt / Cổng nhân viên:** quản lý thấy đơn chờ duyệt; nhân viên thấy lối mở nhanh vào Cổng nhân viên.
   - **eSign - Hồ sơ chờ ký:** hiện khi ứng dụng eSign đang bật cho thành viên được phép thao tác.
   - **Quy tắc thu gọn khi trống:** khối nào không có việc tồn đọng sẽ tự thu về một dòng gọn kèm liên kết mở ứng dụng, tránh kéo dài Trang chủ.
   - Nếu tổ chức tắt một ứng dụng trong Cài đặt, khối của ứng dụng đó tự ẩn ngay lập tức mà không làm mất cấu hình đã lưu của người dùng.

### 3.2 Chế độ `Tùy chỉnh` và lưu trữ an toàn

- Khi bấm **`Tùy chỉnh`**, người dùng có thể bật/tắt từng khối được phép xem, kéo thả hoặc dùng nút **Lên / Xuống** (hỗ trợ bàn phím và trình đọc màn hình) để sắp xếp thứ tự, hoặc bấm **Đặt lại mặc định theo vai trò**.
- Bố cục được lưu riêng cho từng thành viên trong từng tổ chức tại bảng `ludy_kernel.member_home_layout` trong cơ sở dữ liệu (`PostgreSQL`), giúp đồng bộ ngay khi chuyển từ máy tính sang điện thoại.
- Mọi thao tác đọc và lưu đều đi qua lớp lệnh chuẩn của hệ thống (`Runtime.execute()`), có kiểm soát truy cập theo dòng (`RLS`) để người dùng hoặc trợ lý AI ở tổ chức khác hay thành viên khác không thể đọc hoặc sửa bố cục của bạn, và dữ liệu được dọn sạch khi đóng tổ chức hoặc xóa thành viên.

---

## 4. Kiểm tra phạm vi OPC / SME AI-first

- **Phù hợp quy mô nhỏ:** Tập trung vào công việc hằng ngày và hằng tháng của hộ kinh doanh, công ty một thành viên và SME Việt Nam; không làm hệ thống kéo thả bảng điều khiển phức tạp kiểu doanh nghiệp lớn.
- **Chạy ngay không cần cấu hình:** Tổ chức mới hay thành viên mới vào là thấy đúng các khối theo vai trò và ứng dụng đang bật; `Tùy chỉnh` chỉ là tùy chọn mở rộng và có nút quay về mặc định.
- **Vai trò của AI minh bạch và an toàn:** **Vy** (đồng nghiệp kiêm trợ lý) sẵn sàng ở thanh trên cùng và ô hỏi nhanh trên Trang chủ qua bộ đếm ngân sách AI (`AiMeter`); mọi quy trình cốt lõi vẫn chạy bình thường khi tắt AI, và con người luôn duyệt mọi thao tác liên quan đến tiền, tin nhắn gửi ra ngoài hoặc chi tiêu.

---

## 5. Kế hoạch triển khai 5 giai đoạn (cho M3 Paid pilot)

Sau khi tài liệu thiết kế này được duyệt, công việc sẽ chia thành 5 issue độc lập để triển khai gọn và kiểm thử tự động từng bước:

1. **Giai đoạn 1 - Cơ sở dữ liệu và API lưu bố cục Trang chủ:** tạo bảng `ludy_kernel.member_home_layout`, kiểm tra dữ liệu hợp lệ, chính sách bảo mật theo thành viên (`RLS`), cập nhật hàm dọn dữ liệu tổ chức (`org_purge`), bổ sung lệnh đọc/lưu/đặt lại bố cục trong lõi hệ thống (`@ludy/kernel` và `@ludy/kernel-contract`) cùng bộ kiểm thử cách ly dữ liệu.
2. **Giai đoạn 2 - Thanh công cụ 48px phía trên và thanh trái 64px ổn định:** xây thanh công cụ cố định trên cùng với Logo, tìm kiếm `⌘K`, nút Vy, nút `+` tạo nhanh, Chuông, Cài đặt, ngân sách AI và `AccountPopover`; chỉnh thanh trái giữ cố định `md:py-3` không nhảy dòng và đồng bộ giao diện điện thoại.
3. **Giai đoạn 3 - Màn hình Thông báo 2 cột:** nâng cấp `/o/$slug/notifications` thành danh sách kèm bộ lọc + phím `J`/`K` ở cột trái và khung xem chi tiết/xử lý trực tiếp ở cột phải (mở khung trượt trên điện thoại).
4. **Giai đoạn 4 - Trang chủ theo vai trò và chế độ `Tùy chỉnh`:** giữ cố định `Hôm nay cần bạn` và ô hỏi nhanh Vy ở trên cùng, hiển thị các khối ứng dụng lọc theo quyền và tự thu gọn khi trống, chuyển `Tải chứng từ lên` vào nút `+` phía trên, và gắn giao diện `Tùy chỉnh` lưu vào cơ sở dữ liệu.
5. **Giai đoạn 5 - Kiểm thử toàn diện giao diện, bàn phím và đa màn hình:** chạy kiểm thử tự động ở các kích thước `360px`, `768px`, `1280px`, `1920px`, cả hai chế độ Sáng/Tối, điều hướng bằng bàn phím, chuẩn trợ năng (WCAG 2.2 AA) và kiểm tra không còn hiện tượng nhảy thanh bên trái khi chuyển màn hình.
