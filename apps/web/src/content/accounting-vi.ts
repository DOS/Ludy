// Vietnamese copy of the Ludy Kế toán page (/ke-toan). accounting-en.ts mirrors this shape. Every claim here is
// merged and usable on main today; the PR lists the PR or route behind each one. Company names, amounts and document
// numbers are example data and stay the same in both languages (the sample company is the home page's).
import type { AppPageCopy } from './app-page';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const accountingVi = {
  appName: 'Ludy Kế toán',
  meta: {
    title: 'Ludy Kế toán: hoá đơn về là có bút toán, bạn duyệt rồi mới ghi sổ',
    description:
      'Ludy Kế toán đọc hoá đơn điện tử, kiểm tra từng con số bằng quy tắc cố định và đề xuất bút toán theo Thông tư 133. Có thuế GTGT, lịch thuế, khoá sổ, kết chuyển cuối năm và xuất Excel cho MISA. Mã nguồn mở, chỉ ghi sổ khi có người duyệt.',
  },
  ogTitle: 'Hoá đơn về, bút toán đã soạn sẵn. Bạn duyệt rồi mới ghi sổ.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Hoá đơn về, bút toán đã soạn sẵn. Bạn duyệt rồi mới ghi sổ.',
    lead: 'Ludy Kế toán đọc hoá đơn điện tử, kiểm tra từng con số bằng quy tắc cố định và đề xuất bút toán theo Thông tư 133. Chỉ khi người có thẩm quyền duyệt bằng mã hai lớp, bút toán mới vào sổ.',
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Cài trên máy chủ của bạn bằng docker compose. Ludy Cloud sắp ra mắt.',
  },
  groups: {
    title: 'Việc Ludy Kế toán làm hôm nay',
    lead: 'Xếp theo việc bạn phải làm, từ lúc hoá đơn về đến lúc đóng sổ năm.',
    items: [
      {
        id: 'nhan-va-kiem-tra',
        title: 'Nhận và kiểm tra chứng từ',
        lead: 'Hoá đơn vào bằng cách tải lên hoặc chuyển tiếp email. Việc kiểm tra dùng quy tắc cố định, không dùng AI; chỗ nào chưa khớp thì hoá đơn dừng lại chờ người xem.',
        points: [
          'Hoá đơn điện tử XML theo Nghị định 254/2026 và Thông tư 91/2026, cả hoá đơn theo Nghị định 123/2020, được đọc trực tiếp từ cấu trúc XML, không cần AI',
          'PDF và ảnh chụp được đọc bằng model tương thích OpenAI do người cài đặt cấu hình. PDF chỉ chứa ảnh scan thì chưa đọc được',
          'Tải lên từng file hoặc cả file ZIP. Chuyển tiếp email vào địa chỉ nhận hoá đơn riêng của công ty cũng được, khi người cài đặt đã bật hộp thư',
          'Kiểm tra tổng các dòng, tổng thanh toán, thuế GTGT, chữ số kiểm tra của mã số thuế, hoá đơn đã có mã của cơ quan thuế chưa, chữ ký số và hoá đơn trùng',
          'Lỗi về tổng tiền chặn việc duyệt. Các cảnh báo khác chỉ duyệt được khi người duyệt xác nhận đã đối chiếu với bản gốc',
        ],
      },
      {
        id: 'ghi-so',
        title: 'Soạn bút toán và ghi sổ có kiểm soát',
        lead: 'Ludy đề xuất bút toán Nợ Có theo Thông tư 133, kèm lý do chọn tài khoản. Cho đến khi người có quyền duyệt, nó chỉ là đề xuất.',
        points: [
          'Duyệt bút toán cần mã xác thực hai lớp còn mới, trong vòng 5 phút. Mọi quyết định nằm trong nhật ký thay đổi mà không ai sửa hay xoá được',
          'Tài khoản được nhớ theo nhà cung cấp và mặt hàng, kèm người duyệt, giờ duyệt và chứng từ làm căn cứ',
          'Dòng không khớp quy tắc nào được đánh dấu chưa phân loại. Ludy không ghi sổ cho đến khi người chọn tài khoản, không đoán ngầm',
          'Hoá đơn thay thế huỷ hoá đơn gốc và đảo bút toán của nó. Hoá đơn điều chỉnh được nối với hoá đơn gốc',
          'Sổ đã ghi không sửa, không xoá. Sai thì ghi bút toán đảo',
        ],
      },
      {
        id: 'thue',
        title: 'Thuế GTGT và lịch thuế',
        lead: 'Ludy tính thuế GTGT từ sổ, chỉ ra chỗ cần xem trước khi bạn nộp tờ khai và nhắc việc theo từng khách hàng.',
        points: [
          'Thuế GTGT đầu vào và đầu ra theo tháng hoặc theo quý, tuỳ cách kê khai của công ty',
          'Tờ khai 01/GTGT xuất XML cho HTKK. Ludy điền các chỉ tiêu tính được từ sổ; cơ quan thuế, người ký và một số chỉ tiêu bạn hoàn thiện trong HTKK',
          'Số hoá đơn bán ra bị hở trong dãy được chỉ ra trước khi nộp tờ khai. Chỉ tính hoá đơn đã ghi vào sổ',
          'Kế toán trưởng đánh dấu tờ khai đã nộp. Đó là ghi nhận trong Ludy, Ludy không nộp thay lên cổng thuế',
          'Lịch thuế theo từng khách hàng và từng pháp nhân: nhắc hạn nộp và ghi dấu đã nộp. Bảng hạn nộp chưa được kế toán xác nhận, màn hình trong ứng dụng cũng ghi vậy',
          'Hoá đơn mua vào còn thiếu: tải lên danh sách xuất từ cổng thuế, Ludy so với sổ rồi gửi thư xin khách bổ sung, khi người cài đặt đã cấu hình máy chủ thư',
        ],
      },
      {
        id: 'so-sach',
        title: 'Sổ sách, khoá sổ và xuất file',
        lead: 'Sổ nhật ký chung, sổ cái và báo cáo lấy từ cùng một nguồn. Cuối kỳ khoá sổ để không ai ghi thêm; cuối năm kết chuyển và lưu gói chứng từ.',
        points: [
          'Sổ nhật ký chung, sổ cái, phiếu thu chi, tài sản cố định với khấu hao hằng tháng, số dư đầu kỳ nhập từ Excel',
          'Sao kê ngân hàng nhập từ Excel, CSV hoặc email, rồi ghép từng dòng với chứng từ, có gợi ý. Kết nối ngân hàng trực tiếp chưa có',
          'Khoá sổ theo từng tháng, theo thứ tự. Mở khoá cần chủ sở hữu hoặc kế toán trưởng và phải ghi lý do',
          'Cuối năm: kết chuyển doanh thu và chi phí sang 911, rồi kết quả sang 4212, là một bút toán đề xuất cần duyệt. Khi cả 12 tháng đã khoá, chủ sở hữu tạo gói lưu trữ năm tài chính kèm file gốc của chứng từ',
          'Xuất Excel theo mẫu nhập MISA SME cho hoá đơn mua dịch vụ, mua hàng hoá, bán hàng, phiếu thu và phiếu chi; cột danh mục như nhà cung cấp, mặt hàng, kho để kế toán điền. Mẫu lấy theo file MISA SME 2026, chưa được MISA chứng nhận',
          'Báo cáo B01-DNN và B02-DNN là bản nháp, cách ánh xạ tài khoản chưa được kế toán kiểm tra. Mỗi pháp nhân có sổ, số chứng từ, khoá sổ và tờ khai riêng, với hệ thống tài khoản TT133',
          'Tìm theo tên, mã số thuế, số hoá đơn hay số tiền, gõ không cần dấu',
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Hai việc dưới đây chưa chạy với cổng thuế và ngân hàng thật, nên Ludy chưa tính là có sẵn.',
    label: 'Sắp ra mắt',
    items: [
      { title: 'Lấy danh sách hoá đơn từ cổng thuế', body: 'Hôm nay bạn tải lên file Excel xuất từ cổng thuế, và Ludy đối chiếu với sổ.' },
      { title: 'Kết nối ngân hàng trực tiếp', body: 'Hôm nay sao kê được nhập từ file Excel, CSV hoặc email.' },
    ],
  },
  assistant: {
    title: 'Vy làm gì trong Ludy Kế toán',
    lead: 'Vy là trợ lý AI của Ludy. Trong kế toán, Vy làm phần đọc; quyết định đúng sai là của quy tắc cố định và của người.',
    doesTitle: 'Vy làm',
    does: [
      'Đọc PDF và ảnh chụp hoá đơn thành số liệu có cấu trúc',
      'Đưa kết quả vào hộp chứng từ chờ duyệt, ghi rõ là "Vy đề xuất"',
      'Nút "Dừng AI" tắt mọi việc AI của công ty ngay lập tức',
    ],
    doesNotTitle: 'Vy không làm',
    doesNot: [
      'Không ghi sổ và không duyệt thay người',
      'Không quyết định hoá đơn đúng hay sai: việc đó do quy tắc cố định',
      'Không chọn tài khoản cho dòng chưa phân loại',
    ],
  },
  audience: {
    title: 'Ludy Kế toán dành cho ai',
    lead: 'Cùng một dữ liệu, ba cách dùng.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Không cần biết kế toán. Tải ảnh hoá đơn lên hoặc chuyển tiếp email, xem nhà cung cấp và số tiền rồi bấm duyệt. Chỗ nào thiếu thông tin, Ludy chỉ ra.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Duyệt cả tháng chứng từ bằng bàn phím. Xem nhiều khách hàng ở một nơi, mỗi khách một lịch thuế. Mời kế toán bên ngoài vào làm việc trên những pháp nhân được giao. Xuất Excel và file nhập MISA SME.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, chạy bằng docker compose, dữ liệu nằm trên máy chủ của bạn. Chọn model AI tuỳ ý, kể cả model chạy tại chỗ.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Kế toán',
    items: [
      {
        q: 'Tôi không biết kế toán có dùng được không?',
        a: 'Được. Ludy soạn bút toán và nói vì sao chọn tài khoản đó. Bạn xem nhà cung cấp, số tiền, các kiểm tra và bấm duyệt. Nếu có người làm kế toán cho bạn, mời họ vào cùng công ty hoặc gửi file Excel sổ nhật ký và sổ cái.',
      },
      {
        q: 'Ludy có nộp tờ khai thay tôi không?',
        a: 'Không. Ludy xuất tờ khai 01/GTGT dạng XML cho HTKK với các chỉ tiêu tính được từ sổ. Bạn hoàn thiện và nộp trên HTKK và cổng thuế. Đánh dấu "đã nộp" trong Ludy chỉ là ghi nhận.',
      },
      {
        q: 'Ludy có lập hoá đơn bán hàng, tính lương hay quản lý kho không?',
        a: 'Chưa. Ludy đọc và ghi hoá đơn, chỉ ra số bị hở, nhưng việc lập và phát hành hoá đơn điện tử vẫn làm ở phần mềm hoá đơn của bạn. Chưa có tính lương, thẻ kho hay báo cáo lưu chuyển tiền tệ.',
      },
      {
        q: 'Dữ liệu sang MISA như thế nào?',
        a: 'Ludy xuất file Excel theo mẫu nhập MISA SME. Bạn điền các cột danh mục còn trống rồi nhập vào MISA. Chưa có kết nối trực tiếp với MISA.',
      },
      {
        q: 'Dữ liệu của tôi nằm ở đâu?',
        a: 'Với bản tự cài đặt, dữ liệu nằm trên máy chủ và kho lưu trữ của bạn. Dữ liệu mỗi công ty được tách riêng, và bạn có thể xuất dữ liệu khi cần.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Kế toán với hoá đơn của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    hero: {
      label: 'Một hoá đơn mua vào được đọc, kiểm tra và soạn thành bút toán đề xuất',
      invoiceTitle: 'Hoá đơn đã đọc',
      checksTitle: 'Kiểm tra bằng quy tắc',
      entryTitle: 'Bút toán đề xuất, TT133',
      proposal: 'Đề xuất',
      learned: 'Theo quy tắc đã học: cùng mặt hàng của nhà cung cấp này',
      approveNote: 'Nhập mã hai lớp để ghi sổ',
    },
    intake: {
      title: 'Chứng từ chờ duyệt',
      sub: 'Gạo Sạch Mekong',
      sourcesLabel: 'Chứng từ vào bằng',
      sources: [
        { label: 'Tải lên', body: 'XML, PDF, ảnh hoặc file ZIP' },
        { label: 'Email hoá đơn', body: 'Chuyển tiếp tới địa chỉ nhận riêng của công ty' },
      ],
      held: {
        party: 'Hợp tác xã Tân Hồng',
        sub: 'Phiếu mua gạo nguyên liệu',
        amount: '148.500.000 ₫',
        state: 'Giữ lại, chờ người xem',
        failed: 'Thiếu mã của cơ quan thuế',
        passed: 'Đạt: tổng dòng, thuế GTGT, mã số thuế, không trùng',
      },
    },
    posting: {
      ruleTitle: 'Quy tắc đã học',
      ruleHead: ['Nhà cung cấp', 'Mặt hàng', 'Tài khoản'],
      rule: { party: 'Bao Bì Phú Thịnh', item: 'Thùng carton 5 lớp', account: '152', by: 'Chị Lan duyệt lúc 16:05 ngày 14/10/2026' },
      unclassifiedTitle: 'Dòng chưa phân loại',
      unclassified: { item: 'Phí dịch vụ khác', amount: '1.200.000', state: 'Chọn tài khoản trước khi ghi sổ' },
      replaceTitle: 'Hoá đơn thay thế',
      replaceFrom: { name: 'HĐ 00001284', state: 'Đã huỷ, bút toán được đảo' },
      replaceTo: { name: 'HĐ 00001301', state: 'Thay thế HĐ 00001284' },
    },
    tax: {
      calendarTitle: 'Lịch thuế',
      calendarSub: 'Gạo Sạch Mekong',
      calendar: [
        { name: 'Tạm nộp thuế TNDN quý III/2026', due: '30/10/2026', note: '', state: 'Chưa đánh dấu', tone: 'neutral' as Tone },
        { name: 'Tờ khai thuế GTGT quý III/2026', due: '02/11/2026', note: '31/10 là thứ Bảy', state: 'Chưa đánh dấu', tone: 'neutral' as Tone },
        { name: 'Tờ khai thuế GTGT quý II/2026', due: '31/07/2026', note: '', state: 'Đã nộp', tone: 'ok' as Tone },
      ],
      dueLabel: 'Hạn',
      calendarNote: 'Bảng hạn nộp chưa được kế toán xác nhận.',
      returnTitle: 'Tờ khai 01/GTGT quý IV/2026',
      returnFile: 'Xuất XML cho HTKK',
      returnNote: 'Ludy điền các chỉ tiêu tính được. Cơ quan thuế, người ký và một số chỉ tiêu bạn hoàn thiện trong HTKK.',
      mailTitle: 'Thư xin hoá đơn còn thiếu',
      mailSub: 'Soạn từ danh sách cổng thuế bạn tải lên',
      mailSubject: 'Hoá đơn mua vào tháng 9/2026 còn thiếu',
      mailBody: 'Danh sách từ cổng thuế có 2 hoá đơn mua vào chưa có trong sổ. Anh chị gửi giúp bản hoá đơn:',
      mailRows: [
        ['Công ty CP Bao Bì Phú Thịnh, HĐ 00001297', '4.320.000 ₫'],
        ['EVN, hoá đơn điện tháng 9', '1.946.780 ₫'],
      ],
    },
    books: {
      closeTitle: 'Cuối năm 2026',
      closeSub: 'Gạo Sạch Mekong',
      close: [
        { name: 'Khoá sổ từng tháng', state: 'Đã khoá đủ 12 tháng', tone: 'ok' as Tone },
        { name: 'Kết chuyển sang 911 và 4212', state: 'Đề xuất, chờ duyệt bằng mã hai lớp', tone: 'accent' as Tone },
        { name: 'Gói lưu trữ năm tài chính', state: 'Chủ sở hữu tạo, kèm file gốc', tone: 'neutral' as Tone },
      ],
      exportsTitle: 'Xuất file',
      exports: [
        { name: 'MISA SME', body: 'Mua dịch vụ, mua hàng hoá, bán hàng, phiếu thu, phiếu chi', format: 'Excel' },
        { name: 'Sổ nhật ký chung, sổ cái', body: 'Theo kỳ và pháp nhân đang chọn', format: 'Excel' },
        { name: 'Tờ khai 01/GTGT', body: 'Nhập vào HTKK', format: 'XML' },
        { name: 'Tài sản cố định', body: 'Sổ tài sản và khấu hao', format: 'Excel' },
      ],
      draftNote: 'B01-DNN và B02-DNN là bản nháp.',
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type AccountingCopy = typeof accountingVi;
