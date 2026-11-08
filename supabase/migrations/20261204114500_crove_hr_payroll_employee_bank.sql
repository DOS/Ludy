-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2897, payroll plan docs/plan/payroll.md section 6.4, ADR-0046): the bank each person is paid at, next to the sealed account number, so the bank bulk-salary file can be made one
-- bank at a time. Idempotent; applied files stay untouched.
--
-- bank_code   the code of the person's bank in the list kept as data in @crove/l10n-vn (VN_BANKS: "VCB", "TCB"), 2 to 12 capital letters or digits, or NULL when not recorded. A code, not free text:
--             "Vietcombank", "VCB" and the full name would never match one another when the file is cut by bank. That the code is in the list is checked by the command, not here, so the list can
--             grow without a migration; a code never changes once records hold it. Classified `payment` in the module's manifest and registered in the personal-data registry: the owner's erasure of an
--             ended employee clears it (hr.payroll.employee.erase). A plain column, not sealed: a bank's code alone identifies no person. No list reads it; only the audited sensitive paths do (the one
--             employee's record and the bank file export).
--
-- No new table, so the two-step rule for a tenant table does not apply; the existing owner and admin policies, the legal-entity scope and the row guards cover the new column as they cover the others.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS bank_code text
  CHECK (bank_code IS NULL OR bank_code ~ '^[A-Z0-9]{2,12}$');

GRANT UPDATE (bank_code) ON crove_hr.payroll_employee TO crove_tenant;
