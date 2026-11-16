-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #3384, #2541 slice 2b-3; docs/plan/payroll.md section 5 rows 1-2, section 6.7, section 7; ADR-0046):
-- Labor contract tracking (form, term months, end date, fixed-term sequence) and probation compliance fields (role tier,
-- probation end date, probation wage) on crove_hr.payroll_employment.
-- All 7 columns are nullable for zero-setup backwards compatibility; crove_hr.payroll_employment remains append-only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_hr.payroll_employment
  ADD COLUMN IF NOT EXISTS contract_form text CHECK (contract_form IN ('written', 'electronic', 'oral')),
  ADD COLUMN IF NOT EXISTS term_months smallint CHECK (term_months BETWEEN 1 AND 36),
  ADD COLUMN IF NOT EXISTS contract_end_on date,
  ADD COLUMN IF NOT EXISTS fixed_term_sequence smallint CHECK (fixed_term_sequence BETWEEN 1 AND 2),
  ADD COLUMN IF NOT EXISTS probation_role_tier text CHECK (probation_role_tier IN ('enterprise_manager', 'college_or_above', 'intermediate_technical', 'other')),
  ADD COLUMN IF NOT EXISTS probation_end_on date,
  ADD COLUMN IF NOT EXISTS probation_wage numeric(20, 2) CHECK (probation_wage >= 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_employment'
      AND con.conname = 'payroll_employment_contract_end_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_contract_end_ck
      CHECK (contract_end_on IS NULL OR (contract_end_on >= effective_from AND contract_type <> 'indefinite'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_employment'
      AND con.conname = 'payroll_employment_fixed_term_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_fixed_term_ck
      CHECK ((term_months IS NULL AND fixed_term_sequence IS NULL) OR contract_type = 'fixed_term');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_employment'
      AND con.conname = 'payroll_employment_probation_end_ck'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_probation_end_ck
      CHECK (probation_end_on IS NULL OR probation_end_on >= effective_from);
  END IF;
END $$;
