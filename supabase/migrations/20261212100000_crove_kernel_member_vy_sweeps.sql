-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up, part 2 (#2822): the two sweeps that keep a member's private Vy data from outliving its time, independent of Notes
-- (the core migration 20261128090000 only gave the definers; nothing called them but the Notes sweep). Idempotent; applied files stay untouched.
--   member_vy_results_due(limit, after)  the orgs that hold a result past its expires_at, in org id order after the given id (keyset paging, so a
--                                        sweep reaches every due org), for the worker's daily sweep (worker login only, outside every
--                                        context). Ids only.
--   member_vy_former_members_due(limit)  the users who hold Vy results or memory in an org they are no longer a member of and were not
--                                        removed from in the last 30 days, with whether the audit trail records their removal
--                                        (kernel.member.remove, outcome ok): the same rule as crove_notes.former_members_due. Recorded ones
--                                        come first, so the unrecorded never crowd them out of the limit. Ids and a flag only.
--   queue kernel-member-vy-sweep               the worker's daily queue (apps/kernel/src/member-vy-worker.ts): the expiry sweep, then the
--                                        former members, each org in its own system context through the commands
--                                        kernel.vy_data.results.expire and kernel.vy_data.member_data.purge.
-- The comment of the core migration that names 20261126160000 as the org_purge base is wrong: the base was 20261127310000.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_results_due(p_limit integer, p_after uuid DEFAULT NULL)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT DISTINCT r.org_id FROM crove_kernel.member_vy_result r
    WHERE r.expires_at < pg_catalog.now() AND (p_after IS NULL OR r.org_id > p_after)
    ORDER BY r.org_id LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_results_due(integer, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_results_due(integer, uuid) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_former_members_due(p_limit integer)
RETURNS TABLE (org_id uuid, user_id uuid, recorded boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.org_id, f.user_id, f.recorded FROM (
      SELECT d.org_id, d.user_id, EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id
        ) AS recorded
      FROM (
          SELECT x.org_id, x.member_user_id AS user_id FROM crove_kernel.member_vy_result x
          UNION
          SELECT y.org_id, y.member_user_id FROM crove_kernel.member_vy_memory y) AS d
      WHERE NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.occurred_at > pg_catalog.now() - interval '30 days'
            AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id)) AS f
    ORDER BY f.recorded DESC, f.org_id, f.user_id LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_former_members_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_former_members_due(integer) TO crove_worker;

SELECT crove_jobs.create_queue('kernel-member-vy-sweep', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
