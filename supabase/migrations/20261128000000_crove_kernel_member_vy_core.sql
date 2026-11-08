-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2755, ADR-0049 stage A, slice 1 of 4): the database side of Vy working for one member. Idempotent;
-- applied files stay untouched.
--   agent.kind, agent.member_user_id   a member's own Vy is an agent row of kind 'member_vy', one per member, made only by
--                                      that member in their own user context with the fixed 'kernel.member_vy' template, never
--                                      changed after insert, and never the holder of a position.
--   ai_run.private_read                 true once a run read something private (set by the store command of slice 3, false
--                                      to true only); a run of a member_vy agent is inserted only in its member's context
--                                      and read by that member alone.
--   enter_agent_context                 refuses a member_vy agent (it is no org-chart agent).
--   member_vy_result, member_vy_memory  the member's results and memory, readable and writable by that member alone: no
--                                      owner, admin, other member, viewer, org-chart agent or system context reads or writes a row.
--   member_vy_results_expire, member_vy_member_data_purge, member_vy_private_counts
--                                      the definers the worker and the members screen use; none returns text.
--   org_purge                           deletes both tables with the org.
SET LOCAL lock_timeout = '2s';

-- The fixed template of a member's Vy: no position, so no seat and no role (permissions come from the member). Its role
-- key is a placeholder no role carries; max_risk R1 is the ceiling of ADR-0049 decision 1.
INSERT INTO crove_kernel.agent_template (key, module, title, role_key, max_risk, job_description, subscribes, daily_run_cap)
VALUES ('kernel.member_vy', 'kernel', 'Vy làm việc cho một thành viên', 'member_vy', 'R1',
  '{"responsibilities": ["Làm việc theo yêu cầu của đúng một thành viên, với quyền của người đó"], "kpis": [], "workingHours": "always", "limits": ["Không ghi vào sổ, không duyệt, không gửi gì ra ngoài: chỉ lưu kết quả riêng cho thành viên"]}'::jsonb,
  '{}', 50)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE crove_kernel.agent ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'org_chart';
ALTER TABLE crove_kernel.agent ADD COLUMN IF NOT EXISTS member_user_id uuid;
ALTER TABLE crove_kernel.agent DROP CONSTRAINT IF EXISTS agent_kind_check;
ALTER TABLE crove_kernel.agent ADD CONSTRAINT agent_kind_check CHECK (kind IN ('org_chart', 'member_vy'));
ALTER TABLE crove_kernel.agent DROP CONSTRAINT IF EXISTS agent_member_vy_shape_check;
ALTER TABLE crove_kernel.agent ADD CONSTRAINT agent_member_vy_shape_check
  CHECK ((kind = 'member_vy') = (member_user_id IS NOT NULL) AND (kind = 'member_vy') = (template_key = 'kernel.member_vy'));
-- A member's Vy never runs above R1 (ADR-0049 decision 1).
ALTER TABLE crove_kernel.agent DROP CONSTRAINT IF EXISTS agent_member_vy_risk_check;
ALTER TABLE crove_kernel.agent ADD CONSTRAINT agent_member_vy_risk_check CHECK (kind <> 'member_vy' OR max_risk IN ('R0', 'R1'));
CREATE UNIQUE INDEX IF NOT EXISTS agent_member_vy_uq ON crove_kernel.agent (org_id, member_user_id) WHERE kind = 'member_vy';

-- The binding between member and agent, held by the database (ADR-0049 decision 1).
CREATE OR REPLACE FUNCTION crove_kernel.agent_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'member_vy' AND (
      crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
      OR NEW.member_user_id IS DISTINCT FROM crove_kernel.ctx_user_id()) THEN
      RAISE EXCEPTION 'MEMBER_VY_AGENT_BINDING' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.member_user_id IS DISTINCT FROM OLD.member_user_id
     OR (OLD.kind = 'member_vy' AND NEW.template_key IS DISTINCT FROM OLD.template_key) THEN
    RAISE EXCEPTION 'MEMBER_VY_AGENT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.agent_member_vy_bind() FROM PUBLIC;
DROP TRIGGER IF EXISTS member_vy_bind ON crove_kernel.agent;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE ON crove_kernel.agent
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.agent_member_vy_bind();

-- A position is never held by a member's Vy.
CREATE OR REPLACE FUNCTION crove_kernel.position_no_member_vy() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.holder_agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM crove_kernel.agent a WHERE a.org_id = NEW.org_id AND a.id = NEW.holder_agent_id AND a.kind = 'member_vy') THEN
    RAISE EXCEPTION 'MEMBER_VY_NO_POSITION' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.position_no_member_vy() FROM PUBLIC;
