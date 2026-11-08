// SPDX-License-Identifier: AGPL-3.0-only
import { filterIssues } from '@crove/kernel-contract';
import { describe, expect, it } from 'vitest';
import { EMPTY_DEAL_FILTER, astToDealFilter, dealFilterToAst, dealSortOfValue, dealSortValue, isAmount } from '../src/lib/deal-filter.ts';
import { sameFilter } from '../src/lib/view-filter.ts';

const STAGE = '0192a2b0-7c1e-7000-8000-0000000000a1';
const OWNER = '0192a2b0-7c1e-7000-8000-0000000000b2';

describe('deal filter (CRM K3)', () => {
  it('turns the bar into conditions of the crm.deal scope, and nothing for an empty bar', () => {
    expect(dealFilterToAst(EMPTY_DEAL_FILTER)).toEqual({ v: 1, all: [] });
    const ast = dealFilterToAst({ search: ' nguyen ', stage: STAGE, status: 'open', owner: 'me', close: 'soon', amountMin: '1000000', amountMax: '5000000.50', rest: [] });
    expect(ast.all.map((c) => `${c.field}:${c.op}`)).toEqual(['search:contains', 'stage:in', 'status:is', 'owner:is_me', 'expected_close:within_next_days', 'amount:gte', 'amount:lte']);
    expect(ast.all[0]).toEqual({ field: 'search', op: 'contains', value: 'nguyen' });
    expect(ast.all[1]).toEqual({ field: 'stage', op: 'in', value: [STAGE] });
    expect(ast.all[4]).toEqual({ field: 'expected_close', op: 'within_next_days', value: 7 });
    // What the bar draws is always a filter the registry accepts.
    expect(filterIssues('crm.deal', ast)).toEqual([]);
    expect(filterIssues('crm.deal', dealFilterToAst({ ...EMPTY_DEAL_FILTER, owner: OWNER, close: 'overdue' }))).toEqual([]);
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, owner: 'none' }).all).toEqual([{ field: 'owner', op: 'is_empty' }]);
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, owner: OWNER }).all).toEqual([{ field: 'owner', op: 'is', value: OWNER }]);
  });

  it('leaves out an amount that is not a decimal the registry takes, instead of sending it', () => {
    expect(isAmount('1000000')).toBe(true);
    expect(isAmount(' 12.5 ')).toBe(true);
    for (const bad of ['', 'abc', '-5', '1e3', '1.234', '1,5', '12345678901234567']) expect(isAmount(bad), bad).toBe(false);
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, amountMin: '1e3', amountMax: 'x' }).all).toEqual([]);
    // An unknown owner text is not sent as a user id.
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, owner: 'someone' }).all).toEqual([]);
  });

  it('reads an amount typed with Vietnamese thousands separators as the registry takes it', () => {
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, amountMin: '1.000.000', amountMax: '2 500 000' }).all).toEqual([
      { field: 'amount', op: 'gte', value: '1000000' },
      { field: 'amount', op: 'lte', value: '2500000' },
    ]);
    // A decimal part keeps the dot, and a misplaced separator is refused rather than guessed.
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, amountMin: '12.5' }).all).toEqual([{ field: 'amount', op: 'gte', value: '12.5' }]);
    expect(dealFilterToAst({ ...EMPTY_DEAL_FILTER, amountMin: '1.00.000' }).all).toEqual([]);
  });

  it('reads a stored view back into the bar, keeping the conditions it cannot draw', () => {
    const stored = {
      v: 1 as const,
      all: [
        { field: 'party', op: 'is', value: STAGE },
        { field: 'status', op: 'is', value: 'won' },
        { field: 'stage', op: 'in', value: [STAGE, OWNER] },
        { field: 'created', op: 'within_last_days', value: 30 },
        { field: 'expected_close', op: 'before', value: '2026-12-31' },
        { field: 'owner', op: 'is_empty' },
      ],
    };
    const state = astToDealFilter(stored);
    expect(state).toMatchObject({ status: 'won', owner: 'none', stage: '', close: '' });
    expect(state.rest.map((c) => `${c.field}:${c.op}`)).toEqual(['party:is', 'stage:in', 'created:within_last_days', 'expected_close:before']);
    // Opening a view and applying it again changes nothing.
    expect(sameFilter(dealFilterToAst(state), stored)).toBe(true);
    // One stage and "soon" come back as the bar's own controls.
    expect(astToDealFilter({ v: 1, all: [{ field: 'stage', op: 'in', value: [STAGE] }, { field: 'expected_close', op: 'within_next_days', value: 7 }] })).toMatchObject({ stage: STAGE, close: 'soon' });
    // Another number of days is the view's own condition.
    expect(astToDealFilter({ v: 1, all: [{ field: 'expected_close', op: 'within_next_days', value: 14 }] }).rest).toHaveLength(1);
  });

  it('keeps a second condition on one control instead of losing it', () => {
    const state = astToDealFilter({ v: 1, all: [{ field: 'status', op: 'is', value: 'open' }, { field: 'status', op: 'is', value: 'won' }, { field: 'amount', op: 'gte', value: '1' }, { field: 'amount', op: 'gte', value: '2' }] });
    expect(state.status).toBe('open');
    expect(state.amountMin).toBe('1');
    expect(state.rest).toEqual([{ field: 'status', op: 'is', value: 'won' }, { field: 'amount', op: 'gte', value: '2' }]);
  });

  it('reads and writes the sort option', () => {
    expect(dealSortValue(null)).toBe('');
    expect(dealSortValue({ field: 'amount', dir: 'desc' })).toBe('amount:desc');
    expect(dealSortOfValue('expected_close:asc')).toEqual({ field: 'expected_close', dir: 'asc' });
    expect(dealSortOfValue('')).toBeNull();
    // A contact sort field is not a deal sort field.
    expect(dealSortOfValue('color:asc')).toBeNull();
  });
});
