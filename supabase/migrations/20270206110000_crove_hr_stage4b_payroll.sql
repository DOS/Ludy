-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 4B payroll extensions: hourly/piece-rate pay basis, foreign worker
-- tax residency and work-permit tracking, and BHXH sickness/maternity leave.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employee
  ADD COLUMN IF NOT EXISTS is_foreign boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_permit_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS work_permit_expires_on date,
  ADD COLUMN IF NOT EXISTS work_permit_number_sealed text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employee'::regclass
      AND conname = 'payroll_employee_work_permit_number_sealed_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employee
      ADD CONSTRAINT payroll_employee_work_permit_number_sealed_ck
      CHECK (
        work_permit_number_sealed IS NULL
        OR (
          pg_catalog.length(work_permit_number_sealed) <= 1000
          AND work_permit_number_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'
        )
      );
  END IF;
END
$$;

GRANT UPDATE (is_foreign, work_permit_exempt, work_permit_expires_on, work_permit_number_sealed)
  ON crove_hr.payroll_employee TO crove_tenant;

ALTER TABLE crove_hr.payroll_employment
  ADD COLUMN IF NOT EXISTS pay_basis text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(20, 2),
  ADD COLUMN IF NOT EXISTS piece_rate numeric(20, 2),
  ADD COLUMN IF NOT EXISTS tax_resident boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_pay_basis_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_pay_basis_ck
      CHECK (pay_basis IN ('monthly', 'hourly', 'piece_rate'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_hourly_rate_nonneg_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_hourly_rate_nonneg_ck
      CHECK (hourly_rate IS NULL OR hourly_rate >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_piece_rate_nonneg_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_piece_rate_nonneg_ck
      CHECK (piece_rate IS NULL OR piece_rate >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_hourly_rate_required_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_hourly_rate_required_ck
      CHECK (pay_basis <> 'hourly' OR (hourly_rate IS NOT NULL AND hourly_rate > 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_piece_rate_required_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_piece_rate_required_ck
      CHECK (pay_basis <> 'piece_rate' OR (piece_rate IS NOT NULL AND piece_rate > 0));
  END IF;
END
$$;

ALTER TABLE crove_hr.payroll_leave_entry
  DROP CONSTRAINT IF EXISTS payroll_leave_entry_kind_check;

ALTER TABLE crove_hr.payroll_leave_entry
  ADD CONSTRAINT payroll_leave_entry_kind_check
  CHECK (
    kind IN (
      'opening_balance',
      'annual_leave',
      'personal_paid',
      'unpaid_leave',
      'sickness_bhxh',
      'maternity_bhxh'
    )
  );
