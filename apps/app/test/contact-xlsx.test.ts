// SPDX-License-Identifier: AGPL-3.0-only
// Contacts from an Excel file (#2230, docs/plan/crm.md step K6): the first sheet of an .xlsx read in the browser gives the
// same table as the same data in a CSV, a phone or tax code that Excel stored as a number gets its leading zero back, and
// a file that is not a workbook or a zip bomb is refused. The sample workbook the page offers reads back as its own columns.
import { describe, expect, it } from 'vitest';
import { guessMapping, mappedRows, parseContactCsv, sheetToTable } from '../src/lib/contact-csv.ts';
import { XlsxError, readFirstSheet, writeWorkbook, zipStored } from '../src/lib/xlsx.ts';

const TABLE = [
  ['Tên', 'Mã số thuế', 'Email', 'Số điện thoại', 'Địa chỉ'],
  ['Công ty ABC', '0123456780', 'abc@khach.test', '0901 111 222', '12 Lê Lợi, Quận 1'],
  ['Nguyễn Văn An', '', 'an@khach.test', '0900 333 333', ''],
];
const csvOf = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

describe('an .xlsx of contacts', () => {
  it('gives the same header and rows as the same data in a CSV', async () => {
    const book = writeWorkbook([{ name: 'Liên hệ', widths: [20, 14, 20, 16, 30], headerRows: 1, textColumns: [1, 3], rows: TABLE }]);
    const fromSheet = sheetToTable(await readFirstSheet(book));
    const fromCsv = parseContactCsv(csvOf(TABLE));
    expect(fromSheet.header).toEqual(fromCsv.header);
    expect(fromSheet.rows).toEqual(fromCsv.rows);
    expect(guessMapping(fromSheet.header)).toEqual(['name', 'taxCode', 'email', 'phone', 'address']);
    // The same rows go to the server.
    const mapping = guessMapping(fromSheet.header);
    expect(mappedRows(fromSheet.rows, mapping, fromSheet.numeric)).toEqual(mappedRows(fromCsv.rows, mapping));
  });

  it('reads only the first sheet, skips empty rows and keeps number cells as the text they were stored with', () => {
    const sheet = new Map([
      [3, new Map([[0, { kind: 'text' as const, value: 'Tên' }], [2, { kind: 'text' as const, value: 'Điện thoại' }]])],
      [4, new Map([[0, { kind: 'text' as const, value: 'An' }], [2, { kind: 'number' as const, value: '912345678' }]])],
      [6, new Map<number, { kind: 'text' | 'number'; value: string }>()],
      [7, new Map([[0, { kind: 'text' as const, value: 'Bình' }]])],
    ]);
    const table = sheetToTable(sheet);
    expect(table.header).toEqual(['Tên', '', 'Điện thoại']);
    expect(table.rows).toEqual([['An', '', '912345678'], ['Bình', '', '']]);
    expect(table.numeric).toEqual([[false, false, true], [false, false, false]]);
  });

  it('puts back the zero a number cell lost, in a phone or tax code of nine digits only', () => {
    const rows = [['An', '912345678', '123456789', '12345678'], ['Bình', '912345678', '', '']];
    const numeric = [[false, true, true, true], [false, false, false, false]];
    const mapped = mappedRows(rows, ['name', 'phone', 'taxCode', 'address'], numeric);
    expect(mapped[0]).toMatchObject({ phone: '0912345678', taxCode: '0123456789', address: '12345678' });
    // A cell typed as text is left as it is, and so are the other fields.
    expect(mapped[1]).toMatchObject({ phone: '912345678' });
  });

  it('refuses what is not a workbook, and a file too large', async () => {
    await expect(readFirstSheet(new TextEncoder().encode('Tên,Email\nAn,an@khach.test'))).rejects.toMatchObject({ name: 'XlsxError', reason: 'not_xlsx' });
    await expect(readFirstSheet(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(XlsxError);
    await expect(readFirstSheet(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses a workbook with macros and a sheet with a formula cell when asked, and an oversized one always', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const book = (sheet: string, extra: { name: string; data: Uint8Array }[] = []) =>
      zipStored([
        { name: '[Content_Types].xml', data: enc('<Types/>') },
        { name: 'xl/workbook.xml', data: enc(`<workbook ${ns}><sheets><sheet name="A" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
        { name: 'xl/worksheets/sheet1.xml', data: enc(sheet) },
        ...extra,
      ]);
    const plain = `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Tên</t></is></c></row></sheetData></worksheet>`;
    const withFormula = `<worksheet ${ns}><sheetData><row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>3</v></c></row></sheetData></worksheet>`;
    // A plain sheet reads, with the options on too.
    expect((await readFirstSheet(book(plain), { refuseMacros: true, refuseFormulas: true })).size).toBe(1);
    // A macro workbook (a VBA project part) is refused when asked, and read when not.
    const macro = book(plain, [{ name: 'xl/vbaProject.bin', data: enc('x') }]);
    await expect(readFirstSheet(macro, { refuseMacros: true })).rejects.toMatchObject({ name: 'XlsxError', reason: 'macro' });
    expect((await readFirstSheet(macro)).size).toBe(1);
    // A formula cell is refused when asked, and read (its cached value) when not.
    await expect(readFirstSheet(book(withFormula), { refuseFormulas: true })).rejects.toMatchObject({ reason: 'formula' });
    expect((await readFirstSheet(book(withFormula))).size).toBe(1);
    // An oversized file is refused whatever the options.
    await expect(readFirstSheet(new Uint8Array(5 * 1024 * 1024 + 1), { refuseMacros: true, refuseFormulas: true })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('reads back a sample workbook with the columns the import knows', async () => {
    const sample = writeWorkbook([{ name: 'Liên hệ', widths: [28, 22, 18, 28, 18, 36], headerRows: 1, textColumns: [2, 3], rows: [['Tên', 'Loại (công ty hay cá nhân)', 'Mã số thuế', 'Email', 'Điện thoại', 'Địa chỉ'], ['Công ty Mẫu', '', '', 'mau@example.com', '0900 000 000', '1 Đường Mẫu, Quận 1']] }]);
    const table = sheetToTable(await readFirstSheet(sample));
    expect(table.header).toHaveLength(6);
    expect(table.rows[0]?.[4]).toBe('0900 000 000');
  });
});
