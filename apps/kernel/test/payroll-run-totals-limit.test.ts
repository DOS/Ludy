// SPDX-License-Identifier: AGPL-3.0-only
// The cash limit is written once in SQL (crove_hr.payroll_run_totals counts the net pays at or above it, #2751) and once in code (CASH_PAYMENT_LIMIT, which the preparer of a payment uses): the two
// must be the same number, or the flag the preparer raises and the flag finance rebuilds at record time would disagree.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASH_PAYMENT_LIMIT } from '@crove/l10n-vn';
import { describe, expect, it } from 'vitest';

describe('the cash limit of the totals function', () => {
  it('is CASH_PAYMENT_LIMIT', () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    const file = readdirSync(dir).find((f) => f.endsWith('_crove_hr_payroll_run_totals.sql'));
    expect(file).toBeDefined();
    const sql = readFileSync(`${dir}${file}`, 'utf8');
    const used = [...sql.matchAll(/'cashLarge', pg_catalog\.count\(\*\) FILTER \(WHERE net >= (\d+)\)/g)].map((m) => m[1]);
    expect(used).toEqual([CASH_PAYMENT_LIMIT]);
  });
});
