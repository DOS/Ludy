// SPDX-License-Identifier: AGPL-3.0-only
// The 1381 rule at the close of a month of stock (#3712 slice 3), pure: the balance of the account's lines and when Circular 99's warning applies.
import { describe, expect, it } from 'vitest';
import { balanceOf, closeCheckApplies } from '../src/domain/stock-close-check.ts';

describe('the balance of 1381', () => {
  it('is debit minus credit, whole dong, and zero for no lines', () => {
    expect(balanceOf([])).toBe('0');
    expect(balanceOf([{ debit: '300000', credit: '0' }, { debit: '0', credit: '100000' }, { debit: '50000', credit: '0' }])).toBe('250000');
    expect(balanceOf([{ debit: '0', credit: '70000' }])).toBe('-70000');
    expect(balanceOf([{ debit: '100', credit: '0' }, { debit: '0', credit: '100' }])).toBe('0');
  });

  it('keeps decimals exact where JS numbers would not', () => {
    expect(balanceOf([{ debit: '0.1', credit: '0' }, { debit: '0.2', credit: '0' }, { debit: '0', credit: '0.3' }])).toBe('0');
  });
});

describe('when the warning applies', () => {
  it('only under Circular 99 and only for a debit balance', () => {
    expect(closeCheckApplies('tt99', '250000')).toBe(true);
    expect(closeCheckApplies('tt99', '0')).toBe(false);
    expect(closeCheckApplies('tt99', '-70000')).toBe(false);
    expect(closeCheckApplies('tt133', '250000')).toBe(false);
    expect(closeCheckApplies('unknown', '250000')).toBe(false);
  });
});
