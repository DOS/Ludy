// SPDX-License-Identifier: AGPL-3.0-only
// The guide to CRM slice 1 (issue #2231, docs/plan/crm.md step K7) and to quotes (#2699): contacts, importing them from a file, deals on the
// board, then quotes, orders and invoices. Like the quick guide it is written in both interface languages (#3596) and quotes the
// buttons and screens by the labels of the same language's catalog, so a renamed button renames it here too. The page shows it only
// where the crm module is on.
import { brandName } from '../i18n/brand.ts';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { buildGuide, quote as q, type GuideStep, type GuideTexts } from './guide-text.ts';

export type CrmGuideStep = GuideStep<'crm-contacts' | 'crm-import' | 'crm-deals' | 'crm-quotes' | 'crm-quote-order'>;

const CRM_GUIDE: GuideTexts<CrmGuideStep['id']> = {
  vi: (m) => [
    {
      id: 'crm-contacts',
      title: 'Bước 1. Thêm và tìm liên hệ',
      items: [
        `Mở ${q(m.nav.apps.engage)} ở thanh bên, rồi ${q(m.nav.contacts)}. Khách hàng và nhà cung cấp trên hóa đơn cũng hiện ở đây.`,
        `Bấm ${q(m.contacts.add)} để thêm một người hoặc một công ty. Mã số thuế đã có ở liên hệ khác thì {brand} cho biết đó là ai, để bạn mở liên hệ đó thay vì tạo thêm một liên hệ nữa.`,
        'Ô tìm kiếm không cần gõ dấu: gõ "nguyen" vẫn thấy "Nguyễn". Tìm được theo tên, email, số điện thoại và mã số thuế.',
        `Chọn bộ lọc (ví dụ ${q(m.contacts.filters.hasEmail)}) rồi bấm ${q(m.savedViews.save)} để lưu thành một thẻ ngay trên danh sách. Chế độ xem chỉ của bạn, trừ khi bạn chọn ${q(m.savedViews.shareWithOrg)}.`,
        'Bấm vào một liên hệ để xem thông tin, các cơ hội, ghi chú và dòng thời gian của liên hệ đó.',
      ],
    },
    {
      id: 'crm-import',
      title: 'Bước 2. Nhập liên hệ từ tệp',
      items: [
        `Ở ${q(m.nav.contacts)}, bấm ${q(m.contacts.importFile)}. Bấm ${q(m.contactImport.choose.template)} nếu muốn xem tệp mẫu.`,
        `Chọn tệp Excel (.xlsx) hoặc CSV, dòng đầu là tiêu đề, tối đa 2.000 dòng. Tệp được đọc ngay trên máy bạn và không được lưu lại.`,
        `Ở bước ${q(m.contactImport.steps.map)}, kiểm tra mỗi cột là thông tin nào (tên, mã số thuế, email, điện thoại, địa chỉ, công ty). Cột có tiêu đề quen thuộc được chọn sẵn; phải có một cột là ${q(m.contactImport.field.name)}. Cột ${q(m.contactImport.field.company)} ghi công ty mỗi người làm việc, bằng tên hoặc mã số thuế của công ty.`,
        `Ở bước ${q(m.contactImport.steps.preview)}, xem từng dòng: ${q(m.contactImport.outcome.new)}, ${q(m.contactImport.outcome.duplicate)} (trùng mã số thuế, email hoặc số điện thoại với liên hệ đã có hoặc với một dòng trước), ${q(m.contactImport.outcome.conflict)} (khớp với hai liên hệ khác nhau) và ${q(m.contactImport.outcome.invalid)}. Lúc này chưa có gì được ghi vào danh sách liên hệ.`,
        `Dòng trùng thì bỏ qua, hoặc chỉ điền vào chỗ còn trống của liên hệ đã có; thông tin đã có không bao giờ bị ghi đè.`,
        `Công ty đã có trong danh sách thì người đó được gắn vào đó. Công ty chưa có chỉ được tạo khi bạn chọn ô tạo công ty mới ở bước xem trước; không chọn thì những người này vẫn được nhập, chỉ chưa gắn công ty.`,
        `Bấm nút nhập để tạo các liên hệ mới. Các dòng chưa nhập tải về được kèm lý do. Lần nhập chưa quyết định sau 7 ngày sẽ bị xóa cùng dữ liệu của nó.`,
      ],
    },
    {
      id: 'crm-deals',
      title: 'Bước 3. Theo dõi cơ hội trên bảng',
      items: [
        `Mở ${q(m.nav.apps.engage)}, rồi ${q(m.nav.deals)}. Bảng có một cột cho mỗi giai đoạn: ${q('Mới')}, ${q('Đã liên hệ')}, ${q('Báo giá')}, ${q('Thương lượng')}, ${q('Thắng')} và ${q('Thua')}. Trên điện thoại, màn hình mở ở dạng ${q(m.deals.view.list)}.`,
        `Bấm ${q(m.deals.add)}: nhập tên cơ hội, tìm khách hàng đã có, số tiền (đồng) và ngày dự kiến chốt.`,
        'Kéo thẻ sang cột khác, hoặc kéo lên xuống trong cột để đổi thứ tự. Dùng bàn phím hoặc điện thoại thì chọn giai đoạn ở menu trên thẻ. Gần mép bảng, các cột tự cuộn khi bạn kéo.',
        `Chuyển sang ${q('Thắng')} là cơ hội đã chốt. Chuyển sang ${q('Thua')} thì có thể ghi lý do. Chuyển ngược lại sang giai đoạn đang mở thì cơ hội mở lại.`,
        'Hai người cùng sửa một cơ hội: người lưu sau được báo là cơ hội vừa được người khác sửa, và không ghi đè lên bản của người trước.',
        `Chủ sở hữu và quản trị viên bấm ${q(m.deals.editStages)} (hoặc mở Cài đặt, thẻ ${q(m.deals.process.title)}) để đổi tên, thêm, sắp xếp và xóa các giai đoạn đang mở (tối đa 12 giai đoạn; ${q('Thắng')} và ${q('Thua')} luôn ở cuối). Giai đoạn còn cơ hội thì chưa xóa được.`,
        'Mỗi lần tạo, chuyển giai đoạn hay xóa cơ hội đều ghi vào dòng thời gian của liên hệ, không kèm tên cơ hội hay số tiền.',
      ],
    },
    {
      id: 'crm-quotes',
      title: 'Bước 4. Lập báo giá cho một cơ hội',
      items: [
        `Mở ${q(m.nav.deals)}, bấm vào một cơ hội rồi bấm ${q(m.quotes.create)}. Khách hàng và tên cơ hội được điền sẵn; báo giá chỉ là bản nháp cho đến khi bạn gửi.`,
        `Bấm ${q(m.quotes.editor.addItem)} rồi nhập mô tả, số lượng, đơn giá trước thuế, giảm giá và thuế GTGT. Muốn dùng lại dòng cũ thì chọn ${q(m.quotes.editor.copyFrom)}; nhập lại mô tả một món khách từng được báo giá thì đơn giá lần trước hiện ra, bạn sửa được.`,
        'Tiền hàng, thuế và tổng cộng do máy tính theo cùng một quy tắc với hóa đơn bán ra, bạn không phải cộng tay, và số trên màn hình là số máy chủ sẽ lưu.',
        'Nếu máy chủ có bật AI, bạn có thể nhờ người đồng nghiệp AI của mảng bán hàng gợi ý dòng hàng từ tin khách đã nhắn và các báo giá cũ của khách. Giá chỉ lấy từ chính các nguồn đó, thiếu thì để trống cho bạn nhập; từng dòng gợi ý do bạn chọn dùng hoặc bỏ. Tắt AI hay hết ngân sách AI thì bạn vẫn lập báo giá như bình thường.',
        `Bấm ${q(m.quotes.editor.save)} để lưu bản nháp. Hai người cùng sửa một báo giá: người lưu sau được báo là báo giá vừa được người khác sửa.`,
        'Báo giá đã gửi mà 5 ngày chưa có trả lời, hoặc còn hiệu lực từ 3 ngày trở xuống, sẽ thành một việc cần theo dõi cho người phụ trách cơ hội, hiện ở mục việc tiếp theo của Cơ hội và ở Trang chủ.',
        `Mở ${q(m.reports.title)} rồi chọn thẻ ${q(m.reports.tabs.quotes)} để xem số báo giá đã gửi, đã chấp nhận, bị từ chối và đang chờ, kèm giá trị, theo khoảng thời gian bạn chọn.`,
      ],
    },
    {
      id: 'crm-quote-order',
      title: 'Bước 5. Gửi báo giá, ghi nhận trả lời, đơn hàng và hóa đơn',
      items: [
        `Báo giá đã lưu có khung ${q(m.quotes.send.title)} ngay dưới trình soạn. Chọn ${q(m.quotes.send.viaLink)} rồi bấm ${q(m.quotes.send.sendLink)} (báo giá chuyển sang Đã gửi, còn bạn tự dán liên kết cho khách), hoặc chọn ${q(m.quotes.send.viaEmail)} rồi bấm ${q(m.quotes.send.sendEmail)}. Việc gửi luôn do bạn bấm; không có gì được gửi đi tự động.`,
        `Gửi bằng liên kết: liên kết chỉ hiện một lần, hãy bấm ${q(m.quotes.send.copyMessage)} rồi dán vào Zalo hay Messenger. Trong Hộp thư, ở cuộc trò chuyện của khách, bạn cũng chèn được báo giá vào ô trả lời bằng ${q(m.quotes.send.replyInsert)}, rồi tự bấm gửi. Khách xem không cần đăng nhập và in được. Lần đầu khách mở, bạn thấy ngày giờ ngay trên báo giá.`,
        `Gửi bằng email: thư có liên kết và kèm bản PDF của báo giá đúng như đã gửi. Nếu chưa tạo được bản PDF thì thư vẫn đi với liên kết, và nội dung thư không nói là có kèm PDF. Muốn tự tải PDF về, mở menu ⋯ ở dòng báo giá rồi chọn ${q(m.quotes.row.pdf)}. Chủ sở hữu và quản trị viên điền điện thoại, email, ghi chú chuyển khoản và logo ở Cài đặt, thẻ ${q(m.quotes.settings.card)}. Các thông tin này và logo được chụp lại lúc bạn gửi, nên đổi sau không làm đổi báo giá đã gửi.`,
        `Báo giá đã gửi thì không sửa được, vì đó là bản khách đã nhận. Muốn đổi, mở menu ⋯ của dòng báo giá rồi chọn ${q(m.quotes.row.revise)}; khi gửi bản mới, bản cũ thành ${q(m.quotes.status.superseded)} và liên kết cũ không còn mở được. Bạn cũng thu hồi được một liên kết bằng ${q(m.quotes.send.revoke)}.`,
        `Khi khách trả lời, bạn ghi lại. Bấm ${q(m.quotes.decision.accept)}, chọn khách đồng ý bằng cách nào và ngày nào, rồi bấm ${q(m.quotes.decision.acceptYes)}. Nếu khách từ chối, mở menu ⋯ của dòng báo giá, chọn ${q(m.quotes.decision.decline)} và ghi lý do nếu muốn. Khách không tự bấm đồng ý trên liên kết: luôn do một người ghi nhận.`,
        `Sau khi báo giá được gửi hoặc được chấp nhận, đầu thẻ báo giá của cơ hội có thể hiện các gợi ý như chuyển cơ hội sang giai đoạn ${q('Báo giá')} hoặc ${q('Thắng')}, hay ${q(m.quotes.dealOffer.setAmount)}. Đây là luật cố định, không gọi mô hình AI. Mỗi gợi ý chỉ chạy khi bạn bấm, hoặc bạn bấm ${q(m.quotes.dealOffer.dismiss)}; cơ hội không tự đổi.`,
        `Ghi nhận khách đồng ý thì có ngay một đơn hàng, hiện ở mục ${q(m.quotes.orders.title)}, là bản sao đúng như báo giá đã gửi. Lúc này chưa có hóa đơn nào và kho chưa động đến.`,
        `Nếu mô-đun Kế toán chạy, bấm ${q(m.quotes.orders.invoice)} trên đơn để Kế toán lập bản nháp hóa đơn từ các dòng của đơn; một dòng không bị lập hai lần. Dòng có giảm giá chưa vào được hóa đơn và được nêu tên. Rồi bấm ${q(m.quotes.orders.invoiceOpen)} để xem lại; việc phát hành vẫn do Kế toán duyệt. Mỗi dòng hàng của đơn cho biết nó đang ở đâu: ${q(m.quotes.orders.invoiceState.none)}, ${q(m.quotes.orders.invoiceState.draft)} hay ${q(m.quotes.orders.invoiceState.issued)}. Lập một phần thì nút nêu các dòng còn lại và ẩn đi khi hết dòng.`,
        `Khi hàng đi, bấm ${q(m.quotes.orders.delivery.open)} rồi ${q(m.quotes.orders.delivery.mark)} ở từng dòng hàng. Kho chỉ trừ lúc này, không trừ lúc xác nhận đơn; dòng dịch vụ không trừ kho. Dòng báo ${q(m.quotes.orders.delivery.stockPending)} thì bấm ${q(m.quotes.orders.delivery.stockRecord)} hoặc ${q(m.quotes.orders.delivery.stockRetry)}, an toàn khi bấm lại. Nếu hàng chưa có tên trong kho, bấm ${q(m.quotes.orders.delivery.stockTeach)}. Giao nhầm thì bấm ${q(m.quotes.orders.delivery.takeBack)}.`,
        `Chỉ hủy đơn bằng ${q(m.quotes.orders.cancelOrder)} khi chưa lập hóa đơn hay giao hàng cho đơn đó. Đơn có dòng đã lập nháp hoặc đã phát hành thì nút hủy tắt và màn hình nói lý do; đơn đã giao mà chưa hoàn giao thì hệ thống từ chối việc hủy; đơn đã hủy không lập hóa đơn được.`,
      ],
    },
  ],
  en: (m) => [
    {
      id: 'crm-contacts',
      title: 'Step 1. Add and find contacts',
      items: [
        `Open ${q(m.nav.apps.engage)} in the side bar, then ${q(m.nav.contacts)}. The customers and vendors on your invoices show here too.`,
        `Click ${q(m.contacts.add)} to add a person or a company. If the tax code already belongs to another contact, {brand} tells you who it is, so you can open that contact instead of creating one more.`,
        'The search box ignores Vietnamese accents: a search for "nguyen" also finds names written with accents. You can search by name, email, phone number and tax code.',
        `Pick a filter (for example ${q(m.contacts.filters.hasEmail)}) and click ${q(m.savedViews.save)} to keep it as a tab right on the list. A view is yours alone, unless you choose ${q(m.savedViews.shareWithOrg)}.`,
        'Click a contact to see its details, deals, notes and timeline.',
      ],
    },
    {
      id: 'crm-import',
      title: 'Step 2. Import contacts from a file',
      items: [
        `In ${q(m.nav.contacts)}, click ${q(m.contacts.importFile)}. Click ${q(m.contactImport.choose.template)} if you want to see a sample file.`,
        'Pick an Excel (.xlsx) or CSV file with a header row, up to 2,000 rows. The file is read on your own device and is not stored.',
        `In the ${q(m.contactImport.steps.map)} step, check which kind of information each column holds (name, tax code, email, phone, address, company). Columns with familiar headings are picked for you; one column must be ${q(m.contactImport.field.name)}. The ${q(m.contactImport.field.company)} column names the company each person works for, by name or by tax code.`,
        `In the ${q(m.contactImport.steps.preview)} step, look at each row: ${q(m.contactImport.outcome.new)}, ${q(m.contactImport.outcome.duplicate)} (the same tax code, email or phone number as an existing contact or an earlier row), ${q(m.contactImport.outcome.conflict)} (matches two different contacts) and ${q(m.contactImport.outcome.invalid)}. Nothing has been written to your contacts yet.`,
        'Rows that repeat an existing contact are skipped, or only fill the empty fields of that contact; information that is already there is never overwritten.',
        'A company that is already in your list gets the person attached to it. A company that is not there is created only if you tick the box to create new companies in the preview; if you do not, those people are still imported, just without a company.',
        'Click the import button to create the new contacts. The rows that were not imported can be downloaded with the reason. An import you have not decided on is deleted with its data after 7 days.',
      ],
    },
    {
      id: 'crm-deals',
      title: 'Step 3. Follow deals on the board',
      items: [
        `Open ${q(m.nav.apps.engage)}, then ${q(m.nav.deals)}. The board has a column for each stage. A new organization starts with these stages, named in Vietnamese: ${q('Mới')} (new), ${q('Đã liên hệ')} (contacted), ${q('Báo giá')} (quote), ${q('Thương lượng')} (negotiation), ${q('Thắng')} (won) and ${q('Thua')} (lost). On a phone, the screen opens as a ${q(m.deals.view.list)}.`,
        `Click ${q(m.deals.add)}: enter the deal's name, find an existing customer, the amount (in dong) and the expected closing date.`,
        'Drag a card to another column, or up and down within a column to change the order. With a keyboard or on a phone, pick the stage in the menu on the card. Near the edge of the board, the columns scroll by themselves as you drag.',
        `Moving a deal to ${q('Thắng')} closes it as won. Moving it to ${q('Thua')} lets you note the reason. Moving it back to an open stage reopens it.`,
        'If two people edit the same deal, the one who saves second is told that the deal was just changed by someone else, and does not overwrite the first person\'s version.',
        `Owners and admins click ${q(m.deals.editStages)} (or open Settings, the ${q(m.deals.process.title)} tab) to rename, add, reorder and delete the open stages (up to 12 stages; ${q('Thắng')} and ${q('Thua')} always stay last). A stage that still holds deals cannot be deleted yet.`,
        'Every time a deal is created, moved to another stage or deleted, it is written to the contact\'s timeline, without the deal\'s name or amount.',
      ],
    },
    {
      id: 'crm-quotes',
      title: 'Step 4. Make a quote for a deal',
      items: [
        `Open ${q(m.nav.deals)}, click a deal, then click ${q(m.quotes.create)}. The customer and the deal's name are filled in; the quote is only a draft until you send it.`,
        `Click ${q(m.quotes.editor.addItem)}, then enter a description, quantity, unit price before tax, discount and VAT. To reuse old lines, pick ${q(m.quotes.editor.copyFrom)}; if you type again the description of an item the customer was quoted before, the earlier unit price shows and you can change it.`,
        'The goods total, the tax and the grand total are worked out by the computer by the same rule as a sales invoice, so you never add them by hand, and the figures on screen are the ones the server will save.',
        'If the server has AI on, you can ask the AI coworker for sales to suggest item lines from the messages the customer sent and from the customer\'s earlier quotes. A price is taken only from those sources, and left empty for you to enter if it is missing; you choose to use or drop each suggested line. With AI off, or when the AI budget is used up, you still make quotes as usual.',
        `Click ${q(m.quotes.editor.save)} to save the draft. If two people edit the same quote, the one who saves second is told that the quote was just changed by someone else.`,
        'A quote that was sent and has had no answer for 5 days, or that has 3 days or fewer left before it expires, becomes something to follow up for whoever owns the deal; it shows in the next steps of the deal and on Home.',
        `Open ${q(m.reports.title)} and pick the ${q(m.reports.tabs.quotes)} tab to see how many quotes were sent, accepted, declined and are still waiting, with their value, over the period you choose.`,
      ],
    },
    {
      id: 'crm-quote-order',
      title: 'Step 5. Send the quote, record the answer, then the order and the invoice',
      items: [
        `A saved quote has a ${q(m.quotes.send.title)} box right under the editor. Pick ${q(m.quotes.send.viaLink)} and click ${q(m.quotes.send.sendLink)} (the quote becomes ${q(m.quotes.status.sent)}, and you paste the link to the customer yourself), or pick ${q(m.quotes.send.viaEmail)} and click ${q(m.quotes.send.sendEmail)}. Sending is always your click; nothing is sent automatically.`,
        `Sending by link: the link shows only once, so click ${q(m.quotes.send.copyMessage)} and paste it into Zalo or Messenger. In the inbox, in the customer's conversation, you can also put the quote into the reply box with ${q(m.quotes.send.replyInsert)}, then send it yourself. The customer can view it without signing in, and can print it. When the customer first opens it, you see the date and time right on the quote.`,
        `Sending by email: the email has the link and the PDF of the quote exactly as sent. If the PDF could not be made, the email still goes out with the link, and its text does not say a PDF is attached. To download the PDF yourself, open the ⋯ menu on the quote's row and pick ${q(m.quotes.row.pdf)}. Owners and admins enter the phone, email, bank transfer note and logo in Settings, the ${q(m.quotes.settings.card)} tab. These details and the logo are captured when you send, so a later change does not alter a quote already sent.`,
        `A quote that was sent cannot be edited, because it is the version the customer received. To change it, open the ⋯ menu on the quote's row and pick ${q(m.quotes.row.revise)}; when you send the new version, the old one becomes ${q(m.quotes.status.superseded)} and its link no longer opens. You can also take back a link with ${q(m.quotes.send.revoke)}.`,
        `When the customer answers, you record it. Click ${q(m.quotes.decision.accept)}, choose how and on which day the customer agreed, then click ${q(m.quotes.decision.acceptYes)}. If the customer declines, open the ⋯ menu on the quote's row, pick ${q(m.quotes.decision.decline)} and give a reason if you like. The customer does not click "agree" on the link: a person always records it.`,
        `After a quote is sent or accepted, the top of the deal's quote tab may show suggestions such as moving the deal to the stage ${q('Báo giá')} (quote) or ${q('Thắng')} (won), or ${q(m.quotes.dealOffer.setAmount)}. These are fixed rules and call no AI model. Each suggestion runs only when you click it, or you click ${q(m.quotes.dealOffer.dismiss)}; the deal never changes by itself.`,
        `Recording that the customer agreed creates an order at once. It shows under ${q(m.quotes.orders.title)} and is a copy of the quote exactly as sent. No invoice exists yet and stock is untouched.`,
        `If the Accounting module is on, click ${q(m.quotes.orders.invoice)} on the order and Accounting makes a draft invoice from the order's lines; a line is never invoiced twice. A line with a discount cannot go onto the invoice yet and is named. Then click ${q(m.quotes.orders.invoiceOpen)} to look at it; issuing it is still approved in Accounting. Each item line of the order says where it stands: ${q(m.quotes.orders.invoiceState.none)}, ${q(m.quotes.orders.invoiceState.draft)} or ${q(m.quotes.orders.invoiceState.issued)}. If you invoice only part of it, the button names the remaining lines and hides when none are left.`,
        `When the goods leave, click ${q(m.quotes.orders.delivery.open)} and then ${q(m.quotes.orders.delivery.mark)} on each item line. Stock is deducted only now, not when the order is confirmed; a service line does not deduct stock. For a line that shows ${q(m.quotes.orders.delivery.stockPending)}, click ${q(m.quotes.orders.delivery.stockRecord)} or ${q(m.quotes.orders.delivery.stockRetry)}; it is safe to click again. If the item has no name in stock yet, click ${q(m.quotes.orders.delivery.stockTeach)}. If you delivered by mistake, click ${q(m.quotes.orders.delivery.takeBack)}.`,
        `Cancel an order with ${q(m.quotes.orders.cancelOrder)} only before an invoice or a delivery exists for it. An order with a line that has a draft or an issued invoice has its cancel button turned off and the screen says why; an order that was delivered and not taken back is refused cancellation; a cancelled order cannot be invoiced.`,
      ],
    },
  ],
};

export function crmGuide(brand: string = brandName(), locale: Locale = DEFAULT_LOCALE): readonly CrmGuideStep[] {
  return buildGuide(CRM_GUIDE, brand, locale);
}
