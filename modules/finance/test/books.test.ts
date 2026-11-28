// SPDX-License-Identifier: AGPL-3.0-only
// The date and label helpers of the books regime (issue #1403). The chart an entity keeps on a date is read from the database and tested on a real PostgreSQL (apps/kernel/test/finance-opening-balance.db.test.ts).
import { describe, expect, it } from 'vitest';
import { TT133_BOOKS, dayAfter, isTt133Books, regimeLabel } from '../src/books.ts';

describe('dayAfter', () => {
  it('moves to the next calendar day across month, year and leap days', () => {
    expect(dayAfter('2025-12-31')).toBe('2026-01-01');
    expect(dayAfter('2026-01-31')).toBe('2026-02-01');
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
    expect(dayAfter('2028-02-29')).toBe('2028-03-01');
    expect(dayAfter('2026-02-28')).toBe('2026-03-01');
    expect(dayAfter('2026-06-14')).toBe('2026-06-15');
  });
});

describe('books regime helpers', () => {
  it('knows TT133 2026.1 from any other chart', () => {
    expect(isTt133Books(TT133_BOOKS)).toBe(true);
    expect(isTt133Books({ regime: 'tt133', version: '2028.1' })).toBe(false);
    expect(isTt133Books({ regime: 'tt99', version: '2026.1' })).toBe(false);
  });

  it('names a regime for a person', () => {
    expect(regimeLabel('tt99')).toBe('Thông tư 99');
    expect(regimeLabel('tt133')).toBe('Thông tư 133');
    expect(regimeLabel('other')).toBe('other');
  });
});
