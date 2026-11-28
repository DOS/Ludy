// SPDX-License-Identifier: AGPL-3.0-only
// Excel export of S1a-HKD (#2517, Circular 152/2025/TT-BTC Art. 6), the sales listing of a household of group 1: the household's name and tax code, the title of the book, the period and the day
// the books were opened, the table (date, document, description, amount), a total row and a place for the representative's signature. The layout is the form as commonly published; the accountant
// checks it against the appendix of the circular (#2520), and the file says so while the book's row is still `commentary`. Same cell rules as the other exports (export.ts): amounts exact,
// text never read as a formula. Labels stay Vietnamese in every locale.
import ExcelJS from 'exceljs';
import { HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL, HOUSEHOLD_PROVISIONAL_LABEL, type HouseholdCnkd, type HouseholdQtt, type HouseholdS1a, type HouseholdS2a, type HouseholdS2b, type HouseholdS2c, type HouseholdS2d, type HouseholdS2e, type HouseholdYearToDate } from '@ludy/kernel-contract';
import { money as decimal, toMoney } from '@ludy/l10n-vn';
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
  digital_content: 'Nội dung số (trò chơi, phim, ảnh, nhạc, quảng cáo số)',
  other: 'Hoạt động kinh doanh khác',
};

// The line that names a row behind the figures which the accountant has not confirmed (#2520).
function unconfirmedLine(u: { kind: 'form' | 'rate' | 'reduction' | 'threshold'; key: string; effectiveFrom: string }): string {
  if (u.kind === 'form') return `  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}`;
  if (u.kind === 'threshold') return `  Chưa xác nhận: ngưỡng doanh thu năm, từ ${dateLabel(u.effectiveFrom)}`;
  if (u.kind === 'reduction') {
    return u.key === 'pit'
      ? `  Chưa xác nhận: mức giảm thuế TNCN theo Nghị định 398, từ ${dateLabel(u.effectiveFrom)}`
      : `  Chưa xác nhận: mức giảm thuế GTGT theo Nghị định 174, từ ${dateLabel(u.effectiveFrom)}`;
  }
  return `  Chưa xác nhận: tỷ lệ thuế của ngành "${TRADE_LABEL[u.key] ?? u.key}", từ ${dateLabel(u.effectiveFrom)}`;
}

// The yearly part of a household's tax (#3710 slice 3): the year's revenue to date, the threshold, and this period's tax by the yearly rule. `text` writes a sentence, `money` a labelled exact amount (the caller
// marks the amount rows while the book is provisional). The PIT is never guessed: while the household has not chosen the trade that takes the deduction the file asks, and writes no PIT figure.
function writeYearToDate(
  ytd: HouseholdYearToDate,
  pit: boolean,
  put: { text: (label: string, bold?: boolean) => void; money: (label: string, value: string) => void },
): void {
  put.text(`THUẾ THEO DOANH THU CẢ NĂM ${ytd.year}`, true);
  put.money('Doanh thu lũy kế từ đầu năm', ytd.revenueToDate);
  if (ytd.threshold) {
    put.money(`Ngưỡng doanh thu năm ${ytd.year} (từ ${dateLabel(ytd.threshold.effectiveFrom)}): ${ytd.crossed ? 'đã vượt' : 'chưa vượt'}`, ytd.threshold.amount);
  }
  if (!ytd.crossed) put.text(`Doanh thu lũy kế của năm chưa vượt ngưỡng nên chưa phải nộp thuế GTGT${pit ? ' và thuế TNCN' : ''}.`);
  if (ytd.deductionNeeded && pit) {
    put.text('Hộ có nhiều ngành nghề: hãy chọn ngành nghề được trừ phần doanh thu dưới ngưỡng để tính thuế TNCN. Chưa chọn nên chưa tính thuế TNCN.');
    return;
  }
  if (ytd.deductionShort && pit) {
    put.text(`Chưa ngành nghề nào có doanh thu đạt ngưỡng ${ytd.threshold?.amount ?? ''} đồng nên thuế TNCN tạm giữ lại: quy định cho trường hợp này đang chờ kế toán xác nhận. Thuế của kỳ chưa được tính.`);
    return;
  }
  const pay = ytd.payable;
  if (!pay) {
    put.text('Doanh thu của năm chưa được gán hết cho ngành nghề nên chưa tính thuế phải nộp theo doanh thu cả năm; gán ngành cho mặt hàng đã bán rồi lập lại sổ.');
    return;
  }
  put.money('Thuế GTGT của kỳ theo doanh thu cả năm (trước giảm)', pay.vatBefore);
  if (decimal(pay.vatCut).gt(0)) put.money('Giảm thuế GTGT theo Nghị định 174', pay.vatCut);
  put.money('Thuế GTGT phải nộp của kỳ', pay.vat);
  if (pit) {
    put.money('Thuế TNCN của kỳ theo doanh thu cả năm (trước giảm)', pay.pitBefore);
    if (ytd.pitCut?.applied) put.money(`Giảm thuế TNCN ${ytd.pitCut.percent}% theo Nghị định 398`, pay.pitCut);
    put.money('Thuế TNCN phải nộp của kỳ', pay.pit);
  }
}

