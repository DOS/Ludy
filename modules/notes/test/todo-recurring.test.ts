// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Notes v2 T3 recurring personal to-do schemas, date math, and schedule shifting (#3557).
import { describe, expect, it } from 'vitest';
import {
  TODO_RESCHEDULE_BATCH_MAX,
  nextTodoOccurrenceDate,
  normalizeTodoRecurrence,
  shiftTodoSchedule,
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
  });
});
