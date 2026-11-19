// SPDX-License-Identifier: AGPL-3.0-only
// The one-page quick guide (issues #310, #3596): the three jobs an owner does every month, upload and approve the
// purchase invoices, file the VAT return, export the books to Excel for the accountant. It is written in both
// interface languages and quotes the buttons and screens by the labels of the same language's catalog, so a renamed
// button renames it here too. The guide for an accounting firm with many client companies (issue #661) is not here:
// docs/product/scope.md puts that audience in the Icebox.
import { brandName } from '../i18n/brand.ts';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.ts';
import { buildGuide, fill, quote as q, type GuideStep, type GuideTexts } from './guide-text.ts';

export type QuickGuideStep = GuideStep<'upload' | 'vat' | 'export'>;

const QUICK_GUIDE: GuideTexts<QuickGuideStep['id']> = {
  vi: (m) => [
    {
      id: 'upload',
      title: 'Bước 1. Tải hóa đơn lên và duyệt',
      items: [
        `Mở ${q(m.nav.inbox)} trong menu (bên trái màn hình; trên điện thoại, bấm nút ☰ ở góc trên để mở menu).`,
        `Bấm ${q(m.inbox.upload)}, hoặc kéo thả tệp vào ô ${q(m.inbox.dropHere)}. Mỗi tệp tối đa 25 MB, chọn được nhiều tệp một lần (tối đa 500), hoặc một tệp ZIP tải về từ cổng thuế: {brand} mở ZIP và đọc từng hóa đơn.`,
        'Tệp XML hóa đơn điện tử luôn đọc được. Tệp PDF và ảnh chụp chỉ đọc được khi máy chủ đã cấu hình AI; nếu chưa, ô tải lên sẽ báo.',
        `Nếu máy chủ bật nhận email, bạn có thể chuyển tiếp thư hóa đơn tới địa chỉ trong ô ${q(m.inbox.forwardTitle)} (bấm ${q(m.inbox.copyAddress)} để sao chép).`,
        `Tệp vừa gửi hiện ở ${q(m.inbox.recentFiles)}: ${q(m.inbox.fileStatus.processing)}, rồi ${q(m.inbox.fileStatus.proposed)}. Nếu tệp ${q(m.inbox.fileStatus.failed)}, bấm ${q(m.inbox.reread)} khi có nút này.`,
        `Ở tab ${q(m.inbox.tabs.pending)}, bấm tên người bán để mở đề xuất. Đối chiếu số tiền, ${q(m.inboxDetail.checks)} và ${q(m.inboxDetail.journal)} với ${q(m.inboxDetail.original)}. Muốn đổi tài khoản, chọn lại ở cột ${q(m.inboxDetail.debitAccount)} rồi bấm ${q(m.inboxDetail.saveEdit)}.`,
        `Nút ${q(m.inboxDetail.approve)} bị mờ khi còn chỉnh sửa chưa lưu, hoặc khi có kiểm tra không đạt: đối chiếu chứng từ gốc rồi đánh dấu ô ${q(m.inboxDetail.acceptFailed)} nếu vẫn muốn ghi sổ.`,
        `Bấm ${q(m.inboxDetail.approve)}. {brand} có thể hỏi mã xác thực hai lớp: lần đầu, bấm ${q(m.twoFactor.enable)}, quét mã QR bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator...) rồi nhập mã 6 chữ số.`,
        'Nếu tổ chức có từ hai người duyệt trở lên, người đã tải lên hoặc chỉnh sửa đề xuất không tự duyệt được: một người khác phải duyệt.',
        `Hóa đơn sai thì bấm ${q(m.inboxDetail.reject)} (lý do không bắt buộc). Đề xuất đã duyệt chuyển sang tab ${q(m.inbox.tabs.executed)}; chứng từ hiện ở ${q(m.nav.documents)}, người bán ở ${q(m.nav.vendors)}.`,
      ],
    },
    {
      id: 'vat',
      title: 'Bước 2. Khai thuế GTGT của tháng',
      items: [
        `Một lần duy nhất: mở ${q(m.nav.settings)}, chọn ${q(m.settings.vatFilingPeriod)} (${q(m.settings.vatFilingMonth)} hoặc ${q(m.settings.vatFilingQuarter)}) để {brand} nhắc hạn nộp tờ khai, và kiểm tra ${q(m.settings.taxCode)} đã đúng.`,
        `Khi đã duyệt xong hóa đơn của kỳ, mở ${q(m.nav.vat)}, chọn kỳ, xem bảng kê và các chỉ tiêu 01/GTGT.`,
        `Bấm ${q(m.vat.export)} để gửi bảng kê cho kế toán, hoặc ${q(m.vat.exportXml)} để có tệp XML mở trong HTKK.`,
        'Tệp XML để 0 ở các chỉ tiêu {brand} chưa tính được, trong đó có [25] thuế được khấu trừ: kế toán bổ sung và kiểm tra trong HTKK hoặc trên eTax trước khi nộp.',
        `Khi đã nộp tờ khai, mở ${q(m.nav.ledger)}, thẻ ${q(m.ledger.tabs.closing)}, và bấm nút khóa sổ của tháng cần khóa (${q(fill(m.periodLock.lock, { month: 'MM/YYYY' }))}, với MM/YYYY là tháng đó) ở ô ${q(m.periodLock.title)}: không ai ghi, duyệt hay đảo bút toán vào tháng đó được nữa. Chủ sở hữu hoặc quản trị khóa sổ; chỉ chủ sở hữu mở khóa được, kèm lý do.`,
      ],
    },
    {
      id: 'export',
      title: 'Bước 3. Xuất Excel cho kế toán',
      items: [
        `Mở ${q(m.nav.journal)} trong menu.`,
        `Chọn ${q(m.journal.from)} và ${q(m.journal.to)} nếu chỉ cần một khoảng thời gian; để trống để xuất tất cả.`,
        `Bấm ${q(m.journal.export)}. Tệp {brandSlug}-but-toan-<mã tổ chức>.xlsx ghi từng dòng Nợ/Có, gửi thẳng cho kế toán.`,
      ],
    },
  ],
  en: (m) => [
    {
      id: 'upload',
      title: 'Step 1. Upload invoices and approve them',
      items: [
        `Open ${q(m.nav.inbox)} in the menu (on the left of the screen; on a phone, tap the ☰ button at the top to open the menu).`,
        `Click ${q(m.inbox.upload)}, or drag files onto ${q(m.inbox.dropHere)}. Each file can be up to 25 MB, you can pick several files at once (up to 500), or one ZIP file downloaded from the tax portal: {brand} opens the ZIP and reads each invoice.`,
        'An e-invoice XML file can always be read. A PDF or a photo can be read only when the server has AI set up; if it has not, the upload box tells you.',
        `If the server accepts email, you can forward invoice emails to the address in ${q(m.inbox.forwardTitle)} (click ${q(m.inbox.copyAddress)} to copy it).`,
        `A file you just sent shows under ${q(m.inbox.recentFiles)}: ${q(m.inbox.fileStatus.processing)}, then ${q(m.inbox.fileStatus.proposed)}. If a file shows ${q(m.inbox.fileStatus.failed)}, click ${q(m.inbox.reread)} when the button is there.`,
        `On the ${q(m.inbox.tabs.pending)} tab, click the seller's name to open the proposal. Compare the amount, ${q(m.inboxDetail.checks)} and ${q(m.inboxDetail.journal)} with ${q(m.inboxDetail.original)}. To change an account, pick another in the ${q(m.inboxDetail.debitAccount)} column and click ${q(m.inboxDetail.saveEdit)}.`,
        `${q(m.inboxDetail.approve)} is greyed out while a change is unsaved, or while a check has failed: compare with the original document, then tick ${q(m.inboxDetail.acceptFailed)} if you still want to post it.`,
        `Click ${q(m.inboxDetail.approve)}. {brand} may ask for a two-factor code: the first time, click ${q(m.twoFactor.enable)}, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator...) and enter the 6-digit code.`,
        'If the organization has two or more approvers, the person who uploaded or changed a proposal cannot approve it: someone else has to.',
        `If an invoice is wrong, click ${q(m.inboxDetail.reject)} (a reason is optional). An approved proposal moves to the ${q(m.inbox.tabs.executed)} tab; the document shows under ${q(m.nav.documents)} and the seller under ${q(m.nav.vendors)}.`,
      ],
    },
    {
      id: 'vat',
      title: 'Step 2. The VAT return of the month',
      items: [
        `Once only: open ${q(m.nav.settings)}, choose ${q(m.settings.vatFilingPeriod)} (${q(m.settings.vatFilingMonth)} or ${q(m.settings.vatFilingQuarter)}) so {brand} reminds you of the filing deadline, and check that ${q(m.settings.taxCode)} is right.`,
        `Once the invoices of the period are approved, open ${q(m.nav.vat)}, pick the period, and look at the listing and the 01/GTGT lines.`,
        `Click ${q(m.vat.export)} to send the listing to your accountant, or ${q(m.vat.exportXml)} to get an XML file you open in HTKK.`,
        'The XML file leaves 0 on the lines {brand} cannot work out yet, including [25] deductible tax: your accountant adds them and checks the file in HTKK or on eTax before filing.',
        `After you have filed, open ${q(m.nav.ledger)}, the ${q(m.ledger.tabs.closing)} tab, and click the lock button of the month you want to close (${q(fill(m.periodLock.lock, { month: 'MM/YYYY' }))}, with MM/YYYY being that month) in ${q(m.periodLock.title)}: nobody can post, approve or reverse an entry in that month any more. An owner or admin locks the period; only an owner can unlock it, with a reason.`,
      ],
    },
    {
      id: 'export',
      title: 'Step 3. Export to Excel for your accountant',
      items: [
        `Open ${q(m.nav.journal)} in the menu.`,
        `Pick ${q(m.journal.from)} and ${q(m.journal.to)} if you only need a period; leave them empty to export everything.`,
        `Click ${q(m.journal.export)}. The file {brandSlug}-but-toan-<organization code>.xlsx lists every debit and credit line; send it straight to your accountant.`,
      ],
    },
  ],
};

// The guide in a language with the product name filled in (BRAND_NAME, issue #1040): the text above, and the labels it
// quotes, say {brand}.
export function quickGuide(brand: string = brandName(), locale: Locale = DEFAULT_LOCALE): readonly QuickGuideStep[] {
  return buildGuide(QUICK_GUIDE, brand, locale);
}
