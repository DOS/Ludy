// SPDX-License-Identifier: AGPL-3.0-only
// A declaration document (./declarations.ts) as an xlsx file (issue #2533), laid out like the form's list: the notice, the layout version and the draft banner on top, then one sheet per
// schedule with typed columns, a totals row, and the notes on the last sheet.
//
// Two rules keep the file safe to open, as the books' exports keep them:
// - Every text cell (a name, a header, a code, an identifier) is a string cell with the Text format, never a formula: ExcelJS writes a string as a string, only `{ formula }` makes a formula,
//   and the Text number format keeps `=HYPERLINK(...)`, `+84...`, `-ABC` or `@x` inert. No apostrophe is added (it would become part of the data).
// - Money is exact: a number cell only when the double Excel stores shows the same decimal; otherwise the decimal is written as text, right aligned.
// The file is built in one pass after the caller has the audit row for it; the document is bounded by HR_DECLARATION_MAX_PEOPLE, so it is never cut short.
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { HrDeclarationDocument as DeclarationDocument } from '@crove/kernel-contract';
import { Decimal, money } from '@crove/l10n-vn';

type DeclarationSheet = DeclarationDocument['sheets'][number];
type DeclarationColumn = DeclarationSheet['columns'][number];

const EXCEL_SIGNIFICANT_DIGITS = 15;
const TEXT = '@';

type Cell = { kind: 'number'; value: number; numFmt: string } | { kind: 'text'; value: string };

// An amount as the cell it can be: exact or text. Never rounded through a JS number.
export function amountCell(amount: string): Cell {
  const exact = money(amount);
  if (exact.isZero()) return { kind: 'number', value: 0, numFmt: '#,##0' };
  const canonical = exact.toFixed();
  if (exact.precision(true) <= EXCEL_SIGNIFICANT_DIGITS) {
    const asNumber = Number(canonical);
    if (Number.isFinite(asNumber) && new Decimal(String(asNumber)).eq(exact)) {
      const places = exact.decimalPlaces();
      return { kind: 'number', value: asNumber, numFmt: places === 0 ? '#,##0' : `#,##0.${'0'.repeat(places)}` };
    }
  }
  return { kind: 'text', value: canonical };
}

function setText(cell: ExcelJS.Cell, value: string): void {
  cell.value = value;
  cell.numFmt = TEXT;
}

function setValue(cell: ExcelJS.Cell, column: DeclarationColumn, value: string | undefined): void {
  const v = value ?? '';
  if (column.kind === 'text' || v === '') return setText(cell, v);
  if (column.kind === 'count') {
    // A count is an integer: a number cell when it is one, text otherwise (never a guess).
    if (/^\d{1,9}$/.test(v)) {
      cell.value = Number(v);
      cell.numFmt = '0';
      return;
    }
    return setText(cell, v);
  }
  const a = amountCell(v);
  cell.value = a.value;
  if (a.kind === 'number') cell.numFmt = a.numFmt;
  else {
    cell.numFmt = TEXT;
    cell.alignment = { horizontal: 'right' };
  }
}

function writeSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, doc: DeclarationDocument, sheet: DeclarationSheet, withNotes: boolean): void {
  const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
  const text = (value: string, bold = false): void => {
    const row = ws.addRow([]);
    setText(row.getCell(1), value);
    if (bold) row.font = { bold: true };
    row.commit();
  };
  text(doc.notice.toUpperCase(), true);
  text(`${doc.title}`, true);
  text(`Mẫu: ${doc.layout.form} | Phiên bản bố cục: ${doc.layout.version}`);
  if (doc.draft) text(doc.draft, true);
  text(doc.notSent);
  for (const h of doc.header) {
    const row = ws.addRow([]);
    setText(row.getCell(1), h.label);
    setText(row.getCell(2), h.value);
    row.commit();
  }
  text('');
  text(sheet.title, true);
  const head = ws.addRow([]);
  sheet.columns.forEach((c, i) => setText(head.getCell(i + 1), c.header));
  head.font = { bold: true };
  head.commit();
  for (const data of sheet.rows) {
    const row = ws.addRow([]);
    sheet.columns.forEach((c, i) => setValue(row.getCell(i + 1), c, data[c.key]));
    row.commit();
  }
  if (sheet.totals) {
    const row = ws.addRow([]);
    const totals = sheet.totals;
    sheet.columns.forEach((c, i) => setValue(row.getCell(i + 1), c, totals[c.key]));
    row.font = { bold: true };
    row.commit();
  }
  if (withNotes) {
    text('');
    text('Ghi chú', true);
    for (const note of doc.notes) text(note);
  }
  ws.commit();
}

export async function buildDeclarationWorkbook(doc: DeclarationDocument, brand = 'Ludy'): Promise<Uint8Array> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.once('end', resolve);
    sink.once('error', reject);
  });
  finished.catch(() => undefined);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
  workbook.creator = brand;
  workbook.lastModifiedBy = brand;
  try {
    doc.sheets.forEach((sheet, i) => writeSheet(workbook, doc, sheet, i === doc.sheets.length - 1));
    await workbook.commit();
  } catch (error) {
    sink.destroy();
    throw error;
  }
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}
