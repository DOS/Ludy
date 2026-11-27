// Excel export of a period's financial statements (issue #154) for the accountant: B01-DNN at the period's last day
// and B02-DNN for the period, one sheet each, with the comparison columns of the screen (#2090): B01's start of year,
// and B02 for the same period of the previous year and, for a month or a quarter, for the period right before. A
// comparison that does not exist (before the year 2000) has no column. The line codes and the account mapping are a DRAFT nobody has verified
// (domain/tt133-reports.ts), so each sheet says so on its first line, and lists the balances no line reads. Same cell
// rules as the other exports (export.ts): amounts exact through moneyCell, text never read as a formula. Labels stay
// Vietnamese in every locale.
import ExcelJS from 'exceljs';
import { setMoneyCell as setMoney, setTextCell as setText } from './export.ts';
import { b01For } from './domain/tt99-reports.ts';
import type { ColumnAmounts, FinancialStatements, StatementLine, UnmappedRow } from './statements.ts';

export const DRAFT_NOTICE = 'BẢN NHÁP: mã chỉ tiêu và cách lấy số liệu từ tài khoản chưa được kế toán kiểm tra; không dùng để nộp.';
// B02 read under the TT99 chart (#5187): the line codes and the account map come from secondary sources, not the official text.
export const TT99_NOTICE = 'Kết quả hoạt động kinh doanh (B02) đọc theo hệ thống tài khoản Thông tư 99, mã chỉ tiêu lấy từ nguồn thứ cấp, chưa đối chiếu văn bản chính thức.';
// The fixed label of a TT99 B01 (#5204): every placement of an account on a line is Ludy's own, until the accountant confirms it (#61). It sits under the draft notice at the top of the sheet.
export const B01_TT99_DRAFT = 'Bản nháp, kế toán chưa xác nhận cách lập';
export const MIXED_CHARTS_NOTICE = 'Cảnh báo: kỳ này hoặc một cột so sánh có phần ghi sổ theo hệ thống tài khoản khác; mọi cột đọc theo hệ thống của ngày cuối kỳ nên số liệu có thể lệch.';

// A column beside the period's own: its heading, and the amount of each line by code (a line the column's period has no
// entries for reads 0).
interface ComparisonColumn {
  header: string;
  amounts: ColumnAmounts;
  // B01's two warnings for the column's date, and the balances of the column's period no line reads.
  balanced?: boolean;
  unmapped: number;
}

function statementSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  column: string,
  lines: readonly StatementLine[],
  unmapped: readonly UnmappedRow[],
  comparisons: readonly ComparisonColumn[] = [],
  // Fixed lines under the draft notice (the TT99 B01's draft label).
  notices: readonly string[] = [],
  // The codes of total assets and total sources the unbalanced warnings of the columns name.
  totals: { assets: string; sources: string } = { assets: '200', sources: '500' },
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { key: 'label', width: 64 },
    { key: 'code', width: 10 },
    { key: 'amount', width: 22 },
    ...comparisons.map((_, i) => ({ key: `compare${i}`, width: 28 })),
  ];
  const notice = sheet.addRow([]);
  setText(notice.getCell('label'), DRAFT_NOTICE);
  notice.font = { bold: true, color: { argb: 'FFB45309' } };
  for (const text of notices) {
    const extra = sheet.addRow([]);
    setText(extra.getCell('label'), text);
    extra.font = { bold: true, color: { argb: 'FFB45309' } };
  }
  const heading = sheet.addRow([]);
  setText(heading.getCell('label'), title);
  heading.font = { bold: true };
  const head = sheet.addRow([]);
  setText(head.getCell('label'), 'Chỉ tiêu');
  setText(head.getCell('code'), 'Mã số');
  setText(head.getCell('amount'), column);
  comparisons.forEach((c, i) => setText(head.getCell(`compare${i}`), c.header));
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 3 + notices.length }];
  for (const line of lines) {
    const row = sheet.addRow([]);
    setText(row.getCell('label'), line.label);
    setText(row.getCell('code'), line.code);
    setMoney(row.getCell('amount'), line.amount);
    comparisons.forEach((c, i) => setMoney(row.getCell(`compare${i}`), c.amounts[line.code] ?? '0'));
    if (line.total) row.font = { bold: true };
  }
  if (unmapped.length > 0) {
    sheet.addRow([]);
    const warn = sheet.addRow([]);
    setText(warn.getCell('label'), 'Cảnh báo: các số dư dưới đây chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ (số dư Nợ dương, Có âm)');
    warn.font = { bold: true };
    for (const u of unmapped) {
      const row = sheet.addRow([]);
      setText(row.getCell('label'), [u.accountName, u.partyName].filter(Boolean).join(', ') || u.accountCode);
      setText(row.getCell('code'), u.accountCode);
      setMoney(row.getCell('amount'), u.amount);
    }
  }
  // A comparison column that is incomplete or does not balance says so, as the sheet's own figures do.
  for (const c of comparisons) {
    if (c.balanced === false) {
      setText(sheet.addRow([]).getCell('label'), `Cảnh báo: tổng tài sản (mã ${totals.assets}) và tổng nguồn vốn (mã ${totals.sources}) của cột ${c.header} không bằng nhau`);
    }
    if (c.unmapped > 0) {
      setText(sheet.addRow([]).getCell('label'), `Cảnh báo: cột ${c.header} có số dư chưa được chỉ tiêu nào đọc, báo cáo chưa đầy đủ`);
    }
  }
  return sheet;
}

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator.
export async function buildStatementsWorkbook(statements: FinancialStatements, orgName: string, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `Báo cáo tài chính ${statements.period.period} ${orgName}`;
  const { startOfYear, lastYear, previous } = statements.comparison;
  const tt99 = statements.regime === 'tt99';
  // The form's own name: B01-DNN / B02-DNN under Circular 133, B 01-DN / B 02-DN under Circular 99.
  const form = tt99 ? 'DN' : 'DNN';
  const totals = b01For(statements.regime ?? 'tt133');
  const b01 = statementSheet(
    workbook,
    `B01-${form}`,
    `Báo cáo tình hình tài chính (B01-${form}) tại ngày ${statements.b01.asOf}`,
    `Số cuối kỳ (${statements.b01.asOf})`,
    statements.b01.lines,
    statements.b01.unmapped,
    startOfYear ? [{ header: `Số đầu năm (${startOfYear.asOf})`, amounts: startOfYear.amounts, balanced: startOfYear.balanced, unmapped: startOfYear.unmapped }] : [],
    tt99 ? [B01_TT99_DRAFT] : [],
    totals,
  );
  if (!statements.b01.balanced) {
    const note = b01.addRow([]);
    setText(note.getCell('label'), `Cảnh báo: tổng tài sản (mã ${totals.assets}) và tổng nguồn vốn (mã ${totals.sources}) không bằng nhau`);
    note.font = { bold: true };
  }
  const b02 = statementSheet(
    workbook,
    `B02-${form}`,
    `Báo cáo kết quả hoạt động kinh doanh (B02-${form}), kỳ ${statements.period.period} (${statements.b02.from} đến ${statements.b02.to})`,
    `Kỳ này`,
    statements.b02.lines,
    statements.b02.unmapped,
    [
      ...(lastYear ? [{ header: `${statements.period.kind === 'year' ? 'Năm trước' : 'Cùng kỳ năm trước'} (${lastYear.period})`, amounts: lastYear.amounts, unmapped: lastYear.unmapped }] : []),
      ...(previous ? [{ header: `Kỳ liền trước (${previous.period})`, amounts: previous.amounts, unmapped: previous.unmapped }] : []),
    ],
  );
  if (tt99) setText(b02.addRow([]).getCell('label'), TT99_NOTICE);
  for (const sheet of [b01, b02]) {
    if (statements.mixedCharts === true) setText(sheet.addRow([]).getCell('label'), MIXED_CHARTS_NOTICE);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
