-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #2151, follow-up of #2141): store the buyer's name ('Tên người mua') on
-- ludy_finance.portal_invoice_row so a sale on the tax portal without a buyer tax code (for example, an individual
-- customer) names the customer instead of showing blank. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.portal_invoice_row
  ADD COLUMN IF NOT EXISTS buyer_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'ludy_finance.portal_invoice_row'::regclass
      AND c.conname = 'portal_invoice_row_buyer_name_check'
  ) THEN
    ALTER TABLE ludy_finance.portal_invoice_row
      ADD CONSTRAINT portal_invoice_row_buyer_name_check
      CHECK (buyer_name IS NULL OR pg_catalog.length(buyer_name) <= 500);
  END IF;
END $$;
