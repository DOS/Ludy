-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (issue #4894, the same gap as #4582 note 2, found in the review of #4893): ludy_kernel.mcp_wake_company_targets(org, limit) lists the company grants to wake for a published-minutes event.
-- It is a worker-only definer that took the org as an argument and trusted it, so the worker's login could ask it for the grant ids of any org. Like ludy_meetings.minutes_wake_open (#4893) and
-- ludy_sign.webhook_delivery_get it now also holds the caller to the org of the transaction: the system context must be set (ctx_org_id() is not null and ctx_actor_type() is 'system'), and
-- p_org_id must be that org, or it raises NO_CONTEXT (42501). The only caller, kernel.mcp.wake.minutes_targets (packages/kernel/src/mcp-wake.ts), runs as the system with the org's context, so nothing it
-- does changes; a call for another org, or with no context, now fails instead of listing that org's grants. It only tightens: the rows, the grants (the worker's login alone) and the search path
-- are those of 20270209120000_crove_kernel_mcp_wake_minutes.sql.
--
-- Body check: the SELECT is the previous definition's, word for word (its schema names are the ones the schemas carry now); the function was LANGUAGE sql and is now plpgsql only to be able to raise,
-- so the output column is named by RETURNS TABLE as before and every column reference is qualified. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.mcp_wake_company_targets(p_org_id uuid, p_limit integer)
RETURNS TABLE (grant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR p_org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.grant_id
  FROM ludy_kernel.agent_grant_wake w
  JOIN ludy_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
  WHERE w.org_id = p_org_id
    AND w.enabled
    AND g.kind = 'company'
    AND ludy_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
  ORDER BY w.grant_id
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.mcp_wake_company_targets(uuid, integer) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.mcp_wake_company_targets(uuid, integer) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.mcp_wake_company_targets(uuid, integer) TO ludy_worker;
