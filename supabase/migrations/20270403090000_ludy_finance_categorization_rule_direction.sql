-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #1452): extend ludy_finance.categorization_rule to support learned revenue account rules for
-- sales lines alongside purchase lines. Idempotent; applied files stay untouched.
--
--   direction  'purchase' (expense, asset or inventory debit account for a vendor/every vendor) or 'sale' (revenue
--              credit account for a customer/every customer). Existing rows default to 'purchase' and never change in
--              place: ludy_tenant keeps its column-level UPDATE grant (label, debit_account, confirmed_by,
--              confirmed_at, source_document_id) and cannot update direction.
--   categorization_rule_match_uq
--              uniqueness now includes direction so a purchase rule and a sales rule with the same counterparty and text
--              can coexist inside the same legal entity.
--   categorization_rule_direction_account_check
--              holds every writer to the same direction/account split as purchase_line (check_line_direction): sales
--              rules name revenue accounts (5*, 711*, 3387*) and purchase rules never do.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.categorization_rule
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'purchase';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'ludy_finance.categorization_rule'::pg_catalog.regclass
      AND c.conname = 'categorization_rule_direction_check'
  ) THEN
    ALTER TABLE ludy_finance.categorization_rule
      ADD CONSTRAINT categorization_rule_direction_check CHECK (direction IN ('purchase', 'sale'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'ludy_finance.categorization_rule'::pg_catalog.regclass
      AND c.conname = 'categorization_rule_direction_account_check'
  ) THEN
    ALTER TABLE ludy_finance.categorization_rule
      ADD CONSTRAINT categorization_rule_direction_account_check
      CHECK ((direction = 'purchase' AND debit_account !~ '^(5|711|3387)') OR (direction = 'sale' AND debit_account ~ '^(5|711|3387)'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'ludy_finance.categorization_rule'::pg_catalog.regclass
      AND c.conname = 'categorization_rule_match_uq'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%direction%'
  ) THEN
    ALTER TABLE ludy_finance.categorization_rule DROP CONSTRAINT IF EXISTS categorization_rule_match_uq;
    ALTER TABLE ludy_finance.categorization_rule ADD CONSTRAINT categorization_rule_match_uq
      UNIQUE NULLS NOT DISTINCT (org_id, legal_entity_id, direction, vendor_party_id, match_kind, match_text);
  END IF;
END $$;
