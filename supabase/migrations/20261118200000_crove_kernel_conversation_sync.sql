-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations CV5b (issue #2329): what the worker reads from a platform beyond the webhook. Idempotent; applied files
-- stay untouched.
--
-- 1. crove_kernel.conversation_identity.profile_checked_at: when the platform was asked for the customer's name (once; null again only
--    for a failure worth retrying). The name itself is display_name.
-- 2. crove_kernel.channel_connection.history_synced_at, gap_from, gap_to: when the account's recent chats were last read to fill what
--    the webhook did not bring, and, when that read could not reach back far enough, the period whose events may be missing (shown on
--    the threads active after gap_from). A reconnect clears history_synced_at so the account is read again at once.
-- 3. crove_kernel.conversation_sync_due: the work the relay hands the worker, across orgs, for the worker login alone: the active
--    connections of the providers that can be read whose history is due, and the identities with no name yet, each with the
--    connection to ask through. Ids only.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.conversation_identity ADD COLUMN IF NOT EXISTS profile_checked_at timestamptz;
-- When the work was last handed to the worker (kernel.conversation.sync_request), so the relay does not hand it out again every pass.
ALTER TABLE crove_kernel.conversation_identity ADD COLUMN IF NOT EXISTS profile_requested_at timestamptz;
GRANT UPDATE (profile_checked_at, profile_requested_at) ON crove_kernel.conversation_identity TO crove_tenant;

ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS history_synced_at timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS gap_from timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS gap_to timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS history_requested_at timestamptz;
GRANT UPDATE (history_synced_at, gap_from, gap_to, history_requested_at) ON crove_kernel.channel_connection TO crove_tenant;

CREATE INDEX IF NOT EXISTS conversation_identity_unnamed_idx ON crove_kernel.conversation_identity (provider) WHERE display_name IS NULL AND profile_checked_at IS NULL AND erased_at IS NULL;

CREATE OR REPLACE FUNCTION crove_kernel.conversation_sync_due(p_history_providers text[], p_profile_providers text[], p_history_stale_minutes integer, p_limit integer)
RETURNS TABLE (kind text, org_id uuid, connection_id uuid, identity_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  (SELECT 'history'::text, c.org_id, c.id, NULL::uuid
   FROM crove_kernel.channel_connection c
   JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
   WHERE c.provider = ANY (p_history_providers) AND c.status = 'active'
     AND (c.history_synced_at IS NULL OR c.history_synced_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_history_stale_minutes))
     AND (c.history_requested_at IS NULL OR c.history_requested_at < pg_catalog.now() - interval '30 minutes')
   ORDER BY c.history_synced_at NULLS FIRST, c.id
   LIMIT LEAST(GREATEST(p_limit, 1), 200))
  UNION ALL
  (SELECT 'profile'::text, i.org_id, k.id, i.id
   FROM crove_kernel.conversation_identity i
   JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
   JOIN LATERAL (
     SELECT c2.channel_connection_id AS id FROM crove_kernel.conversation c2
     JOIN crove_kernel.channel_connection cc ON cc.org_id = c2.org_id AND cc.id = c2.channel_connection_id AND cc.status = 'active'
     WHERE c2.org_id = i.org_id AND c2.identity_id = i.id ORDER BY c2.updated_at DESC LIMIT 1) k ON true
   WHERE i.provider = ANY (p_profile_providers) AND i.display_name IS NULL AND i.profile_checked_at IS NULL AND i.erased_at IS NULL
     AND (i.profile_requested_at IS NULL OR i.profile_requested_at < pg_catalog.now() - interval '10 minutes')
   ORDER BY i.created_at, i.id
   LIMIT LEAST(GREATEST(p_limit, 1), 200));
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_sync_due(text[], text[], integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_sync_due(text[], text[], integer, integer) TO crove_worker;
