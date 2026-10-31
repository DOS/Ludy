// Bank statements (issue #326): reading a bank's Excel or CSV export in the browser and finding its columns by their
// headers, so any bank's file can be imported without a preset. Cells go to the kernel as text (number cells as
// stored, amounts typed as text made plain by normalizeStatementAmount); the finance module decides every rule. The
// header detection and the CSV reading are shared with the sandbox that reads a statement sent by email (#2142).
import { BANK_IMPORT_MAX_ROWS, statementAmountText, type BankStatementRow } from '@crove/kernel-contract';
import { parseCsv, statementLines, type StatementMapping } from '@crove/l10n-vn';
import { readFirstSheet, type SheetRows } from './xlsx.ts';

export { STATEMENT_COLUMNS, findColumns, headerKey, headerLabels, parseCsv, type StatementColumn, type StatementMapping } from '@crove/l10n-vn';

// The lines under the header: every row whose date cell holds a digit (a title, a blank or a "Tổng cộng" row below
// the lines has none). At most BANK_IMPORT_MAX_ROWS; null when the file has more.
export function statementRows(rows: SheetRows, mapping: StatementMapping): BankStatementRow[] | null {
  const lines = statementLines(rows, mapping, BANK_IMPORT_MAX_ROWS);
  if (lines === null) return null;
  return lines.map((line) => ({
    rowNo: line.rowNo,
    date: line.date,
    description: line.description,
    moneyIn: statementAmountText(line.moneyIn).slice(0, 50),
    moneyOut: statementAmountText(line.moneyOut).slice(0, 50),
    balance: statementAmountText(line.balance).slice(0, 50),
    reference: line.reference,
  }));
}

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

// A picked file as rows: an .xlsx workbook's first sheet, else CSV (UTF-8, or UTF-16 with its byte order mark, as
// Excel saves "Unicode text").
export async function readStatementFile(bytes: Uint8Array, name: string): Promise<SheetRows> {
  if (/\.xlsx$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return readFirstSheet(bytes);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  return parseCsv(new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes));
}
