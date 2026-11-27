// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for code-built "Việc của bạn" matching and redaction detection in meeting catch-up (#5130).
import { describe, expect, it } from 'vitest';
import { CATCH_UP_YOUR_ITEMS_MAX, REDACTION_MARK_BY_KIND } from '@ludy/kernel-contract';
import { hasRedactedMinutes, yourCatchUpItems, type CatchUpActionRow } from '../src/catch-up.ts';

const USER = 'user-an';
const OTHER = 'user-lan';

const row = (id: string, over: Partial<CatchUpActionRow> = {}): CatchUpActionRow => ({
  id,
  title: 'Gui bao gia',
  who_drafted: '',
  who_parsed: null,
  when_drafted: 'thu sau',
  when_parsed: null,
  status: 'suggested',
  task_id: null,
  ...over,
});

describe('yourCatchUpItems (#5130)', () => {
  it('matches by who_parsed userId first and avoids matching items assigned to another userId by name', () => {
    const items = [
      row('i1', { title: 'Viec 1', who_drafted: 'Lan', who_parsed: USER, status: 'accepted', task_id: 'task-1' }),
      row('i2', { title: 'Viec 2', who_drafted: 'An', who_parsed: OTHER }),
      row('i3', { title: 'Viec 3', who_drafted: 'chị An (Kế toán)', who_parsed: null }),
      row('i4', { title: 'Viec 4', who_drafted: 'Lan', who_parsed: null }),
      row('i5', { title: 'Viec 5', who_drafted: 'Toàn', who_parsed: null }),
    ];
    expect(yourCatchUpItems(items, USER, 'Nguyễn Thị An')).toEqual([
      {
        itemId: 'i1',
        title: 'Viec 1',
        who: 'Lan',
        when: 'thu sau',
        whenDate: null,
        status: 'accepted',
        taskId: 'task-1',
        matchedBy: 'user_id',
      },
      {
        itemId: 'i3',
        title: 'Viec 3',
        who: 'chị An (Kế toán)',
        when: 'thu sau',
        whenDate: null,
        status: 'suggested',
        taskId: null,
        matchedBy: 'name',
      },
    ]);
  });

  it('skips name fallback when askerName is empty and caps output at CATCH_UP_YOUR_ITEMS_MAX', () => {
    const emptyName = yourCatchUpItems([row('i1', { who_drafted: 'An' }), row('i2', { who_parsed: USER })], USER, '');
    expect(emptyName.map((i) => i.itemId)).toEqual(['i2']);

    const many = Array.from({ length: CATCH_UP_YOUR_ITEMS_MAX + 5 }, (_, idx) => row(`item-${idx}`, { who_parsed: USER }));
    expect(yourCatchUpItems(many, USER, 'An')).toHaveLength(CATCH_UP_YOUR_ITEMS_MAX);
  });

  it('detects every redaction marker across published minutes text', () => {
    expect(hasRedactedMinutes(['Chot ke hoach ban hang', 'Gui bao gia'])).toBe(false);
    for (const mark of Object.values(REDACTION_MARK_BY_KIND)) {
      expect(hasRedactedMinutes([`Thong tin ${mark}`])).toBe(true);
    }
  });
});
