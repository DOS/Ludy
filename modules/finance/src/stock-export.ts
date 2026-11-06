// SPDX-License-Identifier: AGPL-3.0-only
// Excel export of the stock reports (#2513) for the accountant: Nhập xuất tồn of one month (one row per item with its opening, in, out and closing quantity and value and the unit cost,
// and whether the month is closed) and, when an item is named, its stock card (thẻ kho) with the balance after each move. Same cell rules as the other exports (export.ts): amounts and
// quantities exact through the decimal cells, text never read as a formula. Labels stay Vietnamese in every locale.
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { zId, zStockMonth, type StockCard, type StockReportRow } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineCommand } from '@crove/kernel-runtime';
import { decimalCell, setMoneyCell as setMoney, setTextCell as setText } from './export.ts';

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
const SOURCES: Record<string, string> = { document_line: 'Từ hóa đơn', manual: 'Nhập tay', reversal: 'Đảo', order_line: 'Từ đơn hàng sàn' };

// A quantity or a unit cost, exact: a number while Excel keeps it as written, else the decimal as text.
function setDecimal(cell: ExcelJS.Cell, value: string): void {
  const v = decimalCell(value);
  cell.value = v.value;
  if (v.kind === 'number') {
    cell.numFmt = v.numFmt;
  } else {
    cell.numFmt = '@';
    cell.alignment = { horizontal: 'right' };
  }
}

// brand: the product name users see (BRAND_NAME, #1045), as the file's creator.
export async function buildStockWorkbook(month: string, report: readonly StockReportRow[], card: StockCard | null, orgName: string, brand = 'Ludy'): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = brand;
  workbook.title = `Nhập xuất tồn tháng ${monthLabel(month)} ${orgName}`;
  const sheet = workbook.addWorksheet('Nhập xuất tồn');
  sheet.columns = [
    { key: 'code', width: 16 },
    { key: 'name', width: 40 },
    { key: 'unit', width: 10 },
    { key: 'openingQuantity', width: 14 },
    { key: 'openingValue', width: 18 },
    { key: 'inQuantity', width: 14 },
    { key: 'inValue', width: 18 },
    { key: 'outQuantity', width: 14 },
    { key: 'outValue', width: 18 },
    { key: 'closingQuantity', width: 14 },
    { key: 'closingValue', width: 18 },
    { key: 'unitCost', width: 18 },
    { key: 'state', width: 14 },
  ];
  const head = sheet.addRow([]);
  const titles: Record<string, string> = {
    code: 'Mã hàng',
    name: 'Tên hàng',
    unit: 'Đơn vị',
    openingQuantity: 'Đầu kỳ (SL)',
    openingValue: 'Đầu kỳ (giá trị)',
    inQuantity: 'Nhập (SL)',
    inValue: 'Nhập (giá trị)',
    outQuantity: 'Xuất (SL)',
    outValue: 'Xuất (giá trị)',
    closingQuantity: 'Cuối kỳ (SL)',
    closingValue: 'Cuối kỳ (giá trị)',
    unitCost: 'Đơn giá bình quân',
    state: 'Tình trạng',
  };
  for (const [key, title] of Object.entries(titles)) setText(head.getCell(key), title);
  head.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of report) {
    const row = sheet.addRow([]);
    setText(row.getCell('code'), r.code);
    setText(row.getCell('name'), r.name);
    setText(row.getCell('unit'), r.unit);
    setDecimal(row.getCell('openingQuantity'), r.openingQuantity);
    setMoney(row.getCell('openingValue'), r.openingValue);
    setDecimal(row.getCell('inQuantity'), r.inQuantity);
    setMoney(row.getCell('inValue'), r.inValue);
    setDecimal(row.getCell('outQuantity'), r.outQuantity);
    setMoney(row.getCell('outValue'), r.outValue);
    setDecimal(row.getCell('closingQuantity'), r.closingQuantity);
    setMoney(row.getCell('closingValue'), r.closingValue);
    if (r.unitCost !== null) setDecimal(row.getCell('unitCost'), r.unitCost);
    setText(row.getCell('state'), r.closed ? 'Đã chốt sổ' : 'Tạm tính');
  }
  if (card) {
    const cardSheet = workbook.addWorksheet('Thẻ kho');
    cardSheet.columns = [
      { key: 'date', width: 14 },
      { key: 'source', width: 22 },
      { key: 'quantity', width: 14 },
      { key: 'value', width: 18 },
      { key: 'balance', width: 14 },
    ];
    const title = cardSheet.addRow([]);
    setText(title.getCell(1), `Thẻ kho ${card.item.code} - ${card.item.name}, tháng ${monthLabel(card.month)} (${card.provisional ? 'tạm tính' : 'đã chốt sổ'})`);
    title.font = { bold: true };
    const opening = cardSheet.addRow([]);
    setText(opening.getCell('source'), 'Tồn đầu kỳ');
    setDecimal(opening.getCell('balance'), card.openingQuantity);
    const cardHead = cardSheet.addRow([]);
    setText(cardHead.getCell('date'), 'Ngày');
    setText(cardHead.getCell('source'), 'Nguồn');
    setText(cardHead.getCell('quantity'), 'Số lượng');
    setText(cardHead.getCell('value'), 'Giá trị nhập');
    setText(cardHead.getCell('balance'), 'Tồn');
    cardHead.font = { bold: true };
    for (const m of card.moves) {
      const row = cardSheet.addRow([]);
      setText(row.getCell('date'), m.date);
      setText(row.getCell('source'), SOURCES[m.source] ?? m.source);
      setDecimal(row.getCell('quantity'), m.quantity);
      if (m.value !== null) setMoney(row.getCell('value'), m.value);
      setDecimal(row.getCell('balance'), m.balance);
    }
    const closing = cardSheet.addRow([]);
    setText(closing.getCell('source'), 'Tồn cuối kỳ');
    setDecimal(closing.getCell('balance'), card.closingQuantity);
    closing.font = { bold: true };
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Records one Excel export of the stock reports after the workbook is built. It changes nothing: its audit row (the month, the number of items, whether a card was in it) is the record of
// who took the figures out, and a failure stops the download.
export const exportStock = defineCommand({
  name: 'finance.stock.export',
  input: z.object({ month: zStockMonth, items: z.number().int().min(0), card: z.boolean(), legalEntityId: zId.optional() }),
  risk: 'R0',
  sideEffect: 'none',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ month: input.month, items: input.items, card: input.card, ...(input.legalEntityId ? { legal_entity_id: input.legalEntityId } : {}) });
    return { ok: true as const };
  },
});

export const stockExportCommands = [exportStock];
