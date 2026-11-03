// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy Engage page (/engage). engage-en.ts mirrors this shape. Ludy Engage is the one app of the
// shell that holds the Inbox, customers and sales (the folded-in CRM, #2435), marketing (posts and ads) and reports;
// ludy.vn's /crm now redirects here (#2440). Every claim is merged and usable on main today (the PR lists the PR and
// code path behind each one); planned work appears only under "sắp ra mắt". Company names, amounts and dates are example
// data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';
import { N } from './roster';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const engageVi = {
  appName: 'Ludy Engage',
  meta: {
    title: 'Ludy Engage: hộp thư, khách hàng, bán hàng và marketing trong một ứng dụng',
    description:
      'Ludy Engage gom hộp thư chung cho khách, danh sách khách hàng và cơ hội bán hàng, lịch hẹn, bài đăng và quảng cáo về một nơi, có báo cáo cho từng phần. Mã nguồn mở, dùng chung danh sách khách hàng với Ludy Kế toán.',
  },
  ogTitle: 'Hộp thư, khách hàng và marketing, trong một ứng dụng.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Hộp thư, khách hàng và marketing, trong một ứng dụng.',
    lead: `Ludy Engage gom tin nhắn của khách, danh sách khách hàng và cơ hội bán hàng, lịch hẹn, bài đăng và quảng cáo về một nơi, mỗi phần có báo cáo riêng. ${N.sales} lo hộp thư, khách hàng và bán hàng, ${N.marketing} lo marketing, bạn duyệt.`,
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy Engage có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Từ tin nhắn của khách đến báo cáo của bạn',
    lead: 'Bốn nhóm trong menu của ứng dụng, theo thứ tự việc thường diễn ra.',
    steps: [
      { name: 'Nhận tin', body: 'Tin nhắn của khách về Hộp thư, kèm bản nháp trả lời để bạn xem.', outcome: 'Có trong Hộp thư', tone: 'accent' },
      { name: 'Ghi nhận khách', body: 'Gắn hội thoại với một liên hệ, mở cơ hội, hoặc để khách tự đặt lịch hẹn.', outcome: 'Có trong danh sách khách hàng', tone: 'neutral' },
      { name: 'Chốt', body: 'Kéo cơ hội qua các giai đoạn cho đến Thắng hoặc Thua.', outcome: 'Thắng hoặc Thua', tone: 'ok' },
      { name: 'Đăng và đo', body: 'Lên lịch bài cho nhiều kênh, theo dõi quảng cáo, rồi xem số liệu ở Báo cáo.', outcome: 'Có số liệu', tone: 'ok' },
    ],
  },
  groups: {
    title: 'Việc Ludy Engage làm hôm nay',
    lead: 'Năm việc, nằm trong bốn nhóm của menu: Hộp thư, Khách hàng & Bán hàng, Marketing và Báo cáo.',
    items: [
      {
        id: 'hop-thu',
        title: 'Hộp thư',
        lead: 'Một hộp thư chung cho tin nhắn riêng của khách. Bình luận hiện chỉ có ở kênh thử.',
        points: [
          'Ba tab Mới, Đang chờ và Đã xong; lọc theo loại, kênh, người phụ trách và ý định của khách; tìm không cần gõ dấu',
          'Kênh nối được hôm nay là tin nhắn riêng Zalo OA, trả lời trong cửa sổ 48 giờ của Zalo: đã làm xong, chưa thử với một OA thật. Người cài đặt khai báo ứng dụng Zalo trước. Có kênh thử, cả bình luận lẫn tin nhắn, để dùng thử ngay trên máy của bạn',
          'Giao người phụ trách, ghi chú nội bộ, câu trả lời lưu sẵn, và dấu báo đang có người trả lời để hai người không trả lời trùng',
          'Gắn hội thoại với một liên hệ hoặc tạo liên hệ mới, xem các hội thoại khác của cùng khách, xoá dữ liệu của một khách (chủ sở hữu và quản trị viên)',
          'Tin nhắn riêng chỉ chủ sở hữu, quản trị viên và người giữ vai trò Chăm sóc khách hàng đọc được',
        ],
      },
      {
        id: 'khach-hang',
        title: 'Khách hàng và cơ hội bán hàng',
        lead: 'Một danh sách liên hệ dùng chung với Ludy Kế toán, và các cơ hội theo giai đoạn do bạn đặt.',
        points: [
          'Liên hệ là cá nhân hoặc công ty, chính là đối tác mà hoá đơn trong Ludy Kế toán dùng; tìm theo tên, email, điện thoại hoặc mã số thuế, gõ không cần dấu',
          'Nhập từ file Excel (.xlsx) hoặc CSV: xem trước từng dòng là mới, trùng hay lỗi rồi mới nhập, không ghi đè thông tin đã có. Nhập xong không hoàn tác được',
          'Mỗi cơ hội có khách hàng, số tiền bằng đồng, người phụ trách, ngày dự kiến chốt và lý do thua',
          'Bảng kéo thả theo giai đoạn, mỗi cột có số thẻ và tổng tiền. Chủ sở hữu và quản trị viên đặt tên, thêm, bớt và đổi thứ tự giai đoạn',
          'Lọc theo trạng thái, người phụ trách, hạn chốt và số tiền, rồi lưu thành chế độ xem riêng hoặc dùng chung',
        ],
      },
      {
        id: 'lich-hen',
        title: 'Lịch hẹn cho khách',
        lead: 'Khách tự chọn giờ còn trống trên trang đặt lịch công khai, không cần tài khoản.',
        points: [
          'Mỗi loại cuộc hẹn có một trang đặt lịch, giờ hiện theo múi giờ của khách; loại hẹn theo nhóm luân phiên cho người đang rảnh hoặc chỉ hiện giờ cả nhóm cùng rảnh',
          'Giờ làm việc và ngày nghỉ của từng người; ngày lễ và Tết theo lịch thông thường đã tính sẵn đến năm 2028, ngày nghỉ bù do bạn thêm',
          'Email xác nhận kèm tệp lịch, nhắc hẹn trước 24 giờ và 1 giờ, khách tự dời hoặc huỷ bằng liên kết dùng một lần. Cần máy chủ thư do người cài đặt cấu hình',
          'Nối Google Calendar: giờ bận chặn giờ hẹn, chỉ đọc giờ chứ không đọc tiêu đề; có thể bật ghi lịch hẹn mới vào Google Calendar. Cần khoá Google do người cài đặt cấu hình',
          'Khách đặt lịch được khớp hoặc tạo thành liên hệ, và ghi vào dòng thời gian của liên hệ',
        ],
      },
      {
        id: 'marketing',
        title: 'Marketing: bài đăng và quảng cáo',
        lead: 'Lên lịch bài cho nhiều kênh và xem quảng cáo cùng một chỗ, mọi bài đều qua người duyệt.',
        points: [
          'Mỗi bài có một nội dung và một bản cho từng kênh, kiểm tra riêng cho từng kênh, xem trước, và lịch, bảng hoặc danh sách sắp đăng',
          'Kênh gồm Facebook, Instagram, Threads, TikTok, YouTube, LinkedIn, X, Zalo OA và nhiều kênh khác. Với các nền tảng lớn, người cài đặt khai báo ứng dụng của nền tảng đó trước',
          'Mỗi bài cần người duyệt trước khi đăng, có quy trình nhiều bước, danh sách kiểm tra và liên kết cho khách duyệt không cần đăng nhập',
          'Báo cáo cho khách dưới dạng liên kết chia sẻ, bản in, có thương hiệu riêng và có thể hẹn lịch gửi',
          'Quảng cáo: xem chi tiêu, lượt hiển thị, lượt nhấp và kết quả của quảng cáo Facebook và Instagram theo ngày, tháng và chiến dịch, đối chiếu chi tiêu với sổ kế toán khi dùng Ludy Kế toán. Cần khoá Meta do người cài đặt cấu hình',
        ],
      },
      {
        id: 'bao-cao',
        title: 'Báo cáo',
        lead: 'Số liệu của từng phần bạn đang dùng, gom ở một chỗ.',
        points: [
          'Mỗi phần một tab, chỉ hiện phần nào đang chạy: Hội thoại, Bán hàng, Bài đăng và Quảng cáo',
          'Hội thoại: số hội thoại mới, đang chờ, đã xong và chưa đọc',
          'Bán hàng: các cơ hội đang mở, và đã thắng hoặc đã thua trong 30 ngày qua, theo từng giai đoạn, với tổng tiền',
          'Bài đăng: số bài, tiếp cận, lượt phản ứng, bình luận và chia sẻ của 30 ngày gần nhất so với 30 ngày trước đó',
          'Quảng cáo: chi tiêu, lượt hiển thị, lượt nhấp và kết quả của tháng này cho từng tài khoản, theo tiền tệ của tài khoản, không quy đổi. Báo cáo chỉ để xem, mỗi phần có liên kết mở màn hình của nó',
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Chưa dùng được hôm nay.',
    label: 'Sắp ra mắt',
    items: [
      { title: 'Facebook và Instagram trong Hộp thư', body: 'Bình luận và tin nhắn riêng, và trả lời riêng một bình luận.' },
      { title: 'Email của khách trong Hộp thư', body: 'Email của khách về cùng hộp thư với các kênh khác.' },
      { title: 'Chạy quảng cáo từ Ludy', body: 'Hôm nay Ludy chỉ cho xem quảng cáo. Tạo và chạy chiến dịch, với hạn mức chi tiêu, nút dừng và mọi khoản chi do bạn duyệt: sắp ra mắt.' },
    ],
  },
  coworker: {
    title: `${N.sales} và ${N.marketing} làm gì trong Ludy Engage`,
    lead: `${N.sales} là trưởng phòng bán hàng AI, lo hộp thư, khách hàng và bán hàng. ${N.marketing} là trưởng phòng marketing AI, lo bài đăng. Cả hai là đồng nghiệp của bạn, làm việc dưới sự điều phối của ${N.gm}. Cần model AI do người cài đặt cấu hình; chủ sở hữu hoặc quản trị viên có thể dừng AI, và ngân sách AI hàng tháng giới hạn chi phí.`,
    doesTitle: 'Làm',
    does: [
      `${N.sales} soạn sẵn bản nháp trả lời trong Hộp thư, không tự bịa giá hay liên kết, và gợi ý ý định của khách và liên hệ khớp`,
      `${N.sales} đọc tin nhắn bạn dán vào màn Lịch hẹn, chọn giờ trống thật và soạn sẵn thư trả lời kèm liên kết đặt lịch`,
      `${N.marketing} soạn và viết lại bài đăng, gợi ý thẻ hashtag, mô tả ảnh, ý tưởng bài mới và tóm tắt một kỳ`,
    ],
    doesNotTitle: 'Không làm',
    doesNot: [
      'Không tự gửi trả lời cho khách, không tự đặt lịch, không tự gửi thư',
      'Không tự đăng bài: mọi bài cần người duyệt',
      'Không chạy quảng cáo hay tiêu tiền, và không ghi vào danh sách liên hệ hay cơ hội',
    ],
  },
  audience: {
    title: 'Ludy Engage dành cho ai',
    lead: 'Cho người trả lời khách, bán hàng và làm marketing.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Tin nhắn của khách, danh sách khách hàng, lịch hẹn và bài đăng ở cùng một nơi, thay cho bảng tính và tin nhắn rải rác.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Khách hàng ở đây cũng là khách hàng trong Ludy Kế toán, nên hoá đơn và liên hệ dùng chung một danh sách.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, dữ liệu nằm trên máy chủ của bạn. Cần máy chủ thư để gửi email xác nhận, và ứng dụng của từng nền tảng để nối kênh.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Engage',
    items: [
      {
        q: 'Ludy CRM đã đi đâu?',
        a: 'Ludy CRM đã gộp vào Ludy Engage. Liên hệ, cơ hội và lịch hẹn nằm ở nhóm Khách hàng & Bán hàng, và địa chỉ cũ của trang Ludy CRM chuyển về trang này.',
      },
      {
        q: 'Hộp thư nhận tin từ những kênh nào?',
        a: 'Hôm nay là tin nhắn riêng Zalo OA (đã làm xong, chưa thử với một OA thật), và người cài đặt phải khai báo ứng dụng Zalo trước. Có kênh thử, cả bình luận lẫn tin nhắn, để dùng thử trên máy của bạn. Facebook, Instagram và email: sắp ra mắt.',
      },
      {
        q: 'Ludy có tự trả lời khách hay tự đăng bài không?',
        a: `Không. ${N.sales} chỉ soạn bản nháp để bạn xem, sửa và gửi, và mọi bài đăng cần người duyệt. Phần cốt lõi vẫn chạy khi tắt AI.`,
      },
      {
        q: 'Có chạy quảng cáo từ Ludy được chưa?',
        a: 'Chưa. Hôm nay Ludy cho xem quảng cáo Facebook và Instagram. Tạo và chạy chiến dịch: sắp ra mắt.',
      },
      {
        q: 'Khách hàng bên Ludy Kế toán có sang Ludy Engage không?',
        a: 'Có. Liên hệ chính là đối tác mà hoá đơn dùng, nên khách hàng và nhà cung cấp đã có sẽ hiện trong danh sách liên hệ.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Engage với khách hàng của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    menu: {
      label: 'Menu của Ludy Engage',
      groups: [
        { name: 'Hộp thư', items: ['Hội thoại'] },
        { name: 'Khách hàng & Bán hàng', items: ['Người liên hệ', 'Cơ hội', 'Lịch hẹn'] },
        { name: 'Marketing', items: ['Bài đăng', 'Quảng cáo'] },
        { name: 'Báo cáo', items: ['Báo cáo'] },
      ],
    },
    inbox: {
      label: 'Hộp thư của Gạo Sạch Mekong',
      tabs: ['Mới', 'Đang chờ', 'Đã xong'],
      channel: 'Zalo OA',
      intentLabel: 'Gợi ý',
      rows: [
        { who: 'Nhà hàng Sen Vàng', preview: 'Hỏi giá gạo ST25, lấy 10 tấn', state: 'Mới', tone: 'accent' as Tone, intent: 'Đặt hàng hoặc hỏi giá' },
        { who: 'Cửa hàng Bình An', preview: 'Hẹn xem hàng ở kho, giờ nào được?', state: 'Đang chờ', tone: 'neutral' as Tone, intent: 'Câu hỏi' },
        { who: 'Đại lý Phương Nam', preview: 'Cảm ơn, đã nhận hàng', state: 'Đã xong', tone: 'ok' as Tone, intent: '' },
      ],
    },
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
            { title: 'Gạo ST25, 10 tấn', party: 'Đại lý Phương Nam', amount: '250.000.000 ₫', close: '15/11/2026' },
            { title: 'Giao gạo hằng tuần', party: 'Cửa hàng Bình An', amount: '42.000.000 ₫', close: '20/11/2026' },
          ],
        },
        { name: 'Báo giá', tone: 'neutral' as Tone, sum: '120.000.000 ₫', deals: [{ title: 'Gạo sỉ vụ đông', party: 'Cửa hàng Hoa Mai', amount: '120.000.000 ₫', close: '10/11/2026' }] },
        { name: 'Thương lượng', tone: 'neutral' as Tone, sum: '480.000.000 ₫', deals: [{ title: 'Hợp đồng cung ứng quý IV', party: 'Công ty Thực phẩm An Phát', amount: '480.000.000 ₫', close: '05/11/2026' }] },
        { name: 'Thắng', tone: 'ok' as Tone, sum: '96.000.000 ₫', deals: [{ title: 'Gạo ST25 đợt tháng 10', party: 'Đại lý Phương Nam', amount: '96.000.000 ₫', close: '12/10/2026' }] },
        { name: 'Thua', tone: 'neutral' as Tone, sum: '0 ₫', deals: [] },
      ],
    },
    posts: {
      label: 'Lịch đăng của Gạo Sạch Mekong',
      approval: 'Mọi bài cần người duyệt trước khi đăng',
    },
    reports: {
      label: 'Báo cáo của Gạo Sạch Mekong',
      tabs: ['Hội thoại', 'Bán hàng', 'Bài đăng', 'Quảng cáo'],
      current: 1,
      title: 'Bán hàng: cơ hội theo giai đoạn',
      head: ['Giai đoạn', 'Số cơ hội', 'Tổng tiền'],
      rows: [
        { stage: 'Mới', count: '1', sum: '18.000.000 ₫' },
        { stage: 'Đã liên hệ', count: '2', sum: '292.000.000 ₫' },
        { stage: 'Báo giá', count: '1', sum: '120.000.000 ₫' },
        { stage: 'Thương lượng', count: '1', sum: '480.000.000 ₫' },
      ],
      openLabel: 'Đang mở',
      open: '5 cơ hội, 910.000.000 ₫',
      wonLabel: 'Thắng 30 ngày qua',
      won: '1 cơ hội, 96.000.000 ₫',
      readOnly: 'Chỉ để xem. Mở màn hình Cơ hội để sửa.',
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type EngageCopy = typeof engageVi;
