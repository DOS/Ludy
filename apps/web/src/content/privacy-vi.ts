// SPDX-License-Identifier: AGPL-3.0-only
// Chính sách quyền riêng tư, tiếng Việt (bản mặc định). Mỗi câu phải đúng với những gì code và ADR đã chấp nhận làm hôm nay;
// xem privacy.ts. Phiên bản và ngày nằm ở content/site.ts.
import type { PrivacyCopy } from './privacy';
import { N } from './roster';
import { PRIVACY_OPERATOR } from './site';

export const privacyVi: PrivacyCopy = {
  meta: {
    title: 'Chính sách quyền riêng tư | Ludy',
    description:
      'Ludy ghi, lưu, cho ai đọc và giữ bao lâu dữ liệu cuộc họp khi bạn dùng tiện ích Ludy cho trình duyệt, và cách Ludy Cloud xử lý dữ liệu tài khoản và sổ sách. Không bán dữ liệu, không quảng cáo, không theo dõi.',
  },
  ogTitle: 'Chính sách quyền riêng tư',
  crumbLabel: 'Đường dẫn trang',
  title: 'Chính sách quyền riêng tư',
  lead: 'Trang này nói rõ Ludy xử lý dữ liệu thế nào khi bạn dùng tiện ích Ludy cho trình duyệt và khi bạn dùng Ludy Cloud. Phần về tiện ích đi trước, vì đó là phần cần đọc trước khi bạn bấm ghi.',
  versionLine: 'Phiên bản 1.0, có hiệu lực từ 13/11/2026.',
  reviewNotice: 'Chính sách này đang được rà soát và có thể được cập nhật.',
  contentsTitle: 'Nội dung',
  sections: [
    {
      id: 'summary',
      title: 'Tóm tắt',
      blocks: [
        {
          kind: 'list',
          items: [
            'Tiện ích chỉ ghi khi bạn bấm "Bắt đầu ghi" trên tab họp, sau khi bạn xác nhận rằng mọi người tham gia đã được báo và đồng ý.',
            'Bản ghi chỉ đi tới một địa chỉ Ludy mà bạn đã chọn: app.ludy.vn, hoặc máy chủ Ludy riêng của công ty bạn.',
            'Âm thanh và video của mỗi cuộc họp được lưu mã hóa bằng khóa riêng. Hết thời hạn giữ, khóa bị hủy và bản ghi không còn đọc được; phần văn bản bị xóa theo thời hạn của nó.',
            'Ludy không bán dữ liệu, không chạy quảng cáo, không theo dõi bạn, và không dùng dữ liệu để đánh giá tín dụng hay cho vay.',
            'Bạn có thể thu hồi tiện ích bất cứ lúc nào trong Ludy, ở mục thiết bị đã kết nối.',
          ],
        },
        {
          kind: 'p',
          text: `Ludy là phần mềm mã nguồn mở. Ludy Cloud (app.ludy.vn) do ${PRIVACY_OPERATOR} vận hành. Ludy cũng chạy được trên máy chủ riêng của một công ty. Tổ chức ghi cuộc họp là bên quyết định việc ghi và phải báo cho người tham gia; trên Ludy Cloud, Ludy xử lý dữ liệu đó theo chỉ dẫn của tổ chức. Công ty chạy Ludy trên máy chủ riêng tự chịu trách nhiệm về dữ liệu trên máy chủ đó. Trang này mô tả tiện ích và Ludy Cloud, không thay chính sách của công ty ấy.`,
        },
      ],
    },
    {
      id: 'extension',
      title: 'Tiện ích Ludy cho trình duyệt',
      blocks: [
        {
          kind: 'p',
          text: 'Tiện ích Ludy (Chrome và Edge) có một mục đích: ghi âm thanh của cuộc họp đang mở trong một tab trình duyệt, cùng micro của bạn, rồi tải lên thành một cuộc họp trong không gian Ludy của bạn khi bạn dừng. Bản ghi chứa giọng nói của người tham gia, và khuôn mặt của họ nếu bạn ghi cả video. Đó là dữ liệu cá nhân.',
        },
        {
          kind: 'table',
          caption: 'Tiện ích xử lý những gì',
          head: ['Dữ liệu', 'Khi nào', 'Dùng để làm gì'],
          rows: [
            ['Âm thanh của tab họp và của micro bạn', 'Chỉ sau khi bạn xác nhận và bấm "Bắt đầu ghi"', 'Tạo bản ghi cuộc họp trong Ludy'],
            ['Video của tab họp', 'Chỉ khi bạn tick "Ghi cả video" cho cuộc họp đó', 'Xem lại phần chia sẻ màn hình'],
            ['Tên cuộc họp, cách đã báo cho người tham gia, xác nhận của bạn', 'Trước khi ghi', 'Lưu bằng chứng đã báo, cùng với cuộc họp'],
            ['Mã đăng nhập của tiện ích', 'Sau khi bạn đăng nhập Ludy và cho phép tiện ích', 'Để Ludy biết tiện ích làm việc cho bạn, trong một tổ chức'],
            ['Tên thiết bị, ví dụ "Tiện ích Ludy, Chrome trên Windows"', 'Khi bạn kết nối tiện ích', 'Để bạn thấy và thu hồi thiết bị trong Ludy. Chỉ gồm trình duyệt và hệ điều hành, không có địa chỉ mạng hay số sê-ri'],
            ['Địa chỉ Ludy và các tính năng bạn đã bật', 'Khi bạn cài đặt tiện ích', 'Lưu trong bộ nhớ riêng của tiện ích trên máy bạn'],
          ],
        },
        {
          kind: 'p',
          text: 'Tiện ích không đọc nội dung, địa chỉ, tiêu đề hay văn bản bạn chọn của bất kỳ trang web nào. Nó không thu lịch sử duyệt web, vị trí, thông tin tài chính hay sức khỏe, và không có công cụ phân tích, đo đạc hay mã định danh quảng cáo.',
        },
        { kind: 'p', text: 'Bước xác nhận đi trước mọi bản ghi:' },
        {
          kind: 'list',
          items: [
            'Trước khi mở bất kỳ thiết bị ghi nào, tiện ích đòi bạn nhập tên cuộc họp, chọn cách đã báo cho người tham gia (nói ở đầu cuộc họp, ghi trong lời mời, hoặc bằng văn bản) và xác nhận rằng mọi người đã được báo và đồng ý.',
            'Ludy lưu xác nhận này cùng với cuộc họp và từ chối nhận âm thanh nếu thiếu nó.',
            'Tiện ích chỉ ghi tab bạn đang mở khi bấm "Bắt đầu ghi". Nó không ghi tab khác và không tự bắt đầu.',
          ],
        },
        { kind: 'p', text: 'Dữ liệu đi đâu:' },
        {
          kind: 'list',
          items: [
            'Tiện ích chỉ liên lạc với một địa chỉ: app.ludy.vn (Ludy Cloud), hoặc địa chỉ máy chủ Ludy riêng của công ty bạn mà bạn gõ lúc cài đặt. Với máy chủ riêng, trình duyệt hỏi quyền cho đúng địa chỉ đó. Tiện ích không liên lạc địa chỉ nào khác và chỉ nhận địa chỉ https (hoặc localhost).',
            'Bản ghi chưa tải lên nằm trên máy bạn, trong bộ nhớ riêng của tiện ích, và bị xóa khi đã tải lên xong. Nếu tải lên lỗi, bản ghi còn đó cho đến khi bạn tải lại hoặc xóa khỏi máy.',
            'Đăng nhập diễn ra ở trang đăng nhập của Ludy, mở trong cửa sổ trình duyệt. Tiện ích không bao giờ thấy mật khẩu hay phiên đăng nhập của ứng dụng.',
            'Mã đăng nhập của tiện ích chỉ có hiệu lực cho một tổ chức, một thành viên và các tính năng bạn đã bật. Nó hết hạn sau 90 ngày, mất hiệu lực ngay khi bạn bị gỡ khỏi tổ chức, và mỗi lần dùng đều có dòng trong nhật ký kiểm toán.',
          ],
        },
        { kind: 'p', text: 'Quyền trình duyệt mà tiện ích xin, và vì sao:' },
        {
          kind: 'list',
          items: [
            'Lưu trữ (storage): giữ địa chỉ Ludy, mã đăng nhập và các tính năng bạn đã bật, và giữ bản ghi trên máy đến khi tải lên xong.',
            'Đăng nhập (identity): mở trang đăng nhập Ludy để bạn đăng nhập và cho phép tiện ích.',
            'Địa chỉ app.ludy.vn: gửi bản ghi và thông tin cuộc họp tới Ludy Cloud, và lấy danh sách tính năng.',
            'Ghi tab (tabCapture) và tài liệu ngoài màn hình (offscreen): chỉ được xin khi bạn bật "Ghi cuộc họp", và trả lại khi bạn tắt. Chúng ghi âm thanh của tab bạn đã bấm ghi, và không bao giờ ghi tab khác.',
            'Một địa chỉ máy chủ riêng: chỉ với công ty tự chạy Ludy, và chỉ đúng một địa chỉ do bạn gõ. Tiện ích không bao giờ xin quyền cho một trang web bạn đang xem.',
          ],
        },
        { kind: 'p', text: 'Tiện ích không dùng mã tải từ xa: toàn bộ mã nằm trong gói cài đặt.' },
      ],
    },
    {
      id: 'storage',
      title: 'Sau khi tải lên: lưu trữ',
      blocks: [
        {
          kind: 'list',
          items: [
            'Bản ghi đi tới Ludy qua kết nối https.',
            'Âm thanh và video của mỗi cuộc họp được mã hóa (AES-256-GCM) bằng khóa riêng của nó trước khi nằm trong kho lưu trữ. Khóa này được bọc bằng khóa của hệ thống. Tệp tải lên gốc bị xóa khi đã được chuẩn hóa; âm thanh đã chuẩn hóa ở lại. Bản ghi lời, tóm tắt, quyết định và việc cần làm là văn bản trong cơ sở dữ liệu và bị xóa khi hết thời hạn.',
            'Video chỉ được giữ khi bạn tick "Ghi cả video". Nếu không tick, phần hình bị bỏ khi xử lý và không bao giờ được lưu. Video có khóa riêng, nên có thể bị hủy sớm hơn âm thanh, và không bao giờ muộn hơn.',
            'Việc kiểm tra và chuyển đổi tệp chạy trong một container riêng, không có mạng và không có khóa bí mật.',
          ],
        },
      ],
    },
    {
      id: 'readers',
      title: 'Ai đọc được một cuộc họp',
      blocks: [
        {
          kind: 'list',
          items: [
            'Người đọc được: người ghi, và các thành viên được nêu là người tham dự. Người ghi có thể chia sẻ cuộc họp cho cả tổ chức.',
            'Chủ sở hữu và quản trị viên thấy cuộc họp có tồn tại (ngày, độ dài, người ghi) để quản lý ngân sách và thời hạn lưu, nhưng không đọc nội dung của cuộc họp chỉ chia sẻ cho người tham dự. Chủ sở hữu có thể xóa một cuộc họp để đáp ứng yêu cầu về dữ liệu cá nhân mà không cần đọc nó.',
            'Thành viên chỉ xem, các nhân viên AI trong sơ đồ tổ chức và hệ thống không đọc gì từ cuộc họp.',
            `${N.gm}, làm việc cho chính người ghi, đọc những gì người ghi đọc, chỉ trong cuộc họp đang xử lý. Kết quả của ${N.gm} (bản ghi lời, tóm tắt, quyết định, việc cần làm) là bản nháp chỉ người ghi thấy, cho đến khi người ghi bấm xuất bản cho những người đọc cuộc họp. Bản nháp chưa xuất bản hết hạn sau 30 ngày. ${N.gm} không tự tạo việc, gửi thư hay gửi thông báo từ nội dung cuộc họp.`,
          ],
        },
      ],
    },
    {
      id: 'transcription',
      title: 'Bản ghi lời và tóm tắt bằng AI',
      blocks: [
        {
          kind: 'list',
          items: [
            'Chỉ chạy khi tổ chức của bạn đã bật và triển khai có cấu hình AI. Khi AI tắt, bản ghi vẫn được lưu và không có gì được gửi tới nhà cung cấp AI nào.',
            'Khi bật, nhà cung cấp phiên âm mà không gian làm việc đó cấu hình nhận các đoạn âm thanh (mỗi đoạn tối đa 10 phút) và gợi ý ngôn ngữ, không nhận gì khác. Tên nhà cung cấp và nơi xử lý là cấu hình của từng triển khai.',
            'Bản tóm tắt dùng mô hình văn bản của triển khai: nó nhận nội dung bản ghi lời, ngày họp và tên người tham dự của cuộc họp đó.',
            'Công ty chạy Ludy trên máy chủ riêng có thể trỏ phiên âm tới một mô hình chạy ngay trên máy của họ; khi đó âm thanh không rời khỏi máy của công ty.',
            'Nhà cung cấp ở ngoài Việt Nam là việc chuyển dữ liệu ra nước ngoài, mà tổ chức phải tự đánh giá.',
            'Kết quả AI là nội dung chưa được kiểm chứng. Người ghi xem và quyết định có xuất bản hay không.',
          ],
        },
      ],
    },
    {
      id: 'retention',
      title: 'Giữ bao lâu',
      blocks: [
        {
          kind: 'table',
          caption: 'Thời hạn giữ một cuộc họp',
          head: ['Dữ liệu', 'Mặc định', 'Tổ chức có thể chọn'],
          rows: [
            ['Âm thanh', '30 ngày sau khi bản ghi lời sẵn sàng', 'Xóa ngay sau khi có bản ghi lời, hoặc 7, 30, 90 ngày'],
            ['Video (nếu có)', '7 ngày', '7 hoặc 30 ngày, không bao giờ lâu hơn âm thanh'],
            ['Bản ghi lời, tóm tắt, quyết định, việc cần làm', '12 tháng', '3, 12 hoặc 24 tháng, hoặc đến khi bị xóa'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Chủ sở hữu hoặc quản trị viên đổi các thiết lập này. Thay đổi chỉ áp dụng cho cuộc họp ghi sau đó, để thời hạn mà người tham gia đã được báo vẫn đúng.',
            'Nếu bản ghi lời chưa bao giờ sẵn sàng (AI tắt, hết ngân sách AI), âm thanh và video vẫn có ngày hết hạn tính từ lúc ghi, nên không bản ghi nào nằm chờ vô thời hạn.',
            'Khi hết hạn hoặc khi cuộc họp bị xóa, khóa mã hóa bị hủy. Âm thanh và video không còn đọc được ngay lúc đó. Nếu hệ thống phải khôi phục từ một bản sao lưu cũ, cuộc họp đã hủy được xóa lại ở lần chạy hằng đêm kế tiếp hoặc khi phát lại tham chiếu xóa. Tệp tải lên chưa mã hóa bị xóa khỏi vùng tạm trong vòng một ngày.',
            'Văn bản (bản ghi lời, tóm tắt, quyết định, việc cần làm) bị xóa bởi tác vụ chạy hằng đêm khi hết hạn, và biến mất khỏi bản sao lưu cơ sở dữ liệu khi các bản sao lưu đó hết hạn.',
            'Một việc được tạo từ mục cần làm là hồ sơ công việc của tổ chức: nó ở lại với nội dung người dùng đã xác nhận, và liên kết về cuộc họp báo "Cuộc họp đã xóa".',
            'Khi một tổ chức bị xóa khỏi Ludy, mọi cuộc họp và khóa của tổ chức đó bị xóa.',
          ],
        },
      ],
    },
    {
      id: 'rights',
      title: 'Quyền của bạn và cách thực hiện',
      blocks: [
        {
          kind: 'list',
          items: [
            'Dừng ghi: tắt "Ghi cuộc họp" trong tiện ích để trả lại quyền ghi tab, hoặc gỡ tiện ích bất cứ lúc nào.',
            'Thu hồi tiện ích: vào Cài đặt, mục thiết bị đã kết nối, trong Ludy, rồi thu hồi thiết bị. Mã đăng nhập của tiện ích mất hiệu lực ngay.',
            'Xóa một cuộc họp: người ghi xóa cuộc họp của mình trong Ludy. Việc xóa hủy khóa âm thanh ngay. Chủ sở hữu tổ chức xóa được bất kỳ cuộc họp nào của tổ chức (có xác thực lại), mà không cần đọc nó.',
            'Bạn là người tham gia nhưng không dùng Ludy (khách hàng, nhà cung cấp, ứng viên): hãy nói với người ghi hoặc công ty đó. Họ quyết định việc ghi, có thể dừng ghi, và xóa được cuộc họp khi bạn phản đối.',
            'Xem, sao chép, chỉnh sửa hoặc xóa dữ liệu của bạn trong sổ sách của một tổ chức: liên hệ chủ sở hữu hoặc quản trị viên của tổ chức đó trong Ludy trước, vì tổ chức quyết định việc xử lý. Ludy hỗ trợ tổ chức thực hiện yêu cầu của bạn.',
            'Theo Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15, bạn có quyền được biết, đồng ý hoặc rút lại sự đồng ý, xem và chỉnh sửa dữ liệu, yêu cầu xóa, hạn chế hoặc phản đối việc xử lý, nhận bản sao, khiếu nại, tố cáo và yêu cầu bồi thường. Một số quyền có giới hạn khi pháp luật buộc phải giữ dữ liệu, ví dụ chứng từ kế toán.',
          ],
        },
      ],
    },
    {
      id: 'cloud',
      title: 'Ludy Cloud nói chung',
      blocks: [
        {
          kind: 'p',
          text: `Ludy Cloud (app.ludy.vn) là bản Ludy do ${PRIVACY_OPERATOR} vận hành. Phần này tóm tắt; nó không thay phần về tiện ích ở trên. Chính sách được viết theo Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 và Nghị định 356/2025/NĐ-CP.`,
        },
        {
          kind: 'list',
          items: [
            'Dữ liệu tài khoản: họ tên, email, mật khẩu (chỉ lưu dạng băm), yếu tố xác thực hai lớp; và hoạt động như thời điểm đăng nhập, địa chỉ IP, trình duyệt, nhật ký thao tác. Với dữ liệu này, Ludy là bên kiểm soát dữ liệu.',
            'Dữ liệu trong sổ sách của tổ chức (chứng từ, hóa đơn, sao kê, bút toán, và cuộc họp): tổ chức quyết định mục đích xử lý. Ludy là bên xử lý và chỉ làm theo chỉ dẫn của tổ chức.',
            'Lịch Google: chỉ khi một thành viên tự kết nối lịch của mình. Ludy đọc các khoảng giờ bận, không đọc tiêu đề hay người tham dự. Mọi thành viên của tổ chức thấy các khoảng giờ bận này (không kèm nội dung).',
            'Mục đích: cung cấp dịch vụ, bảo mật (xác thực đăng nhập, xác thực hai lớp, nhật ký kiểm toán), hỗ trợ và vận hành, và trả lời yêu cầu hợp lệ của cơ quan nhà nước.',
            'Ludy không bán dữ liệu cá nhân, không dùng chứng từ hay sổ sách của bạn để quảng cáo, và không dùng chúng để huấn luyện mô hình AI.',
            'AI với chứng từ: hóa đơn điện tử dạng XML được đọc trực tiếp, không qua AI. PDF và ảnh chụp chứng từ được gửi tới nhà cung cấp AI của triển khai để đọc nội dung. Kết quả luôn được kiểm bằng quy tắc và do người duyệt trước khi ghi sổ.',
            'Bảo mật: dữ liệu giữa các tổ chức được cách ly ở tầng cơ sở dữ liệu; mã hóa đường truyền; xác thực hai lớp cho việc duyệt chứng từ; nhật ký kiểm toán không sửa được; sao lưu hằng ngày có thử khôi phục; giới hạn số lần thử đăng nhập.',
            'Khi xảy ra vi phạm dữ liệu cá nhân, Ludy báo cho cơ quan có thẩm quyền và tổ chức của bạn chậm nhất 72 giờ sau khi phát hiện, theo quy định.',
            'Lưu trữ: dữ liệu của tổ chức được giữ trong suốt thời gian tổ chức dùng Ludy. Khi tổ chức đóng, tổ chức xuất dữ liệu của mình trước, sau đó dữ liệu bị xóa. Địa chỉ email người nhận và tiêu đề trong nhật ký gửi thư bị xóa sau 13 tháng, chỉ giữ mã băm để chặn gửi lại tới địa chỉ đã từ chối. Nhật ký kiểm toán được giữ cùng sổ sách của tổ chức, vì đó là bằng chứng ai đã duyệt gì. Tổ chức tự lưu chứng từ và sổ kế toán theo thời hạn Luật Kế toán yêu cầu, bằng bản xuất của mình.',
          ],
        },
      ],
    },
    {
      id: 'changes',
      title: 'Thay đổi chính sách',
      blocks: [
        {
          kind: 'p',
          text: 'Chính sách này đang được rà soát và có thể được cập nhật. Khi tiện ích đổi quyền trình duyệt hoặc loại dữ liệu mà nó xử lý, trang này được cập nhật cùng lúc, và phiên bản cùng ngày ở đầu trang đổi theo.',
        },
      ],
    },
  ],
  contact: { emailLead: 'Yêu cầu xóa dữ liệu, xuất dữ liệu hoặc câu hỏi về dữ liệu cá nhân: gửi email tới' },
};
