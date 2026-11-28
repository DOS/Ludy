// SPDX-License-Identifier: AGPL-3.0-only
// The day-off rule of a tax deadline (Decree 252/2026/NĐ-CP, Article 3(7)): a last day that is a Saturday, a Sunday or a public holiday is the next working day.
import { describe, expect, it } from 'vitest';
import { isDayOff, onOrAfterWorkingDay } from '../src/deadline-day.ts';

describe('isDayOff', () => {
  it('is true for a weekend and a public holiday of the shared calendar, false for a working day', () => {
    expect(isDayOff('2026-09-19')).toBe(true); // Saturday
    expect(isDayOff('2026-09-20')).toBe(true); // Sunday
    expect(isDayOff('2026-04-30')).toBe(true); // Thursday, Reunification Day
    expect(isDayOff('2026-02-20')).toBe(true); // Friday, in Tết
    expect(isDayOff('2026-10-20')).toBe(false); // Tuesday
  });
});

describe('onOrAfterWorkingDay', () => {
  it('keeps a working day', () => {
    expect(onOrAfterWorkingDay('2026-10-20')).toBe('2026-10-20');
    expect(onOrAfterWorkingDay('2027-03-31')).toBe('2027-03-31');
  });

  it('moves a weekend to the Monday', () => {
    expect(onOrAfterWorkingDay('2026-09-19')).toBe('2026-09-21');
    expect(onOrAfterWorkingDay('2026-09-20')).toBe('2026-09-21');
    // 31 January 2027 is a Sunday.
    expect(onOrAfterWorkingDay('2027-01-31')).toBe('2027-02-01');
  });

  it('moves a public holiday, and the holidays and weekend that follow it, to the next working day', () => {
    // Tết 2026 ends on Friday 20 February.
    expect(onOrAfterWorkingDay('2026-02-20')).toBe('2026-02-23');
    // 30 April and 1 May 2026 are a Thursday and a Friday, then the weekend.
    expect(onOrAfterWorkingDay('2026-04-30')).toBe('2026-05-04');
    // 30 April 2027 is a Friday, then the weekend.
    expect(onOrAfterWorkingDay('2027-04-30')).toBe('2027-05-03');
  });

  it('refuses a date that is not a calendar date', () => {
    expect(() => onOrAfterWorkingDay('2026-02-30')).toThrow(/not a calendar date/);
    expect(() => onOrAfterWorkingDay('30/04/2026')).toThrow(/not a calendar date/);
  });
});
