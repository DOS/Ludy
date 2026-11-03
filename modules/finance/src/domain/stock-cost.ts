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

// The figures of every month from the first move's month through `upTo` (YYYY-MM), a month with no move carrying the closing of the one before. Empty when there is no move
// on or before `upTo`.
export function monthlyFigures(moves: readonly CostMove[], upTo: string): MonthFigures[] {
  const dated = moves.filter((m) => monthOf(m.date) <= upTo);
  if (dated.length === 0) return [];
  const byMonth = new Map<string, CostMove[]>();
  for (const move of dated) byMonth.set(monthOf(move.date), [...(byMonth.get(monthOf(move.date)) ?? []), move]);
  const first = [...byMonth.keys()].sort()[0] as string;
  const out: MonthFigures[] = [];
  let openingQuantity = money(0);
  let openingValue = money(0);
  for (let month = first; month <= upTo; month = nextMonth(month)) {
    let valuedQuantity = money(0);
    let valuedValue = money(0);
    let unvaluedQuantity = money(0);
    let total = money(0);
    for (const move of byMonth.get(month) ?? []) {
      const quantity = money(move.quantity);
      total = total.plus(quantity);
      if (move.value === null) {
        unvaluedQuantity = unvaluedQuantity.plus(quantity);
      } else {
        valuedQuantity = valuedQuantity.plus(quantity);
        valuedValue = valuedValue.plus(money(move.value));
      }
    }
    const pool = openingQuantity.plus(valuedQuantity);
    // The average is exact here and rounded only for display; what leaves is valued at the exact average, to four decimals like every amount.
    const average = pool.greaterThan(0) ? openingValue.plus(valuedValue).dividedBy(pool) : null;
    const outQuantity = unvaluedQuantity.negated();
    const outValue = average === null ? money(0) : outQuantity.times(average).toDecimalPlaces(4);
    const closingQuantity = openingQuantity.plus(total);
    const closingValue = openingValue.plus(valuedValue).minus(outValue);
    out.push({
      month,
      openingQuantity: plain(openingQuantity),
      openingValue: plain(openingValue),
      inQuantity: plain(valuedQuantity),
      inValue: plain(valuedValue),
      outQuantity: plain(outQuantity),
      outValue: plain(outValue),
      closingQuantity: plain(closingQuantity),
      closingValue: plain(closingValue),
      unitCost: average === null ? null : plain(average.toDecimalPlaces(6)),
    });
    openingQuantity = closingQuantity;
    openingValue = closingValue;
  }
  return out;
}
