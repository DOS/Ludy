-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3710 slice 2, plan stock-and-marketplaces.md section 8.5): the household's own answer to "do your goods and services get the Decree 174 VAT cut?".
-- The cut is not applied to all revenue by default (the PO's decision of 2026-11-18): Decree 174 excludes groups of goods and services, and only the household knows which of its goods are in them.
-- A profile is append-only, so the answer is a column of the profile row: a change is a new profile row from its date, never an edit. NULL means not answered; the books then compute without
-- the cut and show what the VAT would be if the household were eligible. The cut itself stays dated data (crove_finance.household_tax_reduction, migration 20270112120000), never a constant.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.household_profile ADD COLUMN IF NOT EXISTS vat_cut_eligible text;

-- One constraint under a fixed name, added only when it is missing, so a second run changes nothing. A new nullable column has no row to validate beyond NULL, so the table is not scanned for long.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_finance.household_profile'::pg_catalog.regclass AND conname = 'household_profile_vat_cut_eligible_check'
  ) THEN
    ALTER TABLE crove_finance.household_profile
      ADD CONSTRAINT household_profile_vat_cut_eligible_check CHECK (vat_cut_eligible IS NULL OR vat_cut_eligible IN ('yes', 'no'));
  END IF;
END
$$;

COMMENT ON COLUMN crove_finance.household_profile.vat_cut_eligible IS
  'The household''s answer on the Decree 174 VAT cut for its goods and services: yes, no, or NULL (not answered; the books compute without the cut and show the VAT if eligible).';
