// SPDX-License-Identifier: AGPL-3.0-only
// Vietnamese public holidays (Labor Code 45/2019/QH14, Article 112), moved out of calendar.ts so the deadline rules (deadline-day.ts)
// can use them without importing the calendar's schemas. calendar.ts re-exports everything here.

export interface PublicHoliday {
  date: string;
  name: string;
}

// The fixed-date holidays, every year.
const FIXED_HOLIDAYS: ReadonlyArray<{ monthDay: string; name: string }> = [
  { monthDay: '01-01', name: 'Tết Dương lịch' },
  { monthDay: '04-30', name: 'Ngày Giải phóng miền Nam' },
  { monthDay: '05-01', name: 'Ngày Quốc tế Lao động' },
  { monthDay: '09-02', name: 'Quốc khánh' },
];

// The holidays that follow the lunar calendar, per year: Tết (the last day of the lunar year and the first four days of
// the new one, the usual split of its five days) and the Hùng Kings' commemoration (10th day of the 3rd lunar month).
// The government sets each year's exact Tết days, the day next to 2 September and swapped working days by decision;
// an org adds those, and the compensatory days off, as its own days off. Extend this table each year.
const LUNAR_HOLIDAYS: Readonly<Record<number, readonly PublicHoliday[]>> = {
  2026: [
    ...['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2026-04-26', name: 'Giỗ Tổ Hùng Vương' },
  ],
  2027: [
    ...['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2027-04-16', name: 'Giỗ Tổ Hùng Vương' },
  ],
  2028: [
    ...['2028-01-25', '2028-01-26', '2028-01-27', '2028-01-28', '2028-01-29'].map((date) => ({ date, name: 'Tết Nguyên đán' })),
    { date: '2028-04-04', name: 'Giỗ Tổ Hùng Vương' },
  ],
};

/** The Vietnamese public holidays of a year, by date. A year beyond the lunar table has only the fixed-date ones. */
export function vietnamHolidays(year: number): PublicHoliday[] {
  const fixed = FIXED_HOLIDAYS.map((h) => ({ date: `${year}-${h.monthDay}`, name: h.name }));
  return [...fixed, ...(LUNAR_HOLIDAYS[year] ?? [])].sort((a, b) => a.date.localeCompare(b.date));
}

const holidayDates = new Map<number, Set<string>>();
/** True when `date` (YYYY-MM-DD) is a Vietnamese public holiday. */
export function isVietnamHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  let dates = holidayDates.get(year);
  if (!dates) {
    dates = new Set(vietnamHolidays(year).map((h) => h.date));
    holidayDates.set(year, dates);
  }
  return dates.has(date);
}
