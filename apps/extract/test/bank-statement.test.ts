// SPDX-License-Identifier: AGPL-3.0-only
// The bank statement reader of the sandbox (#2142): an .xlsx or CSV statement read into its account number and lines, a
// file that is no statement answered as such, and the same file through the parser and the sandboxed process.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractResponse } from '@crove/extract-contract';
import { readBankStatement } from '../src/bank-statement.ts';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
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
