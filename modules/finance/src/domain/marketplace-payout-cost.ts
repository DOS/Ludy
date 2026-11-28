// SPDX-License-Identifier: AGPL-3.0-only
// Suggested cost of goods lost in transit (#4337, option B of #4303 S4): given an order's ship moves and each item's monthly weighted-average unit cost at the ship date's month
// (from the stock-close cost model), sums quantity x unitCost using decimal.js and rounds once to whole dong (ROUND_HALF_UP, matching S4's rule).
// Pure: computes a display/prefill suggestion only; never writes and never replaces the person's explicit costAmount.
import { money } from '@ludy/l10n-vn';

export interface ShipMoveCostInput {
  // Positive shipped quantity in the stock item's unit.
  quantity: string;
  // Average unit cost in the ship move's month (from stock-close / stock-report), or null when unpriced.
  unitCost: string | null;
}

const WHOLE_DONG = /^\d{1,15}$/;

// Returns the whole-dong cost suggestion for one order's ship moves, or null when the order has no ship moves, any move is unpriced, or the result is negative/out of range.
export function suggestOrderLostCost(moves: readonly ShipMoveCostInput[]): string | null {
  if (moves.length === 0) return null;
  let total = money('0');
  for (const move of moves) {
    if (move.unitCost === null || move.unitCost.trim() === '') return null;
    const unitCost = money(move.unitCost);
    const quantity = money(move.quantity);
    if (unitCost.isNegative() || !quantity.greaterThan(0)) return null;
    total = total.plus(quantity.times(unitCost));
  }
  const rounded = total.toDecimalPlaces(0).toFixed();
  const clean = rounded === '-0' ? '0' : rounded;
  return WHOLE_DONG.test(clean) ? clean : null;
}
