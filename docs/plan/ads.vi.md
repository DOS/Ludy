# Ludy Ads: tóm tắt kế hoạch cho JOY

> Bản tóm tắt tiếng Việt của [ads.md](ads.md) và [ADR-0040](../adr/0040-ads-read-only-sources.md), ngày 2026-11-01. **Cả sáu câu hỏi đã được JOY trả lời ngày 2026-11-01** (xem mục "Câu trả lời của JOY" ở cuối); lát A1 (kênh quảng cáo giả, màn hình, dải so sánh với sổ) đang được build trong #2217.

## Ads làm gì, cho ai

Một công ty một người hoặc doanh nghiệp nhỏ chạy quảng cáo trên Meta (Facebook, Instagram), Google và TikTok. Hôm nay chủ doanh nghiệp xem số tiền chi ở ba trang quản lý quảng cáo riêng, rồi vài tuần sau mới thấy cùng số tiền đó trong sổ sách, dưới dạng dòng thẻ hoặc ngân hàng và hóa đơn.

Ludy Ads đọc số liệu từ nền tảng (chỉ đọc, không sửa gì bên đó) và đặt cạnh sổ kế toán, để trả lời hai câu hỏi: "tháng này quảng cáo tốn bao nhiêu, đổi lại được gì?" và "mọi khoản quảng cáo đã vào sổ, đã có hóa đơn chưa?"

## Bản v1 (chỉ đọc)

- Kết nối tài khoản quảng cáo bằng OAuth (token được mã hóa, dùng chung lớp kết nối với Social).
- Kéo số liệu theo ngày: chi tiêu, lượt hiển thị, lượt nhấp, kết quả, theo từng tài khoản và từng chiến dịch, đúng tiền tệ và múi giờ của tài khoản.
- Màn hình: tổng theo tháng, chi phí trên mỗi kết quả, xu hướng, tình trạng đồng bộ.
- Dải so sánh với sổ: chi tiêu của nền tảng bên cạnh số dư tài khoản chi phí quảng cáo trong sổ. Chỉ hiển thị chênh lệch, Ads không bao giờ sửa sổ.
- Nền tảng giả (`sandbox`) chạy offline để `docker compose up` dùng được mà không cần tài khoản thật.

**Ngoài v1:** tạo hoặc sửa chiến dịch, Boost (đẩy một bài đăng), ngân sách, đặt giá thầu, tệp đối tượng, biểu mẫu khách hàng tiềm năng, chia nhỏ theo tuổi giới tính khu vực, thuế GTGT và thuế nhà thầu, tác nhân AI đọc dữ liệu quảng cáo, giao diện cho agency.

## Ads nằm ở đâu trong ứng dụng

Tham chiếu (JOY, 2026-11-01, ảnh chụp bảng điều khiển Hootsuite): Ads không phải một sản phẩm riêng trên thanh bên. Nó là một nhóm bên trong sản phẩm đăng bài, cạnh Plan (lịch, bản nháp, nội dung) và Analytics, gồm hai mục là Ads và Boost.

**Đề xuất: Ads là một nhóm bên trong ứng dụng Social (đăng bài) trên thanh bên, không có mục riêng.** Cùng một người xem lịch đăng bài và số liệu quảng cáo, cả hai dùng chung kết nối nền tảng, và thêm mục thứ tư hoặc thứ năm cho một module chỉ có một hai màn hình làm thanh bên của doanh nghiệp nhỏ rối thêm. Mỗi nhóm **chỉ hiện khi module của nó được bật**: tắt `ads` thì nhóm Ads biến mất và Social giữ nguyên như hôm nay; tắt `social` mà bật `ads` thì ứng dụng vẫn hiện, chỉ có nhóm Ads (khung giao diện giữ ứng dụng khi còn một nhóm có mục đã cài), nên không cần mục riêng.

**Boost** (trả tiền đẩy một bài đăng tự nhiên) **nằm ngoài v1** vì nó ghi vào tài khoản quảng cáo và tiêu tiền, và cần nền tảng duyệt quyền ghi. Lát A1 kiểm tra xem khung giao diện có cho một module đặt mục của mình vào ứng dụng của module khác không; nếu không thì sửa khung nhỏ trong cùng PR.

## Lát cắt đầu tiên đề xuất: Meta, chỉ đọc, cạnh sổ

- Meta trước vì phần lớn chi tiêu quảng cáo của doanh nghiệp nhỏ ở Việt Nam chạy trên Facebook và Instagram, tài liệu đọc được, và cùng một đăng nhập Meta với Social.
- **Tài khoản quảng cáo của chính JOY không cần duyệt gì.** Quyền truy cập chuẩn (Standard) của Meta tự động có cho ứng dụng loại Business và đủ cho tài khoản của chủ ứng dụng. Chỉ phục vụ doanh nghiệp khác trên Ludy Cloud mới cần App Review và Business Verification.
- Google để sau: quyền `adwords` thuộc loại bị hạn chế, ứng dụng do nhà cung cấp giữ cho nhiều khách phải qua kiểm định OAuth và đánh giá an ninh CASA. Chính sách Google nói mỗi nhà quảng cáo cần Cloud project riêng, riêng công cụ mã nguồn mở cho người dùng tự mang thông tin đăng nhập thì không bị hạn chế. Vì vậy Google hợp với người tự host, không hợp với Ludy Cloud.

