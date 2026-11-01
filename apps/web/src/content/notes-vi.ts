// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy Notes page (/notes). notes-en.ts mirrors this shape. Every claim here is merged and usable
// on main today (the PR lists the PR or route behind each one); planned work is not named. Company names, amounts and
// dates are example data and stay the same in both languages where they are names.
import type { AppPageCopy } from './app-page';

export const notesVi = {
  appName: 'Ludy Notes',
  meta: {
    title: 'Ludy Notes: ghi chú và việc của bạn, ngay cạnh khách hàng và chứng từ',
    description:
      'Ludy Notes giữ ghi chú riêng hoặc dùng chung, viết bằng Markdown, ngay trên màn hình khách hàng, nhà cung cấp, chứng từ và lịch hẹn, cùng danh sách việc riêng có hạn và giờ nhắc. Mã nguồn mở, tìm không cần gõ dấu.',
  },
  ogTitle: 'Ghi chú và việc của bạn, ngay cạnh khách hàng và chứng từ.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Ghi chú và việc của bạn, ngay cạnh khách hàng và chứng từ.',
    lead: 'Ludy Notes giữ ghi chú riêng hoặc dùng chung với cả tổ chức, và danh sách việc của riêng bạn có hạn, giờ nhắc và các bước. Ghi chú viết ngay trên màn hình của khách hàng, nhà cung cấp, chứng từ hay lịch hẹn thì nằm đúng ở đó khi bạn quay lại.',
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy Notes có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn việc với ghi chú và việc cần làm',
    lead: 'Ghi chú và Việc của tôi là hai màn hình cạnh nhau, cùng bảng ghi chú trên các màn hình khác.',
    steps: [
      { name: 'Viết ghi chú', body: 'Viết bằng Markdown, riêng cho bạn hoặc dùng chung với cả tổ chức.', outcome: 'Riêng tư lúc đầu', tone: 'neutral' },
      { name: 'Gắn vào bản ghi', body: 'Viết từ bảng Ghi chú trên màn hình khách hàng, nhà cung cấp, chứng từ, bút toán hay lịch hẹn.', outcome: 'Hiện đúng chỗ', tone: 'accent' },
      { name: 'Ghi việc', body: 'Thêm việc của tôi với hạn, giờ nhắc và các bước.', outcome: 'Chỉ mình bạn thấy', tone: 'ok' },
      { name: 'Giao việc', body: 'Cần người khác làm thì giao cho một vị trí, việc thành việc nhóm.', outcome: 'Đã giao', tone: 'ok' },
    ],
  },
  groups: {
    title: 'Việc Ludy Notes làm hôm nay',
    lead: 'Ghi chú, ghi chú ngay chỗ làm việc, việc của riêng bạn, và dữ liệu của bạn.',
    items: [
      {
        id: 'ghi-chu',
        title: 'Ghi chú',
        lead: 'Riêng cho bạn hoặc dùng chung, viết nhanh và tìm lại dễ.',
        points: [
          'Ghi chú mới luôn riêng tư. Chỉ người viết sửa được nội dung',
          'Ghi chú riêng chỉ bạn xem được trong tổ chức này, kể cả chủ sở hữu và quản trị viên cũng không. Chuyển thành dùng chung thì mọi thành viên, trừ người chỉ xem, đọc được',
          'Viết bằng Markdown: tiêu đề, danh sách, ô đánh dấu và liên kết',
          'Thẻ, ghim, lưu trữ và thùng rác (dọn sau 30 ngày), có nút Hoàn tác khi lưu trữ hoặc xoá',
        ],
      },
      {
        id: 'ngay-cho-lam-viec',
        title: 'Ghi chú ngay chỗ làm việc',
        lead: 'Bảng Ghi chú nằm trên chính các màn hình bạn đang làm.',
        points: [
          'Bảng Ghi chú có trên màn hình khách hàng, nhà cung cấp, chứng từ mua, bút toán, lịch hẹn, liên hệ CRM và trang tổng quan',
          'Ghi chú viết từ một bảng thì gắn với bản ghi đó. Mỗi bảng chỉ hiện ghi chú bạn được đọc',
          'Tìm ghi chú theo tiêu đề, thẻ hoặc nội dung, gõ không cần dấu, cả trong Ctrl K',
        ],
      },
      {
        id: 'viec-cua-toi',
        title: 'Việc của tôi',
        lead: 'Danh sách việc riêng, có hạn và giờ nhắc.',
        points: [
          'Mỗi việc có hạn, giờ, các bước và hộp nhắc. Chỉ mình bạn thấy, chủ sở hữu và quản trị viên cũng không',
          'Chia sẵn theo Quá hạn, Hôm nay và 7 ngày tới',
          'Nhắc hiện trong chuông thông báo của Ludy, vào 8:00 ngày đến hạn hoặc 30 phút trước giờ bạn đặt',
          'Giao cho một vị trí thì việc thành việc nhóm. Bạn sửa tên và mô tả trước khi giao; mọi thành viên đọc được việc nhóm, và vị trí có thể do agent AI giữ',
        ],
      },
      {
        id: 'du-lieu',
        title: 'Dữ liệu của bạn',
        lead: 'Tải về bất cứ lúc nào.',
        points: [
          'Tải ghi chú và việc của bạn về dạng Markdown hoặc JSON, cả bộ chứ không từng ghi chú',
          'Khi một thành viên rời tổ chức, ghi chú riêng và việc của họ được giữ kín 30 ngày rồi xoá. Ghi chú dùng chung ở lại',
        ],
      },
    ],
  },
  assistant: {
    title: 'Vy và ghi chú',
    lead: 'Ghi chú của bạn ở lại với bạn.',
    doesTitle: 'Vy và agent làm',
    does: ['Nhận một việc bạn giao cho vị trí do agent AI giữ, sau khi bạn sửa tên và mô tả'],
    doesNotTitle: 'Vy và agent không',
    doesNot: ['Không đọc ghi chú của bạn', 'Không viết hay sửa ghi chú'],
  },
  audience: {
    title: 'Ludy Notes dành cho ai',
    lead: 'Cho người cần nhớ nhiều thứ nhỏ về khách hàng và công việc.',
    items: [
      {
        title: 'Chủ doanh nghiệp một người và doanh nghiệp nhỏ',
        body: 'Giữ điều cần nhớ về từng khách hàng và nhà cung cấp ngay trên màn hình của họ, cùng danh sách việc của riêng bạn.',
      },
      {
        title: 'Kế toán và dịch vụ kế toán',
        body: 'Để lại ghi chú trên hoá đơn hay bút toán của khách. Trong tổ chức của một khách hàng, trang tổng quan hiện các ghi chú về khách đó.',
      },
      {
        title: 'Người tự cài đặt',
        body: 'Mã nguồn mở AGPL, dữ liệu nằm trên máy chủ của bạn.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Notes',
    items: [
      {
        q: 'Ai đọc được ghi chú của tôi?',
        a: 'Ghi chú riêng chỉ bạn đọc được trong tổ chức này, chủ sở hữu và quản trị viên cũng không. Ghi chú dùng chung thì mọi thành viên đọc được, trừ người chỉ xem. Chỉ người viết mới chuyển một ghi chú giữa riêng và dùng chung.',
      },
      {
        q: 'Ludy Notes có nhắc việc qua email không?',
        a: 'Không. Nhắc việc hiện trong chuông thông báo của Ludy, vào 8:00 ngày đến hạn hoặc 30 phút trước giờ bạn đặt.',
      },
      {
        q: 'Việc tôi giao cho một vị trí thì ai thấy?',
        a: 'Người giữ vị trí và mọi thành viên của tổ chức đều đọc được việc nhóm. Chi tiết và các bước của việc riêng không tự chuyển sang, bạn gõ vào mô tả nếu cần.',
      },
      {
        q: 'Tôi không thấy Ghi chú trong menu?',
        a: 'Ludy Notes là một phân hệ. Người cài đặt có thể tắt nó; khi đó không có menu Ghi chú, bảng ghi chú hay tìm kiếm ghi chú.',
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Notes với công việc của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // What the page draws of the product, as example data (the home page's sample company, Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
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
      hint: 'Mọi thành viên trong tổ chức và người giữ vị trí (kể cả agent AI) sẽ đọc được tên việc và mô tả dưới đây. Hãy sửa trước khi giao.',
      positionLabel: 'Giao cho vị trí',
      position: 'Kế toán trưởng, Chị Lan',
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
      leaveTitle: 'Khi một thành viên rời tổ chức',
      leave: 'Ghi chú riêng và việc của họ được giữ kín 30 ngày rồi xoá. Ghi chú dùng chung ở lại.',
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type NotesCopy = typeof notesVi;
