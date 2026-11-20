// SPDX-License-Identifier: AGPL-3.0-only
// The pure half of the column screen (#4036): a suggestion can only fill assignable columns and each field once, the mapping to check needs a platform and one column, a verdict belongs to the
// mapping it was made for, and a selection round-trips to assignments in column order.
import { describe, expect, it } from 'vitest';
import type { MarketplaceColumnSheet } from '@crove/kernel-contract';
import { assignableIndexes, checkIsStuck, assignmentsFrom, fieldsChosenTwice, mappingFrom, sameMappings, selectionFrom, verdictIsCurrent } from '../src/lib/marketplace-columns.ts';

const sheet: MarketplaceColumnSheet = {
  headerRow: 1,
  columns: [
    { index: 0, header: 'Order ID', samples: ['aaaaaa9999'], buyer: false },
    { index: 1, header: '', samples: [], buyer: true },
    { index: 2, header: 'Qty', samples: ['9'], buyer: false },
    { index: 3, header: 'Total', samples: ['999.999'], buyer: false },
  ],
};

describe('what may be picked', () => {
  it('offers every column but a buyer column', () => {
    expect(assignableIndexes(sheet)).toEqual([0, 2, 3]);
  });

  it('drops a suggestion for a buyer column, for an unknown column and a field already placed', () => {
    const selection = selectionFrom(sheet, [
      { index: 0, field: 'orderNo' },
      { index: 1, field: 'sku' }, // a buyer column
      { index: 9, field: 'amount' }, // not in the sheet
      { index: 2, field: 'orderNo' }, // the field is placed already
      { index: 0, field: 'quantity' }, // the column is taken already
      { index: 3, field: 'amount' },
    ]);
    expect(selection).toEqual({ 0: 'orderNo', 3: 'amount' });
  });
});

describe('the mapping a choice makes', () => {
  it('lists the assignments in column order and leaves an unused column out', () => {
    expect(assignmentsFrom({ 3: 'amount', 0: 'orderNo', 2: '' })).toEqual([
      { index: 0, field: 'orderNo' },
      { index: 3, field: 'amount' },
    ]);
  });

  it('needs a platform and a column, and refuses a field on two columns', () => {
    expect(mappingFrom('', { 0: 'orderNo' })).toBeNull();
    expect(mappingFrom('shopee', {})).toBeNull();
    expect(mappingFrom('shopee', { 0: 'sku', 2: 'sku' })).toBeNull();
    expect(fieldsChosenTwice({ 0: 'sku', 2: 'sku', 3: 'amount' })).toEqual(['sku']);
    expect(mappingFrom('lazada', { 2: 'quantity', 0: 'orderNo' })).toEqual({ platform: 'lazada', assignments: [{ index: 0, field: 'orderNo' }, { index: 2, field: 'quantity' }] });
  });

  it('compares two mappings by platform and every assignment, and ties a verdict to the mapping asked', () => {
    const a = mappingFrom('shopee', { 0: 'orderNo', 2: 'quantity' });
    const same = mappingFrom('shopee', { 2: 'quantity', 0: 'orderNo' });
    const other = mappingFrom('tiktok_shop', { 0: 'orderNo', 2: 'quantity' });
    expect(sameMappings(a, same)).toBe(true);
    expect(sameMappings(a, other)).toBe(false);
    expect(sameMappings(null, null)).toBe(true);
    expect(verdictIsCurrent(a, same)).toBe(true);
    expect(verdictIsCurrent(a, other)).toBe(false);
    // The sheet alone (no mapping asked) has no verdict to show.
    expect(verdictIsCurrent(null, null)).toBe(false);
  });
});

describe('a check whose job was lost', () => {
  const now = Date.parse('2026-11-20T12:00:00.000Z');
  it('is stuck only when it still waits and was asked ten minutes ago or more', () => {
    expect(checkIsStuck({ state: 'requested', requestedAt: '2026-11-20T11:49:00.000Z' }, now)).toBe(true);
    expect(checkIsStuck({ state: 'requested', requestedAt: '2026-11-20T11:50:00.000Z' }, now)).toBe(true);
    expect(checkIsStuck({ state: 'requested', requestedAt: '2026-11-20T11:51:00.000Z' }, now)).toBe(false);
    expect(checkIsStuck({ state: 'done', requestedAt: '2026-11-20T11:00:00.000Z' }, now)).toBe(false);
    expect(checkIsStuck({ state: 'requested', requestedAt: null }, now)).toBe(false);
    expect(checkIsStuck({ state: 'requested', requestedAt: 'not a date' }, now)).toBe(false);
    expect(checkIsStuck(undefined, now)).toBe(false);
  });
});
