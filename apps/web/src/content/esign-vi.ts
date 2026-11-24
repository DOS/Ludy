// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy eSign page (/esign). esign-en.ts mirrors this shape. Every claim here is merged and
// usable on main today; live public CA credentials and Decree 337/2025 eContract platform reporting sit under "soon".
// Company names, amounts and document numbers are example data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';
import { N } from './roster';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const esignVi = {
  appName: 'Ludy eSign',
  meta: {
    title: 'Ludy eSign: ký tài liệu PDF qua Zalo, mẫu dùng lại, sổ tay SME, niêm phong SHA-256 và API',
    description:
      'Ludy eSign kiểm tra an toàn PDF trong hộp cát, soạn và lưu mẫu dùng lại, đặt ô ký và đóng dấu, gửi link Zalo bảo mật hoặc cổng công khai, niêm phong SHA-256, rà sổ tay hợp đồng SME, nhắc gia hạn và nối Webhook, MCP, REST API. Chạy đầy đủ khi tắt AI.',
  },
  ogTitle: 'Ký tài liệu PDF qua Zalo hoặc email, theo dõi từ soạn mẫu đến gia hạn.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Ký tài liệu PDF qua Zalo hoặc email, niêm phong SHA-256 trọn vòng đời.',
    lead: `Soạn từ hợp đồng mẫu, lưu mẫu dùng lại hoặc chuyển từ Engage, Cuộc họp, Dự án và Nhân sự, với gợi ý từ ${N.gm} theo ngân sách AI. Gửi link Zalo, liên kết trực tiếp hoặc ký tại quầy kèm OTP, đóng dấu, kiểm tra sổ tay SME, theo dõi gia hạn và tự xác minh ngoại tuyến.`,
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy eSign có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn bước từ soạn mẫu đến bản niêm phong và theo dõi',
    lead: 'Chạy trọn vẹn khi tự cài đặt với docker compose, không cần khoá trả phí hay tài khoản bên thứ ba.',
    steps: [
      {
        name: 'Chuẩn bị & kiểm tra',
        body: 'Tải PDF (tối đa 25 MB, 200 trang), soạn từ 5 mẫu doanh nghiệp Việt Nam, mở từ mẫu có sẵn thẻ chữ ký hoặc chuyển từ Engage, Cuộc họp, Dự án và Nhân sự. Hộp cát không ra mạng chặn tệp mã hoá và script ẩn.',
        outcome: 'PDF đạt chuẩn',
        tone: 'neutral',
      },
      {
        name: 'Đặt ô & rà sổ tay',
        body: `Đặt 9 loại ô (ký, ký nháy tất cả các trang, con dấu đỏ, danh sách chọn, đính kèm) bằng tay hay theo thẻ trong PDF, hoặc nhờ ${N.gm} gợi ý ô và rà 6 quy tắc sổ tay hợp đồng SME.`,
        outcome: 'Đề xuất, người tự duyệt',
        tone: 'accent',
      },
      {
        name: 'Gửi ký đa kênh',
        body: 'Ký song song hoặc tuần tự qua link Zalo sau dấu # (no-referrer), email kèm OTP 6 số tuỳ chọn, liên kết trực tiếp, cổng biểu mẫu công khai hoặc ký tại quầy, kèm sửa người nhận và uỷ quyền.',
        outcome: 'Đã gửi ký',
        tone: 'ok',
      },
      {
        name: 'Niêm phong & theo dõi',
        body: 'Đóng phẳng chữ ký, con dấu và trang chứng nhận, đối chiếu KYC đính kèm, xác minh SHA-256 ngoại tuyến, theo dõi gia hạn trên Hôm nay và phát sự kiện qua Webhook, MCP, REST API.',
        outcome: 'Đã niêm phong SHA-256',
        tone: 'ok',
      },
    ],
  },
  groups: {
    title: 'Việc Ludy eSign làm hôm nay',
    lead: 'Đủ quy trình cho hợp đồng dịch vụ, biên bản nghiệm thu, hợp đồng cộng tác viên và báo giá: soạn mẫu, kiểm tra an toàn PDF, ký trên điện thoại, rà sổ tay SME, niêm phong SHA-256 và tự động hoá.',
    items: [
      {
        id: 'mau-tai-lieu-va-soan-thao',
        title: 'Soạn hợp đồng mẫu, tái sử dụng mẫu, thẻ văn bản và đối chiếu sửa đổi',
        lead: 'Bắt đầu nhanh từ tệp PDF tải lên, 5 mẫu hợp đồng doanh nghiệp Việt Nam có sẵn hoặc thư viện mẫu dùng lại, luôn kiểm tra cấu trúc an toàn trước khi gửi.',
        points: [
          'Hộp cát không ra mạng kiểm tra PDF tối đa 25 MB và 200 trang, từ chối tệp mã hoá mật khẩu, script nhúng hoặc hành động tự mở, đồng thời tách lưu trữ riêng để không kích hoạt luồng đọc hoá đơn OCR của Ludy Tài chính',
          'Soạn hợp đồng mẫu tiếng Việt và song ngữ ngoại tuyến (NDA 2 chiều, Hợp đồng dịch vụ, Biên bản nghiệm thu, Biên bản thanh lý, Hợp đồng cộng tác viên) xuất PDF khổ A4 kèm sẵn thẻ {{signature, r1}}, {{date, r1}}, tuỳ chọn nhờ đồng nghiệp AI soạn thêm điều khoản ở dạng Đề xuất',
          'Thư viện mẫu tài liệu dùng lại với ba vai trò Người ký, Người duyệt và Nhận bản sao (CC), tự động nhận diện thẻ văn bản {{signature, r1}}, {{date, r1}}, {{text, r1}}, {{dropdown, r1, ...}} trong hộp cát ngay cả khi tắt AI',
          'Trình xem PDF thuần JavaScript (không dùng tệp .wasm) hỗ trợ 9 loại ô (Chữ ký, Chữ ký tắt, Con dấu công ty hoặc chức danh, Ngày ký, Họ tên / Chức danh, Ô tích, Danh sách chọn, Lựa chọn đơn tối đa 50 phương án, Tệp đính kèm), chữ ký và con dấu lưu sẵn cùng nút Ký nháy tất cả các trang một chạm',
          'So sánh bản sửa đổi giữa bản nháp v1 và bản đối tác chỉnh v2 theo từng trang và từng điều khoản hoàn toàn ngoại tuyến, kèm tóm tắt biến động rủi ro thương mại tuỳ chọn từ đồng nghiệp AI',
        ],
      },
      {
        id: 'chuyen-tu-quy-trinh-ludy',
        title: 'Chuyển thẳng từ báo giá Engage, biên bản họp, nghiệm thu dự án và Nhân sự',
        lead: 'Hợp đồng và biên bản phát sinh ở đâu thì khởi tạo hồ sơ ký ngay tại đó, giữ nguyên ranh giới phân quyền và bảo mật của từng phân hệ.',
        points: [
          'Chuyển một chạm từ báo giá Ludy Engage (bản nháp, đã gửi hoặc đã chấp nhận còn hạn): xuất PDF báo giá, điền sẵn người mua và hiện trạng thái đã ký ngay tại màn hình báo giá',
          'Chuyển từ biên bản cuộc họp đã chia sẻ trong Ludy Cộng tác (Ký xác nhận qua eSign): dựng PDF biên bản A4, điền sẵn người dự họp và giữ chặt quyền đọc riêng của cuộc họp (người không được chia sẻ luôn nhận mã 404, kể cả chủ sở hữu hay quản trị viên nếu cuộc họp chỉ chia sẻ cho người dự)',
          'Chuyển từ dự án không riêng tư trong Ludy Dự án (Lập biên bản nghiệm thu): điền bảng đầu việc đã xong ngay cả khi tắt AI hoặc nhờ đồng nghiệp AI tóm tắt bàn giao; khi nghiệm thu đã niêm phong, bấm một chạm để mở sẵn bản nháp hoá đơn bán ra bên Ludy Tài chính cho người duyệt số tiền',
          'Chuyển từ hợp đồng lao động trong Ludy Nhân sự với quyền truy cập giới hạn cho chủ sở hữu, quản trị viên và người tạo hồ sơ, kèm thông báo tuân thủ Nghị định 337/2025/NĐ-CP về điều kiện chữ ký số CA công cộng, dấu thời gian, xác thực VNeID/CCCD và mã định danh trên Nền tảng quốc gia Bộ Nội vụ',
        ],
      },
      {
        id: 'ky-qua-zalo-truc-tiep-va-tai-quay',
        title: 'Link Zalo sau dấu #, liên kết trực tiếp, cổng biểu mẫu công khai và ký tại quầy',
        lead: 'Người nhận mở trên điện thoại từ 360px trở lên để ký, đóng dấu, tải tệp đính kèm hoặc bấm phê duyệt, không cần tài khoản hay vượt CAPTCHA.',
        points: [
          'Mã mở liên kết ký 32 byte đặt sau dấu # (/-/sign#<token>): máy chủ chỉ lưu mã băm SHA-256, trình duyệt xoá dấu # khỏi thanh địa chỉ khi tải xong, luôn gắn header Referrer-Policy: no-referrer, không gắn CAPTCHA và giữ kín tệp PDF với lượt sau trong chế độ ký tuần tự',
          'Hỗ trợ cả link Zalo và email kèm OTP 6 chữ số tuỳ chọn (hiệu lực 10 phút, tối đa 5 lần nhập sai và 3 lần gửi mỗi giờ), liên kết ký trực tiếp cố định cho mẫu 1 người ký hoặc duyệt (/-/sign/d#<token>), và cổng biểu mẫu công khai tự chọn theo tổ chức (/-/sign/p/<orgSlug>)',
          'Trên màn hình ký di động, người ký vẽ tay, gõ tên hoặc dùng chữ ký đã lưu (chỉ nhận PNG, chặn SVG/XML), đóng dấu đỏ công ty hoặc chức danh, chọn danh sách hoặc lựa chọn đơn, tải tệp đính kèm xác minh (CCCD, Giấy ĐKKD, Giấy uỷ quyền tối đa 10 MB PDF/PNG/JPEG) và xem bản tóm tắt điều khoản chính do người gửi tự duyệt mà không gọi AI công khai; người duyệt có giao diện phê duyệt riêng gọn nhẹ',
          'Hỗ trợ sửa thông tin người nhận chưa ký ngay khi hồ sơ đang chạy mà không huỷ chữ ký của người đã ký xong (tự thu hồi mã cũ), cho phép bật uỷ quyền ký có ghi nhật ký kiểm toán (tối đa 2 lần) và chế độ Ký trực tiếp tại quầy mở thẻ /-/sign độc lập 30 phút ghi rõ nhân viên phụ trách',
        ],
      },
      {
        id: 'niem-phong-kyc-va-xac-minh',
        title: 'Niêm phong SHA-256, đối chiếu KYC đính kèm, ranh giới CA và xác minh ngoại tuyến',
        lead: 'Khi các bên hoàn tất, Ludy đóng phẳng PDF kèm trang chứng chỉ vừa khổ trang cuối, kiểm tra tệp định danh người ký và cho phép kiểm tra lại ngay trên trình duyệt.',
        points: [
          'Hộp cát làm phẳng chữ ký PNG, con dấu đỏ, lựa chọn và chữ tiếng Việt chuẩn dấu (Be Vietnam Pro), loại bỏ script tương tác, nối trang Chứng nhận ký kết điện tử đúng kích thước trang cuối tài liệu và gửi email kèm bản niêm phong cùng certificate.json cho các bên và CC (đính kèm trực tiếp dưới 18 MB)',
          'Chuỗi sự kiện nối đuôi bằng mã băm SHA-256 (chỉ cho thêm mới, bị cơ sở dữ liệu chặn sửa hoặc xoá) lưu đủ dấu vết ký, uỷ quyền, sửa người nhận, ký tại quầy và mã băm tệp đính kèm cùng mã chứng chỉ dạng CS-XXXX-XXXX-XXXX',
          'Đối chiếu chứng từ KYC đính kèm ngay trong màn hình hồ sơ (không mở ra trang ký công khai): tự động kiểm tra SHA-256, loại tệp và tách mã số thuế MST (10 hoặc 13 số), số CCCD (12 số) và tên pháp nhân từ PDF trong hộp cát, tuỳ chọn nhờ đồng nghiệp AI so sánh ở dạng Đề xuất trước khi con người bấm Đánh dấu đã khớp hoặc Cần kiểm tra lại',
          'Màn hình Xác minh tệp (/sign/verify) tính mã băm SHA-256 bằng Web Crypto ngay trên máy để đối chiếu với certificate.json hoặc tra cứu mã chứng chỉ; đồng thời sẵn sàng chế độ Sandbox PAdES ngoại tuyến và giao diện kết nối VNPT SmartCA, Viettel MySign, MISA WeSign trong Cài đặt',
        ],
      },
      {
        id: 'theo-doi-gia-han-va-vy',
        title: 'Sổ tay hợp đồng SME, nghĩa vụ gia hạn, nhắc hạn trên Hôm nay và hỏi đáp kho',
        lead: 'Hợp đồng sau khi ký tiếp tục được theo dõi nghĩa vụ, cảnh báo trước hạn trên màn hình Hôm nay và cho phép tra cứu theo đúng quyền đọc của từng thành viên.',
        points: [
          'Sổ tay rà soát hợp đồng SME có sẵn 6 quy tắc mặc định Việt Nam (bao gồm giới hạn phạt vi phạm 8% theo Điều 301 Luật Thương mại 2005, thanh toán tối đa 30 ngày, báo trước chấm dứt, gia hạn tự động, tài phán Việt Nam và tiêu chí nghiệm thu): kiểm tra theo từ khoá tất định khi tắt AI hoặc nhờ đồng nghiệp AI chấm kèm trích dẫn từng trang và mẫu câu đề xuất sửa đổi chép một chạm',
          'Theo dõi nghĩa vụ sau ký và ngày hết hạn ở thẻ Sắp gia hạn / Nghĩa vụ (giá trị hợp đồng lưu dạng chuỗi thập phân chính xác, thời hạn báo trước gia hạn và các mốc bàn giao thanh toán), cho phép nhập tay hoặc nhờ đồng nghiệp AI trích xuất kèm trích dẫn trang để người dùng xác nhận',
          'Tự động đưa hồ sơ sắp hết hạn ký trong 48 giờ, hồ sơ bị từ chối chưa xác nhận, hợp đồng vào cửa sổ báo trước gia hạn 30 ngày và nghĩa vụ quá hạn lên màn hình Hôm nay (hoàn toàn bằng quy tắc cố định, không tốn AI), kèm tối đa 1 email nhắc tự động trước 24 giờ cho người nhận qua email',
          'Tra cứu và Hỏi đáp kho hợp đồng theo phạm vi quyền đọc của từng người: tìm kiếm từ khoá tức thì trên các điều khoản, tóm tắt và nghĩa vụ đã xác nhận khi tắt AI hoặc hỏi bằng ngôn ngữ tự nhiên để nhận câu trả lời có trích dẫn trang; hợp đồng nhân sự và biên bản họp mật luôn được lọc chặt trước khi đếm hay trả lời',
        ],
      },
      {
        id: 'tich-hop-webhook-mcp-va-api',
        title: 'Tự động hoá với Webhook HMAC, 4 công cụ MCP chỉ đọc và REST API tạo nháp',
        lead: 'Kết nối ERP, CRM, cửa hàng trực tuyến hoặc n8n theo nguyên tắc tối thiểu quyền, giấu kín khóa bí mật và giữ ranh giới bảo mật theo từng tổ chức.',
        points: [
          'Webhook HTTPS sự kiện ký kết (envelope sent, signed, completed, declined, expired): khóa whsec_ mã hoá tại lớp biên, hỗ trợ xoay khóa song song 24 giờ, kiểm tra tên miền công khai chống SSRF và thử lại 8 lần; chỉ gửi mã định danh, trạng thái và SHA-256 (không gửi PDF, email, SĐT, OTP hay link ký) và tự động loại trừ hợp đồng nhân sự cùng biên bản họp',
          '4 công cụ MCP chỉ đọc cho cấp công ty dưới quyền ludy.read (ludy_sign_envelopes_list, ludy_sign_envelope_get, ludy_sign_renewals_list, ludy_sign_templates_list) giúp công cụ AI bên ngoài xem tiến độ, nghĩa vụ đã xác nhận và danh sách mẫu mà không lộ thông tin cá nhân người ký, token hay hồ sơ mật',
          'REST API ngoài có phạm vi (/api/v1/sign/*) dùng khóa ludy_sk_* chỉ lưu mã băm SHA-256 với hai quyền sign:read và sign:draft (việc tạo khóa cần xác thực 2 lớp gần nhất nếu tài khoản bật MFA): đọc hồ sơ, tải bản niêm phong, lấy chứng chỉ hoặc tạo hồ sơ từ mẫu ở trạng thái nháp chờ con người kiểm tra và bấm gửi',
          'Bật tắt độc lập cho từng tổ chức: khi tắt eSign, biểu tượng ứng dụng biến mất, toàn bộ cổng công khai, liên kết trực tiếp, API, Webhook giao hàng và công cụ MCP trả về cùng mã 404 hoặc từ chối nhất quán trong khi tác vụ dọn dẹp hết hạn vẫn vận hành an toàn',
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Hai phần dưới đây đã có nền tảng kết nối trong mã nguồn nhưng còn phụ thuộc thông số đối tác thực tế và thẩm định pháp lý trước khi bật cho doanh nghiệp dùng rộng rãi.',
    label: 'Sắp ra mắt',
    items: [
      {
        title: 'Kết nối chữ ký số công cộng trực tiếp (VNPT SmartCA, Viettel MySign, MISA WeSign) và ký số PAdES-LTV',
        body: 'Giao diện cấu hình theo từng tổ chức, khối kết nối chuẩn PAdES-LTV và chế độ Sandbox PAdES ngoại tuyến đã sẵn sàng trong Ludy eSign. Việc bật nhà cung cấp chữ ký số công cộng thực tế đang chờ hoàn tất thẩm định pháp lý (#62) theo Luật Giao dịch điện tử 20/2023/QH15, Nghị định 23/2025/NĐ-CP cùng thông số tài khoản đối tác của từng doanh nghiệp.',
      },
      {
        title: 'Chứng thực hợp đồng lao động điện tử theo Nghị định 337/2025/NĐ-CP và báo cáo Bộ Nội vụ',
        body: 'Hợp đồng lao động chuyển từ Ludy Nhân sự hiện hiển thị rõ thông báo tuân thủ Nghị định 337/2025/NĐ-CP và khóa quyền xem chặt. Kết nối trực tiếp với đơn vị eContract được cấp phép để gắn dấu thời gian, xác thực VNeID/CCCD và cấp mã định danh trên Nền tảng quốc gia Bộ Nội vụ trong 24 giờ đang chờ rà soát pháp lý (#62) và tích hợp đối tác.',
      },
    ],
  },
  coworker: {
    title: `${N.gm} làm gì trong Ludy eSign`,
    lead: `${N.gm} là tổng quản AI điều phối xuyên suốt mọi ứng dụng của Ludy. Trong Ludy eSign, ${N.gm} chạy qua đồng hồ ngân sách AI của Ludy AI khi bạn bấm yêu cầu; mọi chức năng ký, mẫu, sổ tay, kiểm tra KYC, kho hợp đồng và API đều hoạt động đầy đủ khi tắt AI.`,
    doesTitle: `${N.gm} làm`,
    does: [
      'Đọc văn bản PDF đã tách để đề xuất vị trí ô chữ ký, ký nháy, ngày ký và họ tên cho từng người nhận',
      'Tóm tắt điều khoản chính, gắn cờ điều khoản rủi ro, so sánh biến động rủi ro giữa bản v1 và v2, và gợi ý điều khoản bổ sung khi soạn hợp đồng mẫu',
      'Chấm đối chiếu theo Sổ tay quy tắc SME kèm câu trích nguyên văn theo trang và gợi ý sửa đổi chép một chạm; tóm tắt đầu việc hoàn thành cho biên bản nghiệm thu dự án',
      'Trích xuất đề xuất ngày hiệu lực, gia hạn, giá trị và nghĩa vụ sau ký; so sánh chứng từ KYC đính kèm với thông tin pháp nhân; và trả lời Hỏi đáp kho hợp đồng kèm trích dẫn trang trong phạm vi quyền đọc của bạn',
      'Tuân thủ ngân sách tháng, công tắc từng tính năng và nút Dừng AI trong Ludy AI; tự động chuyển về quy tắc tất định và thao tác thủ công khi AI tắt',
    ],
    doesNotTitle: `${N.gm} không làm`,
    doesNot: [
      'Không tự áp dụng ô ký, không tự ghi nhận kết quả sổ tay, nghĩa vụ gia hạn hay xác nhận khớp KYC khi chưa có người bấm duyệt',
      'Không bao giờ tạo token ký, gửi email mời ký, sửa nội dung PDF đã ký, từ chối thay người ký hay gọi AI trên các trang ký công khai (/-/sign, /-/sign/d, /-/sign/p)',
      'Không làm lộ hợp đồng lao động hay biên bản cuộc họp mật ra ngoài phạm vi quyền đọc, và không thay thế luật sư hoặc chữ ký số công cộng khi pháp luật bắt buộc',
    ],
  },
  audience: {
    title: 'Ludy eSign dành cho ai',
    lead: 'Dùng độc lập cho hợp đồng hằng ngày, nối liền quy trình bán hàng, dự án, nhân sự hoặc tích hợp hệ thống nội bộ.',
    items: [
      {
        title: 'Chủ doanh nghiệp nhỏ và hộ kinh doanh Việt Nam',
        body: 'Soạn nhanh 5 mẫu hợp đồng phổ biến, rà trần phạt 8% Điều 301 và 6 quy tắc SME, đóng con dấu đỏ, ký nháy tất cả các trang và gửi link Zalo để đối tác ký trên điện thoại trong vài chục giây.',
      },
      {
        title: 'Đội bán hàng, dự án, họp nhóm và nhân sự dùng Ludy',
        body: 'Chuyển thẳng báo giá Engage, biên bản họp đã chia sẻ, biên bản nghiệm thu dự án sang hoá đơn Tài chính và hợp đồng lao động giữ kín quyền đọc, kèm nhắc gia hạn tự động trên màn hình Hôm nay.',
      },
      {
        title: 'Kỹ sư và tổ chức tự cài đặt hoặc tự động hoá',
        body: 'Mã nguồn mở AGPL chạy trọn trên docker compose với hộp cát PDF không ra mạng, Webhook ký số HMAC xoay khóa 24 giờ, 4 công cụ MCP chỉ đọc và REST API tạo nháp có kiểm soát.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy eSign',
    items: [
      {
        q: 'Chữ ký trong Ludy eSign hôm nay có giá trị sử dụng thế nào?',
        a: 'Phiên bản hiện tại cung cấp chữ ký điện tử tự chủ kèm chuỗi sự kiện nối băm SHA-256, tuỳ chọn OTP email, tệp đính kèm xác minh và niêm phong PDF SHA-256, phù hợp với hợp đồng thương mại và biên bản nghiệm thu khi các bên thoả thuận giao dịch điện tử theo Luật Giao dịch điện tử 20/2023/QH15. Các chứng từ bắt buộc chữ ký số công cộng PAdES-LTV (hoá đơn GTGT, tờ khai thuế) hoặc hợp đồng lao động điện tử nộp Bộ Nội vụ theo Nghị định 337/2025/NĐ-CP cần chờ bật kết nối CA thực tế và hoàn tất rà soát pháp lý (#62).',
      },
      {
        q: 'Người nhận ký qua link Zalo, liên kết trực tiếp hay cổng công khai có cần tài khoản hay vượt CAPTCHA không?',
        a: 'Không. Người nhận mở đường dẫn đặt mã sau dấu # (/-/sign#<token>, /-/sign/d#<token> hoặc chọn biểu mẫu trên cổng /-/sign/p/<orgSlug>), xác thực OTP email 6 chữ số nếu người gửi bật, điền chữ ký/con dấu/lựa chọn/đính kèm rồi xác nhận đồng ý mà không cần tài khoản Ludy hay vượt CAPTCHA.',
      },
      {
        q: 'Nếu tắt AI hoặc hết ngân sách tháng thì các tính năng mới có hoạt động không?',
        a: `Có. Toàn bộ luồng tải và kiểm tra PDF, đặt 9 loại ô, thẻ văn bản {{signature, r1}}, 5 mẫu hợp đồng A4, so sánh bản sửa đổi v1/v2, kiểm tra từ khoá Sổ tay SME, tách MST/CCCD trong kiểm tra KYC, tìm kiếm kho hợp đồng, nhập nghĩa vụ sau ký, Webhook HMAC, REST API, ký trên điện thoại, niêm phong SHA-256 và xác minh ngoại tuyến đều chạy đầy đủ không cần AI. ${N.gm} chỉ là lớp đề xuất tuỳ chọn.`,
      },
      {
        q: 'Hợp đồng lao động và biên bản cuộc họp mật được bảo vệ như thế nào?',
        a: 'Hợp đồng lao động (hr_contract) chỉ chủ sở hữu, quản trị viên và người tạo hồ sơ mới xem hoặc tải tệp được; biên bản cuộc họp (meeting_minutes) chỉ người có quyền đọc cuộc họp đó mới truy cập được (người ngoài nhận mã 404). Cả hai loại hồ sơ này luôn bị loại trừ tự động khỏi Webhook outbound, 4 công cụ MCP chỉ đọc và REST API /api/v1/sign/*.',
      },
      {
        q: 'Ludy eSign kết nối với ERP, CRM, n8n hoặc công cụ AI ngoài ra sao?',
        a: 'Bạn cấu hình Webhook HTTPS có chữ ký HMAC (khóa whsec_ xoay song song 24 giờ), cấp khóa REST API ludy_sk_* theo từng phạm vi sign:read và sign:draft (API chỉ tạo bản nháp chờ con người duyệt và gửi, không tự động gửi ký), hoặc mở 4 công cụ MCP chỉ đọc dưới quyền ludy.read để công cụ AI bên ngoài đọc tiến độ hợp đồng không mật.',
      },
      {
        q: 'Làm sao xác minh tệp PDF đã niêm phong mà không phải gửi tệp lên mạng?',
        a: 'Mở màn hình Xác minh tệp (/sign/verify) và thả tệp PDF đã niêm phong vào. Trình duyệt dùng Web Crypto API tính mã băm SHA-256 ngay tại máy của bạn rồi đối chiếu ngoại tuyến với tệp certificate.json hoặc tra cứu trạng thái qua mã chứng chỉ.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy eSign cho trọn vòng đời hợp đồng của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    hero: {
      label: 'Một hồ sơ ký trong Ludy eSign với người nhận, con dấu, đề xuất của AI và sổ tay kiểm tra',
      docTitle: 'Hợp đồng cung ứng bao bì Q4/2026',
      sourceChip: 'Từ báo giá BG-2026-018',
      routingChip: 'Ký tuần tự',
      inspectBadge: 'PDF đạt chuẩn, 4 trang',
      signersTitle: 'Người nhận (3)',
      signers: [
        { order: 'Lượt #1', name: 'Anh Tuấn', detail: 'Người ký · link Zalo · ký nháy 3 trang', state: 'Chờ ký', tone: 'accent' as Tone },
        { order: 'Lượt #2', name: 'Chị Hoa', detail: 'Người ký · email + OTP · đính kèm ĐKKD', state: 'Chờ lượt', tone: 'neutral' as Tone },
        { order: 'CC', name: 'Kế toán trưởng', detail: 'Nhận bản niêm phong khi hoàn tất', state: 'Nhận bản sao', tone: 'neutral' as Tone },
      ],
      pageLabel: 'Trang 4 / 4',
      partyA: 'Đại diện Bên A: Gạo Sạch Mekong',
      partyB: 'Đại diện Bên B: Công ty CP Bao Bì Phú Thịnh',
      placedField: 'Chữ ký & Con dấu đỏ, Anh Tuấn',
      proposalBadge: `Đề xuất từ ${N.gm}`,
      proposalField: 'Chữ ký & Ngày ký, Chị Hoa',
      applyBtn: 'Áp dụng',
      dismissBtn: 'Bỏ qua',
      vyTitle: `${N.gm} rà điều khoản & Sổ tay SME`,
      vyClause: 'Điều 5.2: Phạt chậm giao hàng 8% giá trị phần bị vi phạm (đạt trần Điều 301). Cần báo trước gia hạn 30 ngày.',
      vyRisk: 'Sổ tay 5/6 đạt · Trang 3',
      sendBtn: 'Gửi yêu cầu ký',
      sendNote: 'Chỉ con người mới khoá bố cục và bấm gửi',
    },
    templatesAndDrafting: {
      title: 'Soạn mẫu A4, thư viện mẫu, thẻ văn bản và so sánh sửa đổi',
      sub: 'Chạy 100% khi tắt AI · Hộp cát không ra mạng',
      starterTitle: '5 mẫu hợp đồng doanh nghiệp Việt Nam',
      starterKinds: ['NDA 2 chiều', 'Hợp đồng dịch vụ', 'Biên bản nghiệm thu', 'Biên bản thanh lý', 'Hợp đồng CTV'],
      tagsTitle: 'Nhận diện thẻ văn bản & đặt ô nhanh',
      tagsDetected: ['{{signature, r1}}', '{{date, r1}}', '{{dropdown, r1, ...}}'],
      initialAllBadge: 'Ký nháy tất cả trang 1..3 (1 chạm)',
      paletteTitle: '9 loại ô ký, con dấu và đính kèm',
      fieldTypes: ['Chữ ký', 'Ký nháy', 'Con dấu đỏ', 'Ngày ký', 'Họ tên', 'Ô tích', 'Danh sách chọn', 'Lựa chọn đơn', 'Đính kèm KYC'],
      diffTitle: 'So sánh bản sửa đổi (v1 -> v2)',
      diffBadge: '1 sửa đổi · Điều 7.1',
      diffNote: 'Thời hạn thanh toán đổi từ 15 ngày sang 30 ngày (Trang 2)',
    },
    handoffs: {
      title: 'Khởi tạo hồ sơ từ Engage, Cộng tác, Dự án và Nhân sự',
      sub: 'Giữ nguyên ranh giới phân quyền của từng ứng dụng',
      cards: [
        {
          from: 'Ludy Engage · Báo giá BG-2026-018',
          to: 'Hồ sơ ký nháp (điền sẵn người mua) -> hiện trạng thái ký ngay trên báo giá',
          badge: 'Báo giá -> eSign',
          tone: 'accent' as Tone,
        },
        {
          from: 'Ludy Cộng tác · Biên bản họp đã chia sẻ',
          to: 'PDF biên bản A4 cho người dự họp ký; ai không được chia sẻ luôn nhận mã 404',
          badge: 'Khóa theo người đọc',
          tone: 'ok' as Tone,
        },
        {
          from: 'Ludy Dự án -> eSign -> Ludy Tài chính',
          to: 'Lập biên bản nghiệm thu đầu việc đã xong -> mở nháp hoá đơn bán ra sau khi niêm phong',
          badge: 'Nghiệm thu -> Hoá đơn nháp',
          tone: 'ok' as Tone,
        },
        {
          from: 'Ludy Nhân sự · Hợp đồng lao động',
          to: 'Chỉ chủ sở hữu, quản trị viên và người tạo được xem; hiện lưu ý Nghị định 337/2025/NĐ-CP',
          badge: 'Hồ sơ mật HR',
          tone: 'warn' as Tone,
        },
      ],
    },
    ceremony: {
      title: 'Kênh gửi ký & trang ký trên điện thoại (360px)',
      urls: ['/-/sign#<token>', '/-/sign/d#<token>', '/-/sign/p/gao-sach-mekong'],
      otpBadge: 'OTP email 6 số · Không CAPTCHA',
      docTitle: 'Hợp đồng cung ứng bao bì Q4/2026',
      remainingBadge: 'Còn 1 ô và 1 đính kèm',
      sharedSummaryBadge: 'Tóm tắt tham khảo do người gửi duyệt (Trang 1..3)',
      tabs: ['Vẽ tay', 'Gõ tên', 'Con dấu'],
      activeTab: 1,
      typedName: 'Trần Thị Hoa',
      attachmentChip: 'Đính kèm: Giấy ĐKKD · 1,4 MB PDF (SHA-256)',
      consent: 'Tôi đồng ý sử dụng chữ ký điện tử và xác nhận nội dung tài liệu này.',
      submitBtn: 'Hoàn tất ký',
      declineBtn: 'Từ chối',
      delegateNote: 'Hỗ trợ sửa người nhận chưa ký, uỷ quyền tối đa 2 lần và Ký trực tiếp tại quầy (30 phút)',
    },
    sealing: {
      title: 'Niêm phong SHA-256, kiểm tra KYC & xác minh ngoại tuyến',
      certCodeLabel: 'Mã chứng chỉ',
      certCode: 'CS-7F3A-91C2-04B8',
      sourceLabel: 'SHA-256 bản gốc',
      sourceHash: '4a9c2e81b04f...7d31e5082a19',
      sealedLabel: 'SHA-256 bản niêm phong',
      sealedHash: '8f3a1c04d92b...c61e4b902f7a',
      chainBadge: 'Chuỗi băm toàn vẹn (9 sự kiện)',
      kycTitle: 'Đối chiếu đính kèm KYC (chỉ người gửi xem)',
      kycStatus: 'Đã khớp MST 0312345678 · ĐKKD Bao Bì Phú Thịnh',
      kycNote: 'Tách MST/CCCD trong hộp cát, người gửi tự xác nhận khớp hay cần kiểm tra lại',
      verifyTitle: 'Xác minh ngoại tuyến (/sign/verify) & ranh giới CA',
      verifyNote: 'Web Crypto tính SHA-256 tại máy; sẵn Sandbox PAdES ngoại tuyến, CA công cộng chờ #62',
      verifyResult: 'Toàn vẹn - khớp bản niêm phong gốc',
      caBadge: 'Sandbox PAdES sẵn · Email kèm PDF + certificate.json',
    },
    obligationsAndPlaybook: {
      title: 'Sổ tay SME, gia hạn sau ký & hỏi đáp kho hợp đồng',
      playbookTitle: 'Sổ tay 6 quy tắc hợp đồng Việt Nam',
      playbookRule: 'Điều 301 Luật Thương mại 2005: trần phạt vi phạm <= 8%',
      playbookVerdict: 'Đạt · Trang 3',
      redlineLabel: 'Mẫu câu đề xuất sửa (sao chép 1 chạm)',
      redlineText: '"Mức phạt vi phạm không vượt quá 8% giá trị phần nghĩa vụ hợp đồng bị vi phạm."',
      renewalTitle: 'Theo dõi gia hạn & nhắc trên Hôm nay',
      renewalMeta: 'Bao Bì Phú Thịnh · 120.000.000 VND · Hết hạn 31/12/2026',
      renewalBadge: 'Báo trước 30 ngày · Nhắc email 24h trước hạn',
      vaultTitle: 'Hỏi đáp kho hợp đồng (lọc theo quyền đọc)',
      vaultQuery: 'Hợp đồng nào tự động gia hạn trong quý này?',
      vaultAnswer: '1 hợp đồng khớp (Trang 2): tự gia hạn nếu không báo trước 30 ngày. Bỏ qua HR và họp mật.',
      aiOffNote: 'Tắt AI vẫn chạy đủ kiểm tra từ khoá sổ tay, tìm kiếm kho và danh sách Sắp gia hạn.',
    },
    integrations: {
      title: 'Webhook HMAC, 4 công cụ MCP chỉ đọc & REST API /api/v1/sign/*',
      sub: 'Không rò PDF, email hay hồ sơ mật',
      webhookTitle: 'Webhook sự kiện ký kết (HTTPS + HMAC)',
      webhookUrl: 'https://erp.gaosach.example/hooks/sign',
      webhookSecretLabel: 'Khóa',
      webhookSecretPrefix: 'whsec_',
      webhookRotationNote: 'xoay song song 24h',
      webhookPayload: 'Chỉ gửi ID, trạng thái, SHA-256 · Loại trừ HR & Cuộc họp',
      mcpTitle: '4 công cụ MCP công ty (ludy.read)',
      mcpTools: ['ludy_sign_envelopes_list', 'ludy_sign_envelope_get', 'ludy_sign_renewals_list', 'ludy_sign_templates_list'],
      apiTitlePrefix: 'REST API phạm vi theo khóa',
      apiKeyPrefix: 'ludy_sk_*',
      apiTitleSuffix: '',
      apiScopes: [
        { code: 'sign:read', route: '', text: 'xem hồ sơ & tải bản niêm phong' },
        { code: 'sign:draft', route: 'POST /from-template', text: 'chỉ tạo bản nháp (người dùng bấm gửi)' },
      ],
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type EsignCopy = typeof esignVi;
