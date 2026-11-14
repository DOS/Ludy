-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel conversations, YouTube comments (issue #3134, plan docs/plan/conversations-channels.md section 4.5). Idempotent; applied files
-- stay untouched.
--
-- YouTube has no push for comments and meters its API in quota units per Google project, so a connection that opted in is polled within a
-- daily unit budget of its own. Counters only; no comment text is kept here.
-- 1. crove_kernel.channel_connection: comments_enabled (the owner's or an admin's opt-in; nothing is read until it is on), the day's counters
--    (quota_reset_at is when the period ends, the next midnight Pacific time; quota_poll_units and quota_reply_units are what Ludy spent for this
--    connection in it), quota_blocked_until (Google refused the project's quota: no poll before it), history_next_at (when the next poll is due:
--    an adaptive interval, so the relay does not read the connection hourly) and history_idle_polls (polls in a row that found nothing new).
-- 2. crove_kernel.conversation_sync_due: a connection with history_next_at set is due when that time has come, any other as before (stale
--    after the given minutes); and a request that was answered (history_synced_at is not before history_requested_at) may be made again at once,
--    not only after 30 minutes, which an interval of 15 minutes needs. Other providers keep history_next_at NULL, so their hourly read is unchanged.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS quota_reset_at timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS quota_poll_units integer NOT NULL DEFAULT 0;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS quota_reply_units integer NOT NULL DEFAULT 0;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS quota_blocked_until timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS history_next_at timestamptz;
ALTER TABLE crove_kernel.channel_connection ADD COLUMN IF NOT EXISTS history_idle_polls integer NOT NULL DEFAULT 0;
GRANT UPDATE (comments_enabled, quota_reset_at, quota_poll_units, quota_reply_units, quota_blocked_until, history_next_at, history_idle_polls) ON crove_kernel.channel_connection TO crove_tenant;

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
     AND (
       (c.history_next_at IS NOT NULL AND c.history_next_at <= pg_catalog.now())
       OR (c.history_next_at IS NULL AND (c.history_synced_at IS NULL OR c.history_synced_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_history_stale_minutes)))
     )
     AND (
       c.history_requested_at IS NULL
       OR c.history_requested_at < pg_catalog.now() - interval '30 minutes'
       OR (c.history_next_at IS NOT NULL AND c.history_synced_at IS NOT NULL AND c.history_synced_at >= c.history_requested_at)
     )
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
