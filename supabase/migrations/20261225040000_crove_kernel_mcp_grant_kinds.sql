-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 2, issue #2975, slice 3, step 3c-3: the screen needs each listed grant's kind to know where a wake-up may be set. mcp_grant_kinds answers the kind of the same
-- grants mcp_grant_list answers (an owner or admin: the org's; anyone else: their own, from the last 30 days), and nothing else. mcp_grant_list keeps its return type, so every
-- migration file stays re-appliable.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_kinds()
RETURNS TABLE (id uuid, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_all boolean;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  SELECT m.role IN ('owner', 'admin') INTO v_all FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_all IS NULL THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT g.id, g.kind
  FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org
    AND (v_all OR g.user_id = v_user)
    AND g.expires_at > pg_catalog.now() - interval '30 days'
    AND (g.revoked_at IS NULL OR g.revoked_at > pg_catalog.now() - interval '30 days')
  ORDER BY g.created_at DESC, g.id DESC
  LIMIT 200;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_kinds() FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_kinds() FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_grant_kinds() TO crove_app;
