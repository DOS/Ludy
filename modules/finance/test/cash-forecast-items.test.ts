// SPDX-License-Identifier: AGPL-3.0-only
// The occurrences of an owner-entered cash forecast item (#5326): once, monthly and quarterly, the month ends that never drift, an inclusive end date, a first date in the past, and the 91-day window edges.
import { describe, expect, it } from 'vitest';
import { nextOccurrence, occurrencesOf, type RepeatingItem } from '../src/domain/cash-forecast-items.ts';

const item = (over: Partial<RepeatingItem>): RepeatingItem => ({ firstDate: '2026-12-05', recurrence: 'monthly', endDate: null, ...over });

describe('a one-off item', () => {
  it('falls once, on its date, when that date is in the window', () => {
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: '2026-12-20' }), '2026-12-01')).toEqual(['2026-12-20']);
  });

  it('counts day 0 and day 90 and nothing before or after them', () => {
    const today = '2026-12-01';
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: today }), today)).toEqual([today]);
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: '2027-03-01' }), today)).toEqual(['2027-03-01']);
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: '2027-03-02' }), today)).toEqual([]);
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: '2026-11-30' }), today)).toEqual([]);
  });
});

describe('a monthly item', () => {
  it('falls on the day of its first date each month of the window', () => {
    // Day 90 of 2026-12-01 is 2027-03-01, so the fifth of March is outside; day 90 of 2026-12-10 is 2027-03-10, so it is inside.
    expect(occurrencesOf(item({}), '2026-12-01')).toEqual(['2026-12-05', '2027-01-05', '2027-02-05']);
    expect(occurrencesOf(item({}), '2026-12-10')).toEqual(['2027-01-05', '2027-02-05', '2027-03-05']);
  });

  it('uses the last day of a short month and goes back to the day after it, never drifting', () => {
    const rent = item({ firstDate: '2026-01-31' });
    expect(occurrencesOf(rent, '2027-01-25', 100)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    // A leap February has a 29th.
    expect(occurrencesOf(item({ firstDate: '2027-12-31' }), '2028-01-25', 60)).toEqual(['2028-01-31', '2028-02-29']);
  });

  it('is found from a first date years in the past without walking every month', () => {
    expect(occurrencesOf(item({ firstDate: '2001-03-15' }), '2026-12-01')).toEqual(['2026-12-15', '2027-01-15', '2027-02-15']);
  });

  it('does not start before its first date', () => {
    expect(occurrencesOf(item({ firstDate: '2027-02-10' }), '2026-12-01')).toEqual(['2027-02-10']);
  });

  it('stops after an inclusive end date', () => {
    expect(occurrencesOf(item({ endDate: '2027-01-05' }), '2026-12-01')).toEqual(['2026-12-05', '2027-01-05']);
    expect(occurrencesOf(item({ endDate: '2027-01-04' }), '2026-12-01')).toEqual(['2026-12-05']);
    expect(occurrencesOf(item({ endDate: '2026-11-30' }), '2026-12-01')).toEqual([]);
  });
});

describe('a quarterly item', () => {
  it('falls every third month from its first date', () => {
    const insurance = item({ recurrence: 'quarterly', firstDate: '2026-01-31' });
    expect(occurrencesOf(insurance, '2026-12-01')).toEqual(['2027-01-31']);
    expect(occurrencesOf(insurance, '2027-02-01', 120)).toEqual(['2027-04-30']);
  });

  it('counts at most two occurrences in a window of 91 days', () => {
    expect(occurrencesOf(item({ recurrence: 'quarterly', firstDate: '2026-12-01' }), '2026-12-01')).toEqual(['2026-12-01', '2027-03-01']);
  });
});

describe('the next occurrence', () => {
  it('is the first date in the window, or null when none falls in it', () => {
    expect(nextOccurrence(item({}), '2026-12-01')).toBe('2026-12-05');
    expect(nextOccurrence(item({ recurrence: 'once', firstDate: '2026-11-01' }), '2026-12-01')).toBeNull();
    expect(nextOccurrence(item({ recurrence: 'once', firstDate: '2027-06-01' }), '2026-12-01')).toBeNull();
    expect(nextOccurrence(item({ endDate: '2026-12-04' }), '2026-12-01')).toBeNull();
  });
});
