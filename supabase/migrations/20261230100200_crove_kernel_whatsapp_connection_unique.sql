-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel channels: one org at a time holds a WhatsApp phone number (issue #3131, from the independent review of the WhatsApp channel). Idempotent; applied files
-- stay untouched.
--
-- A WhatsApp number is connected by a token the business pastes, which proves only that its holder may call the number, not that the holder is the business (a
-- Facebook Page or an Instagram account is proved by the OAuth dialog of a Page admin). The conversation intake finds every active connection of the platform's
-- account id (crove_kernel.conversation_connections_for), so a second org that connected the same phone number id would receive a copy of every message the
-- first org's customers send, and could answer as the business. channel_connection_live_uq is per org, so nothing stopped it; this index is across orgs
-- (a unique index is not bound by row-level security), for a WhatsApp connection that is not revoked. An expired connection still holds the number until its
-- org disconnects it; a revoked one is history and holds nothing. kernel.channel.connect turns the violation into CHANNEL_ACCOUNT_TAKEN.
SET LOCAL lock_timeout = '2s';

CREATE UNIQUE INDEX IF NOT EXISTS channel_connection_whatsapp_account_uq
  ON crove_kernel.channel_connection (external_account_id) WHERE provider = 'whatsapp' AND status <> 'revoked';
