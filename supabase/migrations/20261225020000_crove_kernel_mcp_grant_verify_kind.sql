-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 2, slice 3b-2 (#2975): the edge learns a grant's kind. mcp_grant_verify now also answers `kind` ('company' or 'member'), so
-- the actor the endpoint builds names the context the runtime enters (a member-bound grant enters crove_kernel.enter_mcp_member_context). Nothing
-- else changes: same arguments, same standing check, same refusals (no row), same grants (the API login only).
-- crove:contract adr=0051
DROP FUNCTION IF EXISTS crove_kernel.mcp_grant_verify(uuid, text);
CREATE FUNCTION crove_kernel.mcp_grant_verify(p_grant_id uuid, p_client_id text)
RETURNS TABLE (grant_id uuid, org_id uuid, user_id uuid, scopes text[], client_name text, client_host text, expires_at timestamptz, kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_row crove_kernel.agent_grant%ROWTYPE;
BEGIN
  IF p_grant_id IS NULL OR p_client_id IS NULL THEN
    RETURN;
  END IF;
  SELECT g.* INTO v_row FROM crove_kernel.agent_grant g WHERE g.id = p_grant_id AND g.client_id = p_client_id;
  IF NOT FOUND OR NOT crove_kernel.mcp_grant_standing(v_row.id, v_row.org_id, v_row.user_id) THEN
    RETURN;
  END IF;
  IF v_row.last_used_at IS NULL OR v_row.last_used_at < pg_catalog.clock_timestamp() - interval '5 minutes' THEN
    UPDATE crove_kernel.agent_grant g SET last_used_at = pg_catalog.clock_timestamp() WHERE g.org_id = v_row.org_id AND g.id = v_row.id;
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.org_id, v_row.user_id, v_row.scopes, v_row.client_name, v_row.client_host, v_row.expires_at, v_row.kind;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_verify(uuid, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_verify(uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_grant_verify(uuid, text) TO crove_app;
