// SPDX-License-Identifier: AGPL-3.0-only
// A bank statement as .xlsx or CSV (#2142): the account number above the lines and the lines under the header, read in
// the sandbox like the tax portal's list. The columns are found by the header detection the browser import uses
// (@crove/l10n-vn, bank-statement-sheet.ts), so a file reads the same way in both. What it returns is cells of text; the
// finance module judges them (dates, amounts, duplicates) exactly as it does a browser import's.
//
// A file that is no statement (another kind of workbook, a ZIP of documents, text without a date and an amount column)
// is an answer, not a failure: recognized is false, and the worker goes on to treat the file as it did before, so an
// archive of invoices is still opened as one. Only a statement past the line cap is flagged apart (tooMany).
import { EXTRACT_LIMITS, type ExtractedBankStatement } from '@crove/extract-contract';
import { findAccountNumber, findColumns, parseCsv, statementLines, type StatementCell } from '@crove/l10n-vn';
import { readFirstSheet, serialToDate, XlsxError } from './xlsx.ts';

const NONE: ExtractedBankStatement = { recognized: false, accountNumber: null, tooMany: false, rows: [] };

// The cells of the file's first sheet, a date cell as its calendar day (the sheet's own date system decides it), every
// other cell as the text it holds. null when the bytes are not a workbook.
function workbookGrid(bytes: Uint8Array): Map<number, Map<number, StatementCell>> | null {
  let sheet;
  try {
    sheet = readFirstSheet(bytes);
  } catch (error) {
    if (error instanceof XlsxError) return null;
    throw error;
  }
  const grid = new Map<number, Map<number, StatementCell>>();
  for (const row of sheet.rows) {
    const cells = new Map<number, StatementCell>();
    for (const [col, cell] of row.cells) {
      if (cell.kind === 'date') cells.set(col, { kind: 'text', value: serialToDate(cell.value, sheet.date1904) ?? cell.value });
      else cells.set(col, { kind: cell.kind === 'number' ? 'number' : 'text', value: cell.value });
    }
    grid.set(row.rowNo, cells);
  }
  return grid;
}

// UTF-8, or UTF-16 with its byte order mark (Excel's "Unicode text"); null for bytes that are not text.
function csvGrid(bytes: Uint8Array): Map<number, Map<number, StatementCell>> | null {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  // A binary file has NUL bytes in its first kilobytes; UTF-16 text has them by design.
  if (!utf16 && bytes.subarray(0, 4096).includes(0)) return null;
  try {
    return parseCsv(new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

const cellOut = (cell: StatementCell | undefined) =>
  cell === undefined ? null : { kind: cell.kind === 'number' ? ('number' as const) : ('text' as const), value: cell.value.slice(0, EXTRACT_LIMITS.maxStatementCellChars) };

export function readBankStatement(bytes: Uint8Array): ExtractedBankStatement {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const grid = zip ? workbookGrid(bytes) : csvGrid(bytes);
  if (!grid) return NONE;
  const mapping = findColumns(grid);
  if (!mapping) return NONE;
  const accountNumber = findAccountNumber(grid, mapping.headerRow);
  const lines = statementLines(grid, mapping, EXTRACT_LIMITS.maxStatementRows);
  if (lines === null) return { recognized: true, accountNumber, tooMany: true, rows: [] };
  // A header with no line under it is no statement of anything.
  if (lines.length === 0) return NONE;
  return {
    recognized: true,
    accountNumber,
    tooMany: false,
    rows: lines.map((line) => ({
      rowNo: line.rowNo,
      date: line.date,
      description: line.description,
      reference: line.reference,
      moneyIn: cellOut(line.moneyIn),
      moneyOut: cellOut(line.moneyOut),
      balance: cellOut(line.balance),
    })),
  };
}
