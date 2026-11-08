-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2533, payroll plan docs/plan/payroll.md section 6.1 and 6.5, ADR-0046): what the declaration exports need of a person and Ludy did not hold. Idempotent; applied files stay untouched.
--
-- birth_date                      the person's birth date (the D02-LT and the schedules ask for it). Classified pii; the owner's erasure clears it.
-- tax_code_sealed                 the personal tax code. Since 2025-07-01 it is in most cases the personal identity number, so it is sealed like national_id_sealed: under the person's own key
-- insurance_number_sealed         the social insurance number, tied to the same number. Sealed the same way.
--                                 (ctx.seal, subject `employee:<id>`), opened only by the audited, sensitive paths, and unreadable once the erasure shreds the key.
-- finalization_authorized_years   the tax years the person authorized the payer to finalize their income tax (form 08/UQ-QTT-TNCN). A list of years, written by one command.
--
-- No new table, so the two-step rule for a tenant table does not apply; the existing owner and admin policies and the row guards cover the new columns as they cover the others.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS tax_code_sealed text
  CHECK (tax_code_sealed IS NULL OR (pg_catalog.length(tax_code_sealed) <= 1000 AND tax_code_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'));
ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS insurance_number_sealed text
  CHECK (insurance_number_sealed IS NULL OR (pg_catalog.length(insurance_number_sealed) <= 1000 AND insurance_number_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'));
ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS finalization_authorized_years smallint[] NOT NULL DEFAULT '{}'
  CHECK (pg_catalog.cardinality(finalization_authorized_years) <= 100 AND pg_catalog.array_position(finalization_authorized_years, NULL::smallint) IS NULL);

GRANT UPDATE (birth_date, tax_code_sealed, insurance_number_sealed, finalization_authorized_years) ON crove_hr.payroll_employee TO crove_tenant;