## Thứ tự nền tảng

| Thứ tự | Nền tảng | Tình trạng |
|---|---|---|
| 1 | Meta (Facebook, Instagram) | API đọc được. Cần một ứng dụng Meta riêng cho quảng cáo (mọi use case của Marketing API đều kèm quyền ghi `ads_management`, không gỡ được) |
| 2 | Google Ads | Developer token đã bị bỏ từ 2026-09-09, mức truy cập nay gắn với Cloud project. Người tự host mang project của mình |
| 3 | TikTok Ads | Trang tài liệu cần trình duyệt nên chưa xác nhận được token, giới hạn, duyệt ứng dụng: một người phải đọc bằng tay |
| 4 | Zalo Ads (Adtima) | Không thấy API công khai. **Chủ đã bỏ (câu 6, 2026-11-01):** không nhập CSV, không liên hệ Adtima |
| sau này | Microsoft, LinkedIn | Chỉ khi có nhu cầu |
| chưa dự kiến | X, Pinterest, Cốc Cốc | |

Mọi tin trong kế hoạch được gắn nhãn: [C] đã đọc trên trang chính thức, [S] chỉ nguồn thứ cấp (blog), [U] chưa xác nhận được.

## Tiền chi quảng cáo vào Kế toán ở đâu

- Ads **không ghi sổ**. Mọi thứ vẫn qua một đường ghi duy nhất của Finance.
- Cùng một khoản tiền xuất hiện ở bốn nơi: số liệu nền tảng (Ads lưu), dòng thẻ hoặc ngân hàng (đã có), hóa đơn hoặc biên lai (nhập qua đường tiếp nhận chứng từ như bình thường), và chi phí trong sổ (kế toán duyệt). Bản v1 chỉ so tổng theo tháng.
- Tài khoản chi phí là một cài đặt cho từng tài khoản quảng cáo: 6421 với sổ theo Thông tư 133, 641 (dịch vụ mua ngoài 6417) với sổ theo Thông tư 99/2025, theo nguồn thứ cấp. Kế toán quyết định (#61).
- Tiền tệ: Ads giữ nguyên tiền tệ của tài khoản (USD hay VND) và ghi rõ nhãn, không tự quy đổi. Dải so sánh chỉ so trực tiếp cho tài khoản VND.
- **Thuế GTGT và thuế nhà thầu nước ngoài:** luật đã đổi nhiều trong 2025 và 2026 và mọi thông tin tìm được đều từ blog hoặc trang của nhà cung cấp, nên v1 không hiển thị con số thuế nào. Kết quả tra cứu (Google Việt Nam xuất hóa đơn từ 2025-04-01, TikTok tự kê khai thuế nhà thầu, Meta chưa rõ) nằm trong kế hoạch để kế toán đối chiếu.

## Dữ liệu cá nhân

v1 **không lưu dữ liệu cá nhân**: chỉ mã và tên tài khoản, chiến dịch, và số liệu tổng hợp theo ngày. Tệp đối tượng, biểu mẫu khách hàng tiềm năng, pixel đều là dữ liệu cá nhân của người khác nên nằm ngoài v1. Meta coi số liệu tổng hợp là "Platform Data" nên ứng dụng phải có endpoint xóa dữ liệu theo yêu cầu, và có lệnh xóa lịch sử.

**Đã làm ở lát A3 (#2219):** khi Meta từ chối token, tài khoản bị **tạm dừng** (không đọc, giữ nguyên số liệu), màn hình nói rõ lý do và từ ngày nào, chủ sở hữu và quản trị viên nhận thông báo trong chuông và bấm vào là tới màn Quảng cáo để **kết nối lại**; kết nối lại cùng tài khoản thì lấy tiếp từ ngày chưa chốt, không mất ngày nào. Nút **"Xóa lịch sử đã lưu"** xóa mọi số liệu và nhật ký của tài khoản (tài khoản đã ngắt kết nối thì xóa luôn cả tài khoản); sổ kế toán không bị đụng tới. **Endpoint xóa dữ liệu của Meta** (`/api/ads/meta/data-deletion`) kiểm tra chữ ký của Meta, trả mã xác nhận và trang xem trạng thái; hệ thống đóng kết nối và xóa các tài khoản do người đó cấp quyền. Người cấp quyền chỉ được lưu dưới dạng **băm có khóa**, không lưu mã Meta của họ. Tài khoản kết nối trước lát A3 chưa có băm này: phải kết nối lại thì endpoint mới tìm thấy (hoặc chủ tự xóa lịch sử).

## Rủi ro chính

- Token Meta mang quyền ghi dù Ludy chỉ đọc. Giảm thiểu: mã hóa, chỉ worker mở, adapter chỉ có hàm đọc và có test kiểm tra, ngắt kết nối thì xóa token ngay.
- Token Meta hết hạn sau khoảng 60 ngày, không làm mới được: chủ phải đăng nhập lại, Ludy báo trước.
- Nền tảng đổi phiên bản và quy tắc: mỗi adapter ghim một phiên bản và có test với phản hồi ghi sẵn.

## Câu trả lời của JOY (2026-11-01)

1. Lát cắt đầu tiên: **"Meta cùng Google"**, chỉ đọc, cạnh sổ (A1 đến A3 cho Meta, B cho Google).
2. Meta: JOY đã có sẵn ứng dụng Meta và business portfolio, nên Business Verification có thể đã xong. Ứng dụng đó là loại cũ (App type: None) và đang ở mức **Limited** của Marketing API, nên lát A2 phải chạy được ở mức này; App Review xin sau khi A2 chạy trên tài khoản của JOY.
3. Google: **khách tự mang** project và OAuth client của mình.
4. Lịch sử: **13 tháng**, giữ lại sau khi ngắt kết nối, có thao tác "xóa lịch sử" rõ ràng (lát A3). Điều khoản Meta về lưu trữ vẫn cần luật sư đọc trước khi chạy Ludy Cloud.
5. Thuế: **v1 không hiển thị con số thuế nào**; kế toán (#61) xác nhận quy tắc trước.
6. Zalo Ads: **bỏ qua**, lát E bị bỏ, không liên hệ Adtima.

## Các câu hỏi đã đặt ra cho JOY

Mỗi câu có phương án, đề xuất và hệ quả nếu không trả lời. Chi tiết đầy đủ trong [mục 12 của ads.md](ads.md#12-questions-for-joy).

1. **Lát cắt đầu tiên là gì?** Đề xuất: **A, Meta chỉ đọc, cạnh sổ.** Khác: B Google trước, C Meta cùng Google, D chỉ chi tiêu không có kết quả. Nếu không trả lời: không mở issue build nào.
2. **Bắt đầu Business Verification và App Review của Meta cho Ludy Cloud ngay bây giờ không?** Đề xuất: **chưa**, làm sau khi lát A2 chạy trên tài khoản của JOY (có màn hình và video minh họa). Nếu không trả lời: khách Ludy Cloud chưa kết nối Meta quảng cáo được, người tự host và JOY thì được.
3. **Google Ads trên Ludy Cloud: người dùng tự mang project hay DOS giữ project chung?** Đề xuất: **tự mang project** trong v1. DOS giữ chung cần CASA, mức Standard và các quy tắc Required Minimum Functionality, và trái chính sách Google. Nếu không trả lời: làm theo kiểu tự mang project.
4. **Giữ bao nhiêu lịch sử, và khi ngắt kết nối thì sao?** Đề xuất: **13 tháng, giữ lại sau khi ngắt kết nối kèm lựa chọn xóa rõ ràng.** Khác: xóa khi ngắt, hoặc chỉ giữ 3 tháng. Nếu không trả lời: phương án đề xuất, và cần xem lại điều khoản Meta về mặt pháp lý trước khi chạy Ludy Cloud.
5. **Thuế GTGT và thuế nhà thầu trên hóa đơn quảng cáo: bao giờ hiển thị?** Người làm: kế toán (#61), qua JOY. Đề xuất: **v1 không hiển thị**, chờ kế toán xác nhận. Nếu không trả lời: như đề xuất.
6. **Hỏi Adtima xem Zalo Ads có API báo cáo không?** Người làm: JOY, qua kênh hỗ trợ của Adtima trên trang của họ. Đề xuất: **hỏi**, một tin nhắn là rõ. Nếu không trả lời: Zalo Ads chưa được hỗ trợ.

## Việc JOY phải làm tay khi bắt đầu build (không agent nào làm)

- Tạo ứng dụng Meta cho quảng cáo (use case "Measure ad performance"), thêm JOY làm quản trị viên, liên kết tài khoản quảng cáo của JOY. Không cần duyệt.
- Về sau, cho Ludy Cloud: Business Verification, App Review, URL xóa dữ liệu công khai, chính sách quyền riêng tư.
- Google (lát B): Cloud project, OAuth client, màn hình đồng ý loại External ở trạng thái In production, xác minh thương hiệu, đăng ký mức Basic.
- TikTok (lát C): ứng dụng nhà phát triển TikTok for Business, và đọc cổng tài liệu để kiểm tra token và giới hạn.
