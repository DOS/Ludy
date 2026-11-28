// SPDX-License-Identifier: AGPL-3.0-only
// The regime rules of a purchase proposal (issue #1403, TT99 books): approval, revision, learning and the offered rules.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@ludy/kernel-runtime';
import { approvalRegimeRefused, booksRegimeChanged, chartChangeRefused, learnsRules, reviseRegimeRefused, rulesForBooks, voucherRegimeRefused } from '../src/purchase-regime.ts';

const TT99 = { regime: 'tt99', version: '2026.1' };
const TT99_NEXT = { regime: 'tt99', version: '2027.1' };
const TT133 = { regime: 'tt133', version: '2026.1' };

describe('approvalRegimeRefused', () => {
  it('refuses a purchase with no regime on a code the circulars define differently once the books are TT99', () => {
    for (const code of ['211', '3386', '6421', '6422']) {
      expect(approvalRegimeRefused({ carried: undefined, current: TT99, accounts: ['156', code] })).toBe(true);
    }
  });

  it('lets a purchase with no regime post under TT99 on accounts both charts share, and under TT133 whatever the accounts', () => {
    expect(approvalRegimeRefused({ carried: undefined, current: TT99, accounts: ['156', '6427', '642'] })).toBe(false);
    expect(approvalRegimeRefused({ carried: undefined, current: undefined, accounts: ['6421', '211'] })).toBe(false);
  });

  it('refuses a proposal that carries a regime once the books are another one, or back to TT133', () => {
    expect(approvalRegimeRefused({ carried: 'tt99', current: undefined, accounts: ['156'] })).toBe(true);
    expect(approvalRegimeRefused({ carried: 'tt99', current: TT133, accounts: ['156'] })).toBe(true);
    expect(approvalRegimeRefused({ carried: 'tt133', current: TT99, accounts: ['156'] })).toBe(true);
  });

  it('posts a proposal that carries the regime still in force, whatever the accounts (the account check decides those)', () => {
    expect(approvalRegimeRefused({ carried: 'tt99', current: TT99, accounts: ['6421'] })).toBe(false);
    expect(approvalRegimeRefused({ carried: 'tt133', current: TT133, accounts: ['6421'] })).toBe(false);
  });

  it('holds a proposal to the version of the chart it carries, and to the regime alone when it carries none', () => {
    expect(approvalRegimeRefused({ carried: 'tt99', carriedVersion: '2026.1', current: TT99_NEXT, accounts: ['156'] })).toBe(true);
    expect(approvalRegimeRefused({ carried: 'tt99', carriedVersion: '2026.1', current: TT99, accounts: ['156'] })).toBe(false);
    expect(approvalRegimeRefused({ carried: 'tt99', current: TT99_NEXT, accounts: ['156'] })).toBe(false);
  });
});

describe('chartChangeRefused', () => {
  it('refuses a mirror of a line on a changed-meaning code into the books of another chart', () => {
    for (const code of ['211', '3386', '6421', '6422']) {
      expect(chartChangeRefused({ from: TT133, to: TT99, accounts: ['156', code] })).toBe(true);
      expect(chartChangeRefused({ from: TT99, to: TT99_NEXT, accounts: [code] })).toBe(true);
    }
  });

  it('lets the mirror through when the chart is the same, or no line is on a changed-meaning code', () => {
    expect(chartChangeRefused({ from: TT99, to: TT99, accounts: ['6421'] })).toBe(false);
    expect(chartChangeRefused({ from: TT133, to: TT99, accounts: ['156', '331', '6427'] })).toBe(false);
  });
});

