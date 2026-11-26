-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:concurrent-index
-- Ludy kernel (#5028): concurrent partial indexes on channel_connection for 10s displacement sweeps and bot lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connection_chat_displace_pending_idx ON ludy_kernel.channel_connection (chat_changed_at NULLS LAST, org_id, id) WHERE chat_displace_pending = true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connection_chat_bot_id_idx ON ludy_kernel.channel_connection (chat_bot_id, org_id, id) WHERE chat_bot_id IS NOT NULL;
