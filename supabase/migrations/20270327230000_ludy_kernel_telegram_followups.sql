-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (#5028, follow-ups from #4998 / #3150): enforce object shape and 8 KiB serialized text size cap on
-- channel_connection.chat_business_order. Added NOT VALID here without scanning existing rows under ACCESS EXCLUSIVE;
-- validated under SHARE UPDATE EXCLUSIVE in 20270327230100 and paired with concurrent partial indexes in 20270327230200.
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
        AND pg_catalog.octet_length(chat_business_order::text) <= 8192
      ) NOT VALID;
  END IF;
END $$;
