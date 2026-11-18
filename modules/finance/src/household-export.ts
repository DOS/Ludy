// SPDX-License-Identifier: AGPL-3.0-only
// Excel export of S1a-HKD (#2517, Circular 152/2025/TT-BTC Art. 6), the sales listing of a household of group 1: the household's name and tax code, the title of the book, the period and the day
// the books were opened, the table (date, document, description, amount), a total row and a place for the representative's signature. The layout is the form as commonly published; the accountant
// checks it against the appendix of the circular (#2520), and the file says so while the book's row is still `commentary`. Same cell rules as the other exports (export.ts): amounts exact,
// text never read as a formula. Labels stay Vietnamese in every locale.
import ExcelJS from 'exceljs';
import { HOUSEHOLD_PROVISIONAL_LABEL, type HouseholdCnkd, type HouseholdS1a, type HouseholdS2a, type HouseholdS2b, type HouseholdS2c } from '@crove/kernel-contract';
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
    for (const u of sheetData.unconfirmed) line(u.kind === 'form' ? `  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}` : `  Chưa xác nhận: tỷ lệ thuế của ngành "${TRADE_LABEL[u.key] ?? u.key}", từ ${dateLabel(u.effectiveFrom)}`);
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
  money('Tổng thuế GTGT và TNCN theo tỷ lệ', totals?.tax ?? '0', false, true);
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
  line('Ghi chú: chưa trừ phần doanh thu được miễn thuế trong năm; kế toán đối chiếu với quy định hiện hành (#2520).');
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
    for (const u of book.unconfirmed) line(u.kind === 'form' ? `  Chưa xác nhận: mẫu ${u.key}, hiệu lực từ ${dateLabel(u.effectiveFrom)}` : `  Chưa xác nhận: tỷ lệ thuế của ngành "${TRADE_LABEL[u.key] ?? u.key}", từ ${dateLabel(u.effectiveFrom)}`);
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
  if (opts.pit) {
    perLine('Tỷ lệ thuế TNCN (%)', (l) => l.pitPercent ?? '', undefined, 'text');
    perLine('Thuế TNCN', (l) => l.pit ?? '0', book.totals?.pit, 'money');
  }
  const tax = sheet.addRow([]);
  setTextCell(tax.getCell('description'), opts.pit ? 'Tổng thuế GTGT và TNCN' : 'Tổng thuế GTGT');
  // No total while revenue has no business line yet: the cell stays blank, never a 0 that does not exist.
  if (book.totals) setMoneyCell(tax.getCell('total'), (opts.pit ? book.totals.tax : book.totals.vat) ?? '0');
  mark(tax);
  tax.font = { bold: true };
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
