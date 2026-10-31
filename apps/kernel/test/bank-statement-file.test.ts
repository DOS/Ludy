// SPDX-License-Identifier: AGPL-3.0-only
// A bank statement that arrives as a file (#2142), on the worker's side: the real sandbox reads made-up statements, a fake
// runtime records what the worker asks of the finance module. What the command does with the lines (the mapping, the
// dedupe keys, nothing written for an unmapped account) is covered on PostgreSQL in finance-bank.db.test.ts.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMIT_RETRIES, EXTRACT_LIMITS, type ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { readStatementFile, statementFileRows, type StatementFileOutcome } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { STATEMENT_ACCOUNT, statementCsv, statementRows, statementXlsx } from '../../extract/test/statement-fixture.ts';
import { buildXlsx } from '../../extract/test/xlsx-fixture.ts';
import { buildZip } from '../../extract/test/zip-fixture.ts';

const ZIP = 'application/zip';
const CSV = 'text/csv';
const ORG = '0190a000-0000-7000-8000-000000000001';
const FILE = '0190a000-0000-7000-8000-0000000000f1';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const bytes = this.blobs.get(key);
    if (!bytes) throw new Error('missing blob');
    return bytes;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Call {
  name: string;
  input: Record<string, unknown>;
}

// A runtime that answers finance.extraction.file with the file, finance.bank.statement_file with `outcome`, and keeps
// every execute it was asked for.
function harness(
  bytes: Uint8Array,
  contentType: string,
  outcome: StatementFileOutcome,
  options: { hasExtraction?: boolean; extract?: ExtractClient; version?: number; due?: boolean } = {},
) {
  const store = new MemoryStore();
  const sha256 = sha256Hex(bytes);
  store.blobs.set('k', bytes);
  const calls: Call[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const executeOptions: Array<Record<string, unknown>> = [];
  const runtime = {
    query: async (name: string, input: Record<string, unknown>) => {
      if (name !== 'finance.extraction.file') throw new Error(`unexpected query ${name}`);
      queries.push(input);
      // With a version the file has a (pending) run; without one, whether it was read already.
      return { id: FILE, filename: 'sao-ke.xlsx', content_type: contentType, storage_key: 'k', generation: null, sha256, hasExtraction: options.hasExtraction ?? options.version !== undefined, due: options.due ?? true, aiStopped: false };
    },
    execute: async (name: string, input: Record<string, unknown>, executeOption: Record<string, unknown>) => {
      calls.push({ name, input });
      if (name === 'finance.bank.statement_file') executeOptions.push(executeOption);
      return name === 'finance.bank.statement_file' ? outcome : {};
    },
  } as unknown as Runtime;
  const extract = options.extract ?? inProcessExtract();
  return { calls, queries, options: executeOptions, run: (attempt = 0, version?: number) => readStatementFile({ runtime, store, extract }, ORG, FILE, attempt, version) };
}

const imported: StatementFileOutcome = {
  outcome: 'imported',
  importId: '0190a000-0000-7000-8000-0000000000a1',
  bankAccount: '1121',
  legalEntityId: '0190a000-0000-7000-8000-0000000000e1',
  counts: { new: 3, duplicate: 0, ambiguous: 0, invalid: 0 },
};
const unmapped: StatementFileOutcome = { outcome: 'unmapped', accountNumber: STATEMENT_ACCOUNT };

describe('readStatementFile', () => {
  it('reads an .xlsx statement that arrived as a ZIP, stores its lines through the finance command and records the file as read', async () => {
    const h = harness(statementXlsx(), ZIP, imported);
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls.map((c) => c.name)).toEqual(['finance.bank.statement_file', 'kernel.extraction.record']);
    const [store, record] = h.calls;
    expect(store?.input).toMatchObject({ fileId: FILE, filename: 'sao-ke.xlsx', accountNumber: STATEMENT_ACCOUNT });
    const rows = (store?.input['rows'] ?? []) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r['rowNo'], r['date'], r['moneyIn'], r['moneyOut'], r['balance'], r['reference']])).toEqual([
      [7, '01/09/2026', '2000000', '', '12000000', 'FT26244000001'],
      [8, '02/09/2026', '', '11000', '11989000', 'FT26245000002'],
      [9, '03/09/2026', '', '850000', '11139000', 'FT26246000003'],
    ]);
    expect(record?.input).toMatchObject({
      fileId: FILE,
      status: 'done',
      proposal: null,
      error: null,
      result: { kind: 'bank_statement', summary: { bankAccount: '1121', newLines: 3, duplicateLines: 0 } },
      summary: 'Đã nhập sao kê tài khoản 1121: 3 dòng mới, 0 dòng đã có',
    });
  });

  it('records the read of a statement stored as a ZIP as a statement run, and asks the command once per run of the file', async () => {
    const h = harness(statementXlsx(), ZIP, imported);
    await h.run();
    // kernel.extraction.record lets a ZIP through only for a statement run (flag, method unsupported, no proposal).
    expect(h.calls.at(-1)?.input).toMatchObject({ statement: true, method: 'unsupported', proposal: null });
    expect(h.calls.at(-1)?.input).not.toHaveProperty('version');
    // One idempotency key per run: a job that stored the lines and failed before recording finds the answer, not a second import.
    expect(h.options[0]).toMatchObject({ idempotencyKey: `bank-statement-file:${FILE}:0` });
  });

  it('reads again a statement whose account was unmapped when it was read, on the run that was asked for (#2142)', async () => {
    const h = harness(statementXlsx(), ZIP, imported, { version: 2 });
    expect(await h.run(0, 2)).toEqual({ handled: true });
    expect(h.queries.at(-1)).toMatchObject({ fileId: FILE, version: 2 });
    expect(h.calls.at(-1)?.input).toMatchObject({ fileId: FILE, version: 2, status: 'done', statement: true });
    // Its own key: the earlier run's stored answer (unmapped) is not replayed.
    expect(h.options[0]).toMatchObject({ idempotencyKey: `bank-statement-file:${FILE}:2` });
    // A re-read that is no longer pending (another job answered it) is left alone.
    const gone = harness(statementXlsx(), ZIP, imported, { version: 2, due: false });
    expect(await gone.run(0, 2)).toEqual({ handled: true });
    expect(gone.calls).toEqual([]);
  });

  it('reads a CSV statement the same way', async () => {
    const h = harness(statementCsv(), CSV, imported);
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls.map((c) => c.name)).toEqual(['finance.bank.statement_file', 'kernel.extraction.record']);
    expect(h.calls[0]?.input).toMatchObject({ accountNumber: STATEMENT_ACCOUNT });
  });

  it('records an account number no one mapped as a failed read with the reason, which the Inbox shows', async () => {
    const h = harness(statementXlsx(), ZIP, unmapped);
    expect(await h.run()).toEqual({ handled: true });
    const record = h.calls.at(-1);
    expect(record?.name).toBe('kernel.extraction.record');
    expect(record?.input).toMatchObject({ status: 'failed', proposal: null, result: null });
    expect(String(record?.input['error'])).toContain(STATEMENT_ACCOUNT);
    expect(String(record?.input['error'])).toContain('chưa được liên kết');
  });

  it('records a statement with no account number as a failed read, and stores nothing', async () => {
    const h = harness(statementCsv({ account: null }), CSV, { outcome: 'unmapped', accountNumber: null });
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls[0]?.input).toMatchObject({ accountNumber: null });
    expect(h.calls.at(-1)?.input).toMatchObject({ status: 'failed' });
    expect(String(h.calls.at(-1)?.input['error'])).toContain('Không tìm thấy số tài khoản');
  });

  it('tells the person what to fix when the lines are refused', async () => {
    const h = harness(statementXlsx(), ZIP, { outcome: 'refused', code: 'BANK_IMPORT_INVALID', message: 'x', rows: [8, 9] });
    expect(await h.run()).toEqual({ handled: true });
    expect(String(h.calls.at(-1)?.input['error'])).toContain('dòng 8, 9');
  });

  it('leaves a ZIP of invoices, another workbook and a file that is not a statement to the caller, who opens or reads them as before', async () => {
    const archive = buildZip([{ name: 'hoa-don.xml', data: new TextEncoder().encode('<HDon/>') }]);
    for (const bytes of [archive, buildXlsx([['Họ tên', 'Địa chỉ'], ['An', 'Hà Nội']])]) {
      const h = harness(bytes, ZIP, imported);
      expect(await h.run()).toEqual({ handled: false });
      expect(h.calls).toEqual([]);
    }
    // An invoice or a photo is never offered to the sandbox as a statement.
    const xml = harness(new TextEncoder().encode('<HDon/>'), 'application/xml', imported, { extract: { extract: async () => Promise.reject(new Error('not called')) } });
    expect(await xml.run()).toEqual({ handled: false });
  });

  it('takes exactly the archive path for a ZIP that only pretends to be a statement: a bomb, an entity, a damaged or oversized file (#2142)', async () => {
    const bomb = buildXlsx(statementRows(), { override: { 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${' '.repeat(40 * 1024 * 1024)}</sheetData></worksheet>` } });
    const entity = buildXlsx(statementRows(), { override: { 'xl/worksheets/sheet1.xml': '<!DOCTYPE x [<!ENTITY a "b">]><worksheet/>' } });
    const damaged = statementXlsx().slice(0, 200);
    for (const bytes of [bomb, entity, damaged]) {
      const h = harness(bytes, ZIP, imported);
      expect(await h.run()).toEqual({ handled: false });
      // Nothing was stored and nothing recorded: the caller opens it as an archive, with the limits it always had.
      expect(h.calls).toEqual([]);
    }
    // A ZIP past the statement size cap (the sandbox refuses it at the door), or one that keeps timing out after its
    // retries, is an archive's too; before the retries run out a timeout is retried like any other sandbox failure.
    const refuse = (code: 'too_large' | 'timeout' | 'memory'): ExtractClient => ({ extract: async () => ({ ok: false, code, message: 'x' }) as never });
    for (const code of ['too_large', 'timeout', 'memory'] as const) {
      expect(await harness(statementXlsx(), ZIP, imported, { extract: refuse(code) }).run(EXTRACT_LIMIT_RETRIES)).toEqual({ handled: false });
    }
    // Over the statement cap the sandbox is not even asked: a big ZIP is an archive, a big CSV is refused as too large.
    const never: ExtractClient = { extract: async () => Promise.reject(new Error('not called')) };
    const big = new Uint8Array(EXTRACT_LIMITS.maxStatementBytes + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await harness(big, ZIP, imported, { extract: never }).run()).toEqual({ handled: false });
    const bigCsv = harness(big, CSV, imported, { extract: never });
    expect(await bigCsv.run()).toEqual({ handled: true });
    expect(String(bigCsv.calls[0]?.input['error'])).toContain('10 MB');
    await expect(harness(statementXlsx(), ZIP, imported, { extract: refuse('timeout') }).run(0)).rejects.toThrow(/limit/);
    await expect(harness(statementXlsx(), ZIP, imported, { extract: { extract: async () => Promise.reject(new Error('sandbox down')) } }).run()).rejects.toThrow('sandbox down');
  });

  it('ends a CSV the sandbox cannot read as a clear refusal in the Inbox, never as a crash', async () => {
    const binary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x2c]);
    const h = harness(binary, CSV, imported);
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls[0]?.input).toMatchObject({ status: 'failed', proposal: null });
    expect(String(h.calls[0]?.input['error'])).toContain('Không nhận ra sao kê');
    const tooLarge = harness(statementCsv(), CSV, imported, { extract: { extract: async () => ({ ok: false, code: 'too_large', message: 'x' }) as never } });
    expect(await tooLarge.run()).toEqual({ handled: true });
    expect(String(tooLarge.calls[0]?.input['error'])).toContain('10 MB');
  });

  it('fails a CSV that is no statement with the reason, since nothing else would read it', async () => {
    const h = harness(new TextEncoder().encode('Họ tên,Địa chỉ\nAn,Hà Nội\n'), CSV, imported);
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.input).toMatchObject({ status: 'failed' });
    expect(String(h.calls[0]?.input['error'])).toContain('Không nhận ra sao kê');
  });

  it('skips a file that was read already, so a retried job or an opened archive is not read twice', async () => {
    const h = harness(statementXlsx(), ZIP, imported, { hasExtraction: true, extract: { extract: async () => Promise.reject(new Error('not called')) } });
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls).toEqual([]);
  });

  it('fails a statement over the line cap with the reason', async () => {
    const lines = Array.from({ length: 5001 }, (_, i) => ({ date: '01/09/2026', description: `d${i}`, moneyIn: 1000, reference: `FT${i}` }));
    const h = harness(statementXlsx({ lines }), ZIP, imported);
    expect(await h.run()).toEqual({ handled: true });
    expect(h.calls).toHaveLength(1);
    expect(String(h.calls[0]?.input['error'])).toContain('hơn 5.000 dòng');
  });
});

describe('statementFileRows', () => {
  it('turns a typed amount into plain digits as the browser import does, and keeps a stored number as it is', () => {
    const rows = statementFileRows([
      { rowNo: 2, date: '01/09/2026', description: 'a', reference: 'r', moneyIn: { kind: 'text', value: '1.500.000' }, moneyOut: null, balance: { kind: 'number', value: '1.5E+7' } },
      { rowNo: 3, date: '02/09/2026', description: 'b', reference: '', moneyIn: null, moneyOut: { kind: 'text', value: '1,5' }, balance: { kind: 'text', value: '1e3' } },
    ]);
    expect(rows).toEqual([
      { rowNo: 2, date: '01/09/2026', description: 'a', reference: 'r', moneyIn: '1500000', moneyOut: '', balance: '1.5E+7' },
      // A typed text with an exponent is sent as a value the module refuses, never as 1000.
      { rowNo: 3, date: '02/09/2026', description: 'b', reference: '', moneyIn: '', moneyOut: '1.5', balance: '?' },
    ]);
  });
});
