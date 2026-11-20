// SPDX-License-Identifier: AGPL-3.0-only
// The earliest cut-over day of a bank feed mapping (#4218): the first-pull reach before a sync, and after one the first day the
// feed will still fetch, from the sandbox's day cursor and from Tingee's stamp.
import { describe, expect, it } from 'vitest';
import { earliestFeedFrom } from '../src/bank-feed.ts';

const now = new Date('2026-11-20T08:00:00Z');
const row = (cursor: string | null, feed_from: string | null = null) => ({ cursor, feed_from });

describe('earliestFeedFrom', () => {
  it('is the first-pull reach before a sync', () => {
    expect(earliestFeedFrom(now, 'bank_tingee', null)).toBe('2026-10-20');
    expect(earliestFeedFrom(now, 'bank_sandbox', row(null))).toBe('2026-11-13');
  });

  it('is the day after the sandbox cursor day, the last day pulled', () => {
    expect(earliestFeedFrom(now, 'bank_sandbox', row('2026-11-18'))).toBe('2026-11-19');
  });

  it('is the day after a Tingee stamp, except at midnight where the whole day is still fetched', () => {
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118083000'))).toBe('2026-11-19');
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118000000'))).toBe('2026-11-18');
  });

  it('keeps the day the mapping holds when that is later, and never goes under the reach', () => {
    expect(earliestFeedFrom(now, 'bank_sandbox', row('2026-11-18', '2026-11-19'))).toBe('2026-11-19');
    expect(earliestFeedFrom(now, 'bank_sandbox', row('2026-10-01'))).toBe('2026-11-13');
  });

  it('gives no day for a cursor it cannot read, or a day not on the calendar', () => {
    expect(earliestFeedFrom(now, 'bank_sandbox', row('garbage'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_sandbox', row('2026-02-30'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261340120000'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118246000'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118086000'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118083060'))).toBeNull();
    // Each provider reads only its own cursor: a 17-digit stamp or a day is not Tingee's, a stamp is not the sandbox's.
    expect(earliestFeedFrom(now, 'bank_tingee', row('20261118083000000'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_tingee', row('2026-11-18'))).toBeNull();
    expect(earliestFeedFrom(now, 'bank_sandbox', row('20261118083000'))).toBeNull();
  });
});
