// SPDX-License-Identifier: AGPL-3.0-only
import { defineRule, type RuleRow } from '../rule-types.ts';

// Regional minimum wage (plan section 5, row 6). Also the lowest pay allowed in the region, and the base of the BHTN cap.
// The region follows the employer's place of operation by commune (the decree's appendix).

export const MINIMUM_WAGE_RULES: readonly RuleRow<'minimum_wage'>[] = [
  defineRule({
    kind: 'minimum_wage',
    key: 'I',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Decree 293/2025/ND-CP, region I: 5,310,000 a month, 25,500 an hour, from 2026-01-01 (government news page, EY summary; decree text not read)', confidence: 'gov' },
    value: { monthly: '5310000', hourly: '25500' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'II',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Decree 293/2025/ND-CP, region II: 4,730,000 a month, 22,700 an hour, from 2026-01-01 (government news page, EY summary; decree text not read)', confidence: 'gov' },
    value: { monthly: '4730000', hourly: '22700' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'III',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Decree 293/2025/ND-CP, region III: 4,140,000 a month, 20,000 an hour, from 2026-01-01 (government news page, EY summary; decree text not read)', confidence: 'gov' },
    value: { monthly: '4140000', hourly: '20000' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'IV',
    effectiveFrom: '2026-01-01',
    status: 'commentary',
    source: { cite: 'Decree 293/2025/ND-CP, region IV: 3,700,000 a month, 17,800 an hour, from 2026-01-01 (government news page, EY summary; decree text not read)', confidence: 'gov' },
    value: { monthly: '3700000', hourly: '17800' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'I',
    effectiveFrom: '2027-01-01',
    status: 'commentary',
    source: { cite: 'Decree 399/2026/ND-CP, region I: 5,700,000 a month, 27,400 an hour, from 2027-01-01 (government news page; decree text not read, signing date unclear)', confidence: 'gov' },
    value: { monthly: '5700000', hourly: '27400' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'II',
    effectiveFrom: '2027-01-01',
    status: 'commentary',
    source: { cite: 'Decree 399/2026/ND-CP, region II: 5,080,000 a month, 24,400 an hour, from 2027-01-01 (government news page; decree text not read, signing date unclear)', confidence: 'gov' },
    value: { monthly: '5080000', hourly: '24400' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'III',
    effectiveFrom: '2027-01-01',
    status: 'commentary',
    source: { cite: 'Decree 399/2026/ND-CP, region III: 4,450,000 a month, 21,400 an hour, from 2027-01-01 (government news page; decree text not read, signing date unclear)', confidence: 'gov' },
    value: { monthly: '4450000', hourly: '21400' },
  }),
  defineRule({
    kind: 'minimum_wage',
    key: 'IV',
    effectiveFrom: '2027-01-01',
    status: 'commentary',
    source: { cite: 'Decree 399/2026/ND-CP, region IV: 4,040,000 a month, 19,400 an hour, from 2027-01-01 (government news page; decree text not read, signing date unclear)', confidence: 'gov' },
    value: { monthly: '4040000', hourly: '19400' },
  }),
];
