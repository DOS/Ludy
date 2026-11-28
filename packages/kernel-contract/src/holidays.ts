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

// The compensatory days off of a year (Labor Code 45/2019/QH14, Article 111(3): when the weekly rest day coincides with a public holiday of Article 112(1), the worker takes the weekly rest day
// off on the next working day). A holiday that falls on a Saturday or a Sunday, the weekly rest days of a state agency's five-day week (the tax authority's), moves one day off to the next day that is
// neither a Saturday, a Sunday, a holiday nor already a compensatory day. It is a separate list, used by the tax deadline rule (deadline-day.ts) only: isVietnamHoliday above, which the
// calendar and the e-invoice code read, is unchanged. The government also fixes the exact days of Tet and National Day each year (Article 112(3)) and may arrange the days around them differently;
// those moved days are not here, so the table is a default, not the notice.
const compensatoryDates = new Map<number, Set<string>>();
const isWeekend = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};
const dayAfter = (date: string): string => new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/** The compensatory days off of the year's public holidays that fall on a Saturday or a Sunday, in date order. */
export function vietnamCompensatoryDays(year: number): string[] {
  const holidays = new Set(vietnamHolidays(year).map((h) => h.date));
  const out: string[] = [];
  for (const holiday of [...holidays].sort()) {
    if (!isWeekend(holiday)) continue;
    let day = dayAfter(holiday);
    while (isWeekend(day) || holidays.has(day) || out.includes(day)) day = dayAfter(day);
    out.push(day);
  }
  return out;
}

/** True when `date` (YYYY-MM-DD) is the compensatory day off of a public holiday that fell on a Saturday or a Sunday. */
export function isCompensatoryDayOff(date: string): boolean {
  const year = Number(date.slice(0, 4));
  let dates = compensatoryDates.get(year);
  if (!dates) {
    dates = new Set(vietnamCompensatoryDays(year));
    compensatoryDates.set(year, dates);
  }
  return dates.has(date);
}
