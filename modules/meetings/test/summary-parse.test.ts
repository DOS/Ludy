// SPDX-License-Identifier: AGPL-3.0-only
// What code reads of a "who" and a "when" the model copied from a meeting (#2580, M6 part B1): a name is matched to one attendee or none, a date is read
// against the meeting's own day or not at all.
import { describe, expect, it } from 'vitest';
import { matchAttendee, parseWhen, plainName } from '../src/summary.ts';

// Tuesday 2026-11-10.
const DAY = '2026-11-10';

describe('parseWhen', () => {
  it('reads dates, today, tomorrow and weekdays against the meeting day', () => {
    expect(parseWhen('2026-11-13', DAY)).toBe('2026-11-13');
    expect(parseWhen('trước ngày 13/11', DAY)).toBe('2026-11-13');
    expect(parseWhen('13/11/2026', DAY)).toBe('2026-11-13');
    expect(parseWhen('hôm nay', DAY)).toBe('2026-11-10');
    expect(parseWhen('Ngày mai', DAY)).toBe('2026-11-11');
    expect(parseWhen('ngày kia', DAY)).toBe('2026-11-12');
    expect(parseWhen('tomorrow', DAY)).toBe('2026-11-11');
  });

  it('takes the next weekday after the meeting day, and tells thứ ba (Tuesday) from thứ bảy (Saturday)', () => {
    expect(parseWhen('thứ sáu', DAY)).toBe('2026-11-13');
    expect(parseWhen('thứ bảy', DAY)).toBe('2026-11-14');
    expect(parseWhen('thứ ba', DAY)).toBe('2026-11-17');
    expect(parseWhen('thứ tư', DAY)).toBe('2026-11-11');
    expect(parseWhen('chủ nhật', DAY)).toBe('2026-11-15');
    expect(parseWhen('Friday', DAY)).toBe('2026-11-13');
    expect(parseWhen('thứ hai', DAY)).toBe('2026-11-16');
  });

  it('answers null when it does not name one day for sure', () => {
    expect(parseWhen('', DAY)).toBeNull();
    expect(parseWhen('tuần sau', DAY)).toBeNull();
    expect(parseWhen('sớm', DAY)).toBeNull();
    expect(parseWhen('31/02', DAY)).toBeNull();
    expect(parseWhen('2026-13-45', DAY)).toBeNull();
    expect(parseWhen('09/11', DAY)).toBeNull();
    expect(parseWhen('ngày mai hoặc thứ sáu', DAY)).toBeNull();
    expect(parseWhen('hôm nay và ngày mai', DAY)).toBeNull();
  });

  it('stays fast on long text', () => {
    const started = performance.now();
    parseWhen('1/'.repeat(100) + '/'.repeat(100), DAY);
    parseWhen('9'.repeat(200), DAY);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('matchAttendee', () => {
  const people = [
    { userId: 'a', name: 'Nguyễn Thị Lan' },
    { userId: 'b', name: 'Trần Văn Nam' },
    { userId: 'c', name: 'Phạm Văn Hùng' },
  ];
  it('matches the whole name or one word of it, without marks or case', () => {
    expect(matchAttendee('Lan', people)).toBe('a');
    expect(matchAttendee('nguyen thi lan', people)).toBe('a');
    expect(matchAttendee('NAM', people)).toBe('b');
    expect(matchAttendee('Hùng', people)).toBe('c');
  });
  it('answers null for no one, for two people, and for nothing said', () => {
    expect(matchAttendee('Minh', people)).toBeNull();
    expect(matchAttendee('Văn', people)).toBeNull();
    expect(matchAttendee('', people)).toBeNull();
    expect(matchAttendee('Lan', [...people, { userId: 'd', name: 'Lê Lan' }])).toBeNull();
  });
  it('writes a name without marks', () => {
    expect(plainName('  Đặng  Thị   Hồng ')).toBe('dang thi hong');
  });
});