DROP TRIGGER IF EXISTS member_vy_no_seat ON crove_kernel."position";
CREATE TRIGGER member_vy_no_seat BEFORE INSERT OR UPDATE OF holder_agent_id ON crove_kernel."position"
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.position_no_member_vy();

-- The user a member_vy agent works for, NULL for an org-chart agent, an unknown id or an org other than the context's.
CREATE OR REPLACE FUNCTION crove_kernel.agent_member_of(p_org uuid, p_agent uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.member_user_id FROM crove_kernel.agent a
  WHERE a.org_id = p_org AND a.id = p_agent AND a.kind = 'member_vy' AND p_org = crove_kernel.ctx_org_id()
$$;
REVOKE ALL ON FUNCTION crove_kernel.agent_member_of(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.agent_member_of(uuid, uuid) TO crove_tenant;

-- The user a context acts for: the user of a user context, NULL for everything else (org-chart agents and the system
-- included). Stage B adds the sealed member of a member-scoped agent context.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_acting_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN crove_kernel.ctx_actor_type() = 'user' THEN crove_kernel.ctx_user_id() END
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_acting_user_id() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_acting_user_id() TO crove_tenant;

ALTER TABLE crove_kernel.ai_run ADD COLUMN IF NOT EXISTS private_read boolean NOT NULL DEFAULT false;

-- A run of a member_vy agent is inserted only in its member's own user context (the lookup is a definer's, so a policy
-- that hides agent rows from the caller cannot open the check), expires within 4 hours, and never moves to another agent.
CREATE OR REPLACE FUNCTION crove_kernel.ai_run_member_vy_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_member uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.member_user_id INTO v_member FROM crove_kernel.agent a
  WHERE a.org_id = NEW.org_id AND a.id = NEW.agent_id AND a.kind = 'member_vy';
  IF v_member IS NOT NULL THEN
    IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR crove_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id
       OR v_member IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_BINDING' USING ERRCODE = '42501';
    END IF;
    IF NEW.expires_at > NEW.started_at + interval '4 hours' THEN
      RAISE EXCEPTION 'MEMBER_VY_RUN_EXPIRY' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.ai_run_member_vy_bind() FROM PUBLIC;
DROP TRIGGER IF EXISTS member_vy_bind ON crove_kernel.ai_run;
CREATE TRIGGER member_vy_bind BEFORE INSERT OR UPDATE OF agent_id ON crove_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.ai_run_member_vy_bind();

-- The private-read flag only goes from false to true.
CREATE OR REPLACE FUNCTION crove_kernel.private_read_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.private_read AND NOT NEW.private_read THEN
    RAISE EXCEPTION 'PRIVATE_READ_NOT_CLEARED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.private_read_monotonic() FROM PUBLIC;
DROP TRIGGER IF EXISTS private_read_monotonic ON crove_kernel.ai_run;
CREATE TRIGGER private_read_monotonic BEFORE UPDATE OF private_read ON crove_kernel.ai_run
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.private_read_monotonic();

-- Restrictive, so it narrows the tenant policy: the row of a member_vy run is its member's alone. Owners and admins
-- see the cost through org_usage, never the run.
DROP POLICY IF EXISTS member_vy_read ON crove_kernel.ai_run;
CREATE POLICY member_vy_read ON crove_kernel.ai_run AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (NOT EXISTS (
    SELECT 1 FROM crove_kernel.agent a
    WHERE a.org_id = ai_run.org_id AND a.id = ai_run.agent_id AND a.kind = 'member_vy'
      AND a.member_user_id IS DISTINCT FROM (SELECT crove_kernel.ctx_acting_user_id())))
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- enter_agent_context: as in 20261120100000, plus the refusal of a member_vy agent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_agent_context(p_org_id uuid, p_agent_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_run_status text;
  v_run_expires timestamptz;
  v_run_tainted boolean;
  v_agent_status text;
  v_agent_kind text;
  v_agent_risk text;
  v_template_risk text;
  v_template_role text;
  v_position uuid;
  v_role text;
  v_module text;
  v_le text[];
  v_flags text[];
  v_risk text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'AGENT_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'TENANT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  SELECT r.status, r.expires_at, r.tainted INTO v_run_status, v_run_expires, v_run_tainted
  FROM crove_kernel.ai_run r WHERE r.org_id = p_org_id AND r.id = p_run_id AND r.agent_id = p_agent_id;
  IF NOT FOUND OR v_run_status <> 'running' OR v_run_expires <= pg_catalog.now() THEN
    RAISE EXCEPTION 'AGENT_RUN_NOT_LIVE' USING ERRCODE = '42501';
  END IF;
  SELECT a.status, a.kind, a.max_risk, t.max_risk, t.role_key INTO v_agent_status, v_agent_kind, v_agent_risk, v_template_risk, v_template_role
  FROM crove_kernel.agent a JOIN crove_kernel.agent_template t ON t.key = a.template_key
  WHERE a.org_id = p_org_id AND a.id = p_agent_id;
  IF NOT FOUND OR v_agent_status <> 'active' THEN
    RAISE EXCEPTION 'AGENT_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;
  -- A member's own Vy is no org-chart agent: this entry never admits it (ADR-0049 decision 1).
  IF v_agent_kind <> 'org_chart' THEN
    RAISE EXCEPTION 'AGENT_NOT_ORG_CHART' USING ERRCODE = '42501';
  END IF;
  SELECT p.id, p.role_key, p.module, p.le_scope, p.flags INTO v_position, v_role, v_module, v_le, v_flags
  FROM crove_kernel.position p WHERE p.org_id = p_org_id AND p.holder_agent_id = p_agent_id AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NO_POSITION' USING ERRCODE = '42501';
  END IF;
  IF v_role <> v_template_role THEN
    RAISE EXCEPTION 'AGENT_ROLE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k
    WHERE k.org_id = p_org_id AND k.released_at IS NULL
      AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = v_module) OR (k.scope = 'agent' AND k.target = p_agent_id::text))
  ) THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  -- The deployment-wide switch for AI (#886), engaged by the operator.
  IF crove_kernel.global_kill_switch_on('ai') THEN
    RAISE EXCEPTION 'KILL_SWITCH_ON' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ai_budget_exhausted(p_org_id, v_module, p_agent_id) THEN
    RAISE EXCEPTION 'BUDGET_EXHAUSTED' USING ERRCODE = '42501';
  END IF;
  v_risk := CASE WHEN v_agent_risk < v_template_risk THEN v_agent_risk ELSE v_template_risk END;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_agent_id,
    'run', p_run_id,
    'position', v_position,
    'module', v_module,
    'max_risk', v_risk,
    'tainted', v_run_tainted,
    'le_scope', pg_catalog.to_jsonb(v_le),
    'flags', pg_catalog.to_jsonb(v_flags)));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'position', v_position, 'module', v_module, 'maxRisk', v_risk, 'tainted', v_run_tainted);
