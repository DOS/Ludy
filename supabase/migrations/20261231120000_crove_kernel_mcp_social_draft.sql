-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0051 decision 2, issue #3227, step 3 (owner decision 2026-11-14: one new write scope and exactly one command): the scope `ludy.social.draft` lets a company MCP grant create a draft Social post
-- for a person to review, and nothing else. A company grant (an owner's or admin's) alone may hold it (a CHECK); mcp_grant_approve accepts it; a member-bound grant's definer does not.
-- enter_mcp_company_draft_context seals the write context for the one command that declares it: agent-shaped, no user, tainted, R1, kind mcp_company_draft, after the same standing check as the read
-- context and a check that the grant holds the scope. agent_write_guard restated whole from 20261226210000 with one new branch: that kind inserts a draft post (an AI post made over MCP by the sealed
-- grantor, status draft, never approved, planned, assigned, repeated or archived) and its draft channels, and nothing else (no event, no update, no delete); the read contexts are unchanged. A CHECK ties an
-- MCP post to origin ai and tainted. Existing read-only grants gain nothing: they hold no such scope and the CHECK and the definers are the only ways to add it. Idempotent; applied files untouched.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  ALTER TABLE crove_kernel.agent_grant DROP CONSTRAINT IF EXISTS agent_grant_scopes_ck;
  ALTER TABLE crove_kernel.agent_grant ADD CONSTRAINT agent_grant_scopes_ck
    CHECK (pg_catalog.cardinality(scopes) BETWEEN 1 AND 4
           AND scopes <@ ARRAY['ludy.read', 'ludy.member.read', 'ludy.social.draft']::text[]
           AND (NOT ('ludy.member.read' = ANY (scopes)) OR kind = 'member')
           AND (NOT ('ludy.social.draft' = ANY (scopes)) OR kind = 'company'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The company grant's definer, restated whole from 20261219000000 with one change: the scope list.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_grant_approve(
  p_client_id text, p_client_name text, p_client_host text, p_scopes text[], p_oauth_grant_id text, p_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_name text := pg_catalog.btrim(p_client_name);
  v_host text := pg_catalog.lower(pg_catalog.btrim(p_client_host));
  v_scopes text[];
  v_old text;
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    JOIN crove_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
    JOIN crove_kernel.user_account u ON u.id = m.user_id AND u.disabled_at IS NULL
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin')
  ) OR crove_kernel.global_kill_switch_on('ai') OR EXISTS (
    SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = v_org AND k.scope = 'org' AND k.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MCP_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR pg_catalog.char_length(p_client_id) NOT BETWEEN 1 AND 512
     OR v_name IS NULL OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 120
     OR v_host IS NULL OR pg_catalog.char_length(v_host) NOT BETWEEN 1 AND 253 OR v_host !~ '^[a-z0-9.:\[\]-]+$'
     OR p_scopes IS NULL OR pg_catalog.cardinality(p_scopes) NOT BETWEEN 1 AND 4 OR NOT (p_scopes <@ ARRAY['ludy.read', 'ludy.social.draft']::text[])
     OR p_oauth_grant_id IS NULL OR pg_catalog.char_length(p_oauth_grant_id) NOT BETWEEN 1 AND 200
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '2150 hours' THEN
    RAISE EXCEPTION 'MCP_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s ORDER BY s) INTO v_scopes FROM pg_catalog.unnest(p_scopes) AS s;
  -- The same user's live grant of the same client ends, with its tokens (the new one is a new consent).
  SELECT g.oauth_grant_id INTO v_old FROM crove_kernel.agent_grant g
  WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
  IF FOUND THEN
    UPDATE crove_kernel.agent_grant g SET revoked_at = pg_catalog.clock_timestamp()
    WHERE g.org_id = v_org AND g.user_id = v_user AND g.client_id = p_client_id AND g.revoked_at IS NULL;
    PERFORM crove_kernel.oauth_record_revoke_by_grant(v_old);
  END IF;
  INSERT INTO crove_kernel.agent_grant (org_id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
  VALUES (v_org, v_user, p_client_id, v_name, v_host, v_scopes, p_oauth_grant_id, pg_catalog.clock_timestamp(), p_expires_at, v_user)
  RETURNING id INTO v_id;
  UPDATE crove_kernel.oauth_record o SET expires_at = GREATEST(o.expires_at, pg_catalog.clock_timestamp() + interval '400 days')
  WHERE o.model = 'Client' AND o.key_hash = pg_catalog.sha256(pg_catalog.convert_to(p_client_id, 'UTF8'));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- The write context of the draft command
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_draft_context(p_org_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_kind text;
  v_scopes text[];
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  -- A write context is for a transaction that may write: a read-only one is a bug in the caller.
  IF pg_catalog.current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'MCP_WRITE_READ_ONLY' USING ERRCODE = '25006';
  END IF;
  SELECT g.user_id, g.kind, g.scopes, g.revoked_at, g.expires_at INTO v_user, v_kind, v_scopes, v_revoked, v_expires
  FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'company' THEN
    RAISE EXCEPTION 'MCP_GRANT_NOT_COMPANY' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user FOR SHARE;
  IF NOT crove_kernel.mcp_grant_standing(p_grant_id, p_org_id, v_user) THEN
    IF v_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'MCP_GRANT_REVOKED' USING ERRCODE = '42501';
    END IF;
    IF v_expires <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'MCP_GRANT_EXPIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF NOT ('ludy.social.draft' = ANY (v_scopes)) THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1, 'org', p_org_id, 'actor', 'agent', 'user', NULL, 'role', v_role, 'agent', p_grant_id, 'run', NULL, 'position', NULL,
    'module', 'social', 'max_risk', 'R1', 'tainted', true, 'le_scope', pg_catalog.jsonb_build_array('*'), 'flags', '[]'::jsonb,
    'kind', 'mcp_company_draft', 'grantor', v_user));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'grantor', v_user, 'maxRisk', 'R1', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_draft_context(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_draft_context(uuid, uuid) TO crove_app;

-- ---------------------------------------------------------------------------
-- The guard, restated whole from 20261226210000 with the one new branch above
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := crove_kernel.ctx_verified();
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
  v_agent := (v_ctx ->> 'agent')::uuid;
  -- A member-bound or company MCP context (ADR-0049 step 3e) is sealed as an agent without a user, so no user-bound policy lets it read. It writes one
  -- thing, the audit row of a call it refused: an INSERT into audit_event by the consenting user (the sealed grantor or member, never the claim of the
  -- row) that names this very grant. Nothing else, no other table, no update, no delete.
  IF (v_ctx ->> 'grantor' IS NOT NULL OR crove_kernel.ctx_mcp_member_id() IS NOT NULL) THEN
    IF TG_TABLE_SCHEMA = 'crove_kernel' AND TG_TABLE_NAME = 'audit_event' AND TG_OP = 'INSERT' THEN
      IF NEW.actor_type = 'user'
         AND NEW.actor_id = COALESCE(v_ctx ->> 'grantor', crove_kernel.ctx_mcp_member_id()::text)::uuid
         AND NEW.detail ->> 'mcpGrant' = v_agent::text THEN
        NEW.occurred_at := pg_catalog.now();
        RETURN NEW;
      END IF;
    END IF;
    -- The write context of the one MCP write command (#3227, scope ludy.social.draft, kind mcp_company_draft) inserts a draft post and nothing else: the post, as an AI draft made over MCP by
    -- the sealed grantor, never approved, planned for publish, assigned, repeated or archived; and its channels, each a plain draft of such a post. It emits no event (crove_kernel.emit needs a run an MCP
    -- grant has not), so outbox_pending stays refused like every other table. Never an update and never a delete.
    IF v_ctx ->> 'kind' = 'mcp_company_draft' AND v_ctx ->> 'grantor' IS NOT NULL AND TG_OP = 'INSERT' THEN
      IF TG_TABLE_SCHEMA = 'crove_social' AND TG_TABLE_NAME = 'post' THEN
        IF NEW.origin = 'ai' AND NEW.actor_origin = 'mcp' AND NEW.tainted IS TRUE
           AND NEW.author_user_id = (v_ctx ->> 'grantor')::uuid
           AND NEW.status = 'draft' AND NEW.revision = 1 AND NEW.archived_at IS NULL AND NEW.archived_by IS NULL
           AND NEW.assignee_user_id IS NULL AND NEW.due_at IS NULL AND NEW.repost_of IS NULL AND NEW.evergreen_days IS NULL
           AND NEW.recurrence IS NULL AND NEW.recurrence_source_id IS NULL THEN
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_SCHEMA = 'crove_social' AND TG_TABLE_NAME = 'post_variant' THEN
        IF NEW.status = 'draft' AND NEW.revision = 1 AND NEW.scheduled_at IS NULL AND NEW.queue_slot_at IS NULL AND NEW.review_since IS NULL
           AND NEW.published_at IS NULL AND NEW.external_post_id IS NULL AND NEW.external_url IS NULL AND NEW.removed_at IS NULL
           AND EXISTS (SELECT 1 FROM crove_social.post p
                       WHERE p.org_id = NEW.org_id AND p.id = NEW.post_id AND p.origin = 'ai' AND p.actor_origin = 'mcp'
                         AND p.tainted IS TRUE AND p.author_user_id = (v_ctx ->> 'grantor')::uuid AND p.status = 'draft') THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
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
      v_run := (v_ctx ->> 'run')::uuid;
      IF TG_TABLE_NAME = 'audit_event' THEN
        v_detail := NEW.detail;
        -- The ids in the detail are the run's own (#2822): runId is the run the context was sealed for; resultId, subjectId and subjectType are those of the one result
        -- row of that run, and when the run has no result yet the detail carries none of them (absent or null). The target is the same: none, or the run itself (a denied row, whose target comes from the model's input, has none). Never a free
        -- uuid, which would carry 128 bits of anything into the write-once audit stream.
        SELECT r.id, r.subject_id, r.subject_type INTO v_res_id, v_res_subject, v_res_type
        FROM crove_kernel.member_vy_result r WHERE r.org_id = NEW.org_id AND r.run_id = v_run;
        v_found := FOUND;
        v_ids_ok := v_detail IS NULL OR (
          (v_detail -> 'runId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'runId') = 'null' OR v_detail ->> 'runId' = v_run::text)
          AND (v_detail -> 'resultId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'resultId') = 'null' OR (v_found AND v_detail ->> 'resultId' = v_res_id::text))
          AND (v_detail -> 'subjectId' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectId') = 'null' OR (v_found AND v_detail ->> 'subjectId' = v_res_subject::text))
          AND (v_detail -> 'subjectType' IS NULL OR pg_catalog.jsonb_typeof(v_detail -> 'subjectType') = 'null' OR (v_found AND v_detail ->> 'subjectType' = v_res_type)));
        IF TG_OP = 'INSERT' AND NEW.actor_type = 'agent' AND NEW.actor_id = v_agent
           AND COALESCE(v_ids_ok, false)
           AND NEW.detail ->> 'agentRun' = (v_ctx ->> 'run')
           AND ((crove_kernel.member_vy_audit_command_ok(NEW.command) AND crove_kernel.member_vy_audit_target_ok(NEW.target_type)
                 AND (NEW.target_id IS NULL OR (NEW.target_type = 'kernel.ai_run' AND NEW.target_id = v_run)))
                OR (NEW.target_id IS NULL
                    AND crove_kernel.member_vy_denied_audit_ok(NEW.org_id, v_agent, (v_ctx ->> 'run')::uuid, NEW.outcome, NEW.command, NEW.target_type, NEW.detail)))
           AND NEW.input_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND crove_kernel.member_vy_audit_detail_ok(NEW.detail) THEN
          NEW.occurred_at := pg_catalog.now();
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
        v_detail := NEW.response;
        -- The ids in the detail are the run's own (#2822): runId is the run the context was sealed for; resultId, subjectId and subjectType are those of the one result
        -- row of that run, and when the run has no result yet the detail carries none of them (absent or null). Never a free
        -- uuid, which would carry 128 bits of anything into the write-once audit stream.
        SELECT r.id, r.subject_id, r.subject_type INTO v_res_id, v_res_subject, v_res_type
        FROM crove_kernel.member_vy_result r WHERE r.org_id = NEW.org_id AND r.run_id = v_run;
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
           AND crove_kernel.member_vy_audit_command_ok(NEW.command)
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


-- A post made over MCP is an AI post and tainted, whatever wrote the row. NOT VALID then VALIDATE: every older row has another actor_origin.
DO $$
BEGIN
  ALTER TABLE crove_social.post ADD CONSTRAINT post_mcp_ai_tainted_ck CHECK (actor_origin <> 'mcp' OR (origin = 'ai' AND tainted)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE crove_social.post VALIDATE CONSTRAINT post_mcp_ai_tainted_ck;
