// SPDX-License-Identifier: AGPL-3.0-only
// Excel export of S1a-HKD (#2517, Circular 152/2025/TT-BTC Art. 6), the sales listing of a household of group 1: the household's name and tax code, the title of the book, the period and the day
// the books were opened, the table (date, document, description, amount), a total row and a place for the representative's signature. The layout is the form as commonly published; the accountant
// checks it against the appendix of the circular (#2520), and the file says so while the book's row is still `commentary`. Same cell rules as the other exports (export.ts): amounts exact,
// text never read as a formula. Labels stay Vietnamese in every locale.
import ExcelJS from 'exceljs';
import type { HouseholdCnkd, HouseholdS1a } from '@crove/kernel-contract';
import { setMoneyCell, setTextCell } from './export.ts';

const dateLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator.
export async function buildS1aWorkbook(book: HouseholdS1a, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${book.form.name} ${dateLabel(book.period.from)} - ${dateLabel(book.period.to)} ${book.household.name}`;
  const sheet = workbook.addWorksheet('S1a-HKD');
  sheet.columns = [
    { key: 'date', width: 16 },
    { key: 'reference', width: 22 },
    { key: 'description', width: 56 },
    { key: 'amount', width: 22 },
  ];
  const line = (text: string, bold = false) => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell(1), text);
    if (bold) row.font = { bold: true };
    return row;
  };
  line(`HỘ, CÁ NHÂN KINH DOANH: ${book.household.name}`, true);
  line(`Mã số thuế: ${book.household.taxCode ?? ''}`);
  line(book.form.name.toUpperCase(), true);
  line(`Kỳ: từ ${dateLabel(book.period.from)} đến ${dateLabel(book.period.to)}`);
  line(`Ngày mở sổ: ${dateLabel(book.household.openedOn)}`);
  sheet.addRow([]);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('date'), 'Ngày tháng ghi sổ');
  setTextCell(head.getCell('reference'), 'Chứng từ (số hiệu)');
  setTextCell(head.getCell('description'), 'Diễn giải');
  setTextCell(head.getCell('amount'), 'Số tiền');
  head.font = { bold: true };
  for (const r of book.rows) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('date'), dateLabel(r.date));
    setTextCell(row.getCell('reference'), r.reference);
    setTextCell(row.getCell('description'), r.reversal ? `${r.description} (bút toán đảo)` : r.description);
    setMoneyCell(row.getCell('amount'), r.amount);
  }
  const total = sheet.addRow([]);
  setTextCell(total.getCell('description'), 'Cộng');
  setMoneyCell(total.getCell('amount'), book.total);
  total.font = { bold: true };
  sheet.addRow([]);
  line('Người đại diện hộ kinh doanh', true);
  line('(Ký, họ tên)');
  sheet.addRow([]);
  line(book.household.representativeName ?? '');
  if (book.form.status !== 'confirmed') {
    sheet.addRow([]);
    line('Ghi chú: bố cục sổ đang chờ kế toán đối chiếu với phụ lục của Thông tư 152/2025/TT-BTC.');
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

// The labels of the trades as the return groups them; Vietnamese in every locale.
const TRADE_LABEL: Readonly<Record<string, string>> = {
  goods: 'Phân phối, cung cấp hàng hóa',
  services: 'Dịch vụ',
  catering: 'Ăn uống, sản xuất, xây dựng có bao thầu nguyên vật liệu',
  other: 'Hoạt động kinh doanh khác',
};

// Excel export of the 01/CNKD return worksheet (#2518): the household's name and tax code, the form and the quarter, revenue by trade with VAT and PIT by the percentages in force, the total, the tax the
// platforms already withheld (one line per settlement), what is left to pay (or paid too much) and a place for the representative's signature. It says on its face that it is a worksheet to file from
// through the tax portal or eTax Mobile, that Ludy files nothing, and that the exempt band of the year is not deducted (the rule is unconfirmed, #2520). The query refuses the ask while a row behind the
// figures is `commentary` or revenue is unassigned, so the totals here are always whole. Same cell rules as the other exports.
export async function buildCnkdWorkbook(sheetData: HouseholdCnkd, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${sheetData.form.name} quý ${sheetData.period.quarter}/${sheetData.period.year} ${sheetData.household.name}`;
  const sheet = workbook.addWorksheet('01-CNKD');
  sheet.columns = [
    { key: 'trade', width: 52 },
    { key: 'revenue', width: 22 },
    { key: 'vatPercent', width: 14 },
    { key: 'vat', width: 20 },
    { key: 'pitPercent', width: 14 },
    { key: 'pit', width: 20 },
  ];
  const line = (text: string, bold = false) => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell(1), text);
    if (bold) row.font = { bold: true };
    return row;
  };
  line(`HỘ, CÁ NHÂN KINH DOANH: ${sheetData.household.name}`, true);
  line(`Mã số thuế: ${sheetData.household.taxCode ?? ''}`);
  line(`BẢNG TÍNH TỜ KHAI ${sheetData.form.name.toUpperCase()}`, true);
  line(`Phiên bản mẫu: ${sheetData.form.version}`);
  line(`Kỳ tính thuế: quý ${sheetData.period.quarter} năm ${sheetData.period.year} (từ ${dateLabel(sheetData.period.from)} đến ${dateLabel(sheetData.period.to)})`);
  line('Đây là bảng tính để kê khai trên cổng thuế hoặc eTax Mobile. Ludy không nộp tờ khai và không gửi dữ liệu cho cơ quan thuế.');
  sheet.addRow([]);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('trade'), 'Ngành nghề');
  setTextCell(head.getCell('revenue'), 'Doanh thu');
  setTextCell(head.getCell('vatPercent'), 'Tỷ lệ GTGT (%)');
  setTextCell(head.getCell('vat'), 'Thuế GTGT');
  setTextCell(head.getCell('pitPercent'), 'Tỷ lệ TNCN (%)');
  setTextCell(head.getCell('pit'), 'Thuế TNCN');
  head.font = { bold: true };
  for (const l of sheetData.lines) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('trade'), TRADE_LABEL[l.trade] ?? l.trade);
    setMoneyCell(row.getCell('revenue'), l.revenue);
    setTextCell(row.getCell('vatPercent'), l.vatPercent);
    setMoneyCell(row.getCell('vat'), l.vat);
    setTextCell(row.getCell('pitPercent'), l.pitPercent);
    setMoneyCell(row.getCell('pit'), l.pit);
  }
  const totals = sheetData.totals;
  const total = sheet.addRow([]);
  setTextCell(total.getCell('trade'), 'Cộng');
  setMoneyCell(total.getCell('revenue'), totals?.revenue ?? sheetData.revenue);
  setMoneyCell(total.getCell('vat'), totals?.vat ?? '0');
  setMoneyCell(total.getCell('pit'), totals?.pit ?? '0');
  total.font = { bold: true };
  sheet.addRow([]);
  const money = (label: string, value: string, bold = false) => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('trade'), label);
    setMoneyCell(row.getCell('revenue'), value);
    if (bold) row.font = { bold: true };
  };
  money('Tổng thuế GTGT và TNCN theo tỷ lệ', totals?.tax ?? '0');
  line('Thuế sàn thương mại điện tử đã khấu trừ và nộp thay (theo từng kỳ đối soát):', true);
  for (const w of sheetData.withheld.settlements) money(`  ${w.platform}, ${dateLabel(w.periodStart)} - ${dateLabel(w.periodEnd)}`, w.taxWithheld);
  money('Cộng thuế đã khấu trừ', sheetData.withheld.total);
  money('Số thuế còn phải nộp', sheetData.due ?? '0', true);
  if (sheetData.overpaid && sheetData.overpaid !== '0') money('Số thuế đã khấu trừ vượt số phải nộp', sheetData.overpaid);
  sheet.addRow([]);
  line('Người đại diện hộ kinh doanh', true);
  line('(Ký, họ tên)');
  sheet.addRow([]);
  line(sheetData.household.representativeName ?? '');
  sheet.addRow([]);
  line('Ghi chú: chưa trừ phần doanh thu được miễn thuế trong năm; kế toán đối chiếu với quy định hiện hành (#2520).');
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
