// SPDX-License-Identifier: AGPL-3.0-only
// The close of a month of stock (#2513, plan stock-and-marketplaces.md section 8.3), pure: from each item's moves it works out what the month held, what leaving goods cost, and the one
// entry that posts that cost. It reads moves and writes nothing; the command (stock-close.ts) reads the moves, asks for the entry through the proposal path and stores the result.
// - The cost of what left an item is its quantity out at the month's weighted average, (opening value + value in) / (opening quantity + quantity in), valued in whole dong: the entry
//   is a general journal voucher and a voucher holds no fraction of a dong. Money is decimal.js throughout, never a number.
// - The entry credits each stock account (156 or a sub-account of it) with what left its items and debits 632 with the same in total. What came back (a return, a reversed sale)
//   is negative cost: the sides swap for that account, and 632 takes what is left over, so the entry always balances.
// - A month cannot close while any item is below zero at its end (a sale entered before the purchase): the items are named so a person can enter the purchase or count.
import { money } from '@crove/l10n-vn';
import { monthFigures, type CostMove, type MonthFigures, type OpeningBalance } from './stock-cost.ts';

// The advisory lock every writer of a move of an entity takes shared and a close takes alone, so a close reads every move that committed before it and none is written meanwhile.
export const stockMoveLockKey = (orgId: string, legalEntityId: string): string => `crove_finance.stock_move:${orgId}:${legalEntityId}`;

// The account the cost of goods sold is posted to.
export const COGS_ACCOUNT = '632';

export interface CloseItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  // The stock account the item is booked to (156 or a sub-account).
  stockAccount: string;
  // The item's moves up to the end of the month, or only the ones after the closed month it carries a balance from.
  moves: readonly CostMove[];
  // What the last closed month left on hand, when the moves given are the ones after it.
  opening?: OpeningBalance | undefined;
}

export interface CloseItemFigures extends MonthFigures {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  stockAccount: string;
}

export interface CloseLine {
  account: string;
  debit: string;
  credit: string;
}

export interface CloseResult {
  // Every item that has moves or a balance to carry, with what the month held of it (out valued in whole dong).
  items: CloseItemFigures[];
  // The items below zero at the month's end.
  negative: Array<{ itemId: string; code: string; name: string; closingQuantity: string }>;
  // The items that moved without a value to price the move at (no opening value and no purchase to average over): what left them would be costed at zero and what came back would
  // come back worth nothing, so a month is not closed on them.
  unpriced: Array<{ itemId: string; code: string; name: string; outQuantity: string }>;
  // The entry: empty when no cost left the stock in the month. Whole dong, each line one side.
  lines: CloseLine[];
  // The debits of the entry (equal to its credits), or '0'.
  total: string;
}

const plain = (value: { toFixed(): string }): string => {
  const text = value.toFixed();
  return text === '-0' ? '0' : text;
};

// `month` is YYYY-MM.
export function closeMonth(items: readonly CloseItem[], month: string): CloseResult {
  const figured: CloseItemFigures[] = [];
  for (const item of items) {
    const figures = monthFigures(item.moves, month, { scale: 0, ...(item.opening ? { opening: item.opening } : {}) });
    if (figures === null) continue;
    figured.push({ ...figures, itemId: item.itemId, code: item.code, name: item.name, unit: item.unit, stockAccount: item.stockAccount });
  }
  const negative = figured.filter((f) => money(f.closingQuantity).lessThan(0)).map((f) => ({ itemId: f.itemId, code: f.code, name: f.name, closingQuantity: f.closingQuantity }));
  const unpriced = figured.filter((f) => f.unitCost === null && !money(f.outQuantity).isZero()).map((f) => ({ itemId: f.itemId, code: f.code, name: f.name, outQuantity: f.outQuantity }));
  // What left each stock account: positive is cost out of it (credit), negative is cost back into it (debit).
  const byAccount = new Map<string, ReturnType<typeof money>>();
  for (const f of figured) byAccount.set(f.stockAccount, (byAccount.get(f.stockAccount) ?? money(0)).plus(money(f.outValue)));
  const lines: CloseLine[] = [];
  let net = money(0);
  for (const account of [...byAccount.keys()].sort()) {
    const amount = byAccount.get(account) as ReturnType<typeof money>;
    if (amount.isZero()) continue;
    net = net.plus(amount);
    lines.push(amount.greaterThan(0) ? { account, debit: '0', credit: plain(amount) } : { account, debit: plain(amount.negated()), credit: '0' });
  }
  if (!net.isZero()) lines.push(net.greaterThan(0) ? { account: COGS_ACCOUNT, debit: plain(net), credit: '0' } : { account: COGS_ACCOUNT, debit: '0', credit: plain(net.negated()) });
  const total = lines.reduce((sum, l) => sum.plus(money(l.debit)), money(0));
  return { items: figured, negative, unpriced, lines, total: plain(total) };
}

// The last day of `month` (YYYY-MM), the date of the entry.
export function monthEnd(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// The description of the voucher: the month in the form the books write it.
export function closeDescription(month: string): string {
  const [year, m] = month.split('-') as [string, string];
  return `Giá vốn hàng bán tháng ${m}/${year} (đóng sổ kho)`;
}
