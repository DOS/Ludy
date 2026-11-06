// SPDX-License-Identifier: AGPL-3.0-only
// The count of stock (kiểm kê, #2513 part b, plan stock-and-marketplaces.md section 8.2), pure: from what was counted of each item against what the books hold, it works out the
// difference, what the difference is worth, and the one entry that posts it. It reads quantities and writes nothing; the commands (stock-count.ts) read the moves, ask for the entry
// through the proposal path and write the adjustment moves.
// - The difference of an item is counted minus book quantity (the book quantity is the sum of its moves up to the count date). A shortage is negative and a surplus positive.
// - A difference is worth its quantity at the unit cost the person typed for the line or, when none was typed, at the month's provisional average up to the count date, in whole dong:
//   the entry is a general journal voucher and a voucher holds no fraction of a dong. Money is decimal.js throughout, never a number. An item with a difference and no cost to price it at
//   is named, so a person can type one: a surplus of goods never bought has no cost of its own.
// - A shortage goes to 632 within the norm the count names (a percentage of the book quantity) and to 1381 (goods waiting to be resolved) beyond it; both credit the stock account. A
//   surplus debits the stock account and credits 3381 (surplus waiting to be resolved). The accounts are the plan's defaults, for the accountant to confirm (#2520).
import { money } from '@crove/l10n-vn';

export const SHORTAGE_NORM_ACCOUNT = '632';
export const SHORTAGE_OTHER_ACCOUNT = '1381';
export const SURPLUS_ACCOUNT = '3381';

export interface CountItem {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  // The stock account the item is booked to (156 or a sub-account).
  stockAccount: string;
  // The sum of the item's moves up to the count date.
  bookQuantity: string;
  // The month's provisional average up to the count date, or null when there is nothing to average over.
  averageCost: string | null;
  countedQuantity: string;
  // The unit cost the person typed for this line, or null.
  unitCost: string | null;
}

export interface CountLine {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  stockAccount: string;
  bookQuantity: string;
  countedQuantity: string;
  // Counted minus book: negative for a shortage.
  difference: string;
  // The unit cost the difference is priced at, or null when there is no difference or no cost.
  unitCost: string | null;
  // What the difference is worth, whole dong, signed like the difference ('0' when there is none).
  value: string;
  // For a shortage: the part of its value within the norm (to 632), whole dong; '0' otherwise.
  withinNorm: string;
}

export interface CountEntryLine {
  account: string;
  debit: string;
  credit: string;
}

export interface CountResult {
  lines: CountLine[];
  // The items that differ and have no cost to price the difference at.
  unpriced: Array<{ itemId: string; code: string; name: string }>;
  // The entry that posts the differences: empty when none has a value. Whole dong, each line one side.
  entry: CountEntryLine[];
  // The debits of the entry (equal to its credits), or '0'.
  total: string;
}

const plain = (value: { toFixed(): string }): string => {
  const text = value.toFixed();
  return text === '-0' ? '0' : text;
};

// `normPercent` is a percentage of the book quantity, 0 to 100.
export function countDifferences(items: readonly CountItem[], normPercent: string): CountResult {
  const norm = money(normPercent);
  const lines: CountLine[] = [];
  const unpriced: CountResult['unpriced'] = [];
  for (const item of items) {
    const difference = money(item.countedQuantity).minus(money(item.bookQuantity));
    const base = { itemId: item.itemId, code: item.code, name: item.name, unit: item.unit, stockAccount: item.stockAccount, bookQuantity: plain(money(item.bookQuantity)), countedQuantity: plain(money(item.countedQuantity)) };
    if (difference.isZero()) {
      lines.push({ ...base, difference: '0', unitCost: null, value: '0', withinNorm: '0' });
      continue;
    }
    const cost = item.unitCost !== null ? money(item.unitCost) : item.averageCost !== null ? money(item.averageCost) : null;
    const magnitude = difference.abs();
    const worth = cost !== null && cost.greaterThan(0) ? magnitude.times(cost).toDecimalPlaces(0) : money(0);
    if (cost === null || !cost.greaterThan(0) || worth.isZero()) {
      unpriced.push({ itemId: item.itemId, code: item.code, name: item.name });
      lines.push({ ...base, difference: plain(difference), unitCost: null, value: '0', withinNorm: '0' });
      continue;
    }
    let within = money(0);
    if (difference.lessThan(0)) {
      const allowed = money(item.bookQuantity).greaterThan(0) ? money(item.bookQuantity).times(norm).dividedBy(100) : money(0);
      const withinQuantity = magnitude.lessThan(allowed) ? magnitude : allowed;
      within = withinQuantity.times(cost).toDecimalPlaces(0);
      if (within.greaterThan(worth)) within = worth;
    }
    lines.push({ ...base, difference: plain(difference), unitCost: plain(cost), value: plain(difference.lessThan(0) ? worth.negated() : worth), withinNorm: plain(within) });
  }
  // The entry, one line per account and side: what a shortage takes out of its stock account (credit) goes to 632 within the norm and to 1381 beyond it; a surplus goes into its stock
  // account (debit) against 3381.
  const sides = new Map<string, ReturnType<typeof money>>();
  const add = (account: string, side: 'debit' | 'credit', amount: ReturnType<typeof money>) => {
    if (amount.isZero()) return;
    const key = `${account}|${side}`;
    sides.set(key, (sides.get(key) ?? money(0)).plus(amount));
  };
  for (const line of lines) {
    const value = money(line.value);
    if (value.isZero()) continue;
    if (value.lessThan(0)) {
      const worth = value.negated();
      const within = money(line.withinNorm);
      add(line.stockAccount, 'credit', worth);
      add(SHORTAGE_NORM_ACCOUNT, 'debit', within);
      add(SHORTAGE_OTHER_ACCOUNT, 'debit', worth.minus(within));
    } else {
      add(line.stockAccount, 'debit', value);
      add(SURPLUS_ACCOUNT, 'credit', value);
    }
  }
  const entry: CountEntryLine[] = [...sides.keys()]
    .sort()
    .map((key) => {
      const [account, side] = key.split('|') as [string, 'debit' | 'credit'];
      const amount = plain(sides.get(key) as ReturnType<typeof money>);
      return side === 'debit' ? { account, debit: amount, credit: '0' } : { account, debit: '0', credit: amount };
    });
  const total = entry.reduce((sum, l) => sum.plus(money(l.debit)), money(0));
  return { lines, unpriced, entry, total: plain(total) };
}

// The description of the voucher: the date of the count in the form the books write it.
export function countDescription(countDate: string): string {
  const [year, month, day] = countDate.split('-') as [string, string, string];
  return `Chênh lệch kiểm kê kho ngày ${day}/${month}/${year}`;
}
