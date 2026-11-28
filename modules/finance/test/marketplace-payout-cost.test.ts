// SPDX-License-Identifier: AGPL-3.0-only
// Pure tests for suggested lost-goods cost (#4337, option B of #4303 S4): quantity x monthly weighted-average cost at the ship date's month,
// computed with decimal.js and rounded half-up to whole dong.
import { describe, expect, it } from 'vitest';
import { suggestOrderLostCost } from '../src/domain/marketplace-payout-cost.ts';
import { monthFigures, type CostMove } from '../src/domain/stock-cost.ts';

describe('suggested cost of lost goods from ship moves (#4337)', () => {
  it('returns null when an order has no ship moves or any ship move is unpriced', () => {
    expect(suggestOrderLostCost([])).toBeNull();
    expect(suggestOrderLostCost([{ quantity: '2', unitCost: null }])).toBeNull();
    expect(suggestOrderLostCost([{ quantity: '1', unitCost: '' }])).toBeNull();
    expect(
      suggestOrderLostCost([
        { quantity: '1', unitCost: '100000' },
        { quantity: '1', unitCost: null },
      ]),
    ).toBeNull();
    expect(suggestOrderLostCost([{ quantity: '1', unitCost: '-100' }])).toBeNull();
    expect(suggestOrderLostCost([{ quantity: '0', unitCost: '100000' }])).toBeNull();
  });

  it('multiplies quantity by unit cost with decimal.js and rounds half-up to whole dong', () => {
    expect(suggestOrderLostCost([{ quantity: '2', unitCost: '110000' }])).toBe('220000');
    expect(suggestOrderLostCost([{ quantity: '1', unitCost: '33333.333333' }])).toBe('33333');
    expect(suggestOrderLostCost([{ quantity: '2', unitCost: '33333.333333' }])).toBe('66667');
    expect(suggestOrderLostCost([{ quantity: '1', unitCost: '50.5' }])).toBe('51');
    expect(suggestOrderLostCost([{ quantity: '1.5', unitCost: '100000' }])).toBe('150000');
    expect(suggestOrderLostCost([{ quantity: '1', unitCost: '0' }])).toBe('0');
  });

  it('sums across multiple ship moves of one order before rounding once to whole dong', () => {
    expect(
      suggestOrderLostCost([
        { quantity: '1', unitCost: '33.5' },
        { quantity: '1', unitCost: '33.5' },
      ]),
    ).toBe('67');
    expect(
      suggestOrderLostCost([
        { quantity: '2', unitCost: '50000' },
        { quantity: '3', unitCost: '25000.2' },
      ]),
    ).toBe('175001');
  });

  it('returns null when the rounded whole-dong amount exceeds the 15-digit journal limit', () => {
    expect(suggestOrderLostCost([{ quantity: '10', unitCost: '100000000000000' }])).toBeNull();
  });

  it('pairs with monthFigures at the ship date month and ignores purchases in later months', () => {
    const moves: CostMove[] = [
      { date: '2026-10-02', quantity: '10', value: '1000000' },
      { date: '2026-10-12', quantity: '10', value: '1200000' },
      { date: '2026-10-15', quantity: '-2', value: null },
      { date: '2026-11-01', quantity: '10', value: '5000000' },
    ];
    const oct = monthFigures(moves, '2026-10');
    expect(oct?.unitCost).toBe('110000');
    expect(suggestOrderLostCost([{ quantity: '2', unitCost: oct?.unitCost ?? null }])).toBe('220000');
  });
});
