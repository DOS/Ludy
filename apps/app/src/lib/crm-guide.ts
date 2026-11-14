// SPDX-License-Identifier: AGPL-3.0-only
// The guide to CRM slice 1 (issue #2231, docs/plan/crm.md step K7) and to quotes (#2699): contacts, importing them from a file, deals on the
// board. Like the quick guide it is Vietnamese only, whatever the interface language, and quotes the buttons and screens by
// their Vietnamese labels from the source catalog, so a renamed button renames it here too. The page shows it only where the
// crm module is on.
import { brandName, withBrand } from '../i18n/brand.ts';
import { vi } from '../i18n/messages/vi.ts';

export interface CrmGuideStep {
  id: 'crm-contacts' | 'crm-import' | 'crm-deals' | 'crm-quotes';
  title: string;
  items: readonly string[];
}

const q = (label: string) => `"${label}"`;

const CRM_GUIDE: readonly CrmGuideStep[] = [
  {
    id: 'crm-contacts',
    title: 'Bước 1. Thêm và tìm liên hệ',
    items: [
      `Mở ${q(vi.nav.apps.engage)} ở thanh bên, rồi ${q(vi.nav.contacts)}. Khách hàng và nhà cung cấp trên hóa đơn cũng hiện ở đây.`,
      `Bấm ${q(vi.contacts.add)} để thêm một người hoặc một công ty. Mã số thuế đã có ở liên hệ khác thì {brand} cho biết đó là ai, để bạn mở liên hệ đó thay vì tạo thêm một liên hệ nữa.`,
      'Ô tìm kiếm không cần gõ dấu: gõ "nguyen" vẫn thấy "Nguyễn". Tìm được theo tên, email, số điện thoại và mã số thuế.',
      `Chọn bộ lọc (ví dụ ${q(vi.contacts.filters.hasEmail)}) rồi bấm ${q(vi.savedViews.save)} để lưu thành một thẻ ngay trên danh sách. Chế độ xem chỉ của bạn, trừ khi bạn chọn ${q(vi.savedViews.shareWithOrg)}.`,
      'Bấm vào một liên hệ để xem thông tin, các cơ hội, ghi chú và dòng thời gian của liên hệ đó.',
    ],
  },
  {
    id: 'crm-import',
    title: 'Bước 2. Nhập liên hệ từ tệp',
    items: [
      `Ở ${q(vi.nav.contacts)}, bấm ${q(vi.contacts.importFile)}. Bấm ${q(vi.contactImport.choose.template)} nếu muốn xem tệp mẫu.`,
      `Chọn tệp Excel (.xlsx) hoặc CSV, dòng đầu là tiêu đề, tối đa 2.000 dòng. Tệp được đọc ngay trên máy bạn và không được lưu lại.`,
      `Ở bước ${q(vi.contactImport.steps.map)}, kiểm tra mỗi cột là thông tin nào (tên, mã số thuế, email, điện thoại, địa chỉ, công ty). Cột có tiêu đề quen thuộc được chọn sẵn; phải có một cột là ${q(vi.contactImport.field.name)}. Cột ${q(vi.contactImport.field.company)} ghi công ty mỗi người làm việc, bằng tên hoặc mã số thuế của công ty.`,
      `Ở bước ${q(vi.contactImport.steps.preview)}, xem từng dòng: ${q(vi.contactImport.outcome.new)}, ${q(vi.contactImport.outcome.duplicate)} (trùng mã số thuế, email hoặc số điện thoại với liên hệ đã có hoặc với một dòng trước), ${q(vi.contactImport.outcome.conflict)} (khớp với hai liên hệ khác nhau) và ${q(vi.contactImport.outcome.invalid)}. Lúc này chưa có gì được ghi vào danh sách liên hệ.`,
      `Dòng trùng thì bỏ qua, hoặc chỉ điền vào chỗ còn trống của liên hệ đã có; thông tin đã có không bao giờ bị ghi đè.`,
      `Công ty đã có trong danh sách thì người đó được gắn vào đó. Công ty chưa có chỉ được tạo khi bạn chọn ô tạo công ty mới ở bước xem trước; không chọn thì những người này vẫn được nhập, chỉ chưa gắn công ty.`,
      `Bấm nút nhập để tạo các liên hệ mới. Các dòng chưa nhập tải về được kèm lý do. Lần nhập chưa quyết định sau 7 ngày sẽ bị xóa cùng dữ liệu của nó.`,
    ],
  },
  {
    id: 'crm-deals',
    title: 'Bước 3. Theo dõi cơ hội trên bảng',
    items: [
      `Mở ${q(vi.nav.apps.engage)}, rồi ${q(vi.nav.deals)}. Bảng có một cột cho mỗi giai đoạn: ${q('Mới')}, ${q('Đã liên hệ')}, ${q('Báo giá')}, ${q('Thương lượng')}, ${q('Thắng')} và ${q('Thua')}. Trên điện thoại, màn hình mở ở dạng ${q(vi.deals.view.list)}.`,
      `Bấm ${q(vi.deals.add)}: nhập tên cơ hội, tìm khách hàng đã có, số tiền (đồng) và ngày dự kiến chốt.`,
      'Kéo thẻ sang cột khác, hoặc kéo lên xuống trong cột để đổi thứ tự. Dùng bàn phím hoặc điện thoại thì chọn giai đoạn ở menu trên thẻ. Gần mép bảng, các cột tự cuộn khi bạn kéo.',
      `Chuyển sang ${q('Thắng')} là cơ hội đã chốt. Chuyển sang ${q('Thua')} thì có thể ghi lý do. Chuyển ngược lại sang giai đoạn đang mở thì cơ hội mở lại.`,
      'Hai người cùng sửa một cơ hội: người lưu sau được báo là cơ hội vừa được người khác sửa, và không ghi đè lên bản của người trước.',
      `Chủ sở hữu và quản trị viên bấm ${q(vi.deals.view.settings)} để đổi tên, thêm, sắp xếp và xóa các giai đoạn đang mở (tối đa 12 giai đoạn; ${q('Thắng')} và ${q('Thua')} luôn ở cuối). Giai đoạn còn cơ hội thì chưa xóa được.`,
      'Mỗi lần tạo, chuyển giai đoạn hay xóa cơ hội đều ghi vào dòng thời gian của liên hệ, không kèm tên cơ hội hay số tiền.',
    ],
  },
  {
    id: 'crm-quotes',
    title: 'Bước 4. Lập báo giá cho một cơ hội',
    items: [
      `Mở ${q(vi.nav.deals)}, bấm vào một cơ hội rồi bấm ${q(vi.quotes.create)}. Khách hàng và tên cơ hội được điền sẵn; báo giá chỉ là bản nháp cho đến khi bạn gửi.`,
      `Bấm ${q(vi.quotes.editor.addItem)} rồi nhập mô tả, số lượng, đơn giá trước thuế, giảm giá và thuế GTGT. Muốn dùng lại dòng cũ thì chọn ${q(vi.quotes.editor.copyFrom)}; nhập lại mô tả một món khách từng được báo giá thì đơn giá lần trước hiện ra, bạn sửa được.`,
      'Tiền hàng, thuế và tổng cộng do máy tính theo cùng một quy tắc với hóa đơn bán ra, bạn không phải cộng tay, và số trên màn hình là số máy chủ sẽ lưu.',
      'Nếu máy chủ có bật AI, bạn có thể nhờ người đồng nghiệp AI của mảng bán hàng gợi ý dòng hàng từ tin khách đã nhắn và các báo giá cũ của khách. Giá chỉ lấy từ chính các nguồn đó, thiếu thì để trống cho bạn nhập; từng dòng gợi ý do bạn chọn dùng hoặc bỏ. Tắt AI hay hết ngân sách AI thì bạn vẫn lập báo giá như bình thường.',
      `Bấm ${q(vi.quotes.editor.save)} để lưu bản nháp. Hai người cùng sửa một báo giá: người lưu sau được báo là báo giá vừa được người khác sửa.`,
      'Báo giá đã gửi mà 5 ngày chưa có trả lời, hoặc còn hiệu lực từ 3 ngày trở xuống, sẽ thành một việc cần theo dõi cho người phụ trách cơ hội, hiện ở mục việc tiếp theo của Cơ hội và ở Trang chủ.',
      `Mở ${q(vi.reports.title)} rồi chọn thẻ ${q(vi.reports.tabs.quotes)} để xem số báo giá đã gửi, đã chấp nhận, bị từ chối và đang chờ, kèm giá trị, theo khoảng thời gian bạn chọn.`,
    ],
  },
];

export function crmGuide(brand: string = brandName()): readonly CrmGuideStep[] {
  return CRM_GUIDE.map((step) => ({ ...step, title: withBrand(step.title, brand), items: step.items.map((item) => withBrand(item, brand)) }));
}
