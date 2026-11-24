-- SPDX-License-Identifier: AGPL-3.0-only
-- Accept both new `ludy:s1:` writes and existing legacy `crove:s1:` sealed values in every SEALED_COLUMNS CHECK (#3972, ADR-0054).

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  r RECORD;
  v_relid oid;
  v_attnum smallint;
  k RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (
      VALUES
        ('ludy_hr', 'payroll_employee', 'national_id_sealed', 'payroll_employee_national_id_sealed_ck', 'regex'),
        ('ludy_hr', 'payroll_employee', 'bank_account_sealed', 'payroll_employee_bank_account_sealed_ck', 'regex'),
        ('ludy_hr', 'payroll_employee', 'tax_code_sealed', 'payroll_employee_tax_code_sealed_ck', 'regex'),
        ('ludy_hr', 'payroll_employee', 'insurance_number_sealed', 'payroll_employee_insurance_number_sealed_ck', 'regex'),
        ('ludy_hr', 'payroll_employee', 'work_permit_number_sealed', 'payroll_employee_work_permit_number_sealed_ck', 'regex'),
        ('ludy_hr', 'onboarding_submission', 'national_id_sealed', 'onboarding_submission_national_id_sealed_ck', 'regex'),
        ('ludy_hr', 'onboarding_submission', 'bank_account_sealed', 'onboarding_submission_bank_account_sealed_ck', 'regex'),
        ('ludy_hr', 'onboarding_submission', 'tax_code_sealed', 'onboarding_submission_tax_code_sealed_ck', 'regex'),
        ('ludy_hr', 'onboarding_submission', 'insurance_number_sealed', 'onboarding_submission_insurance_number_sealed_ck', 'regex'),
        ('ludy_finance', 'supplier_bank_account', 'account_holder_sealed', 'supplier_bank_account_account_holder_sealed_ck', 'like'),
        ('ludy_finance', 'supplier_bank_account', 'number_sealed', 'supplier_bank_account_number_sealed_ck', 'like')
    ) AS t(schema_name, table_name, column_name, constraint_name, check_mode)
  LOOP
    SELECT c.oid
      INTO v_relid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = r.schema_name
       AND c.relname = r.table_name;

    IF v_relid IS NULL THEN
      RAISE EXCEPTION 'Expected sealed table %.% does not exist', r.schema_name, r.table_name;
    END IF;

    SELECT a.attnum
      INTO v_attnum
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_relid
       AND a.attname = r.column_name
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_attnum IS NULL THEN
      RAISE EXCEPTION 'Expected sealed column %.%.% does not exist', r.schema_name, r.table_name, r.column_name;
    END IF;

    -- Replace any legacy single-column CHECK that requires crove:s1: without ludy:s1:.
    FOR k IN
      SELECT c.conname
        FROM pg_catalog.pg_constraint c
       WHERE c.contype = 'c'
         AND c.conrelid = v_relid
         AND v_attnum = ANY (c.conkey)
         AND pg_catalog.cardinality(c.conkey) = 1
         AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%crove:s1:%'
         AND pg_catalog.pg_get_constraintdef(c.oid) NOT LIKE '%ludy:s1:%'
    LOOP
      EXECUTE pg_catalog.format(
        'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
        r.schema_name, r.table_name, k.conname
      );
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = v_relid
         AND c.conname = r.constraint_name
    ) THEN
      IF r.check_mode = 'regex' THEN
        EXECUTE pg_catalog.format(
          'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR (pg_catalog.length(%I) <= 1000 AND %I ~ %L))',
          r.schema_name, r.table_name, r.constraint_name,
          r.column_name, r.column_name, r.column_name,
          '^(?:ludy|crove):s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'
        );
      ELSE
        EXECUTE pg_catalog.format(
          'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (pg_catalog.length(%I) <= 2000 AND (%I LIKE %L OR %I LIKE %L))',
          r.schema_name, r.table_name, r.constraint_name,
          r.column_name, r.column_name, 'ludy:s1:%', r.column_name, 'crove:s1:%'
        );
      END IF;
    END IF;
  END LOOP;
END
$$;
