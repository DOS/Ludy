// SPDX-License-Identifier: AGPL-3.0-only
// The provisional cost of stock, by calendar month (#2513, plan stock-and-marketplaces.md sections 5 row 4 and 8.3): the weighted average per item for the month, (opening value +
// value in) / (opening quantity + quantity in), with every figure a decimal string made by decimal.js and none a number. Pure: it reads moves, it writes nothing.
// - A move that brings value in carries it: a purchase line's amount (and the negative of it for the reversal of such a move). Everything else (a sale's stock-out, the reversal of
//   one, a manual move) carries none and is priced at the month's average.
// - Out is what leaves at that average: the quantity of the moves without value, negated. The closing value is the opening plus the value in less the value out, so the three always add up.
// - A month with nothing to average (no quantity to spread the value over) has no unit cost, and what leaves is valued at zero: the screens say the cost is provisional until a person closes the month.
import { money } from '@crove/l10n-vn';

export interface CostMove {
  // YYYY-MM-DD, the move's date.
  date: string;
  // Signed decimal string.
  quantity: string;
  // The value that comes in with the move (a decimal string, negative for a reversal of a valued move), or null for a move priced at the average.
  value: string | null;
}

export interface MonthFigures {
  // YYYY-MM.
  month: string;
  openingQuantity: string;
  openingValue: string;
  inQuantity: string;
  inValue: string;
  outQuantity: string;
  outValue: string;
  closingQuantity: string;
  closingValue: string;
  // (opening value + value in) / (opening quantity + quantity in) to six decimals, or null when there is no quantity to spread it over.
  unitCost: string | null;
}

const plain = (value: { toFixed(): string }): string => {
  const text = value.toFixed();
  return text === '-0' ? '0' : text;
};
const monthOf = (date: string): string => date.slice(0, 7);

// The month after `month` (YYYY-MM).
export function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

type Balance = { quantity: ReturnType<typeof money>; value: ReturnType<typeof money> };

// What a closed month left to the months after it: the quantity and the value on hand at its end.
export interface OpeningBalance {
  quantity: string;
  value: string;
}

// How a month is folded. `scale` is the decimal places what leaves is valued to: four for the provisional figures, none for a close, which posts whole dong. `opening` is the
// balance a month starts from when the moves before it are a closed month's, which is no longer folded.
export interface FoldOptions {
  scale?: number;
  opening?: OpeningBalance;
}

// One month on top of the balance it opens with: its figures and the balance it closes with.
function foldMonth(opening: Balance, month: string, moves: readonly CostMove[], scale = 4): { figures: MonthFigures; closing: Balance } {
  let valuedQuantity = money(0);
  let valuedValue = money(0);
  let unvaluedQuantity = money(0);
  let total = money(0);
  for (const move of moves) {
    const quantity = money(move.quantity);
    total = total.plus(quantity);
    if (move.value === null) {
      unvaluedQuantity = unvaluedQuantity.plus(quantity);
    } else {
      valuedQuantity = valuedQuantity.plus(quantity);
      valuedValue = valuedValue.plus(money(move.value));
    }
  }
  const pool = opening.quantity.plus(valuedQuantity);
  // The average is exact here and rounded only for display; what leaves is valued at the exact average, to four decimals like every amount.
  const average = pool.greaterThan(0) ? opening.value.plus(valuedValue).dividedBy(pool) : null;
  const outQuantity = unvaluedQuantity.negated();
  const outValue = average === null ? money(0) : outQuantity.times(average).toDecimalPlaces(scale);
  const closing = { quantity: opening.quantity.plus(total), value: opening.value.plus(valuedValue).minus(outValue) };
  return {
    closing,
    figures: {
      month,
      openingQuantity: plain(opening.quantity),
      openingValue: plain(opening.value),
      inQuantity: plain(valuedQuantity),
      inValue: plain(valuedValue),
      outQuantity: plain(outQuantity),
      outValue: plain(outValue),
      closingQuantity: plain(closing.quantity),
      closingValue: plain(closing.value),
      unitCost: average === null ? null : plain(average.toDecimalPlaces(6)),
    },
  };
}

// The figures of `month` (YYYY-MM), carried from the first move's month (or from `options.opening`, the balance of a closed month, when the moves given are the ones after it): a
// month with no move carries the closing of the one before, so only the months that have moves are folded and the cost is that of the moves, never of the months in between. Null
// when there is no move on or before `month` and no balance carried in.
export function monthFigures(moves: readonly CostMove[], month: string, options: FoldOptions = {}): MonthFigures | null {
  const scale = options.scale ?? 4;
  const carried = options.opening ?? null;
  const byMonth = new Map<string, CostMove[]>();
  for (const move of moves) {
    const key = monthOf(move.date);
    if (key > month) continue;
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(move);
    else byMonth.set(key, [move]);
  }
  if (byMonth.size === 0 && carried === null) return null;
  let balance: Balance = carried ? { quantity: money(carried.quantity), value: money(carried.value) } : { quantity: money(0), value: money(0) };
  let last: MonthFigures | null = null;
  for (const key of [...byMonth.keys()].sort()) {
    const step = foldMonth(balance, key, byMonth.get(key) as CostMove[], scale);
    balance = step.closing;
    last = step.figures;
  }
  return last !== null && last.month === month ? last : foldMonth(balance, month, [], scale).figures;
}
