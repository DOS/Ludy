// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Notes v2 T3 recurring personal to-do schemas, date math, and schedule shifting (#3557).
import { describe, expect, it } from 'vitest';
import {
  TODO_RESCHEDULE_BATCH_MAX,
  isSpringForwardDate,
  nextTodoOccurrenceDate,
  normalizeTodoRecurrence,
  recoverSpringForwardDueTime,
  shiftTodoSchedule,
  todoAutoReminder,
  todoDueInstant,
  todoLocalTime,
  zTodoComplete,
  zTodoRecurrence,
  zTodoReschedule,
} from '@ludy/kernel-contract';

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

describe('todo recurrence schemas (#3557)', () => {
  it('accepts valid daily, weekly, monthly and month-end rules', () => {
    expect(zTodoRecurrence.parse({ freq: 'daily', interval: 1 })).toEqual({ freq: 'daily', interval: 1 });
    expect(zTodoRecurrence.parse({ freq: 'weekly', interval: 2, byWeekday: 1 })).toEqual({ freq: 'weekly', interval: 2, byWeekday: 1 });
    expect(zTodoRecurrence.parse({ freq: 'monthly', interval: 1, byMonthDay: -1 })).toEqual({ freq: 'monthly', interval: 1, byMonthDay: -1 });
    expect(zTodoRecurrence.parse({ freq: 'monthly', interval: 3, byMonthDay: 31 })).toEqual({ freq: 'monthly', interval: 3, byMonthDay: 31 });
  });

  it('rejects out-of-range intervals, mismatched fields, invalid month days and extra keys', () => {
    expect(zTodoRecurrence.safeParse({ freq: 'daily', interval: 0 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'daily', interval: 366 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'daily', interval: 1, byWeekday: 2 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'daily', interval: 1, byMonthDay: 1 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'weekly', interval: 1, byMonthDay: 15 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'weekly', interval: 1, byWeekday: 7 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'monthly', interval: 1, byWeekday: 1 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'monthly', interval: 1, byMonthDay: 0 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'monthly', interval: 1, byMonthDay: -2 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'monthly', interval: 1, byMonthDay: 32 }).success).toBe(false);
    expect(zTodoRecurrence.safeParse({ freq: 'daily', interval: 1, extra: true }).success).toBe(false);
  });

  it('normalizes canonical recurrence keys without unspecified optionals', () => {
    expect(normalizeTodoRecurrence({ freq: 'daily', interval: 1, byWeekday: null, byMonthDay: undefined })).toEqual({
      freq: 'daily',
      interval: 1,
    });
    expect(normalizeTodoRecurrence({ freq: 'monthly', interval: 2, byMonthDay: -1, byWeekday: null })).toEqual({
      freq: 'monthly',
      interval: 2,
      byMonthDay: -1,
    });
  });

  it('validates and deduplicates zTodoReschedule and zTodoComplete', () => {
    expect(zTodoComplete.parse({ todoId: ID_1 })).toEqual({ todoId: ID_1 });
    expect(zTodoComplete.parse({ todoId: ID_1, stopSeries: true })).toEqual({ todoId: ID_1, stopSeries: true });
    expect(zTodoComplete.safeParse({ todoId: ID_1, extra: 1 }).success).toBe(false);

    const parsed = zTodoReschedule.parse({ todoIds: [ID_1, ID_2, ID_1], dueOn: '2026-11-20' });
    expect(parsed).toEqual({ todoIds: [ID_1, ID_2], dueOn: '2026-11-20' });
    expect(zTodoReschedule.safeParse({ todoIds: [], dueOn: '2026-11-20' }).success).toBe(false);
    expect(
      zTodoReschedule.safeParse({
        todoIds: Array.from({ length: TODO_RESCHEDULE_BATCH_MAX + 1 }, () => ID_1),
        dueOn: '2026-11-20',
      }).success,
    ).toBe(false);
  });
});

