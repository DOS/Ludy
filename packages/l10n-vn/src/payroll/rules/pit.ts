// SPDX-License-Identifier: AGPL-3.0-only
import { rule, type PayrollRule } from '../rule-types.ts';

// Personal income tax on salary (plan section 5, rows 10 to 12). Law 109/2025/QH15 applies to the whole 2026 tax period
// (Art. 29(2)), so every month of 2026 uses the new brackets and deductions. Salary withheld before 2026-07-01 was
// withheld under the old table; Decree 253/2026/ND-CP Art. 70 (as summarized by commentary) says the difference is
// settled in the 2026 finalization. That reading is unverified and is what the accountant (#2535) confirms.

const LAW = 'Law 109/2025/QH15';

export const PIT_RULES: readonly PayrollRule[] = [
  rule({
    kind: 'pit_brackets',
    key: 'resident_monthly',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: {
      cite: `${LAW} (English translation), resident progressive table per month: up to 10 million 5%, over 10 to 30 million 10%, over 30 to 60 million 20%, over 60 to 100 million 30%, over 100 million 35% (a year: 120, 360, 720, 1,200 million); the seven brackets of the old law apply to tax year 2025 and before`,
      confidence: 'primary',
    },
    value: {
      brackets: [
        { upTo: '10000000', percent: '5' },
        { upTo: '30000000', percent: '10' },
        { upTo: '60000000', percent: '20' },
        { upTo: '100000000', percent: '30' },
        { upTo: null, percent: '35' },
      ],
    },
  }),
  rule({
    kind: 'pit_deduction',
    key: 'personal',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: `${LAW} with Resolution 110/2025/UBTVQH15, from the 2026 tax period: personal deduction 15,500,000 a month (186,000,000 a year); 11,000,000 in 2025 and before`, confidence: 'primary' },
    value: { monthly: '15500000' },
  }),
  rule({
    kind: 'pit_deduction',
    key: 'dependent',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: `${LAW} with Resolution 110/2025/UBTVQH15, from the 2026 tax period: 6,200,000 a month for each registered dependent; 4,400,000 in 2025 and before`, confidence: 'primary' },
    value: { monthly: '6200000' },
  }),
  rule({
    kind: 'pit_deduction',
    key: 'dependent_income_limit',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: "Circular 87/2026/TT-BTC (some sources print 86): a dependent's own income limit is 3,000,000 a month; above it the person is not a dependent that month", confidence: 'commentary' },
    value: { monthly: '3000000' },
  }),
  rule({
    kind: 'pit_deduction',
    key: 'voluntary_pension_cap',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Voluntary pension or life insurance is deductible up to 3,000,000 a month, employer and employee together (commentary; the health and education deduction of Decree 253/2026 Art. 49 is not modelled, whether it is taken in the monthly withholding is unverified)', confidence: 'commentary' },
    value: { monthly: '3000000' },
  }),
  rule({
    kind: 'pit_withholding',
    key: 'no_or_short_contract',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: {
      cite: 'Decree 253/2026/ND-CP Art. 50(2): no labor contract or a contract under 3 months, 10% withheld on each payment of 5,000,000 or more (the threshold was 2,000,000 before; some 2026 articles still say so); below it only if the person asks; a commitment form lets a person with income below the taxable level avoid it; a contract of 3 months or more is withheld at the progressive table',
      confidence: 'commentary',
    },
    value: { percent: '10', paymentThreshold: '5000000', progressiveFromContractMonths: 3 },
  }),
];
