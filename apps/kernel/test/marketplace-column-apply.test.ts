// SPDX-License-Identifier: AGPL-3.0-only
// A saved column mapping applied on import (#4037): the worker asks the real extract sandbox (in process, through its HTTP client and parser process) for the file's header digest, looks up the org's saved
// mapping for it (here a fake lookup that records what it was asked), and reads the file again through that mapping. The same header row on another file is found by the same digest, another header row is
// not, a mapping the check refuses on this file reads nothing, and a sandbox that fails leaves the file as it was. The lookup itself and the staging are CI's database test.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMIT_RETRIES, type ExtractClient } from '@crove/extract-contract';
import type { Runtime } from '@crove/kernel-runtime';
import { readWithSavedColumns, type SavedMapping } from '@crove/mod-finance';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
import { inProcessExtract } from './extract-service.ts';

const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007' };
// A shop's own export no built-in profile fits (the same as the sandbox's own test).
const HEAD: XlsxCell[] = ['Số hiệu đơn', 'Ngày tạo', 'Tình trạng', 'Tên người nhận', 'SĐT', 'Mô tả mặt hàng', 'Số lượng', 'Giá bán', 'Tham chiếu 1', 'Cột tự do'];
const row = (order: string, status: string, qty: number, price: number): XlsxCell[] => [order, '2026-10-30', status, BUYER.name, BUYER.phone, `Sản phẩm ${order}`, qty, price, '0900000011', `${BUYER.name} mua`];
const report = (head: XlsxCell[] = HEAD): XlsxCell[][] => [['Báo cáo của cửa hàng'], head, row('9001', 'Hoàn thành', 2, 50000), row('9002', 'Đã hủy', 1, 120000), row('9003', 'Hoàn thành', 3, 50000)];
const digestOf = (cells: XlsxCell[]) => createHash('sha256').update(cells.map((c) => String(c).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()).join('\n'), 'utf8').digest('hex');
const HEADERS: Record<number, string> = { 0: 'Số hiệu đơn', 1: 'Ngày tạo', 2: 'Tình trạng', 5: 'Mô tả mặt hàng', 6: 'Số lượng', 7: 'Giá bán' };
const mapping = (digest: string, fields: Array<[number, SavedMapping['columns'][number]['field']]>, platform: SavedMapping['platform'] = 'shopee'): SavedMapping => ({
  headerDigest: digest,
  platform,
  columns: fields.map(([index, field]) => ({ index, header: HEADERS[index] ?? '', field })),
});
const GOOD = mapping(digestOf(HEAD), [
  [0, 'orderNo'],
  [1, 'orderedAt'],
  [2, 'status'],
  [5, 'itemName'],
  [6, 'quantity'],
  [7, 'unitPrice'],
]);
const extract = inProcessExtract();
// The sandbox client with a count of the calls it was asked for.
function counting(client: ExtractClient) {
  const calls = { n: 0 };
  return { calls, client: { extract: (...args: Parameters<ExtractClient['extract']>) => (calls.n++, client.extract(...args)) } as unknown as ExtractClient };
}

// A runtime that answers the saved-mappings lookup with `saved` and remembers what it was asked.
function lookup(saved: SavedMapping[]) {
  const asked: Array<{ name: string; input: unknown }> = [];
  const runtime = {
    query: async (name: string, input: unknown) => {
      asked.push({ name, input });
      return saved;
    },
  } as unknown as Runtime;
  return { runtime, asked };
}

