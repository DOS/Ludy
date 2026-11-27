// Excel export of a period's VAT working (issue #316) for the accountant: a summary sheet with the form 01/GTGT
// indicators and the totals by rate, then one sheet per side listing each invoice by rate (one row per invoice and
// rate, as on a purchase or sales listing). Same cell rules as the journal export (export.ts): amounts exact through
// moneyCell, text never read as a formula. Headers and labels stay Vietnamese in every locale: the file goes to
// Vietnamese accountants and their software.
import ExcelJS from 'exceljs';
import { money } from '@ludy/l10n-vn';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';
import { addSideTotals, type VatRate } from './domain/vat-return.ts';
import type { VatInvoiceView, VatReport, VatSide, VatWarning } from './vat.ts';

export const VAT_RATE_LABELS: Readonly<Record<VatRate, string>> = {
  '0': '0%',
  '5': '5%',
  '8': '8%',
  '10': '10%',
  KCT: 'Không chịu thuế',
  KKKNT: 'Không kê khai, tính nộp thuế',
  other: 'Chưa rõ thuế suất',
};

export const VAT_WARNING_LABELS: Readonly<Record<VatWarning, string>> = {
  rate_unknown: 'Có dòng chưa rõ thuế suất',
  rate_split: 'Thuế GTGT chia theo thuế suất là số ước tính',
  reduced_rate_outside_period: 'Thuế suất 8% ngoài thời gian được giảm thuế',
  lines_mismatch: 'Tổng các dòng lệch tiền trước thuế của hóa đơn; số tổng cộng theo các dòng',
  vat_mismatch: 'Thuế GTGT lệch giá trị trước thuế nhân thuế suất',
  declared_late: 'Hóa đơn của kỳ trước, ghi sổ và kê khai vào kỳ này vì tháng của hóa đơn đã khóa sổ',
  late_sale: 'Hóa đơn lập sau kỳ của ngày bán (hóa đơn lập muộn): kê khai ở kỳ của ngày bán',
  check_payment: 'Đạt ngưỡng phải thanh toán không dùng tiền mặt mà chưa rõ đã thanh toán qua ngân hàng: kiểm tra chứng từ trước khi khấu trừ',
};

const noTaxCode = (brand: string) => `Chưa nhập mã số thuế của tổ chức nên ${brand} chưa nhận ra hóa đơn bán ra`;

function invoiceSheet(workbook: ExcelJS.Workbook, name: string, side: VatSide, partyHeader: string, taxCodeHeader: string, brand: string): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: 'STT', key: 'no', width: 6 },
    { header: 'Ngày hóa đơn', key: 'issueDate', width: 14 },
    { header: 'Ký hiệu HĐ', key: 'series', width: 12 },
    { header: 'Số HĐ', key: 'number', width: 12 },
    { header: taxCodeHeader, key: 'taxCode', width: 16 },
    { header: partyHeader, key: 'partyName', width: 36 },
    { header: 'Thuế suất', key: 'rate', width: 16 },
    { header: 'Giá trị chưa có thuế', key: 'taxable', width: 22 },
    { header: 'Thuế GTGT', key: 'vat', width: 20 },
    { header: 'Ghi chú', key: 'note', width: 40 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (!side.available) {
    const row = sheet.addRow([]);
    setText(row.getCell('partyName'), noTaxCode(brand));
    return;
  }
  side.documents.forEach((doc: VatInvoiceView, index) => {
    const parts = doc.saleDate ? [`Ngày bán ${doc.saleDate}`] : [];
    for (const w of doc.warnings) parts.push(VAT_WARNING_LABELS[w]);
    const note = parts.join('; ');
    for (const rate of doc.rates) {
      const row = sheet.addRow([]);
      row.getCell('no').value = index + 1;
      setText(row.getCell('issueDate'), doc.issueDate);
      setText(row.getCell('series'), doc.series);
      setText(row.getCell('number'), doc.number);
      setText(row.getCell('taxCode'), doc.partyTaxCode);
      setText(row.getCell('partyName'), doc.partyName);
      setText(row.getCell('rate'), VAT_RATE_LABELS[rate.rate]);
      setMoney(row.getCell('taxable'), rate.taxable);
      setMoney(row.getCell('vat'), rate.vat);
      setText(row.getCell('note'), note);
    }
  });
  const total = sheet.addRow([]);
  setText(total.getCell('partyName'), 'Tổng cộng');
  setMoney(total.getCell('taxable'), side.totals.taxable);
  setMoney(total.getCell('vat'), side.totals.vat);
  total.font = { bold: true };
}

