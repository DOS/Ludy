// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy Tài chính page (/ke-toan). accounting-en.ts mirrors this shape. Every claim here is
// merged and usable on main today; the PR lists the PR or route behind each one. Company names, amounts and document
// numbers are example data and stay the same in both languages (the sample company is the home page's).
import type { AppPageCopy } from './app-page';
import { N } from './roster';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const accountingVi = {
  appName: 'Ludy Tài chính',
  meta: {
    title: 'Ludy Tài chính: hoá đơn về, Ludy soạn bút toán đề xuất, bạn duyệt rồi mới ghi sổ',
    description:
      'Ludy Tài chính đọc hoá đơn điện tử, kiểm tra từng con số bằng quy tắc cố định và đề xuất bút toán theo Thông tư 133. Có Bán hàng, Mua hàng, Sổ sách & Thuế, lịch thuế, khoá sổ, kết chuyển cuối năm và xuất Excel theo mẫu nhập liệu MISA SME. Mã nguồn mở, chỉ ghi sổ khi có người duyệt.',
  },
  ogTitle: 'Hoá đơn về, Ludy soạn bút toán đề xuất. Bạn duyệt rồi mới ghi sổ.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Hoá đơn về, Ludy soạn bút toán đề xuất. Bạn duyệt rồi mới ghi sổ.',
    lead: 'Ludy Tài chính đọc hoá đơn điện tử, kiểm tra từng con số bằng quy tắc cố định và đề xuất bút toán theo Thông tư 133. Chỉ khi người có thẩm quyền duyệt bằng mã hai lớp, bút toán mới vào sổ.',
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy Tài chính có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn bước từ hộp thư đến sổ cái',
    lead: 'Ludy làm ba bước đầu và ghi lại từng bước. Bước cuối luôn do người có thẩm quyền duyệt bằng mã xác thực hai lớp.',
    steps: [
      { name: 'Nhận', body: `Tải lên hoặc chuyển tiếp email. XML được đọc trực tiếp; PDF và ảnh chụp do ${N.finance} đọc.`, outcome: 'Đã nhận', tone: 'neutral' },
      { name: 'Kiểm tra', body: 'Quy tắc cố định đối chiếu tổng tiền, thuế, mã số thuế và hoá đơn trùng. Lỗi tổng tiền thì hoá đơn dừng lại.', outcome: 'Đạt hoặc giữ lại', tone: 'ok' },
      { name: 'Đề xuất', body: 'Bút toán theo TT133 vào thẻ Chờ duyệt của Chứng từ, kèm lý do chọn tài khoản. Chưa vào sổ.', outcome: 'Đề xuất, chưa ghi sổ', tone: 'accent' },
      { name: 'Duyệt', body: 'Người duyệt xem, sửa tài khoản nếu cần, nhập mã hai lớp. Lúc đó bút toán mới vào sổ.', outcome: 'Đã ghi sổ', tone: 'ok' },
    ],
  },
  groups: {
    title: 'Việc Ludy Tài chính làm hôm nay',
    lead: 'Xếp theo menu của ứng dụng: Chứng từ, Phiếu thu chi, Sao kê ngân hàng, cùng ba nhóm Bán hàng, Mua hàng và Sổ sách & Thuế.',
    items: [
      {
        id: 'nhan-va-kiem-tra',
        title: 'Chứng từ: nhận và kiểm tra',
        lead: 'Hoá đơn vào màn Chứng từ bằng cách tải lên hoặc chuyển tiếp email, nằm ở thẻ Chờ duyệt trước khi vào Tất cả chứng từ. Việc kiểm tra dùng quy tắc cố định, không dùng AI.',
        points: [
          'Hoá đơn điện tử XML theo Nghị định 254/2026 và Thông tư 91/2026, cả hoá đơn theo Nghị định 123/2020, được đọc trực tiếp từ cấu trúc XML, không cần AI',
          'PDF và ảnh chụp được đọc bằng model tương thích OpenAI do người cài đặt cấu hình. PDF chỉ chứa ảnh scan thì chưa đọc được',
          'Tải lên từng file hoặc cả file ZIP. Chuyển tiếp email vào địa chỉ nhận hoá đơn riêng của công ty cũng được, khi người cài đặt đã nối tên miền nhận thư với Ludy',
          'Kiểm tra tổng các dòng, tổng thanh toán, bảng thuế GTGT, ngày hoá đơn và hoá đơn trùng. Hoá đơn XML được kiểm thêm chữ ký số và mã của cơ quan thuế. Chữ số kiểm tra của mã số thuế cũng được xét',
          'Lệch tổng tiền chặn hẳn việc duyệt. Kiểm tra không đạt khác, hoặc chữ ký số chưa xác minh, chỉ duyệt được khi người duyệt xác nhận đã đối chiếu với bản gốc. Mã số thuế sai chữ số kiểm tra hay thiếu mã cơ quan thuế chỉ là cảnh báo',
        ],
      },
      {
        id: 'ghi-so',
        title: 'Bán hàng, Mua hàng và ghi sổ có kiểm soát',
        lead: 'Nhóm Bán hàng có Hóa đơn bán ra, Khách hàng và Hàng hóa; nhóm Mua hàng có Nhà cung cấp. Ludy đề xuất bút toán Nợ Có theo Thông tư 133, chờ người có quyền duyệt.',
        points: [
          'Duyệt bút toán cần mã xác thực hai lớp còn mới, trong vòng 5 phút. Mọi quyết định nằm trong nhật ký thay đổi, không sửa hay xoá được qua ứng dụng',
          'Nhà cung cấp và Khách hàng nhớ tài khoản theo đối tác và mặt hàng; thẻ Nhắc thu nợ trong Khách hàng soạn thư nhắc công nợ quá hạn để bạn xem rồi gửi',
          'Hóa đơn bán ra lập bản nháp và chạy thử trong môi trường sandbox tích hợp sẵn; kết nối nhà cung cấp hoá đơn điện tử thật chưa có. Hàng hóa có thẻ Tồn kho bình quân gia quyền tạm tính đến khi khoá tháng, và thẻ Sàn nhập bảng đối soát sàn (mẫu cột Shopee và TikTok Shop chưa xác nhận trên tệp người bán thật)',
          'Dòng không khớp quy tắc nào được đánh dấu chưa phân loại. Ludy không ghi sổ cho đến khi người chọn tài khoản, không đoán ngầm',
          'Khi hoá đơn thay thế được duyệt, hoá đơn gốc bị huỷ và bút toán của nó được đảo. Hoá đơn điều chỉnh được nối với hoá đơn gốc. Sổ đã ghi không sửa, không xoá',
        ],
      },
      {
        id: 'thue',
        title: 'Thuế: Tờ khai GTGT, Đối chiếu cổng thuế và lịch thuế',
        lead: 'Trong nhóm Sổ sách & Thuế, mục Thuế tính thuế GTGT từ sổ, chỉ ra chỗ cần xem trước khi nộp tờ khai và đối chiếu danh sách cổng thuế bạn tải lên.',
        points: [
          'Thuế GTGT đầu vào và đầu ra theo tháng hoặc theo quý, tuỳ cách kê khai của công ty',
          'Thẻ Tờ khai GTGT xuất tệp XML tờ khai 01/GTGT. Ludy điền các chỉ tiêu tính được từ sổ; cơ quan thuế, người ký và một số chỉ tiêu để bạn hoàn thiện. Việc HTKK và eTax nhận tệp này đang được kiểm tra cùng kế toán đối tác',
          'Số hoá đơn bán ra bị hở trong dãy được chỉ ra trước khi nộp tờ khai. Chỉ tính hoá đơn đã ghi vào sổ',
          'Chủ sở hữu, quản trị viên hoặc kế toán trưởng đánh dấu tờ khai đã nộp. Đó là ghi nhận trong Ludy, Ludy không nộp thay lên cổng thuế',
          'Lịch thuế theo từng khách hàng và từng pháp nhân: nhắc hạn nộp và ghi dấu đã nộp. Bảng hạn nộp chưa được kế toán xác nhận, màn hình trong ứng dụng cũng ghi vậy',
          'Thẻ Đối chiếu cổng thuế: tải lên danh sách xuất từ cổng thuế, Ludy so với sổ rồi gửi thư xin khách bổ sung hoá đơn mua vào còn thiếu, khi người cài đặt đã cấu hình máy chủ thư',
        ],
      },
      {
        id: 'so-sach',
        title: 'Sổ sách & Thuế: Bút toán, Sổ sách, Tài sản, khoá sổ và xuất file',
        lead: 'Bút toán, Sổ sách, Tài sản, Phiếu thu chi và Sao kê ngân hàng dùng chung một nguồn sổ cái. Cuối kỳ khoá sổ; cuối năm kết chuyển và lưu gói chứng từ.',
        points: [
          'Bút toán (sổ nhật ký chung), Sổ sách (sổ cái), Phiếu thu chi, Tài sản cố định với khấu hao hằng tháng, số dư đầu kỳ nhập từ Excel, và sổ doanh thu S1a cho pháp nhân Hộ kinh doanh (ngưỡng thuế đang chờ xác nhận kế toán)',
          'Sao kê ngân hàng nhập từ file Excel hoặc CSV, hoặc gửi qua email; thành viên xác nhận các dòng trước khi vào sổ. Kết nối ngân hàng trực tiếp chưa có',
          'Khoá sổ theo từng tháng, theo thứ tự. Mở khoá bắt đầu từ tháng khoá cuối cùng và cần chủ sở hữu hoặc kế toán trưởng, mã hai lớp và lý do',
          'Cuối năm: kết chuyển doanh thu và chi phí sang 911, rồi kết quả sang 4212, là một bút toán đề xuất cần duyệt bằng mã hai lớp. Sau khi duyệt và khoá đủ 12 tháng, chủ sở hữu tạo gói lưu trữ năm tài chính kèm file gốc của chứng từ',
          'Xuất Excel theo mẫu nhập liệu MISA SME cho hoá đơn mua dịch vụ, mua hàng hoá, bán hàng, phiếu thu và phiếu chi; mã nhà cung cấp và khách hàng để kế toán điền, còn mã mặt hàng và kho đặt trong Cài đặt. Việc nhập vào MISA thật đang được kiểm tra cùng kế toán đối tác',
          'Báo cáo B01-DNN và B02-DNN là bản nháp, cách ánh xạ tài khoản chưa được kế toán kiểm tra. Mỗi pháp nhân có sổ, số chứng từ, khoá sổ và tờ khai riêng, với hệ thống tài khoản TT133',
          'Tìm theo tên, mã số thuế, số hoá đơn hay số tiền, gõ không cần dấu',
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Ba việc dưới đây chưa nối trực tiếp với cổng thuế, ngân hàng hay nhà cung cấp hoá đơn điện tử thật, nên Ludy chưa tính là có sẵn.',
    label: 'Sắp ra mắt',
    items: [
      { title: 'Lấy danh sách hoá đơn trực tiếp từ cổng thuế', body: 'Hôm nay bạn tải lên file Excel xuất từ cổng thuế ở thẻ Đối chiếu cổng thuế, và Ludy đối chiếu với sổ.' },
      { title: 'Kết nối ngân hàng trực tiếp', body: 'Hôm nay sao kê được nhập từ file Excel, CSV hoặc email ở màn Sao kê ngân hàng.' },
      { title: 'Phát hành hoá đơn điện tử qua nhà cung cấp thật', body: 'Hôm nay màn Hóa đơn bán ra tạo bản nháp và chạy thử trong môi trường sandbox tích hợp sẵn.' },
    ],
  },
  coworker: {
    title: `${N.finance} làm gì trong Ludy Tài chính`,
    lead: `${N.finance} là giám đốc tài chính AI, đồng nghiệp của bạn trong Ludy Tài chính (và rà biến động lương trong Ludy Nhân sự), làm việc dưới sự điều phối của ${N.gm}. ${N.finance} làm phần đọc; quyết định đúng sai là của quy tắc cố định và của người.`,
    doesTitle: `${N.finance} làm`,
    does: [
      'Đọc PDF và ảnh chụp hoá đơn thành số liệu có cấu trúc',
      'Đưa kết quả vào thẻ Chờ duyệt của Chứng từ, ghi rõ là đọc bằng AI và cần người kiểm tra',
      'Chủ sở hữu hoặc quản trị viên bấm Dừng AI trong Ludy AI để tắt ngay mọi việc AI của công ty (bật lại cần chủ sở hữu và mã hai lớp); khi đang dừng, việc đọc PDF và ảnh mới bị từ chối và bấm Đọc lại được sau khi bật lại',
    ],
    doesNotTitle: `${N.finance} không làm`,
    doesNot: [
      'Không ghi sổ và không duyệt thay người',
      'Không quyết định hoá đơn đúng hay sai: việc đó do quy tắc cố định',
      'Không chọn tài khoản cho dòng chưa phân loại',
    ],
  },
  audience: {
    title: 'Ludy Tài chính dành cho ai',
    lead: 'Cùng một dữ liệu, ba cách dùng.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Không cần biết kế toán. Tải ảnh hoá đơn lên, hoặc chuyển tiếp email khi công ty đã có địa chỉ nhận hoá đơn, xem nhà cung cấp và số tiền rồi bấm duyệt. Chỗ nào thiếu thông tin, Ludy chỉ ra.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Duyệt cả tháng chứng từ bằng bàn phím. Xem nhiều khách hàng ở một nơi, mỗi khách một lịch thuế. Mời kế toán bên ngoài vào làm việc trên những pháp nhân được giao. Xuất Excel và tệp theo mẫu nhập liệu MISA SME.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, chạy bằng docker compose, dữ liệu nằm trên máy chủ của bạn. Chọn model AI tuỳ ý, kể cả model chạy tại chỗ.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Tài chính',
    items: [
      {
        q: 'Tôi không biết kế toán có dùng được không?',
        a: 'Được. Ludy soạn bút toán và nói vì sao chọn tài khoản đó. Bạn xem nhà cung cấp, số tiền, các kiểm tra và bấm duyệt. Nếu có người làm kế toán cho bạn, mời họ vào cùng công ty hoặc gửi file Excel sổ nhật ký và sổ cái.',
      },
      {
        q: 'Ludy có nộp tờ khai thay tôi không?',
        a: 'Không. Ludy xuất tệp XML tờ khai 01/GTGT với các chỉ tiêu tính được từ sổ; bạn hoàn thiện và nộp bằng công cụ của cơ quan thuế. Việc HTKK và eTax nhận tệp này đang được kiểm tra cùng kế toán đối tác. Đánh dấu "đã nộp" trong Ludy chỉ là ghi nhận.',
      },
      {
        q: 'Hóa đơn bán ra, Hàng hóa và tính lương hôm nay tới đâu?',
        a: 'Màn Hóa đơn bán ra tạo bản nháp và chạy thử trong sandbox tích hợp sẵn, chưa nối nhà cung cấp hoá đơn điện tử thật để phát hành mã cơ quan thuế. Màn Hàng hóa tính tồn kho bình quân gia quyền tạm tính đến khi khoá tháng và nhập bảng đối soát sàn. Lương và nhân sự nằm ở ứng dụng Ludy Nhân sự riêng trong thanh chuyển ứng dụng, hiện tạo kỳ lương nháp trong khi chờ kế toán xác nhận quy tắc tính lương theo luật. Chưa có báo cáo lưu chuyển tiền tệ.',
      },
      {
        q: 'Dữ liệu sang MISA như thế nào?',
        a: 'Ludy xuất file Excel theo mẫu nhập liệu MISA SME, để bạn điền các cột danh mục còn trống. Việc nhập vào MISA thật đang được kiểm tra cùng kế toán đối tác, và chưa có kết nối trực tiếp với MISA.',
      },
      {
        q: 'Dữ liệu của tôi nằm ở đâu?',
        a: 'Với bản tự cài đặt, dữ liệu nằm trên máy chủ và kho lưu trữ của bạn. Dữ liệu mỗi công ty được tách riêng. Bạn xuất sổ nhật ký, sổ cái và các tệp Excel bất kỳ lúc nào; toàn bộ dữ liệu của công ty được xuất khi đóng tổ chức.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Tài chính với hoá đơn của bạn',
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
        state: 'Giữ lại, chưa duyệt được',
        failed: 'Tổng các dòng không khớp tổng tiền hàng',
        passed: 'Đạt: bảng thuế GTGT, mã số thuế, không trùng',
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
      returnFile: 'Xuất tệp XML tờ khai',
      returnNote: 'Ludy điền các chỉ tiêu tính được. Cơ quan thuế, người ký và một số chỉ tiêu để bạn hoàn thiện.',
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
      closeTitle: 'Cuối năm 2025',
      closeSub: 'Gạo Sạch Mekong',
      close: [
        { name: 'Kết chuyển sang 911 và 4212', state: 'Đã duyệt bằng mã hai lớp', tone: 'ok' as Tone },
        { name: 'Khoá sổ đủ 12 tháng', state: 'Đã khoá', tone: 'ok' as Tone },
        { name: 'Gói lưu trữ năm tài chính', state: 'Chủ sở hữu tạo, kèm file gốc', tone: 'neutral' as Tone },
      ],
      exportsTitle: 'Xuất file',
      exports: [
        { name: 'Mẫu nhập liệu MISA SME', body: 'Mua dịch vụ, mua hàng hoá, bán hàng, phiếu thu, phiếu chi', format: 'Excel' },
        { name: 'Sổ nhật ký chung, sổ cái', body: 'Theo kỳ và pháp nhân đang chọn', format: 'Excel' },
        { name: 'Tờ khai 01/GTGT', body: 'Tệp XML các chỉ tiêu tính được', format: 'XML' },
        { name: 'Tài sản cố định', body: 'Sổ tài sản và khấu hao', format: 'Excel' },
      ],
      draftNote: 'B01-DNN và B02-DNN là bản nháp.',
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type AccountingCopy = typeof accountingVi;
