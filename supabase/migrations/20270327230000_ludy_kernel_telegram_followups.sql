-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (#5028, follow-ups from #4998 / #3150): enforce object shape and 8 KiB size cap on
-- channel_connection.chat_business_order and add partial indexes for 10s displacement sweeps and bot lookups.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_kernel.channel_connection'::regclass
      AND conname = 'channel_connection_chat_business_order_check'
  ) THEN
    ALTER TABLE ludy_kernel.channel_connection
      ADD CONSTRAINT channel_connection_chat_business_order_check CHECK (
        pg_catalog.jsonb_typeof(chat_business_order) = 'object'
        AND pg_catalog.pg_column_size(chat_business_order) <= 8192
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS channel_connection_chat_displace_pending_idx
  ON ludy_kernel.channel_connection (chat_displace_pending, chat_changed_at NULLS LAST, org_id, id)
  WHERE chat_displace_pending = true;

CREATE INDEX IF NOT EXISTS channel_connection_chat_bot_id_idx
  ON ludy_kernel.channel_connection (chat_bot_id, org_id, id)
  WHERE chat_bot_id IS NOT NULL;
