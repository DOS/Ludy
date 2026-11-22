-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #4381, found in the review of #3480): `crove_kernel.conversation_purge_due` lists the orgs the daily conversation purge visits. It listed only an org with a thread past its retention
-- or an erase tombstone older than 30 days, so an org that keeps threads forever (retention NULL) and has no old tombstone was never visited, and the purge's org-wide sweep of identities left with no
-- thread (`deleteOrphanIdentities`) never ran for it. An identity no thread or message names (made by the private-reply echo path, or skipped by an erase because another transaction held its row) then
-- kept its name and platform id, which are personal data, indefinitely.
-- This restates that one function (from 20261118180000_crove_kernel_conversation_retention.sql, its only earlier definition, and nothing else) with a third branch: an active org that holds an identity,
-- not a tombstone, that no thread and no message names and that has not been touched for a day (an intake's identity that is about to get its thread is left alone). The purge command already sweeps these for
-- an org with no thread to delete, so listing the org is the whole fix. Ids only; the worker's login alone. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.conversation_purge_due(p_limit integer)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'CONVERSATION_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.org_id FROM (
    SELECT c.org_id, pg_catalog.min(COALESCE(c.last_message_at, c.opened_at)) AS oldest
    FROM crove_kernel.conversation c
    JOIN crove_kernel.tenant t ON t.org_id = c.org_id AND t.status = 'active'
    LEFT JOIN crove_kernel.conversation_setting s ON s.org_id = c.org_id
    WHERE COALESCE(c.last_message_at, c.opened_at) < pg_catalog.now() - pg_catalog.make_interval(months => CASE WHEN s.id IS NULL THEN 24 ELSE s.retention_months::integer END)
    GROUP BY c.org_id
    UNION ALL
    -- An org with an erase tombstone older than 30 days, whatever its retention.
    SELECT i.org_id, pg_catalog.min(i.erased_at)
    FROM crove_kernel.conversation_identity i
    JOIN crove_kernel.tenant t ON t.org_id = i.org_id AND t.status = 'active'
    WHERE i.erased_at < pg_catalog.now() - interval '30 days'
    GROUP BY i.org_id
    UNION ALL
    -- An org with an identity that nothing names any more (no thread, no message author), untouched for a day, whatever its retention (#4381). It sorts after the orgs that are overdue.
    SELECT t.org_id, pg_catalog.now()
    FROM crove_kernel.tenant t
    WHERE t.status = 'active'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.conversation_identity i
        WHERE i.org_id = t.org_id AND i.erased_at IS NULL AND i.updated_at < pg_catalog.now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = i.org_id AND c.identity_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = i.org_id AND m.author_identity_id = i.id))
  ) d
  GROUP BY d.org_id
  ORDER BY pg_catalog.min(d.oldest), d.org_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_purge_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.conversation_purge_due(integer) TO crove_worker;
