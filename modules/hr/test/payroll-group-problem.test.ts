// SPDX-License-Identifier: AGPL-3.0-only
// What is wrong with one cost department's stored sums (#2918): the posting refuses a run with such a group and the payment amounts do not offer it. The database already checks the lines, so these
// are the guards of the code against a department or fund the lists do not know and per-fund sums that do not add to the insurance.
import { describe, expect, it } from 'vitest';
import { groupProblem, type StoredGroup } from '../src/payroll-posting.ts';

const group = (over: Partial<StoredGroup> = {}): StoredGroup => ({
  payFunction: 'admin',
  gross: '1000000',
  unionFee: '0',
  pit: '0',
  net: '895000',
  advance: '0',
  otherDeductions: '0',
  funds: [
    { fund: 'health', employee: '15000', employer: '30000' },
    { fund: 'unemployment', employee: '10000', employer: '10000' },
  ],
  employeeInsurance: '25000',
  employerInsurance: '40000',
  ...over,
});

describe('a stored group the posting refuses and the amounts do not offer', () => {
  it('is whole when the department and funds are known and the fund shares add to the insurance', () => {
    expect(groupProblem(group())).toBeNull();
  });
  it('names an unknown department, an unknown fund, and fund shares that do not add up', () => {
    expect(groupProblem(group({ payFunction: 'bogus' }))).toBe('bộ phận hạch toán');
    expect(groupProblem(group({ funds: [{ fund: 'bogus' as 'health', employee: '25000', employer: '40000' }] }))).toBe('quỹ bảo hiểm');
    expect(groupProblem(group({ employeeInsurance: '25001' }))).toBe('bảo hiểm');
    expect(groupProblem(group({ employerInsurance: '39999' }))).toBe('bảo hiểm');
  });
});
