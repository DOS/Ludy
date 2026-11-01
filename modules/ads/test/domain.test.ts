// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's pure rules: days in an account's time zone, the window a sync reads, the settled day, and the cost per
// result in decimal.
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, costPerResult, currencyDecimals, historyStart, nextSettledThrough, resultsText, settleBefore, spendText, syncWindow, todayIn } from '../src/domain.ts';

describe('calendar days', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('adds months and clamps to the end of a shorter month', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', -13)).toBe('2025-10-15');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonths('2026-02-28', -12)).toBe('2025-02-28');
  });

  it('takes the history start 13 months back', () => {
    expect(historyStart('2026-11-15')).toBe('2025-10-15');
    expect(historyStart('2026-03-31')).toBe('2025-02-28');
  });

  it("finds today in the account's time zone, not the server's", () => {
    const instant = new Date('2026-11-20T18:00:00Z');
    expect(todayIn('Asia/Ho_Chi_Minh', instant)).toBe('2026-11-21');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-11-20');
    expect(todayIn('UTC', new Date('2026-11-20T23:59:59Z'))).toBe('2026-11-20');
  });
});

describe('the sync window', () => {
  it('reads the whole history first, then from the day after the last final day', () => {
    expect(syncWindow({ today: '2026-11-20', backfillFrom: '2025-10-20', settledThrough: null })).toEqual({ from: '2025-10-20', to: '2026-11-20' });
    expect(syncWindow({ today: '2026-11-20', backfillFrom: '2025-10-20', settledThrough: '2026-11-16' })).toEqual({ from: '2026-11-17', to: '2026-11-20' });
  });

  it('never starts before the history start or after today', () => {
    expect(syncWindow({ today: '2026-11-20', backfillFrom: '2026-11-01', settledThrough: '2026-10-01' })).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(syncWindow({ today: '2026-11-20', backfillFrom: '2025-10-20', settledThrough: '2026-11-20' })).toEqual({ from: '2026-11-20', to: '2026-11-20' });
  });

  it('settles the days before the revision window, or none for a platform with no window', () => {
    expect(settleBefore('2026-11-20', 3)).toBe('2026-11-17');
    expect(settleBefore('2026-11-20', 28)).toBe('2026-10-23');
    expect(settleBefore('2026-11-20', null)).toBeNull();
  });

  it('moves the last final day only when the read began right after the previous one', () => {
    const backfillFrom = '2025-10-20';
    // First read of the history: days before 2026-11-17 are final.
    expect(nextSettledThrough({ current: null, backfillFrom, window: { from: '2025-10-20', to: '2026-11-20' }, settleBefore: '2026-11-17' })).toBe('2026-11-16');
    // A later read from the day after: 2026-11-16 to 2026-11-20, final up to the new day before the window.
    expect(nextSettledThrough({ current: '2026-11-16', backfillFrom, window: { from: '2026-11-17', to: '2026-11-21' }, settleBefore: '2026-11-18' })).toBe('2026-11-17');
    // Nothing new is final.
    expect(nextSettledThrough({ current: '2026-11-16', backfillFrom, window: { from: '2026-11-17', to: '2026-11-17' }, settleBefore: '2026-11-17' })).toBe('2026-11-16');
    // A read that left a gap (it began later than the day after the last final one) moves nothing.
    expect(nextSettledThrough({ current: '2026-11-10', backfillFrom, window: { from: '2026-11-15', to: '2026-11-20' }, settleBefore: '2026-11-18' })).toBe('2026-11-10');
    // The first read of a young account stops where the read stops.
    expect(nextSettledThrough({ current: null, backfillFrom: '2026-11-01', window: { from: '2026-11-01', to: '2026-11-05' }, settleBefore: '2026-12-01' })).toBe('2026-11-05');
    // A platform with no revision window settles nothing.
    expect(nextSettledThrough({ current: null, backfillFrom, window: { from: '2025-10-20', to: '2026-11-20' }, settleBefore: null })).toBeNull();
    // A first read none of whose days is before the settle day leaves it null.
    expect(nextSettledThrough({ current: null, backfillFrom: '2026-11-18', window: { from: '2026-11-18', to: '2026-11-20' }, settleBefore: '2026-11-17' })).toBeNull();
  });
});

describe('cost per result', () => {
  it("rounds to the currency's smallest unit, half up", () => {
    expect(currencyDecimals('VND')).toBe(0);
    expect(currencyDecimals('USD')).toBe(2);
    expect(costPerResult('100000', '3', 'VND')).toBe('33333');
    expect(costPerResult('100000', '6', 'VND')).toBe('16667');
    expect(costPerResult('10', '3', 'USD')).toBe('3.33');
    expect(costPerResult('10.005', '1', 'USD')).toBe('10.01');
  });

  it('is null, never zero, when there is no result', () => {
    expect(costPerResult('100000', null, 'VND')).toBeNull();
    expect(costPerResult('100000', '0', 'VND')).toBeNull();
  });

  it('shows spend and results as text without float noise', () => {
    expect(spendText('0.1', 'USD')).toBe('0.10');
    expect(spendText('1000', 'VND')).toBe('1000');
    expect(spendText('10.456', 'USD')).toBe('10.46');
    expect(resultsText('3.0')).toBe('3');
    expect(resultsText('2.50')).toBe('2.5');
  });
});
