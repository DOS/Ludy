// SPDX-License-Identifier: AGPL-3.0-only
import { defineRule, type PayrollRule } from '../rule-types.ts';

// Labor Code 2019 (Law 45/2019/QH14, in force 2021-01-01), read in the Official Gazette text (plan section 5, row 17).

const CODE = 'Labor Code 2019';

export const LABOR_CODE_RULES: readonly PayrollRule[] = [
  defineRule({
    kind: 'overtime_multiples',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: { cite: `${CODE} Art. 98(1): overtime pay is at least 150% of the normal rate on a normal day, 200% on a weekly rest day, 300% on a public holiday or paid leave day (for monthly-paid staff the whole multiple is paid on top of the monthly wage; for daily-paid staff the holiday pay is not counted in the 300%)`, confidence: 'primary' },
    value: { normal_day: '1.5', weekly_rest_day: '2', holiday: '3' },
  }),
  defineRule({
    kind: 'night_premium',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: {
      cite: `${CODE} Art. 98(2) and (3): night work (22:00 to 06:00) is paid at least 30% more than the normal rate; night overtime is paid the overtime rate plus 30% plus 20% of the daytime overtime rate of that day`,
      confidence: 'primary',
    },
    value: { nightWork: '0.3', nightOvertimeExtra: '0.2' },
  }),
  defineRule({
    kind: 'deduction_cap',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: { cite: `${CODE} Art. 102(3) and Art. 129 (the plan cites Art. 129): deductions to compensate damage are at most 30% of the monthly pay left after insurance and tax`, confidence: 'primary' },
    value: { percent: '30' },
  }),
  defineRule({
    kind: 'standard_hours',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: { cite: `${CODE} Art. 105: normal working time is at most 8 hours a day and 48 hours a week`, confidence: 'primary' },
    value: { perDay: '8' },
  }),
  defineRule({
    kind: 'overtime_caps',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: {
      cite: `${CODE} Art. 107(2)(b) and (c): overtime hours may not exceed 40 hours in 1 month and 200 hours in 1 year (300 hours in a year in listed sectors with notice)`,
      confidence: 'primary',
    },
    value: { monthlyHours: '40', annualHours: '200' },
  }),
  defineRule({
    kind: 'annual_leave',
    key: 'default',
    effectiveFrom: '2021-01-01',
    status: 'commentary',
    source: {
      cite: `${CODE} Art. 113 and Art. 114 and Decree 145/2020/ND-CP Art. 65(4) and Art. 66: 12 working days a year in normal conditions, 14 for heavy or hazardous work, 16 for specially heavy or hazardous work, plus 1 extra day for every full 5 years worked for the employer; employer-approved unpaid leave up to 1 month/year counts as working time (approvedUnpaidMonthsAllowance 1), and a hire, end, or remaining unpaid month with at least 50% of working days (halfMonthWorkingDaysRatio 0.5) counts toward annual leave`,
      confidence: 'commentary',
    },
    value: {
      standardDaysPerYear: '12',
      heavyDaysPerYear: '14',
      specialHeavyDaysPerYear: '16',
      seniorityYearsStep: 5,
      seniorityExtraDays: '1',
      halfMonthWorkingDaysRatio: '0.5',
      approvedUnpaidMonthsAllowance: '1',
    },
  }),
];
