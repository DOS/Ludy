// SPDX-License-Identifier: AGPL-3.0-only
import { filterIssues } from '@crove/kernel-contract';
import { describe, expect, it } from 'vitest';
import { EMPTY_CONTACT_FILTER, astToContactFilter, contactFilterToAst, sortOfValue, sortValue } from '../src/lib/contact-filter.ts';
import { sameFilter, sameSort } from '../src/lib/view-filter.ts';

describe('contact filter (CRM K4)', () => {
  it('turns the bar into conditions of the crm.party scope, and nothing for an empty bar', () => {
    expect(contactFilterToAst(EMPTY_CONTACT_FILTER)).toEqual({ v: 1, all: [] });
    const ast = contactFilterToAst({ search: '  nguyen ', kind: 'person', email: 'yes', phone: 'no', taxCode: '', rest: [] });
    expect(ast).toEqual({
      v: 1,
      all: [
        { field: 'search', op: 'contains', value: 'nguyen' },
        { field: 'kind', op: 'is', value: 'person' },
        { field: 'has_email', op: 'is', value: true },
        { field: 'has_phone', op: 'is', value: false },
      ],
    });
    // What the bar draws is always a filter the registry accepts.
    expect(filterIssues('crm.party', ast)).toEqual([]);
  });

  it('reads a stored view back into the bar, keeping the conditions it cannot draw', () => {
    const stored = {
      v: 1 as const,
      all: [
        { field: 'created', op: 'within_last_days', value: 7 },
        { field: 'has_tax_code', op: 'is', value: true },
        { field: 'search', op: 'contains', value: 'Lê' },
        { field: 'has_open_deal', op: 'is', value: false },
      ],
    };
    const state = astToContactFilter(stored);
    expect(state).toMatchObject({ search: 'Lê', taxCode: 'yes', kind: '', email: '', phone: '' });
    expect(state.rest).toEqual([
      { field: 'created', op: 'within_last_days', value: 7 },
      { field: 'has_open_deal', op: 'is', value: false },
    ]);
    // Opening a view and applying it again changes nothing.
    expect(sameFilter(contactFilterToAst(state), stored)).toBe(true);
  });

  it('tells filters apart by their conditions, not their order', () => {
    const a = { v: 1 as const, all: [{ field: 'kind', op: 'is', value: 'person' }, { field: 'has_email', op: 'is', value: true }] };
    const b = { v: 1 as const, all: [{ field: 'has_email', op: 'is', value: true }, { field: 'kind', op: 'is', value: 'person' }] };
    expect(sameFilter(a, b)).toBe(true);
    expect(sameFilter(a, { v: 1, all: [{ field: 'kind', op: 'is', value: 'organization' }] })).toBe(false);
    expect(sameFilter(a, { v: 1, all: [] })).toBe(false);
  });

  it('keeps a second condition on one flag instead of losing it', () => {
    const state = astToContactFilter({ v: 1, all: [{ field: 'has_email', op: 'is', value: true }, { field: 'has_email', op: 'is', value: false }] });
    expect(state.email).toBe('yes');
    expect(state.rest).toEqual([{ field: 'has_email', op: 'is', value: false }]);
  });

  it('reads and writes the sort option', () => {
    expect(sortValue(null)).toBe('');
    expect(sortValue({ field: 'name', dir: 'desc' })).toBe('name:desc');
    expect(sortOfValue('created:asc')).toEqual({ field: 'created', dir: 'asc' });
    expect(sortOfValue('')).toBeNull();
    // A deal sort is not a contact sort.
    expect(sortOfValue('amount:asc')).toBeNull();
    expect(sameSort(null, undefined)).toBe(true);
    expect(sameSort({ field: 'name', dir: 'asc' }, null)).toBe(false);
  });
});
