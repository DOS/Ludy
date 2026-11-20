// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_FEE_CYCLE_DAYS, daysBetween, feeAge, oldestUnclearedFeeDate } from '../src/domain/marketplace-fee-age.ts';

const debit = (date: string, amount: string) => ({ date, debit: amount, credit: '0' });
const credit = (date: string, amount: string) => ({ date, debit: '0', credit: amount });

describe('how old the fees a platform kept are (#3711 slice 2)', () => {
  it('has no age when no fee is waiting', () => {
    expect(oldestUnclearedFeeDate([])).toBeNull();
    expect(oldestUnclearedFeeDate([debit('2026-08-01', '100'), credit('2026-09-01', '100')])).toBeNull();
    expect(feeAge([], '2026-11-19')).toEqual({ oldestFeeDate: null, feesAgeDays: null, feesOverdue: false });
  });
  it('is the date of the oldest debit nobody has cleared', () => {
    expect(oldestUnclearedFeeDate([debit('2026-09-10', '50'), debit('2026-08-01', '100')])).toBe('2026-08-01');
  });
  it('lets an invoice clear the oldest fees first, so the age is the next one\'s', () => {
    // 100 kept on 1 Aug, 50 on 10 Sep; an invoice of 100 on 15 Sep clears the August fees; the 50 of September is what waits.
    expect(oldestUnclearedFeeDate([debit('2026-08-01', '100'), debit('2026-09-10', '50'), credit('2026-09-15', '100')])).toBe('2026-09-10');
    // A part of the oldest still waits when the invoice is smaller than it.
    expect(oldestUnclearedFeeDate([debit('2026-08-01', '100'), credit('2026-09-15', '40')])).toBe('2026-08-01');
  });
  it('keeps an invoice that came before the payout and clears the next debit with it', () => {
    expect(oldestUnclearedFeeDate([credit('2026-08-01', '100'), debit('2026-08-20', '100')])).toBeNull();
    expect(oldestUnclearedFeeDate([credit('2026-08-01', '30'), debit('2026-08-20', '100')])).toBe('2026-08-20');
  });
  it('counts a debit before a credit of the same day, and the sum left equals the debit balance', () => {
    expect(oldestUnclearedFeeDate([credit('2026-08-01', '100'), debit('2026-08-01', '100')])).toBeNull();
    // A reversal of a payout credits 331 back on its own date: it clears the fees it took.
    expect(oldestUnclearedFeeDate([debit('2026-08-01', '100'), credit('2026-08-05', '100')])).toBeNull();
  });
  it('flags a balance only after one settlement cycle (45 days), not before', () => {
    expect(MARKETPLACE_FEE_CYCLE_DAYS).toBe(45);
    expect(feeAge([debit('2026-10-05', '10')], '2026-11-19')).toEqual({ oldestFeeDate: '2026-10-05', feesAgeDays: 45, feesOverdue: false });
    expect(feeAge([debit('2026-10-04', '10')], '2026-11-19')).toEqual({ oldestFeeDate: '2026-10-04', feesAgeDays: 46, feesOverdue: true });
  });
  it('counts whole days across month ends and never goes negative', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-11-20', '2026-11-19')).toBe(0);
  });
});
