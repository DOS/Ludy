// SPDX-License-Identifier: AGPL-3.0-only
// The expense side of the household income-method books (#2517, S2c): which accounts are expense accounts and which group a dated map row gives one. The map is data (dated rows), the longest prefix decides, and
// an account no row covers has no group: the book shows it apart and never guesses.
import { describe, expect, it } from 'vitest';
import { groupRowFor, isExpenseAccount } from '../src/domain/household-expense.ts';

const row = (group: string, prefix: string, from = '2026-01-01', status = 'commentary') => ({ expense_group: group, account_prefix: prefix, effective_from: from, status });

describe('isExpenseAccount', () => {
  it('takes TT133 classes 6 and 8 and their sub-accounts, and nothing else', () => {
    for (const code of ['611', '632', '635', '642', '6421', '642.A', '811']) expect(isExpenseAccount(code), code).toBe(true);
    for (const code of ['111', '156', '334', '511', '5111', '711', '911']) expect(isExpenseAccount(code), code).toBe(false);
  });
});

describe('groupRowFor', () => {
  const rows = [row('materials_goods', '632'), row('other', '642'), row('outside_services', '6421')];

  it('gives an account the group of the row whose prefix it starts with', () => {
    expect(groupRowFor('632', rows, '2026-09-30')?.expense_group).toBe('materials_goods');
    expect(groupRowFor('6322', rows, '2026-09-30')?.expense_group).toBe('materials_goods');
    expect(groupRowFor('6422', rows, '2026-09-30')?.expense_group).toBe('other');
  });

  it('lets the longest prefix refine a shorter one', () => {
    expect(groupRowFor('6421', rows, '2026-09-30')?.expense_group).toBe('outside_services');
    expect(groupRowFor('64211', rows, '2026-09-30')?.expense_group).toBe('outside_services');
  });

  it('has no group for an account no row covers, never a guess', () => {
    expect(groupRowFor('641', rows, '2026-09-30')).toBeNull();
    expect(groupRowFor('811', rows, '2026-09-30')).toBeNull();
  });

  it('reads the row in force on the date: a later dated row changes the next period and none before', () => {
    const dated = [row('other', '642', '2026-01-01'), row('wages_insurance', '642', '2026-10-01', 'confirmed')];
    expect(groupRowFor('642', dated, '2026-09-30')?.expense_group).toBe('other');
    expect(groupRowFor('642', dated, '2026-10-31')).toMatchObject({ expense_group: 'wages_insurance', status: 'confirmed' });
    // A row dated after the day is not in force yet.
    expect(groupRowFor('642', [row('other', '642', '2026-12-01')], '2026-09-30')).toBeNull();
  });
});