END $$;

-- ---------------------------------------------------------------------------
-- The member's results and memory (ADR-0049 decision 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_kernel.member_vy_result (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  member_user_id uuid NOT NULL,
  run_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  subject_type text NOT NULL CHECK (pg_catalog.length(subject_type) BETWEEN 1 AND 100),
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ready', 'failed')),
  -- A fixed code, never text.
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  source_revision integer,
  -- The text (class pii). Tainted until the member acts on it.
  body text CHECK (body IS NULL OR pg_catalog.length(body) <= 100000),
  tainted boolean NOT NULL DEFAULT true,
  private_read boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, run_id) REFERENCES crove_kernel.ai_run (org_id, id),
  CONSTRAINT member_vy_result_run_uq UNIQUE (org_id, run_id),
  CHECK (status <> 'ready' OR body IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS member_vy_result_member_idx ON crove_kernel.member_vy_result (org_id, member_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_vy_result_subject_idx ON crove_kernel.member_vy_result (org_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS member_vy_result_expiry_idx ON crove_kernel.member_vy_result (expires_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_vy_result');

CREATE TABLE IF NOT EXISTS crove_kernel.member_vy_memory (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  member_user_id uuid NOT NULL,
  -- What the member made or confirmed (class pii).
  body text NOT NULL CHECK (pg_catalog.length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS member_vy_memory_member_idx ON crove_kernel.member_vy_memory (org_id, member_user_id, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_kernel.member_vy_memory');

-- The org, the member, the run, the feature and the subject never change; only the store command's columns do.
REVOKE UPDATE ON crove_kernel.member_vy_result FROM crove_tenant;
GRANT UPDATE (status, error_code, source_revision, body, tainted, private_read) ON crove_kernel.member_vy_result TO crove_tenant;
REVOKE UPDATE ON crove_kernel.member_vy_memory FROM crove_tenant;
GRANT UPDATE (body, updated_at) ON crove_kernel.member_vy_memory TO crove_tenant;

-- A result inherits the flag of its run (a member cannot delete a result and insert it again with the flag false).
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_result_inherit_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM crove_kernel.ai_run r WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND r.private_read) THEN
    NEW.private_read := true;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_result_inherit_flag() FROM PUBLIC;
DROP TRIGGER IF EXISTS inherit_flag ON crove_kernel.member_vy_result;
CREATE TRIGGER inherit_flag BEFORE INSERT ON crove_kernel.member_vy_result
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.member_vy_result_inherit_flag();

DROP TRIGGER IF EXISTS private_read_monotonic ON crove_kernel.member_vy_result;
CREATE TRIGGER private_read_monotonic BEFORE UPDATE OF private_read ON crove_kernel.member_vy_result
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.private_read_monotonic();

-- Restrictive, so they narrow the tenant policy and never widen it: the member alone, in a user context. An owner,
-- an admin, another member, a viewer, an org-chart agent and the system context see and write no row.
DROP POLICY IF EXISTS member_only ON crove_kernel.member_vy_result;
CREATE POLICY member_only ON crove_kernel.member_vy_result AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (member_user_id = (SELECT crove_kernel.ctx_acting_user_id()))
  WITH CHECK (member_user_id = (SELECT crove_kernel.ctx_acting_user_id()));
DROP POLICY IF EXISTS member_only ON crove_kernel.member_vy_memory;
CREATE POLICY member_only ON crove_kernel.member_vy_memory AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (member_user_id = (SELECT crove_kernel.ctx_acting_user_id()))
  WITH CHECK (member_user_id = (SELECT crove_kernel.ctx_acting_user_id()));

-- ---------------------------------------------------------------------------
-- Definers: the worker and the members screen reach these rows only through them, and none returns text.
-- ---------------------------------------------------------------------------
-- Removes up to p_limit expired results of the context's org (worker login, in the org's system context).
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_results_expire(p_limit integer)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEMBER_VY_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_kernel.member_vy_result r
  WHERE r.org_id = v_org AND r.id IN (
    SELECT x.id FROM crove_kernel.member_vy_result x WHERE x.org_id = v_org AND x.expires_at < pg_catalog.now()
    ORDER BY x.expires_at LIMIT LEAST(GREATEST(p_limit, 1), 1000));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_results_expire(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_results_expire(integer) TO crove_worker;

-- Removes a former member's results and memory from the context's org, unless they are a member again or were removed
-- less than 30 days ago (worker login, in the org's system context). Holds the membership lock until the transaction
-- ends, so a re-add waits or is seen. Returns how many rows it removed.
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_member_data_purge(p_org uuid, p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint;
  v_m bigint;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEMBER_VY_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_org IS DISTINCT FROM p_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'MEMBER_VY_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- A re-add of this user (crove_kernel.invite_accept) either committed before this and the check below sees it, or waits
  -- until this transaction ends.
  PERFORM crove_kernel.membership_lock(v_org, p_user);
  IF EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN 0;
  END IF;
  -- Nothing goes in the 30 days after the removal (the rule of crove_notes.member_items_purge).
  IF EXISTS (
    SELECT 1 FROM crove_kernel.audit_event a
    WHERE a.org_id = v_org AND a.occurred_at > pg_catalog.now() - interval '30 days'
      AND a.command = 'kernel.member.remove' AND a.outcome = 'ok' AND a.target_id = p_user
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM crove_kernel.member_vy_result r WHERE r.org_id = v_org AND r.member_user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM crove_kernel.member_vy_memory m WHERE m.org_id = v_org AND m.member_user_id = p_user;
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RETURN v_n + v_m;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_member_data_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_member_data_purge(uuid, uuid) TO crove_worker;

-- How many results and memory entries each member has in the context's org: for an owner or admin before they remove a
-- member, and for the org export, which records a count of what its row policies leave out. No other context gets an answer.
CREATE OR REPLACE FUNCTION crove_kernel.member_vy_private_counts()
RETURNS TABLE (org_id uuid, member_user_id uuid, results bigint, memories bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT v_org, u.uid,
      (SELECT pg_catalog.count(*) FROM crove_kernel.member_vy_result r WHERE r.org_id = v_org AND r.member_user_id = u.uid),
      (SELECT pg_catalog.count(*) FROM crove_kernel.member_vy_memory m WHERE m.org_id = v_org AND m.member_user_id = u.uid)
    FROM (SELECT x.member_user_id AS uid FROM crove_kernel.member_vy_result x WHERE x.org_id = v_org
          UNION SELECT y.member_user_id FROM crove_kernel.member_vy_memory y WHERE y.org_id = v_org) u
    ORDER BY u.uid;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_private_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_private_counts() TO crove_tenant;

-- ---------------------------------------------------------------------------
-- org_purge: the body of 20261126160000 (the newest) with both tables added at the head of the list deleted whole,
-- before the runs and agents they reference. Signature, owner and grants as they were.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.org_purge(p_min_days integer)
RETURNS TABLE (outcome text, counts jsonb, blob_keys text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_refusal text;
  v_n bigint;
  v_t text;
  v_deleted jsonb := '{}'::jsonb;
  v_pinned jsonb := '{}'::jsonb;
  v_anonymized bigint;
  v_keep_proposal uuid[];
  v_keep_task uuid[];
  v_keep_position uuid[];
  v_keep_run uuid[];
  v_keep_agent uuid[];
  v_keep_variant uuid[];
  v_keep_post uuid[];
  v_keep_connection uuid[];
  v_keep_party uuid[];
  v_keep_file uuid[];
  v_keep_signed_file uuid[];
  v_keys text[];
  v_conversation_keys text[];
  -- Rows of these tables are deleted whole, in this order (children before the rows they reference).
  v_kernel_first text[] := ARRAY[
    'crove_kernel.member_vy_memory', 'crove_kernel.member_vy_result',
    'crove_hr.payroll_bank_template', 'crove_hr.payroll_dependent', 'crove_hr.payroll_employee',
    'crove_meetings.media_key', 'crove_meetings.audio_segment', 'crove_meetings.meeting_video', 'crove_meetings.meeting_reader', 'crove_meetings.meeting',
    'crove_kernel.saved_reply', 'crove_kernel.conversation_setting', 'crove_kernel.member_availability', 'crove_kernel.conversation_composing', 'crove_kernel.conversation_draft', 'crove_kernel.conversation_note', 'crove_kernel.conversation_read', 'crove_kernel.conversation_attachment', 'crove_kernel.conversation_message', 'crove_kernel.conversation', 'crove_kernel.conversation_identity', 'crove_kernel.channel_access',
    'crove_ads.ad_flag_setting', 'crove_ads.ad_campaign_request', 'crove_ads.ad_campaign_draft', 'crove_ads.ad_spend_cap', 'crove_ads.ad_org_setting', 'crove_ads.ad_sync_run', 'crove_ads.ad_spend_day', 'crove_ads.ad_account',
    'crove_kernel.today_mail', 'crove_kernel.saved_view', 'crove_notes.link', 'crove_notes.todo', 'crove_notes.note',
    'crove_kernel.activity', 'crove_kernel.agent_wakeup', 'crove_kernel.extraction',
    'crove_kernel.inbound_message', 'crove_kernel.notification', 'crove_kernel.notification_mute', 'crove_kernel.inbox_item',
    'crove_kernel.mail_event', 'crove_kernel.mail_suppression', 'crove_kernel.mail_message',
    'crove_kernel.member_invite', 'crove_kernel.auth_session_org', 'crove_kernel.inbound_drop',
    'crove_kernel.idempotency_key', 'crove_kernel.extension_token', 'crove_kernel.extension_auth_code', 'crove_kernel.oauth_state', 'crove_kernel.outbox_pending',
    'crove_kernel.proposal_policy', 'crove_kernel.refusal_tally', 'crove_kernel.tax_obligation_done',
    'crove_kernel.tax_profile', 'crove_kernel.usage_deferral', 'crove_kernel.file_upload', 'crove_kernel.record_le',
    'crove_kernel.budget_policy', 'crove_kernel.kill_switch', 'crove_kernel.credential', 'crove_kernel.subject_key', 'crove_kernel.calendar_credential',
    'crove_finance.vendor_account_rule', 'crove_finance.categorization_rule', 'crove_finance.stock_alias', 'crove_finance.einvoice_connection', 'crove_finance.einvoice_series', 'crove_finance.bank_party_rule', 'crove_finance.customer_collection', 'crove_finance.collection_setting', 'crove_finance.bank_account_number', 'crove_finance.bank_feed_account', 'crove_finance.bank_feed_listed_account', 'crove_crm.booking_feed', 'crove_crm.booking', 'crove_kernel.availability_rule',
    'crove_kernel.calendar_event_link', 'crove_kernel.calendar_event', 'crove_kernel.calendar_connection', 'crove_crm.deal_next_step', 'crove_crm.deal_setting', 'crove_crm.deal', 'crove_crm.pipeline_stage', 'crove_crm.import_row', 'crove_crm.import_batch', 'crove_crm.event_type'];
  v_social text[] := ARRAY[
    'crove_social.account_snapshot', 'crove_social.bio_click', 'crove_social.bio_page', 'crove_social.brand_voice',
    'crove_social.calendar_feed', 'crove_social.calendar_note', 'crove_social.channel_policy',
    'crove_social.channel_set', 'crove_social.chat_alert_target', 'crove_social.chat_alert',
    'crove_social.feed_item', 'crove_social.feed', 'crove_social.idea_label', 'crove_social.idea',
    'crove_social.post_label', 'crove_social.queue_slot', 'crove_social.queue', 'crove_social.label',
    'crove_social.link_preview', 'crove_social.media_tag', 'crove_social.metric_snapshot',
    'crove_social.notification', 'crove_social.notification_mail_off', 'crove_social.notification_mute',
    'crove_social.post_comment', 'crove_social.post_media', 'crove_social.post_version', 'crove_social.publish_hold', 'crove_social.report_link',
    'crove_social.report_schedule_run', 'crove_social.report_schedule', 'crove_social.review_feedback',
    'crove_social.review_link_post', 'crove_social.review_link', 'crove_social.short_link_click',
    'crove_social.short_link', 'crove_social.snippet', 'crove_social.watermark', 'crove_social.report_branding', 'crove_social.goal', 'crove_social.banned_word', 'crove_social.external_import', 'crove_social.external_post', 'crove_social.review_check', 'crove_social.digest_week', 'crove_social.channel_option', 'crove_social.media_attribution', 'crove_social.push_subscription', 'crove_social.saved_view', 'crove_social.media_archive'];
BEGIN
  -- Also refuses a definer owner or another role reached through a mistaken grant: only the worker login, in the
  -- sealed system context of the org it purges (execute() of kernel.org.purge).
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'ORG_PURGE_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The write fence: every other transaction inside an offboarding org holds this lock shared (enter_context,
  -- enter_system_context), so taking it exclusive waits for those in flight and holds new ones back until the purge
  -- commits; they then see the org closed and are refused. Taken before the tenant row, so an in-flight transaction
  -- that updates the tenant row cannot deadlock with the purge. This transaction's own shared hold does not conflict.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.purge:' || v_org::text, 0));
  -- Serializes purges of one org and holds the status still while the map runs.
  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR UPDATE;
  v_refusal := crove_kernel.org_purge_refusal(v_org, p_min_days);
  IF v_refusal IS NOT NULL THEN
    outcome := v_refusal;
    RETURN NEXT;
    RETURN;
  END IF;

  -- The append-only working rows (#1032): task comments and Social post approvals. Their append_only_row trigger
  -- (purge_append_only_guard) lets a DELETE through only from this function, for the org it purges, under this
  -- transaction-local mark, cleared again right after. Deleted first, so the tasks, positions, agents, runs, variants,
  -- posts and channel connections they referenced are no longer pinned and go with the rest of the map.
  PERFORM pg_catalog.set_config('crove.org_purge', v_org::text, true);
  DELETE FROM crove_kernel.task_comment c WHERE c.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.task_comment', v_n);
  DELETE FROM crove_social.post_approval a WHERE a.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post_approval', v_n);
  -- The sales e-invoice drafts (#2500): the guards of the draft and its lines let a DELETE of a draft that has left `draft` through only from this function, under
  -- the same mark. Lines first. The series are deleted with the first list below.
  -- The signed XML of an issued sales invoice stays with the books: read here, before the drafts that name it are deleted below.
  v_keep_signed_file := ARRAY(SELECT d.signed_file_id FROM crove_finance.einvoice_draft d WHERE d.org_id = v_org AND d.signed_file_id IS NOT NULL);
  DELETE FROM crove_finance.einvoice_draft_line l WHERE l.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_finance.einvoice_draft_line', v_n);
  DELETE FROM crove_finance.einvoice_draft d WHERE d.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_finance.einvoice_draft', v_n);
  -- The pay runs (#2531): frozen once approved, deleted under the same mark, lines first, before the employments and employees they name.
  DELETE FROM crove_hr.payroll_line l WHERE l.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_hr.payroll_line', v_n);
  DELETE FROM crove_hr.payroll_run r WHERE r.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_hr.payroll_run', v_n);
  -- The payroll employments (#2530): append-only like the task comments, deleted under the same mark, before the employees they name.
  DELETE FROM crove_hr.payroll_employment e WHERE e.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_hr.payroll_employment', v_n);
  PERFORM pg_catalog.set_config('crove.org_purge', '', true);

  -- The proposals behind kept books: the approval and four-eyes trail of booked entries (purchase documents, cash and
  -- journal vouchers, and reversals, whose entry names the proposal).
  v_keep_proposal := ARRAY(
    SELECT d.proposal_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.proposal_id IS NOT NULL
    UNION
    SELECT c.proposal_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.proposal_id IS NOT NULL
    UNION
    SELECT j.proposal_id FROM crove_finance.journal_voucher j WHERE j.org_id = v_org AND j.proposal_id IS NOT NULL
    UNION
    SELECT e.source_id FROM crove_finance.journal_entry e
    WHERE e.org_id = v_org AND e.source_type = 'kernel.proposal' AND e.source_id IS NOT NULL);

  -- Rows that append-only rows and kept proposals reference, with what they reference in turn.
  v_keep_task := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT c.task_id FROM crove_kernel.task_comment c WHERE c.org_id = v_org
      UNION
      SELECT r.source_task_id FROM crove_kernel.proposal r
      WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.source_task_id IS NOT NULL
      UNION
      SELECT t.parent_task_id FROM crove_kernel.task t JOIN k ON t.org_id = v_org AND t.id = k.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT id FROM k);
  v_keep_run := ARRAY(
    SELECT t.checkout_run_id FROM crove_kernel.task t
    WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.checkout_run_id IS NOT NULL
    UNION
    SELECT r.requested_by_run FROM crove_kernel.proposal r
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.requested_by_run IS NOT NULL);
  v_keep_position := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT t.assignee_position_id FROM crove_kernel.task t
      WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.assignee_position_id IS NOT NULL
      UNION
      SELECT p.reports_to FROM crove_kernel.position p JOIN k ON p.org_id = v_org AND p.id = k.id WHERE p.reports_to IS NOT NULL
    ) SELECT id FROM k);
  v_keep_agent := ARRAY(
    SELECT p.holder_agent_id FROM crove_kernel.position p
    WHERE p.org_id = v_org AND p.id = ANY (v_keep_position) AND p.holder_agent_id IS NOT NULL
    UNION
    SELECT r.agent_id FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id = ANY (v_keep_run) AND r.agent_id IS NOT NULL
    UNION
    SELECT a.agent FROM crove_kernel.proposal r
    CROSS JOIN LATERAL (VALUES (r.requested_by_agent), (r.decided_by_agent)) a(agent)
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND a.agent IS NOT NULL);
  v_keep_variant := ARRAY(SELECT DISTINCT a.variant_id FROM crove_social.post_approval a WHERE a.org_id = v_org);
  v_keep_post := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT a.post_id FROM crove_social.post_approval a WHERE a.org_id = v_org
      UNION
      SELECT s.src FROM crove_social.post p JOIN k ON p.org_id = v_org AND p.id = k.id
      CROSS JOIN LATERAL (VALUES (p.repost_of), (p.recurrence_source_id)) s(src) WHERE s.src IS NOT NULL
    ) SELECT id FROM k);
  v_keep_connection := ARRAY(
    SELECT DISTINCT v.channel_connection_id FROM crove_social.post_variant v
    WHERE v.org_id = v_org AND v.id = ANY (v_keep_variant) AND v.channel_connection_id IS NOT NULL);
  v_keep_party := ARRAY(
    SELECT d.party_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.party_id IS NOT NULL
    UNION
    SELECT c.party_id FROM crove_finance.cash_voucher c WHERE c.org_id = v_org AND c.party_id IS NOT NULL
    UNION
    -- Ledger lines name parties without a foreign key (sales, opening balances, bank matching on 131 and 331).
    SELECT l.party_id FROM crove_finance.journal_line l WHERE l.org_id = v_org AND l.party_id IS NOT NULL);
  v_keep_file := ARRAY(
    SELECT d.source_file_id FROM crove_finance.purchase_document d WHERE d.org_id = v_org AND d.source_file_id IS NOT NULL
    UNION
    SELECT l.file_id FROM crove_finance.portal_invoice_list l WHERE l.org_id = v_org AND l.file_id IS NOT NULL);
  v_keep_file := v_keep_file || v_keep_signed_file;

  DELETE FROM crove_kernel.proposal r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_proposal);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.proposal', v_n);

  -- The blobs of the customers' stored images, read before their rows go (the delete trigger queues them too, so a failure to delete one
  -- here leaves it to the worker).
  v_conversation_keys := ARRAY(
    SELECT a.storage_key FROM crove_kernel.conversation_attachment a
    WHERE a.org_id = v_org AND a.state = 'stored' AND a.storage_key LIKE 'conversation/' || v_org::text || '/%' ORDER BY 1);

  FOREACH v_t IN ARRAY v_kernel_first || v_social LOOP
    EXECUTE pg_catalog.format('DELETE FROM %s WHERE org_id = $1', v_t::regclass) USING v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || pg_catalog.jsonb_build_object(v_t, v_n);
  END LOOP;

  -- The items of stock (#2512): those no stock move names go with the aliases above; the moves are kept with the books, and so are the items they name.
  DELETE FROM crove_finance.stock_item i
  WHERE i.org_id = v_org AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move m WHERE m.org_id = v_org AND m.item_id = i.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_finance.stock_item', v_n);

  -- Social: the posts and variants no approval pins, then the channel connections no kept variant uses.
  DELETE FROM crove_social.post_variant v WHERE v.org_id = v_org AND v.id <> ALL (v_keep_variant);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post_variant', v_n);
  DELETE FROM crove_social.post p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_post);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_social.post', v_n);
  DELETE FROM crove_kernel.channel_connection c WHERE c.org_id = v_org AND c.id <> ALL (v_keep_connection);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.channel_connection', v_n);

  -- The sealed copies of closed ads tokens and the revoke state (#2296), after every credential and connection of the org is gone: the ads hold made a
  -- copy for each ads credential the deletes above dropped, and those go too. The seal first, since it references the obligation.
  DELETE FROM crove_ads.ad_token_seal s WHERE s.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_ads.ad_token_seal', v_n);
  DELETE FROM crove_ads.ad_token_revoke r WHERE r.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_ads.ad_token_revoke', v_n);

  -- The org chart and its work, but what a task comment pins.
  DELETE FROM crove_kernel.task t WHERE t.org_id = v_org AND t.id <> ALL (v_keep_task);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.task', v_n);
  DELETE FROM crove_kernel.ai_run r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_run);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.ai_run', v_n);
  DELETE FROM crove_kernel.position p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_position);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.position', v_n);
  DELETE FROM crove_kernel.agent a WHERE a.org_id = v_org AND a.id <> ALL (v_keep_agent);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.agent', v_n);

  -- Members last among the org chart: a kept position's holder becomes NULL (ON DELETE SET NULL).
  DELETE FROM crove_kernel.tenant_member m WHERE m.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.tenant_member', v_n);

  -- Parties: those a kept voucher names are anonymized, the rest deleted.
  UPDATE crove_kernel.party p SET duplicate_of = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party) AND p.duplicate_of IS NOT NULL;
  UPDATE crove_kernel.party p SET address = NULL, email = NULL, phone = NULL, verified_by = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party)
    AND (p.address IS NOT NULL OR p.email IS NOT NULL OR p.phone IS NOT NULL OR p.verified_by IS NOT NULL);
  GET DIAGNOSTICS v_anonymized = ROW_COUNT;
  DELETE FROM crove_kernel.party p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_party);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.party', v_n);

  -- Files: those the books reference stay. The blobs of the others go, unless a kept row has the same content. Only
  -- keys under the org's own documents prefix are returned (the content-address check is NOT VALID for old rows), so
  -- no archive/ or export/ key, nor another org's, can ever be deleted from here.
  WITH gone AS (
    DELETE FROM crove_kernel.file f WHERE f.org_id = v_org AND f.id <> ALL (v_keep_file) RETURNING f.storage_key
  )
  SELECT pg_catalog.count(*), ARRAY(
    SELECT DISTINCT g.storage_key FROM gone g
    WHERE g.storage_key LIKE 'org/' || v_org::text || '/%'
      AND NOT EXISTS (SELECT 1 FROM crove_kernel.file k WHERE k.org_id = v_org AND k.id = ANY (v_keep_file) AND k.storage_key = g.storage_key)
    ORDER BY 1)
  INTO v_n, v_keys FROM gone;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('crove_kernel.file', v_n);
  v_keys := COALESCE(v_keys, ARRAY[]::text[]) || v_conversation_keys;

  v_pinned := pg_catalog.jsonb_build_object(
    'crove_kernel.task_comment', (SELECT pg_catalog.count(*) FROM crove_kernel.task_comment c WHERE c.org_id = v_org),
    'crove_kernel.task', pg_catalog.cardinality(v_keep_task),
    'crove_kernel.ai_run', pg_catalog.cardinality(v_keep_run),
    'crove_kernel.position', pg_catalog.cardinality(v_keep_position),
    'crove_kernel.agent', pg_catalog.cardinality(v_keep_agent),
    'crove_social.post_approval', (SELECT pg_catalog.count(*) FROM crove_social.post_approval a WHERE a.org_id = v_org),
    'crove_social.post_variant', pg_catalog.cardinality(v_keep_variant),
    'crove_social.post', pg_catalog.cardinality(v_keep_post),
    'crove_kernel.channel_connection', pg_catalog.cardinality(v_keep_connection),
    'crove_finance.stock_item', (SELECT pg_catalog.count(*) FROM crove_finance.stock_item i WHERE i.org_id = v_org));

  UPDATE crove_kernel.tenant t SET status = 'closed' WHERE t.org_id = v_org;

  outcome := 'ok';
  counts := pg_catalog.jsonb_build_object(
    'deleted', v_deleted,
    'pinned', v_pinned,
    'anonymized', pg_catalog.jsonb_build_object('crove_kernel.party', v_anonymized),
    'keptFiles', pg_catalog.cardinality(v_keep_file),
    'keptParties', pg_catalog.cardinality(v_keep_party),
    'keptProposals', pg_catalog.cardinality(v_keep_proposal));
  blob_keys := v_keys;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.org_purge(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.org_purge(integer) TO crove_worker;