function rateTotalsTable(summary: ExcelJS.Worksheet, title: string, side: Pick<VatSide, 'available' | 'totals'>, brand: string): void {
  summary.addRow([]);
  const head = summary.addRow([]);
  setText(head.getCell('label'), title);
  setText(head.getCell('taxable'), 'Giá trị chưa có thuế');
  setText(head.getCell('vat'), 'Thuế GTGT');
  head.font = { bold: true };
  for (const rate of side.totals.byRate) {
    const row = summary.addRow([]);
    setText(row.getCell('label'), VAT_RATE_LABELS[rate.rate]);
    setMoney(row.getCell('taxable'), rate.taxable);
    setMoney(row.getCell('vat'), rate.vat);
  }
  const total = summary.addRow([]);
  setText(total.getCell('label'), side.available ? `Tổng cộng (${side.totals.documents} hóa đơn)` : noTaxCode(brand));
  setMoney(total.getCell('taxable'), side.totals.taxable);
  setMoney(total.getCell('vat'), side.totals.vat);
  total.font = { bold: true };
}

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator and in its notes.
export async function buildVatWorkbook(report: VatReport, orgName: string, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `Tờ khai GTGT ${report.period.period} ${orgName}`;

  const summary = workbook.addWorksheet('Tổng hợp');
  summary.columns = [
    { key: 'code', width: 10 },
    { key: 'label', width: 70 },
    { key: 'taxable', width: 22 },
    { key: 'vat', width: 20 },
  ];
  const heading = summary.addRow([]);
  setText(heading.getCell('label'), `Kỳ ${report.period.period} (${report.period.from} đến ${report.period.to})`);
  heading.font = { bold: true };

  summary.addRow([]);
  const formHead = summary.addRow([]);
  setText(formHead.getCell('code'), 'Chỉ tiêu');
  setText(formHead.getCell('label'), 'Tờ khai 01/GTGT');
  setText(formHead.getCell('taxable'), 'Số tiền');
  formHead.font = { bold: true };
  for (const indicator of report.indicators) {
    const row = summary.addRow([]);
    setText(row.getCell('code'), `[${indicator.code}]`);
    setText(row.getCell('label'), indicator.label);
    setMoney(row.getCell('taxable'), indicator.amount);
  }
  const note = summary.addRow([]);
  setText(note.getCell('label'), 'Chỉ tiêu [25] (thuế GTGT được khấu trừ) do kế toán xác định; hàng hóa 8% kê khai thêm phụ lục giảm thuế GTGT.');
  // Sales at a rate Ludy cannot place are in the totals but in no indicator (issue #358).
  const otherSales = report.output.totals.byRate.find((r) => r.rate === 'other')?.taxable ?? '0';
  if (!money(otherSales).isZero()) {
    const row = summary.addRow([]);
    setText(row.getCell('label'), 'Doanh thu bán ra chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai');
    setMoney(row.getCell('taxable'), otherSales);
  }

  rateTotalsTable(summary, 'Hóa đơn bán ra theo thuế suất', report.output, brand);
  rateTotalsTable(summary, 'Hóa đơn mua vào theo thuế suất', report.input, brand);

  if (report.supplementary.documents.length > 0) {
    rateTotalsTable(summary, 'Hóa đơn bán ra cần kê khai bổ sung theo thuế suất', { available: true, totals: report.supplementary.totals }, brand);
    const combinedOutput = addSideTotals(report.output.totals, report.supplementary.totals);
    const combinedRow = summary.addRow([]);
    setText(combinedRow.getCell('label'), `Tổng bán ra sau bổ sung (${combinedOutput.documents} hóa đơn)`);
    setMoney(combinedRow.getCell('taxable'), combinedOutput.taxable);
    setMoney(combinedRow.getCell('vat'), combinedOutput.vat);
    combinedRow.font = { bold: true };
    const suppNote = summary.addRow([]);
    setText(
      suppNote.getCell('label'),
      'Các hóa đơn cần kê khai bổ sung nằm ngoài bảng kê bán ra và chỉ tiêu [26] đến [35] ở trên (kỳ đã khóa sổ hoặc đã nộp tờ khai); số tổng sau bổ sung dùng để đối chiếu khi lập tờ khai bổ sung.',
    );
    const otherSupplementary = report.supplementary.totals.byRate.find((r) => r.rate === 'other')?.taxable ?? '0';
    if (!money(otherSupplementary).isZero()) {
      const row = summary.addRow([]);
      setText(row.getCell('label'), 'Doanh thu bán ra cần kê khai bổ sung chưa rõ thuế suất, không nằm trong chỉ tiêu nào: kiểm tra các hóa đơn đó trước khi nộp tờ khai bổ sung');
      setMoney(row.getCell('taxable'), otherSupplementary);
    }
  }

  invoiceSheet(workbook, 'Bán ra', report.output, 'Tên người mua', 'MST người mua', brand);
  invoiceSheet(workbook, 'Mua vào', report.input, 'Tên người bán', 'MST người bán', brand);
  if (report.supplementary.documents.length > 0) {
    invoiceSheet(workbook, 'Kê khai bổ sung', { available: true, ...report.supplementary }, 'Tên người mua', 'MST người mua', brand);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
