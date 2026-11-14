-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, Telegram Business mode in Hộp thư (issue #3191, plan docs/plan/conversations-channels.md section 4.2). Idempotent; applied files
-- stay untouched.
--
-- crove_kernel.channel_connection.chat_business: the business accounts a Telegram connection's bot is connected to, as Telegram told it in its
-- business_connection updates: a JSON array of at most 10 entries {id, userId, name, canReply, enabled}. Only the system command
-- kernel.channel.telegram_business_record writes it, from an update the webhook route verified; the core stores a business message only while
-- the entry for its business connection is enabled. Empty for a connection that has none; cleared when the connection is disconnected. The shape of
-- an entry is the command's to check; the table only keeps it a small array.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_business jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.channel_connection'::regclass AND conname = 'channel_connection_chat_business_check') THEN
    ALTER TABLE crove_kernel.channel_connection ADD CONSTRAINT channel_connection_chat_business_check CHECK (
      pg_catalog.jsonb_typeof(chat_business) = 'array'
      AND pg_catalog.jsonb_array_length(chat_business) <= 10
      AND pg_catalog.pg_column_size(chat_business) <= 8192
    );
  END IF;
END $$;

GRANT UPDATE (chat_business) ON crove_kernel.channel_connection TO crove_tenant;
