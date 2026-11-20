-- SPDX-License-Identifier: AGPL-3.0-only
-- The module and coworker switches at the write and proposal entries of an MCP grant (#4155, a follow-up of the shared-core review of #4150; ADR-0051 decisions 10 and 11, ADR-0053). A company grant's entry
-- (enter_mcp_company_draft_context, enter_mcp_company_write_context, enter_mcp_company_proposal_context) reads the grant's standing: live, the org not stopped, the deployment's AI switch off. It did not read the two stops
-- an owner or admin uses for one app or one coworker, which an org-chart agent's entry does (20261018050000): a kill switch of scope `module` and one of scope `agent`. What this adds:
--   crove_kernel.mcp_switch_check(org, grant, module)   the API login's alone, called by the runtime right after one of those entries, in the same transaction, with the module the command belongs to (for a proposal, the
--                        module of the command the proposal is for): it refuses with KILL_SWITCH_ON (42501) when a switch of scope `module` names that module, or a switch of scope `agent` names the grant, is engaged
--                        now. It reads the switch rows only and writes nothing, so the refusal is audited by the runtime as the grant's, as any command it refuses is. The app gate (ADR-0053, `apps_off`) already
--                        answers MODULE_OFF for the same module straight after the entry, so it is not asked twice here.
--   crove_kernel.ctx_mcp_engage_write()   no longer a definer (the review's item 2): crove_tenant, the only role that calls it, already holds EXECUTE on ctx_verified(), so it reads the sealed context as itself and the
--                        comment of 20270122190000 that said a tenant login may not read it was wrong. The body, the privileges and the policies that call it are unchanged.
-- Idempotent (create or replace, revoke, grant); applied files untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.mcp_switch_check(p_org_id uuid, p_grant_id uuid, p_module text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_org_id IS NULL OR p_grant_id IS NULL OR p_module IS NULL OR p_module !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
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

CREATE OR REPLACE FUNCTION crove_kernel.ctx_mcp_engage_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(crove_kernel.ctx_actor_type() = 'agent'
                  AND (crove_kernel.ctx_verified() ->> 'kind') = 'mcp_engage_write'
                  AND '*' = ANY ((crove_kernel.ctx_le_scope())::text[]), false)
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_mcp_engage_write() FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_mcp_engage_write() TO crove_tenant;
