// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for project starter templates, calendar/month-end recurrence math, and schemas (#2607).
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROJECT_TEMPLATE_KEYS,
  PROJECT_TEMPLATE_TASKS_MAX,
  zProjectCreateFromTemplateInput,
  zProjectTaskRecurrence,
  zProjectTemplateCreateInput,
} from '@ludy/kernel-contract';
import {
  addLocalDays,
  daysBetweenLocalDates,
  daysInMonth,
  nextProjectRecurrenceDate,
  starterProjectTemplates,
} from '../src/index.ts';

describe('project templates & recurring task rules (#2607)', () => {
  it('ships 3 localized starter templates within DB limits', () => {
    for (const language of ['vi', 'en'] as const) {
      const starters = starterProjectTemplates(language);
      expect(starters.map((s) => s.builtinKey)).toEqual([...BUILTIN_PROJECT_TEMPLATE_KEYS]);
      for (const tpl of starters) {
        expect(tpl.source).toBe('builtin');
        expect(tpl.name.trim().length).toBeGreaterThan(0);
        expect(tpl.tasks.length).toBeGreaterThan(0);
        expect(tpl.tasks.length).toBeLessThanOrEqual(PROJECT_TEMPLATE_TASKS_MAX);
        for (const item of tpl.tasks) {
          expect(item.title.trim().length).toBeGreaterThan(0);
          if (item.dueOffsetDays !== undefined && item.dueOffsetDays !== null) {
            expect(item.dueOffsetDays).toBeGreaterThanOrEqual(0);
            expect(item.dueOffsetDays).toBeLessThanOrEqual(365);
          }
        }
      }
    }
  });

  it('computes weekly recurrence across week boundaries and intervals', () => {
    // 2026-11-17 is Tuesday (weekday = 2).
    const sameWeekFriday = { cadence: 'weekly' as const, interval: 2, weekday: 5, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(sameWeekFriday, '2026-11-17')).toBe('2026-11-20');
    expect(nextProjectRecurrenceDate(sameWeekFriday, '2026-11-20')).toBe('2026-12-04');

    const everyTwoTuesdays = { cadence: 'weekly' as const, interval: 2, weekday: 2, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(everyTwoTuesdays, '2026-11-17')).toBe('2026-12-01');
    expect(nextProjectRecurrenceDate(everyTwoTuesdays, '2026-12-01')).toBe('2026-12-15');

    const sundayRule = { cadence: 'weekly' as const, interval: 1, weekday: 0, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(sundayRule, '2026-11-17')).toBe('2026-11-22');
  });

  it('computes monthly recurrence for fixed days and month-end -1 including leap years', () => {
    const fixedDay = { cadence: 'monthly' as const, interval: 1, monthDay: 15, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(fixedDay, '2026-11-10')).toBe('2026-11-15');
    expect(nextProjectRecurrenceDate(fixedDay, '2026-11-15')).toBe('2026-12-15');
    expect(nextProjectRecurrenceDate(fixedDay, '2026-12-15')).toBe('2027-01-15');

    const quarterlyDay = { cadence: 'monthly' as const, interval: 3, monthDay: 5, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(quarterlyDay, '2026-11-05')).toBe('2027-02-05');

    const monthEnd = { cadence: 'monthly' as const, interval: 1, monthDay: -1, timeZone: 'Asia/Ho_Chi_Minh' };
    expect(nextProjectRecurrenceDate(monthEnd, '2026-11-15')).toBe('2026-11-30');
    expect(nextProjectRecurrenceDate(monthEnd, '2026-11-30')).toBe('2026-12-31');
    expect(nextProjectRecurrenceDate(monthEnd, '2026-12-31')).toBe('2027-01-31');
    expect(nextProjectRecurrenceDate(monthEnd, '2027-01-31')).toBe('2027-02-28');
    expect(nextProjectRecurrenceDate(monthEnd, '2027-02-28')).toBe('2027-03-31');
    // 2028 is a leap year.
    expect(nextProjectRecurrenceDate(monthEnd, '2028-01-31')).toBe('2028-02-29');
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('respects until date boundary strictly', () => {
    const rule = {
      cadence: 'weekly' as const,
      interval: 1,
      weekday: 2,
      timeZone: 'Asia/Ho_Chi_Minh',
      until: '2026-11-24',
    };
    expect(nextProjectRecurrenceDate(rule, '2026-11-17')).toBe('2026-11-24');
    expect(nextProjectRecurrenceDate(rule, '2026-11-24')).toBeNull();
  });

  it('handles calendar day arithmetic cleanly', () => {
    expect(addLocalDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(daysBetweenLocalDates('2027-01-02', '2026-12-30')).toBe(3);
  });

  it('validates recurrence & template schemas cleanly', () => {
    expect(zProjectTaskRecurrence.safeParse({ cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' }).success).toBe(true);
    expect(zProjectTaskRecurrence.safeParse({ cadence: 'monthly', interval: 1, monthDay: -1, timeZone: 'Asia/Ho_Chi_Minh' }).success).toBe(true);
    expect(zProjectTaskRecurrence.safeParse({ cadence: 'weekly', interval: 1, monthDay: 1, timeZone: 'Asia/Ho_Chi_Minh' }).success).toBe(false);
    expect(zProjectTaskRecurrence.safeParse({ cadence: 'monthly', interval: 1, monthDay: 30, timeZone: 'Asia/Ho_Chi_Minh' }).success).toBe(false);

    expect(zProjectTemplateCreateInput.safeParse({ name: 'T', tasks: [{ title: 'A', dueOffsetDays: 0 }] }).success).toBe(true);
    expect(
      zProjectTemplateCreateInput.safeParse({
        name: 'T',
        tasks: [{ title: 'A', tainted: true } as unknown as { title: string }],
      }).success,
    ).toBe(false);
    expect(zProjectTemplateCreateInput.safeParse({ name: 'T' }).success).toBe(false);
    expect(
      zProjectTemplateCreateInput.safeParse({
        name: 'T',
        sourceProjectId: '10000000-0000-4000-8000-000000000001',
        tasks: [],
      }).success,
    ).toBe(false);

    expect(zProjectCreateFromTemplateInput.safeParse({ builtinKey: 'monthly-close' }).success).toBe(true);
    expect(zProjectCreateFromTemplateInput.safeParse({}).success).toBe(false);
  });
});
