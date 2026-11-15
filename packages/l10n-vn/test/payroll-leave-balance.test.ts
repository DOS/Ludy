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
    // Default Mon-Sat schedule: July 2026 has 27 Mon-Sat days: Jul 16 -> 14/27 >= 0.5 (6 months); Jul 17 -> 13/27 < 0.5 (5 months).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-07-16' })).toMatchObject({
      eligibleMonths: 6,
      entitlementDays: '6',
    });
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-07-17' })).toMatchObject({
      eligibleMonths: 5,
      entitlementDays: '5',
    });

    // February 2026 has 24 Mon-Sat days (Feb 15 is Sunday): hired Mon Feb 16 -> 12/24 = 0.5 (11 months); Feb 17 -> 11/24 < 0.5 (10 months).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-16' }).eligibleMonths).toBe(11);
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-17' }).eligibleMonths).toBe(10);

    // Explicit all_days workweek checks calendar day counts (Feb 15 -> 14/28 = 0.5; Feb 16 -> 13/28 < 0.5).
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-15', workweek: 'all_days' }).eligibleMonths).toBe(11);
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2026-02-16', workweek: 'all_days' }).eligibleMonths).toBe(10);

    // Leap year February 2028 (25 Mon-Sat days, 29 calendar days): Feb 15 -> 13/25 >= 0.5 (11 months); Feb 16 -> 12/25 < 0.5 (10 months).
    expect(calculateLeaveBalance({ year: '2028', category: 'standard', hireDate: '2028-02-15' }).eligibleMonths).toBe(11);
    expect(calculateLeaveBalance({ year: '2028', category: 'standard', hireDate: '2028-02-16' }).eligibleMonths).toBe(10);

    // Ended May 14 -> 12/26 < 0.5 (4 months); ended May 15 -> 13/26 = 0.5 (5 months) on Mon-Sat default.
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2024-01-01', endedOn: '2026-05-14' }).eligibleMonths).toBe(4);
    expect(calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2024-01-01', endedOn: '2026-05-15' }).eligibleMonths).toBe(5);
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
          approvedUnpaidMonthsAllowance: '1',
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
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01', openingBalanceDays: '1 2' })).code).toBe(
      'invalid_input',
    );
    expect(refusal(() => calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01', openingBalanceDays: '1e2' })).code).toBe(
      'invalid_input',
    );
  });

  it('uses working-day schedules and workedDaysByMonth in partial months instead of calendar-day ratios', () => {
    // March 2026 has 22 Mon-Fri days; starting 2026-03-17 (Tuesday) works 11/22 = 0.5 -> 10 eligible months.
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2026-03-17',
        workingDaysByMonth: { '2026-03': '22' },
      }),
    ).toMatchObject({ eligibleMonths: 10, entitlementDays: '10' });

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2026-03-17',
        workweek: 'mon_fri',
      }),
    ).toMatchObject({ eligibleMonths: 10, entitlementDays: '10' });

    // When custom workingDaysByMonth doesn't match Mon-Fri/Mon-Sat/calendar counts, require workedDaysByMonth or workweek.
    expect(() =>
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2026-03-17',
        workingDaysByMonth: { '2026-03': '21' },
      }),
    ).toThrow(PayrollRefusedError);

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2026-03-17',
        workingDaysByMonth: { '2026-03': '21' },
        workedDaysByMonth: { '2026-03': '11' },
      }).eligibleMonths,
    ).toBe(10);

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2026-03-17',
        workingDaysByMonth: { '2026-03': '21' },
        workedDaysByMonth: { '2026-03': '10' },
      }).eligibleMonths,
    ).toBe(9);

    // With zero setup (no standardWorkingDays or workweek), full-month unpaid leave still deducts against Mon-Sat default.
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        entries: [{ kind: 'unpaid_leave', month: '2026-05', days: '26' }],
      }),
    ).toMatchObject({ eligibleMonths: 11, entitlementDays: '11' });
  });

  it('honors Decree 145 Art. 65(4) 1-month cumulative allowance only for employer-approved unpaid leave', () => {
    // 1 cumulative month (26 days on Mon-Sat default) of approved unpaid leave still counts as eligible working time.
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        entries: [{ kind: 'unpaid_leave', month: '2026-03', days: '26', approved: true }],
      }),
    ).toMatchObject({ eligibleMonths: 12, entitlementDays: '12' });

    // Approved unpaid leave split across months consumes the 1-month allowance chronologically;
    // 13 + 26 days across Mar and May leaves 13 worked days in May (13/26 = 0.5 -> still counts),
    // whereas 14 + 26 days leaves 12 worked days in May (12/26 < 0.5 -> May drops).
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        entries: [
          { kind: 'unpaid_leave', month: '2026-03', days: '13', approved: true },
          { kind: 'unpaid_leave', month: '2026-05', days: '26', approved: true },
        ],
      }),
    ).toMatchObject({ eligibleMonths: 12, entitlementDays: '12' });

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        entries: [
          { kind: 'unpaid_leave', month: '2026-03', days: '14', approved: true },
          { kind: 'unpaid_leave', month: '2026-05', days: '26', approved: true },
        ],
      }),
    ).toMatchObject({ eligibleMonths: 11, entitlementDays: '11' });

    // Unapproved (or unspecified approved flag) unpaid leave does not receive the Art. 65(4) allowance.
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        entries: [{ kind: 'unpaid_leave', month: '2026-03', days: '26', approved: false }],
      }),
    ).toMatchObject({ eligibleMonths: 11, entitlementDays: '11' });

    // Passing workedDaysByMonth for a month with approved unpaid leave stays consistent with omitting it:
    // 1 month approved unpaid counts (12 months); a second month overflows the 1-month allowance (11 months).
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        standardWorkingDays: '26',
        workedDaysByMonth: { '2026-03': '0' },
        entries: [{ kind: 'unpaid_leave', month: '2026-03', days: '26', approved: true }],
      }),
    ).toMatchObject({ eligibleMonths: 12, entitlementDays: '12' });

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        standardWorkingDays: '26',
        workedDaysByMonth: { '2026-03': '0', '2026-05': '0' },
        entries: [
          { kind: 'unpaid_leave', month: '2026-03', days: '26', approved: true },
          { kind: 'unpaid_leave', month: '2026-05', days: '26', approved: true },
        ],
      }),
    ).toMatchObject({ eligibleMonths: 11, entitlementDays: '11' });
  });

  it('clamps rule lookup date by endedOn so post-termination rules do not change entitlement', () => {
    const midYearRules = [
      ...PAYROLL_RULES,
      defineRule({
        kind: 'annual_leave',
        key: 'default',
        effectiveFrom: '2026-07-01',
        status: 'confirmed',
        source: { cite: 'Mid-year company policy change from 2026-07-01', confidence: 'primary' },
        value: {
          standardDaysPerYear: '24',
          heavyDaysPerYear: '26',
          specialHeavyDaysPerYear: '28',
          seniorityYearsStep: 5,
          seniorityExtraDays: '1',
          halfMonthWorkingDaysRatio: '0.5',
          approvedUnpaidMonthsAllowance: '1',
        },
      }),
    ];

    expect(
      calculateLeaveBalance(
        {
          year: '2026',
          category: 'standard',
          hireDate: '2025-01-01',
          endedOn: '2026-06-30',
          entries: [],
        },
        midYearRules,
      ),
    ).toMatchObject({ eligibleMonths: 6, entitlementDays: '6' });
  });

  it('counts paid annual and personal leave with workedDaysByMonth and uses identical month-end rule lookup for asOfMonth 12', () => {
    // 12 worked days + 14 personal_paid (or annual_leave) days = 26 working days in Jan -> full 12 eligible months.
    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        standardWorkingDays: '26',
        workedDaysByMonth: { '2026-01': '12' },
        entries: [{ kind: 'personal_paid', month: '2026-01', days: '14' }],
      }),
    ).toMatchObject({ eligibleMonths: 12, entitlementDays: '12', personalPaidDays: '14' });

    expect(
      calculateLeaveBalance({
        year: '2026',
        category: 'standard',
        hireDate: '2025-01-01',
        standardWorkingDays: '26',
        workedDaysByMonth: { '2026-02': '12' },
        entries: [{ kind: 'annual_leave', month: '2026-02', days: '14' }],
      }),
    ).toMatchObject({ eligibleMonths: 12, entitlementDays: '12', takenAnnualDays: '14' });

    // asOfMonth: '2026-12' evaluates at 2026-12-31, matching a full-year lookup with asOfMonth omitted.
    const decMidRules = [
      ...PAYROLL_RULES,
      defineRule({
        kind: 'annual_leave',
        key: 'default',
        effectiveFrom: '2026-12-15',
        status: 'confirmed',
        source: { cite: 'Mid-December company policy change from 2026-12-15', confidence: 'primary' },
        value: {
          standardDaysPerYear: '24',
          heavyDaysPerYear: '26',
          specialHeavyDaysPerYear: '28',
          seniorityYearsStep: 5,
          seniorityExtraDays: '1',
          halfMonthWorkingDaysRatio: '0.5',
          approvedUnpaidMonthsAllowance: '1',
        },
      }),
    ];
    const fullYear = calculateLeaveBalance({ year: '2026', category: 'standard', hireDate: '2025-01-01' }, decMidRules);
    const asOfDec = calculateLeaveBalance(
      { year: '2026', category: 'standard', hireDate: '2025-01-01', asOfMonth: '2026-12' },
      decMidRules,
    );
    expect(fullYear.entitlementDays).toBe('24');
    expect(asOfDec.entitlementDays).toBe(fullYear.entitlementDays);
  });
});
