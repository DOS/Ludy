// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy eSign page (/esign). esign-en.ts mirrors this shape. Every claim here is merged and
// usable on main today; upcoming Slice 2 features and live CA organization connections appear only under "soon".
// Company names, amounts and document numbers are example data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';
import { N } from './roster';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const esignVi = {
  appName: 'Ludy eSign',
  meta: {
    title: 'Ludy eSign: ký tài liệu PDF qua Zalo hoặc email, niêm phong SHA-256 và tự xác minh ngoại tuyến',
    description:
      'Ludy eSign kiểm tra an toàn PDF trong hộp cát, cho phép đặt ô ký thủ công hoặc nhờ đồng nghiệp AI gợi ý, gửi link Zalo không rò mã kèm OTP email tuỳ chọn, niêm phong SHA-256 với chứng chỉ kiểm toán và kiểm tra tệp ngay trên trình duyệt. Mã nguồn mở AGPL.',
  },
  ogTitle: 'Ký tài liệu PDF qua Zalo hoặc email, niêm phong SHA-256.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Ký tài liệu PDF qua Zalo hoặc email, niêm phong SHA-256.',
    lead: `Tải PDF lên hoặc chuyển từ báo giá của Ludy Engage, kiểm tra tệp an toàn và đặt ô ký với gợi ý từ ${N.gm}. Gửi link Zalo hoặc email kèm OTP tuỳ chọn, niêm phong bằng mã băm SHA-256 và xác minh tệp ngoại tuyến ngay trên trình duyệt.`,
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy eSign có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn bước từ tệp PDF đến bản đã niêm phong',
    lead: 'Chạy trọn vẹn khi tự cài đặt với docker compose, không cần khoá trả phí hay tài khoản bên thứ ba.',
    steps: [
      {
        name: 'Tải lên & kiểm tra',
        body: 'Nhận tệp PDF (tối đa 25 MB, 200 trang) hoặc chuyển thẳng từ báo giá Ludy Engage. Hộp cát không ra mạng kiểm tra cấu trúc và chặn tệp mã hoá hay chứa script ẩn.',
        outcome: 'PDF đạt chuẩn',
        tone: 'neutral',
      },
      {
        name: 'Đặt ô & rà điều khoản',
        body: `Đặt ô chữ ký, ký tắt, ngày ký, họ tên và ô tích thủ công, hoặc nhờ ${N.gm} đề xuất vị trí ô và gắn cờ điều khoản rủi ro theo ngân sách AI.`,
        outcome: 'Đề xuất, người tự duyệt',
        tone: 'accent',
      },
      {
        name: 'Gửi link Zalo hoặc email',
        body: 'Ký song song hoặc tuần tự. Chép link Zalo đặt mã sau dấu # (no-referrer) hoặc gửi email kèm OTP 6 số tuỳ chọn. Người ký mở trên điện thoại, không cần tài khoản.',
        outcome: 'Đã gửi ký',
        tone: 'ok',
      },
      {
        name: 'Niêm phong & xác minh',
        body: 'Đóng phẳng chữ ký và văn bản tiếng Việt vào PDF, nối trang chứng nhận kiểm toán kèm certificate.json và kiểm tra lại SHA-256 ngoại tuyến.',
        outcome: 'Đã niêm phong SHA-256',
        tone: 'ok',
      },
    ],
  },
  groups: {
    title: 'Việc Ludy eSign làm hôm nay',
    lead: 'Đủ quy trình cho hợp đồng dịch vụ, biên bản nghiệm thu và báo giá: kiểm tra an toàn PDF, đặt ô, ký trên điện thoại, niêm phong SHA-256 và xác minh ngoại tuyến.',
    items: [
      {
        id: 'kiem-tra-va-dat-o',
        title: 'Kiểm tra PDF an toàn, đặt ô ký và chuyển từ báo giá',
        lead: 'Hồ sơ ký nhận tệp PDF tải lên trực tiếp hoặc chuyển một bước từ báo giá Ludy Engage, luôn qua kiểm tra cấu trúc trước khi gửi.',
        points: [
          'Nhận tệp PDF tối đa 25 MB và 200 trang trong hộp cát không ra mạng: kiểm tra định dạng tệp PDF, từ chối tệp mã hoá mật khẩu và các thành phần thực thi ẩn như script, hành động mở tự động hoặc tệp nhúng',
          'Tách luồng lưu trữ riêng để các hợp đồng tải lên eSign không kích hoạt quy trình đọc hoá đơn OCR của Ludy Tài chính',
          'Trình xem PDF thuần JavaScript trên trình duyệt (không dùng tệp .wasm) với 5 loại ô (Chữ ký, Chữ ký tắt, Ngày ký, Họ tên / Chức danh, Ô tích) gán cho người ký hoặc người duyệt theo chế độ song song hoặc tuần tự, cùng vai trò người nhận bản sao để nhận bản đã niêm phong khi hoàn tất',
          'Chuyển thẳng từ báo giá của Ludy Engage (bản nháp, đã gửi hoặc đã chấp nhận còn hạn): xuất PDF báo giá, tạo hồ sơ ký gắn với báo giá, điền sẵn người mua và hiện trạng thái đã ký ngay trên màn hình báo giá',
          'Bật tắt theo từng tổ chức: khi tắt eSign, biểu tượng ứng dụng ẩn khỏi thanh chuyển, các giao diện lập trình trả về mã 404 và mọi địa chỉ ký hay xác minh công khai đều trả về cùng một mã 404 chung',
        ],
      },
      {
        id: 'ky-qua-zalo-va-otp',
        title: 'Link Zalo bảo mật sau dấu #, OTP email tuỳ chọn và ký trên điện thoại',
        lead: 'Người nhận mở liên kết ngay trên điện thoại từ 360px trở lên để vẽ tay, gõ tên ký hoặc bấm phê duyệt, không cần đăng ký tài khoản hay vượt CAPTCHA.',
        points: [
          'Mã mở liên kết (32 byte ngẫu nhiên) nằm sau dấu # của đường dẫn (/-/sign#<token>): máy chủ chỉ lưu mã băm SHA-256, trang ký xoá dấu # khỏi thanh địa chỉ ngay khi mở và luôn gửi header Referrer-Policy: no-referrer',
          'Hỗ trợ cả chép link gửi qua Zalo/chat và gửi lời mời qua email; khi ký theo thứ tự, người ở lượt sau chưa thể tải tệp PDF trước khi lượt trước hoàn tất, kèm nút nhắc ký có thời gian chờ',
          'Tuỳ chọn xác thực OTP 6 chữ số qua email (hiệu lực 10 phút, tối đa 5 lần nhập sai và 3 lần gửi mỗi giờ): tệp PDF bị giữ kín cho đến khi người ký xác nhận đúng mã OTP',
          'Khung ký trên điện thoại cho phép người ký vẽ tay hoặc gõ tên chuyển sang ảnh PNG hợp lệ (chặn tệp SVG/XML), giao diện riêng gọn nhẹ cho người duyệt không cần vẽ chữ ký, khóa chống gửi lặp trên từng token và không gắn CAPTCHA bắt buộc',
        ],
      },
      {
        id: 'niem-phong-va-xac-minh',
        title: 'Niêm phong SHA-256, chứng chỉ kiểm toán và xác minh ngoại tuyến',
        lead: 'Khi các bên ký đủ, Ludy niêm phong bản PDF cuối cùng và tạo bộ chứng cứ để bất kỳ ai cũng kiểm tra lại tính toàn vẹn.',
        points: [
          'Trong hộp cát, Ludy làm phẳng các trường biểu mẫu cũ, đóng ảnh chữ ký PNG và chữ tiếng Việt chuẩn dấu (Be Vietnam Pro), loại bỏ script tương tác và nối thêm trang Chứng nhận ký kết điện tử',
          'Mỗi hồ sơ lưu chuỗi sự kiện nối đuôi bằng mã băm SHA-256 (chỉ cho thêm mới, bị cơ sở dữ liệu chặn sửa hoặc xoá) cùng tệp certificate.json và mã chứng chỉ dạng CS-XXXX-XXXX-XXXX',
          'Màn hình Xác minh tệp (/sign/verify) tính mã băm SHA-256 ngay trên trình duyệt bằng Web Crypto để tệp hợp đồng không rời máy, đối chiếu trực tiếp với certificate.json hoặc tra cứu theo mã chứng chỉ',
          'Khi niêm phong xong, Ludy gửi email thông báo kèm bản PDF đã niêm phong và tệp certificate.json cho người gửi, người ký, người duyệt và người nhận bản sao (đính kèm trực tiếp dưới ngưỡng 18 MB, và luôn gửi kèm certificate.json, mã chứng chỉ cùng mã băm SHA-256 nếu tệp PDF lớn hơn)',
        ],
      },
      {
        id: 'goi-y-cua-vy',
        title: `${N.gm} gợi ý ô ký và rà điều khoản rủi ro`,
        lead: `Khi bật AI, ${N.gm} đọc văn bản trích từ PDF để gợi ý vị trí đặt ô và tóm tắt điều khoản đáng chú ý; khi tắt AI, toàn bộ việc đặt ô và gửi ký vẫn chạy đầy đủ.`,
        points: [
          `Các lượt gợi ý ô và tóm tắt điều khoản tính vào ngân sách trong Ludy AI, chạy không có quyền gọi công cụ, coi văn bản PDF là dữ liệu không tin cậy và kiểm tra toạ độ, trích dẫn theo từng trang`,
          `Các ô ${N.gm} gợi ý hiện dưới dạng khung viền nét đứt gắn nhãn "Đề xuất"; chỉ khi người gửi bấm Áp dụng hoặc Áp dụng tất cả thì ô mới trở thành ô ký thật, và ${N.gm} không bao giờ tự gửi hồ sơ`,
          `Nếu tổ chức tắt AI, bấm nút Dừng AI hoặc hết ngân sách tháng, ${N.gm} hiện thông báo tạm nghỉ trong khi tải tệp, đặt ô thủ công, gửi link Zalo, OTP, niêm phong và xác minh hoạt động y nguyên`,
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Ba phần dưới đây thuộc lộ trình Giai đoạn 2 hoặc đang chờ thông số kiểm thử và rà soát pháp lý nên chưa tính là có sẵn cho khách hàng dùng ngay.',
    label: 'Sắp ra mắt',
    items: [
      {
        title: 'Kết nối chữ ký số công cộng Việt Nam (VNPT SmartCA, Viettel MySign, MISA WeSign) và nhúng PAdES-LTV',
        body: 'Các khối nền tảng kết nối nhà cung cấp và nhúng chữ ký PAdES-LTV đã có trong mã nguồn; việc nối vào luồng ký hồ sơ, màn hình cài đặt khoá theo từng tổ chức, thông số kiểm thử thực tế từ nhà cung cấp và rà soát pháp lý theo Luật Giao dịch điện tử 20/2023/QH15, Nghị định 23/2025/NĐ-CP cùng Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 đang được triển khai tiếp.',
      },
      {
        title: 'Mẫu tài liệu dùng lại và liên kết ký cố định',
        body: 'Lưu sẵn bộ vai trò và vị trí ô ký mẫu để mở hồ sơ mới trong một chạm, cùng liên kết ký trực tiếp cố định cho những biểu mẫu ký lặp lại.',
      },
      {
        title: 'Nhắc gia hạn hợp đồng và chuyển từ hợp đồng lao động',
        body: 'Theo dõi ngày hết hạn của hợp đồng đã niêm phong và khởi tạo hồ sơ ký trực tiếp từ hợp đồng nhân sự trong Ludy Nhân sự.',
      },
    ],
  },
  coworker: {
    title: `${N.gm} làm gì trong Ludy eSign`,
    lead: `${N.gm} là tổng quản AI điều phối xuyên suốt mọi ứng dụng của Ludy. Trong Ludy eSign, ${N.gm} chỉ đọc khi bạn bấm yêu cầu và ngân sách AI còn cho phép; mọi quyết định đặt ô và gửi ký đều thuộc về người dùng.`,
    doesTitle: `${N.gm} làm`,
    does: [
      'Đọc văn bản PDF đã tách để đề xuất vị trí ô chữ ký, ký tắt, ngày ký và họ tên cho từng người nhận',
      'Tóm tắt nội dung chính của hợp đồng và gắn cờ các điều khoản cần xem kỹ (tự động gia hạn, phạt vi phạm, chấm dứt đơn phương) kèm trích dẫn đúng trang',
      'Tuân thủ ngân sách tháng và nút Dừng AI trong Ludy AI; khi AI tắt, mọi thao tác thủ công vẫn chạy bình thường',
    ],
    doesNotTitle: `${N.gm} không làm`,
    doesNot: [
      'Không tự áp dụng ô đề xuất vào hồ sơ ký và không tự dịch chuyển ô người dùng đã đặt',
      'Không bao giờ tạo link ký, gửi email mời ký, nhắc ký hay huỷ hồ sơ',
      'Không thay thế tư vấn pháp lý hoặc quyết định ký kết của người có thẩm quyền',
    ],
  },
  audience: {
    title: 'Ludy eSign dành cho ai',
    lead: 'Dùng độc lập cho hợp đồng hằng ngày, hoặc nối liền với bán hàng và lưu trữ chứng từ.',
    items: [
      {
        title: 'Chủ doanh nghiệp nhỏ và hộ kinh doanh',
        body: 'Gửi hợp đồng dịch vụ, thoả thuận bảo mật hay biên bản nghiệm thu qua một link Zalo gọn nhẹ để đối tác ký trên điện thoại trong vài chục giây, không còn cảnh in ra ký rồi chụp ảnh.',
      },
      {
        title: 'Đội bán hàng dùng Ludy Engage',
        body: 'Chuyển trực tiếp báo giá đang mở hoặc đã chấp nhận sang hồ sơ eSign mà không phải tải xuống rồi tải lên lại, và thấy ngay trạng thái ký ngay tại màn hình báo giá.',
      },
      {
        title: 'Người tự cài đặt trên máy chủ riêng',
        body: 'Mã nguồn mở AGPL, chạy cùng docker compose, toàn bộ tệp hợp đồng, chữ ký và chuỗi bằng chứng nằm trên máy chủ và kho lưu trữ của chính công ty bạn.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy eSign',
    items: [
      {
        q: 'Chữ ký trong Ludy eSign hôm nay có giá trị sử dụng thế nào?',
        a: 'Phiên bản hiện tại cung cấp chữ ký điện tử tự chủ kèm nhật ký sự kiện nối chuỗi băm, tuỳ chọn xác thực OTP email và niêm phong PDF SHA-256, phù hợp với hợp đồng thương mại và biên bản nghiệm thu khi các bên thoả thuận giao dịch điện tử. Các chứng từ bắt buộc dùng chữ ký số công cộng (như hoá đơn GTGT điện tử hay tờ khai thuế) cần chờ kết nối trực tiếp với tổ chức cấp chứng thư công cộng sau khi hoàn tất thông số kiểm thử và rà soát pháp lý.',
      },
      {
        q: 'Người nhận ký có cần tài khoản Ludy hay vượt CAPTCHA không?',
        a: 'Không. Người nhận chỉ cần mở đường dẫn được gửi qua Zalo hoặc email trên điện thoại hoặc máy tính, nhập mã OTP email nếu người gửi bật lớp bảo vệ đó, vẽ tay hoặc gõ tên ký rồi xác nhận đồng ý.',
      },
      {
        q: 'Vì sao đường dẫn ký dùng dấu # thay vì tham số truy vấn URL?',
        a: 'Trình duyệt không gửi phần sau dấu # lên máy chủ hay vào lịch sử Referer. Ludy đồng thời gắn header Referrer-Policy: no-referrer, xoá dấu # khỏi thanh địa chỉ ngay khi trang ký tải xong và chỉ lưu mã băm SHA-256 của từng token dùng một lần.',
      },
      {
        q: 'Nếu tắt AI thì Ludy eSign có còn ký và niêm phong được không?',
        a: `Có. Toàn bộ luồng tải PDF, kiểm tra an toàn hộp cát, đặt ô thủ công, gửi link Zalo hoặc email, xác thực OTP, ký trên điện thoại, niêm phong SHA-256 và xác minh ngoại tuyến đều chạy độc lập không cần AI. ${N.gm} chỉ là lớp hỗ trợ tuỳ chọn để gợi ý ô và rà điều khoản.`,
      },
      {
        q: 'Làm sao kiểm tra lại tệp PDF đã ký mà không phải gửi tệp lên mạng?',
        a: 'Mở màn hình Xác minh tệp (/sign/verify) và thả tệp PDF đã niêm phong vào. Trình duyệt dùng Web Crypto API tính mã băm SHA-256 ngay trên thiết bị của bạn rồi đối chiếu với tệp certificate.json ngoại tuyến hoặc tra cứu trạng thái theo mã chứng chỉ.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy eSign với hợp đồng của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    hero: {
      label: 'Một hồ sơ ký trong Ludy eSign với người nhận, ô đề xuất và rà điều khoản',
      docTitle: 'Hợp đồng cung ứng bao bì Q4/2026',
      sourceChip: 'Từ báo giá BG-2026-018',
      routingChip: 'Ký tuần tự',
      inspectBadge: 'PDF đạt chuẩn, 4 trang',
      signersTitle: 'Người nhận (2)',
      signers: [
        { order: 'Lượt #1', name: 'Anh Tuấn', detail: 'Bên A, link Zalo', state: 'Chờ ký', tone: 'accent' as Tone },
        { order: 'Lượt #2', name: 'Chị Hoa', detail: 'Bên B (Bao Bì Phú Thịnh), email + OTP', state: 'Chờ lượt', tone: 'neutral' as Tone },
      ],
      pageLabel: 'Trang 4 / 4',
      partyA: 'Đại diện Bên A: Gạo Sạch Mekong',
      partyB: 'Đại diện Bên B: Công ty CP Bao Bì Phú Thịnh',
      placedField: 'Chữ ký, Anh Tuấn',
      proposalBadge: `Đề xuất từ ${N.gm}`,
      proposalField: 'Chữ ký, Chị Hoa',
      applyBtn: 'Áp dụng',
      dismissBtn: 'Bỏ qua',
      vyTitle: `${N.gm} đọc hợp đồng`,
      vyClause: 'Điều 5.2: Phạt chậm giao hàng 8% giá trị phần bị vi phạm',
      vyRisk: 'Cần lưu ý, Trang 3',
      sendBtn: 'Gửi yêu cầu ký',
      sendNote: 'Chỉ con người mới khoá bố cục và bấm gửi',
    },
    intake: {
      title: 'Kiểm tra an toàn PDF & nguồn hồ sơ',
      sub: 'Hộp cát cô lập không kết nối mạng ngoài',
      checks: [
        'Tối đa 25 MB và 200 trang, kiểm tra cấu trúc PDF chuẩn',
        'Từ chối PDF mã hoá, script tương tác và tệp nhúng ẩn',
        'Không chạy nhầm vào luồng đọc hoá đơn của Tài chính',
      ],
      handoffTitle: 'Chuyển từ báo giá Ludy Engage',
      handoffFrom: 'Báo giá BG-2026-018, Gạo Sạch Miền Tây',
      handoffTo: 'Hồ sơ ký nháp (điền sẵn người mua)',
      paletteTitle: '5 loại ô đặt cho người ký hoặc người duyệt',
      fieldTypes: ['Chữ ký', 'Chữ ký tắt', 'Ngày ký', 'Họ tên / Chức danh', 'Ô tích'],
    },
    ceremony: {
      title: 'Trang ký công khai trên điện thoại (360px)',
      urlNote: '/-/sign#<token> · Referrer-Policy: no-referrer',
      otpBadge: 'Bảo vệ bằng OTP email 6 số',
      docTitle: 'Hợp đồng cung ứng bao bì Q4/2026',
      remainingBadge: 'Còn 1 ô bắt buộc',
      tabs: ['Vẽ tay', 'Gõ tên'],
      activeTab: 1,
      typedName: 'Trần Thị Hoa',
      consent: 'Tôi đồng ý sử dụng chữ ký điện tử và xác nhận nội dung tài liệu này.',
      submitBtn: 'Hoàn tất ký',
      declineBtn: 'Từ chối ký',
    },
    sealing: {
      title: 'Bằng chứng niêm phong & Xác minh ngoại tuyến',
      certCodeLabel: 'Mã chứng chỉ',
      certCode: 'CS-7F3A-91C2-04B8',
      sourceLabel: 'SHA-256 bản gốc',
      sourceHash: '4a9c2e81b04f...7d31e5082a19',
      sealedLabel: 'SHA-256 bản niêm phong',
      sealedHash: '8f3a1c04d92b...c61e4b902f7a',
      chainBadge: 'Chuỗi băm toàn vẹn (7 sự kiện)',
      verifyTitle: 'Xác minh tệp PDF ngoại tuyến (/sign/verify)',
      verifyNote: 'Tính SHA-256 trên trình duyệt bằng Web Crypto, tệp không rời thiết bị',
      verifyResult: 'Toàn vẹn - khớp bản niêm phong gốc',
      caBadge: 'Gửi email bản PDF đã niêm phong & certificate.json cho các bên và người nhận bản sao',
    },
    vyReview: {
      title: `${N.gm} rà điều khoản & dự phòng khi tắt AI`,
      summaryLabel: 'Tóm tắt điều khoản',
      summaryBody: 'Hợp đồng cung ứng bao bì carton 5 lớp kỳ hạn 12 tháng, thanh toán trong 15 ngày sau biên bản nghiệm thu.',
      riskLabel: 'Điều khoản cần xem kỹ',
      risks: [
        { title: 'Tự động gia hạn nếu không báo trước 30 ngày', level: 'Cần lưu ý', page: 'Trang 2', tone: 'warn' as Tone },
        { title: 'Phạt chậm giao hàng 8% giá trị đợt giao', level: 'Cần lưu ý', page: 'Trang 3', tone: 'warn' as Tone },
      ],
      aiOffTitle: 'Khi tắt AI hoặc hết ngân sách tháng',
      aiOffBody: `${N.gm} tạm nghỉ: bạn vẫn tải PDF, đặt ô thủ công, gửi link Zalo, OTP và niêm phong đầy đủ.`,
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type EsignCopy = typeof esignVi;
