// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PAYROLL_RULES, PayrollRefusedError, calculateLeaveBalance, defineRule, listRulesUsed } from '../src/index.ts';

describe('calculateLeaveBalance (#3348)', () => {
  it('computes full-year entitlement across standard, heavy, and special_heavy categories', () => {
    const standard = calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01' });
    expect(standard).toMatchObject({
      year: '2026',
      eligibleMonths: 12,
      entitlementDays: '12',
      seniorityYears: 1,
      seniorityDays: '0',
      totalEntitlementDays: '12',
      openingDays: '0',
      takenAnnualDays: '0',
      signedBalanceDays: '12',
      remainingAnnualDays: '12',
      exceededAnnualDays: '0',
      personalPaidDays: '0',
      unpaidDaysByMonth: {},
    });
    expect(standard.rulesUsed.map((r) => r.id)).toEqual(['annual_leave.default@2021-01-01']);

    expect(calculateLeaveBalance({ year: '2026', category: 'heavy', hireDate: '2025-01-01' }).entitlementDays).toBe('14');
    expect(calculateLeaveBalance({ year: '2026', category: 'special_heavy', hireDate: '2025-01-01' }).entitlementDays).toBe('16');
  });

  it('applies halfMonthWorkingDaysRatio (0.5) to mid-year hire and termination months', () => {
    // July has 31 days: hired July 16 -> 16/31 >= 0.5 (6 months); hired July 17 -> 15/31 < 0.5 (5 months).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-07-16' })).toMatchObject({
      eligibleMonths: 6,
      entitlementDays: '6',
    });
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-07-17' })).toMatchObject({
      eligibleMonths: 5,
      entitlementDays: '5',
    });

    // February 2026 has 28 days: hired Feb 15 -> 14/28 = 0.5 (counts -> 11 months); Feb 16 -> 13/28 < 0.5 (10 months).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-15' }).eligibleMonths).toBe(11);
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-16' }).eligibleMonths).toBe(10);

    // Leap year February 2028 (29 days): hired Feb 15 -> 15/29 >= 0.5 (11 months); Feb 16 -> 14/29 < 0.5 (10 months).
    expect(calculateLeaveBalance({ year: '2028', category: 'standard', hireDate: '2028-02-15' }).eligibleMonths).toBe(11);
    expect(calculateLeaveBalance({ year: '2028', category: 'standard', hireDate: '2028-02-16' }).eligibleMonths).toBe(10);

    // Ended May 15 -> 15/31 < 0.5 (4 months); ended May 16 -> 16/31 >= 0.5 (5 months).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2024-01-01', endedOn: '2026-05-15' }).eligibleMonths).toBe(4);
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2024-01-01', endedOn: '2026-05-16' }).eligibleMonths).toBe(5);
  });

  it('adds +1 seniority day per full 5 years completed and pro-rates for partial years', () => {
    // Hired 2021-06-01: completes 5 full years on 2026-06-01, so 5 years by 2026-12-31 (+1 day).
    const reachedFive = calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2021-06-01' });
    expect(reachedFive).toMatchObject({
      eligibleMonths: 12,
      entitlementDays: '12',
      seniorityYears: 5,
      seniorityDays: '1',
      totalEntitlementDays: '13',
      remainingAnnualDays: '13',
    });

    // If evaluated as of 2026-05 (before 2026-06-01 anniversary), only 4 completed years.
    const beforeAnniversary = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2021-06-01',
      asOfMonth: '2026-05',
    });
    expect(beforeAnniversary).toMatchObject({
      eligibleMonths: 5,
      entitlementDays: '5',
      seniorityYears: 4,
      seniorityDays: '0',
      totalEntitlementDays: '5',
    });

    // Hired 2016-01-01: 10 full years in 2026 -> +2 seniority days; if terminated 2026-06-30 (6 months), pro-rated to 6 + 1 = 7.
    const tenYearsHalfYear = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2016-01-01',
      endedOn: '2026-06-30',
    });
    expect(tenYearsHalfYear).toMatchObject({
      eligibleMonths: 6,
      entitlementDays: '6',
      seniorityYears: 10,
      seniorityDays: '1',
      totalEntitlementDays: '7',
    });
  });

  it('supports 0.5-day increments, opening balances, personal_paid (without consuming annual leave), and unpaid_leave', () => {
    const result = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2025-01-01',
      openingBalanceDays: '2.5',
      entries: [
        { kind: 'opening_balance', month: '2026-01', days: '1' },
        { kind: 'annual_leave', month: '2026-03', days: '1.5' },
        { kind: 'annual_leave', month: '2026-08', days: '2' },
        { kind: 'personal_paid', month: '2026-04', days: '3' },
        { kind: 'unpaid_leave', month: '2026-05', days: '1.5' },
        { kind: 'unpaid_leave', month: '2026-05', days: '0.5' },
        // Outside 2026: ignored when aggregating 2026 totals.
        { kind: 'annual_leave', month: '2025-12', days: '5' },
      ],
    });
    expect(result).toMatchObject({
      eligibleMonths: 12,
      entitlementDays: '12',
      seniorityDays: '0',
      totalEntitlementDays: '12',
      openingDays: '3.5',
      takenAnnualDays: '3.5',
      signedBalanceDays: '12',
      remainingAnnualDays: '12',
      exceededAnnualDays: '0',
      personalPaidDays: '3',
      unpaidDaysByMonth: { '2026-05': '2' },
    });
  });

  it('clamps remainingAnnualDays at 0 and reports exceededAnnualDays when annual leave exceeds available balance', () => {
    const result = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2026-07-01',
      entries: [{ kind: 'annual_leave', month: '2026-10', days: '8.5' }],
    });
    expect(result).toMatchObject({
      eligibleMonths: 6,
      entitlementDays: '6',
      takenAnnualDays: '8.5',
      signedBalanceDays: '-2.5',
      remainingAnnualDays: '0',
      exceededAnnualDays: '2.5',
    });
  });

  it('drops a month with unpaid leave reaching below halfMonthWorkingDaysRatio when standardWorkingDays is provided', () => {
    const dropped = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2025-01-01',
      standardWorkingDays: '26',
      entries: [{ kind: 'unpaid_leave', month: '2026-05', days: '14' }],
    });
    // (26 - 14) / 26 = 0.4615 < 0.5 -> May is excluded (11 eligible months).
    expect(dropped).toMatchObject({
      eligibleMonths: 11,
      entitlementDays: '11',
      unpaidDaysByMonth: { '2026-05': '14' },
    });

    const kept = calculateLeaveBalance({
      year: '2026',
      category: 'standard',
      hireDate: '2025-01-01',
      standardWorkingDays: '26',
      entries: [{ kind: 'unpaid_leave', month: '2026-05', days: '13' }],
    });
    // (26 - 13) / 26 = 0.5 >= 0.5 -> May is counted (12 eligible months).
    expect(kept.eligibleMonths).toBe(12);
  });

  it('supports explicit eligibleMonths override, exact decimal rounding for heavy pro-ration, and listRulesUsed', () => {
    const overridden = calculateLeaveBalance({
      year: '2026',
      category: 'heavy',
      hireDate: '2020-01-01',
      eligibleMonths: 5,
    });
    // 14 * 5 / 12 = 5.8333, 1 * 5 / 12 = 0.4167 -> total 6.25.
    expect(overridden).toMatchObject({
      eligibleMonths: 5,
      entitlementDays: '5.8333',
      seniorityDays: '0.4167',
      totalEntitlementDays: '6.25',
    });
    expect(listRulesUsed([overridden]).blocksApproval).toBe(true);

    const confirmed = PAYROLL_RULES.map((r) =>
      r.id === 'annual_leave.default@2021-01-01' ? { ...r, status: 'confirmed' as const } : r,
    );
    expect(listRulesUsed([calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01' }, confirmed)], confirmed).blocksApproval).toBe(false);
  });

  it('returns 0 entitlement when employment does not overlap the year and respects custom dated rules', () => {
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2027-01-01' })).toMatchObject({
      eligibleMonths: 0,
      entitlementDays: '0',
      seniorityYears: 0,
      seniorityDays: '0',
    });
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2020-01-01', endedOn: '2025-12-31' })).toMatchObject({
      eligibleMonths: 0,
      entitlementDays: '0',
      seniorityDays: '0',
    });

    const customRules = [
      ...PAYROLL_RULES,
      defineRule({
        kind: 'annual_leave',
        key: 'default',
        effectiveFrom: '2026-01-01',
        status: 'confirmed',
        source: { cite: 'Custom company policy adding 15 standard days from 2026-01-01', confidence: 'primary' },
        value: {
          standardDaysPerYear: '15',
          heavyDaysPerYear: '17',
          specialHeavyDaysPerYear: '19',
          seniorityYearsStep: 5,
          seniorityExtraDays: '1',
          halfMonthWorkingDaysRatio: '0.5',
        },
      }),
    ];
    const custom = calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01' }, customRules);
    expect(custom.entitlementDays).toBe('15');
    expect(custom.rulesUsed[0]?.id).toBe('annual_leave.default@2026-01-01');
  });

  it('refuses invalid dates, pre-rule years, negative days, and malformed numbers', () => {
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof PayrollRefusedError) return e;
        throw e;
      }
      throw new Error('expected PayrollRefusedError');
    };

    expect(refusal(() => calculateLeaveBalance({ year: '2020', category: 'standard', hireDate: '2020-01-01' })).code).toBe('no_rule_in_force');
    expect(refusal(() => calculateLeaveBalance({ year: '26', category: 'standard', hireDate: '2025-01-01' })).code).toBe('invalid_input');
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-30' })).code).toBe('invalid_input');
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-05-01', endedOn: '2026-04-30' })).code).toBe('invalid_input');
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01', eligibleMonths: 13 })).code).toBe('invalid_input');
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01', openingBalanceDays: '-1' })).code).toBe('invalid_input');
    expect(
      refusal(() =>
        calculateLeaveBalance({
          year: '2026',
          category: 'standard',
          hireDate: '2025-01-01',
          entries: [{ kind: 'annual_leave', month: '2026-03', days: 'abc' }],
        }),
      ).code,
    ).toBe('invalid_input');
    expect(
      refusal(() =>
        calculateLeaveBalance({
          year: '2026',
          category: 'standard',
          hireDate: '2025-01-01',
          entries: [{ kind: 'annual_leave', month: '2026-03', days: '' }],
        }),
      ).code,
    ).toBe('invalid_input');
  });
});
