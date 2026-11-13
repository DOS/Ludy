-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel, Telegram bot chats in Hộp thư (issue #3132, plan docs/plan/conversations-channels.md section 4.2). Idempotent; applied files
-- stay untouched.
--
-- A Telegram webhook update does not name the bot, so the route is /api/channels/telegram/webhook/<hook> and the connection holds the hook:
--
-- 1. crove_kernel.channel_connection.chat_hook: the opaque id (32 random bytes, base64url, 43 characters) of the webhook the connection answers
--    chats on now. chat_hook_next: the id of the webhook being set (a first turn on, or a reconnect, which gives a new hook and so a new secret):
--    the old one stays valid until the worker has set the new one, so no message sent in between is lost. Each is unique across the deployment,
--    names a connection and never an org, and is null when chats are off. The secret_token Telegram echoes is not stored: it is derived from the
--    hook under a key of the deployment, so the route checks it before it reads the body or asks the database.
-- 2. chat_state: off, enabling (the worker is setting the webhook), on, disabling (the worker is deleting it). chat_changed_at: when the state last
--    changed, so a switch whose job was lost can be asked again. chat_error: the code of the last attempt that failed, for the screen to word.
--    chat_bot_id: the bot's numeric id, a public number, so a second connection of the same org holding the same bot is refused instead of taking
--    the webhook from the first.
-- 3. crove_kernel.conversation_chat_hook_connections: where a parked notice goes. The worker login's alone: the active connection of an active
--    org that holds the hook (current or next). The org comes from the stored connection, never from the notice (ADR-0039).
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_hook text;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_hook_next text;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_state text NOT NULL DEFAULT 'off';
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_error text;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_bot_id text;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS chat_changed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.channel_connection'::regclass AND conname = 'channel_connection_chat_check') THEN
    ALTER TABLE crove_kernel.channel_connection ADD CONSTRAINT channel_connection_chat_check CHECK (
      chat_state IN ('off', 'enabling', 'on', 'disabling')
      AND (chat_hook IS NULL OR chat_hook ~ '^[A-Za-z0-9_-]{43}$')
      AND (chat_hook_next IS NULL OR chat_hook_next ~ '^[A-Za-z0-9_-]{43}$')
      AND (chat_hook IS DISTINCT FROM chat_hook_next OR chat_hook IS NULL)
      -- A hook exists exactly while chats are on or being switched: off has none, enabling has the one being set, on has the live one and
      -- nothing being set.
      AND ((chat_state = 'off') = (chat_hook IS NULL AND chat_hook_next IS NULL))
      AND (chat_state <> 'enabling' OR chat_hook_next IS NOT NULL)
      AND (chat_state <> 'on' OR (chat_hook IS NOT NULL AND chat_hook_next IS NULL))
      AND (chat_error IS NULL OR chat_error ~ '^[A-Za-z0-9_.:-]{1,60}$')
      AND (chat_bot_id IS NULL OR chat_bot_id ~ '^[0-9]{3,20}$')
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_chat_hook_uq ON crove_kernel.channel_connection (chat_hook) WHERE chat_hook IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_chat_hook_next_uq ON crove_kernel.channel_connection (chat_hook_next) WHERE chat_hook_next IS NOT NULL;
GRANT UPDATE (chat_hook, chat_hook_next, chat_state, chat_error, chat_bot_id, chat_changed_at) ON crove_kernel.channel_connection TO crove_tenant;

-- Where a parked Telegram notice goes: the active connection of an active org whose hook (the live one or the one being set) it came in on,
-- while chats are on or switching.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_chat_hook_connections(p_hook text)
RETURNS TABLE (org_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.org_id, c.id FROM crove_kernel.channel_connection c
  JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
  WHERE (c.chat_hook = p_hook OR c.chat_hook_next = p_hook) AND c.provider = 'telegram' AND c.status = 'active' AND c.chat_state IN ('enabling', 'on', 'disabling')
$$;

REVOKE ALL ON FUNCTION crove_kernel.conversation_chat_hook_connections(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_chat_hook_connections(text) TO crove_worker;
