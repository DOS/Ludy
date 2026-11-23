-- SPDX-License-Identifier: AGPL-3.0-only
-- The switch check of an MCP grant's entry answers only for the context the caller entered (hardening a, notes from the security review of #4155 and #4189, issue #4160).
-- crove_kernel.mcp_switch_check(org, grant, module) (20270125600000) took the org and the grant from its caller. Only the API login can call it, so the exposure was one boolean about a switch row, but it
-- now also requires that the org is the org of the sealed context and the grant is the agent the sealed context names (the entry seals `agent` = the grant for every kind of company entry: write, draft and
-- proposal), so a check can only be asked about the call it is part of. A name that is not a module is still refused first (MCP_GRANT_SCOPE); a call outside an entered context, or about another org or
-- grant, is refused with MCP_SWITCH_CONTEXT (42501) and reads no switch row. Signature, owner, privileges and the rest of the body are unchanged.
-- Idempotent (create or replace); applied files untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.mcp_switch_check(p_org_id uuid, p_grant_id uuid, p_module text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_org_id IS NULL OR p_grant_id IS NULL OR p_module IS NULL OR p_module !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id OR crove_kernel.ctx_agent_id() IS DISTINCT FROM p_grant_id THEN
    RAISE EXCEPTION 'MCP_SWITCH_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k
    WHERE k.org_id = p_org_id AND k.released_at IS NULL
      AND ((k.scope = 'module' AND k.target = p_module) OR (k.scope = 'agent' AND k.target = p_grant_id::text))
  ) THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_switch_check(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_switch_check(uuid, uuid, text) TO crove_app;
