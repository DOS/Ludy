// SPDX-License-Identifier: AGPL-3.0-only
// A bank statement that arrives as a file (#2142), on the worker's side: the real sandbox reads made-up statements, a fake
// runtime records what the worker asks of the finance module. What the command does with the lines (the mapping, the
// dedupe keys, nothing written for an unmapped account) is covered on PostgreSQL in bank-statement-file.db.test.ts.
import { describe, expect, it } from 'vitest';
import type { ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { readStatementFile, statementFileRows, type StatementFileOutcome } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { STATEMENT_ACCOUNT, statementCsv, statementXlsx } from '../../extract/test/statement-fixture.ts';
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
function harness(bytes: Uint8Array, contentType: string, outcome: StatementFileOutcome, options: { hasExtraction?: boolean; extract?: ExtractClient } = {}) {
  const store = new MemoryStore();
  const sha256 = sha256Hex(bytes);
  store.blobs.set('k', bytes);
  const calls: Call[] = [];
  const runtime = {
    query: async (name: string) => {
      if (name !== 'finance.extraction.file') throw new Error(`unexpected query ${name}`);
      return { id: FILE, filename: 'sao-ke.xlsx', content_type: contentType, storage_key: 'k', generation: null, sha256, hasExtraction: options.hasExtraction ?? false, due: true, aiStopped: false };
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      return name === 'finance.bank.statement_file' ? outcome : {};
    },
  } as unknown as Runtime;
  const extract = options.extract ?? inProcessExtract();
  return { calls, run: (attempt = 0) => readStatementFile({ runtime, store, extract }, ORG, FILE, attempt) };
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
      note: 'Đã nhập sao kê tài khoản 1121: 3 dòng mới, 0 dòng đã có',
    });
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