describe('nextTodoOccurrenceDate (#3557)', () => {
  it('advances daily and weekly rules accurately', () => {
    expect(nextTodoOccurrenceDate({ freq: 'daily', interval: 1 }, '2026-11-17')).toBe('2026-11-18');
    expect(nextTodoOccurrenceDate({ freq: 'daily', interval: 3 }, '2026-11-29')).toBe('2026-12-02');
    expect(nextTodoOccurrenceDate({ freq: 'weekly', interval: 1 }, '2026-11-17')).toBe('2026-11-24');
    expect(nextTodoOccurrenceDate({ freq: 'weekly', interval: 2 }, '2026-11-17')).toBe('2026-12-01');
  });

  it('advances weekly rules with explicit byWeekday', () => {
    // 2026-11-17 is Tuesday (weekday = 2).
    // Next Friday (5) falls in the same week; next Monday (1) advances by interval weeks.
    expect(nextTodoOccurrenceDate({ freq: 'weekly', interval: 1, byWeekday: 5 }, '2026-11-17')).toBe('2026-11-20');
    expect(nextTodoOccurrenceDate({ freq: 'weekly', interval: 1, byWeekday: 1 }, '2026-11-17')).toBe('2026-11-23');
    expect(nextTodoOccurrenceDate({ freq: 'weekly', interval: 2, byWeekday: 2 }, '2026-11-17')).toBe('2026-12-01');
  });

  it('advances monthly rules with clamping, leap years and end-of-month (-1)', () => {
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1 }, '2026-01-31')).toBe('2026-02-28');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1 }, '2024-01-31')).toBe('2024-02-29');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: 31 }, '2026-02-28')).toBe('2026-03-31');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: 25 }, '2026-03-10')).toBe('2026-03-25');

    // End of month (-1) hits last calendar day of the month.
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: -1 }, '2026-01-31')).toBe('2026-02-28');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: -1 }, '2026-02-28')).toBe('2026-03-31');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: -1 }, '2026-03-15')).toBe('2026-03-31');
    expect(nextTodoOccurrenceDate({ freq: 'monthly', interval: 1, byMonthDay: -1 }, '2024-02-28')).toBe('2024-02-29');
  });
});

