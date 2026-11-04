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
];
