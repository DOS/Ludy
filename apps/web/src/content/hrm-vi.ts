// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese copy of the Ludy Nhân sự page (/nhan-su). hrm-en.ts mirrors this shape. Every claim here is merged and
// usable on main today; items gated on partner accountant sign-off (#2535) or legal review (#2536, #2539) are stated
// plainly and listed under "soon". Company names, amounts and dates are example data (Gạo Sạch Mekong).
import type { AppPageCopy } from './app-page';
import { N } from './roster';

type Tone = 'ok' | 'warn' | 'accent' | 'neutral';

export const hrmVi = {
  appName: 'Ludy Nhân sự',
  meta: {
    title: 'Ludy Nhân sự: hồ sơ nhân viên, chấm công, bảng lương và tuyển dụng gọn cho doanh nghiệp nhỏ',
    description:
      'Ludy Nhân sự gom hồ sơ nhân viên mã hoá theo từng người, phòng ban, hợp đồng lao động, chấm công và sổ phép năm, kỳ lương tháng, bảng kê khai báo và tuyển dụng gọn cho doanh nghiệp nhỏ. Đồng nghiệp AI rà biến động trên số liệu ẩn danh, người tự quyết. Mã nguồn mở AGPL.',
  },
  ogTitle: 'Hồ sơ nhân viên, chấm công, bảng lương và tuyển dụng gọn trong một nơi.',
  crumbLabel: 'Đường dẫn',
  hero: {
    title: 'Hồ sơ nhân viên, chấm công, bảng lương và tuyển dụng gọn trong một nơi.',
    lead: `Ludy Nhân sự giữ kín lương cá nhân cho chủ sở hữu và quản trị viên, tính kỳ lương tháng bằng quy tắc cố định và nhờ đồng nghiệp AI ${N.finance} rà biến động trên số liệu ẩn danh trước khi chuyển bút toán tổng hợp sang Ludy Tài chính.`,
    primary: 'Tự cài đặt miễn phí',
    secondary: 'Đăng nhập',
    note: 'Mã nguồn mở AGPL. Ludy Nhân sự có trong bản tự cài đặt. Trên Ludy Cloud: sắp ra mắt.',
  },
  how: {
    title: 'Bốn bước từ hồ sơ nhân sự đến bảng lương tháng',
    lead: 'Dùng được ngay cho đội ngũ 3 đến 30 người mà không cần dựng sơ đồ phòng ban phức tạp trước.',
    steps: [
      {
        name: 'Lập hồ sơ & hợp đồng',
        body: 'Thêm nhân viên, người phụ thuộc và điều khoản hợp đồng. Số CCCD, mã số thuế, số BHXH và tài khoản ngân hàng được mã hoá bằng khoá riêng của từng người.',
        outcome: 'Đã mã hoá từng người',
        tone: 'neutral',
      },
      {
        name: 'Chấm công & phép năm',
        body: 'Dán dòng công từ bảng tính hoặc tải tệp .csv, .tsv, .txt để nhập nghỉ không lương, làm đêm và làm thêm giờ. Quy tắc cố định cảnh báo vượt trần 40 giờ/tháng và cộng dồn phép năm.',
        outcome: 'Đã kiểm tra giờ công',
        tone: 'ok',
      },
      {
        name: 'Tính lương & rà biến động',
        body: `Quy tắc cố định tính bảo hiểm, thuế thu nhập cá nhân, lương tháng 13; ${N.finance} gắn cờ dòng lương biến động trên mã ẩn danh để bạn kiểm tra.`,
        outcome: 'Kỳ lương nháp',
        tone: 'accent',
      },
      {
        name: 'Khai báo & hạch toán tách biệt',
        body: 'Xuất ngay Sổ quản lý lao động và báo cáo 01/PLI; luồng duyệt 2 lớp, tệp lương ngân hàng và bút toán tổng hợp chờ kế toán đối tác xác nhận bảng quy tắc.',
        outcome: 'Không lộ lương cá nhân',
        tone: 'ok',
      },
    ],
  },
  groups: {
    title: 'Việc Ludy Nhân sự làm hôm nay',
    lead: 'Bốn mục trong menu Nhân sự dành riêng cho chủ sở hữu và quản trị viên: Nhân viên, Tuyển dụng, Bảng lương (kèm thẻ Mẫu file lương) và Bảng kê khai báo.',
    items: [
      {
        id: 'ho-so-va-hop-dong',
        title: 'Hồ sơ nhân sự, phòng ban gọn và hợp đồng lao động',
        lead: 'Quản lý nhân viên theo từng pháp nhân, bảo vệ giấy tờ định danh bằng khoá riêng và theo dõi sát thời hạn hợp đồng, thử việc theo Bộ luật Lao động 2019.',
        points: [
          'Mã hoá riêng từng nhân viên cho số CCCD/CMND/hộ chiếu, mã số thuế cá nhân, số BHXH và số tài khoản ngân hàng; không lưu ảnh chụp giấy tờ tuỳ thân, và hỗ trợ huỷ khoá xoá dữ liệu theo Luật Bảo vệ dữ liệu cá nhân sau thời hạn lưu trữ chứng từ kế toán 10 năm',
          'Phòng ban gọn theo từng pháp nhân kèm nhóm chi phí mặc định (quản lý, bán hàng, sản xuất) và chức danh, hoàn toàn không bắt buộc tạo phòng ban trước khi thêm người đầu tiên',
          'Lịch sử điều khoản làm việc chỉ thêm mới để tăng lương không làm sai lệch kỳ lương cũ: hỗ trợ hợp đồng không xác định thời hạn, hợp đồng xác định thời hạn (1 đến 36 tháng, nhắc tối đa 2 lần ký nối tiếp) hoặc chưa ký hợp đồng lao động (khấu trừ thuế 10%), đồng thời từ chối loại hợp đồng mùa vụ đã bãi bỏ',
          'Kiểm tra trần ngày thử việc theo nhóm vị trí (6 ngày làm việc hoặc 30, 60, 180 ngày lịch), mức lương thử việc tối thiểu 85% và cảnh báo hợp đồng sắp hết hạn hoặc phải chuyển sang không xác định thời hạn',
          'Xuất Sổ quản lý lao động và Báo cáo tình hình sử dụng lao động định kỳ mẫu 01/PLI ra tệp .xlsx hoặc .json (gắn nhãn bản nháp đối chiếu trong khi chờ kế toán xác nhận biểu mẫu)',
        ],
      },
      {
        id: 'cham-cong-va-phep-nam',
        title: 'Chấm công gọn và sổ phép năm tự động cộng dồn',
        lead: 'Đưa dữ liệu chấm công tháng vào kỳ lương trong vài giây bằng cách dán từ bảng tính hoặc sửa trực tiếp trên từng dòng lương nháp.',
        points: [
          'Dán trực tiếp từ bảng tính hoặc tải tệp .csv, .tsv, .txt để nhập hàng loạt ngày nghỉ không lương, ngày chưa làm việc, giờ làm đêm và giờ làm thêm (ngày thường, ngày nghỉ tuần, ngày lễ) có bước xem trước lỗi trước khi áp dụng; phụ cấp và thưởng được giữ nguyên hoặc sửa trên từng dòng lương',
          'Tự động kiểm tra trần làm thêm 40 giờ mỗi tháng theo Bộ luật Lao động khi nhập bảng công, gắn cảnh báo trên dòng vượt ngưỡng và yêu cầu người duyệt xác nhận rõ trước khi chốt kỳ lương',
          'Sổ phép năm theo từng tháng (số dư đầu kỳ, phép năm đã nghỉ, nghỉ việc riêng hưởng lương, nghỉ không lương) kèm nút Đồng bộ nghỉ phép một chạm để chép ngày nghỉ không lương đã duyệt sang kỳ lương nháp',
          'Tính số ngày phép năm được hưởng theo số tháng làm việc và cộng thêm 1 ngày phép cho mỗi 5 năm thâm niên tại doanh nghiệp',
        ],
      },
      {
        id: 'bang-luong-va-hach-toan',
        title: 'Bảng lương tháng, lương tháng 13, trợ cấp thôi việc và hạch toán bốn mắt',
        lead: 'Mọi con số được tính bằng số thập phân chính xác theo quy tắc cố định. Chủ doanh nghiệp nắm chi tiết từng người, còn kế toán chỉ nhận bút toán tổng hợp theo tài khoản.',
        points: [
          'Tính lương gộp, 5 quỹ BHXH/BHYT/BHTN phần nhân viên và phần doanh nghiệp đóng, kinh phí công đoàn, giảm trừ gia cảnh người phụ thuộc, thuế TNCN lũy tiến hoặc khấu trừ 10%, lương thực nhận và phiếu lương từng người',
          'Xem trước và áp dụng lương tháng 13 theo tỷ lệ số tháng làm việc tròn trong năm; công cụ tính trợ cấp thôi việc theo Điều 46 Bộ luật Lao động (0,5 tháng lương cho mỗi năm làm việc đủ điều kiện, trừ thời gian đã đóng BHTN)',
          'Tách biệt quyền xem lương từ tầng cơ sở dữ liệu: chỉ chủ sở hữu và quản trị viên mở được Ludy Nhân sự, mọi lượt đọc dữ liệu nhạy cảm đều ghi nhật ký kiểm toán trước khi mở số liệu',
          'Đã dựng sẵn trọn luồng sau duyệt (hiện giữ khoá an toàn chờ kế toán đối tác xác nhận bảng quy tắc): đóng băng kỳ lương bằng mã xác thực 2 lớp, cắt tệp chuyển khoản .xlsx theo từng ngân hàng với thẻ Mẫu file lương tuỳ chỉnh, xuất bảng kê D02-LT, 05/KK-TNCN, 05/QTT-TNCN, dữ liệu 03/TNCN và chuyển bút toán tổng hợp sang Ludy Tài chính duyệt chéo bốn mắt (cảnh báo khoản lương tiền mặt từ 5.000.000 ₫ trở lên)',
        ],
      },
      {
        id: 'tuyen-dung-gon',
        title: 'Tuyển dụng gọn từ ứng viên đến nhận việc một chạm',
        lead: 'Theo dõi vị trí đang mở và phễu ứng viên vừa vặn cho doanh nghiệp nhỏ mà không cần phần mềm tuyển dụng rời bên ngoài.',
        points: [
          'Tạo vị trí tuyển dụng gắn với phòng ban, loại hợp đồng, vùng lương và khung lương dự kiến, hoặc thêm thẳng ứng viên mới vào phễu ngay cả khi chưa tạo vị trí tuyển',
          'Phễu 6 trạng thái rõ ràng (Ứng tuyển, Sơ loại, Phỏng vấn, Đề nghị, Đã nhận, Từ chối) có kiểm tra bước chuyển hợp lệ',
          'Gợi ý khung giờ phỏng vấn trống dựa trên giờ làm việc của công ty, lịch nghỉ lễ Việt Nam và lịch bận; sự kiện ghi lên lịch làm việc chỉ mang tên vị trí tuyển, không lộ họ tên hay số điện thoại ứng viên trên tiêu đề lịch',
          'Bấm Nhận việc một chạm để tạo ngay hồ sơ nhân viên và hợp đồng lao động đầu tiên trong cùng một giao dịch; chủ sở hữu có thể bấm xoá dữ liệu ứng viên đã kết thúc tuyển dụng (xoá họ tên, email, số điện thoại và ghi chú) theo Luật Bảo vệ dữ liệu cá nhân',
        ],
      },
      {
        id: 'dong-nghiep-ai',
        title: `Đồng nghiệp AI ${N.finance} rà biến động trên số liệu ẩn danh`,
        lead: `${N.finance} là giám đốc tài chính AI làm việc cùng bạn trong cả Ludy Tài chính và Ludy Nhân sự. Mọi lượt đọc đều qua đồng hồ ngân sách AI và không bao giờ nhận tên thật hay số định danh.`,
        points: [
          `Trước khi gửi mô hình AI, máy chủ thay tên nhân viên và ứng viên bằng mã ngẫu nhiên tạm thời (như E1, E2, C1) và chặn lớp thứ hai nếu lọt họ tên, CCCD, mã số thuế, tài khoản ngân hàng, địa chỉ hay số tiền lương kỳ vọng thô của ứng viên`,
          `${N.finance} tóm tắt biến động kỳ lương (thực nhận lệch trên 20% so với tháng trước, người mới vào, người nghỉ việc, dòng vượt trần làm thêm), giải thích phiếu lương, kiểm tra thiếu sót trước khi xuất 01/PLI và soạn bản tóm tắt sơ loại kèm câu hỏi phỏng vấn`,
          'Mọi con số trong câu văn của AI đều được đối chiếu ngược với dữ liệu gốc trước khi hiển thị; khi công ty tắt AI, bấm nút Dừng AI hoặc hết ngân sách tháng, toàn bộ việc tính lương, chấm công, xuất sổ và tuyển dụng vẫn chạy bình thường',
        ],
      },
    ],
  },
  soon: {
    title: 'Sắp ra mắt',
    lead: 'Ba hạng mục dưới đây đang chờ xác nhận nghiệp vụ của kế toán đối tác, rà soát pháp lý hoặc nối liên thông giữa các ứng dụng nên được khoá rõ ràng, không hứa quá sự thật.',
    label: 'Sắp ra mắt',
    items: [
      {
        title: 'Mở khoá duyệt kỳ lương chính thức và ghi sổ bút toán lương',
        body: 'Toàn bộ bộ máy tính lương, đóng băng bằng mã 2 lớp, xuất tệp chuyển khoản theo ngân hàng, bảng kê D02-LT / 05/KK-TNCN / 05/QTT-TNCN và chuyển bút toán tổng hợp sang Ludy Tài chính đã có trong mã nguồn. Nút duyệt chính thức đang giữ khoá an toàn cho tới khi kế toán đối tác đối chiếu xong từng dòng quy tắc bảo hiểm, thuế và sơ đồ tài khoản với văn bản pháp luật gốc.',
      },
      {
        title: 'Xuất tệp XML thuế chuẩn HTKK và gửi phiếu lương qua email',
        body: 'Tệp XML thuế chuẩn HTKK và gửi phiếu lương qua email đang chờ luật sư rà soát thời hạn lưu trữ theo Luật Bảo vệ dữ liệu cá nhân, điều kiện bản quyền bộ lược đồ XSD của HTKK và phương thức gửi phiếu lương bảo mật. Hôm nay phiếu lương xem trực tiếp trong ứng dụng, Sổ quản lý lao động và báo cáo 01/PLI xuất ra tệp .xlsx hoặc .json; còn các bảng kê D02-LT, 05/KK-TNCN và 05/QTT-TNCN dạng .xlsx sẽ xuất khi mở khoá duyệt kỳ lương chính thức.',
      },
      {
        title: 'Gửi ký hợp đồng lao động trực tiếp qua Ludy eSign',
        body: 'Chuyển điều khoản hợp đồng lao động từ hồ sơ nhân viên sang hồ sơ ký điện tử trên Ludy eSign trong một bước, kèm lịch nhắc gia hạn trước ngày hết hạn.',
      },
    ],
  },
  coworker: {
    title: `${N.finance} làm gì trong Ludy Nhân sự`,
    lead: `${N.finance} là giám đốc tài chính AI, đồng nghiệp của bạn trong Ludy Nhân sự và Ludy Tài chính, hoạt động dưới sự điều phối của ${N.gm}. ${N.finance} chỉ đọc các cờ kiểm tra và con số đã ẩn danh khi ngân sách AI cho phép; quy tắc cố định tính số tiền và con người quyết định.`,
    doesTitle: `${N.finance} làm`,
    does: [
      'Gắn cờ biến động thực nhận trên 20%, nhân sự mới hoặc nghỉ việc, làm thêm vượt trần và giải thích dễ hiểu từng khoản trên phiếu lương từ số liệu đã ẩn danh',
      'Rà thiếu sót hồ sơ (thiếu số CCCD, số BHXH, hạn thử việc, hợp đồng sắp hết hạn) trước khi xuất Sổ quản lý lao động và báo cáo 01/PLI',
      'Tóm tắt mức độ phù hợp của ứng viên theo yêu cầu vị trí và gợi ý 3 đến 5 câu hỏi phỏng vấn sát thực tế mà không nhận tên thật hay mức lương thô',
    ],
    doesNotTitle: `${N.finance} không làm`,
    doesNot: [
      'Không tính lương, bảo hiểm hay thuế thu nhập cá nhân: toàn bộ phép tính do bộ quy tắc cố định thực hiện',
      'Không bao giờ nhận họ tên, số CCCD, mã số thuế, số tài khoản ngân hàng hay địa chỉ của nhân viên và ứng viên',
      'Không tự duyệt bảng lương, không ghi sổ kế toán, không xuất tệp ngân hàng và không tự nhận hay loại ứng viên',
    ],
  },
  audience: {
    title: 'Ludy Nhân sự dành cho ai',
    lead: 'Thiết kế vừa khít cho doanh nghiệp nhỏ tại Việt Nam cần sự rõ ràng, bảo mật lương và liên thông sẵn với sổ kế toán.',
    items: [
      {
        title: 'Chủ doanh nghiệp nhỏ từ 3 đến 30 nhân sự',
        body: 'Theo dõi hợp đồng, phép năm, kỳ lương tháng và tuyển người mới ngay trong cùng một nơi quản lý công ty, không lộ bảng lương chi tiết cho các thành viên khác.',
      },
      {
        title: 'Doanh nghiệp thuê kế toán dịch vụ hoặc có kế toán nội bộ',
        body: 'Chủ công ty giữ quyền xem lương từng người ở Ludy Nhân sự; kế toán làm việc ở Ludy Tài chính chỉ kiểm tra và duyệt bút toán tổng hợp theo từng tài khoản chi phí.',
      },
      {
        title: 'Người tự cài đặt trên máy chủ riêng',
        body: 'Mã nguồn mở AGPL, khởi chạy bằng một lệnh docker compose, toàn bộ hồ sơ mã hoá của nhân viên nằm trọn trên máy chủ của bạn và chạy đầy đủ ngay cả khi tắt AI.',
      },
    ],
  },
  faq: {
    title: 'Câu hỏi về Ludy Nhân sự',
    items: [
      {
        q: 'Kế toán của công ty có xem được lương từng nhân viên không?',
        a: 'Không, trừ khi người đó đồng thời được cấp vai trò chủ sở hữu hoặc quản trị viên của tổ chức. Thành viên giữ vai trò kế toán chỉ làm việc trên Ludy Tài chính và duyệt bút toán lương tổng hợp theo từng tài khoản chi phí (quản lý, bán hàng, sản xuất), hoàn toàn không thấy tên hay mức lương của từng cá nhân.',
      },
      {
        q: 'Vì sao việc duyệt kỳ lương chính thức hôm nay vẫn đang khoá an toàn?',
        a: 'Ludy không cho phép đóng băng hay ghi sổ một con số thuế, bảo hiểm khi từng dòng quy tắc pháp lý chưa được kế toán có chứng chỉ đối chiếu trên văn bản gốc. Hôm nay bạn dùng đầy đủ hồ sơ nhân viên, phòng ban, hợp đồng, chấm công, sổ phép năm, tuyển dụng, xuất Sổ quản lý lao động / 01/PLI và chạy thử kỳ lương nháp; ngay khi kế toán đối tác xác nhận xong bảng quy tắc, nút duyệt kỳ lương 2 lớp, tệp chuyển khoản ngân hàng và bút toán sang Ludy Tài chính sẽ mở khoá.',
      },
      {
        q: 'Số CCCD, tài khoản ngân hàng và dữ liệu ứng viên được bảo vệ thế nào?',
        a: 'Số CCCD/CMND/hộ chiếu, mã số thuế, số BHXH và số tài khoản ngân hàng được mã hoá bằng khoá riêng của từng nhân viên và không lưu ảnh chụp giấy tờ. Mọi thao tác mở xem đều ghi nhật ký kiểm toán trước khi đọc. Hồ sơ ứng viên không tuyển có thể xoá sạch ngay theo Luật Bảo vệ dữ liệu cá nhân; hồ sơ nhân viên đã nghỉ việc cho phép huỷ khoá mã hoá sau thời hạn lưu trữ kế toán 10 năm.',
      },
      {
        q: 'Ludy có tự chuyển tiền lương qua ngân hàng hay nộp hộ tờ khai BHXH, thuế không?',
        a: 'Không. Ludy không bao giờ tự động trích tiền hay gửi tờ khai thay bạn. Sau khi mở khoá duyệt kỳ lương chính thức, hệ thống xuất tệp bảng tính .xlsx theo đúng mẫu cột của từng ngân hàng để bạn tải lên ngân hàng điện tử, và xuất các bảng kê D02-LT, 05/KK-TNCN, 05/QTT-TNCN (cùng 01/PLI xuất ngay hôm nay) để bạn đối chiếu và nộp trên cổng chính thức.',
      },
      {
        q: 'Nếu công ty không bật AI thì Ludy Nhân sự có hoạt động đầy đủ không?',
        a: `Có. Toàn bộ việc lưu hồ sơ, kiểm tra hợp đồng và thử việc, nhập chấm công, tính phép năm, tính lương bảo hiểm và thuế, xuất bảng kê và quản lý phễu tuyển dụng đều chạy bằng quy tắc cố định. ${N.finance} chỉ là lớp đọc tóm tắt tuỳ chọn khi bạn bật AI.`,
      },
    ],
  },
  cta: {
    title: 'Thử Ludy Nhân sự cho đội ngũ của bạn',
    body: 'Tự cài đặt miễn phí chỉ với một lệnh docker compose. Đã có tài khoản thì đăng nhập.',
    primary: 'Xem cách tự cài đặt',
    secondary: 'Đăng nhập',
  },
  // Example data rendered in components/apps/hrm-visuals.tsx (sample company: Gạo Sạch Mekong).
  fragments: {
    sample: 'Dữ liệu mẫu',
    hero: {
      label: 'Kỳ lương nháp tháng 10/2026 trong Ludy Nhân sự với kiểm tra quy tắc cố định, nhận xét ẩn danh và hạch toán tách biệt',
      runTitle: 'Kỳ lương tháng 10/2026',
      runState: 'Bản nháp',
      roleBadge: 'Chỉ Chủ sở hữu & Quản trị viên',
      employeesCount: '12 nhân viên · 26 ngày công chuẩn',
      rows: [
        { name: 'Nguyễn Minh Đức', dept: 'Sản xuất · HĐ không thời hạn', gross: '18.500.000 ₫', net: '16.557.500 ₫', tag: 'Tăng ca 18h / 40h', tone: 'ok' as Tone },
        { name: 'Trần Thị Mai', dept: 'Bán hàng · HĐ 12 tháng (lần 1)', gross: '15.200.000 ₫', net: '13.604.000 ₫', tag: 'Phép còn 9 ngày', tone: 'neutral' as Tone },
        { name: 'Lê Hoàng Nam', dept: 'Quản lý · Thử việc 60 ngày', gross: '11.900.000 ₫', net: '10.710.000 ₫', tag: '85% lương cơ bản', tone: 'accent' as Tone },
      ],
      grossLabel: 'Tổng lương gộp',
      grossTotal: '186.400.000 ₫',
      netLabel: 'Tổng thực nhận',
      netTotal: '167.120.000 ₫',
      lyTitle: `${N.finance} rà biến động (ẩn danh)`,
      lyBadge: 'Đề xuất',
      lyNote: 'Mã E1 có tiền làm thêm tăng 24% so với tháng 09/2026 nhưng vẫn dưới trần 40 giờ/tháng. Hợp đồng thử việc của mã E3 còn 9 ngày.',
      privacyBadge: 'Không gửi tên thật, CCCD hay số tài khoản cho AI',
      handoffTitle: 'Chuyển sang Ludy Tài chính',
      handoffSub: 'Bút toán tổng hợp theo bộ phận, duyệt chéo bốn mắt',
      handoffLines: [
        ['Chi phí lương & bảo hiểm doanh nghiệp theo bộ phận', '222.748.000 ₫'],
        ['Phải trả lương (167.120.000 ₫), bảo hiểm & thuế (55.628.000 ₫)', '222.748.000 ₫'],
      ],
      gateNote: 'Đang giữ khoá duyệt chính thức chờ kế toán đối tác xác nhận bảng quy tắc',
    },
    records: {
      title: 'Hồ sơ mã hoá riêng & theo dõi hợp đồng lao động',
      sub: 'Gạo Sạch Mekong',
      sealedTitle: 'Trường mã hoá bằng khoá riêng của từng người',
      sealedFields: ['Số CCCD / hộ chiếu', 'Mã số thuế cá nhân', 'Số sổ BHXH', 'Số tài khoản ngân hàng'],
      contractsTitle: 'Kiểm tra hợp đồng & thử việc tự động',
      alerts: [
        { person: 'Trần Thị Mai · Phòng Bán hàng', detail: 'HĐ xác định thời hạn 12 tháng (lần 1/2), hết hạn 30/11/2026', badge: 'Sắp đến hạn', tone: 'warn' as Tone },
        { person: 'Lê Hoàng Nam · Phòng Quản lý', detail: 'Thử việc đại học tối đa 60 ngày lịch, hưởng 85% lương', badge: 'Đúng chuẩn Bộ luật Lao động', tone: 'ok' as Tone },
      ],
      exportsTitle: 'Xuất ngay từ hồ sơ nhân sự',
      exports: ['Sổ quản lý lao động (.xlsx, .json)', 'Báo cáo 01/PLI định kỳ (.xlsx, .json)'],
    },
    timekeeping: {
      title: 'Nhập bảng chấm công & sổ phép năm',
      sub: 'Dán từ bảng tính hoặc tải tệp .csv, .tsv, .txt',
      importBadge: 'Đã kiểm tra 12/12 dòng hợp lệ',
      otTitle: 'Kiểm tra trần làm thêm 40 giờ/tháng',
      otRows: [
        { name: 'Nguyễn Minh Đức', regular: '26 công', ot: '18 giờ làm thêm', status: 'Đạt (dưới 40h)', tone: 'ok' as Tone },
        { name: 'Phạm Thu Hà', regular: '25 công · 1 nghỉ không lương', ot: '42 giờ làm thêm', status: 'Cảnh báo vượt trần 40h', tone: 'warn' as Tone },
      ],
      leaveTitle: 'Sổ phép năm cộng dồn & thâm niên',
      leavePerson: 'Nguyễn Minh Đức · 6 năm làm việc (+1 ngày thâm niên)',
      leaveStats: [
        ['Phép năm được hưởng', '13 ngày'],
        ['Đã nghỉ trong năm', '4 ngày'],
        ['Số dư còn lại', '9 ngày'],
      ],
    },
    payroll: {
      title: 'Tính lương, quyết toán & tách biệt quyền kế toán',
      sub: 'Số thập phân chính xác, không làm tròn sai lệch',
      calcItems: [
        { label: 'Bảo hiểm bắt buộc (5 quỹ)', value: 'BHXH, BHYT, BHTN phần nhân viên & doanh nghiệp' },
        { label: 'Thuế thu nhập cá nhân', value: 'Biểu lũy tiến từng phần hoặc khấu trừ 10%' },
        { label: 'Lương tháng 13 & thôi việc', value: 'Tính theo tháng làm việc tròn & Điều 46 Bộ luật Lao động' },
      ],
      splitTitle: 'Tách biệt hiển thị giữa Chủ doanh nghiệp và Kế toán',
      ownerBoxTitle: 'Chủ sở hữu & Quản trị viên (Ludy Nhân sự)',
      ownerBoxBody: 'Xem lương từng người, phiếu lương, mẫu file lương từng ngân hàng và bảng kê D02-LT, 05/KK-TNCN, 05/QTT-TNCN.',
      accountantBoxTitle: 'Kế toán duyệt chéo (Ludy Tài chính)',
      accountantBoxBody: 'Chỉ thấy tổng chi phí theo tài khoản quản lý, bán hàng, sản xuất và cảnh báo khoản chi tiền mặt từ 5.000.000 ₫ trở lên.',
    },
    recruiting: {
      title: 'Phễu tuyển dụng gọn & nhận việc một chạm',
      sub: 'Không bắt buộc tạo vị trí tuyển trước',
      openingTitle: 'Nhân viên kinh doanh kênh đại lý · Vùng I',
      stages: [
        { stage: 'Sơ loại', count: '3' },
        { stage: 'Phỏng vấn', count: '2' },
        { stage: 'Đề nghị', count: '1' },
      ],
      calendarTitle: 'Sự kiện ghi trên lịch làm việc',
      calendarEvent: 'Phỏng vấn: Nhân viên kinh doanh kênh đại lý · 14:00 22/10/2026',
      calendarPrivacy: 'Tiêu đề lịch không chứa họ tên hay số điện thoại ứng viên',
      hireAction: 'Nhận việc một chạm: tạo hồ sơ nhân viên và hợp đồng lao động',
      eraseAction: 'Kết thúc tuyển dụng: xoá họ tên, liên hệ và ghi chú theo Luật Bảo vệ dữ liệu cá nhân',
    },
    coworker: {
      title: `${N.finance} chỉ đọc mã ẩn danh & dự phòng khi tắt AI`,
      sub: 'Qua ngân sách tháng trong Ludy AI',
      shieldTitle: 'Lớp chắn dữ liệu trước khi gọi mô hình AI',
      keptInServer: 'Giữ lại trên máy chủ: họ tên, CCCD, mã số thuế, số BHXH, tài khoản ngân hàng, địa chỉ, lương thô ứng viên',
      sentToModel: 'Chỉ gửi cho mô hình: mã tạm E1, E2, C1 kèm số tiền lương ẩn danh (hoặc trạng thái khớp khung lương khi tuyển dụng) và cờ kiểm tra',
      briefTitle: `${N.finance} tóm tắt sơ loại ứng viên C1`,
      briefBody: 'Đáp ứng 4/4 kỹ năng bắt buộc, mức lương mong muốn nằm trong khung ngân sách vị trí. Gợi ý hỏi thêm kinh nghiệm mở đại lý tỉnh.',
      aiOffTitle: 'Khi tắt AI hoặc hết ngân sách tháng',
      aiOffBody: `${N.finance} tạm nghỉ: toàn bộ tính lương, chấm công, phép năm, xuất sổ 01/PLI và tuyển dụng vẫn chạy bình thường.`,
    },
  },
} satisfies AppPageCopy & { fragments: object };

export type HrmCopy = typeof hrmVi;