// Excel export of the 01/CNKD return worksheet (#2518): the household's name and tax code, the form and the quarter, revenue by trade with VAT and PIT by the percentages in force, the total, the tax the
// platforms already withheld (one line per settlement), what is left to pay (or paid too much) and a place for the representative's signature. It says on its face that it is a worksheet to file from
// through the tax portal or eTax Mobile, that Ludy files nothing, and that the exempt band of the year is not deducted (the rule is unconfirmed, #2520). While a row behind the figures is `commentary`
// (the accountant has not confirmed it) the file says so on top, lists the rows, and puts HOUSEHOLD_PROVISIONAL_LABEL in a note column on every figure that depends on them (each trade, the total, the tax, what
// is left to pay); the tax the platforms withheld comes from the settlements and is not labelled. The label is data: it is gone once the rows are confirmed. The query refuses the ask only while revenue is
// unassigned, so the totals here are always whole. Same cell rules as the other exports.
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
    { key: 'note', width: 46 },
  ];
  const provisional = sheetData.commentary;
  // The label on a figure's row, only while the rows behind it are unconfirmed.
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_PROVISIONAL_LABEL);
  };
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
  if (provisional) {
    line(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of sheetData.unconfirmed) line(unconfirmedLine(u));
  }
  sheet.addRow([]);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('trade'), 'Ngành nghề');
  setTextCell(head.getCell('revenue'), 'Doanh thu');
  setTextCell(head.getCell('vatPercent'), 'Tỷ lệ GTGT (%)');
  setTextCell(head.getCell('vat'), 'Thuế GTGT');
  setTextCell(head.getCell('pitPercent'), 'Tỷ lệ TNCN (%)');
  setTextCell(head.getCell('pit'), 'Thuế TNCN');
  if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
  head.font = { bold: true };
  for (const l of sheetData.lines) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('trade'), TRADE_LABEL[l.trade] ?? l.trade);
    setMoneyCell(row.getCell('revenue'), l.revenue);
    setTextCell(row.getCell('vatPercent'), l.vatPercent);
    setMoneyCell(row.getCell('vat'), l.vat);
    setTextCell(row.getCell('pitPercent'), l.pitPercent);
    setMoneyCell(row.getCell('pit'), l.pit);
    mark(row);
  }
  const totals = sheetData.totals;
  const total = sheet.addRow([]);
  setTextCell(total.getCell('trade'), 'Cộng');
  setMoneyCell(total.getCell('revenue'), totals?.revenue ?? sheetData.revenue);
  setMoneyCell(total.getCell('vat'), totals?.vat ?? '0');
  setMoneyCell(total.getCell('pit'), totals?.pit ?? '0');
  mark(total);
  total.font = { bold: true };
  sheet.addRow([]);
  const money = (label: string, value: string, bold = false, labelled = false) => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('trade'), label);
    setMoneyCell(row.getCell('revenue'), value);
    if (labelled) mark(row);
    if (bold) row.font = { bold: true };
  };
  money('Tổng thuế GTGT và TNCN theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm', totals?.tax ?? '0', false, true);
  // The Decree 174 VAT cut, only where the household's profile answered yes (#3710): the cut and the tax after it. With no answer, the file says what the VAT would be if the household were eligible.
  const cut = sheetData.vatCut;
  if (cut.applied && cut.total) {
    money(`Giảm thuế GTGT ${cut.percent}% theo Nghị định 174 (theo tỷ lệ của kỳ, tham khảo)`, cut.total.cut, false, true);
    money('Tổng thuế GTGT và TNCN sau giảm, theo tỷ lệ trên doanh thu của kỳ, chưa xét ngưỡng năm', toMoney(decimal(cut.total.vatPayable).plus(totals?.pit ?? '0')), false, true);
  }
  if (cut.ifEligible) line(`Chưa trả lời câu hỏi giảm thuế GTGT (Nghị định 174) trong hồ sơ: nếu thuộc diện được giảm, thuế GTGT sẽ là ${cut.ifEligible.vatPayable} đồng (giảm ${cut.ifEligible.cut} đồng), tính theo tỷ lệ của kỳ để tham khảo; thuế phải nộp theo quy tắc doanh thu cả năm.`);
  sheet.addRow([]);
  writeYearToDate(sheetData.yearToDate, true, {
    text: (label, bold) => void line(label, bold),
    money: (label, value) => money(label, value, false, true),
  });
  sheet.addRow([]);
  line('Thuế sàn thương mại điện tử đã khấu trừ và nộp thay (theo từng kỳ đối soát):', true);
  for (const w of sheetData.withheld.settlements) money(`  ${w.platform}, ${dateLabel(w.periodStart)} - ${dateLabel(w.periodEnd)}`, w.taxWithheld);
  money('Cộng thuế đã khấu trừ', sheetData.withheld.total);
  money('Số thuế còn phải nộp', sheetData.due ?? '0', true, true);
  if (sheetData.overpaid && sheetData.overpaid !== '0') money('Số thuế đã khấu trừ vượt số phải nộp', sheetData.overpaid, false, true);
  sheet.addRow([]);
  line('Người đại diện hộ kinh doanh', true);
  line('(Ký, họ tên)');
  sheet.addRow([]);
  line(sheetData.household.representativeName ?? '');
  sheet.addRow([]);
  line('Ghi chú: phần doanh thu được trừ theo ngưỡng được tính ở mục thuế theo doanh thu cả năm, từ doanh thu lũy kế từ đầu năm; Ludy không nộp tờ khai thay hộ kinh doanh.');
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

