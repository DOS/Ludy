// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { zCrmWonDealSignal, zFinanceSalesSignal } from '../src/signals.ts';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('the date of a signal row', () => {
  it('accepts a real day', () => {
    expect(zFinanceSalesSignal.safeParse({ partyId: ID, lastSaleOn: '2026-11-13', count: 1 }).success).toBe(true);
    expect(zFinanceSalesSignal.safeParse({ partyId: ID, lastSaleOn: '2028-02-29', count: 1 }).success).toBe(true);
  });

  it('fails the parse, and never throws, on a day that does not exist or is not a date', () => {
    for (const day of ['2026-02-30', '2026-13-45', '2026-00-10', '9999-99-99', 'Công ty A', '2026-1-1', '']) {
      const run = () => zFinanceSalesSignal.safeParse({ partyId: ID, lastSaleOn: day, count: 1 });
      expect(run, day).not.toThrow();
      expect(run().success, day).toBe(false);
      const deal = () => zCrmWonDealSignal.safeParse({ dealId: ID, partyId: ID, wonOn: day, amount: '1000' });
      expect(deal, day).not.toThrow();
      expect(deal().success, day).toBe(false);
    }
  });
});
