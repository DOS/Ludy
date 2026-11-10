-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up, PR 4 (#2822, from the review of #2920): the two sweep lists, restated in full from 20261212100000 (same signatures, owners and grants; the applied
-- file is not edited) with one more filter: only an org a system context can enter, tenant.status IN ('active', 'offboarding'). A closed org had its data purged and no
-- context to run the sweep commands in, so listing it made the worker ask for it every night and fail. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_results_due(p_limit integer, p_after uuid DEFAULT NULL)
RETURNS TABLE (org_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT DISTINCT r.org_id FROM crove_kernel.member_vy_result r
    JOIN crove_kernel.tenant t ON t.org_id = r.org_id AND t.status IN ('active', 'offboarding')
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
      WHERE EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = d.org_id AND t.status IN ('active', 'offboarding'))
        AND NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = d.org_id AND m.user_id = d.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM crove_kernel.audit_event a
          WHERE a.org_id = d.org_id AND a.occurred_at > pg_catalog.now() - interval '30 days'
            AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = d.user_id)) AS f
    ORDER BY f.recorded DESC, f.org_id, f.user_id LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_former_members_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_former_members_due(integer) TO crove_worker;
