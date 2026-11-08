// SPDX-License-Identifier: AGPL-3.0-only
// What a duplicate group has set (#2488): the terms are the kept party's, else the first duplicate's that has some, and the pause is the latest one anywhere in the
// group, so a pause is never lost to a merge or hidden by a row that holds only terms.
import { describe, expect, it } from 'vitest';
import { mergeGroupRows } from '../src/collection-settings.ts';

const row = (party_id: string, terms_days: number | null, paused_until: string | null) => ({ party_id, terms_days, paused_until });

describe('mergeGroupRows', () => {
  it('has nothing to say about a group with no row', () => {
    expect(mergeGroupRows([], 'k')).toBeUndefined();
  });

  it('takes the kept party\'s terms before a duplicate\'s', () => {
    expect(mergeGroupRows([row('a', 20, null), row('k', 45, null)], 'k')).toEqual({ terms_days: 45, paused_until: null });
  });

  it('takes the first duplicate\'s terms when the kept party has none, by party id', () => {
    expect(mergeGroupRows([row('a', 20, null), row('b', 40, null)], 'k')).toEqual({ terms_days: 20, paused_until: null });
    expect(mergeGroupRows([row('a', null, null), row('b', 40, null), row('k', null, null)], 'k')).toEqual({ terms_days: 40, paused_until: null });
  });

  it('keeps the latest pause of the group even when the kept party has a row without one', () => {
    expect(mergeGroupRows([row('a', null, '2027-01-01'), row('k', 45, null)], 'k')).toEqual({ terms_days: 45, paused_until: '2027-01-01' });
    expect(mergeGroupRows([row('a', null, '2027-01-01'), row('b', null, '2027-03-01'), row('k', null, '2026-12-01')], 'k')).toEqual({ terms_days: null, paused_until: '2027-03-01' });
  });
});