describe('shiftTodoSchedule (#3557)', () => {
  it('preserves local due time and automatic reminder across DST transitions', () => {
    const dueBeforeDst = todoDueInstant('2026-03-07', '14:30', 'America/New_York');
    // Automatic reminder: 30 minutes before dueAt (14:00 local).
    const autoRemindBeforeDst = new Date(dueBeforeDst.getTime() - 30 * 60_000);
    const shifted = shiftTodoSchedule(
      { dueOn: '2026-03-07', dueAt: dueBeforeDst, timeZone: 'America/New_York', remindAt: autoRemindBeforeDst },
      '2026-03-09',
    );
    expect(shifted.dueOn).toBe('2026-03-09');
    expect(shifted.dueAt).not.toBeNull();
    expect(todoLocalTime(shifted.dueAt!, 'America/New_York')).toBe('14:30');
    expect(shifted.remindAt).not.toBeNull();
    expect(todoLocalTime(shifted.remindAt!, 'America/New_York')).toBe('14:00');
  });

  it('preserves custom reminder lead time and nulls when unset', () => {
    const dueAt = todoDueInstant('2026-11-17', '10:00', 'Asia/Ho_Chi_Minh');
    // Custom 2 hours before due time.
    const customRemind = new Date(dueAt.getTime() - 120 * 60_000);
    const shifted = shiftTodoSchedule(
      { dueOn: '2026-11-17', dueAt, timeZone: 'Asia/Ho_Chi_Minh', remindAt: customRemind },
      '2026-11-20',
    );
    expect(shifted.dueOn).toBe('2026-11-20');
    expect(todoLocalTime(shifted.dueAt!, 'Asia/Ho_Chi_Minh')).toBe('10:00');
    expect(todoLocalTime(shifted.remindAt!, 'Asia/Ho_Chi_Minh')).toBe('08:00');
    expect(shifted.dueAt!.getTime() - shifted.remindAt!.getTime()).toBe(120 * 60_000);

    const noRemind = shiftTodoSchedule({ dueOn: '2026-11-17', dueAt, timeZone: 'Asia/Ho_Chi_Minh', remindAt: null }, '2026-11-20');
    expect(noRemind.remindAt).toBeNull();
    expect(noRemind.dueTime).toBe('10:00');
  });

  it('preserves intended wall-clock dueTime across spring-forward DST gaps in America/New_York and Europe/London', () => {
    // America/New_York skips 02:00..02:59 on 2026-03-08.
    const nyDay1Due = todoDueInstant('2026-03-07', '02:30', 'America/New_York');
    const nyDay1Auto = todoAutoReminder({ dueOn: '2026-03-07', dueAt: nyDay1Due, timeZone: 'America/New_York' });
    const nyDay2 = shiftTodoSchedule(
      { dueOn: '2026-03-07', dueAt: nyDay1Due, timeZone: 'America/New_York', remindAt: nyDay1Auto },
      '2026-03-08',
    );
    expect(todoLocalTime(nyDay2.dueAt!, 'America/New_York')).toBe('03:30');
    expect(nyDay2.dueTime).toBe('02:30');

    const nyDay3 = shiftTodoSchedule({ ...nyDay2, timeZone: 'America/New_York' }, '2026-03-09');
    expect(nyDay3.dueTime).toBe('02:30');
    expect(todoLocalTime(nyDay3.dueAt!, 'America/New_York')).toBe('02:30');
    expect(nyDay3.dueAt!.toISOString()).toBe('2026-03-09T06:30:00.000Z');
    expect(todoLocalTime(nyDay3.remindAt!, 'America/New_York')).toBe('02:00');
    expect(nyDay3.remindAt!.toISOString()).toBe('2026-03-09T06:00:00.000Z');

    // Custom reminder lead duration (15 min before due) also survives the spring-forward gap.
    const nyCustomDay1 = new Date(nyDay1Due.getTime() - 15 * 60_000);
    const nyCustomDay2 = shiftTodoSchedule(
      { dueOn: '2026-03-07', dueAt: nyDay1Due, dueTime: '02:30', timeZone: 'America/New_York', remindAt: nyCustomDay1 },
      '2026-03-08',
    );
    const nyCustomDay3 = shiftTodoSchedule({ ...nyCustomDay2, timeZone: 'America/New_York' }, '2026-03-09');
    expect(todoLocalTime(nyCustomDay3.dueAt!, 'America/New_York')).toBe('02:30');
    expect(todoLocalTime(nyCustomDay3.remindAt!, 'America/New_York')).toBe('02:15');
    expect(nyCustomDay3.dueAt!.getTime() - nyCustomDay3.remindAt!.getTime()).toBe(15 * 60_000);

    // Europe/London skips 01:00..01:59 on 2026-03-29.
    const ukDay1Due = todoDueInstant('2026-03-28', '01:30', 'Europe/London');
    const ukDay1Auto = todoAutoReminder({ dueOn: '2026-03-28', dueAt: ukDay1Due, timeZone: 'Europe/London' });
    const ukDay2 = shiftTodoSchedule(
      { dueOn: '2026-03-28', dueAt: ukDay1Due, timeZone: 'Europe/London', remindAt: ukDay1Auto },
      '2026-03-29',
    );
    expect(todoLocalTime(ukDay2.dueAt!, 'Europe/London')).toBe('02:30');
    expect(ukDay2.dueTime).toBe('01:30');
    const ukDay3 = shiftTodoSchedule({ ...ukDay2, timeZone: 'Europe/London' }, '2026-03-30');
    expect(todoLocalTime(ukDay3.dueAt!, 'Europe/London')).toBe('01:30');
    expect(ukDay3.dueAt!.toISOString()).toBe('2026-03-30T00:30:00.000Z');
    expect(todoLocalTime(ukDay3.remindAt!, 'Europe/London')).toBe('01:00');
  });

  it('preserves local wall-clock time across fall-back DST transitions and in Asia/Ho_Chi_Minh', () => {
    // America/New_York repeats 01:00..01:59 on 2026-11-01; Europe/London repeats 01:00..01:59 on 2026-10-25.
    const nyFall1 = todoDueInstant('2026-10-31', '01:30', 'America/New_York');
    const nyFall2 = shiftTodoSchedule(
      { dueOn: '2026-10-31', dueAt: nyFall1, timeZone: 'America/New_York', remindAt: todoAutoReminder({ dueOn: '2026-10-31', dueAt: nyFall1, timeZone: 'America/New_York' }) },
      '2026-11-01',
    );
    const nyFall3 = shiftTodoSchedule({ ...nyFall2, timeZone: 'America/New_York' }, '2026-11-02');
    expect(todoLocalTime(nyFall2.dueAt!, 'America/New_York')).toBe('01:30');
    expect(todoLocalTime(nyFall3.dueAt!, 'America/New_York')).toBe('01:30');
    expect(nyFall3.dueAt!.toISOString()).toBe('2026-11-02T06:30:00.000Z');

    const ukFall1 = todoDueInstant('2026-10-24', '01:30', 'Europe/London');
    const ukFall2 = shiftTodoSchedule({ dueOn: '2026-10-24', dueAt: ukFall1, timeZone: 'Europe/London', remindAt: null }, '2026-10-25');
    const ukFall3 = shiftTodoSchedule({ ...ukFall2, timeZone: 'Europe/London' }, '2026-10-26');
    expect(todoLocalTime(ukFall2.dueAt!, 'Europe/London')).toBe('01:30');
    expect(todoLocalTime(ukFall3.dueAt!, 'Europe/London')).toBe('01:30');
    expect(ukFall3.dueAt!.toISOString()).toBe('2026-10-26T01:30:00.000Z');

    // Asia/Ho_Chi_Minh has no DST across March or November transition dates.
    const vnDue = todoDueInstant('2026-03-07', '02:30', 'Asia/Ho_Chi_Minh');
    const vnDay2 = shiftTodoSchedule(
      { dueOn: '2026-03-07', dueAt: vnDue, timeZone: 'Asia/Ho_Chi_Minh', remindAt: todoAutoReminder({ dueOn: '2026-03-07', dueAt: vnDue, timeZone: 'Asia/Ho_Chi_Minh' }) },
      '2026-03-08',
    );
    const vnDay3 = shiftTodoSchedule({ ...vnDay2, timeZone: 'Asia/Ho_Chi_Minh' }, '2026-03-09');
    expect(todoLocalTime(vnDay2.dueAt!, 'Asia/Ho_Chi_Minh')).toBe('02:30');
    expect(todoLocalTime(vnDay3.dueAt!, 'Asia/Ho_Chi_Minh')).toBe('02:30');
    expect(todoLocalTime(vnDay3.remindAt!, 'Asia/Ho_Chi_Minh')).toBe('02:00');
  });

  it('detects spring-forward transition days and recovers intended pre-gap dueTime safely', () => {
    expect(isSpringForwardDate('2026-03-08', 'America/New_York')).toBe(true);
    expect(isSpringForwardDate('2026-03-07', 'America/New_York')).toBe(false);
    expect(isSpringForwardDate('2026-03-09', 'America/New_York')).toBe(false);
    expect(isSpringForwardDate('2026-11-01', 'America/New_York')).toBe(false);
    expect(isSpringForwardDate('2026-03-29', 'Europe/London')).toBe(true);
    expect(isSpringForwardDate('2026-03-08', 'America/Havana')).toBe(true);
    expect(isSpringForwardDate('2026-03-08', 'Asia/Ho_Chi_Minh')).toBe(false);

    const gapDueAt = todoDueInstant('2026-03-08', '02:30', 'America/New_York');
    expect(
      recoverSpringForwardDueTime(
        { dueOn: '2026-03-08', dueAt: gapDueAt, timeZone: 'America/New_York' },
        [{ dueOn: '2026-03-07', dueAt: todoDueInstant('2026-03-07', '02:30', 'America/New_York'), timeZone: 'America/New_York' }],
      ),
    ).toBe('02:30');

    // Does not revert when user explicitly set 04:00 on the gap day or when the series was already 03:30.
    expect(
      recoverSpringForwardDueTime(
        { dueOn: '2026-03-08', dueAt: todoDueInstant('2026-03-08', '04:00', 'America/New_York'), timeZone: 'America/New_York' },
        [{ dueOn: '2026-03-07', dueAt: todoDueInstant('2026-03-07', '02:30', 'America/New_York'), timeZone: 'America/New_York' }],
      ),
    ).toBeNull();
    expect(
      recoverSpringForwardDueTime(
        { dueOn: '2026-03-08', dueAt: gapDueAt, timeZone: 'America/New_York' },
        [
          { dueOn: '2026-03-07', dueAt: todoDueInstant('2026-03-07', '03:30', 'America/New_York'), timeZone: 'America/New_York' },
          { dueOn: '2026-03-06', dueAt: todoDueInstant('2026-03-06', '02:30', 'America/New_York'), timeZone: 'America/New_York' },
        ],
      ),
    ).toBeNull();

    // Unsupported time zones fall back safely to DEFAULT_TIME_ZONE (Asia/Ho_Chi_Minh) without throwing.
    const fallbackShift = shiftTodoSchedule(
      { dueOn: '2026-03-07', dueAt: todoDueInstant('2026-03-07', '09:00', 'Asia/Ho_Chi_Minh'), timeZone: 'Mars/Olympus', remindAt: null },
      '2026-03-08',
    );
    expect(fallbackShift.dueTime).toBe('09:00');
    expect(todoLocalTime(fallbackShift.dueAt!, 'Asia/Ho_Chi_Minh')).toBe('09:00');
  });
});