// Excel export of the 02/CNKD-TNCN-QTT annual finalization worksheet (#5285): the household's name and tax code, the form and the year, the lines [09] to [20] with their codes (the form's own labels), the rate
// band, the 30% PIT cut of Decree 398 before and after (the form has no line for it, so the lines above are BEFORE it), what the household had to type and did not, a place for the representative's signature. It
// says on its face that it is a worksheet to file from through the tax portal or eTax Mobile and that Ludy files nothing. While a row behind the figures is `commentary` the file says so on top, lists the rows,
// and puts HOUSEHOLD_PROVISIONAL_LABEL in a note column on every line that depends on them. The query refuses the ask while anything is held (forExport), so the figures here are always whole. Same cell rules
// as the other exports (exact amounts, text never a formula).
const QTT_RULE_LINES = new Set(['10', '10a', '10b', '10c', '10d', '10đ', '10e', '11', '12', '13', '17', '18', '19', '20']);
// The notes, with the product name users see (BRAND_NAME, #1045) where one speaks.
const qttNotes = (brand: string): Readonly<Record<HouseholdQtt['notes'][number], string>> => ({
  withheld_not_entered: 'Chưa nhập thuế sàn đã khấu trừ [14], nên số tính là 0.',
  prepaid_not_entered: 'Chưa nhập thuế đã tạm nộp trong năm [15], nên số tính là 0.',
  costs_not_checked: `${brand} chưa kiểm tra khoản chi nào có được trừ hay không; kế toán cần xem lại từng khoản.`,
  year_not_ended: 'Năm chưa kết thúc nên các số còn thay đổi.',
  reduction_not_in_form: 'Tờ khai không có dòng cho khoản giảm thuế; các dòng [13] đến [20] là số trước khi giảm.',
});
function qttUnconfirmedLine(u: HouseholdQtt['unconfirmed'][number]): string {
  const from = dateLabel(u.effectiveFrom);
  if (u.kind === 'form') return `  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${from}`;
  if (u.kind === 'threshold') return `  Chưa xác nhận: ngưỡng doanh thu năm, từ ${from}`;
  if (u.kind === 'reduction') return `  Chưa xác nhận: mức giảm thuế TNCN theo Nghị định 398, từ ${from}`;
  if (u.kind === 'rate') return `  Chưa xác nhận: thuế suất ${u.key} của bậc doanh thu, từ ${from}`;
  return `  Chưa xác nhận: nhóm chi phí của tài khoản ${u.key}, từ ${from}`;
}
export async function buildQttWorkbook(sheetData: HouseholdQtt, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${sheetData.form.name} năm ${sheetData.period.year} ${sheetData.household.name}`;
  const sheet = workbook.addWorksheet('02-CNKD-TNCN-QTT');
  sheet.columns = [
    { key: 'code', width: 10 },
    { key: 'label', width: 84 },
    { key: 'amount', width: 24 },
    { key: 'after', width: 24 },
    { key: 'note', width: 46 },
  ];
  const provisional = sheetData.commentary;
  const notes = qttNotes(brand);
  // The label on a figure's row, only while the rows behind it are unconfirmed.
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_PROVISIONAL_LABEL);
  };
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
  line(`Kỳ tính thuế: năm ${sheetData.period.year} (từ ${dateLabel(sheetData.period.from)} đến ${dateLabel(sheetData.period.to)})`);
  line(`Đây là bảng tính để kê khai trên cổng thuế hoặc eTax Mobile. ${brand} không nộp tờ khai và không gửi dữ liệu cho cơ quan thuế.`);
  if (provisional) {
    line(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of sheetData.unconfirmed) line(qttUnconfirmedLine(u));
  }
  sheet.addRow([]);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('code'), 'Chỉ tiêu');
  setTextCell(head.getCell('label'), 'Nội dung');
  setTextCell(head.getCell('amount'), 'Số tiền');
  if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
  head.font = { bold: true };
  for (const l of sheetData.lines) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('code'), `[${l.code}]`);
    setTextCell(row.getCell('label'), l.label);
    // The rate is a percentage, never money; a held line (the query refuses the file while anything is held) would say so rather than show a figure.
    if (l.amount === null) setTextCell(row.getCell('amount'), 'Tạm giữ');
    else if (l.code === '12') setTextCell(row.getCell('amount'), `${l.amount}%`);
    else setMoneyCell(row.getCell('amount'), l.amount);
    if (QTT_RULE_LINES.has(l.code) && l.amount !== null) mark(row);
  }
  if (sheetData.rate) line(`Thuế suất [12] là ${sheetData.rate.percent}% (bậc doanh thu trên ${sheetData.rate.revenueOver} đồng)`);
  const reduction = sheetData.reduction;
  if (reduction) {
    sheet.addRow([]);
    line(`Giảm ${reduction.percent}% thuế thu nhập cá nhân (Nghị định 398/2026): số trước và sau khi giảm`, true);
    line('Tờ khai không có dòng cho khoản giảm này, nên các dòng [13] đến [20] ở trên là số TRƯỚC khi giảm. Cách khai khoản giảm đang chờ kế toán xác nhận.');
    if (!reduction.applies) line(`Doanh thu năm vượt ${reduction.ceiling ?? ''} đồng nên không được giảm.`);
    const memoHead = sheet.addRow([]);
    setTextCell(memoHead.getCell('label'), 'Khoản');
    setTextCell(memoHead.getCell('amount'), 'Trước khi giảm');
    setTextCell(memoHead.getCell('after'), 'Sau khi giảm');
    memoHead.font = { bold: true };
    const rows: Array<[string, 'tax' | 'cut' | 'payable' | 'exempt' | 'due' | 'overpaid']> = [
      ['Thuế phát sinh [13]', 'tax'],
      ['Số được giảm', 'cut'],
      ['Còn phải nộp [17]', 'payable'],
      ['Miễn từ 50.000 đồng trở xuống [18]', 'exempt'],
      ['Còn phải nộp sau miễn [19]', 'due'],
      ['Nộp thừa [20]', 'overpaid'],
    ];
    for (const [label, key] of rows) {
      const row = sheet.addRow([]);
      setTextCell(row.getCell('label'), label);
      setMoneyCell(row.getCell('amount'), key === 'cut' ? '0' : reduction.before[key]);
      setMoneyCell(row.getCell('after'), key === 'cut' ? reduction.cut : reduction.after[key]);
      mark(row);
    }
  }
  sheet.addRow([]);
  for (const note of sheetData.notes) {
    if (note === 'reduction_not_in_form' && reduction) continue;
    line(`Ghi chú: ${notes[note]}`);
  }
  sheet.addRow([]);
  line('Người đại diện hộ kinh doanh', true);
  line('(Ký, họ tên)');
  sheet.addRow([]);
  line(sheetData.household.representativeName ?? '');
  sheet.addRow([]);
  line(`${brand} không nộp tờ khai thay hộ kinh doanh.`);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

// Excel export of S2a-HKD (#2517 slice 2a, Circular 152/2025/TT-BTC), the revenue book of a household that pays a percentage of revenue: the household's name and tax code, the title and the period, the day
// the books were opened, one row per entry with its amount in the column of its business line (a column "Chưa phân ngành" appears only when something has no line yet), a total row, then per line the percentage
// and the VAT and PIT it gives, the total tax, and a place for the representative's signature. While a row behind the figures is `commentary` the file says so on top, lists the rows, and puts
// HOUSEHOLD_PROVISIONAL_LABEL in a note column on every figure that depends on them (the revenue and tax rows); the label is data and goes once the rows are confirmed. Ludy files nothing: the book is for
// the household or its accountant. Same cell rules as the other exports (exact amounts, text never a formula).
// What S2a and S2b share in the file: the rows by business line, the VAT per line, and for S2a the PIT per line and the tax total. S2b (the income method) has no PIT, so its lines carry none.
type TradeBookView = Omit<HouseholdS2a, 'lines' | 'totals'> & {
  lines: Array<{ trade: HouseholdS2a['lines'][number]['trade']; revenue: string; vatPercent: string; vat: string; pitPercent?: string; pit?: string }>;
  totals: { revenue: string; vat: string; pit?: string; tax?: string } | null;
};

export async function buildS2aWorkbook(book: HouseholdS2a, brand = 'Ludy'): Promise<Uint8Array> {
  return buildTradeWorkbook(book, brand, { sheet: 'S2a-HKD', pit: true });
}

export async function buildS2bWorkbook(book: HouseholdS2b, brand = 'Ludy'): Promise<Uint8Array> {
  return buildTradeWorkbook(book, brand, { sheet: 'S2b-HKD', pit: false });
}

async function buildTradeWorkbook(book: TradeBookView, brand: string, opts: { sheet: string; pit: boolean }): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${book.form.name} ${dateLabel(book.period.from)} - ${dateLabel(book.period.to)} ${book.household.name}`;
  const sheet = workbook.addWorksheet(opts.sheet);
  const lineKeys = book.lines.map((l) => l.trade);
  // The column exists whenever any entry has a part there (a sale and its void both unassigned net to zero, but each row still writes its part).
  const hasUnassigned = book.rows.some((r) => r.parts.some((p) => p.trade === 'unassigned'));
  const columnKeys: string[] = ['date', 'reference', 'description', ...lineKeys.map((t) => `t_${t}`), ...(hasUnassigned ? ['t_unassigned'] : []), 'total', 'note'];
  sheet.columns = columnKeys.map((key) => ({ key, width: key === 'description' ? 48 : key === 'note' ? 46 : key === 'date' ? 16 : key === 'reference' ? 22 : 22 }));
  const provisional = book.commentary;
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_PROVISIONAL_LABEL);
  };
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
  line('Đây là sổ kế toán của hộ kinh doanh. Ludy không nộp tờ khai và không gửi dữ liệu cho cơ quan thuế.');
  if (provisional) {
    line(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of book.unconfirmed) line(unconfirmedLine(u));
  }
  sheet.addRow([]);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('date'), 'Ngày tháng ghi sổ');
  setTextCell(head.getCell('reference'), 'Chứng từ (số hiệu)');
  setTextCell(head.getCell('description'), 'Diễn giải');
  for (const t of lineKeys) setTextCell(head.getCell(`t_${t}`), TRADE_LABEL[t] ?? t);
  if (hasUnassigned) setTextCell(head.getCell('t_unassigned'), 'Chưa phân ngành');
  setTextCell(head.getCell('total'), 'Tổng số tiền');
  if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
  head.font = { bold: true };
  for (const r of book.rows) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('date'), dateLabel(r.date));
    setTextCell(row.getCell('reference'), r.reference);
    setTextCell(row.getCell('description'), r.reversal ? `${r.description} (bút toán đảo)` : r.description);
    for (const p of r.parts) setMoneyCell(row.getCell(`t_${p.trade}`), p.amount);
    setMoneyCell(row.getCell('total'), r.amount);
  }
  const total = sheet.addRow([]);
  setTextCell(total.getCell('description'), 'Cộng doanh thu');
  for (const l of book.lines) setMoneyCell(total.getCell(`t_${l.trade}`), l.revenue);
  if (hasUnassigned) setMoneyCell(total.getCell('t_unassigned'), book.unassigned);
  setMoneyCell(total.getCell('total'), book.total);
  mark(total);
  total.font = { bold: true };
  sheet.addRow([]);
  const perLine = (label: string, pick: (l: (typeof book.lines)[number]) => string, sumValue: string | undefined, kind: 'money' | 'text') => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('description'), label);
    for (const l of book.lines) (kind === 'money' ? setMoneyCell : setTextCell)(row.getCell(`t_${l.trade}`), pick(l));
    if (sumValue !== undefined) setMoneyCell(row.getCell('total'), sumValue);
    mark(row);
  };
  perLine('Tỷ lệ thuế GTGT (%)', (l) => l.vatPercent, undefined, 'text');
  perLine('Thuế GTGT', (l) => l.vat, book.totals?.vat, 'money');
  // The Decree 174 VAT cut, only where the household's profile answered yes (#3710).
  const cutOf = new Map(book.vatCut.lines.map((l) => [l.trade, l]));
  if (book.vatCut.applied) {
    perLine(`Giảm thuế GTGT ${book.vatCut.percent}% theo Nghị định 174 (theo tỷ lệ của kỳ, tham khảo)`, (l) => cutOf.get(l.trade)?.cut ?? '0', book.vatCut.total?.cut, 'money');
    perLine('Thuế GTGT sau giảm (tham khảo theo tỷ lệ của kỳ)', (l) => cutOf.get(l.trade)?.vatPayable ?? l.vat, book.vatCut.total?.vatPayable, 'money');
  }
  if (opts.pit) {
    perLine('Tỷ lệ thuế TNCN (%)', (l) => l.pitPercent ?? '', undefined, 'text');
    perLine('Thuế TNCN', (l) => l.pit ?? '0', book.totals?.pit, 'money');
  }
  const tax = sheet.addRow([]);
  setTextCell(tax.getCell('description'), `${opts.pit ? 'Tổng thuế GTGT và TNCN' : 'Tổng thuế GTGT'}${book.vatCut.applied ? ' sau giảm' : ''}`);
  // No total while revenue has no business line yet: the cell stays blank, never a 0 that does not exist.
  if (book.totals) {
    const before = (opts.pit ? book.totals.tax : book.totals.vat) ?? '0';
    // After the cut when it applies: the VAT payable (plus the PIT on S2a).
    setMoneyCell(tax.getCell('total'), book.vatCut.applied && book.vatCut.total ? toMoney(decimal(book.vatCut.total.vatPayable).plus(opts.pit ? (book.totals.pit ?? '0') : '0')) : before);
  }
  mark(tax);
  tax.font = { bold: true };
  if (book.vatCut.ifEligible) {
    sheet.addRow([]);
    line(`Chưa trả lời câu hỏi giảm thuế GTGT (Nghị định 174) trong hồ sơ: nếu thuộc diện được giảm, thuế GTGT sẽ là ${book.vatCut.ifEligible.vatPayable} đồng (giảm ${book.vatCut.ifEligible.cut} đồng), tính theo tỷ lệ của kỳ để tham khảo; thuế phải nộp theo quy tắc doanh thu cả năm.`);
  }
  sheet.addRow([]);
  writeYearToDate(book.yearToDate, opts.pit, {
    text: (label, bold) => void line(label, bold),
    money: (label, value) => {
      const row = sheet.addRow([]);
      setTextCell(row.getCell('description'), label);
      setMoneyCell(row.getCell('total'), value);
      mark(row);
    },
  });
  if (!book.totals) {
    sheet.addRow([]);
    line('Ghi chú: còn doanh thu chưa phân ngành nên chưa tính tổng thuế; gán ngành cho mặt hàng đã bán rồi lập lại sổ.');
  }
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

