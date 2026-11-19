-- SPDX-License-Identifier: AGPL-3.0-only
-- An MCP call to an R2 or R3 command becomes a PROPOSAL, never an execution (#3858 slice d; ADR-0051 decision 10; owner decision 2026-11-18/19). What the database gains:
--   proposal.requested_by_grant, mcp_client_name, mcp_client_host   which grant (and which self-declared client, and its redirect host) asked, for the Inbox card; set only by the sealed context below, never changed
--                        after (proposal_keep_mcp_provenance), and a CHECK ties them together and to a tainted proposal with no agent run;
--   enter_mcp_company_proposal_context(org, grant, scope)   the API login's alone: a company grant that stands (the same gate as every other entry), holds the read scope and the named write scope, enters an
--                        agent-shaped, tainted R1 context of kind mcp_company_proposal with no user, naming the grant and the grantor;
--   refuse_agent_write and agent_write_guard (restated whole, one branch each)   that context may INSERT one pending proposal of an exact shape into crove_kernel.proposal and write its audit row (the branch every
--                        MCP context has) and nothing else; the approval policy must name an approver for the command, so an R3 call without a policy that allows a proposal inserts nothing;
--   mcp_proposal_command (catalog)   the commands an MCP proposal may name, each with the one write scope it needs; filled only by a migration (the migration of the line that declares the command, with
--                        its approval policy), empty here, and read by the guard below, so the database itself keeps a grant's scope to its own line's commands (a grant holding ludy.social.draft cannot insert a proposal of
--                        any other command, whatever the caller's TypeScript does). The sealed context carries the scope it was entered for;
--   mcp_proposal_cap (before insert, a definer)   checks the grant stands now (not revoked, the org not stopped), stamps the client name and host and the title from the grant's own record and the catalog's kind, and
--                        applies a DB-backed cap of pending proposals per grant (20) and per org (100) over all grants, both counted under one advisory lock per org, so a looping client cannot flood the Inbox whatever
--                        the API process's memory holds; the insert is refused with MCP_PROPOSAL_CAP and a person's decision (approve, reject) or the expiry frees room.
-- The approver snapshot (eligible_approvers) is stamped by the guard from crove_kernel.approval_eligible_now. The authors of such a proposal are the grant (an agent entry, never an approver) and the grantor (a user entry): where the approval policy asks for four-eyes (P10) with two or more eligible approvers, someone other than the grantor approves; a sole approver uses the one-person path, flagged as self-approved, as for any proposal.
-- Idempotent (add column if not exists, create or replace, drop and create); applied files untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS requested_by_grant uuid;
ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS mcp_client_name text;
ALTER TABLE crove_kernel.proposal ADD COLUMN IF NOT EXISTS mcp_client_host text;
DO $$
BEGIN
  ALTER TABLE crove_kernel.proposal DROP CONSTRAINT IF EXISTS proposal_mcp_grant_shape;
  ALTER TABLE crove_kernel.proposal ADD CONSTRAINT proposal_mcp_grant_shape
    CHECK ((requested_by_grant IS NULL) = (mcp_client_name IS NULL) AND (requested_by_grant IS NULL) = (mcp_client_host IS NULL)
           AND (requested_by_grant IS NULL OR (requested_by_agent IS NULL AND tainted AND pg_catalog.char_length(mcp_client_name) BETWEEN 1 AND 120 AND pg_catalog.char_length(mcp_client_host) BETWEEN 1 AND 253))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- The columns are new, so every existing row holds the rule (all three null): validated at once.
ALTER TABLE crove_kernel.proposal VALIDATE CONSTRAINT proposal_mcp_grant_shape;
CREATE INDEX IF NOT EXISTS proposal_mcp_grant_pending_idx ON crove_kernel.proposal (org_id, requested_by_grant) WHERE requested_by_grant IS NOT NULL AND status = 'pending';

-- The provenance of an MCP proposal never changes.
CREATE OR REPLACE FUNCTION crove_kernel.proposal_keep_mcp_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.requested_by_grant, NEW.mcp_client_name, NEW.mcp_client_host) IS DISTINCT FROM (OLD.requested_by_grant, OLD.mcp_client_name, OLD.mcp_client_host) THEN
    RAISE EXCEPTION 'PROPOSAL_PROVENANCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TABLE IF NOT EXISTS crove_kernel.mcp_proposal_command (
  command text PRIMARY KEY CHECK (command ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  scope text NOT NULL CHECK (scope IN ('ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft')),
  -- The kind of the command's proposals (its proposalKind, the Inbox card's kind): the guard takes the proposal's kind from here, never from the caller.
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  adr text NOT NULL CHECK (adr ~ '^ADR-[0-9]{4}( .*)?$')
);
REVOKE ALL ON crove_kernel.mcp_proposal_command FROM PUBLIC;
GRANT SELECT ON crove_kernel.mcp_proposal_command TO crove_tenant;
SELECT crove_kernel.agent_write_guard_install('crove_kernel.mcp_proposal_command');

REVOKE ALL ON FUNCTION crove_kernel.proposal_keep_mcp_provenance() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS proposal_keep_mcp_provenance ON crove_kernel.proposal;
CREATE TRIGGER proposal_keep_mcp_provenance BEFORE UPDATE ON crove_kernel.proposal FOR EACH ROW EXECUTE FUNCTION crove_kernel.proposal_keep_mcp_provenance();

-- The stamp and the cap, one BEFORE INSERT trigger. A definer, because the tenant login reads no agent_grant; it reads only the grant named by the row being inserted, and counts pending proposals.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_proposal_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_grant integer;
  v_org integer;
  v_name text;
  v_host text;
  v_user uuid;
BEGIN
  IF NEW.requested_by_grant IS NULL THEN
    RETURN NEW;
  END IF;
  -- The client the card names is the grant's own record, never what the caller passed: the name the client declared at registration and the host it returns to.
  SELECT g.client_name, g.client_host, g.user_id INTO v_name, v_host, v_user FROM crove_kernel.agent_grant g WHERE g.org_id = NEW.org_id AND g.id = NEW.requested_by_grant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  -- The grant stands at the moment of the insert (not revoked or expired, its grantor still an owner or admin, the org active and not stopped by a kill switch): the one gate every entry uses.
  IF NOT crove_kernel.mcp_grant_standing(NEW.requested_by_grant, NEW.org_id, v_user) THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  NEW.mcp_client_name := pg_catalog.left(v_name, 120);
  NEW.mcp_client_host := pg_catalog.left(v_host, 253);
  -- The title is the database's too: built from the grant's own client name (control and direction characters taken out) and the kind the catalog fixed, never from what the caller passed.
  NEW.title := pg_catalog.left('Ứng dụng AI “' || pg_catalog.btrim(pg_catalog.regexp_replace(NEW.mcp_client_name, '[[:cntrl:]\u200b-\u200f\u202a-\u202e\u2066-\u2069]+', ' ', 'g')) || '” đề xuất: ' || NEW.kind, 300);
  -- Inserts of one org queue here (the per-grant cap and the org's both count under it), so two calls, of one grant or of two, never both see room for one more.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mcp_proposal:' || NEW.org_id::text, 3858));
  SELECT pg_catalog.count(*) FILTER (WHERE p.requested_by_grant = NEW.requested_by_grant), pg_catalog.count(*) INTO v_grant, v_org
  FROM crove_kernel.proposal p WHERE p.org_id = NEW.org_id AND p.requested_by_grant IS NOT NULL AND p.status = 'pending';
  IF v_grant >= 20 OR v_org >= 100 THEN
    RAISE EXCEPTION 'MCP_PROPOSAL_CAP' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_proposal_cap() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS mcp_proposal_cap ON crove_kernel.proposal;
