# Kho, giá vốn và đơn hàng từ sàn thương mại điện tử: tóm tắt cho chủ sở hữu

> Tóm tắt tiếng Việt của [stock-and-marketplaces.md](stock-and-marketplaces.md) (issue #2499, 2026-11-03). Chỉ là thiết kế: chưa xây gì, chưa tốn tiền, chưa tạo tài khoản nào, chưa dùng thông tin đăng nhập nào, chưa gọi API nào. Mọi quy định và thông tin về sàn đều lấy từ trang công khai và ghi rõ mức chắc chắn. Không phải tư vấn pháp lý: kế toán (#61) phải xác nhận các quy định.

## Làm được gì sau khi xây xong

1. Người bán có **danh sách hàng hóa** và biết **tồn kho** hiện tại, lấy từ hóa đơn mua vào mà Ludy đã đọc.
2. Người bán tải báo cáo **đơn hàng** và báo cáo **thu nhập/chi trả** từ Shopee, TikTok Shop hoặc Lazada, thả vào Hộp thư đến của Ludy, kiểm tra Ludy đọc được gì rồi xác nhận một lần. Kho giảm theo từng dòng hàng đã giao, trả hàng thì cộng lại; doanh thu, phí sàn và thuế sàn khấu trừ được ghi theo từng kỳ sàn trả tiền.
3. Tiền sàn chuyển vào ngân hàng được khớp với số dư của sàn, nên "Shopee còn nợ tôi bao nhiêu" là một con số.
4. Cuối tháng Ludy đề xuất **giá vốn hàng bán** (một bút toán, bình quân gia quyền theo tháng) và một người duyệt. Có báo cáo nhập xuất tồn và thẻ kho, có kiểm kê và điều chỉnh chênh lệch.
5. Với **hộ kinh doanh**, Ludy xuất các sổ của Thông tư 152 (S1a, S2a, S2b, S2c, S2d, S2e) ra bảng tính, lấy từ cùng dữ liệu.
6. Trợ lý tài chính (coworker) gợi ý gán dòng hàng vào mặt hàng, đề xuất ánh xạ cột lạ trong báo cáo, báo hàng sắp hết và soạn nháp thư đặt thêm hàng. Máy tính quyết định con số, người duyệt; tắt AI thì lõi vẫn chạy.

## Những điều khảo sát cho thấy (và làm đổi thiết kế)

- **Đường nhập file đi trước, API đi sau.** Seller nhỏ thường không tự kết nối API được: Shopee Việt Nam có vẻ chỉ cho Shop Yêu Thích và Shopee Mall (bài của FPT Shop, không rõ ngày); TikTok Shop cho seller tự đăng ký nhưng shop phải có người quản lý tài khoản (Account Manager); Lazada cho tài khoản cá nhân tự phát triển, duyệt trong khoảng một ngày. Mọi seller đều tải được báo cáo bằng tay, nên đó là lát cắt đầu.
- **Đơn hàng sàn không phải hóa đơn.** Không có số hóa đơn, không có người mua trong sổ, hàng trăm đơn mỗi tháng, sàn trả tiền theo đợt sau khi trừ phí và (với hộ kinh doanh) trừ thuế GTGT và TNCN theo Nghị định 117/2025. Vì vậy đơn là một loại bản ghi riêng, doanh thu ghi theo từng kỳ chi trả.
- **Không lưu dữ liệu cá nhân người mua** (tên, điện thoại, địa chỉ, email). Cả ba sàn che dữ liệu này và đòi xóa trong khoảng 90 ngày. Sổ sách chỉ cần mã đơn, mã SKU, số lượng và số tiền.
- **File báo cáo của sàn chỉ biết một phần.** Shopee có báo cáo doanh thu 5 trang tính (theo từng đơn, đã có cột thuế GTGT và TNCN khấu trừ), TikTok Shop có file đơn hàng với tên cột công khai, Lazada có file mỗi dòng một đơn vị hàng. Chưa thấy file mẫu thật, chưa thấy nội dung chuyển khoản ngân hàng của kỳ chi trả. Vì vậy bộ nhập đọc cột theo hồ sơ từng sàn (có từ đồng nghĩa), và file mẫu thật của một seller là điều kiện để xây.
- **Thông tư 152/2025 đã đọc được nguyên văn.** Sổ S2d (hàng hóa) chỉ bắt buộc với hộ tính thuế thu nhập theo lãi (nhóm 3); giá vốn là bình quân gia quyền theo kỳ cho từng mặt hàng; sổ có thể giữ điện tử, lưu ít nhất 5 năm. Các quy định còn lại (ngưỡng 1 tỷ đồng, mức khấu trừ của sàn, mẫu tờ khai) chỉ từ bình luận và có chỗ mâu thuẫn giữa các nguồn: kế toán phải xác nhận.
- **Thông tư 99/2025 không thay Thông tư 133.** Doanh nghiệp nhỏ được chọn một trong hai. Ludy đã có sẵn cả hai bộ tài khoản.

## Những quyết định thiết kế chính

- Kho là sổ ghi các lần nhập xuất (chỉ thêm, không sửa); tồn kho là tổng của chúng.
- Giá vốn: bình quân gia quyền theo tháng, chốt khi đóng tháng. Hàng âm kho được cho phép (đơn sàn thường đến trước hóa đơn mua), nhưng không đóng tháng được khi còn mặt hàng âm.
- Sàn là một đối tác trong sổ; tiền sàn chuyển về xóa dần số dư phải thu của sàn. Phí sàn ghi theo kỳ chi trả, hóa đơn phí của sàn đến sau thì xóa khoản chờ hóa đơn.
- Hộ kinh doanh là một loại khách hàng, không phải sổ cái thứ hai: sổ vẫn là TT133 bên dưới, các sổ S-HKD là bảng xem được dẫn xuất. Ngưỡng, tỷ lệ phần trăm và mẫu tờ khai là dữ liệu có ngày hiệu lực.
- Ludy chỉ đọc từ sàn, không ghi ngược tồn kho lên sàn.

## Việc chỉ người làm được (và ai làm)

| Ai | Việc |
| --- | --- |
| Kế toán (#61) | Đọc các quy định của mục 5 trong kế hoạch với văn bản gốc, xác nhận các tài khoản ghi tiền của sàn và thời điểm ghi nhận doanh thu |
| Một seller thật trên mỗi sàn | Xuất mẫu báo cáo đơn hàng và báo cáo thu nhập (đã xóa cột người mua) từ Shopee, TikTok Shop, Lazada để xây và kiểm thử bộ nhập |
| Một hộ kinh doanh thật | Thử đăng ký app của chính mình trên từng sàn và báo lại cần gì, bao lâu, tốn bao nhiêu |
| **Chủ sở hữu (quyết định)** | Có đăng ký Ludy làm đối tác (partner) trên từng sàn để một app phục vụ mọi seller không. Mỗi sàn đòi giấy phép kinh doanh hoặc pháp nhân ký điều khoản, đánh giá bảo mật (khoảng 2 đến 3 tuần), địa chỉ gọi lại HTTPS; chưa thấy sàn nào thu phí đăng ký. Việc xây adapter API chờ quyết định này |
| Chủ sở hữu hoặc Accounting PO | Hỏi hỗ trợ đối tác Lazada xem Ludy tự lưu trữ gọi API có bị coi là hệ thống ERP bị cấm không |
| Chủ sở hữu | Tệp báo cáo gốc có dữ liệu người mua: mặc định xóa sau 90 ngày kể từ khi xác nhận; hay giữ lại làm chứng từ |

## Các bước xây (một issue, một PR mỗi bước)

1. Mặt hàng, bí danh, lần nhập xuất từ dòng hóa đơn mua và bán, danh sách "Chưa gán hàng".
2. Đóng tháng và giá vốn, báo cáo nhập xuất tồn, thẻ kho, kiểm kê.
3. Trợ lý: gán dòng vào mặt hàng, hàng sắp hết, nháp thư đặt hàng.
4. Nhập báo cáo đơn hàng của Shopee, TikTok Shop, Lazada.
5. Nhập báo cáo thu nhập, ghi theo kỳ chi trả, khớp tiền về ngân hàng, màn hình Sàn.
6. Loại khách hộ kinh doanh và các sổ S-HKD ra bảng tính.
7. Bảng tính tờ khai 01/CNKD (Ludy không nộp thay).
8. Loại kết nối `marketplace` trong mục Tích hợp (dùng chung với hóa đơn điện tử, #2497).
9. Việc của người (4 issue) và hàng đợi Icebox (adapter API từng sàn, nhiều kho, lô và hạn dùng, ghi ngược tồn kho).
