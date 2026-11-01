-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2251, plan docs/plan/crm.md §4.4 and §8, step K5b): the sweep of contact import staging that outlived
-- its 7 days. Idempotent; applied files stay untouched.
--
-- K5 refuses and deletes a stale staged batch the next time an import command runs in its org. An org that never imports
-- again would keep the rows (personal data read from a file) for good, so the worker also runs a daily pass. The worker
-- has no org of its own to look in, so it asks this definer which orgs hold a staged batch older than the cutoff, then
-- runs crm.import.expire in each org's system context, where the tenant policy shows that org's rows alone.
--
-- crove_crm.import_expired(before, limit)  the orgs with a staged batch created before `before`, oldest org id first, at
--                                          most `limit` (1 to 1000). It answers org ids only, never a row. Callable by the
--                                          worker login alone, and not from inside an org's context.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_crm.import_expired(p_before timestamptz, p_limit integer)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT DISTINCT b.org_id FROM crove_crm.import_batch b
    WHERE b.status = 'staged' AND b.created_at < p_before
    ORDER BY 1 LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_crm.import_expired(timestamptz, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_crm.import_expired(timestamptz, integer) TO crove_worker;

-- The worker's queue (apps/kernel/src/crm-worker.ts): the daily sweep, scheduled when the crm module is installed.
SELECT crove_jobs.create_queue('crm-import-expire', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
