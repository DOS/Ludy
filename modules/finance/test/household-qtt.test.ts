// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of the annual PIT finalization 02/CNKD-TNCN-QTT of a household on the income method (#5285), worked out by hand: the form's own formulas for lines [09] to [20] (Circular 89/2026 Phụ lục I),
// the band of the income-method rate (Luật TNCN 109/2025 Art. 7(2): a band applies ABOVE its bound), the 50,000 VND exemption, the cases that are held and the 30% cut of Decree 398/2026 on both sides.
import { HOUSEHOLD_EXPENSE_GROUPS, zHouseholdQttGet } from '@ludy/kernel-contract';
import { describe, expect, it } from 'vitest';
import { bandFor, computeQtt, QTT_CODES, QTT_COST_LINES, QTT_LABELS, reductionMemo, settle, type QttInput } from '../src/domain/household-qtt.ts';

const BANDS = [
  { revenueOver: '0', percent: '15' },
  { revenueOver: '3000000000', percent: '17' },
  { revenueOver: '50000000000', percent: '20' },
];
const band15 = { revenueOver: '0', percent: '15' };
const amounts = (lines: ReadonlyArray<{ code: string; amount: string | null }>) => Object.fromEntries(lines.map((l) => [l.code, l.amount]));

// A year: revenue 1.5 billion VND, 400 million of it on platforms that withheld and paid over, 100 million on a platform with no payment function, so [09a] = 1 billion; costs 800 million in the six groups.
// [11] = 1.5 billion - 800 million = 700 million; 15% = 105 million; less 5 million withheld and 40 million prepaid = 60 million to pay.
const BASE: QttInput = {
  revenue: '1500000000',
  platformRevenue: '400000000',
  noPaymentRevenue: '100000000',
  costs: { materials_goods: '600000000', wages_insurance: '100000000', depreciation: '20000000', outside_services: '30000000', interest: '10000000', other: '40000000' },
  unmappedGross: '0',
  threshold: '1000000000',
  band: band15,
  withheld: '5000000',
  prepaid: '40000000',
  closed: false,
};

describe('02/CNKD-TNCN-QTT, the lines of part A', () => {
  it('works out every line from the form\'s own formulas', () => {
    const r = computeQtt(BASE);
    expect(r.holds).toEqual([]);
    expect(amounts(r.lines)).toEqual({
      '09': '1500000000',
      '09a': '1000000000',
      '09b': '400000000',
      '09c': '100000000',
      '10': '800000000',
      '10a': '600000000',
      '10b': '100000000',
      '10c': '20000000',
      '10d': '30000000',
      '10đ': '10000000',
      '10e': '40000000',
      '11': '700000000',
      '12': '15',
      '13': '105000000',
      '14': '5000000',
      '15': '40000000',
      '16': '0',
      '17': '60000000',
      '18': '0',
      '19': '60000000',
      '20': '0',
    });
    expect(r.tax).toBe('105000000');
  });

  it('prints the lines in the form\'s order with its codes and labels, the loan interest as 10đ', () => {
    const r = computeQtt(BASE);
    expect(r.lines.map((l) => l.code)).toEqual([...QTT_CODES]);
    for (const code of QTT_CODES) expect(QTT_LABELS[code], code).toBeTruthy();
    // The six expense groups of S2c are exactly the six cost lines of the form, each once.
    expect(Object.values(QTT_COST_LINES).sort()).toEqual(['10a', '10b', '10c', '10d', '10e', '10đ']);
    expect(Object.keys(QTT_COST_LINES).sort()).toEqual([...HOUSEHOLD_EXPENSE_GROUPS].sort());
    expect(QTT_COST_LINES.interest).toBe('10đ');
    expect(QTT_COST_LINES.outside_services).toBe('10d');
  });

  it('rounds the tax to a whole dong', () => {
    // Income 333,334 at 15% = 50,000.1, which is 50,000.
    const r = computeQtt({ ...BASE, revenue: '1100000000', platformRevenue: '0', noPaymentRevenue: '0', costs: { ...BASE.costs, materials_goods: '1099666666', wages_insurance: '0', depreciation: '0', outside_services: '0', interest: '0', other: '0' }, withheld: '0', prepaid: '0' });
    expect(amounts(r.lines)['11']).toBe('333334');
    expect(amounts(r.lines)['13']).toBe('50000');
    expect(amounts(r.lines)['18']).toBe('50000');
    expect(amounts(r.lines)['19']).toBe('0');
  });

  it('shows an overpayment on [20] and nothing to pay on [17]', () => {
    const r = computeQtt({ ...BASE, prepaid: '120000000' });
    expect(amounts(r.lines)['17']).toBe('0');
    expect(amounts(r.lines)['19']).toBe('0');
    // 105 million - 5 million withheld - 120 million prepaid = 20 million overpaid.
    expect(amounts(r.lines)['20']).toBe('20000000');
  });
});

