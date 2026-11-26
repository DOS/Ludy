-- SPDX-License-Identifier: AGPL-3.0-only
-- Separate poll state and timestamp for the marketplace income leg (#4306, follow-up of #4302). Idempotent; applied files stay untouched.
--
-- The orders leg and the income leg share one connection row, so previously an income failure set `last_poll_state` and triggered the hourly or six-hour back-off for the orders leg too.
-- Adding `last_income_polled_at` and `last_income_poll_state` lets each leg track its own state and back-off independently while keeping `poll_cursor` as the shared `<orders>|<income>` text.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.marketplace_connection
  ADD COLUMN IF NOT EXISTS last_income_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_income_poll_state text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_finance'
      AND t.relname = 'marketplace_connection'
      AND c.conname = 'marketplace_connection_last_income_poll_state_check'
  ) THEN
    ALTER TABLE ludy_finance.marketplace_connection
      ADD CONSTRAINT marketplace_connection_last_income_poll_state_check
      CHECK (last_income_poll_state IN ('ok', 'unreachable', 'credentials', 'rate_limited', 'too_large', 'not_recognized'));
  END IF;
END $$;

GRANT UPDATE (last_income_polled_at, last_income_poll_state)
  ON ludy_finance.marketplace_connection TO ludy_tenant;
