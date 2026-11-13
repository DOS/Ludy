-- SPDX-License-Identifier: AGPL-3.0-only
-- The sealed context of a member-bound MCP grant, step 3b-1 (ADR-0051 decision 2, ADR-0049; design note on #2975, slice 3, section 5). SQL only: no runtime or API code reads any of this yet, so
-- nothing changes for a call until the runtime enters the context (step 3b-2). Idempotent; applied files stay untouched.
--   mcp_member_table             the catalog of tables a member-bound MCP grant may read: mode 'read' only, filled only by a migration, empty here (the private scope ships dark).
--   ctx_mcp_member_id()          the sealed member of a context of kind 'mcp_member', NULL for every other context. A table opts in to a member grant by a policy that reads THIS helper and by a row in the
--                                catalog. It is not ctx_acting_user_id(): that one answers for Vy in member mode, and a member grant must not read what Vy's catalog opted in (a private note); each kind opens
--                                only the tables listed for it.
--   enter_mcp_member_context(org, grant)
--                                the API's login only. Enters an agent-shaped context sealed with kind 'mcp_member', the member and their live rights (the role and the legal entities their role assignments
--                                give, as enter_member_vy_context computes them), max_risk R0, `user` NULL and the grant's id as the agent, so every policy written as `= ctx_user_id()` refuses it and the
--                                "system" clause of the policies (no user and no agent) can never match it. The gate is mcp_grant_standing, the one function that decides whether a grant stands; this
--                                function adds no second copy of that logic. It refuses, with a code each: a grant that is not of this org or does not exist (MCP_GRANT_INVALID, 28000), a company grant
--                                (MCP_GRANT_NOT_MEMBER), a revoked one (MCP_GRANT_REVOKED), an expired one (MCP_GRANT_EXPIRED), a member or viewer's grant while the org's switch is off (MCP_MEMBER_GRANTS_OFF), and
--                                anything else that ends standing (a removed member, a disabled account, a stopped org, a kill switch: MCP_GRANT_INVALID). The reason is worked out only after standing said no.
-- agent_write_guard is untouched: a context of this kind has no allowlist and no catalog 'write' row, so every guarded write refuses it, as for every agent context that is not listed (a test pins it).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.mcp_member_table (
  table_name text PRIMARY KEY CHECK (table_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  mode text NOT NULL CHECK (mode = 'read'),
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$')
);
REVOKE ALL ON crove_kernel.mcp_member_table FROM PUBLIC;
GRANT SELECT ON crove_kernel.mcp_member_table TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.mcp_member_table');

CREATE OR REPLACE FUNCTION crove_kernel.ctx_mcp_member_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN crove_kernel.ctx_actor_type() = 'agent' AND crove_kernel.ctx_verified() ->> 'kind' = 'mcp_member'
              THEN (crove_kernel.ctx_verified() ->> 'member')::uuid END
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_mcp_member_id() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_mcp_member_id() TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_member_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_kind text;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
  v_switch boolean;
  v_scope jsonb;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  SELECT g.user_id, g.kind, g.revoked_at, g.expires_at INTO v_user, v_kind, v_revoked, v_expires
  FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  IF NOT FOUND THEN
    -- Not a grant, or a grant of another org: one answer for both.
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'member' THEN
    RAISE EXCEPTION 'MCP_GRANT_NOT_MEMBER' USING ERRCODE = '42501';
  END IF;
  -- A removal and this entry serialize on the member's membership row. A read-only transaction (a query) writes nothing and cannot take a row lock, so it takes none: it sees the
  -- membership as of its snapshot, and every command re-enters in its own transaction.
  IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
    PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user FOR SHARE;
  END IF;
  -- The gate: the one definition of "this grant stands now". The reasons below only name why it does not, after it said no.
  IF NOT crove_kernel.mcp_grant_standing(p_grant_id, p_org_id, v_user) THEN
    IF v_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'MCP_GRANT_REVOKED' USING ERRCODE = '42501';
    END IF;
    IF v_expires <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'MCP_GRANT_EXPIRED' USING ERRCODE = '42501';
    END IF;
    SELECT m.role, t.mcp_member_grants INTO v_role, v_switch
    FROM crove_kernel.tenant_member m JOIN crove_kernel.tenant t ON t.org_id = m.org_id
    WHERE m.org_id = p_org_id AND m.user_id = v_user;
    IF FOUND AND v_role NOT IN ('owner', 'admin') AND NOT v_switch THEN
      RAISE EXCEPTION 'MCP_MEMBER_GRANTS_OFF' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  -- The member's rights, as enter_context computes them: the base role and the legal entities of their role assignments.
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user;
  IF v_role NOT IN ('owner', 'admin') AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a WHERE a.org_id = p_org_id AND a.user_id = v_user AND a.legal_entity_id IS NULL
  ) THEN
    SELECT pg_catalog.jsonb_agg(DISTINCT a.legal_entity_id::text ORDER BY a.legal_entity_id::text) INTO v_scope
    FROM crove_kernel.role_assignment a WHERE a.org_id = p_org_id AND a.user_id = v_user;
  END IF;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_grant_id,
    'run', NULL,
    'position', NULL,
    'module', 'kernel',
    'max_risk', 'R0',
    'tainted', true,
    'le_scope', COALESCE(v_scope, pg_catalog.jsonb_build_array('*')),
    'flags', '[]'::jsonb,
    'kind', 'mcp_member',
    'member', v_user));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'member', v_user, 'maxRisk', 'R0', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_member_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_member_context(uuid, uuid) TO crove_app;
