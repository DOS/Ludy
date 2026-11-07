// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { HR_PAY_FUNCTIONS, zHrEmploymentTerms } from '@crove/kernel-contract';
import { PAYROLL_POSTING_MAPS, PAY_FUNCTIONS } from '@crove/l10n-vn';

describe('the pay function of an employment (#2532)', () => {
  it('is the list the posting maps hold an expense account for, in both charts', () => {
    expect([...HR_PAY_FUNCTIONS]).toEqual([...PAY_FUNCTIONS]);
    for (const map of Object.values(PAYROLL_POSTING_MAPS)) {
      expect(Object.keys(map.expense).sort()).toEqual([...HR_PAY_FUNCTIONS].sort());
    }
  });

  it('is administration when the terms name none, and refuses an unknown function', () => {
    const terms = { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' };
    expect(zHrEmploymentTerms.parse(terms).payFunction).toBe('admin');
    expect(zHrEmploymentTerms.parse({ ...terms, payFunction: 'sales' }).payFunction).toBe('sales');
    expect(zHrEmploymentTerms.safeParse({ ...terms, payFunction: 'marketing' }).success).toBe(false);
  });
});
