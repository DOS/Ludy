-- SPDX-License-Identifier: AGPL-3.0-only
-- PROTOTYPE of step 3e-2, run only to see which pinned invariants it touches; not committed in 3e-1.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_kind text;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT g.user_id, g.kind, g.revoked_at, g.expires_at INTO v_user, v_kind, v_revoked, v_expires
  FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'company' THEN
    RAISE EXCEPTION 'MCP_GRANT_NOT_COMPANY' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
    PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user FOR SHARE;
  END IF;
  IF NOT crove_kernel.mcp_grant_standing(p_grant_id, p_org_id, v_user) THEN
    IF v_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'MCP_GRANT_REVOKED' USING ERRCODE = '42501';
    END IF;
    IF v_expires <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'MCP_GRANT_EXPIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1, 'org', p_org_id, 'actor', 'agent', 'user', NULL, 'role', v_role, 'agent', p_grant_id, 'run', NULL, 'position', NULL,
    'module', 'kernel', 'max_risk', 'R0', 'tainted', true, 'le_scope', pg_catalog.jsonb_build_array('*'), 'flags', '[]'::jsonb,
    'kind', 'mcp_company', 'grantor', v_user));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'grantor', v_user, 'maxRisk', 'R0', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_context(uuid, uuid) TO crove_app;