describe('reviseRegimeRefused', () => {
  it('refuses a revision across a regime change, in both directions and from none', () => {
    expect(reviseRegimeRefused({ regime: undefined, version: undefined }, TT99)).toBe(true);
    expect(reviseRegimeRefused({ regime: 'tt99', version: '2026.1' }, undefined)).toBe(true);
    expect(reviseRegimeRefused({ regime: 'tt99', version: '2026.1' }, TT133)).toBe(true);
  });

  it('accepts a revision under the regime the proposal carries', () => {
    expect(reviseRegimeRefused({ regime: undefined, version: undefined }, undefined)).toBe(false);
    expect(reviseRegimeRefused({ regime: 'tt99', version: '2026.1' }, TT99)).toBe(false);
    expect(reviseRegimeRefused({ regime: 'tt99', version: undefined }, TT99)).toBe(false);
  });

  it('refuses a revision under another version of the chart the proposal carries', () => {
    expect(reviseRegimeRefused({ regime: 'tt99', version: '2026.1' }, TT99_NEXT)).toBe(true);
  });
});

describe('voucherRegimeRefused', () => {
  it('holds a stamped voucher to the books it was prepared under, the chart version included when it carries one', () => {
    expect(voucherRegimeRefused({ carried: 'tt99', carriedVersion: '2026.1', current: TT99, accounts: ['6421'] })).toBe(false);
    expect(voucherRegimeRefused({ carried: 'tt99', carriedVersion: '2026.1', current: TT133, accounts: ['156'] })).toBe(true);
    expect(voucherRegimeRefused({ carried: 'tt99', carriedVersion: '2026.1', current: TT99_NEXT, accounts: ['156'] })).toBe(true);
    expect(voucherRegimeRefused({ carried: 'tt99', carriedVersion: undefined, current: TT99_NEXT, accounts: ['156'] })).toBe(false);
  });

  it('refuses an unstamped voucher under other books only on a code the two circulars define differently', () => {
    for (const code of ['211', '3386', '6421', '6422']) {
      expect(voucherRegimeRefused({ carried: undefined, carriedVersion: undefined, current: TT99, accounts: ['111', code] })).toBe(true);
      expect(voucherRegimeRefused({ carried: undefined, carriedVersion: undefined, current: TT133, accounts: [code] })).toBe(false);
    }
    expect(voucherRegimeRefused({ carried: undefined, carriedVersion: undefined, current: TT99, accounts: ['111', '156', '331'] })).toBe(false);
  });
});

describe('booksRegimeChanged', () => {
  it('is the named 409 error with both regimes', () => {
    const error = booksRegimeChanged('tt99', undefined);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'BOOKS_REGIME_CHANGED', status: 409, details: { proposed: 'tt99', current: null } });
  });

  it('names the versions when it is given them', () => {
    expect(booksRegimeChanged('tt99', 'tt99', { proposed: '2026.1', current: '2027.1' })).toMatchObject({ details: { proposedVersion: '2026.1', currentVersion: '2027.1' } });
  });
});

describe('learnsRules', () => {
  it('learns only from a purchase that posts under TT133', () => {
    expect(learnsRules(false, undefined)).toBe(true);
    expect(learnsRules(false, 'tt99')).toBe(false);
    expect(learnsRules(true, undefined)).toBe(false);
    expect(learnsRules(true, 'tt99')).toBe(false);
  });
});

describe('rulesForBooks', () => {
  const chart = new Set(['156', '6427', '6421', '3386']);

  it('keeps the rules on accounts the chart has and means the same by, and drops the others', () => {
    const rules = [{ account: '6427' }, { account: '5111' }, { account: '6421' }, { account: '156' }];
    const offered = rulesForBooks({ vendorDefault: '156', learnedRules: rules, inChart: (code) => chart.has(code) });
    expect(offered.vendorDefault).toBe('156');
    expect(offered.learnedRules).toEqual([{ account: '6427' }, { account: '156' }]);
  });

  it('drops a vendor default the chart lacks or that changed meaning, and keeps none as none', () => {
    expect(rulesForBooks({ vendorDefault: '5111', learnedRules: [], inChart: (code) => chart.has(code) }).vendorDefault).toBeNull();
    expect(rulesForBooks({ vendorDefault: '6421', learnedRules: [], inChart: (code) => chart.has(code) }).vendorDefault).toBeNull();
    expect(rulesForBooks({ vendorDefault: null, learnedRules: [], inChart: () => true }).vendorDefault).toBeNull();
  });
});
