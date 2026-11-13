-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 4, issues #2967 and #2969, step S5: the worker enters a company grant's sealed context to look at its signals.
-- - seal_mcp_company_context(org, grant) is the private core: it re-checks the grant's standing, reads the grantor's role live (owner or admin, else refused) and seals the
--   agent-shaped, read-only, tainted R0 context that names the grant and the grantor. It is the only function that names the `mcp_company` kind; no login may run it.
-- - enter_mcp_company_context(org, grant) keeps its signature and its grants (the API's login alone) and now only calls the core.
-- - enter_mcp_wake_company_context(org, grant) is the worker's entry, for the worker's login alone: the grant must be a company grant with a wake registration that mcp_wake_due would pick
--   (enabled, signals due), and the transaction must be read-only. It seals the same context through the same core, so nothing the worker sees differs from a pull call. There is no member entry:
--   a member-bound grant never gets signals.
-- A member-bound grant is never entered from the sweep: mcp_wake_due asks no signals for it, and the wake entry refuses any grant that is not a company grant.
-- Idempotent: CREATE OR REPLACE.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.seal_mcp_company_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_kind text;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
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
REVOKE ALL ON FUNCTION crove_kernel.seal_mcp_company_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN crove_kernel.seal_mcp_company_context(p_org_id, p_grant_id);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_context(uuid, uuid) TO crove_app;

CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_wake_company_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  -- Queries only: the sealed context reads, and the transaction says so.
  IF pg_catalog.current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'MCP_CONTEXT_READ_ONLY' USING ERRCODE = '25006';
  END IF;
  -- The rows mcp_wake_due picks for signals: a company grant whose wake-up is on and whose signals are due. Nothing else is entered.
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.agent_grant_wake w
    JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id
    WHERE w.org_id = p_org_id AND w.grant_id = p_grant_id AND w.enabled AND g.kind = 'company'
      AND (w.signals_checked_at IS NULL OR w.signals_checked_at <= pg_catalog.clock_timestamp() - interval '5 minutes')
  ) THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  RETURN crove_kernel.seal_mcp_company_context(p_org_id, p_grant_id);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_wake_company_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_wake_company_context(uuid, uuid) TO crove_worker;
