// SPDX-License-Identifier: AGPL-3.0-only
// The bank bulk-salary file (./bank-file.ts) as an xlsx file (issue #2532): one sheet, a header row and one row per person, in the columns the person picked or the saved template's (#2893), under the
// headers the file carries (the generic ones, or the template's: text a person typed, so a string cell like every other).
//
// Every cell, the amounts and the sequence numbers included, is a string cell with the Text number format, never a number and never a formula. ExcelJS writes a string as a string and only
// `{ formula }` makes a formula, and the Text format keeps a name or a remark such as `=HYPERLINK(...)`, `+84...`, `-ABC` or `@x` inert in the spreadsheet program. No apostrophe is added in front of
// such a text: it would become part of the name or the account in the file the bank reads (the same rule as the declaration files, ./declaration-xlsx.ts). Banks import an account number and an
// amount as text; an amount is the plain decimal digits of the net pay, with no thousands separator.
// The file is built whole after the caller has its audit row, from a list bounded by HR_BANK_FILE_MAX_PEOPLE, so it is never cut short, and nothing of it is stored.
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { HrBankFile } from '@crove/kernel-contract';

const TEXT = '@';

function setText(cell: ExcelJS.Cell, value: string, right = false): void {
  cell.value = value;
  cell.numFmt = TEXT;
  if (right) cell.alignment = { horizontal: 'right' };
}

export async function buildBankFileWorkbook(file: HrBankFile, brand = 'Ludy'): Promise<Uint8Array> {
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
    const ws = workbook.addWorksheet('Chuyen luong');
    const head = ws.addRow([]);
    file.headers.forEach((header, i) => setText(head.getCell(i + 1), header));
    head.font = { bold: true };
    head.commit();
    for (const r of file.rows) {
      const row = ws.addRow([]);
      file.columns.forEach((c, i) => setText(row.getCell(i + 1), r[c], c === 'amount' || c === 'seq'));
      row.commit();
    }
    ws.commit();
    await workbook.commit();
  } catch (error) {
    sink.destroy();
    throw error;
  }
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}