// The expense groups of Circular 152's S2c as the book names them; Vietnamese in every locale.
const GROUP_LABEL: Readonly<Record<string, string>> = {
  materials_goods: 'Nguyên liệu, vật liệu, hàng hóa',
  wages_insurance: 'Tiền lương, tiền công, bảo hiểm',
  depreciation: 'Khấu hao tài sản cố định',
  outside_services: 'Dịch vụ thuê ngoài',
  interest: 'Lãi vay',
  other: 'Chi phí khác',
};

// Excel export of S2c-HKD (#2517 slice 2b, Circular 152/2025/TT-BTC), the revenue and expense detail of a household that pays PIT on income: the household's name and tax code, the title and the period, the day the
// books were opened, the revenue rows and their total, the expense rows (date, document, description, account, group, amount) with a total per group, the expense no map row covers (own line, no guessed group), the
// total expense, the income (revenue less expense, blank with its reason while an expense line has no group), and a place for the representative's signature. While a row behind the figures is `commentary` the file says
// so on top, lists the rows, and puts HOUSEHOLD_PROVISIONAL_LABEL in a note column on every expense and income figure; the label is data and goes once the rows are confirmed. The PIT is not computed. Ludy files
// nothing. Same cell rules as the other exports (exact amounts, text never a formula).
export async function buildS2cWorkbook(book: HouseholdS2c, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${book.form.name} ${dateLabel(book.period.from)} - ${dateLabel(book.period.to)} ${book.household.name}`;
  const sheet = workbook.addWorksheet('S2c-HKD');
  sheet.columns = [
    { key: 'date', width: 16 },
    { key: 'reference', width: 22 },
    { key: 'description', width: 48 },
    { key: 'account', width: 12 },
    { key: 'group', width: 34 },
    { key: 'amount', width: 22 },
    { key: 'note', width: 46 },
  ];
  const provisional = book.commentary;
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_PROVISIONAL_LABEL);
  };
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
  line('Đây là sổ kế toán của hộ kinh doanh. Ludy không nộp tờ khai, không gửi dữ liệu cho cơ quan thuế và chưa tính thuế thu nhập cá nhân.');
  if (provisional) {
    line(HOUSEHOLD_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of book.unconfirmed) line(u.kind === 'form' ? `  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}` : `  Chưa xác nhận: nhóm chi phí của tài khoản ${u.key}, từ ${dateLabel(u.effectiveFrom)}`);
  }
  sheet.addRow([]);
  line('I. DOANH THU', true);
  const revenueHead = sheet.addRow([]);
  setTextCell(revenueHead.getCell('date'), 'Ngày tháng ghi sổ');
  setTextCell(revenueHead.getCell('reference'), 'Chứng từ (số hiệu)');
  setTextCell(revenueHead.getCell('description'), 'Diễn giải');
  setTextCell(revenueHead.getCell('amount'), 'Số tiền');
  revenueHead.font = { bold: true };
  for (const r of book.revenueRows) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('date'), dateLabel(r.date));
    setTextCell(row.getCell('reference'), r.reference);
    setTextCell(row.getCell('description'), r.reversal ? `${r.description} (bút toán đảo)` : r.description);
    setMoneyCell(row.getCell('amount'), r.amount);
  }
  const revenueTotal = sheet.addRow([]);
  setTextCell(revenueTotal.getCell('description'), 'Cộng doanh thu');
  setMoneyCell(revenueTotal.getCell('amount'), book.revenue);
  revenueTotal.font = { bold: true };
  sheet.addRow([]);
  line('II. CHI PHÍ', true);
  const head = sheet.addRow([]);
  setTextCell(head.getCell('date'), 'Ngày tháng ghi sổ');
  setTextCell(head.getCell('reference'), 'Chứng từ (số hiệu)');
  setTextCell(head.getCell('description'), 'Diễn giải');
  setTextCell(head.getCell('account'), 'Tài khoản');
  setTextCell(head.getCell('group'), 'Nhóm chi phí');
  setTextCell(head.getCell('amount'), 'Số tiền');
  if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
  head.font = { bold: true };
  for (const r of book.expenseRows) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('date'), dateLabel(r.date));
    setTextCell(row.getCell('reference'), r.reference);
    setTextCell(row.getCell('description'), r.reversal ? `${r.description} (bút toán đảo)` : r.description);
    setTextCell(row.getCell('account'), r.accountCode);
    setTextCell(row.getCell('group'), r.group === null ? 'Chưa xếp nhóm' : (GROUP_LABEL[r.group] ?? r.group));
    setMoneyCell(row.getCell('amount'), r.amount);
    // A line's group rests on a map row: labelled while that row is unconfirmed (the list on top says which); an unmapped line rests on no row.
    if (r.group !== null) mark(row);
  }
  sheet.addRow([]);
  line('Cộng chi phí theo nhóm', true);
  for (const g of book.groups) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('group'), GROUP_LABEL[g.group] ?? g.group);
    setMoneyCell(row.getCell('amount'), g.amount);
    mark(row);
  }
  if (!/^-?0+(\.0+)?$/.test(book.unmappedGross)) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('group'), 'Chưa xếp nhóm');
    setMoneyCell(row.getCell('amount'), book.unmapped);
  }
  const expenseTotal = sheet.addRow([]);
  setTextCell(expenseTotal.getCell('description'), 'Cộng chi phí');
  setMoneyCell(expenseTotal.getCell('amount'), book.expenseTotal);
  mark(expenseTotal);
  expenseTotal.font = { bold: true };
  const income = sheet.addRow([]);
  setTextCell(income.getCell('description'), 'Thu nhập (doanh thu trừ chi phí)');
  // Blank while an expense line has no group, never a figure built on a guess.
  if (book.income !== null) setMoneyCell(income.getCell('amount'), book.income);
  mark(income);
  income.font = { bold: true };
  if (book.income === null) {
    sheet.addRow([]);
    line('Ghi chú: còn chi phí chưa xếp nhóm (tài khoản chưa có dòng quy tắc nhóm) nên chưa tính thu nhập; kế toán bổ sung quy tắc rồi lập lại sổ.');
  }
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

// Excel export of S2e-HKD (#2517 slice 2e, Circular 152/2025/TT-BTC), the cash and bank book of a household that pays PIT on income: the household's name and tax code, the title and the period, the day the books
// were opened, then one section per account of 111 and 112 (opening balance, one row per line with the document, description, the accounts on the other side, cash in, cash out and the running balance, the totals and
// the closing balance), the total of all accounts and a place for the representative's signature. While the layout row is `commentary` the file says so on top and puts HOUSEHOLD_PROVISIONAL_LABEL in a note column
// on every figure; the label is data and goes once the row is confirmed. A negative balance is written as it is, with a note. Ludy files nothing. Same cell rules as the other exports (exact amounts, text never a formula).
export async function buildS2eWorkbook(book: HouseholdS2e, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${book.form.name} ${dateLabel(book.period.from)} - ${dateLabel(book.period.to)} ${book.household.name}`;
  const sheet = workbook.addWorksheet('S2e-HKD');
  sheet.columns = [
    { key: 'date', width: 16 },
    { key: 'reference', width: 22 },
    { key: 'description', width: 48 },
    { key: 'counter', width: 18 },
    { key: 'in', width: 20 },
    { key: 'out', width: 20 },
    { key: 'balance', width: 22 },
    { key: 'note', width: 46 },
  ];
  const provisional = book.commentary;
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL);
  };
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
  line('Đây là sổ kế toán của hộ kinh doanh. Ludy không nộp tờ khai và không gửi dữ liệu cho cơ quan thuế.');
  if (provisional) {
    line(HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of book.unconfirmed) line(`  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}`);
  }
  for (const a of book.accounts) {
    sheet.addRow([]);
    line(`Tài khoản ${a.accountCode}${a.accountName ? ` - ${a.accountName}` : ''}`, true);
    const head = sheet.addRow([]);
    setTextCell(head.getCell('date'), 'Ngày tháng ghi sổ');
    setTextCell(head.getCell('reference'), 'Chứng từ (số hiệu)');
    setTextCell(head.getCell('description'), 'Diễn giải');
    setTextCell(head.getCell('counter'), 'TK đối ứng');
    setTextCell(head.getCell('in'), 'Thu (nợ)');
    setTextCell(head.getCell('out'), 'Chi (có)');
    setTextCell(head.getCell('balance'), 'Tồn quỹ');
    if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
    head.font = { bold: true };
    const opening = sheet.addRow([]);
    setTextCell(opening.getCell('description'), 'Số dư đầu kỳ');
    setMoneyCell(opening.getCell('balance'), a.opening);
    mark(opening);
    for (const r of a.rows) {
      const row = sheet.addRow([]);
      setTextCell(row.getCell('date'), dateLabel(r.date));
      setTextCell(row.getCell('reference'), r.reference);
      setTextCell(row.getCell('description'), r.reversal ? `${r.description} (bút toán đảo)` : r.description);
      setTextCell(row.getCell('counter'), r.counterAccounts.join(', '));
      setMoneyCell(row.getCell('in'), r.cashIn);
      setMoneyCell(row.getCell('out'), r.cashOut);
      setMoneyCell(row.getCell('balance'), r.balance);
      mark(row);
    }
    const total = sheet.addRow([]);
    setTextCell(total.getCell('description'), 'Cộng phát sinh');
    setMoneyCell(total.getCell('in'), a.totalIn);
    setMoneyCell(total.getCell('out'), a.totalOut);
    total.font = { bold: true };
    const closing = sheet.addRow([]);
    setTextCell(closing.getCell('description'), 'Số dư cuối kỳ');
    setMoneyCell(closing.getCell('balance'), a.closing);
    if (a.negative) setTextCell(closing.getCell('note'), provisional ? `Số dư âm: kiểm tra các khoản thu chi chưa ghi sổ. ${HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL}` : 'Số dư âm: kiểm tra các khoản thu chi chưa ghi sổ');
    else mark(closing);
    closing.font = { bold: true };
  }
  if (book.accounts.length === 0) {
    sheet.addRow([]);
    line('Không có số dư hay phát sinh tiền mặt, tiền gửi ngân hàng trong kỳ này.');
  }
  sheet.addRow([]);
  line('Cộng tất cả tài khoản tiền', true);
  const all = sheet.addRow([]);
  setTextCell(all.getCell('description'), 'Số dư đầu kỳ, thu, chi, số dư cuối kỳ');
  setMoneyCell(all.getCell('in'), book.totals.in);
  setMoneyCell(all.getCell('out'), book.totals.out);
  setMoneyCell(all.getCell('balance'), book.totals.closing);
  mark(all);
  all.font = { bold: true };
  const openingAll = sheet.addRow([]);
  setTextCell(openingAll.getCell('description'), 'Số dư đầu kỳ của tất cả tài khoản');
  setMoneyCell(openingAll.getCell('balance'), book.totals.opening);
  mark(openingAll);
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

