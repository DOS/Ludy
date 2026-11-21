// SPDX-License-Identifier: AGPL-3.0-only
// A saved column mapping applied on import (#4037): the worker asks the real extract sandbox (in process, through its HTTP client and parser process) for the file's header digest, looks up the org's saved
// mapping for it (here a fake lookup that records what it was asked), and reads the file again through that mapping. The same header row on another file is found by the same digest, another header row is
// not, a mapping the check refuses on this file reads nothing, and a sandbox that fails leaves the file as it was. The lookup itself and the staging are CI's database test.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMIT_RETRIES, type ExtractClient } from '@crove/extract-contract';
import type { Runtime } from '@crove/kernel-runtime';
import { readWithSavedColumns, type SavedColumns } from '@crove/mod-finance';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
import { inProcessExtract } from './extract-service.ts';

const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007' };
// A shop's own export no built-in profile fits (the same as the sandbox's own test).
const HEAD: XlsxCell[] = ['Số hiệu đơn', 'Ngày tạo', 'Tình trạng', 'Tên người nhận', 'SĐT', 'Mô tả mặt hàng', 'Số lượng', 'Giá bán', 'Tham chiếu 1', 'Cột tự do'];
const row = (order: string, status: string, qty: number, price: number): XlsxCell[] => [order, '2026-10-30', status, BUYER.name, BUYER.phone, `Sản phẩm ${order}`, qty, price, '0900000011', `${BUYER.name} mua`];
const report = (head: XlsxCell[] = HEAD): XlsxCell[][] => [['Báo cáo của cửa hàng'], head, row('9001', 'Hoàn thành', 2, 50000), row('9002', 'Đã hủy', 1, 120000), row('9003', 'Hoàn thành', 3, 50000)];
const digestOf = (cells: XlsxCell[]) => createHash('sha256').update(cells.map((c) => String(c).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()).join('\n'), 'utf8').digest('hex');
const GOOD: SavedColumns = {
  platform: 'shopee',
  assignments: [
    { index: 0, field: 'orderNo' },
    { index: 1, field: 'orderedAt' },
    { index: 2, field: 'status' },
    { index: 5, field: 'itemName' },
    { index: 6, field: 'quantity' },
    { index: 7, field: 'unitPrice' },
  ],
};
const extract = inProcessExtract();

// A runtime that answers the saved-mapping lookup with `saved` (by digest) and remembers what it was asked.
function lookup(saved: Record<string, SavedColumns>) {
  const asked: Array<{ name: string; input: unknown }> = [];
  const runtime = {
    query: async (name: string, input: { headerDigest: string }) => {
      asked.push({ name, input });
      return saved[input.headerDigest] ?? null;
    },
  } as unknown as Runtime;
  return { runtime, asked };
}

describe('a saved column mapping applied on import', () => {
  it('reads a file no profile fits through the mapping saved for its header row, and stages lines like any report', async () => {
    const { runtime, asked } = lookup({ [digestOf(HEAD)]: GOOD });
    const orders = await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(report()), 0);
    expect(asked).toEqual([{ name: 'finance.marketplace.columns_saved', input: { headerDigest: digestOf(HEAD) } }]);
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
    const { runtime, asked } = lookup({ [digestOf(HEAD)]: GOOD });
    const other = [['Một tiêu đề khác'], HEAD, row('1234', 'Hoàn thành', 5, 10000), row('5678', 'Hoàn thành', 1, 20000)];
    const orders = await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(other), 0);
    expect(asked[0]?.input).toEqual({ headerDigest: digestOf(HEAD) });
    expect(orders?.lines.map((l) => l.orderNo)).toEqual(['1234', '5678']);
  });

  it('leaves a file whose header row has no saved mapping alone: one sandbox call, one lookup, nothing read', async () => {
    const { runtime, asked } = lookup({ [digestOf(HEAD)]: GOOD });
    const renamed = [...HEAD];
    renamed[1] = 'Ngày đặt hàng';
    expect(await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(report(renamed)), 0)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.input).toEqual({ headerDigest: digestOf(renamed) });
  });

  it('reads nothing when the check refuses the saved mapping on this file', async () => {
    // The order number on the date column and the quantity on the status column: the file does not read through it.
    const bad: SavedColumns = {
      platform: 'shopee',
      assignments: [
        { index: 1, field: 'orderNo' },
        { index: 2, field: 'quantity' },
      ],
    };
    const { runtime } = lookup({ [digestOf(HEAD)]: bad });
    expect(await readWithSavedColumns({ runtime, extract }, 'org-1', buildXlsx(report()), 0)).toBeNull();
  });

  it('asks nothing for a file that is no sheet', async () => {
    const { runtime, asked } = lookup({});
    expect(await readWithSavedColumns({ runtime, extract }, 'org-1', new TextEncoder().encode('plain text, no table'), 0)).toBeNull();
    expect(asked).toHaveLength(0);
  });

  it('leaves the file alone when the sandbox cannot be reached or says it does not know the file, and retries a limit it hit', async () => {
    const { runtime, asked } = lookup({ [digestOf(HEAD)]: GOOD });
    const down = { extract: async () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as ExtractClient;
    expect(await readWithSavedColumns({ runtime, extract: down }, 'org-1', buildXlsx(report()), 0)).toBeNull();
    const failing = (code: string) => ({ extract: async () => ({ ok: false, code, message: 'x' }) }) as unknown as ExtractClient;
    expect(await readWithSavedColumns({ runtime, extract: failing('unavailable') }, 'org-1', buildXlsx(report()), 0)).toBeNull();
    // A limit (time or memory) throws on the first attempts so the job runs again, as the first read does; past them the file stays as it was.
    await expect(readWithSavedColumns({ runtime, extract: failing('timeout') }, 'org-1', buildXlsx(report()), 0)).rejects.toThrow(/stopped at a limit: timeout/);
    await expect(readWithSavedColumns({ runtime, extract: failing('memory') }, 'org-1', buildXlsx(report()), EXTRACT_LIMIT_RETRIES - 1)).rejects.toThrow(/memory/);
    expect(await readWithSavedColumns({ runtime, extract: failing('timeout') }, 'org-1', buildXlsx(report()), EXTRACT_LIMIT_RETRIES)).toBeNull();
    expect(asked).toHaveLength(0);
  });
});
