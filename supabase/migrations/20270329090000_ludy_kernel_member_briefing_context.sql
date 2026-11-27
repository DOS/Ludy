-- SPDX-License-Identifier: AGPL-3.0-only
-- Read-only member_briefing context primitives, 23 briefing_sealed_closed policies, 7 Meetings restrictive
-- SELECT policies, narrow member_briefing_directory lookup, and write/worker guards (#5080 Slice A1, ADR-0049):
--   1. ludy_kernel.member_briefing_table (migration-only read catalog).
--   2. ludy_kernel.ctx_briefing_user_id() (INVOKER STABLE helper mirroring ctx_mcp_member_id()).
--   3. ludy_kernel.enter_member_briefing_context(uuid, uuid, uuid) (worker-only R0 sealed entry with full live
--      checks on org, member, email, mail_message, and morning_notice).
--   4. Narrow lookup view ludy_kernel.member_briefing_directory (security_invoker + security_barrier,
--      worker SELECT only, returning only user_id and display_name via untainted SQL helper).
--   5. 23 restrictive briefing_sealed_closed FOR ALL policies (8 ludy_kernel + 15 ludy_projects tables).
--   6. Write/worker guards rejecting kind = 'member_briefing' with 42501.
--   7. 7 restrictive FOR SELECT policies on allowlisted ludy_meetings tables.
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_kernel.member_briefing_table (
  table_name text PRIMARY KEY CHECK (table_name ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  mode text NOT NULL CHECK (mode = 'read'),
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$')
);
REVOKE ALL ON TABLE ludy_kernel.member_briefing_table FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE ludy_kernel.member_briefing_table FROM %I', v_role);
  END LOOP;
END $$;
GRANT SELECT ON TABLE ludy_kernel.member_briefing_table TO ludy_tenant;
SELECT ludy_kernel.agent_write_guard_install('ludy_kernel.member_briefing_table');

CREATE OR REPLACE FUNCTION ludy_kernel.ctx_briefing_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN ludy_kernel.ctx_actor_type() = 'agent' AND ludy_kernel.ctx_verified() ->> 'kind' = 'member_briefing'
              THEN (ludy_kernel.ctx_verified() ->> 'member')::uuid END
$$;
REVOKE ALL ON FUNCTION ludy_kernel.ctx_briefing_user_id() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.ctx_briefing_user_id() FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.ctx_briefing_user_id() TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_kernel.enter_member_briefing_context(
  p_org_id uuid,
  p_member_user_id uuid,
  p_mail_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org_status text;
  v_apps_off text[];
  v_role text;
  v_email text;
  v_scope jsonb;
BEGIN
  PERFORM ludy_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'BRIEFING_CONTEXT_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS NULL OR p_member_user_id IS NULL OR p_mail_id IS NULL THEN
    RAISE EXCEPTION 'BRIEFING_CONTEXT_INVALID' USING ERRCODE = '42501';
  END IF;

  SELECT t.status, t.apps_off INTO v_org_status, v_apps_off
  FROM ludy_kernel.tenant t
  WHERE t.org_id = p_org_id;
  IF NOT FOUND
     OR v_org_status IS DISTINCT FROM 'active'
     OR 'meetings' = ANY (COALESCE(v_apps_off, '{}'::text[]))
     OR NOT ludy_kernel.org_app_on(p_org_id, 'meetings') THEN
    RAISE EXCEPTION 'BRIEFING_CONTEXT_ORG_INVALID' USING ERRCODE = '42501';
  END IF;

  -- Serialize membership updates/removals with writable callers; READ ONLY callers use snapshot consistency.
  IF pg_catalog.current_setting('transaction_read_only') = 'off' THEN
    PERFORM 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = p_member_user_id FOR SHARE;
  END IF;

  SELECT m.role, u.email INTO v_role, v_email
  FROM ludy_kernel.tenant_member m
  JOIN ludy_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = p_org_id
    AND m.user_id = p_member_user_id
    AND m.role IN ('owner', 'admin', 'member')
    AND u.disabled_at IS NULL;
  IF NOT FOUND OR v_email IS NULL OR pg_catalog.btrim(v_email) = '' THEN
    RAISE EXCEPTION 'BRIEFING_MEMBER_NOT_ACTIVE' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM ludy_kernel.mail_message msg
  WHERE msg.org_id = p_org_id
    AND msg.id = p_mail_id
    AND msg.source = 'meetings.morning'
    AND msg.source_id = p_member_user_id
    AND msg.status IN ('queued', 'sending')
    AND msg.created_at >= pg_catalog.now() - interval '36 hours'
    AND msg.created_at <= pg_catalog.now() + interval '5 minutes'
    AND msg.to_address IS NOT NULL
    AND pg_catalog.btrim(msg.to_address) <> ''
    AND pg_catalog.lower(pg_catalog.btrim(msg.to_address)) = pg_catalog.lower(pg_catalog.btrim(v_email));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BRIEFING_MAIL_INVALID' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM ludy_meetings.morning_notice mn
  WHERE mn.org_id = p_org_id
    AND mn.user_id = p_member_user_id
    AND mn.enabled = true
    AND mn.content = 'full';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BRIEFING_OPT_IN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF v_role NOT IN ('owner', 'admin') AND NOT EXISTS (
    SELECT 1 FROM ludy_kernel.role_assignment a
    WHERE a.org_id = p_org_id AND a.user_id = p_member_user_id AND a.legal_entity_id IS NULL
  ) THEN
    SELECT pg_catalog.jsonb_agg(DISTINCT a.legal_entity_id::text ORDER BY a.legal_entity_id::text) INTO v_scope
    FROM ludy_kernel.role_assignment a
    WHERE a.org_id = p_org_id AND a.user_id = p_member_user_id;
  END IF;

  PERFORM ludy_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1,
    'org', p_org_id,
    'actor', 'agent',
    'user', NULL,
    'role', v_role,
    'agent', p_mail_id,
    'run', NULL,
    'position', NULL,
    'module', 'meetings',
    'max_risk', 'R0',
    'tainted', true,
    'le_scope', COALESCE(v_scope, pg_catalog.jsonb_build_array('*')),
    'flags', '[]'::jsonb,
    'kind', 'member_briefing',
    'member', p_member_user_id));

  RETURN pg_catalog.jsonb_build_object(
    'role', v_role,
    'member', p_member_user_id,
    'mail', p_mail_id,
    'maxRisk', 'R0',
    'tainted', true);
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.enter_member_briefing_context(uuid, uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.enter_member_briefing_context(uuid, uuid, uuid) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.enter_member_briefing_context(uuid, uuid, uuid) TO ludy_worker;

-- Narrow active-org display-name lookup helper for render-time member briefing (never exposes email).
-- Uses only standard context accessors so scanPolicyContextReads keeps it untainted.
CREATE OR REPLACE FUNCTION ludy_kernel.member_briefing_directory_rows()
RETURNS TABLE (org_id uuid, user_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.org_id, m.user_id, u.display_name
  FROM ludy_kernel.tenant t
  JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id
  JOIN ludy_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = ludy_kernel.ctx_org_id()
    AND t.status = 'active'
    AND ludy_kernel.ctx_actor_type() = 'agent'
    AND ludy_kernel.ctx_position_id() IS NULL
    AND ludy_kernel.ctx_run_id() IS NULL
    AND pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
    AND u.disabled_at IS NULL
    AND ludy_kernel.ctx_agent_id() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM ludy_kernel.mail_message msg
      WHERE msg.org_id = m.org_id
        AND msg.id = ludy_kernel.ctx_agent_id()
        AND msg.source = 'meetings.morning'
        AND msg.status IN ('queued', 'sending')
        AND msg.created_at >= pg_catalog.now() - interval '36 hours'
        AND msg.created_at <= pg_catalog.now() + interval '5 minutes'
    )
$$;
REVOKE ALL ON FUNCTION ludy_kernel.member_briefing_directory_rows() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.member_briefing_directory_rows() FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.member_briefing_directory_rows() TO ludy_worker;

CREATE OR REPLACE VIEW ludy_kernel.member_briefing_directory
  WITH (security_invoker = true, security_barrier = true)
AS
SELECT d.user_id, d.display_name
FROM ludy_kernel.member_briefing_directory_rows() AS d
WHERE d.org_id = (SELECT ludy_kernel.ctx_org_id())
  AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL;

REVOKE ALL ON ludy_kernel.member_briefing_directory FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON ludy_kernel.member_briefing_directory FROM %I', v_role);
  END LOOP;
END $$;
GRANT SELECT ON ludy_kernel.member_briefing_directory TO ludy_worker;

INSERT INTO ludy_kernel.member_briefing_table (table_name, mode, adr) VALUES
  ('ludy_kernel.member_briefing_directory', 'read', 'ADR-0049'),
  ('ludy_meetings.action_item', 'read', 'ADR-0049'),
  ('ludy_meetings.calendar_agenda', 'read', 'ADR-0049'),
  ('ludy_meetings.meeting', 'read', 'ADR-0049'),
  ('ludy_meetings.meeting_link', 'read', 'ADR-0049'),
  ('ludy_meetings.meeting_reader', 'read', 'ADR-0049'),
  ('ludy_meetings.meeting_result', 'read', 'ADR-0049'),
  ('ludy_meetings.morning_brief_lines', 'read', 'ADR-0049')
ON CONFLICT (table_name) DO NOTHING;

-- 23 restrictive briefing_sealed_closed FOR ALL policies (8 ludy_kernel + 15 ludy_projects).
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.ai_run;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.ai_run AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.inbound_message;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.inbound_message AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.mail_event;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.mail_event AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.mail_message;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.mail_message AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.mail_suppression;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.mail_suppression AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.task;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.task AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.task_comment;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.task_comment AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_kernel.today_mail;
CREATE POLICY briefing_sealed_closed ON ludy_kernel.today_mail AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.* without tainting project_row_visible
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.* without tainting project_row_visible
CREATE POLICY briefing_sealed_closed ON ludy_projects.project AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_column;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_column AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_cycle;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_cycle AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_cycle_snapshot;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_cycle_snapshot AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_cycle_task_history;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_cycle_task_history AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_member;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_member AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_task;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_task AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.project_triage_item;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.project_triage_item AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.roadmap_announcement;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.roadmap_announcement AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.roadmap_board;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.roadmap_board AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.roadmap_item;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.roadmap_item AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.roadmap_signal;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.roadmap_signal AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.roadmap_vote;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.roadmap_vote AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.task_dependency;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.task_dependency AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
DROP POLICY IF EXISTS briefing_sealed_closed ON ludy_projects.time_entry;
-- migration-lint: cross-module ADR-0049 briefing_sealed_closed closes ludy_projects.*
CREATE POLICY briefing_sealed_closed ON ludy_projects.time_entry AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing')
  WITH CHECK (((SELECT ludy_kernel.ctx_verified()) ->> 'kind') IS DISTINCT FROM 'member_briefing');

-- Restate agent_write_guard from 20270122190000 with explicit member_briefing refusal (zero writes).
CREATE OR REPLACE FUNCTION ludy_kernel.agent_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ctx jsonb := ludy_kernel.ctx_verified();
  v_agent uuid;
  v_key text;
  v_run uuid;
  v_detail jsonb;
  v_found boolean;
  v_res_id uuid;
  v_res_subject uuid;
  v_res_type text;
  v_ids_ok boolean;
BEGIN
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'kind' = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  v_agent := (v_ctx ->> 'agent')::uuid;
  IF (v_ctx ->> 'grantor' IS NOT NULL OR ludy_kernel.ctx_mcp_member_id() IS NOT NULL) THEN
    IF TG_TABLE_SCHEMA = 'ludy_kernel' AND TG_TABLE_NAME = 'audit_event' AND TG_OP = 'INSERT' THEN
      IF NEW.actor_type = 'user'
         AND NEW.actor_id = COALESCE(v_ctx ->> 'grantor', ludy_kernel.ctx_mcp_member_id()::text)::uuid
         AND NEW.detail ->> 'mcpGrant' = v_agent::text THEN
        NEW.occurred_at := pg_catalog.now();
        RETURN NEW;
      END IF;
    END IF;
    IF v_ctx ->> 'kind' = 'mcp_company_draft' AND v_ctx ->> 'grantor' IS NOT NULL AND TG_OP = 'INSERT' THEN
      IF TG_TABLE_SCHEMA = 'ludy_social' AND TG_TABLE_NAME = 'post' THEN
        IF NEW.origin = 'ai' AND NEW.actor_origin = 'mcp' AND NEW.tainted IS TRUE
           AND NEW.author_user_id = (v_ctx ->> 'grantor')::uuid
           AND NEW.status = 'draft' AND NEW.revision = 1 AND NEW.archived_at IS NULL AND NEW.archived_by IS NULL
           AND NEW.assignee_user_id IS NULL AND NEW.due_at IS NULL AND NEW.repost_of IS NULL AND NEW.evergreen_days IS NULL
           AND NEW.recurrence IS NULL AND NEW.recurrence_source_id IS NULL AND NEW.recurrence_count = 0 AND NEW.recurrence_next_at IS NULL AND NEW.recurrence_last_at IS NULL
           AND NEW.text_variations = '[]'::jsonb AND NEW.text_variation_next = 0 THEN
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_SCHEMA = 'ludy_social' AND TG_TABLE_NAME = 'post_variant' THEN
        IF NEW.status = 'draft' AND NEW.revision = 1 AND NEW.scheduled_at IS NULL AND NEW.queue_slot_at IS NULL AND NEW.review_since IS NULL
           AND NEW.published_at IS NULL AND NEW.external_post_id IS NULL AND NEW.external_url IS NULL AND NEW.removed_at IS NULL
           AND NEW.attempt = 1 AND NEW.error_code IS NULL AND NEW.error_message IS NULL AND NEW.error_retry_at IS NULL AND NEW.next_check_at IS NULL
           AND NEW.paused_connection_version IS NULL AND NEW.edit_state IS NULL AND NEW.content_frozen IS NOT TRUE
           AND NEW.remove_requested_at IS NULL AND NEW.edit_body IS NULL AND NEW.edit_requested_at IS NULL AND NEW.edit_requested_by IS NULL AND NEW.published_revision IS NULL
           AND NEW.media IS NULL AND NEW.link_url IS NULL AND pg_catalog.jsonb_typeof(NEW.settings) = 'object' AND (NEW.settings - 'signature') = '{}'::jsonb
           AND (NEW.settings -> 'signature' IS NULL OR pg_catalog.jsonb_typeof(NEW.settings -> 'signature') = 'string')
           AND EXISTS (SELECT 1 FROM ludy_social.post p
                       WHERE p.org_id = NEW.org_id AND p.id = NEW.post_id AND p.origin = 'ai' AND p.actor_origin = 'mcp'
                         AND p.tainted IS TRUE AND p.author_user_id = (v_ctx ->> 'grantor')::uuid AND p.status = 'draft') THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    IF v_ctx ->> 'kind' = 'mcp_company_proposal' AND v_ctx ->> 'grantor' IS NOT NULL AND TG_OP = 'INSERT'
       AND TG_TABLE_SCHEMA = 'ludy_kernel' AND TG_TABLE_NAME = 'proposal' THEN
      NEW.eligible_approvers := ludy_kernel.approval_eligible_now(NEW.org_id, NEW.command);
      IF NEW.requested_by_grant = v_agent AND NEW.status = 'pending' AND NEW.revision = 1 AND NEW.tainted IS TRUE
         AND NEW.requested_by_agent IS NULL AND NEW.requested_by_run IS NULL AND NEW.source_task_id IS NULL AND NEW.request_event_id IS NULL
         AND NEW.decided_by IS NULL AND NEW.decided_at IS NULL AND NEW.decided_by_agent IS NULL AND NEW.decision_note IS NULL
         AND NEW.executed_command_id IS NULL AND NEW.result IS NULL AND NEW.source_file_id IS NULL AND NEW.extraction_id IS NULL
         AND NEW.duplicate_of IS NULL AND NEW.resubmitted_from IS NULL AND NEW.policy_flags IS NULL AND NEW.co_authors IS NULL
         AND NEW.reminded_at IS NULL AND NEW.escalated_at IS NULL
         AND NEW.mcp_client_name IS NOT NULL AND NEW.mcp_client_host IS NOT NULL
         AND NEW.request_input IS NULL AND NEW.created_at BETWEEN pg_catalog.now() - interval '1 minute' AND pg_catalog.now() + interval '1 minute'
         AND NEW.eligible_approvers IS NOT NULL AND pg_catalog.cardinality(NEW.eligible_approvers) > 0
         AND pg_catalog.jsonb_typeof(NEW.authors) = 'array' AND pg_catalog.jsonb_array_length(NEW.authors) = 2
         AND NEW.authors -> 0 ->> 'type' = 'agent' AND NEW.authors -> 0 ->> 'id' = v_agent::text AND NEW.authors -> 0 ->> 'run' = v_agent::text
         AND NEW.authors -> 1 ->> 'type' = 'user' AND NEW.authors -> 1 ->> 'id' = v_ctx ->> 'grantor'
         AND pg_catalog.cardinality((ludy_kernel.approval_command_policy(NEW.command)).roles) > 0
         AND EXISTS (SELECT 1 FROM ludy_kernel.mcp_proposal_command mc WHERE mc.command = NEW.command AND mc.scope = v_ctx ->> 'scope' AND mc.kind = NEW.kind) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF v_ctx ->> 'kind' IN ('mcp_engage_write', 'mcp_ads_draft') AND v_ctx ->> 'grantor' IS NOT NULL
       AND ludy_kernel.mcp_write_row_ok(
         v_ctx ->> 'kind', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP,
         CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE pg_catalog.to_jsonb(OLD) END,
         CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE pg_catalog.to_jsonb(NEW) END,
         (v_ctx ->> 'grantor')::uuid) THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF v_ctx ->> 'kind' = 'member_vy' THEN
    IF EXISTS (SELECT 1 FROM ludy_kernel.member_vy_table c
               WHERE c.table_name = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME AND c.mode = 'write') THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
      END IF;
      IF TG_TABLE_NAME = 'member_vy_result' THEN
        IF TG_OP <> 'UPDATE' OR OLD.run_id IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.tainted IS NOT TRUE THEN
          RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF TG_TABLE_SCHEMA = 'ludy_kernel' AND TG_OP <> 'DELETE' THEN
      v_run := (v_ctx ->> 'run')::uuid;
      IF TG_TABLE_NAME = 'audit_event' THEN
        v_detail := NEW.detail;
        SELECT r.id, r.subject_id, r.subject_type INTO v_res_id, v_res_subject, v_res_type
        FROM ludy_kernel.member_vy_result r WHERE r.org_id = NEW.org_id AND r.run_id = v_run;
        v_found := FOUND;
        v_ids_ok := v_detail IS NULL OR (
          (v_detail -> 'runId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'runId') = 'null' OR v_detail ->> 'runId' = v_run::text)
          AND (v_detail -> 'resultId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'resultId') = 'null' OR (v_found AND v_detail ->> 'resultId' = v_res_id::text))
          AND (v_detail -> 'subjectId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectId') = 'null' OR (v_found AND v_detail ->> 'subjectId' = v_res_subject::text))
          AND (v_detail -> 'subjectType' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectType') = 'null' OR (v_found AND v_detail ->> 'subjectType' = v_res_type)));
        IF TG_OP = 'INSERT' AND NEW.actor_type = 'agent' AND NEW.actor_id = v_agent
           AND COALESCE(v_ids_ok, false)
           AND NEW.detail ->> 'agentRun' = (v_ctx ->> 'run')
           AND ((ludy_kernel.member_vy_audit_command_ok(NEW.command) AND ludy_kernel.member_vy_audit_target_ok(NEW.target_type)
                 AND (NEW.target_id IS NULL OR (NEW.target_type = 'kernel.ai_run' AND NEW.target_id = v_run)))
                OR (NEW.target_id IS NULL
                    AND ludy_kernel.member_vy_denied_audit_ok(NEW.org_id, v_agent, (v_ctx ->> 'run')::uuid, NEW.outcome, NEW.command, NEW.target_type, NEW.detail)))
           AND NEW.input_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND ludy_kernel.member_vy_audit_detail_ok(NEW.detail) THEN
          NEW.occurred_at := pg_catalog.now();
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
        v_detail := NEW.response;
        SELECT r.id, r.subject_id, r.subject_type INTO v_res_id, v_res_subject, v_res_type
        FROM ludy_kernel.member_vy_result r WHERE r.org_id = NEW.org_id AND r.run_id = v_run;
        v_found := FOUND;
        v_ids_ok := v_detail IS NULL OR (
          (v_detail -> 'runId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'runId') = 'null' OR v_detail ->> 'runId' = v_run::text)
          AND (v_detail -> 'resultId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'resultId') = 'null' OR (v_found AND v_detail ->> 'resultId' = v_res_id::text))
          AND (v_detail -> 'subjectId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectId') = 'null' OR (v_found AND v_detail ->> 'subjectId' = v_res_subject::text))
          AND (v_detail -> 'subjectType' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectType') = 'null' OR (v_found AND v_detail ->> 'subjectType' = v_res_type)));
        IF NEW.actor_key = 'agent:' || v_agent::text || ':' || (v_ctx ->> 'run')
           AND COALESCE(v_ids_ok, false)
           AND (TG_OP = 'INSERT' OR OLD.actor_key = NEW.actor_key)
           AND NEW.key ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$'
           AND ludy_kernel.member_vy_audit_command_ok(NEW.command)
           AND NEW.request_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND (NEW.response IS NULL OR ludy_kernel.member_vy_audit_detail_ok(NEW.response)) THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_SCHEMA = 'ludy_kernel' AND TG_OP <> 'DELETE' THEN
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
           SELECT 1 FROM ludy_kernel.position p
           WHERE p.org_id = NEW.org_id AND p.holder_agent_id = NEW.agent_id
             AND ludy_kernel.position_in_subtree(NEW.org_id, (v_ctx ->> 'position')::uuid, p.id)) THEN
        IF TG_OP = 'INSERT' THEN
          NEW.request_count := 1;
          NEW.tainted := NEW.tainted OR ludy_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
        IF OLD.status = 'pending' AND OLD.org_id = NEW.org_id AND OLD.id = NEW.id AND OLD.agent_id = NEW.agent_id
           AND OLD.created_at = NEW.created_at AND NEW.request_count >= OLD.request_count
           AND NEW.request_depth >= OLD.request_depth THEN
          NEW.tainted := NEW.tainted OR OLD.tainted OR ludy_kernel.ctx_run_tainted();
          RETURN NEW;
        END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.agent_write_guard() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.agent_write_guard() FROM %I', v_role);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.activity_stamp_agent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := ludy_kernel.ctx_verified();
BEGIN
  NEW.actor_origin := 'ui';
  IF v_ctx IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_ctx ->> 'actor' = 'agent' THEN
    IF v_ctx ->> 'kind' IN ('member_vy', 'member_briefing') THEN
      RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'ludy_kernel.activity';
    END IF;
    IF v_ctx ->> 'kind' IN ('mcp_engage_write', 'mcp_ads_draft') AND v_ctx ->> 'grantor' IS NOT NULL THEN
      NEW.agent_id := NULL;
      NEW.actor_id := (v_ctx ->> 'grantor')::uuid;
      NEW.actor_origin := 'mcp';
      RETURN NEW;
    END IF;
    NEW.agent_id := (v_ctx ->> 'agent')::uuid;
    NEW.actor_id := NULL;
  ELSE
    NEW.agent_id := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.activity_stamp_agent() FROM PUBLIC;

-- Update member_vy_forbid() in place (a00_member_vy_forbid triggers are already on task, task_comment, refusal_tally, outbox_event).
CREATE OR REPLACE FUNCTION ludy_kernel.member_vy_forbid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ludy_kernel.ctx_verified() ->> 'kind' IN ('member_vy', 'member_briefing') THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.member_vy_forbid() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.member_vy_forbid() FROM %I', v_role);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_kernel.refusal_tally_note(
  p_command text, p_code text, p_security boolean, p_actor_limit integer, p_org_limit integer, p_reserve integer,
  p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor_type text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_actor text;
  v_window timestamptz;
  v_actor_n bigint;
  v_org_n bigint;
  v_seen boolean;
  v_audit boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'ludy_kernel.refusal_tally';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF v_actor_type = 'user' AND v_user IS NOT NULL THEN
    v_actor := 'user:' || v_user::text;
  ELSIF v_actor_type = 'system' THEN
    v_actor := 'system';
  ELSIF v_actor_type = 'agent' AND ludy_kernel.ctx_agent_id() IS NOT NULL THEN
    v_actor := 'agent:' || ludy_kernel.ctx_agent_id()::text;
  ELSE
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_command IS NULL OR pg_catalog.length(p_command) NOT BETWEEN 1 AND 200
     OR p_code IS NULL OR pg_catalog.length(p_code) NOT BETWEEN 1 AND 100
     OR p_security IS NULL
     OR p_actor_limit IS NULL OR p_actor_limit NOT BETWEEN 1 AND 999999
     OR p_org_limit IS NULL OR p_org_limit NOT BETWEEN 1 AND 999999
     OR p_reserve IS NULL OR p_reserve NOT BETWEEN 0 AND p_actor_limit
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'REFUSAL_TALLY_INVALID' USING ERRCODE = '22023';
  END IF;

  v_window := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', v_now) / p_window_seconds) * p_window_seconds);

  SELECT COALESCE(pg_catalog.sum(t.refusals) FILTER (WHERE t.actor_key = v_actor), 0),
         COALESCE(pg_catalog.sum(t.refusals), 0),
         COALESCE(pg_catalog.bool_or(t.actor_key = v_actor AND t.command = p_command AND t.code = p_code), false)
    INTO v_actor_n, v_org_n, v_seen
  FROM ludy_kernel.refusal_tally t
  WHERE t.org_id = v_org AND t.window_start = v_window;

  v_audit := NOT v_seen
    OR v_actor_n < p_reserve
    OR (v_actor_n < p_actor_limit AND (p_security OR v_org_n < p_org_limit));

  INSERT INTO ludy_kernel.refusal_tally AS t (org_id, window_start, actor_key, command, code, refusals, audited, first_at, last_at)
  VALUES (v_org, v_window, v_actor, p_command, p_code, 1, CASE WHEN v_audit THEN 1 ELSE 0 END, v_now, v_now)
  ON CONFLICT (org_id, window_start, actor_key, command, code) DO UPDATE
    SET refusals = t.refusals + 1,
        audited = t.audited + EXCLUDED.audited,
        last_at = GREATEST(t.last_at, EXCLUDED.last_at);
  RETURN v_audit;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.refusal_tally_note(text, text, boolean, integer, integer, integer, integer) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.refusal_tally_note(text, text, boolean, integer, integer, integer, integer) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.refusal_tally_note(text, text, boolean, integer, integer, integer, integer) TO ludy_app, ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.emit(p_type text, p_payload jsonb, p_command_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := ludy_kernel.ctx_verified();
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_actor text;
  v_id uuid;
BEGIN
  IF v_ctx ->> 'kind' = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'ludy_kernel.outbox_event';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  v_actor := COALESCE(v_ctx ->> 'actor', CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END);
  INSERT INTO ludy_kernel.outbox_event (org_id, type, payload, actor_id, command_id, actor_type, agent_id, agent_run)
  VALUES (
    v_org, p_type, p_payload,
    CASE WHEN v_actor = 'user' THEN v_user END,
    p_command_id,
    v_actor,
    CASE WHEN v_actor = 'agent' THEN (v_ctx ->> 'agent')::uuid END,
    CASE WHEN v_actor = 'agent' THEN (v_ctx ->> 'run')::uuid END
  )
  RETURNING id INTO v_id;
  INSERT INTO ludy_kernel.outbox_pending (org_id, event_id) VALUES (v_org, v_id);
  PERFORM pg_catalog.pg_notify('ludy_outbox', '');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.emit(text, jsonb, uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.emit(text, jsonb, uuid) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.emit(text, jsonb, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_kernel.member_emails(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT u.id, u.email
  FROM ludy_kernel.tenant_member m
  JOIN ludy_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = (SELECT ludy_kernel.ctx_org_id())
    AND m.user_id = ANY (p_user_ids)
    AND u.disabled_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.member_emails(uuid[]) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.member_emails(uuid[]) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.member_emails(uuid[]) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_kernel.today_mail_recipients(p_user_ids uuid[], p_upstream boolean)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'TODAY_MAIL_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF p_upstream AND NOT ludy_kernel.auth_email_check_ready() THEN
    RAISE EXCEPTION 'TODAY_MAIL_AUTH_NOT_READY' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
  SELECT u.id, u.email
  FROM ludy_kernel.tenant_member m
  JOIN ludy_kernel.user_account u ON u.id = m.user_id
  WHERE m.org_id = (SELECT ludy_kernel.ctx_org_id())
    AND m.user_id = ANY (p_user_ids)
    AND u.disabled_at IS NULL
    AND (NOT p_upstream OR CASE
      WHEN u.subject ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN ludy_kernel.auth_email_confirmed(u.subject::uuid)
      ELSE false END);
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.today_mail_recipients(uuid[], boolean) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.today_mail_recipients(uuid[], boolean) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_kernel.today_mail_recipients(uuid[], boolean) TO ludy_worker;

-- Narrow untainted helper for Meetings briefing RLS: verifies agent context without position/run, active org
-- and member, and checks recorder, org visibility + whole-org le_scope, or explicit meeting_reader grant.
-- migration-lint: cross-module ADR-0049 member_briefing read helper in ludy_meetings paired with kernel context migration
CREATE OR REPLACE FUNCTION ludy_meetings.is_briefing_meeting_reader(
  p_org_id uuid,
  p_meeting_id uuid,
  p_user_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_vis text;
  v_recorder uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RETURN false;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'agent'
     OR ludy_kernel.ctx_position_id() IS NOT NULL
     OR ludy_kernel.ctx_run_id() IS NOT NULL
     OR ludy_kernel.ctx_agent_id() IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.mail_message msg
    WHERE msg.org_id = v_org
      AND msg.id = ludy_kernel.ctx_agent_id()
      AND msg.source = 'meetings.morning'
      AND msg.source_id = p_user_id
      AND msg.status IN ('queued', 'sending')
      AND msg.created_at >= pg_catalog.now() - interval '36 hours'
      AND msg.created_at <= pg_catalog.now() + interval '5 minutes'
  ) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant t
    JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id
    JOIN ludy_kernel.user_account u ON u.id = m.user_id
    WHERE t.org_id = v_org
      AND t.status = 'active'
      AND m.user_id = p_user_id
      AND m.role IN ('owner', 'admin', 'member')
      AND u.disabled_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  SELECT m.visibility, m.recorder_user_id INTO v_vis, v_recorder
  FROM ludy_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_recorder = p_user_id THEN
    RETURN true;
  END IF;
  IF v_vis = 'org' AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM ludy_meetings.meeting_reader r
    WHERE r.org_id = v_org AND r.meeting_id = p_meeting_id AND r.user_id = p_user_id
  );
END $$;
-- migration-lint: cross-module ADR-0049 revoke public on ludy_meetings helper
REVOKE ALL ON FUNCTION ludy_meetings.is_briefing_meeting_reader(uuid, uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user LOOP
    -- migration-lint: cross-module ADR-0049 lock execute privileges on ludy_meetings briefing reader helper
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.is_briefing_meeting_reader(uuid, uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
-- migration-lint: cross-module ADR-0049 grant execute to ludy_tenant for RLS policy evaluation
GRANT EXECUTE ON FUNCTION ludy_meetings.is_briefing_meeting_reader(uuid, uuid, uuid) TO ludy_tenant;

-- 7 Meetings restrictive FOR SELECT policies referencing (SELECT ludy_kernel.ctx_briefing_user_id()) directly.
-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting
DROP POLICY IF EXISTS meeting_read ON ludy_meetings.meeting;
-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting
CREATE POLICY meeting_read ON ludy_meetings.meeting AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_kernel.ctx_actor_type() = 'user'
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')
      )
      AND (
        recorder_user_id = (SELECT ludy_kernel.ctx_user_id())
        OR (
          visibility = 'org'
          AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
        )
        OR EXISTS (
          SELECT 1 FROM ludy_meetings.meeting_reader r
          WHERE r.org_id = meeting.org_id AND r.meeting_id = meeting.id AND r.user_id = (SELECT ludy_kernel.ctx_user_id())
        )
      )
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND visibility = 'org'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, id)
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, id)
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND ludy_meetings.is_briefing_meeting_reader(org_id, id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );

-- migration-lint: cross-module ADR-0049 add published-only member_briefing read branch to ludy_meetings.meeting_result
DROP POLICY IF EXISTS meeting_result_read ON ludy_meetings.meeting_result;
-- migration-lint: cross-module ADR-0049 add published-only member_briefing read branch to ludy_meetings.meeting_result
CREATE POLICY meeting_result_read ON ludy_meetings.meeting_result AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND ludy_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND ludy_meetings.is_briefing_meeting_reader(org_id, meeting_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );

-- migration-lint: cross-module ADR-0049 add published-only member_briefing read branch to ludy_meetings.action_item
DROP POLICY IF EXISTS action_item_read ON ludy_meetings.action_item;
-- migration-lint: cross-module ADR-0049 add published-only member_briefing read branch to ludy_meetings.action_item
CREATE POLICY action_item_read ON ludy_meetings.action_item AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND ludy_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND flags = '[]'::jsonb
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND ludy_meetings.is_briefing_meeting_reader(org_id, meeting_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );

-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting_link
DROP POLICY IF EXISTS meeting_link_read ON ludy_meetings.meeting_link;
-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting_link
CREATE POLICY meeting_link_read ON ludy_meetings.meeting_link AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    ludy_meetings.is_meeting_reader(org_id, meeting_id)
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND ludy_meetings.is_briefing_meeting_reader(org_id, meeting_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );

-- migration-lint: cross-module ADR-0049 add member_briefing O1 own-row read branch to ludy_meetings.calendar_agenda
DROP POLICY IF EXISTS calendar_agenda_read ON ludy_meetings.calendar_agenda;
-- migration-lint: cross-module ADR-0049 add member_briefing O1 own-row read branch to ludy_meetings.calendar_agenda
CREATE POLICY calendar_agenda_read ON ludy_meetings.calendar_agenda AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_kernel.ctx_actor_type() = 'user'
      AND user_id = ludy_kernel.ctx_user_id()
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND user_id = (SELECT ludy_kernel.ctx_acting_user_id())
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = calendar_agenda.org_id
          AND m.user_id = (SELECT ludy_kernel.ctx_acting_user_id())
          AND m.role IN ('owner', 'admin', 'member')
      )
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND user_id = (SELECT ludy_kernel.ctx_briefing_user_id())
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = calendar_agenda.org_id
          AND m.user_id = (SELECT ludy_kernel.ctx_briefing_user_id())
          AND m.role IN ('owner', 'admin', 'member')
      )
    )
  );

-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting_reader
DROP POLICY IF EXISTS meeting_reader_read ON ludy_meetings.meeting_reader;
-- migration-lint: cross-module ADR-0049 add member_briefing read branch to ludy_meetings.meeting_reader
CREATE POLICY meeting_reader_read ON ludy_meetings.meeting_reader AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    ludy_meetings.is_meeting_reader(org_id, meeting_id)
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND ludy_meetings.is_briefing_meeting_reader(org_id, meeting_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );

-- Narrow untainted helper for morning_brief_lines_read: morning_notice enforces user-only RLS under invoker,
-- so this SECURITY DEFINER helper verifies the worker-bound morning mail and active morning_notice(enabled, vy_lines)
-- using only standard context accessors.
-- migration-lint: cross-module ADR-0049 read ludy_kernel.mail_message alongside morning_notice in briefing helper
CREATE OR REPLACE FUNCTION ludy_meetings.is_briefing_vy_lines_enabled(
  p_org_id uuid,
  p_user_id uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT
    p_org_id IS NOT NULL
    AND p_user_id IS NOT NULL
    AND p_org_id = ludy_kernel.ctx_org_id()
    AND pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
    AND ludy_kernel.ctx_actor_type() = 'agent'
    AND ludy_kernel.ctx_position_id() IS NULL
    AND ludy_kernel.ctx_run_id() IS NULL
    AND ludy_kernel.ctx_agent_id() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM ludy_kernel.mail_message msg
      WHERE msg.org_id = p_org_id
        AND msg.id = ludy_kernel.ctx_agent_id()
        AND msg.source = 'meetings.morning'
        AND msg.source_id = p_user_id
        AND msg.status IN ('queued', 'sending')
        AND msg.created_at >= pg_catalog.now() - interval '36 hours'
        AND msg.created_at <= pg_catalog.now() + interval '5 minutes'
    )
    AND EXISTS (
      SELECT 1
      FROM ludy_meetings.morning_notice mn
      WHERE mn.org_id = p_org_id
        AND mn.user_id = p_user_id
        AND mn.enabled = true
        AND mn.vy_lines = true
    )
$$;
-- migration-lint: cross-module ADR-0049 revoke public on ludy_meetings vy_lines helper
REVOKE ALL ON FUNCTION ludy_meetings.is_briefing_vy_lines_enabled(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user LOOP
    -- migration-lint: cross-module ADR-0049 lock execute privileges on ludy_meetings vy_lines helper
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.is_briefing_vy_lines_enabled(uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
-- migration-lint: cross-module ADR-0049 grant execute to ludy_tenant for RLS policy evaluation
GRANT EXECUTE ON FUNCTION ludy_meetings.is_briefing_vy_lines_enabled(uuid, uuid) TO ludy_tenant;

-- migration-lint: cross-module ADR-0049 add member_briefing vy_lines read branch to ludy_meetings.morning_brief_lines
DROP POLICY IF EXISTS morning_brief_lines_read ON ludy_meetings.morning_brief_lines;
-- migration-lint: cross-module ADR-0049 add member_briefing vy_lines read branch to ludy_meetings.morning_brief_lines
CREATE POLICY morning_brief_lines_read ON ludy_meetings.morning_brief_lines AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_kernel.ctx_actor_type() = 'user'
      AND user_id = (SELECT ludy_kernel.ctx_user_id())
      AND expires_at > pg_catalog.now()
      AND ludy_meetings.is_meeting_reader(org_id, meeting_id)
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_briefing_user_id()) IS NOT NULL
      AND user_id = (SELECT ludy_kernel.ctx_briefing_user_id())
      AND expires_at > pg_catalog.now()
      AND ludy_meetings.is_briefing_meeting_reader(org_id, meeting_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
      AND ludy_meetings.is_briefing_vy_lines_enabled(org_id, (SELECT ludy_kernel.ctx_briefing_user_id()))
    )
  );
