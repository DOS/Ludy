-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 2, slice 3b-2 (#2975): the edge learns a grant's kind. mcp_grant_kind answers 'company' or 'member' for a grant in good standing, so the
-- actor the endpoint builds names the context the runtime enters (a member-bound grant enters crove_kernel.enter_mcp_member_context). mcp_grant_verify
-- is left as it is (its return type is not changed: every migration file must stay re-appliable). The kind never changes after the grant is made.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_kind(p_grant_id uuid, p_client_id text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.kind
  FROM crove_kernel.agent_grant g
  WHERE g.id = p_grant_id AND g.client_id = p_client_id AND crove_kernel.mcp_grant_standing(g.id, g.org_id, g.user_id)
$$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_kind(uuid, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_grant_kind(uuid, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_grant_kind(uuid, text) TO crove_app;
