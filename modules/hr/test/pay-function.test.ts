// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { HR_PAY_FUNCTIONS, zHrEmployeeInitialEmployment, zHrEmploymentTerms } from '@ludy/kernel-contract';
import { PAYROLL_POSTING_MAPS, PAY_FUNCTIONS } from '@ludy/l10n-vn';

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

  it('requires baseWage on monthly terms while defaulting non-monthly baseWage to 0 (#4301)', () => {
    const monthlyMissing = zHrEmploymentTerms.safeParse({
      effectiveFrom: '2026-08-01',
      contractType: 'indefinite',
      region: 'I',
    });
    expect(monthlyMissing.success).toBe(false);
    if (!monthlyMissing.success) {
      expect(monthlyMissing.error.issues.map((i) => i.path.join('.'))).toContain('baseWage');
    }
    const hourly = zHrEmployeeInitialEmployment.parse({
      effectiveFrom: '2026-08-01',
      contractType: 'indefinite',
      region: 'I',
      payBasis: 'hourly',
      hourlyRate: '50000',
    });
    expect(hourly.baseWage).toBe('0');
    const piece = zHrEmploymentTerms.parse({
      effectiveFrom: '2026-08-01',
      contractType: 'indefinite',
      region: 'I',
      payBasis: 'piece_rate',
      pieceRate: '25000',
    });
    expect(piece.baseWage).toBe('0');
  });
});
