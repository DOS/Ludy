// SPDX-License-Identifier: AGPL-3.0-only
// The bank statement reader of the sandbox (#2142): an .xlsx or CSV statement read into its account number and lines, a
// file that is no statement answered as such, and the same file through the parser and the sandboxed process.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractResponse } from '@crove/extract-contract';
import { readBankStatement } from '../src/bank-statement.ts';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { createExtractApp } from '../src/server.ts';
import { readFirstSheet } from '../src/xlsx.ts';
import { STATEMENT_ACCOUNT, STATEMENT_HEADER, STATEMENT_LINES, statementCsv, statementRows, statementXlsx, type StatementLineSpec } from './statement-fixture.ts';
import { buildXlsx } from './xlsx-fixture.ts';
import { buildZip } from './zip-fixture.ts';

describe('readBankStatement', () => {
  it('reads the account number above the header and the lines under it from a workbook', () => {
    const statement = readBankStatement(statementXlsx());
    expect(statement.recognized).toBe(true);
    expect(statement.tooMany).toBe(false);
    expect(statement.accountNumber).toBe(STATEMENT_ACCOUNT);
    // The title rows and the totals row are no lines; row numbers are the sheet's own.
    expect(statement.rows.map((r) => [r.rowNo, r.date, r.reference])).toEqual([
      [7, '01/09/2026', 'FT26244000001'],
      [8, '02/09/2026', 'FT26245000002'],
      [9, '03/09/2026', 'FT26246000003'],
    ]);
    expect(statement.rows[0]).toMatchObject({ description: 'Thu tien hang HD 0001', moneyOut: null, moneyIn: { kind: 'number', value: '2000000' }, balance: { kind: 'number', value: '12000000' } });
    expect(statement.rows[1]).toMatchObject({ moneyOut: { kind: 'number', value: '11000' }, moneyIn: null });
  });

  it('reads a date cell as its calendar day', () => {
    const rows = statementRows();
    // 46266 is 2026-09-01 in Excel's 1900 system.
    rows[6] = [{ date: 46266 }, ...(rows[6]?.slice(1) ?? [])];
    const statement = readBankStatement(buildXlsx(rows));
    expect(statement.rows[0]?.date).toBe('2026-09-01');
  });

  it('reads the same statement from CSV, with a byte order mark', () => {
    const csv = readBankStatement(statementCsv());
    const xlsx = readBankStatement(statementXlsx());
    expect(csv.recognized).toBe(true);
    expect(csv.accountNumber).toBe(STATEMENT_ACCOUNT);
    expect(csv.rows.map((r) => [r.date, r.description, r.reference])).toEqual(xlsx.rows.map((r) => [r.date, r.description, r.reference]));
    // A CSV cell is text, so the amounts come as typed.
    expect(csv.rows[0]?.moneyIn).toEqual({ kind: 'text', value: '2000000' });
  });

  it('reads a statement that names no account number, and says so', () => {
    expect(readBankStatement(statementXlsx({ account: null })).accountNumber).toBeNull();
    expect(readBankStatement(statementXlsx({ account: null })).recognized).toBe(true);
  });

  it('answers recognized false for a file that is no statement', () => {
    const none = { recognized: false, accountNumber: null, tooMany: false, rows: [] };
    // A workbook with no date and amount columns, a header with no lines, a ZIP of documents, text and binary bytes.
    expect(readBankStatement(buildXlsx([['Họ tên', 'Địa chỉ'], ['An', 'Hà Nội']]))).toEqual(none);
    expect(readBankStatement(buildXlsx([STATEMENT_HEADER]))).toEqual(none);
    expect(readBankStatement(buildZip([{ name: 'hoa-don.xml', data: new TextEncoder().encode('<a/>') }]))).toEqual(none);
    expect(readBankStatement(new TextEncoder().encode('Xin chào, đây là một thư.\nKhông có bảng nào.'))).toEqual(none);
    expect(readBankStatement(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02, 0xff]))).toEqual(none);
    expect(readBankStatement(new Uint8Array(0))).toEqual(none);
  });

  it('flags a statement past the line cap instead of cutting it short', () => {
    const lines: StatementLineSpec[] = Array.from({ length: EXTRACT_LIMITS.maxStatementRows + 1 }, (_, i) => ({
      date: '01/09/2026',
      description: `Dong ${i}`,
      moneyIn: 1000,
      reference: `FT${i}`,
    }));
    expect(readBankStatement(statementXlsx({ lines }))).toEqual({ recognized: true, accountNumber: STATEMENT_ACCOUNT, tooMany: true, rows: [] });
  });
});

