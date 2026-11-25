// SPDX-License-Identifier: AGPL-3.0-only
// The Home money tiles' rules (#4785) as pure functions: who may see the org's money totals, and the tiles built from summed balances on 112, 131 and 331. The books
// themselves are checked in apps/kernel/test/finance-home-money.db.test.ts.
import { describe, expect, it } from 'vitest';
import { buildHomeMoney, canSeeMoneyTotals } from '../src/domain/home-money.ts';
import type { ReportEntry } from '../src/domain/tt133-reports.ts';

const ENTITY = 'le-1';
const entry = (entryDate: string, lines: Array<[string, string, string] | [string, string, string, string]>, legalEntityId = ENTITY): ReportEntry => ({
  legalEntityId,
  entryDate,
  currency: 'VND',
  reversal: false,
  lines: lines.map(([accountCode, debit, credit, partyId]) => ({ accountCode, partyId: (partyId as string | undefined) ?? null, debit, credit })),
});
const standing = (role: string | null, permissions: string[] = [], roleKeys: string[] = []) => ({ role, permissions: new Set(permissions), roleKeys: new Set(roleKeys) });

describe('canSeeMoneyTotals', () => {
  it('shows owners and admins the totals without any finance permission', () => {
    expect(canSeeMoneyTotals(standing('owner'))).toBe(true);
    expect(canSeeMoneyTotals(standing('admin'))).toBe(true);
  });

  it('shows a member or viewer the totals only with a finance permission or finance role', () => {
    expect(canSeeMoneyTotals(standing('member'))).toBe(false);
    expect(canSeeMoneyTotals(standing('viewer'))).toBe(false);
    expect(canSeeMoneyTotals(standing('member', ['finance.vat.file']))).toBe(true);
    expect(canSeeMoneyTotals(standing('viewer', [], ['finance.viewer']))).toBe(true);
    expect(canSeeMoneyTotals(standing('member', [], ['external_accountant']))).toBe(true);
    expect(canSeeMoneyTotals(standing('member', ['notes.write'], ['hr.manager']))).toBe(false);
  });

  it('refuses a caller with no role in the org, whatever it holds', () => {
    expect(canSeeMoneyTotals(standing(null, ['finance.proposal.approve'], ['finance.accountant']))).toBe(false);
  });
});

describe('buildHomeMoney', () => {
  const names = new Map([['1121', 'Vietcombank'], ['1122', 'ACB']]);

  it('reads Chưa thu and Chưa trả as B01 lines 131 and 311: debit balances per customer, credit balances per supplier', () => {
    const entries = [
      entry('2026-10-01', [['131', '8000000', '0', 'c1'], ['511', '0', '8000000']]),
      entry('2026-10-02', [['131', '0', '3000000', 'c1'], ['112', '3000000', '0']]),
      // A customer who paid in advance is not owed to the org: its credit balance is not part of Chưa thu.
      entry('2026-10-03', [['112', '500000', '0'], ['131', '0', '500000', 'c2']]),
      entry('2026-10-04', [['642', '1500000', '0'], ['331', '0', '1500000', 'v1']]),
    ];
    expect(buildHomeMoney(entries, ENTITY, '2026-11-04', names)).toMatchObject({ receivables: '5000000', payables: '1500000' });
  });

  it('counts only entries up to the day and only the entity asked', () => {
    const entries = [entry('2026-10-01', [['112', '1000', '0'], ['4111', '0', '1000']]), entry('2026-11-05', [['112', '9000', '0'], ['4111', '0', '9000']]), entry('2026-10-01', [['112', '7000', '0'], ['4111', '0', '7000']], 'le-2')];
    expect(buildHomeMoney(entries, ENTITY, '2026-11-04', names)).toMatchObject({ bank: '1000', bankAccountCount: 1 });
  });

  it('nets the bank accounts, lists them by size with their names, and says an overdrawn one with its sign', () => {
    const entries = [entry('2026-10-01', [['1121', '4000000', '0'], ['4111', '0', '4000000']]), entry('2026-10-02', [['1122', '9000000', '0'], ['4111', '0', '9000000']]), entry('2026-10-03', [['642', '5000000', '0'], ['1121', '0', '5000000']])];
    const tiles = buildHomeMoney(entries, ENTITY, '2026-11-04', names);
    expect(tiles.bank).toBe('8000000');
    expect(tiles.bankAccounts).toEqual([
      { code: '1122', name: 'ACB', balance: '9000000' },
      { code: '1121', name: 'Vietcombank', balance: '-1000000' },
    ]);
  });

  it('lists at most five accounts and leaves out an account at zero, but the figure and the count keep every account with a balance', () => {
    const codes = ['1121', '1122', '1123', '1124', '1125', '1126'];
    const entries = [...codes.map((code, i) => entry('2026-10-01', [[code, String((i + 1) * 100), '0'], ['4111', '0', String((i + 1) * 100)]])), entry('2026-10-02', [['1127', '50', '0'], ['4111', '0', '50']]), entry('2026-10-03', [['642', '50', '0'], ['1127', '0', '50']])];
    const tiles = buildHomeMoney(entries, ENTITY, '2026-11-04', new Map());
    expect(tiles.bankAccountCount).toBe(6);
    expect(tiles.bankAccounts.map((a) => a.code)).toEqual(['1126', '1125', '1124', '1123', '1122']);
    expect(tiles.bankAccounts[0]).toEqual({ code: '1126', name: null, balance: '600' });
    expect(tiles.bank).toBe('2100');
  });

  it('is all zero for books with nothing on these accounts', () => {
    expect(buildHomeMoney([], ENTITY, '2026-11-04', names)).toEqual({ receivables: '0', payables: '0', bank: '0', bankAccounts: [], bankAccountCount: 0 });
  });
});
