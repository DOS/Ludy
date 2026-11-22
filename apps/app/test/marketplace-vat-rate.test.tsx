// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rate card of marketplace sales (#4303 S3a): what the lib offers and what a saved row looks like on the screen. The server checks every rule again; these pin only what the screen chooses to show.
import { describe, expect, it } from 'vitest';
import { currentSchedule, draftProblem, draftToRow, rowInForce, showPercent, suggestedRows, suggestionOffered, SUGGESTED_SCHEDULE } from '../src/lib/marketplace-vat-rate.ts';

const row = (effectiveFrom: string, vatPercent: string | null) => ({ effectiveFrom, method: vatPercent === null ? ('none' as const) : ('deduction' as const), vatPercent });

describe('marketplace VAT rate lib', () => {
  it('offers the suggestion only while the entity has no row, and writes nothing until the person has picked the method', () => {
    expect(suggestionOffered([])).toBe(true);
    expect(suggestionOffered([row('2026-01-01', '8')])).toBe(false);
    expect(suggestedRows([], '')).toEqual([]);
    expect(suggestedRows([], 'deduction')).toBe(SUGGESTED_SCHEDULE);
    expect(suggestedRows([], 'none')).toEqual([{ effectiveFrom: '2026-01-01', method: 'none', vatPercent: null }]);
    expect(suggestedRows([row('2026-01-01', '8')], 'deduction')).toEqual([]);
    expect(SUGGESTED_SCHEDULE.map((r) => `${r.effectiveFrom}:${r.vatPercent}`)).toEqual(['2026-01-01:8', '2027-01-01:10']);
  });

  it('finds the row in force on a date: the greatest date that has begun, the latest entry of that date', () => {
    const rows = [row('2026-01-01', '8'), row('2026-01-01', '80'), row('2027-01-01', '10')];
    expect(rowInForce(rows, '2025-12-31')).toBeNull();
    expect(rowInForce(rows, '2026-06-30')?.vatPercent).toBe('80');
    expect(rowInForce(rows, '2027-01-01')?.vatPercent).toBe('10');
  });

  it('shows the latest entry of each date, oldest date first, and keeps a corrected entry out of the schedule', () => {
    const entries = [row('2026-01-01', '8'), row('2026-01-01', '80'), row('2027-01-01', '10')];
    expect(currentSchedule(entries).map((r) => `${r.effectiveFrom}:${r.vatPercent}`)).toEqual(['2026-01-01:80', '2027-01-01:10']);
    expect(currentSchedule([])).toEqual([]);
  });

  it('says what is wrong with a row before it is sent, and takes a date that already has a row (a correction)', () => {
    expect(draftProblem({ effectiveFrom: '', method: 'deduction', vatPercent: '10' })).toBe('date');
    expect(draftProblem({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '' })).toBe('rate');
    expect(draftProblem({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '100.5' })).toBe('rate');
    expect(draftProblem({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10' })).toBeNull();
    expect(draftProblem({ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '10' })).toBeNull();
    expect(draftProblem({ effectiveFrom: '2027-01-01', method: 'none', vatPercent: 'ignored' })).toBeNull();
  });

  it('sends a none row without a rate and a deduction row with the trimmed rate', () => {
    expect(draftToRow({ effectiveFrom: '2027-01-01', method: 'none', vatPercent: '10' })).toEqual({ effectiveFrom: '2027-01-01', method: 'none', vatPercent: null });
    expect(draftToRow({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: ' 8.5 ' })).toEqual({ effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '8.5' });
  });

  it('shows a stored rate without trailing zeros', () => {
    expect(showPercent('8.00')).toBe('8');
    expect(showPercent('8.50')).toBe('8.5');
    expect(showPercent('10')).toBe('10');
    expect(showPercent('100.00')).toBe('100');
  });
});
