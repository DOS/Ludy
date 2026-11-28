// SPDX-License-Identifier: AGPL-3.0-only
// The compensatory days off of the public holidays that fall on a Saturday or a Sunday (Labor Code 45/2019/QH14, Article 111(3)), and that the holiday list the calendar reads is unchanged by them.
import { describe, expect, it } from 'vitest';
import { isCompensatoryDayOff, isVietnamHoliday, vietnamCompensatoryDays } from '../src/holidays.ts';

describe('vietnamCompensatoryDays', () => {
  it('gives the next working day after each holiday on a Saturday or a Sunday, in date order', () => {
    // 2026: only the Hùng Kings day (Sunday 26 April).
    expect(vietnamCompensatoryDays(2026)).toEqual(['2026-04-27']);
    // 2027: Tết has two days on the weekend (Saturday 6 and Sunday 7 February), and 1 May is a Saturday.
    expect(vietnamCompensatoryDays(2027)).toEqual(['2027-02-10', '2027-02-11', '2027-05-03']);
    // 2028: 1 January, the fifth day of Tết (29 January) and 2 September are Saturdays, and 30 April is a Sunday (1 May is itself a holiday, so the next working day is Tuesday 2 May).
    expect(vietnamCompensatoryDays(2028)).toEqual(['2028-01-03', '2028-01-31', '2028-05-02', '2028-09-04']);
  });

  it('skips a weekend and a day that is a holiday or already a compensatory day', () => {
    // 2027-02-10 follows the Tết days, so 2027-02-11 is the second one, not the 10th again.
    expect(new Set(vietnamCompensatoryDays(2027)).size).toBe(3);
    expect(vietnamCompensatoryDays(2025).every((d) => !isVietnamHoliday(d))).toBe(true);
  });
});

describe('isCompensatoryDayOff', () => {
  it('is true on a compensatory day and false on any other day', () => {
    expect(isCompensatoryDayOff('2027-05-03')).toBe(true);
    expect(isCompensatoryDayOff('2027-05-04')).toBe(false);
    expect(isCompensatoryDayOff('2027-05-01')).toBe(false);
  });

  it('does not change the public holidays the calendar reads', () => {
    expect(isVietnamHoliday('2027-05-03')).toBe(false);
    expect(isVietnamHoliday('2027-05-01')).toBe(true);
  });
});