CREATE TRIGGER mcp_proposal_cap BEFORE INSERT ON crove_kernel.proposal FOR EACH ROW EXECUTE FUNCTION crove_kernel.mcp_proposal_cap();

-- The sealed context of an MCP proposal.
CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_proposal_context(p_org_id uuid, p_grant_id uuid, p_scope text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_user_before uuid;
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
  IF pg_catalog.current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'MCP_WRITE_READ_ONLY' USING ERRCODE = '25006';
  END IF;
  IF p_scope IS NULL OR NOT (p_scope = ANY (ARRAY['ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft']::text[])) THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  -- Lock order as the draft entry's: the member row, then the grant row, as a demotion takes them.
  SELECT g.user_id INTO v_user_before FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user_before FOR SHARE;
  SELECT g.user_id, g.kind, g.scopes, g.revoked_at, g.expires_at INTO v_user, v_kind, v_scopes, v_revoked, v_expires
  FROM crove_kernel.agent_grant g WHERE g.org_id = p_org_id AND g.id = p_grant_id FOR SHARE OF g;
  IF NOT FOUND OR v_user IS DISTINCT FROM v_user_before THEN
    RAISE EXCEPTION 'MCP_GRANT_INVALID' USING ERRCODE = '28000';
  END IF;
  IF v_kind <> 'company' THEN
    RAISE EXCEPTION 'MCP_GRANT_NOT_COMPANY' USING ERRCODE = '42501';
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
  -- The grant holds the write scope the command declares, and the read scope with it (the CHECK says so too).
  IF NOT (p_scope = ANY (v_scopes)) OR NOT ('ludy.read' = ANY (v_scopes)) THEN
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM crove_kernel.tenant_member m WHERE m.org_id = p_org_id AND m.user_id = v_user;
  PERFORM crove_kernel.ctx_write(pg_catalog.jsonb_build_object(
    'v', 1, 'org', p_org_id, 'actor', 'agent', 'user', NULL, 'role', v_role, 'agent', p_grant_id, 'run', NULL, 'position', NULL,
    'module', 'kernel', 'max_risk', 'R1', 'tainted', true, 'le_scope', pg_catalog.jsonb_build_array('*'), 'flags', '[]'::jsonb,
    'kind', 'mcp_company_proposal', 'grantor', v_user, 'scope', p_scope));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'grantor', v_user, 'maxRisk', 'R1', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_proposal_context(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_proposal_context(uuid, uuid, text) TO crove_app;

-- refuse_agent_write, restated whole from its definition with the one exception above.
CREATE OR REPLACE FUNCTION crove_kernel.refuse_agent_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  -- The one exception (#3858 slice d): the sealed context of an MCP proposal (kind mcp_company_proposal) may INSERT into crove_kernel.proposal; agent_write_guard, which also fires on that table, says which
  -- row. Every other agent context, and every other statement of that one, is refused as before.
  IF crove_kernel.ctx_actor_type() = 'agent'
     AND NOT (TG_TABLE_SCHEMA = 'crove_kernel' AND TG_TABLE_NAME = 'proposal' AND TG_OP = 'INSERT' AND (crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company_proposal') THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- agent_write_guard, restated whole from 20261231180000 with the one new branch above.
CREATE OR REPLACE FUNCTION crove_kernel.agent_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
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
           AND NEW.recurrence IS NULL AND NEW.recurrence_source_id IS NULL AND NEW.recurrence_count = 0 AND NEW.recurrence_next_at IS NULL AND NEW.recurrence_last_at IS NULL
           AND NEW.text_variations = '[]'::jsonb AND NEW.text_variation_next = 0 THEN
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_SCHEMA = 'crove_social' AND TG_TABLE_NAME = 'post_variant' THEN
        IF NEW.status = 'draft' AND NEW.revision = 1 AND NEW.scheduled_at IS NULL AND NEW.queue_slot_at IS NULL AND NEW.review_since IS NULL
           AND NEW.published_at IS NULL AND NEW.external_post_id IS NULL AND NEW.external_url IS NULL AND NEW.removed_at IS NULL
           AND NEW.attempt = 1 AND NEW.error_code IS NULL AND NEW.error_message IS NULL AND NEW.error_retry_at IS NULL AND NEW.next_check_at IS NULL
           AND NEW.paused_connection_version IS NULL AND NEW.edit_state IS NULL AND NEW.content_frozen IS NOT TRUE
           AND NEW.remove_requested_at IS NULL AND NEW.edit_body IS NULL AND NEW.edit_requested_at IS NULL AND NEW.edit_requested_by IS NULL AND NEW.published_revision IS NULL
           AND NEW.media IS NULL AND NEW.link_url IS NULL AND pg_catalog.jsonb_typeof(NEW.settings) = 'object' AND (NEW.settings - 'signature') = '{}'::jsonb
           AND (NEW.settings -> 'signature' IS NULL OR pg_catalog.jsonb_typeof(NEW.settings -> 'signature') = 'string')
           AND EXISTS (SELECT 1 FROM crove_social.post p
                       WHERE p.org_id = NEW.org_id AND p.id = NEW.post_id AND p.origin = 'ai' AND p.actor_origin = 'mcp'
                         AND p.tainted IS TRUE AND p.author_user_id = (v_ctx ->> 'grantor')::uuid AND p.status = 'draft') THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    -- The sealed context in which an MCP call to an R2 or R3 command becomes a proposal (#3858 slice d, kind mcp_company_proposal) inserts ONE row and nothing else: a pending proposal of an exact shape,
    -- stamped with the grant of the context (the sealed agent), authored by that grant (an agent entry) and the sealed grantor (the person who connected it, so four-eyes counts them), tainted, with no decision, execution, result, provenance of an agent run,
    -- extraction or file, and no policy flags; of a command whose approval policy names an approver (crove_kernel.approval_command_policy) and that the catalog lists under the very scope the context was
    -- entered for (crove_kernel.mcp_proposal_command). Never an update and never a delete, and no other table.
    IF v_ctx ->> 'kind' = 'mcp_company_proposal' AND v_ctx ->> 'grantor' IS NOT NULL AND TG_OP = 'INSERT'
       AND TG_TABLE_SCHEMA = 'crove_kernel' AND TG_TABLE_NAME = 'proposal' THEN
      -- The approver snapshot is the database's own reading of who may approve the command now, never the caller's: a forged list (a stranger, the grantor alone) is replaced here, before it is checked.
      NEW.eligible_approvers := crove_kernel.approval_eligible_now(NEW.org_id, NEW.command);
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
         AND pg_catalog.cardinality((crove_kernel.approval_command_policy(NEW.command)).roles) > 0
         AND EXISTS (SELECT 1 FROM crove_kernel.mcp_proposal_command mc WHERE mc.command = NEW.command AND mc.scope = v_ctx ->> 'scope' AND mc.kind = NEW.kind) THEN
        RETURN NEW;
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
