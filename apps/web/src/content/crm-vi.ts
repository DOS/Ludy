// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy CRM page (/crm). crm-en.ts mirrors this shape. Every claim here is merged and usable on
// main today (the PR lists the PR or route behind each one); planned work is not named. Company names, amounts and
// dates are example data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const crmVi = {
  appName: 'Ludy CRM',
  meta: {
    title: 'Ludy CRM: khách hàng, cơ hội và lịch hẹn ở một nơi',
    description:
      'Ludy CRM giữ danh sách liên hệ, các cơ hội bán hàng trên bảng theo giai đoạn và trang đặt lịch công khai để khách tự chọn giờ hẹn. Mã nguồn mở, dùng chung danh sách khách hàng với Ludy Kế toán.',
  },
  ogTitle: 'Khách hàng, cơ hội và lịch hẹn, ở một nơi.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Khách hàng, cơ hội và lịch hẹn, ở một nơi.',
    lead: 'Ludy CRM giữ danh sách liên hệ, theo dõi từng cơ hội bán hàng qua các giai đoạn và cho khách tự chọn giờ hẹn với bạn. Liên hệ chính là khách hàng và nhà cung cấp mà Ludy Kế toán đang dùng.',
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy CRM có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn bước từ liên hệ đến chốt',
    lead: 'Mỗi bước là một màn hình riêng, dùng chung một danh sách khách hàng.',
    steps: [
      { name: 'Thêm liên hệ', body: 'Tạo từng liên hệ, hoặc nhập từ file Excel hay CSV sau khi xem trước từng dòng.', outcome: 'Có trong danh sách', tone: 'neutral' },
      { name: 'Mở cơ hội', body: 'Chọn khách hàng, nhập số tiền và ngày dự kiến chốt.', outcome: 'Ở giai đoạn đầu', tone: 'accent' },
      { name: 'Hẹn gặp', body: 'Gửi trang đặt lịch, khách tự chọn giờ còn trống.', outcome: 'Lịch hẹn đã xác nhận', tone: 'ok' },
      { name: 'Chốt', body: 'Kéo cơ hội qua các giai đoạn cho đến Thắng hoặc Thua.', outcome: 'Thắng hoặc Thua', tone: 'ok' },
    ],
  },
  groups: {
    title: 'Việc Ludy CRM làm hôm nay',
    lead: 'Bốn việc: giữ liên hệ, theo dõi cơ hội, nhận lịch hẹn, nối lịch của bạn.',
    items: [
      {
        id: 'lien-he',
        title: 'Liên hệ',
        lead: 'Một danh sách cho khách hàng và nhà cung cấp, chung với Ludy Kế toán.',
        points: [
          'Liên hệ là cá nhân hoặc công ty, chính là đối tác mà hoá đơn trong Ludy Kế toán dùng',
          'Tìm theo tên, email, điện thoại hoặc mã số thuế, gõ không cần dấu',
          'Mỗi liên hệ có cơ hội, ghi chú (khi dùng Ludy Notes) và dòng thời gian riêng',
          'Nhập từ file Excel hoặc CSV: xem trước từng dòng là mới, trùng hay lỗi rồi mới nhập, không ghi đè thông tin đã có. Nhập xong không hoàn tác được',
          'Chế độ xem đã lưu, riêng hoặc dùng chung',
        ],
      },
      {
        id: 'co-hoi',
        title: 'Cơ hội và quy trình bán hàng',
        lead: 'Theo dõi từng thương vụ qua các giai đoạn do bạn đặt.',
        points: [
          'Mỗi cơ hội có khách hàng, số tiền bằng đồng, người phụ trách, ngày dự kiến chốt và lý do thua',
          'Bảng kéo thả theo giai đoạn, mỗi cột có số thẻ và tổng tiền. Trên điện thoại và bàn phím, dùng ô chọn giai đoạn trên thẻ',
          'Chủ sở hữu và quản trị viên đặt tên, thêm, bớt và đổi thứ tự giai đoạn',
          'Lọc theo trạng thái, người phụ trách, hạn chốt và số tiền, rồi lưu thành chế độ xem riêng hoặc dùng chung',
          'Hai người sửa cùng lúc thì người lưu sau được báo, không ghi đè. Bảng không tự cập nhật theo người khác, hãy tải lại để thấy',
        ],
      },
      {
        id: 'dat-lich',
        title: 'Trang đặt lịch cho khách',
        lead: 'Khách tự chọn giờ còn trống, không cần tài khoản.',
        points: [
          'Mỗi loại cuộc hẹn có một trang đặt lịch công khai, giờ hiện theo múi giờ của khách',
          'Loại hẹn theo nhóm: luân phiên cho người đang rảnh, hoặc chỉ hiện giờ cả nhóm cùng rảnh',
          'Giờ làm việc và ngày nghỉ của từng người; ngày lễ và Tết đã tính sẵn đến năm 2028',
          'Email xác nhận kèm tệp lịch, nhắc hẹn trước 24 giờ và 1 giờ, khách tự dời hoặc huỷ bằng liên kết dùng một lần. Cần máy chủ thư do người cài đặt cấu hình',
          'Khách đặt lịch được khớp hoặc tạo thành liên hệ, và ghi vào dòng thời gian',
        ],
      },
      {
        id: 'lich-va-vy',
        title: 'Lịch Google và Vy',
        lead: 'Nối lịch của bạn để giờ bận không bị hẹn trùng.',
        points: [
          'Nối Google Calendar: giờ bận chặn giờ hẹn, chỉ đọc giờ chứ không đọc tiêu đề. Cần khoá Google do người cài đặt cấu hình',
          'Có thể bật ghi lịch hẹn mới vào Google Calendar; tiêu đề gồm loại hẹn và tên khách',
          'Địa chỉ đăng ký để xem lịch hẹn trong Google Calendar, Outlook hoặc Lịch của Apple',
          'Vy đọc tin nhắn của khách, chọn giờ trống thật và soạn sẵn thư trả lời kèm liên kết đặt lịch. Bạn xem rồi tự gửi. Cần model AI do người cài đặt cấu hình',
        ],
      },
    ],
  },
  assistant: {
    title: 'Vy làm gì trong Ludy CRM',
    lead: 'Vy giúp phần hẹn lịch. Danh sách liên hệ và cơ hội do bạn quản lý.',
    doesTitle: 'Vy làm',
    does: [
      'Gợi ý giờ hẹn từ tin nhắn của khách và soạn sẵn thư trả lời',
      'Khi khách huỷ hẹn, tác tử xếp lịch (nếu bạn thuê) ghi 3 giờ trống gần nhất vào một việc cho người phụ trách',
    ],
    doesNotTitle: 'Vy không làm',
    doesNot: ['Không tự đặt lịch và không tự gửi thư', 'Không ghi vào danh sách liên hệ hay cơ hội'],
  },
  audience: {
    title: 'Ludy CRM dành cho ai',
    lead: 'Cho người bán hàng và nhận lịch hẹn với khách.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Khách hàng, thương vụ và lịch hẹn ở cùng một nơi, thay cho bảng tính và tin nhắn rải rác.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Khách hàng ở đây cũng là khách hàng trong Ludy Kế toán, nên hoá đơn và liên hệ dùng chung một danh sách.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, dữ liệu nằm trên máy chủ của bạn. Cần máy chủ thư để gửi email xác nhận.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy CRM',
    items: [
      {
        q: 'Ludy CRM có đủ như một CRM lớn không?',
        a: 'Chưa. Ludy CRM có liên hệ, cơ hội, bảng giai đoạn và lịch hẹn. Chưa có thu thập email, dự báo doanh thu hay chuỗi email tự động.',
      },
      {
        q: 'Khách hàng bên Ludy Kế toán có sang CRM không?',
        a: 'Có. Liên hệ chính là đối tác mà hoá đơn dùng, nên khách hàng và nhà cung cấp đã có sẽ hiện trong danh sách liên hệ.',
      },
      {
        q: 'Nhập liên hệ có ghi đè dữ liệu cũ không?',
        a: 'Không. Dòng trùng được bỏ qua hoặc chỉ điền vào chỗ còn trống. Bạn xem trước từng dòng trước khi nhập, và nhập xong thì không hoàn tác được.',
      },
      {
        q: 'Có cần dùng Google Calendar không?',
        a: 'Không. Trang đặt lịch chạy không cần Google. Nối Google Calendar chỉ để chặn giờ bận, và cần khoá Google do người cài đặt cấu hình.',
      },
      {
        q: 'Ludy có gửi email xác nhận cho khách không?',
        a: 'Có, khi người cài đặt đã cấu hình máy chủ thư. Chưa có máy chủ thư thì Ludy không gửi email.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy CRM với khách hàng của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    board: {
      label: 'Bảng cơ hội theo giai đoạn của Gạo Sạch Mekong',
      closeOn: 'Dự kiến chốt',
      cards: 'cơ hội',
      empty: 'Chưa có cơ hội',
      stages: [
        { name: 'Mới', tone: 'neutral' as Tone, sum: '18.000.000 ₫', deals: [{ title: 'Gạo thơm cho nhà hàng', party: 'Nhà hàng Sen Vàng', amount: '18.000.000 ₫', close: '30/11/2026' }] },
        {
          name: 'Đã liên hệ',
          tone: 'neutral' as Tone,
          sum: '292.000.000 ₫',
          deals: [
            { title: 'Gạo ST25, 100 tấn', party: 'Đại lý Phương Nam', amount: '250.000.000 ₫', close: '15/11/2026' },
            { title: 'Giao gạo hằng tuần', party: 'Cửa hàng Bình An', amount: '42.000.000 ₫', close: '20/11/2026' },
          ],
        },
        { name: 'Báo giá', tone: 'neutral' as Tone, sum: '120.000.000 ₫', deals: [{ title: 'Gạo sỉ vụ đông', party: 'Gạo Sạch Miền Tây', amount: '120.000.000 ₫', close: '10/11/2026' }] },
        { name: 'Thương lượng', tone: 'neutral' as Tone, sum: '480.000.000 ₫', deals: [{ title: 'Hợp đồng cung ứng quý IV', party: 'Hợp tác xã Tân Hồng', amount: '480.000.000 ₫', close: '05/11/2026' }] },
        { name: 'Thắng', tone: 'ok' as Tone, sum: '96.000.000 ₫', deals: [{ title: 'Gạo ST25 đợt tháng 10', party: 'Đại lý Phương Nam', amount: '96.000.000 ₫', close: '12/10/2026' }] },
        { name: 'Thua', tone: 'neutral' as Tone, sum: '0 ₫', deals: [] },
      ],
    },
    import: {
      title: 'Nhập liên hệ từ tệp',
      file: 'khach-hang.xlsx',
      steps: ['Chọn tệp', 'Ghép cột', 'Xem trước', 'Xong'],
      current: 2,
      hint: 'Chưa có gì được ghi vào danh sách liên hệ. Xem kỹ rồi bấm Nhập.',
      counts: [
        { label: '2 dòng mới', tone: 'ok' as Tone },
        { label: '1 dòng trùng', tone: 'warn' as Tone },
        { label: '1 dòng lỗi', tone: 'warn' as Tone },
      ],
      head: ['Dòng', 'Tên', 'Kết quả'],
      rows: [
        { n: '2', name: 'Nhà hàng Sen Vàng', result: 'Mới', tone: 'ok' as Tone, note: '' },
        { n: '3', name: 'Cửa hàng Bình An', result: 'Mới', tone: 'ok' as Tone, note: '' },
        { n: '4', name: 'Hợp tác xã Tân Hồng', result: 'Trùng', tone: 'warn' as Tone, note: 'Trùng mã số thuế' },
        { n: '5', name: 'Đại lý Phương Nam', result: 'Lỗi', tone: 'warn' as Tone, note: 'Email không hợp lệ' },
      ],
      choiceLabel: 'Dòng trùng với liên hệ đã có thì:',
      choice: 'Bỏ qua, giữ nguyên liên hệ đã có',
      button: 'Nhập 2 liên hệ mới',
    },
    pipeline: {
      title: 'Các giai đoạn của quy trình bán hàng',
      hint: 'Thắng và Thua luôn nằm cuối và không xóa được.',
      stageLabel: 'Giai đoạn',
      stages: ['Mới', 'Đã liên hệ', 'Báo giá', 'Thương lượng'],
      won: 'Giai đoạn thắng: Thắng',
      lost: 'Giai đoạn thua: Thua',
      viewsLabel: 'Chế độ xem đã lưu',
      views: [
        { name: 'Của tôi', shared: false },
        { name: 'Đang thương lượng', shared: true },
      ],
      private: 'Riêng',
      shared: 'Dùng chung',
      filtersLabel: 'Lọc cơ hội',
      filters: ['Đang mở', 'Tôi', 'Sắp đến hạn (7 ngày tới)'],
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type CrmCopy = typeof crmVi;