describe('the band of the income-method rate', () => {
  it('applies a band ABOVE its bound, so exactly 3 billion VND is still 15%', () => {
    expect(bandFor('1500000000', BANDS)?.percent).toBe('15');
    expect(bandFor('3000000000', BANDS)?.percent).toBe('15');
    expect(bandFor('3000000001', BANDS)?.percent).toBe('17');
    expect(bandFor('50000000000', BANDS)?.percent).toBe('17');
    expect(bandFor('50000000001', BANDS)?.percent).toBe('20');
  });

  it('has no band for a revenue of nothing or less', () => {
    expect(bandFor('0', BANDS)).toBeNull();
    expect(bandFor('-5', BANDS)).toBeNull();
    expect(bandFor('1000', [])).toBeNull();
  });

  it('puts the 17% band on [12] and [13] of a year above 3 billion', () => {
    const r = computeQtt({ ...BASE, revenue: '4000000000', platformRevenue: '0', noPaymentRevenue: '0', band: bandFor('4000000000', BANDS), withheld: '0', prepaid: '0' });
    // Income 4 billion - 800 million = 3.2 billion; 17% = 544 million.
    expect(amounts(r.lines)['11']).toBe('3200000000');
    expect(amounts(r.lines)['12']).toBe('17');
    expect(amounts(r.lines)['13']).toBe('544000000');
  });
});

describe('[17] to [20] and the 50,000 VND exemption', () => {
  it('exempts a tax payable of 50,000 or less and nothing above it', () => {
    expect(settle('105000000', '104950000', '0')).toEqual({ tax: '105000000', payable: '50000', exempt: '50000', due: '0', overpaid: '0' });
    expect(settle('105000000', '104949999', '0')).toEqual({ tax: '105000000', payable: '50001', exempt: '0', due: '50001', overpaid: '0' });
    expect(settle('0', '0', '0')).toEqual({ tax: '0', payable: '0', exempt: '0', due: '0', overpaid: '0' });
  });

  it('subtracts withheld, prepaid and relieved tax, and shows what is left over as overpaid', () => {
    expect(settle('100', '10', '20', '5')).toEqual({ tax: '100', payable: '65', exempt: '65', due: '0', overpaid: '0' });
    expect(settle('100', '60', '50')).toEqual({ tax: '100', payable: '0', exempt: '0', due: '0', overpaid: '10' });
  });
});

