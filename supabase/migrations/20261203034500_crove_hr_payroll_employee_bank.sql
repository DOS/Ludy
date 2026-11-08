-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2897, payroll plan docs/plan/payroll.md section 6.4, ADR-0046): the bank each person is paid at, next to the sealed account number, so the bank bulk-salary file can say
-- which people belong in which bank's file instead of writing one typed bank on every row. Idempotent; applied files stay untouched.
--
-- bank_name   the name of the person's bank as the org writes it ("Vietcombank"), 1 to 60 characters with no space at either end, or NULL when not recorded. Classified `payment` in the
--             module's manifest and registered in the personal-data registry: the owner's erasure of an ended employee clears it (hr.payroll.employee.erase). It is a plain column, not sealed:
--             a bank's name alone identifies no person. No list reads it; only the audited sensitive paths do (the one employee's record and the bank file export).
--
-- No new table, so the two-step rule for a tenant table does not apply; the existing owner and admin policies, the legal-entity scope and the row guards cover the new column as they cover the others.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS bank_name text
  CHECK (bank_name IS NULL OR (pg_catalog.length(bank_name) BETWEEN 1 AND 60 AND bank_name = pg_catalog.btrim(bank_name)));

GRANT UPDATE (bank_name) ON crove_hr.payroll_employee TO crove_tenant;
