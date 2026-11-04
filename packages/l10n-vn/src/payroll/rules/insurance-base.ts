// SPDX-License-Identifier: AGPL-3.0-only
import { defineRule, type RuleRow } from '../rule-types.ts';

// The reference level behind the insurance wage's floor and cap, and the bounds themselves (plan section 5, rows 4 and 5).
// The reference level equals the base salary (luong co so) while that exists (Law 41/2024 Arts. 7 and 141(13)).

export const REFERENCE_LEVEL_RULES: readonly RuleRow<'reference_level'>[] = [
  defineRule({
    kind: 'reference_level',
    key: 'default',
    effectiveFrom: '2024-07-01',
    status: 'commentary',
    source: {
      cite: 'Base salary 2,340,000 a month, in force up to 2026-06-30 (plan section 5 row 4); the start date is that of Decree 73/2024/ND-CP, whose text was not read. Sources that still print 2,340,000 or a 46,800,000 cap are stale for any month from July 2026',
      confidence: 'commentary',
    },
    value: { amount: '2340000' },
  }),
  defineRule({
    kind: 'reference_level',
    key: 'default',
    effectiveFrom: '2026-07-01',
    status: 'commentary',
    source: {
      cite: "Reference level 2,530,000 a month from 2026-07-01 (Decree 161/2026/ND-CP; the insurance agency's own site states the July figures; the decree text was not read)",
      confidence: 'gov',
    },
    value: { amount: '2530000' },
  }),
];

export const INSURANCE_WAGE_BOUND_RULES: readonly RuleRow<'insurance_wage_bounds'>[] = [
  defineRule({
    kind: 'insurance_wage_bounds',
    key: 'social',
    effectiveFrom: '2025-07-01',
    status: 'commentary',
    source: {
      cite: 'Law 41/2024/QH15 Art. 31(1)(d), consolidated 19/VBHN-VPQH: BHXH and BHYT contribution wage floor is the reference level, cap is 20 times the reference level',
      confidence: 'primary',
    },
    value: { floor: { basis: 'reference_level', multiple: '1' }, cap: { basis: 'reference_level', multiple: '20' } },
  }),
  defineRule({
    kind: 'insurance_wage_bounds',
    key: 'unemployment',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: {
      cite: 'Employment Law 74/2025/QH15 Art. 34(2), in force 2026-01-01, all workers: BHTN cap is 20 times the regional minimum wage at the time of payment (74.0 million in region IV to 106.2 million in region I); the floor is the minimum social insurance wage, read here as the reference level (a provincial agency page, unverified)',
      confidence: 'commentary',
    },
    value: { floor: { basis: 'reference_level', multiple: '1' }, cap: { basis: 'regional_minimum_wage', multiple: '20' } },
  }),
];
