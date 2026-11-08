// SPDX-License-Identifier: AGPL-3.0-only
// The flags code puts on an action item's title (#2580): a way to reach someone off the page is flagged, and a hostile title costs linear time.
import { describe, expect, it } from 'vitest';
import { itemFlags } from '../src/results.ts';

describe('itemFlags', () => {
  it('flags links, emails and phone-like runs, and leaves plain titles alone', () => {
    expect(itemFlags('Gửi báo giá cho khách')).toEqual([]);
    expect(itemFlags('Gửi 3 bản cho 12 khách')).toEqual([]);
    expect(itemFlags('Xem HTTPS://evil.example/x')).toEqual(['contact_in_title']);
    expect(itemFlags('Gọi www.evil.example')).toEqual(['contact_in_title']);
    expect(itemFlags('Mail anh@evil.example nhé')).toEqual(['contact_in_title']);
    expect(itemFlags('Gọi 0912 345 678 ngay')).toEqual(['contact_in_title']);
    expect(itemFlags('Chi 100.000.000 đồng')).toEqual(['contact_in_title']);
    expect(itemFlags('họp @ 9.30')).toEqual([]);
    expect(itemFlags('a@b')).toEqual([]);
    expect(itemFlags('@.@.')).toEqual([]);
  });

  it('stays fast on long hostile titles (no backtracking)', () => {
    const hostile = ['!'.repeat(10_000), '@'.repeat(10_000), '!@'.repeat(5_000), 'a@'.repeat(5_000) + '.', '1 '.repeat(5_000), '.'.repeat(10_000), ('a@b' + '.'.repeat(50)).repeat(200)];
    const started = performance.now();
    for (const title of hostile) itemFlags(title);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('vnDayStart', () => {
  it('is the instant a Vietnam day begins, in UTC', async () => {
    const { vnDayStart } = await import('../src/retention.ts');
    expect(vnDayStart('2026-11-13')).toBe('2026-11-12T17:00:00.000Z');
    expect(vnDayStart('2026-01-01')).toBe('2025-12-31T17:00:00.000Z');
  });
});
