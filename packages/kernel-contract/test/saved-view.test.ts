// SPDX-License-Identifier: AGPL-3.0-only
// The saved view registry (CRM plan 4.3, #2227): what a Filter AST may name, per scope, and what the commands refuse.
import { describe, expect, it } from 'vitest';
import {
  FILTER_MAX_CONDITIONS,
  SAVED_VIEW_SCOPES,
  filterIssues,
  isSavedViewScope,
  normalizeFilter,
  sortIssues,
  zSavedViewSave,
  zSavedViewSaveShape,
  type FilterAst,
} from '../src/saved-view.ts';

const ID = '0192a2b0-7c1e-7000-8000-000000000001';
const ast = (...all: FilterAst['all']): FilterAst => ({ v: 1, all });

describe('saved view registry', () => {
  it('knows the deal and the contact scope, and no other', () => {
    expect(Object.keys(SAVED_VIEW_SCOPES).sort()).toEqual(['crm.deal', 'crm.party']);
    expect(isSavedViewScope('crm.deal')).toBe(true);
    expect(isSavedViewScope('crm.nothing')).toBe(false);
    // Prototype names are not scopes, fields or operators.
    expect(isSavedViewScope('constructor')).toBe(false);
    expect(filterIssues('crm.deal', ast({ field: 'constructor', op: 'is' }))).toEqual([{ path: 'filters.all.0.field', code: 'unknown_field' }]);
    expect(filterIssues('crm.deal', ast({ field: 'owner', op: 'toString' }))).toEqual([{ path: 'filters.all.0.op', code: 'unknown_op' }]);
  });

  it('accepts every operator with a value of its kind', () => {
    const good: FilterAst['all'] = [
      { field: 'search', op: 'contains', value: ' Nguyễn ' },
      { field: 'stage', op: 'in', value: [ID] },
      { field: 'status', op: 'is', value: 'won' },
      { field: 'owner', op: 'is', value: ID },
      { field: 'owner', op: 'is_me' },
      { field: 'owner', op: 'is_empty' },
      { field: 'party', op: 'is', value: ID },
      { field: 'amount', op: 'gte', value: '1000.50' },
      { field: 'amount', op: 'lte', value: '5000000' },
    ];
    // At most 8 conditions: check them in two goes.
    expect(filterIssues('crm.deal', ast(...good.slice(0, 8)))).toEqual([]);
    expect(
      filterIssues(
        'crm.deal',
        ast(
          { field: 'expected_close', op: 'before', value: '2026-12-31' },
          { field: 'expected_close', op: 'after', value: '2026-01-01' },
          { field: 'expected_close', op: 'overdue' },
          { field: 'expected_close', op: 'within_next_days', value: 7 },
          { field: 'expected_close', op: 'is_empty' },
          { field: 'created', op: 'within_last_days', value: 30 },
        ),
      ),
    ).toEqual([]);
    expect(
      filterIssues(
        'crm.party',
        ast(
          { field: 'search', op: 'contains', value: 'x' },
          { field: 'kind', op: 'is', value: 'person' },
          { field: 'has_email', op: 'is', value: true },
          { field: 'has_phone', op: 'is', value: false },
          { field: 'has_tax_code', op: 'is', value: true },
          { field: 'has_open_deal', op: 'is', value: false },
          { field: 'created', op: 'within_last_days', value: 1 },
        ),
      ),
    ).toEqual([]);
  });

  it('refuses an unknown field or operator, a value of the wrong kind, and a repeated condition', () => {
    const bad = (c: FilterAst['all'][number]) => filterIssues('crm.deal', ast(c)).map((i) => i.code);
    expect(bad({ field: 'color', op: 'is', value: 'red' })).toEqual(['unknown_field']);
    expect(bad({ field: 'status', op: 'in', value: ['won'] })).toEqual(['unknown_op']);
    expect(bad({ field: 'status', op: 'is', value: 'pending' })).toEqual(['bad_value']);
    expect(bad({ field: 'status', op: 'is' })).toEqual(['bad_value']);
    expect(bad({ field: 'owner', op: 'is_me', value: ID })).toEqual(['unexpected_value']);
    expect(bad({ field: 'stage', op: 'in', value: [] })).toEqual(['bad_value']);
    expect(bad({ field: 'stage', op: 'in', value: ['not-an-id'] })).toEqual(['bad_value']);
    expect(bad({ field: 'amount', op: 'gte', value: 1000 })).toEqual(['bad_value']);
    expect(bad({ field: 'amount', op: 'gte', value: '1e3' })).toEqual(['bad_value']);
    expect(bad({ field: 'amount', op: 'gte', value: '-5' })).toEqual(['bad_value']);
    expect(bad({ field: 'amount', op: 'gte', value: '1.234' })).toEqual(['bad_value']);
    expect(bad({ field: 'expected_close', op: 'before', value: '2026-02-30' })).toEqual(['bad_value']);
    expect(bad({ field: 'expected_close', op: 'within_next_days', value: 0 })).toEqual(['bad_value']);
    expect(bad({ field: 'expected_close', op: 'within_next_days', value: 1.5 })).toEqual(['bad_value']);
    expect(bad({ field: 'search', op: 'contains', value: '   ' })).toEqual(['bad_value']);
    expect(bad({ field: 'search', op: 'contains', value: 'x'.repeat(101) })).toEqual(['bad_value']);
    // A party field is not a deal field and the other way round.
    expect(bad({ field: 'has_email', op: 'is', value: true })).toEqual(['unknown_field']);
    expect(filterIssues('crm.party', ast({ field: 'stage', op: 'in', value: [ID] }))).toEqual([{ path: 'filters.all.0.field', code: 'unknown_field' }]);
    // The same field and operator twice.
    expect(
      filterIssues('crm.deal', ast({ field: 'search', op: 'contains', value: 'a' }, { field: 'search', op: 'contains', value: 'b' })),
    ).toEqual([{ path: 'filters.all.1', code: 'duplicate' }]);
    // Another scope.
    expect(filterIssues('crm.nothing', ast())).toEqual([{ path: 'scope', code: 'unknown_scope' }]);
  });

  it('checks a sort against the scope’s sortable fields', () => {
    expect(sortIssues('crm.deal', null)).toEqual([]);
    expect(sortIssues('crm.deal', { field: 'expected_close', dir: 'asc' })).toEqual([]);
    expect(sortIssues('crm.deal', { field: 'title', dir: 'asc' })).toEqual([{ path: 'sort.field', code: 'unknown_sort_field' }]);
    expect(sortIssues('crm.party', { field: 'amount', dir: 'desc' })).toEqual([{ path: 'sort.field', code: 'unknown_sort_field' }]);
  });

  it('stores values as their schema reads them, and nothing else', () => {
    expect(
      normalizeFilter('crm.deal', ast({ field: 'search', op: 'contains', value: '  Lê  ' }, { field: 'owner', op: 'is_me' }, { field: 'status', op: 'is', value: 'open' })),
    ).toEqual({ v: 1, all: [{ field: 'search', op: 'contains', value: 'Lê' }, { field: 'owner', op: 'is_me' }, { field: 'status', op: 'is', value: 'open' }] });
  });

  it('shapes the command input: a new view, or a new filter for one', () => {
    const create = { scope: 'crm.deal', name: 'Của tôi', filters: ast({ field: 'owner', op: 'is_me' }), shared: false };
    expect(zSavedViewSave.safeParse(create).success).toBe(true);
    expect(zSavedViewSave.safeParse({ ...create, sort: { field: 'amount', dir: 'desc' } }).success).toBe(true);
    expect(zSavedViewSave.safeParse({ viewId: ID, filters: ast() }).success).toBe(true);
    // Unknown scope, field, operator or sort, or a name that is empty once trimmed.
    expect(zSavedViewSave.safeParse({ ...create, scope: 'crm.nothing' }).success).toBe(false);
    expect(zSavedViewSave.safeParse({ ...create, filters: ast({ field: 'color', op: 'is', value: 'x' }) }).success).toBe(false);
    expect(zSavedViewSave.safeParse({ ...create, sort: { field: 'color', dir: 'asc' } }).success).toBe(false);
    expect(zSavedViewSave.safeParse({ ...create, name: '   ' }).success).toBe(false);
    // The wire shape alone lets an unknown field through to the command, which answers 422 itself.
    expect(zSavedViewSaveShape.safeParse({ ...create, filters: ast({ field: 'color', op: 'is', value: 'x' }) }).success).toBe(true);
    // Version, shape and size of the AST are fixed.
    expect(zSavedViewSaveShape.safeParse({ ...create, filters: { v: 2, all: [] } }).success).toBe(false);
    expect(zSavedViewSaveShape.safeParse({ ...create, filters: { v: 1, all: [], extra: 1 } }).success).toBe(false);
    const nine = Array.from({ length: FILTER_MAX_CONDITIONS + 1 }, () => ({ field: 'a', op: 'b' }));
    expect(zSavedViewSaveShape.safeParse({ ...create, filters: { v: 1, all: nine } }).success).toBe(false);
  });
});
