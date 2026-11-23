// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy Cộng tác page (/cong-tac). teamwork-en.ts mirrors this shape. Every claim here is merged
// and usable on main today (the PR lists the PR and code path behind each one); planned work is not named. Company
// names, amounts and dates are example data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';
import { N } from './roster';

export const teamworkVi = {
  appName: 'Ludy Cộng tác',
  meta: {
    title: 'Ludy Cộng tác: việc của tôi, việc nhóm, ghi chú và cuộc họp trong một ứng dụng',
    description:
      'Ludy Cộng tác gom Việc của tôi, Việc nhóm, Ghi chú viết bằng Markdown ngay cạnh khách hàng và chứng từ, cùng Cuộc họp lưu bản ghi có đồng ý và chép lời, tóm tắt nháp tuỳ chọn. Mã nguồn mở, tìm không cần gõ dấu.',
  },
  ogTitle: 'Việc của tôi, việc nhóm, ghi chú và cuộc họp, trong một ứng dụng.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Việc của tôi, việc nhóm, ghi chú và cuộc họp, trong một ứng dụng.',
    lead: `Ludy Cộng tác gom bốn màn hình làm việc hằng ngày vào một chỗ: Việc của tôi, Việc nhóm, Ghi chú và Cuộc họp. Ghi chú viết ngay trên màn hình khách hàng, nhà cung cấp hay chứng từ; bản ghi cuộc họp có thể nhờ ${N.gm} soạn chép lời và tóm tắt nháp riêng cho người ghi.`,
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy Cộng tác có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn màn hình của Ludy Cộng tác',
    lead: 'Từ việc riêng của từng người đến việc giao cho cả nhóm, ghi chú theo bản ghi và biên bản cuộc họp.',
    steps: [
      { name: 'Việc của tôi', body: 'Thêm việc riêng có hạn, giờ nhắc và các bước con.', outcome: 'Chỉ mình bạn thấy', tone: 'neutral' },
      { name: 'Việc nhóm', body: 'Giao việc cho một vị trí trong sơ đồ tổ chức, do người hoặc đồng nghiệp AI giữ.', outcome: 'Cả nhóm theo dõi', tone: 'accent' },
      { name: 'Ghi chú', body: 'Viết bằng Markdown, giữ riêng cho bạn hoặc chia sẻ với tổ chức, gắn thẳng vào khách hàng hay chứng từ.', outcome: 'Hiện đúng chỗ', tone: 'ok' },
      { name: 'Cuộc họp', body: 'Tải tệp lên hoặc ghi bằng tiện ích trình duyệt khi mọi người đã đồng ý; xem lại biên bản, quyết định và đầu việc.', outcome: 'Có biên bản', tone: 'ok' },
    ],
  },
  groups: {
    title: 'Việc Ludy Cộng tác làm hôm nay',
    lead: 'Bốn phần trong menu Cộng tác: Việc của tôi, Việc nhóm, Ghi chú và Cuộc họp.',
    items: [
      {
        id: 'viec-cua-toi-va-viec-nhom',
        title: 'Việc của tôi và Việc nhóm',
        lead: 'Danh sách việc riêng có hạn và giờ nhắc, tách bạch với bảng việc nhóm giao theo vị trí.',
        points: [
          'Mỗi mục trong Việc của tôi có hạn, giờ, các bước và hộp nhắc, chia sẵn từ Quá hạn đến 7 ngày tới. Chỉ mình bạn thấy, chủ sở hữu và quản trị viên cũng không đọc được',
          'Nhắc việc hiện trong chuông thông báo của Ludy vào 8:00 ngày đến hạn hoặc 30 phút trước giờ bạn đặt',
          'Giao một việc riêng cho một vị trí thì mở hộp thoại sửa tên và mô tả trước khi tạo Việc nhóm; mọi thành viên đọc được Việc nhóm, và vị trí có thể do đồng nghiệp AI giữ',
          'Tải toàn bộ ghi chú và việc riêng của bạn về dạng Markdown hoặc JSON bất cứ lúc nào. Khi thành viên rời tổ chức, ghi chú riêng và việc riêng được giữ kín 30 ngày rồi xoá',
        ],
      },
      {
        id: 'ghi-chu',
        title: 'Ghi chú riêng và dùng chung',
        lead: 'Viết nhanh bằng Markdown, bạn chọn giữ riêng hay chia sẻ với tổ chức.',
        points: [
          'Ghi chú tạo ở màn hình Ghi chú bắt đầu riêng tư. Chỉ người viết sửa được nội dung',
          'Ghi chú riêng chỉ bạn đọc được trong tổ chức này, kể cả chủ sở hữu và quản trị viên cũng không. Chuyển thành dùng chung thì mọi thành viên, trừ người chỉ xem, đọc được',
          'Viết bằng Markdown: tiêu đề, danh sách, ô đánh dấu và liên kết',
          'Thẻ, ghim, lưu trữ và thùng rác (dọn sau 30 ngày), có nút Hoàn tác khi lưu trữ hoặc xoá',
        ],
      },
      {
        id: 'ngay-cho-lam-viec',
        title: 'Ghi chú ngay chỗ làm việc',
        lead: 'Bảng Ghi chú nằm trên chính các màn hình bạn đang xử lý hồ sơ và khách hàng.',
        points: [
          'Bảng Ghi chú có trên màn hình khách hàng, nhà cung cấp, chứng từ mua, bút toán, lịch hẹn, người liên hệ CRM và trang tổng quan',
          'Ghi chú viết từ một bảng thì gắn với bản ghi đó (bắt đầu dùng chung, có ô tick giữ riêng cho mình). Mỗi bảng chỉ hiện ghi chú bạn được đọc',
          'Tìm ghi chú theo tiêu đề, thẻ hoặc nội dung, gõ không cần dấu, cả trong Ctrl K',
        ],
      },
      {
        id: 'cuoc-hop',
        title: 'Cuộc họp: bản ghi, chép lời nháp và biên bản',
        lead: 'Lưu bản ghi khi các bên đã đồng ý, gắn với khách hàng hay cơ hội, và in biên bản khi chốt xong.',
        points: [
          'Tải tệp âm thanh, video lên màn Cuộc họp, ghi trực tiếp trong ứng dụng, hoặc ghi thẻ trình duyệt kèm micro bằng tiện ích Ludy trên Chrome hay Edge (nối qua trang đăng nhập Ludy, thu hồi bất cứ lúc nào ở mục thiết bị đã kết nối trong Cài đặt); luôn xác nhận mọi người dự họp đã đồng ý trước khi ghi hay tải lên',
          'Âm thanh được mã hoá riêng cho từng cuộc họp, mặc định giữ 30 ngày (tổ chức có thể chọn xoá ngay sau khi có bản chép lời, hoặc 7, 30 hay 90 ngày); tuỳ chọn Ghi cả video mặc định tắt và mặc định giữ 7 ngày (chọn 7 hoặc 30 ngày, không dài hơn âm thanh)',
          `Khi tổ chức bật AI, người ghi có thể nhờ ${N.gm} chép lời và soạn bản nháp tóm tắt, quyết định, đầu việc chỉ mình người ghi thấy; khi người ghi xem lại và chia sẻ cho người dự họp (hoặc cả tổ chức) thì họ mới đọc được, còn bản nháp chưa chia sẻ tự hết hạn sau 30 ngày`,
          'Gắn cuộc họp với khách hàng, nhà cung cấp, cơ hội CRM hoặc lịch hẹn; tìm trong bản chép lời không cần gõ dấu; mở Xem biên bản khổ A4 để in hoặc lưu PDF',
        ],
      },
    ],
  },
  coworker: {
    title: `${N.gm} làm gì trong Ludy Cộng tác`,
    lead: `${N.gm} làm việc cho người ghi trong Cuộc họp khi được gọi, và các vị trí AI nhận Việc nhóm khi được giao. Ghi chú và Việc của tôi hoàn toàn ở lại với bạn.`,
    doesTitle: `${N.gm} và các vị trí AI làm`,
    does: [
      `Trong Cuộc họp, khi bật AI và người ghi yêu cầu, ${N.gm} chép lời và soạn bản nháp tóm tắt, quyết định, đầu việc riêng cho người ghi xem lại trước khi chia sẻ`,
      'Trong Việc nhóm, vị trí do đồng nghiệp AI giữ nhận việc bạn giao sau khi bạn xác nhận tên việc và mô tả',
    ],
    doesNotTitle: `${N.gm} và các vị trí AI không làm`,
    doesNot: [
      'Không đọc, không viết và không sửa Ghi chú hay Việc của tôi của bạn',
      'Không tự ý ghi âm cuộc họp và không chia sẻ bản nháp AI của cuộc họp trước khi người ghi chia sẻ',
    ],
  },
  audience: {
    title: 'Ludy Cộng tác dành cho ai',
    lead: 'Cho người cần giữ đầu việc, ghi chú và nội dung cuộc họp ngay cạnh hồ sơ khách hàng và sổ sách.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Việc riêng, việc giao cho đội, điều cần nhớ về từng khách hàng và biên bản cuộc họp nằm chung một ứng dụng, gắn thẳng với CRM và Tài chính.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Để lại ghi chú trên hoá đơn hay bút toán của khách, giao việc bổ sung chứng từ và lưu biên bản trao đổi cuối kỳ.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, dữ liệu và tệp ghi âm nằm trên máy chủ và kho lưu trữ của bạn; chép lời và tóm tắt AI dùng model tương thích OpenAI do bạn chọn, có thể tắt.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Cộng tác',
    items: [
      {
        q: 'Ludy Notes đã đi đâu?',
        a: 'Ludy Notes đã gom cùng Việc của tôi, Việc nhóm và Cuộc họp thành ứng dụng Ludy Cộng tác trong thanh chuyển ứng dụng. Địa chỉ /notes cũ chuyển hướng vĩnh viễn về trang /cong-tac này.',
      },
      {
        q: 'Ai đọc được ghi chú và Việc của tôi?',
        a: 'Việc của tôi và ghi chú riêng chỉ mình bạn đọc được trong tổ chức này, kể cả chủ sở hữu và quản trị viên cũng không. Ghi chú dùng chung và Việc nhóm thì mọi thành viên đọc được (trừ người chỉ xem đối với ghi chú). Chỉ người viết mới chuyển một ghi chú giữa riêng và dùng chung.',
      },
      {
        q: 'Ai xem được bản ghi và bản nháp AI của Cuộc họp?',
        a: 'Bản nháp chép lời và tóm tắt do AI tạo chỉ hiện cho người đã tải lên hoặc ghi cuộc họp đó; khi người ghi chia sẻ cho người dự họp (hoặc mở rộng cho tổ chức) thì những người đọc được cuộc họp mới thấy. Âm thanh mặc định giữ 30 ngày (tổ chức chọn được xoá ngay sau khi chép lời, hoặc 7, 30 hay 90 ngày) và video, nếu bật Ghi cả video, mặc định giữ 7 ngày (chọn được 7 hoặc 30 ngày, không dài hơn âm thanh).',
      },
      {
        q: 'Ludy Cộng tác có nhắc việc qua email không?',
        a: 'Không. Nhắc việc của Việc của tôi hiện trong chuông thông báo của Ludy, vào 8:00 ngày đến hạn hoặc 30 phút trước giờ bạn đặt.',
      },
      {
        q: 'Tôi không thấy Ghi chú hay Cuộc họp trong menu?',
        a: 'Ghi chú và Cuộc họp là các phân hệ mà người cài đặt có thể tắt riêng; khi tắt phân hệ nào thì mục menu và bảng gắn kèm của phân hệ đó sẽ ẩn đi.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Cộng tác với công việc hằng ngày của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    screenLabel: 'Ứng dụng Ludy Cộng tác',
    menuItems: ['Việc của tôi', 'Việc nhóm', 'Ghi chú', 'Cuộc họp'],
    activeMenuItem: 2,
    note: {
      label: 'Một ghi chú đang mở',
      title: 'Hoá đơn điện về trễ, nhắc bên khách ngày 5',
      tabs: ['Viết', 'Xem trước'],
      current: 1,
      heading: 'Điện tháng 9',
      bullets: ['Hoá đơn về ngày 12, trễ 7 ngày', 'Nhắc bên khách trước ngày 5 hằng tháng'],
      checks: [
        { text: 'Hỏi EVN về kỳ chốt số', done: true },
        { text: 'Gửi lại bảng giá cho khách', done: false },
      ],
      linkText: 'Xem bảng giá của EVN',
      tags: ['hoá đơn', 'nhắc việc'],
      saved: 'Đã lưu',
      attachedLabel: 'Gắn với',
      attached: 'Nhà cung cấp: EVN',
    },
    share: {
      title: 'Chuyển ghi chú thành dùng chung',
      body: 'Mọi thành viên của tổ chức (trừ người chỉ xem) sẽ đọc được ghi chú này. Chuyển thành dùng chung?',
      confirm: 'Chuyển thành dùng chung',
      cancel: 'Hủy',
    },
    panel: {
      screen: 'Nhà cung cấp: EVN',
      sub: 'Điện, hoá đơn hằng tháng',
      title: 'Ghi chú',
      pinned: 'Đã ghim',
      shared: 'Dùng chung',
      private: 'Riêng tư',
      notes: [
        { title: 'Hoá đơn điện về trễ, nhắc bên khách ngày 5', pinned: true, shared: true },
        { title: 'Đổi người nhận hoá đơn sang email kế toán', pinned: false, shared: false },
      ],
      paletteLabel: 'Tìm kiếm',
      query: 'hoa don',
      group: 'Ghi chú',
      results: ['Hoá đơn điện về trễ, nhắc bên khách ngày 5', 'Quy trình nhận hoá đơn của khách'],
    },
    handover: {
      title: 'Giao việc này thành việc nhóm',
      hint: 'Mọi thành viên trong tổ chức và người giữ vị trí (kể cả đồng nghiệp AI) sẽ đọc được tên việc và mô tả dưới đây. Hãy sửa trước khi giao.',
      positionLabel: 'Giao cho vị trí',
      position: 'Kế toán trưởng',
      taskLabel: 'Tên việc nhóm',
      task: 'Đối chiếu công nợ Bao Bì Phú Thịnh',
      descLabel: 'Mô tả cho nhóm',
      desc: 'Đối chiếu số dư đến hết 20/10/2026',
      button: 'Giao việc',
    },
    data: {
      title: 'Tải về',
      note: 'Ghi chú và việc của riêng bạn trong tổ chức này, cả bộ.',
      markdown: 'Tải về Markdown',
      json: 'Tải về JSON',
    },
    meeting: {
      label: 'Một cuộc họp trong Ludy Cộng tác',
      title: 'Họp chốt lịch giao gạo sỉ đợt tháng 10',
      when: '20/10/2026, 14:00 (28 phút)',
      linkedLabel: 'Gắn với',
      linked: 'Khách hàng: Gạo Sạch Miền Tây',
      consentBadge: 'Đã xác nhận đồng ý ghi âm',
      retention: 'Âm thanh mã hoá, mặc định 30 ngày',
      draftBadge: `Bản nháp của ${N.gm}, chỉ người ghi thấy`,
      summaryTitle: 'Tóm tắt và quyết định nháp',
      summaryPoints: [
        'Giao 10 tấn gạo ST25 thành hai đợt vào ngày 24/10 và 31/10 tại kho Long An',
        'Kế toán gửi hoá đơn nháp trước mỗi đợt giao 1 ngày để khách đối chiếu',
      ],
      actionsTitle: 'Đầu việc ghi nhận',
      actions: [
        { text: 'Gửi lịch giao hai đợt cho Gạo Sạch Miền Tây', who: 'Chị Hoa, 21/10' },
        { text: 'Kiểm tra hạn mức công nợ trước đợt 2', who: 'Chị Lan, 28/10' },
      ],
      publishButton: 'Chia sẻ cho người dự họp',
      minutesButton: 'Xem biên bản',
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type TeamworkCopy = typeof teamworkVi;
