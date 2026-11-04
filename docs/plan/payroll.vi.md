# Lương, bảo hiểm xã hội và thuế thu nhập cá nhân cho đội nhóm nhỏ: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [payroll.md](payroll.md) (issue #2498, 2026-11-03). Chỉ là thiết kế: chưa xây gì, chưa tốn tiền, chưa tạo tài khoản nào, chưa dùng thông tin đăng nhập nào. Mọi quy định lấy từ trang công khai, ghi rõ nguồn và mức chắc chắn. Không phải tư vấn pháp lý: kế toán (#61) và luật sư phải xác nhận.

> **Bổ sung 2026-11-04.** Tính lương là **một app riêng**, không nằm trong Kế toán (chủ sở hữu quyết định; xem phần bổ sung của ADR-0046). App mới tạm tên Ludy Nhân sự, có quyền riêng cho người xem và người chạy lương. Duyệt xong bảng lương tháng thì app Nhân sự gửi một đề xuất bút toán sang Kế toán; kế toán chỉ thấy và duyệt số tổng theo tài khoản, không thấy lương từng người.

## Làm được gì sau khi xây xong

1. Chủ hoặc quản trị viên giữ danh sách **nhân viên** với hợp đồng, các khoản lương, người phụ thuộc, tài khoản nhận lương, với quyền truy cập hẹp hơn phần sổ sách còn lại.
2. Mở **bảng lương tháng**: bắt đầu từ tháng trước, nhập phần thay đổi (giờ tăng ca, ngày nghỉ không lương, thưởng, tạm ứng). Máy tính tự tính lương gộp, bảo hiểm của người lao động, thuế TNCN có giảm trừ gia cảnh, lương thực nhận và chi phí của doanh nghiệp, theo quy định có ngày hiệu lực.
3. **Duyệt tháng**: bảng lương khóa lại, ra phiếu lương PDF, và có một đề xuất bút toán (chi phí lương, bảo hiểm, thuế) đi qua luồng duyệt thông thường.
4. **Trả lương**: file chuyển lương hàng loạt theo mẫu từng ngân hàng, phiếu chi, các khoản nộp BHXH và thuế được khớp với sao kê ngân hàng như mọi dòng khác. Ludy không tự chuyển tiền.
5. **Khai báo**: danh sách tháng cho cơ quan BHXH (mẫu D02-LT), số liệu tờ khai thuế TNCN theo quý và quyết toán năm, dữ liệu chứng từ khấu trừ, dưới dạng bảng tính để người dùng tự nộp và ký trên cổng chính thức.
6. Trợ lý tài chính (coworker) chuẩn bị bảng lương tháng từ tháng trước, báo điểm bất thường, giải thích từng dòng phiếu lương bằng lời dễ hiểu. Trợ lý chỉ thấy bảng đã **ẩn danh** (mã thay tên, không thấy tên, số căn cước, mã số thuế, tài khoản, địa chỉ). Máy tính ra con số, người duyệt; tắt AI thì lõi vẫn đủ dùng.

Không có chấm công, số dư ngày phép, cổng cho nhân viên trong các bước đầu.

## Những điều khảo sát cho thấy

- **Quy định đổi nhiều trong 2026.** Luật Thuế TNCN 109/2025 áp dụng cho cả kỳ tính thuế 2026: 5 bậc thuế (5%, 10%, 20%, 30%, 35%), giảm trừ bản thân 15,5 triệu đồng và người phụ thuộc 6,2 triệu đồng mỗi tháng; tờ khai thuế lương khai theo **quý**. Mức tham chiếu của BHXH tăng từ 2.340.000 lên **2.530.000 đồng** từ 2026-07-01, nên trần đóng đổi từ 46,8 triệu lên 50,6 triệu (nhiều nguồn vẫn ghi số cũ). Lương tối thiểu vùng đổi nữa từ 2027-01-01 (Nghị định 399/2026, công bố đúng hôm khảo sát).
- **Chỉ đọc được nguyên văn** Luật BHXH (bản hợp nhất), Bộ luật Lao động 2019 và bản dịch Luật Thuế TNCN. Nghị định, thông tư còn lại chỉ qua bình luận, và có chỗ các nguồn mâu thuẫn (cách khấu trừ tháng 1 đến 6, khoản giảm trừ y tế và giáo dục, tên các mẫu phụ lục, cổng nộp thuế).
- **Không có API công khai** của cơ quan BHXH hay cơ quan thuế cho nhà cung cấp phần mềm, và cũng chưa có XSD chính thức. Vì vậy Ludy **xuất file, không tự nộp, không ký số**; người dùng nộp và ký.
- **Dữ liệu nhân viên là loại nhạy cảm nhất.** Luật Bảo vệ dữ liệu cá nhân 91/2025 có điều riêng về dữ liệu người lao động; số căn cước là dữ liệu cơ bản, ảnh giấy tờ tùy thân là dữ liệu nhạy cảm, còn lương thì chưa chứng minh được là nhạy cảm. Hộ kinh doanh và doanh nghiệp siêu nhỏ được miễn hồ sơ đánh giá tác động, nhưng chưa rõ miễn này có phủ Ludy với tư cách bên xử lý hay không: cần luật sư.
- **Tài khoản kế toán khác nhau theo chế độ:** bảo hiểm thất nghiệp là TK 3385 theo Thông tư 133 và TK 3386 theo Thông tư 99 (cả hai đã có trong sổ tài khoản của Ludy); số hiệu mẫu chứng từ lương cũng khác nhau (02-LĐTL là bảng thanh toán lương theo TT133 nhưng là bảng thưởng theo TT99).
- **Trả lương từ 5 triệu đồng một lần phải qua ngân hàng** mới được trừ khi tính thuế thu nhập doanh nghiệp; Ludy sẽ cảnh báo.

