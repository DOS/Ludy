-- SPDX-License-Identifier: AGPL-3.0-only
-- Stock lead time setting (#2685, plan stock-and-marketplaces.md section 8.6):
-- adds `stock_lead_days` to `ludy_finance.collection_setting` (the org's one finance settings row, #2488)
-- so owners and admins set how many days a supplier takes to deliver (1 to 90, default 14).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.collection_setting
  ADD COLUMN IF NOT EXISTS stock_lead_days smallint NOT NULL DEFAULT 14;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_finance'
      AND t.relname = 'collection_setting'
      AND c.conname = 'collection_setting_stock_lead_days_check'
  ) THEN
    ALTER TABLE ludy_finance.collection_setting
      ADD CONSTRAINT collection_setting_stock_lead_days_check
      CHECK (stock_lead_days BETWEEN 1 AND 90);
  END IF;
END $$;

GRANT UPDATE (stock_lead_days) ON ludy_finance.collection_setting TO ludy_tenant;