// The probe reads a ZIP that may be anything (an .xlsx arrives as a ZIP, so does an archive of invoices, so can a hostile
// file), with the limits the workbook reader and the archive reader already have (#465, #314): none is loosened here. Every
// one of these ends as an answer "this is no statement" and never as a thrown error, a hang or an expanded entity.
describe('a file that is hostile or only pretends to be a statement', () => {
  const NONE = { recognized: false, accountNumber: null, tooMany: false, rows: [] };
  const MiB = 1024 * 1024;

  it('refuses an XML entity in any part it reads: an external one, and a billion laughs', () => {
    const external = '<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row></sheetData></worksheet>';
    const laughs =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol3;</t></is></c></row></sheetData></worksheet>';
    for (const sheet of [external, laughs]) {
      const workbook = buildXlsx(statementRows(), { override: { 'xl/worksheets/sheet1.xml': sheet } });
      // The reader itself says why (no entity is declared, so none is expanded), and the probe answers "no statement".
      expect(() => readFirstSheet(workbook)).toThrow(/DOCTYPE\/ENTITY/);
      expect(readBankStatement(workbook)).toEqual(NONE);
    }
    // The same in the workbook, the shared strings and the styles.
    const entity = '<!DOCTYPE x [<!ENTITY a "b">]><x/>';
    for (const part of ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml']) {
      expect(readBankStatement(buildXlsx(statementRows(), { override: { [part]: entity } }))).toEqual(NONE);
    }
  });

  it('caps what a part inflates to, so a zip bomb is refused without being inflated', () => {
    // 40 MiB of one character deflates to a few KB: its declared size is over the 32 MiB a part may be.
    const bomb = `<worksheet><sheetData>${' '.repeat(40 * MiB)}</sheetData></worksheet>`;
    const started = performance.now();
    expect(readBankStatement(buildXlsx(statementRows(), { override: { 'xl/worksheets/sheet1.xml': bomb } }))).toEqual(NONE);
    // An entry that lies about its size is refused too, not read to the end.
    const lying = buildZip([{ name: 'xl/worksheets/sheet1.xml', data: 'x'.repeat(1000), size: 1 }]);
    expect(readBankStatement(lying)).toEqual(NONE);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('refuses a ZIP with more entries than an archive may have', () => {
    const extra = Array.from({ length: EXTRACT_LIMITS.maxArchiveEntries + 1 }, (_, i) => ({ name: `junk/${i}.txt`, data: 'x' }));
    expect(readBankStatement(buildXlsx(statementRows(), { extra }))).toEqual(NONE);
  });

  it('answers "no statement" for a malformed file instead of failing', () => {
    const good = statementXlsx();
    const damaged = [
      good.slice(0, 120),
      good.slice(0, good.length - 30),
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]),
      Uint8Array.from([...good.slice(0, 60), ...new Uint8Array(200).fill(0xff)]),
      buildZip([{ name: '../../evil.txt', data: 'x' }]),
      buildZip([{ name: 'a.txt', data: 'x', encrypted: true }]),
      buildZip([{ name: 'xl/worksheets/sheet1.xml', data: 'x', method: 99 }]),
    ];
    for (const bytes of damaged) expect(readBankStatement(bytes)).toEqual(NONE);
  });

  it('answers "no statement" for a ZIP that has the parts of a workbook but not a sheet that reads as one', () => {
    // The names of an .xlsx, with a sheet that is not a statement, a missing sheet and a sheet outside the archive.
    expect(readBankStatement(buildXlsx([['Tên', 'Giá'], ['Bút', 5000]]))).toEqual(NONE);
    expect(readBankStatement(buildXlsx(statementRows(), { override: { 'xl/_rels/workbook.xml.rels': '<Relationships/>' } }))).toEqual(NONE);
    expect(readBankStatement(buildXlsx(statementRows(), { override: { 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="http://evil.test/sheet.xml"/></Relationships>' } }))).toEqual(NONE);
    // Old .xls (OLE) is not a workbook the reader takes.
    expect(readBankStatement(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))).toEqual(NONE);
  });

  it('never loads a hostile file into the sandbox answer: a flood of lines is cut at the cap, and text is bounded', () => {
    const long = 'x'.repeat(5000);
    const statement = readBankStatement(statementXlsx({ lines: [{ date: '01/09/2026', description: long, moneyIn: 1, reference: long }] }));
    expect(statement.rows[0]?.description.length).toBeLessThanOrEqual(1000);
    expect(statement.rows[0]?.reference.length).toBeLessThanOrEqual(100);
    expect(() => zExtractResponse.parse({ ok: true, kind: 'bank_statement', statement })).not.toThrow();
  });

  it('is refused at the door over the size cap, before a byte is read', async () => {
    const app = createExtractApp();
    const over = new Uint8Array(EXTRACT_LIMITS.maxStatementBytes + 1);
    const response = await app.fetch(new Request('http://crove-extract.test/extract?kind=bank_statement', { method: 'POST', body: over, headers: { 'content-type': 'application/octet-stream' } }));
    expect(response.status).toBe(413);
    expect(zExtractResponse.parse(await response.json())).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('keeps a hostile file inside the sandbox process: the parser process answers, whatever it is sent', async () => {
    const bomb = `<worksheet><sheetData>${' '.repeat(40 * MiB)}</sheetData></worksheet>`;
    for (const bytes of [buildXlsx(statementRows(), { override: { 'xl/worksheets/sheet1.xml': bomb } }), statementXlsx().slice(0, 150)]) {
      expect(await runSandboxed('bank_statement', bytes)).toMatchObject({ ok: true, kind: 'bank_statement', statement: { recognized: false } });
    }
  });
});

describe('through the parser and the sandbox', () => {
  it('answers a valid contract result for a statement and for a file that is none', async () => {
    const ok = zExtractResponse.parse(await parse('bank_statement', statementXlsx()));
    expect(ok).toMatchObject({ ok: true, kind: 'bank_statement', statement: { recognized: true, accountNumber: STATEMENT_ACCOUNT } });
    const none = zExtractResponse.parse(await parse('bank_statement', buildXlsx([['nothing here']])));
    expect(none).toMatchObject({ ok: true, kind: 'bank_statement', statement: { recognized: false } });
  });

  it('reads the statement in a parser process', async () => {
    const answer = await runSandboxed('bank_statement', statementCsv());
    expect(answer).toMatchObject({ ok: true, kind: 'bank_statement', statement: { recognized: true, accountNumber: STATEMENT_ACCOUNT } });
    expect(answer.ok && answer.kind === 'bank_statement' ? answer.statement.rows : []).toHaveLength(STATEMENT_LINES.length);
  });
});