## Những quyết định thiết kế chính

- Quy định là **dữ liệu có ngày hiệu lực, nguồn và trạng thái** (`confirmed` hoặc `commentary`), không phải hằng số trong mã. **Không duyệt được một tháng lương khi còn dùng quy định ở trạng thái `commentary`**: kế toán đọc văn bản gốc rồi chuyển trạng thái bằng một pull request.
- Nhân viên không phải thành viên tổ chức (không có đăng nhập). Bảng lương đã duyệt không sửa được; sai thì điều chỉnh ở tháng sau hoặc đảo bút toán.
- Quyền đọc lương mặc định chỉ có **chủ và quản trị viên**; mọi truy vấn đều được ghi nhật ký trước khi đọc. Số căn cước và tài khoản ngân hàng mã hóa bằng khóa riêng của từng người để xóa được sau thời hạn lưu trữ. **Không lưu ảnh giấy tờ tùy thân.**
- Một đề xuất bút toán cho mỗi tháng lương, tài khoản theo chế độ của pháp nhân.
- Ludy không nộp thay, không ký số, không chuyển tiền; chỉ xuất bảng tính và file ngân hàng.

## Việc chỉ người làm được (và ai làm)

| Ai | Việc |
| --- | --- |
| Kế toán (#61) | Đọc quy định mục 5 với văn bản gốc và chuyển trạng thái từng dòng; đưa 6 đến 10 ví dụ tính lương chi tiết đến từng đồng để làm bài kiểm thử |
| Luật sư | Dữ liệu cá nhân (miễn trừ cho bên xử lý, lưu trữ ở nước ngoài, thời hạn lưu bảng lương, xử lý yêu cầu xóa của người cũ, lương có nhạy cảm không), giấy phép dùng XSD của HTKK, có cần hợp đồng I-VAN không |
| Một doanh nghiệp nhỏ thật | Một tháng lương đã ẩn danh, mẫu chuyển lương hàng loạt của ngân hàng, file D02-LT đã được cổng BHXH chấp nhận, một tờ khai quý đã nộp |
| **Chủ sở hữu (quyết định)** | Ai được đọc lương (đề xuất: chỉ chủ và quản trị viên) và có bật lương trên Ludy Cloud trước khi luật sư trả lời hay không |

## Các bước xây (một issue, một PR mỗi bước)

1. Quy định có ngày hiệu lực và máy tính lương trong `@crove/l10n-vn`, kiểm thử bằng ví dụ của kế toán.
2. Nhân viên, hợp đồng, người phụ thuộc, quyền, nhóm dữ liệu, khóa riêng, màn hình "Nhân viên".
3. Bảng lương tháng, cổng duyệt theo trạng thái quy định, khóa bảng, phiếu lương PDF.
4. Đề xuất bút toán theo chế độ, phiếu chi, file chuyển lương ngân hàng, cảnh báo tiền mặt từ 5 triệu.
5. Xuất D02-LT, số liệu tờ khai TNCN quý và năm, dữ liệu chứng từ khấu trừ.
6. Trợ lý chuẩn bị, báo bất thường, giải thích phiếu lương trên bảng ẩn danh.
7. Bốn việc của người; ba mục Icebox (phiếu lương qua email, chấm công và phép, nhân viên nước ngoài và các khoản còn lại).
