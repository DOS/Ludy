# Vy làm việc riêng cho từng người: tóm tắt cho JOY

> Bản tóm tắt tiếng Việt của [ADR-0049](0049-member-scoped-vy.md), ngày 2026-11-04 (#1677), cập nhật cùng ngày sau khi Platform PO duyệt bảo mật ("đồng ý, kèm 10 chỗ phải sửa", đã đưa hết vào ADR) và sau góp ý của JOY về cách gọi tên. Bản tiếng Anh là bản chính. Trạng thái: **đề xuất**, chờ Platform PO chấp nhận. Chưa có dòng mã nào được viết.

## Chỉ có một Vy

Người dùng chỉ thấy **một Vy**, một cái tên, ở mọi app. Không có "hai Vy" và không có hai sản phẩm. Điều cần quyết chỉ là: mỗi lần Vy làm một việc, nó **dùng quyền của ai**, và vì thế được đọc và được ghi những gì. Vy làm việc theo hai chế độ:

- **Vy khi làm việc chung cho công ty:** chạy như một tác tử trong sơ đồ tổ chức. Giữ danh sách bảng được ghi như cũ (#285). Không bao giờ đọc ghi chú riêng.
- **Vy khi làm việc riêng cho từng người:** chạy dưới quyền của đúng người đó. Danh mục ghi, trí nhớ và kết quả của chế độ này chỉ thuộc về người đó.

(Trong mã, chế độ thứ hai tên là `member_vy`. Đó chỉ là tên kỹ thuật.)

## Quyết định của JOY và nó có nghĩa là gì

Ngày 2026-11-03 JOY quyết trên #1677: "Với những data riêng thì Vy chỉ trả lời cho user đó thôi chứ. Nôm na là data nào user có access thì Vy (của người đó) có."

- **Khi Vy làm việc riêng cho một người, nó thấy đúng những gì người đó thấy**, chỉ trong phạm vi họ thấy và làm được. Ghi chú riêng của họ, ghi chú chung họ được xem, dữ liệu các app khác theo quyền của họ. Không hơn.
- **Cái Vy tìm thấy trong dữ liệu riêng chỉ trả về cho đúng người đó.** Trí nhớ và kết quả cũng là của riêng từng người. Chủ tổ chức, quản trị viên, người khác, hệ thống đều không đọc được.
- **Việc chung của cả công ty vẫn không đọc gì riêng tư.** Bản tin hằng ngày cho cả nhóm, đề xuất để người khác duyệt, việc của các tác tử AI trong sơ đồ tổ chức: không đụng vào ghi chú riêng.
- Quyết định này sửa điều N-6 của ADR-0037 ("tác tử không đọc ghi chú") chỉ cho chế độ Vy làm việc riêng cho từng người. Chế độ làm việc chung giữ N-6.

## Cách làm, nói ngắn

1. **Chạy trong quyền của chính người đó, không bao giờ trong quyền hệ thống.** Khi người dùng bấm "Tóm tắt" trên một ghi chú, máy chủ xử lý ngay trong phiên của họ. Việc chạy nền (ví dụ chép lời một cuộc họp) vào một ngữ cảnh riêng gắn với đúng người đó. Việc chạy nền dừng ngay khi người đó bị gỡ khỏi tổ chức, bị vô hiệu hóa, xóa tài khoản, hoặc bấm "đăng xuất mọi nơi", kể cả đang chạy giữa chừng. Cơ sở dữ liệu giữ chặt mối buộc giữa người dùng, Vy và lần chạy; quyền của Vy cũng bị giới hạn ở cả tầng chạy lệnh, không chỉ ở cơ sở dữ liệu.
2. **Hai chế độ có danh sách ghi tách bạch.** Khi làm việc chung, Vy giữ danh sách bảng được ghi như cũ (#285). Khi làm việc riêng cho một người, Vy có danh mục riêng, chỉ thêm được bằng migration có rà bảo mật: chỉ ghi kết quả và trí nhớ của chính người đó. Không ghi được nhiệm vụ, đề xuất hay bảng nào người khác đọc.
3. **Trí nhớ và kết quả nằm trong bảng khóa theo từng người** (`member_vy_result`, `member_vy_memory`), có khóa dòng ở mức cơ sở dữ liệu. Thông tin về lần chạy (đọc gì, lỗi gì) cũng chỉ người đó thấy, không nằm ở chỗ cả tổ chức đọc. Kết quả tự ẩn ngay khi người đó mất quyền đọc nguồn của nó (ví dụ ghi chú chung bị chuyển thành riêng). Khi người đó rời tổ chức, chúng bị xóa cùng lúc với ghi chú riêng (sau 30 ngày). Xóa tổ chức hay yêu cầu xóa dữ liệu cá nhân cũng xóa chúng. Khi xuất dữ liệu tổ chức chỉ có số đếm. Trí nhớ chỉ gồm điều người dùng tự ghi hoặc xác nhận, có màn hình "Vy nhớ gì về tôi" để sửa, xóa.
4. **Chặn rò rỉ ra ngoài bằng ba lớp, không dựa vào lời dặn trong lời nhắc, và đóng mọi đường ra.** Bản tin chung và việc chung của Vy không đọc nổi kết quả riêng của từng người. Mỗi lần chạy có cờ "đã đọc dữ liệu riêng", do hệ thống lõi tự tính (không tin giá trị do code tính năng hay trình duyệt gửi lên), tính cả trí nhớ và kết quả trước đó là nguồn riêng, và không bao giờ bị xóa. Chữ riêng chỉ đến chỗ mọi người thấy khi chính người đó bấm xác nhận sau khi thấy đúng nội dung. ADR liệt kê và đóng từng đường mà bộ chặn ghi thông thường không nhìn thấy: nguồn cấp hoạt động, nhật ký kiểm toán (không xóa được, nên chỉ cho phép mã định danh, không chữ), sự kiện gửi ra, tín hiệu cập nhật màn hình, thông báo, kết quả lưu để chống lặp, nội dung tác vụ nền.
5. **Chống lời chèn vào ghi chú.** Mô hình AI không có công cụ nào: mã đọc dữ liệu, gọi mô hình một lần, rồi kiểm kết quả theo khuôn. Ghi chú nói "tạo việc cho X" thì cùng lắm thành một đề xuất có nhãn "Đề xuất", không tự làm gì. Ghi chú chung của người A mà Vy làm việc cho người B đọc thì chỉ ảnh hưởng đến gợi ý hiện cho B, không đọc được ghi chú riêng của A và không gửi gì cho A. Đường dẫn trong kết quả hiện dạng chữ thường ở bản đầu, nên không có cách đưa dữ liệu ra ngoài qua đường dẫn.
6. **Ngân sách và công tắc dừng khẩn cấp.** Mọi lời gọi AI đi qua bộ đếm. Cả bốn công tắc (của tổ chức, của app, của riêng người đó, và công tắc toàn hệ thống của người vận hành) được kiểm ngay cả khi người dùng bấm trong app. Mã dùng để tính chi phí do lõi tự suy ra từ người đang đăng nhập, không nhận từ đầu vào, nên không thể ghi chi phí sang người khác. Chi phí ghi theo từng người để chủ tổ chức thấy tiền đi đâu (chỉ số tiền, không có nội dung). **Mặc định không đặt trần riêng cho từng người** (công ty nhỏ không cần cài đặt). Chủ tổ chức muốn thì đặt trần cho một người.
7. **Đường đi bằng các bước kiểm thử bất biến (invariant), mỗi giai đoạn ba bước:** (a) PR chỉ sửa bộ kiểm thử, chạy được thật (không bỏ qua test nào: rẽ nhánh theo việc hàm đã tồn tại hay chưa), Platform PO gộp; (b) PR tính năng, ghim hành vi mới; (c) PR dọn, gỡ nhánh "chưa có". Bản ADR liệt kê từng thay đổi lên các quy tắc đã chấp nhận. Chỉ có một chỗ nới có chủ ý: N-6 như trên, theo đúng quy tắc của JOY.
8. **Cuộc họp dùng lại cơ chế này theo cách an toàn nhất:** kết quả của việc chạy nền nằm trong kết quả riêng của người ghi cuộc họp. Người đó bấm một lần để chia cho những người tham dự. Không có phần việc nào của Vy tự ghi vào bảng người khác đọc. Kế hoạch cuộc họp (#2554) được Frontend PO sửa riêng để trỏ tới đây.

9. **"Bộ não" của Vy nằm sau một giao diện thay thế được, còn ranh giới quyền luôn do Ludy giữ** (JOY quyết ngày 2026-11-04). Bộ não gồm kho kiến thức từ dữ liệu chung của công ty, trí nhớ dài hạn riêng cho từng người, và mô hình AI. Ludy chạy tự lưu trữ có sẵn bản dựng sẵn, chạy bằng `docker compose up` mà không cần dịch vụ ngoài: trí nhớ là bảng `member_vy_memory`, kiến thức lấy qua các câu truy vấn đã khai báo, chạy dưới quyền của đúng người đó. Ludy Cloud có thể cắm một nhà cung cấp dịch vụ được lưu trữ sẵn qua lớp Cloud riêng tư. Dù dùng bên nào, quy tắc không đổi: dữ liệu được lọc theo quyền của người đó **trước khi** gửi đi, nên nhà cung cấp không bao giờ thấy thứ người đó không đọc được. Trí nhớ của người này không bao giờ được đưa cho người khác. Nhà cung cấp không có logic phân quyền riêng, việc "người này có được xem không" luôn do Ludy quyết trước. Khi xóa (người rời tổ chức, xóa nguồn, yêu cầu xóa dữ liệu, xóa tổ chức), lệnh xóa phải tới tận nhà cung cấp, bên nào không xóa được thì không đủ điều kiện dùng. Có bài kiểm thử với một nhà cung cấp giả để ghi lại mọi thứ nó nhận được.

10. **Ai được làm việc với Vy: quyền `vy.use`, nằm trong các vai trò dựng sẵn, không phải một bảng tick từng quyền** (JOY quyết ngày 2026-11-04: "Ở chỗ set quyền có thêm 'Sử dụng trợ lý Vy'", và "có mấy pre-set role sẵn để admin có thể set/invite nhanh... cho 1 tỷ cái quyền rồi kêu set từng cái không được"). Tên hiển thị là **"Làm việc với Vy"** (tiếng Anh "Work with Vy"). Dùng "làm việc với" thay cho "trợ lý" vì quy tắc "Vy là đồng nghiệp AI, không phải trợ lý" của JOY ngày 2026-11-02; JOY chưa xác nhận cách đặt tên này, Frontend PO đang hỏi.
    - **Vai trò cơ bản:** chủ tổ chức, quản trị viên và thành viên đã có quyền này, người chỉ được xem (viewer) thì không.
    - **Các vai trò dựng sẵn theo bộ phận cũng cấp quyền này:** kế toán trưởng, kế toán viên, kế toán thuê ngoài, nhân viên kinh doanh, chăm sóc khách hàng, quản lý nhân sự. Vai trò "xem số liệu kế toán" thì không. Người quản trị chỉ cần chọn một vai trò cơ bản cộng một vai trò theo bộ phận là xong. Khi thêm vai trò mới (ví dụ Marketing cho Social và quảng cáo, đã tạo issue #2612) thì ghi rõ vai trò đó có kèm quyền này hay không.
    - **Cấp hoặc thu quyền cho riêng một người chỉ dành cho ngoại lệ**, nằm sau mục "Nâng cao" trên dòng của thành viên. Không bao giờ có màn hình liệt kê từng quyền (issue #2611 lo phần màn hình mời và thành viên).
    - **Ai được đổi ngoại lệ:** chủ tổ chức đổi được cho bất kỳ ai. Quản trị viên đổi được cho quản trị viên khác, thành viên và người chỉ xem, **không đổi được của chủ tổ chức** (giống quy tắc quản trị viên không được mời chủ). Thành viên không tự đổi của mình.
    - **Kiểm mỗi lần Vy làm việc riêng cho một người:** khi bấm trong app, mỗi lần chạy nền, khi lưu kết quả và ở bước tính ngân sách. Thu quyền thì các lần chạy đang dở của người đó dừng ngay, giống như khi gỡ người đó khỏi tổ chức.
    - **Không bao giờ mở rộng quyền đọc:** quyền này chỉ bật hoặc tắt Vy cho người đó; Vy vẫn chỉ đọc đúng phần người đó được xem. Một viewer được giao vai trò theo bộ phận sẽ làm việc với Vy được, và dòng thành viên ghi rõ điều đó.
    - Đây là thay đổi về hệ thống phân quyền nên nằm trong bước kiểm thử bất biến của giai đoạn A. Mục này thêm sau khi Platform PO duyệt bản đầu; bước duyệt khi xây giai đoạn A sẽ kiểm.

## Hai giai đoạn

- **Giai đoạn A, cho N8 (tóm tắt ghi chú, gợi ý việc cần làm):** chạy trong phiên của người bấm. Không đổi chính sách của ghi chú, không đổi danh sách bảng được ghi khi Vy làm việc chung. Không cần đường dẫn đặc biệt nào để worker đọc ghi chú. Vì lúc này Vy mang toàn quyền ghi của người đó, ranh giới là mã: các hàm tính năng chỉ biến đầu vào thành đầu ra, chỉ một lệnh lưu duy nhất ghi kết quả, và một bài kiểm thử tĩnh giữ điều đó.
- **Giai đoạn B, cho việc chạy nền (cuộc họp, #2554, và việc về sau):** ngữ cảnh riêng cho chế độ làm việc riêng từng người, danh mục ghi riêng, và bước nới N-6 có kiểm thử. Làm khi cuộc họp cần, với bước kiểm thử bất biến đi trước.

Kế hoạch cuộc họp (#2554) và kế hoạch dự án (#2556, bước P7) đều dùng chung cơ chế này, làm một lần.

## Platform PO đã quyết (không cần JOY quyết thêm)

- Hình dạng: cho việc bấm trong app, dùng ngữ cảnh người dùng của chính người đó; cho việc chạy nền, dùng một ngữ cảnh kiểu tác tử gắn với một người (mặc định từ chối, an toàn hơn).
- Các bảng được phép dùng `ctx_acting_user_id()` ghi trong một danh mục do migration điền, có cột chế độ đọc hoặc ghi, và một bài kiểm thử quét hai chiều chính sách và hàm định nghĩa so với danh mục.
- Giữ hạn xóa 30 ngày chung với ghi chú.
- Tên kỹ thuật: `member_vy`, `member_vy_result`, `member_vy_memory`, lệnh `kernel.member_vy.*`.

JOY chỉ cần quyết nếu muốn đổi thứ mà ADR để mặc định: trần chi phí mặc định cho từng người, quyền "mở khóa khẩn cấp" cho chủ tổ chức, hoặc cho phép Vy ghi thẳng vào bảng của cuộc họp thay vì bấm một lần.

## Việc tiếp theo sau khi được chấp nhận

N8-1 (kiểm thử bất biến, PR bảo vệ) rồi N8-2 (cơ chế phía máy chủ, PR bảo vệ, rồi PR dọn) rồi N8-3 (tính năng trên màn hình ghi chú). Chi tiết trong bảng N8 của [notes.md](../plan/notes.md).