// The stock move sources as the book names them; Vietnamese in every locale.
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  document_line: 'Từ hóa đơn',
  manual: 'Nhập tay',
  reversal: 'Đảo',
  order_line: 'Từ đơn hàng sàn',
  count: 'Kiểm kê',
  crm_order_line: 'Giao hàng của đơn bán',
  sale_return: 'Hàng khách trả lại',
};

export async function buildS2dWorkbook(book: HouseholdS2d, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `${book.form.name} ${dateLabel(book.period.from)} - ${dateLabel(book.period.to)} ${book.household.name}`;
  const sheet = workbook.addWorksheet('S2d-HKD');
  sheet.columns = [
    { key: 'date', width: 16 },
    { key: 'reference', width: 22 },
    { key: 'description', width: 36 },
    { key: 'inQty', width: 16 },
    { key: 'outQty', width: 16 },
    { key: 'valueIn', width: 20 },
    { key: 'balance', width: 18 },
    { key: 'note', width: 46 },
  ];
  const provisional = book.commentary;
  const mark = (row: ExcelJS.Row) => {
    if (provisional) setTextCell(row.getCell('note'), HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL);
  };
  const line = (text: string, bold = false) => {
    const row = sheet.addRow([]);
    setTextCell(row.getCell(1), text);
    if (bold) row.font = { bold: true };
    return row;
  };
  line(`HỘ, CÁ NHÂN KINH DOANH: ${book.household.name}`, true);
  line(`Mã số thuế: ${book.household.taxCode ?? ''}`);
  line(book.form.name.toUpperCase(), true);
  line(`Tháng: từ ${dateLabel(book.period.from)} đến ${dateLabel(book.period.to)}`);
  line(`Ngày mở sổ: ${dateLabel(book.household.openedOn)}`);
  line('Đây là sổ kế toán của hộ kinh doanh. Ludy không nộp tờ khai và không gửi dữ liệu cho cơ quan thuế.');
  if (!book.monthClosed) line('Tháng này chưa chốt: giá vốn hàng xuất là số tạm tính theo bình quân tháng và có thể đổi khi chốt tháng.', true);
  if (provisional) {
    line(HOUSEHOLD_LAYOUT_PROVISIONAL_LABEL.toUpperCase(), true);
    for (const u of book.unconfirmed) line(`  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}`);
  }
  for (const item of book.items) {
    sheet.addRow([]);
    line(`${item.code} - ${item.name} (${item.unit})`, true);
    const head = sheet.addRow([]);
    setTextCell(head.getCell('date'), 'Ngày tháng ghi sổ');
    setTextCell(head.getCell('reference'), 'Chứng từ (số hiệu)');
    setTextCell(head.getCell('description'), 'Diễn giải');
    setTextCell(head.getCell('inQty'), 'Số lượng nhập');
    setTextCell(head.getCell('outQty'), 'Số lượng xuất');
    setTextCell(head.getCell('valueIn'), 'Giá trị nhập');
    setTextCell(head.getCell('balance'), 'Số lượng tồn');
    if (provisional) setTextCell(head.getCell('note'), 'Ghi chú');
    head.font = { bold: true };
    const opening = sheet.addRow([]);
    setTextCell(opening.getCell('description'), `Tồn đầu tháng (giá trị ${item.openingValue})`);
    setTextCell(opening.getCell('balance'), item.openingQuantity);
    mark(opening);
    for (const r of item.rows) {
      const row = sheet.addRow([]);
      setTextCell(row.getCell('date'), dateLabel(r.date));
      setTextCell(row.getCell('reference'), r.reference);
      setTextCell(row.getCell('description'), SOURCE_LABEL[r.source] ?? r.source);
      setTextCell(row.getCell('inQty'), r.quantityIn);
      setTextCell(row.getCell('outQty'), r.quantityOut);
      if (r.valueIn !== null) setMoneyCell(row.getCell('valueIn'), r.valueIn);
      setTextCell(row.getCell('balance'), r.balanceQuantity);
      mark(row);
    }
    const totals = sheet.addRow([]);
    setTextCell(totals.getCell('description'), `Cộng tháng: nhập ${item.inQuantity} (${item.inValue}), xuất ${item.outQuantity} (${item.outValue}), đơn giá bình quân ${item.unitCost ?? ''}`);
    setTextCell(totals.getCell('balance'), item.closingQuantity);
    totals.font = { bold: true };
    mark(totals);
    const closing = sheet.addRow([]);
    setTextCell(closing.getCell('description'), 'Giá trị tồn cuối tháng');
    setMoneyCell(closing.getCell('valueIn'), item.closingValue);
    closing.font = { bold: true };
    mark(closing);
  }
  if (book.items.length === 0) {
    sheet.addRow([]);
    line('Không có hàng tồn kho hay biến động kho trong tháng này.');
  }
  sheet.addRow([]);
  line('Cộng giá trị tất cả mặt hàng', true);
  for (const [label, value] of [['Giá trị tồn đầu tháng', book.totals.openingValue], ['Giá trị nhập', book.totals.inValue], ['Giá trị xuất', book.totals.outValue], ['Giá trị tồn cuối tháng', book.totals.closingValue]] as const) {
    const row = sheet.addRow([]);
    setTextCell(row.getCell('description'), label);
    setMoneyCell(row.getCell('valueIn'), value);
    mark(row);
  }
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
