-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2756, ADR-0049 stage B): the member-scoped background context. Idempotent; applied files stay untouched.
--   member_vy_table                      the catalog of tables Vy in member mode may touch: mode 'read' or 'write'. Filled only by a
--                                        migration. A table whose policy reads ctx_acting_user_id() is listed (the invariant suite
--                                        scans both ways); ai_run and member_vy_result are 'write', member_vy_memory and notes 'read'.
--   ctx_acting_user_id()                 now also the sealed member of a member-scoped agent context (kind 'member_vy').
--   enter_member_vy_context(org, agent, run)
--                                        worker login only. Refuses an org-chart agent, a run that is not live, a member who is no
--                                        longer active (MEMBER_NOT_ACTIVE) or no longer holds vy.use (VY_NOT_ALLOWED), a kill switch and a spent budget. The seal is an agent
--                                        context with a null user and two more fields: member and kind. Rights are the member's
--                                        (role and entity scope as enter_context computes them), max_risk R1 at most.
--   agent_write_guard                    a second branch for kind 'member_vy': a write passes only on a catalog table with mode
--                                        'write' (each row also passes its own policy) or the narrow rows every agent writes; never an
--                                        agent wakeup. The org-chart branches are byte for byte what they were.
--   activity_stamp_agent                 refuses a member-mode context (activity is an org-visible sink).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_kernel.member_vy_table (
  table_name text PRIMARY KEY CHECK (table_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$')
);
REVOKE ALL ON crove_kernel.member_vy_table FROM PUBLIC;
GRANT SELECT ON crove_kernel.member_vy_table TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.member_vy_table');
INSERT INTO crove_kernel.member_vy_table (table_name, mode, adr) VALUES
  ('crove_kernel.ai_run', 'write', 'ADR-0049 decision 2'),
  ('crove_kernel.member_vy_memory', 'read', 'ADR-0049 decision 3'),
  ('crove_kernel.member_vy_result', 'write', 'ADR-0049 decision 3'),
  ('crove_notes.note', 'read', 'ADR-0049 decision 2')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The helper: the context's user for a user context, the sealed member for a member-scoped agent context, NULL for the rest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.ctx_acting_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE crove_kernel.ctx_actor_type()
    WHEN 'user' THEN crove_kernel.ctx_user_id()
    WHEN 'agent' THEN CASE WHEN crove_kernel.ctx_verified() ->> 'kind' = 'member_vy' THEN (crove_kernel.ctx_verified() ->> 'member')::uuid END
  END
$$;

-- ---------------------------------------------------------------------------
-- Memory: a member-scoped run may read its member's memory (the prompt), never write it (ADR-0049 decisions 3 and 5: nothing a model
-- produced reaches memory without the member's own act). member_only of 20261128000000 covered all commands with the helper; it is
-- split so that only the read uses it. The writes stay on ctx_user_id(), which is NULL in every agent context.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS member_only ON crove_kernel.member_vy_memory;
DROP POLICY IF EXISTS member_read ON crove_kernel.member_vy_memory;
CREATE POLICY member_read ON crove_kernel.member_vy_memory AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (member_user_id = (SELECT crove_kernel.ctx_acting_user_id()));
DROP POLICY IF EXISTS member_insert ON crove_kernel.member_vy_memory;
CREATE POLICY member_insert ON crove_kernel.member_vy_memory AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (member_user_id = (SELECT crove_kernel.ctx_user_id()));
DROP POLICY IF EXISTS member_update ON crove_kernel.member_vy_memory;
CREATE POLICY member_update ON crove_kernel.member_vy_memory AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (member_user_id = (SELECT crove_kernel.ctx_user_id()))
  WITH CHECK (member_user_id = (SELECT crove_kernel.ctx_user_id()));
DROP POLICY IF EXISTS member_delete ON crove_kernel.member_vy_memory;
CREATE POLICY member_delete ON crove_kernel.member_vy_memory AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (member_user_id = (SELECT crove_kernel.ctx_user_id()));

-- ---------------------------------------------------------------------------
-- The entry
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_member_vy_context(p_org_id uuid, p_agent_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_member uuid;
  v_status text;
  v_kind text;
  v_agent_risk text;
  v_template_risk text;
  v_run_status text;
  v_run_expires timestamptz;
  v_run_tainted boolean;
  v_module text;
  v_role text;
  v_scope jsonb;
  v_risk text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'AGENT_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT a.member_user_id, a.status, a.kind, a.max_risk, t.max_risk INTO v_member, v_status, v_kind, v_agent_risk, v_template_risk
  FROM crove_kernel.agent a JOIN crove_kernel.agent_template t ON t.key = a.template_key
  WHERE a.org_id = p_org_id AND a.id = p_agent_id;
  IF NOT FOUND OR v_kind <> 'member_vy' OR v_member IS NULL THEN
    RAISE EXCEPTION 'AGENT_NOT_MEMBER_VY' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'AGENT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  -- A removal and this entry serialize on the member's membership row, as approvals do. A read-only transaction (a query) writes nothing and
  -- cannot take a row lock, so it takes none: it sees the membership as of its snapshot, and every command re-enters in its own transaction.
  IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
    PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_member FOR SHARE;
  END IF;
  SELECT r.status, r.expires_at, r.tainted, r.module INTO v_run_status, v_run_expires, v_run_tainted, v_module
  FROM crove_kernel.ai_run r WHERE r.org_id = p_org_id AND r.id = p_run_id AND r.agent_id = p_agent_id;
  IF NOT FOUND OR v_run_status <> 'running' OR v_run_expires <= pg_catalog.now() THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_LIVE' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_kernel.member_vy_member_active(p_org_id, v_member) THEN
    -- Still a member with an enabled account, so what is missing is vy.use: the reason the screens and the runtime know (VY_NOT_ALLOWED).
    IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m JOIN crove_kernel.user_account u ON u.id = m.user_id
               WHERE m.org_id = p_org_id AND m.user_id = v_member AND m.role IN ('owner', 'admin', 'member', 'viewer') AND u.disabled_at IS NULL) THEN
      RAISE EXCEPTION 'VY_NOT_ALLOWED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'MEMBER_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k
    WHERE k.org_id = p_org_id AND k.released_at IS NULL
      AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = v_module) OR (k.scope = 'agent' AND k.target = p_agent_id::text))
  ) THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.global_kill_switch_on('ai') THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ai_budget_exhausted(p_org_id, v_module, p_agent_id) THEN
    RAISE EXCEPTION 'BUDGET_EXHAUSTED' USING ERRCODE = '42501';
  END IF;
  -- The member's rights, as enter_context computes them: the base role and the legal entities of their role assignments.
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_member;
  IF v_role NOT IN ('owner', 'admin') AND NOT EXISTS (
    SELECT 1 FROM crove_kernel.role_assignment a WHERE a.org_id = p_org_id AND a.user_id = v_member AND a.legal_entity_id IS NULL
  ) THEN
    SELECT pg_catalog.jsonb_agg(DISTINCT a.legal_entity_id::text ORDER BY a.legal_entity_id::text) INTO v_scope
    FROM crove_kernel.role_assignment a WHERE a.org_id = p_org_id AND a.user_id = v_member;
  END IF;
  -- R1 at most: the lower of the agent's and the template's, and never above R1 (the agent row is held there as well).
  v_risk := CASE WHEN v_agent_risk IN ('R0', 'R1') AND v_template_risk IN ('R0', 'R1') THEN
              CASE WHEN v_agent_risk < v_template_risk THEN v_agent_risk ELSE v_template_risk END
            ELSE 'R0' END;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_agent_id,
    'run', p_run_id,
    'position', NULL,
    'module', v_module,
    'max_risk', v_risk,
    'tainted', true,
    'le_scope', COALESCE(v_scope, pg_catalog.jsonb_build_array('*')),
    'flags', '[]'::jsonb,
    'kind', 'member_vy',
    'member', v_member));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'member', v_member, 'module', v_module, 'maxRisk', v_risk, 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_member_vy_context(uuid, uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_member_vy_context(uuid, uuid, uuid) TO crove_worker;

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_audit_detail_ok(p_detail jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  -- Listed keys only, each with the one shape its values have: an id is a uuid, a feature or status one of the known words, a code a
  -- code from the runtime's own list, integers from 0 to ten million. Never free text, never a slug a person could have typed (the
  -- audit stream is WORM and anchored, so a text that reaches it cannot be erased; ADR-0049 decision 4).
  SELECT pg_catalog.jsonb_typeof(p_detail) = 'object'
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_detail)) <= 12
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_detail) e
      WHERE NOT CASE e.key
        WHEN 'agentRun' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        WHEN 'runId' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        WHEN 'resultId' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        WHEN 'subjectId' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        WHEN 'feature' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['notes.summary', 'notes.todo_suggest'])
        WHEN 'subjectType' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['note', 'meeting'])
        WHEN 'status' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['running', 'ready', 'failed'])
        WHEN 'code' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['AGENT_FORBIDDEN', 'AGENT_RUN_NOT_LIVE', 'AI_BUDGET_EXHAUSTED', 'AUTH_NOT_READY', 'AUTH_UNAVAILABLE', 'BROKER_NOT_CONFIGURED', 'BUDGET_EXHAUSTED', 'COMMAND_NOT_FOUND', 'CONFLICT', 'EXTENSION_TOKEN_INVALID', 'FORBIDDEN', 'IDEMPOTENCY_MISMATCH', 'INTERNAL', 'INVALID', 'KILL_SWITCH_ON', 'LAST_OWNER', 'LEASE_LOST', 'MEMBER_NOT_ACTIVE', 'MEMBER_VY_RESULT_RUN_MISMATCH', 'MEMORY_NOT_FOUND', 'MFA_REQUIRED', 'NOT_A_MEMBER', 'NOT_STREAMED', 'OAUTH_CLIENT_TOKEN_REFUSED', 'OVERLOADED', 'POSITION_CYCLE', 'QUERY_NOT_FOUND', 'RATE_LIMITED', 'RESULT_NOT_FOUND', 'RETRY', 'SENSITIVE_ONLY', 'SESSION_REVOKED_IN_ORG', 'STEP_UP_REQUIRED', 'STREAM_ONLY', 'UNAUTHENTICATED', 'USER_DISABLED', 'VALIDATION', 'VY_NOT_ALLOWED', 'VY_RUN_NOT_LIVE'])
        WHEN 'errorCode' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['AGENT_FORBIDDEN', 'AGENT_RUN_NOT_LIVE', 'AI_BUDGET_EXHAUSTED', 'AUTH_NOT_READY', 'AUTH_UNAVAILABLE', 'BROKER_NOT_CONFIGURED', 'BUDGET_EXHAUSTED', 'COMMAND_NOT_FOUND', 'CONFLICT', 'EXTENSION_TOKEN_INVALID', 'FORBIDDEN', 'IDEMPOTENCY_MISMATCH', 'INTERNAL', 'INVALID', 'KILL_SWITCH_ON', 'LAST_OWNER', 'LEASE_LOST', 'MEMBER_NOT_ACTIVE', 'MEMBER_VY_RESULT_RUN_MISMATCH', 'MEMORY_NOT_FOUND', 'MFA_REQUIRED', 'NOT_A_MEMBER', 'NOT_STREAMED', 'OAUTH_CLIENT_TOKEN_REFUSED', 'OVERLOADED', 'POSITION_CYCLE', 'QUERY_NOT_FOUND', 'RATE_LIMITED', 'RESULT_NOT_FOUND', 'RETRY', 'SENSITIVE_ONLY', 'SESSION_REVOKED_IN_ORG', 'STEP_UP_REQUIRED', 'STREAM_ONLY', 'UNAUTHENTICATED', 'USER_DISABLED', 'VALIDATION', 'VY_NOT_ALLOWED', 'VY_RUN_NOT_LIVE'])
        WHEN 'rule' THEN pg_catalog.jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (ARRAY['P02', 'P03', 'P05', 'P06', 'member_vy_access', 'member_vy_context', 'member_vy_role'])
        WHEN 'bodyLength' THEN CASE WHEN pg_catalog.jsonb_typeof(e.value) = 'number' THEN (e.value #>> '{}')::numeric BETWEEN 0 AND 10000000 AND (e.value #>> '{}')::numeric = pg_catalog.trunc((e.value #>> '{}')::numeric) ELSE false END
        WHEN 'count' THEN CASE WHEN pg_catalog.jsonb_typeof(e.value) = 'number' THEN (e.value #>> '{}')::numeric BETWEEN 0 AND 10000000 AND (e.value #>> '{}')::numeric = pg_catalog.trunc((e.value #>> '{}')::numeric) ELSE false END
        ELSE false
      END)
$$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_audit_detail_ok(jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- The write guard, with the member_vy branch (the org-chart branches are as in 20261019010000)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
  v_agent uuid;
  v_key text;
BEGIN
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  v_agent := (v_ctx ->> 'agent')::uuid;
  -- Vy in member mode (ADR-0049 decision 2) writes the tables its own catalog lists with mode 'write' (each row also passes its own
  -- restrictive policy: the row belongs to the member) and two narrow rows, an audit row and an idempotency key of its own run whose
  -- every value is an id, an enum, a number or a flag; nothing else. It emits no event (outbox_pending refuses it, so crove_kernel.emit
  -- fails whole), wakes no agent and writes no other guarded table. The org-chart rules below are what they were.
  IF v_ctx ->> 'kind' = 'member_vy' THEN
    IF EXISTS (SELECT 1 FROM crove_kernel.member_vy_table c
               WHERE c.table_name = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME AND c.mode = 'write') THEN
      -- It never deletes (results expire and are purged by definers) and never clears the taint of a result: only the member's own act
      -- does, in the member's own context (ADR-0049 decisions 4 and 5).
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
      END IF;
      -- A result is made by the member's own command, so a background run only updates the one result of its own run: it never inserts one,
      -- never moves a result to another run and never rewrites another run's result of the same member; what it writes stays tainted.
      IF TG_TABLE_NAME = 'member_vy_result' THEN
        IF TG_OP <> 'UPDATE' OR OLD.run_id IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.tainted IS NOT TRUE THEN
          RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF TG_TABLE_SCHEMA = 'crove_kernel' AND TG_OP <> 'DELETE' THEN
      IF TG_TABLE_NAME = 'audit_event' THEN
        IF TG_OP = 'INSERT' AND NEW.actor_type = 'agent' AND NEW.actor_id = v_agent
           AND NEW.detail ->> 'agentRun' = (v_ctx ->> 'run')
           AND NEW.command ~ '^kernel\.member_vy\.[a-z_.]{1,60}$'
           AND (NEW.target_type IS NULL OR NEW.target_type ~ '^[a-z][a-z0-9_.]{0,62}$')
           AND NEW.input_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND crove_kernel.member_vy_audit_detail_ok(NEW.detail) THEN
          NEW.occurred_at := pg_catalog.now();
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
        IF NEW.actor_key = 'agent:' || v_agent::text || ':' || (v_ctx ->> 'run')
           AND (TG_OP = 'INSERT' OR OLD.actor_key = NEW.actor_key)
           AND NEW.key ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$'
           AND NEW.command ~ '^kernel\.member_vy\.[a-z_.]{1,60}$'
           AND NEW.request_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND (NEW.response IS NULL OR crove_kernel.member_vy_audit_detail_ok(NEW.response)) THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_SCHEMA = 'crove_kernel' AND TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'audit_event' THEN
      IF TG_OP = 'INSERT' AND NEW.actor_type = 'agent' AND NEW.actor_id = v_agent
         AND NEW.detail ->> 'agentRun' = (v_ctx ->> 'run') THEN
        NEW.occurred_at := pg_catalog.now();
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'outbox_pending' THEN
      IF TG_OP = 'INSERT' THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
      v_key := 'agent:' || v_agent::text || ':' || (v_ctx ->> 'run');
      IF NEW.actor_key = v_key THEN
        IF TG_OP = 'INSERT' THEN
          RETURN NEW;
        END IF;
        IF OLD.actor_key = v_key THEN
          RETURN NEW;
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'agent_wakeup' THEN
      IF NEW.status = 'pending' AND NEW.run_id IS NULL AND EXISTS (
           SELECT 1 FROM crove_kernel.position p
           WHERE p.org_id = NEW.org_id AND p.holder_agent_id = NEW.agent_id
             AND crove_kernel.position_in_subtree(NEW.org_id, (v_ctx ->> 'position')::uuid, p.id)) THEN
        IF TG_OP = 'INSERT' THEN
          NEW.request_count := 1;
          NEW.tainted := NEW.tainted OR crove_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
        IF OLD.status = 'pending' AND OLD.org_id = NEW.org_id AND OLD.id = NEW.id AND OLD.agent_id = NEW.agent_id
           AND OLD.created_at = NEW.created_at AND NEW.request_count >= OLD.request_count
           AND NEW.request_depth >= OLD.request_depth THEN
          NEW.tainted := NEW.tainted OR OLD.tainted OR crove_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- Activity is an org-visible sink the write guard exempts for org-chart agents (they stamp their own row). Vy in member mode writes
-- none (ADR-0049 decision 4): activity_stamp_agent as in 20261018160000, plus that refusal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.activity_stamp_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
BEGIN
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'actor' = 'agent' THEN
    IF v_ctx ->> 'kind' = 'member_vy' THEN
      RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'crove_kernel.activity';
    END IF;
    NEW.agent_id := (v_ctx ->> 'agent')::uuid;
    NEW.actor_id := NULL;
  ELSE
    NEW.agent_id := NULL;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The tables the guard exempts (20261019010000) are org-visible sinks with rules of their own, written for org-chart agents. Vy in member
-- mode writes none of them: a trigger that fires before every other one refuses the member context outright (ai_run keeps its own-run
-- rule and activity its stamp above). A background run claims no task, comments nowhere, emits nothing and counts no refusal in the tally.
-- ---------------------------------------------------------------------------
-- A definer: it reads the sealed context, which not every role that deletes from these tables may (a purge's own definer, for one), and a
-- trigger function runs with the privileges of whoever fires it.
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_forbid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_verified() ->> 'kind' = 'member_vy' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_forbid() FROM PUBLIC;

-- task, task_comment and refusal_tally are locked together, NOWAIT, in a retry block, and their triggers are replaced under that lock:
-- the migration never waits for one of them while holding another, and CREATE OR REPLACE TRIGGER needs only SHARE ROW EXCLUSIVE, which the
-- LOCK already holds (DROP TRIGGER would upgrade it to ACCESS EXCLUSIVE). A busy table fails the whole attempt, which gives its locks back
-- (the block is a subtransaction), sleeps and tries again. outbox_event, the hot table, comes last so that its lock is held for the
-- shortest time, in the canonical retry block the migration lint asks of a hot table. A command that emits an event and then updates
-- a task in the same moment can still make Postgres abort one of the two on a deadlock; the migration is one transaction, so an aborted
-- migration changes nothing (the deploy stops with the old release serving) and a rerun passes.
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    LOCK TABLE crove_kernel.task, crove_kernel.task_comment, crove_kernel.refusal_tally IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    CREATE OR REPLACE TRIGGER a00_member_vy_forbid BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.task
      FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_forbid();
    CREATE OR REPLACE TRIGGER a00_member_vy_forbid BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.task_comment
      FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_forbid();
    CREATE OR REPLACE TRIGGER a00_member_vy_forbid BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.refusal_tally
      FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_forbid();
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;
DO $$ DECLARE n int := 0; BEGIN LOOP BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    CREATE OR REPLACE TRIGGER a00_member_vy_forbid BEFORE INSERT OR UPDATE OR DELETE ON crove_kernel.outbox_event
      FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_forbid();
    EXIT;
  EXCEPTION WHEN lock_not_available THEN n := n + 1; IF n >= 15 THEN RAISE; END IF; PERFORM pg_sleep(1 + random());
  END; END LOOP; END $$;
