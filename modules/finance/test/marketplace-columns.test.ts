// SPDX-License-Identifier: AGPL-3.0-only
// Whether a stored column check request is for the mapping asked (#4036): compared field by field, since the database keeps a jsonb object's keys in its own order (length, then bytes), so the stored form
// of `{ index, field }` is `{ field, index }` and the text of one is never the text of the other.
import { describe, expect, it } from 'vitest';
import type { MarketplaceColumnMapping } from '@crove/kernel-contract';
import { sameMapping } from '../src/marketplace-columns.ts';

const ASKED: MarketplaceColumnMapping = { platform: 'shopee', assignments: [{ index: 0, field: 'orderNo' }, { index: 2, field: 'quantity' }] };
// What jsonb hands back: the keys of each object in the database's order.
const STORED = { platform: 'shopee', assignments: [{ field: 'orderNo', index: 0 }, { field: 'quantity', index: 2 }] };

describe('sameMapping', () => {
  it('knows the mapping asked from the one stored, whatever order the stored keys come in', () => {
    expect(sameMapping(STORED, ASKED)).toBe(true);
    expect(sameMapping({ platform: 'shopee', assignments: ASKED.assignments }, ASKED)).toBe(true);
  });

  it('tells another platform, another column, another field, another count and another order apart', () => {
    expect(sameMapping({ ...STORED, platform: 'lazada' }, ASKED)).toBe(false);
    expect(sameMapping({ ...STORED, assignments: [{ field: 'orderNo', index: 1 }, { field: 'quantity', index: 2 }] }, ASKED)).toBe(false);
    expect(sameMapping({ ...STORED, assignments: [{ field: 'orderNo', index: 0 }, { field: 'amount', index: 2 }] }, ASKED)).toBe(false);
    expect(sameMapping({ ...STORED, assignments: [{ field: 'orderNo', index: 0 }] }, ASKED)).toBe(false);
    expect(sameMapping({ ...STORED, assignments: [STORED.assignments[1], STORED.assignments[0]] }, ASKED)).toBe(false);
  });

  it('takes no mapping as the sheet alone: no platform and no assignments', () => {
    expect(sameMapping({ platform: null, assignments: [] }, undefined)).toBe(true);
    expect(sameMapping(STORED, undefined)).toBe(false);
    expect(sameMapping({ platform: null, assignments: [] }, ASKED)).toBe(false);
    // A stored value that is no array (a row written by hand) is nothing, never a match for a mapping.
    expect(sameMapping({ platform: 'shopee', assignments: null }, ASKED)).toBe(false);
  });
});
