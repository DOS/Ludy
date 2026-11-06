// SPDX-License-Identifier: AGPL-3.0-only
// The stock workbook (#2513): Nhập xuất tồn of a month with one row per item under a header, and the stock card of an item as a second sheet when one is named. Quantities and amounts exact,
// no text read as a formula, as in the other exports.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { StockCard, StockReportRow } from '@crove/kernel-contract';
import { buildStockWorkbook } from '../src/index.ts';
import { expectExcelSheetNames } from './sheet-names.ts';

const row = (over: Partial<StockReportRow> = {}): StockReportRow => ({
  itemId: '01900000-0000-7000-8000-000000000001',
  legalEntityId: '01900000-0000-7000-8000-0000000000a1',
  code: 'A1',
  name: 'Gói quảng cáo',
  unit: 'gói',
  openingQuantity: '5',
  openingValue: '500',
  inQuantity: '10',
  inValue: '1000',
  outQuantity: '2',
  outValue: '200',
  closingQuantity: '13',
  closingValue: '1300',
  unitCost: '100',
  closed: true,
  ...over,
});

const card: StockCard = {
  item: { id: '01900000-0000-7000-8000-000000000001', code: 'A1', name: 'Gói quảng cáo', unit: 'gói' },
  month: '2026-09',
  openingQuantity: '5',
  closingQuantity: '3',
  unitCost: '100',
  provisional: false,
  moves: [
    { id: '01900000-0000-7000-8000-0000000000b1', date: '2026-09-10', source: 'manual', quantity: '-2', value: null, balance: '3', documentId: null, lineNo: null },
  ],
};

async function load(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  expectExcelSheetNames(workbook);
  return workbook;
}
const values = (sheet: ExcelJS.Worksheet | undefined) => (sheet?.getRows(1, sheet.rowCount) ?? []).map((r) => (r.values as unknown[]).slice(1));

describe('buildStockWorkbook', () => {
  it('writes one row per item under a header, with exact figures and the state of the month', async () => {
    const workbook = await load(await buildStockWorkbook('2026-09', [row(), row({ code: '=SUM(A1)', name: '+cmd', openingQuantity: '1234567890.123456', closed: false, unitCost: null })], null, 'demo'));
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Nhập xuất tồn']);
    const rows = values(workbook.getWorksheet('Nhập xuất tồn'));
    expect(rows[0]?.[0]).toBe('Mã hàng');
    expect(rows[1]).toEqual(['A1', 'Gói quảng cáo', 'gói', 5, 500, 10, 1000, 2, 200, 13, 1300, 100, 'Đã chốt sổ']);
    // A code that looks like a formula stays text, a quantity of more than fifteen digits stays exact, and a month not closed says so.
    expect(rows[2]?.[0]).toBe('=SUM(A1)');
    expect(rows[2]?.[1]).toBe('+cmd');
    expect(rows[2]?.[3]).toBe('1234567890.123456');
    expect(rows[2]?.[12]).toBe('Tạm tính');
  });

  it('adds the stock card of the item as a second sheet, with its opening and closing balance', async () => {
    const workbook = await load(await buildStockWorkbook('2026-09', [row()], card, 'demo'));
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Nhập xuất tồn', 'Thẻ kho']);
    const rows = values(workbook.getWorksheet('Thẻ kho'));
    expect(rows[0]?.[0]).toBe('Thẻ kho A1 - Gói quảng cáo, tháng 09/2026 (đã chốt sổ)');
    expect(rows[1]).toEqual([undefined, 'Tồn đầu kỳ', undefined, undefined, 5]);
    expect(rows[3]).toEqual(['2026-09-10', 'Nhập tay', -2, undefined, 3]);
    expect(rows[4]).toEqual([undefined, 'Tồn cuối kỳ', undefined, undefined, 3]);
  });
});
