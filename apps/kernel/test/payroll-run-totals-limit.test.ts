// SPDX-License-Identifier: AGPL-3.0-only
// The cash limit is written once in SQL (crove_hr.payroll_run_totals counts the net pays at or above it, #2751) and once in code (CASH_PAYMENT_LIMIT, which the preparer of a payment uses): the two
// must be the same number, or the flag the preparer raises and the flag finance rebuilds at record time would disagree.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASH_PAYMENT_LIMIT } from '@crove/l10n-vn';
import { describe, expect, it } from 'vitest';

describe('the cash limit of the totals function', () => {
  it('is CASH_PAYMENT_LIMIT in the migration that last replaced the function', () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    // The function is replaced as a whole by each later migration that changes it: the last one is the one in force.
    const files = readdirSync(dir).filter((f) => /_crove_hr_payroll_run_totals[a-z_]*\.sql$/.test(f)).sort();
    const file = files.at(-1);
    expect(file).toBeDefined();
    const sql = readFileSync(`${dir}${file}`, 'utf8');
    // A person's payment is the net of their pay line and their corrections together (summed per person), counted at or above the limit.
    const used = [...sql.matchAll(/'cashLarge', \(SELECT pg_catalog\.count\(\*\) FROM \(SELECT l3\.employee_id FROM ln l3 WHERE l3\.net IS NOT NULL GROUP BY l3\.employee_id HAVING pg_catalog\.sum\(l3\.net\) >= (\d+)\)/g)].map((m) => m[1]);
    expect(used).toEqual([CASH_PAYMENT_LIMIT]);
  });
});
