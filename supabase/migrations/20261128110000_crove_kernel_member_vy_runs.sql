-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2782, ADR-0049 decisions 1, 3 and 6, slice 3 of 4 of #2755): what the commands of a member's Vy need from
-- the database. Idempotent; applied files stay untouched.
--   member_vy_member_active(org, user)   whether the member may still work with Vy now: still a member of the org with a base role
--                                        that may act, holds vy.use, and the account is not disabled (the test calendar_credential_get
--                                        applies). The entry of a background run (stage B) and the store command's re-check call it.
--   member_vy_runs_cancel(agents, user, module, reason)
--                                        ends the live runs of a member's Vy: an owner, an admin or the system context asks, because
--                                        the run policy hides these runs from every context but their member's.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_member_active(p_org uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    JOIN crove_kernel.user_account u ON u.id = m.user_id
    WHERE m.org_id = p_org AND m.user_id = p_user AND m.role IN ('owner', 'admin', 'member', 'viewer') AND u.disabled_at IS NULL)
    AND crove_kernel.member_has_permission(p_org, p_user, 'vy.use')
$$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_member_active(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_member_active(uuid, uuid) TO crove_worker;

-- Cancels the running runs of member_vy agents in the context's org that match any filter given (agent ids, a member, a module of
-- the run). Only an owner or admin user context or the system context may call it; it returns how many runs it ended and nothing else.
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_runs_cancel(p_agent_ids uuid[], p_user uuid, p_module text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- ai_run.error holds a fixed code, never text.
  IF p_reason IS NULL OR p_reason !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'MEMBER_VY_REASON' USING ERRCODE = '22023';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    -- The system context of the worker login only, as member_vy_private_counts asks.
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_kernel.ai_run r SET status = 'cancelled', finished_at = pg_catalog.now(), error = p_reason
  FROM crove_kernel.agent a
  WHERE r.org_id = v_org AND r.status = 'running' AND a.org_id = r.org_id AND a.id = r.agent_id AND a.kind = 'member_vy'
    AND ((p_agent_ids IS NOT NULL AND r.agent_id = ANY (p_agent_ids))
         OR (p_user IS NOT NULL AND a.member_user_id = p_user)
         OR (p_module IS NOT NULL AND r.module = p_module));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE crove_kernel.member_vy_result v SET status = 'failed', error_code = 'RUN_CANCELLED'
  WHERE v.org_id = v_org AND v.status = 'running'
    AND EXISTS (SELECT 1 FROM crove_kernel.ai_run r WHERE r.org_id = v.org_id AND r.id = v.run_id AND r.status = 'cancelled');
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_runs_cancel(uuid[], uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_runs_cancel(uuid[], uuid, text, text) TO crove_tenant;
