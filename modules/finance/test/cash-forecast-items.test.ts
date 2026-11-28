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

describe('a window that reaches the end of the calendar (year 9999)', () => {
  // addDays answers an extended year ('+010000-01') past the 9999-12-31, which is no date to compare as text: the window then ends on 9999-12-31, and a repeating item with no end date stops there instead of
  // counting months for ninety thousand years.
  it('stops a monthly item at 9999-12-31 and finds the dates before it, from the day whose window ends on it and from days whose 90 days run past it', () => {
    const monthly = item({ firstDate: '2026-01-31' });
    expect(occurrencesOf(monthly, '9999-10-03')).toEqual(['9999-10-31', '9999-11-30', '9999-12-31']);
    expect(occurrencesOf(monthly, '9999-10-02')).toEqual(['9999-10-31', '9999-11-30', '9999-12-31']);
    expect(occurrencesOf(monthly, '9999-11-01')).toEqual(['9999-11-30', '9999-12-31']);
    expect(occurrencesOf(monthly, '9999-12-31')).toEqual(['9999-12-31']);
  });

  it('does the same for a quarterly item and for a window whose 90 days end exactly on 9999-12-31', () => {
    const quarterly = item({ firstDate: '2026-01-31', recurrence: 'quarterly' });
    expect(occurrencesOf(quarterly, '9999-10-02')).toEqual(['9999-10-31']);
    expect(occurrencesOf(quarterly, '9999-12-31')).toEqual([]);
    // 9999-10-02 plus 90 days is 9999-12-31 itself (still a four-digit date).
    expect(occurrencesOf(item({ firstDate: '2026-12-31' }), '9999-10-02')).toEqual(['9999-10-31', '9999-11-30', '9999-12-31']);
  });

  it('finds a one-off and the next occurrence there, and none past the year 9999', () => {
    expect(occurrencesOf(item({ recurrence: 'once', firstDate: '2100-01-01' }), '9999-10-03')).toEqual([]);
    expect(nextOccurrence(item({ firstDate: '2026-01-31' }), '9999-10-03')).toBe('9999-10-31');
    expect(nextOccurrence(item({ firstDate: '2026-01-31' }), '9999-12-31')).toBe('9999-12-31');
  });

  it('answers at once even for the day the reviewers found: a hundred items from 9999-10-02 take no noticeable time', () => {
    const started = Date.now();
    for (let n = 0; n < 100; n++) occurrencesOf(item({ firstDate: '2026-01-31' }), '9999-10-02');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

