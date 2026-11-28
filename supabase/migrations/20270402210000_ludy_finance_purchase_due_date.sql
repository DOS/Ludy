-- SPDX-License-Identifier: AGPL-3.0-only
-- Payment due date on a purchase document (#4395, follow-up of #4391):
-- adds nullable `due_date date` to `ludy_finance.purchase_document` (append-only once recorded;
-- read from purchase e-invoice XML or edited on the pending proposal before approval).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.purchase_document
  ADD COLUMN IF NOT EXISTS due_date date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'ludy_finance.purchase_document'::regclass
      AND c.conname = 'purchase_document_due_date_ck'
  ) THEN
    ALTER TABLE ludy_finance.purchase_document
      ADD CONSTRAINT purchase_document_due_date_ck
      CHECK (due_date IS NULL OR due_date >= invoice_date);
  END IF;
END $$;