describe('a saved column mapping applied on import', () => {
  it('reads a file no profile fits through the mapping saved for its header row, and stages lines like any report', async () => {
    const { runtime, asked } = lookup([GOOD]);
    const orders = await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(report()), 0);
    expect(asked).toEqual([{ name: 'finance.marketplace.columns_saved', input: {} }]);
    expect(orders).toMatchObject({ recognized: true, platform: 'shopee', tooMany: false });
    expect(orders?.lines.map((l) => l.orderNo)).toEqual(['9001', '9002', '9003']);
    // A mapping a person confirmed is never the profile's own words, nor a real seller's file checked: its version says so.
    expect(orders?.profile?.version).toMatch(/\+columns$/);
    expect(orders?.profile?.confirmed).toBe(false);
    // Nothing of the buyer in what comes back.
    const everything = JSON.stringify(orders);
    for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
  });

  it('finds the same mapping for another file with the same header row, whatever its rows or its title', async () => {
    const { runtime } = lookup([GOOD]);
    const other = [['Một tiêu đề khác'], HEAD, row('1234', 'Hoàn thành', 5, 10000), row('5678', 'Hoàn thành', 1, 20000)];
    const orders = await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(other), 0);
    expect(orders?.lines.map((l) => l.orderNo)).toEqual(['1234', '5678']);
  });

  it('does not call the sandbox at all while the org has saved no mapping', async () => {
    const { runtime, asked } = lookup([]);
    const { client, calls } = counting(extract);
    expect(await readWithSavedColumns({ runtime, extract: client }, 'org-1', buildXlsx(report()), 0)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(calls.n).toBe(0);
  });

  it('leaves a file whose header row has no saved mapping alone: one sandbox call, nothing read', async () => {
    const { runtime } = lookup([GOOD]);
    const { client, calls } = counting(extract);
    const renamed = [...HEAD];
    renamed[1] = 'Ngày đặt hàng';
    expect(await readWithSavedColumns({ runtime, extract: client }, 'org-1', buildXlsx(report(renamed)), 0)).toBeNull();
    expect(calls.n).toBe(1);
  });

  it('leaves a file alone when the saved header words are not at the saved columns, though the words hash the same', async () => {
    // The same digest, but the saved mapping says column 6 is "Giá bán" while this file has "Số lượng" there: the mapping is for another layout.
    const moved: SavedMapping = { ...GOOD, columns: GOOD.columns.map((c) => (c.index === 6 ? { ...c, header: 'Giá bán' } : c)) };
    const { runtime } = lookup([moved]);
    const { client, calls } = counting(extract);
    expect(await readWithSavedColumns({ runtime, extract: client }, 'org-1', buildXlsx(report()), 0)).toBeNull();
    expect(calls.n).toBe(1);
  });

  it('reads nothing when the check refuses the saved mapping on this file', async () => {
    // The order number on the date column and the quantity on the status column: the file does not read through it.
    const bad = mapping(digestOf(HEAD), [
      [1, 'orderNo'],
      [2, 'quantity'],
    ]);
    const { runtime } = lookup([bad]);
    expect(await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(report()), 0)).toBeNull();
  });

  it('finds nothing for a file that is no sheet', async () => {
    const { runtime } = lookup([GOOD]);
    expect(await readWithSavedColumns({ runtime, extract }, 'org-1', new TextEncoder().encode('plain text, no table'), 0)).toBeNull();
  });

  it('throws when the sandbox cannot be reached, so the job runs again, and retries a limit it hit; any other answer of it leaves the file alone', async () => {
    const { runtime } = lookup([GOOD]);
    const down = { extract: async () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as ExtractClient;
    await expect(readWithSavedColumns({ runtime, extract: down }, 'org-1', buildXlsx(report()), 0)).rejects.toThrow(/ECONNREFUSED/);
    const failing = (code: string) => ({ extract: async () => ({ ok: false, code, message: 'x' }) }) as unknown as ExtractClient;
    expect(await readWithSavedColumns({ runtime, extract: failing('invalid') }, 'org-1', buildXlsx(report()), 0)).toBeNull();
    // A limit (time or memory) throws on the first attempts so the job runs again, as the first read does; past them the file stays as it was.
    await expect(readWithSavedColumns({ runtime, extract: failing('timeout') }, 'org-1', buildXlsx(report()), 0)).rejects.toThrow(/stopped at a limit: timeout/);
    await expect(readWithSavedColumns({ runtime, extract: failing('memory') }, 'org-1', buildXlsx(report()), EXTRACT_LIMIT_RETRIES - 1)).rejects.toThrow(/memory/);
    expect(await readWithSavedColumns({ runtime, extract: failing('timeout') }, 'org-1', buildXlsx(report()), EXTRACT_LIMIT_RETRIES)).toBeNull();
  });
});
