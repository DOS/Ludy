-- SPDX-License-Identifier: AGPL-3.0-only
-- ludy:concurrent-index
-- The inbox list in both its shapes (kernel.mcp.conversations and the app's own list) orders an org's threads by the latest message, newest first, then by id. The only matching
-- index started with `status`, so a list with no status filter read every thread of the org and, for a member-bound read, ran the row-level security definer once per row before the
-- page of 15 to 30 was cut (#4099, note N1 of #3941). This index lets that order be read straight off the index and stopped at the page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversation_recent_idx ON ludy_kernel.conversation (org_id, last_message_at DESC NULLS LAST, id DESC);