describe('what is held', () => {
  it('holds a revenue at or under the tax-free threshold: no PIT and no return', () => {
    for (const revenue of ['900000000', '1000000000']) {
      const r = computeQtt({ ...BASE, revenue, platformRevenue: '0', noPaymentRevenue: '0', costs: { ...BASE.costs, materials_goods: '0', wages_insurance: '0', depreciation: '0', outside_services: '0', interest: '0', other: '0' } });
      expect(r.holds).toEqual(['below_threshold']);
      expect(amounts(r.lines)['11']).toBe(revenue);
      expect(amounts(r.lines)['13']).toBeNull();
      expect(r.tax).toBeNull();
    }
  });

  it('holds a loss, which no clause treats, but still shows the income below zero', () => {
    // Revenue 1.2 billion, costs 1.6 billion.
    const r = computeQtt({ ...BASE, revenue: '1200000000', platformRevenue: '0', noPaymentRevenue: '0', costs: { ...BASE.costs, materials_goods: '1400000000' } });
    expect(r.holds).toEqual(['loss']);
    expect(amounts(r.lines)['11']).toBe('-400000000');
    expect(amounts(r.lines)['12']).toBeNull();
    expect(amounts(r.lines)['17']).toBeNull();
  });

  it('holds the income while an expense account has no group', () => {
    const r = computeQtt({ ...BASE, unmappedGross: '5000' });
    expect(r.holds).toEqual(['unmapped_costs']);
    expect(amounts(r.lines)['10']).toBe('800000000');
    expect(amounts(r.lines)['11']).toBeNull();
  });

  it('holds [09a] when the platform revenue is more than the ledger\'s revenue, and still works out the tax', () => {
    const r = computeQtt({ ...BASE, platformRevenue: '1600000000', noPaymentRevenue: '0' });
    expect(r.holds).toEqual(['platform_split']);
    expect(amounts(r.lines)['09a']).toBeNull();
    expect(amounts(r.lines)['13']).toBe('105000000');
  });

  it('holds a year closed to account 911, whose closing entries net revenue and costs to nothing', () => {
    const r = computeQtt({ ...BASE, closed: true });
    expect(r.holds).toEqual(['closing_entries']);
    expect(amounts(r.lines)['11']).toBeNull();
  });

  it('holds a revenue no rate row covers', () => {
    const r = computeQtt({ ...BASE, band: null });
    expect(r.holds).toEqual(['rate_missing']);
    expect(amounts(r.lines)['11']).toBe('700000000');
    expect(amounts(r.lines)['12']).toBeNull();
  });
});

describe('the 30% PIT cut of Decree 398/2026, which the form has no line for', () => {
  const cut = { tax: '105000000', revenue: '1500000000', percent: '30', ceiling: '10000000000', withheld: '5000000', prepaid: '40000000' };

  it('gives the balance before and after the cut: 30% of 105 million is 31.5 million', () => {
    const memo = reductionMemo(cut);
    expect(memo.applies).toBe(true);
    expect(memo.cut).toBe('31500000');
    expect(memo.before).toEqual({ tax: '105000000', payable: '60000000', exempt: '0', due: '60000000', overpaid: '0' });
    expect(memo.after).toEqual({ tax: '73500000', payable: '28500000', exempt: '0', due: '28500000', overpaid: '0' });
  });

  it('shows an overpayment after the cut when the tax paid in the year is more than the reduced tax', () => {
    const memo = reductionMemo({ ...cut, prepaid: '80000000', withheld: '0' });
    expect(memo.before.due).toBe('25000000');
    expect(memo.after).toMatchObject({ payable: '0', overpaid: '6500000' });
  });

  it('does not apply above the ceiling of 10 billion VND (the cut is for a revenue up to it), nor with no cut in force', () => {
    const above = reductionMemo({ ...cut, revenue: '10000000001' });
    expect(above.applies).toBe(false);
    expect(above.cut).toBe('0');
    expect(above.after).toEqual(above.before);
    expect(reductionMemo({ ...cut, revenue: '10000000000' }).applies).toBe(true);
    expect(reductionMemo({ ...cut, percent: '0' }).applies).toBe(false);
  });
});

describe('the amounts the household enters', () => {
  const base = { legalEntityId: '11111111-1111-4111-8111-111111111111', year: 2026 };

  it('takes whole dong only for [14], [15] and [09c]: a fraction would run on into [17] to [20]', () => {
    expect(zHouseholdQttGet.safeParse({ ...base, withheld: '10000000', prepaid: '0', noPaymentRevenue: '5' }).success).toBe(true);
    for (const field of ['withheld', 'prepaid', 'noPaymentRevenue']) {
      expect(zHouseholdQttGet.safeParse({ ...base, [field]: '0.5' }).success, field).toBe(false);
      expect(zHouseholdQttGet.safeParse({ ...base, [field]: '12.00000001' }).success, field).toBe(false);
    }
  });
});
