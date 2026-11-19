-- SPDX-License-Identifier: AGPL-3.0-only
-- The sealed write contexts of the Engage coworkers (E2 of epic #3857, issue #3861; ADR-0051 decisions 10 and 11, owner decision 2026-11-19). A company MCP grant that holds `ludy.engage.write` may run the
-- R1 twins of the Hộp thư and CRM commands a person runs (assign, resolve, reopen, note, link a contact, follow up, a new contact, a new deal, move a deal, save or revise a draft quote, mark a next step
-- done or snoozed); one that holds `ludy.ads.draft` may save an ads campaign draft. Nothing above R1 runs (a proposal is another context, #3858 slice d). Per call:
--   enter_mcp_company_write_context(org, grant, scope)   the API login's alone: the same gate as every other entry (the grant stands, is a company grant, holds the read scope and the named write scope, in a
--                                                        read-write transaction, the member row then the grant row locked as a demotion takes them), then it seals an agent-shaped context with no user (so no
--                                                        user-bound policy, private note or member row answers it), tainted, R1, of its own kind: `mcp_engage_write` for the engage scope, `mcp_ads_draft` for the ads one;
--   agent_write_guard                                     restated whole from 20270119150000 with one new branch: those two kinds insert and update the rows of the tables named below, each only in the narrow
--                                                        shape of its command (mcp_write_row_ok), and never delete a row but the lines of a draft quote the draft's own save replaces. Every other table, and every
--                                                        write of any other kind of context, is refused as before. No event (crove_kernel.emit needs a run an MCP grant has not), no outbox row, no key.
--   policies                                              the engage kind reads and updates a conversation and reads its messages as the company read context does (the whole-org scope '*'), in the same two
--                                                        policies each; the ads kind reads nothing of Hộp thư. The kind is compared inline, never through a function (no function names a kind but its entry).
--   activity_stamp_agent                                  a timeline row written under these kinds is stamped with the grantor as its actor and no agent (the grant is not an org-chart agent, so the foreign key
--                                                        would refuse it), so a person's timeline shows the entry and the audit row (which names the grant, client and agent) says who really made it.
-- Stored text written under these contexts is the agent's: a party made here is `external` (a value nobody at the company vouched for), and every deal, quote and conversation read of E1 already says
-- `tainted: true`. Existing grants gain nothing: a scope with no entry runs no command, and the CHECK and definers of 20270119120000 are the only ways to hold a scope. Idempotent; applied files untouched.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- The write contexts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_kernel.enter_mcp_company_write_context(p_org_id uuid, p_grant_id uuid, p_scope text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid;
  v_user_before uuid;
  v_kind text;
  v_scopes text[];
  v_revoked timestamptz;
  v_expires timestamptz;
  v_role text;
  v_ctx_kind text;
  v_module text;
BEGIN
  PERFORM crove_kernel.context_reentry_guard();
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_app', 'MEMBER') THEN
    RAISE EXCEPTION 'MCP_CONTEXT_API_ONLY' USING ERRCODE = '42501';
  END IF;
  -- A write context is for a transaction that may write: a read-only one is a bug in the caller.
  IF pg_catalog.current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'MCP_WRITE_READ_ONLY' USING ERRCODE = '25006';
  END IF;
  IF p_scope = 'ludy.engage.write' THEN
    v_ctx_kind := 'mcp_engage_write';
    v_module := 'kernel';
  ELSIF p_scope = 'ludy.ads.draft' THEN
    v_ctx_kind := 'mcp_ads_draft';
    v_module := 'ads';
  ELSE
    RAISE EXCEPTION 'MCP_GRANT_SCOPE' USING ERRCODE = '42501';
  END IF;
  -- Lock order as the draft entry's: the member row, then the grant row, as a demotion takes them (the update of the member row, then the trigger's revoke of the grants), so a write racing a demotion
  -- waits and never deadlocks. The grant's user is read first without a lock, only to know which member row to lock; every value used below is read again under both locks.
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
    'module', v_module, 'max_risk', 'R1', 'tainted', true, 'le_scope', pg_catalog.jsonb_build_array('*'), 'flags', '[]'::jsonb,
    'kind', v_ctx_kind, 'grantor', v_user));
  RETURN pg_catalog.jsonb_build_object('role', v_role, 'grantor', v_user, 'maxRisk', 'R1', 'tainted', true);
END $$;
REVOKE ALL ON FUNCTION crove_kernel.enter_mcp_company_write_context(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.enter_mcp_company_write_context(uuid, uuid, text) TO crove_app;

-- ---------------------------------------------------------------------------
-- The rows the two kinds may write
-- ---------------------------------------------------------------------------
-- Which columns a row's update changed, as a set of names.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_changed_columns(p_old jsonb, p_new jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(pg_catalog.array_agg(k.key), ARRAY[]::text[])
  FROM (SELECT key FROM pg_catalog.jsonb_object_keys(p_new) AS key) k
  WHERE (p_old -> k.key) IS DISTINCT FROM (p_new -> k.key)
$$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_changed_columns(jsonb, jsonb) FROM PUBLIC;

-- Whether one statement of a sealed Engage or ads write context is in the narrow shape of the command it is for. `p_kind` is the kind of the context (the guard has checked it), `p_table` is schema.table,
-- `p_op` the statement, `p_old` and `p_new` the row as jsonb (null for the side that does not exist), `p_grantor` the person who connected the app. It names no kind of its own policy: the caller picks it.
CREATE OR REPLACE FUNCTION crove_kernel.mcp_write_row_ok(p_kind text, p_table text, p_op text, p_old jsonb, p_new jsonb, p_grantor uuid) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_changed text[];
BEGIN
  IF p_op NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RETURN false;
  END IF;
  v_changed := CASE WHEN p_op = 'UPDATE' THEN crove_kernel.mcp_changed_columns(p_old, p_new) ELSE ARRAY[]::text[] END;
  IF p_kind = 'mcp_engage_write' THEN
    RETURN CASE
      -- A thread: take it, resolve it, reopen it, link its contact. Nothing else of it changes, and never its kind, channel, sender or text.
      WHEN p_table = 'crove_kernel.conversation' THEN
        p_op = 'UPDATE' AND v_changed <@ ARRAY['assignee_user_id', 'status', 'resolved_at', 'resolved_by', 'party_id', 'updated_at']::text[]
        AND p_new ->> 'status' IN ('new', 'pending', 'resolved')
        AND (p_new ->> 'resolved_by' IS NULL OR p_new ->> 'resolved_by' = p_grantor::text)
      -- An internal note, by the grantor, never edited or deleted.
      WHEN p_table = 'crove_kernel.conversation_note' THEN
        p_op = 'INSERT' AND p_new ->> 'author_user_id' = p_grantor::text
      -- A contact the agent adds is an outside value: external, never one a person vouched for.
      WHEN p_table = 'crove_kernel.party' THEN
        p_op = 'INSERT' AND p_new ->> 'source_trust' = 'external'
      WHEN p_table = 'crove_crm.pipeline_stage' THEN
        p_op = 'INSERT'
      WHEN p_table = 'crove_crm.deal' THEN
        (p_op = 'INSERT' AND p_new ->> 'created_by' = p_grantor::text AND p_new ->> 'updated_by' = p_grantor::text)
        OR (p_op = 'UPDATE' AND v_changed <@ ARRAY['stage_id', 'sort_key', 'closed_at', 'lost_reason', 'version', 'updated_by', 'updated_at']::text[]
            AND p_new ->> 'updated_by' = p_grantor::text)
      WHEN p_table = 'crove_crm.deal_next_step' THEN
        p_op = 'UPDATE' AND v_changed <@ ARRAY['status', 'closed_reason', 'resolved_at', 'resolved_by', 'snoozed_until']::text[]
        AND p_new ->> 'status' IN ('open', 'done', 'closed') AND (p_new ->> 'resolved_by' IS NULL OR p_new ->> 'resolved_by' = p_grantor::text)
      WHEN p_table = 'crove_crm.quote' THEN
        (p_op = 'INSERT' AND p_new ->> 'status' = 'draft' AND p_new ->> 'created_by' = p_grantor::text AND p_new ->> 'updated_by' = p_grantor::text)
        OR (p_op = 'UPDATE' AND p_old ->> 'status' = 'draft' AND p_new ->> 'status' = 'draft'
            AND v_changed <@ ARRAY['valid_until', 'remarks', 'terms', 'subtotal', 'vat_amount', 'total', 'version', 'updated_by', 'updated_at']::text[]
            AND p_new ->> 'updated_by' = p_grantor::text)
      -- The lines of a draft quote: written whole, and replaced by the draft's own save.
      WHEN p_table = 'crove_crm.quote_line' THEN
        p_op IN ('INSERT', 'DELETE')
      ELSE false
    END;
  ELSIF p_kind = 'mcp_ads_draft' THEN
    RETURN CASE
      -- An ads campaign draft an AI app made: origin ai, by the grantor, never approved. An edit only of a draft that is one of the agent's kind and stays so.
      WHEN p_table = 'crove_ads.ad_campaign_draft' THEN
        (p_op = 'INSERT' AND p_new ->> 'origin' = 'ai' AND p_new ->> 'status' = 'draft' AND p_new ->> 'created_by' = p_grantor::text)
        OR (p_op = 'UPDATE' AND p_old ->> 'origin' = 'ai' AND p_new ->> 'origin' = 'ai' AND p_old ->> 'status' = 'draft' AND p_new ->> 'status' = 'draft')
      ELSE false
    END;
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.mcp_write_row_ok(text, text, text, jsonb, jsonb, uuid) FROM PUBLIC;

-- agent_write_guard, restated whole from 20270119150000 with one new branch: the Engage and ads write contexts.
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
    -- The sealed write contexts of the Engage coworkers (#3861, kinds mcp_engage_write and mcp_ads_draft) write the rows crove_kernel.mcp_write_row_ok names, each in the narrow shape of its command, and
    -- nothing else: no other table, no row that is not that shape, and no delete but the lines of a draft quote. No event is emitted (crove_kernel.emit needs a run an MCP grant has not), so outbox_pending
    -- stays refused like every other table.
    IF v_ctx ->> 'kind' IN ('mcp_engage_write', 'mcp_ads_draft') AND v_ctx ->> 'grantor' IS NOT NULL
       AND crove_kernel.mcp_write_row_ok(
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

-- ---------------------------------------------------------------------------
-- The one question the policies ask about the engage kind
-- ---------------------------------------------------------------------------
-- Whether the sealed context of this statement is the engage write context of a company grant (an agent-shaped context of the kind `mcp_engage_write` with the whole-org scope). A definer, because a tenant
-- login may not read the sealed context itself; it answers a boolean and reads only the context of the statement, so it cannot be steered to another org or grant. The policies below call it and never read
-- the sealed key themselves, so the nets that pin who reads the sealed context do not move.
CREATE OR REPLACE FUNCTION crove_kernel.ctx_mcp_engage_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(crove_kernel.ctx_actor_type() = 'agent'
                  AND (crove_kernel.ctx_verified() ->> 'kind') = 'mcp_engage_write'
                  AND '*' = ANY ((crove_kernel.ctx_le_scope())::text[]), false)
$$;
REVOKE ALL ON FUNCTION crove_kernel.ctx_mcp_engage_write() FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.ctx_mcp_engage_write() TO crove_tenant;

-- ---------------------------------------------------------------------------
-- Policies: what the engage kind reads and updates of Hộp thư
-- ---------------------------------------------------------------------------
-- The two policies that decide who reads or updates a conversation, and the one that decides who reads its messages, restated from 20270119100000 with one more branch each for the engage kind, whole-org
-- scope only. The write checks of a conversation are restated unchanged but for that branch; an insert or a delete stays a person's (the guard refuses them to an agent anyway).
DROP POLICY IF EXISTS conversation_scope_read ON crove_kernel.conversation;
CREATE POLICY conversation_scope_read ON crove_kernel.conversation AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    crove_kernel.conversation_access(kind, channel_connection_id, false)
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_engage_write())
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_member_id()) IS NOT NULL
      AND crove_kernel.conversation_access_mcp_member(kind, channel_connection_id)
    )
  );
DROP POLICY IF EXISTS conversation_scope_update ON crove_kernel.conversation;
CREATE POLICY conversation_scope_update ON crove_kernel.conversation AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    crove_kernel.conversation_access(kind, channel_connection_id, false)
    OR (
      (SELECT crove_kernel.ctx_mcp_engage_write())
    )
  )
  WITH CHECK (
    crove_kernel.conversation_access(kind, channel_connection_id, true)
    OR (
      (SELECT crove_kernel.ctx_mcp_engage_write())
    )
  );
DROP POLICY IF EXISTS conversation_message_scope_read ON crove_kernel.conversation_message;
CREATE POLICY conversation_message_scope_read ON crove_kernel.conversation_message AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    crove_kernel.conversation_access(kind, channel_connection_id, false)
    OR (
      (SELECT crove_kernel.ctx_actor_type()) = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_engage_write())
    )
    OR (
      (SELECT crove_kernel.ctx_mcp_member_id()) IS NOT NULL
      AND crove_kernel.conversation_access_mcp_member(kind, channel_connection_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Policies: the write checks the engage kind passes
-- ---------------------------------------------------------------------------
-- The write policies of a note, a quote, its lines and a next step ask who the person is (their member row and role), which a sealed context with no user cannot answer. Each is restated with the
-- one more way in for the engage kind (compared inline, whole-org scope), in the same shape the person's branch has where it has one (a draft quote, with no number and nothing sent), and the guard above
-- still says which rows. The person's branch and the system branch are unchanged.
DROP POLICY IF EXISTS conversation_note_scope ON crove_kernel.conversation_note;
CREATE POLICY conversation_note_scope ON crove_kernel.conversation_note AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (EXISTS (SELECT 1 FROM crove_kernel.conversation c WHERE c.org_id = conversation_note.org_id AND c.id = conversation_note.conversation_id))
  WITH CHECK (EXISTS (
    SELECT 1 FROM crove_kernel.conversation c
    WHERE c.org_id = conversation_note.org_id AND c.id = conversation_note.conversation_id
      AND (crove_kernel.conversation_access(c.kind, c.channel_connection_id, true)
           OR (SELECT crove_kernel.ctx_mcp_engage_write()))));

-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
DROP POLICY IF EXISTS deal_next_step_update ON crove_crm.deal_next_step;
-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
CREATE POLICY deal_next_step_update ON crove_crm.deal_next_step AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (SELECT crove_kernel.ctx_mcp_engage_write())
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_next_step.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (SELECT crove_kernel.ctx_mcp_engage_write())
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = deal_next_step.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
DROP POLICY IF EXISTS quote_insert ON crove_crm.quote;
-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
CREATE POLICY quote_insert ON crove_crm.quote AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR ((EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
         OR (SELECT crove_kernel.ctx_mcp_engage_write()))
        AND status = 'draft' AND number IS NULL AND sent_at IS NULL AND sent_via IS NULL AND first_viewed_at IS NULL AND decided_at IS NULL AND decline_reason IS NULL));

-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
DROP POLICY IF EXISTS quote_update ON crove_crm.quote;
-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
CREATE POLICY quote_update ON crove_crm.quote AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (SELECT crove_kernel.ctx_mcp_engage_write())
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (SELECT crove_kernel.ctx_mcp_engage_write())
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
DROP POLICY IF EXISTS quote_line_insert ON crove_crm.quote_line;
-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
CREATE POLICY quote_line_insert ON crove_crm.quote_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR ((EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
         OR (SELECT crove_kernel.ctx_mcp_engage_write()))
        AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')));

-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
DROP POLICY IF EXISTS quote_line_delete ON crove_crm.quote_line;
-- migration-lint: cross-module the CRM table's write policy asks who the person is; the engage write context is one more way in (#3861, ADR-0051 decision 11).
CREATE POLICY quote_line_delete ON crove_crm.quote_line AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR ((EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = quote_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
         OR (SELECT crove_kernel.ctx_mcp_engage_write()))
        AND EXISTS (SELECT 1 FROM crove_crm.quote q WHERE q.org_id = quote_line.org_id AND q.id = quote_line.quote_id AND q.status = 'draft')));

-- ---------------------------------------------------------------------------
-- The next step's own guard: the engage kind acts as the person who connected the app
-- ---------------------------------------------------------------------------
-- crove_crm.deal_next_step_guard, restated whole from 20261120110000 with one change: a sealed engage context is read as that person (the grantor) for the two things a member may do to a step, mark it done in
-- their own name and snooze it to a time within 14 days; every other rule of the function is untouched, and no other agent context passes it.
-- migration-lint: cross-module the CRM's trigger function carries the one rule of who may change a next step, and the engage write context is a new way to be that person (#3861).
CREATE OR REPLACE FUNCTION crove_crm.deal_next_step_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_same crove_crm.deal_next_step;
BEGIN
  -- A sealed engage context (an owner's or admin's connected app) is that person for this guard.
  IF v_actor IS NOT DISTINCT FROM 'agent' AND (crove_kernel.ctx_verified() ->> 'kind') = 'mcp_engage_write' THEN
    v_actor := 'user';
    v_user := (crove_kernel.ctx_verified() ->> 'grantor')::uuid;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A row for another org is the tenant policy's to refuse (its own message), not this guard's.
    IF NEW.org_id IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'open' OR NEW.snoozed_until IS NOT NULL THEN
      RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a next step is raised open and unsnoozed';
    END IF;
    RETURN NEW;
  END IF;
  v_same := NEW;
  IF OLD.assignee_user_id IS NOT NULL AND NEW.assignee_user_id IS NULL THEN
    v_same.assignee_user_id := OLD.assignee_user_id;
  END IF;
  IF OLD.resolved_by IS NOT NULL AND NEW.resolved_by IS NULL THEN
    v_same.resolved_by := OLD.resolved_by;
  END IF;
  -- The foreign key's own action runs nested inside the referential trigger (depth 2 or more); a login's own statement is at depth 1 and never
  -- gets this exemption (a member could otherwise wipe who marked a step done).
  IF pg_catalog.pg_trigger_depth() > 1 AND v_same IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- A statement that changes nothing changes nothing, whoever runs it and whatever the step's state.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- The foreign key's own change was settled above (it alone changes nothing else), so here the assignee is as immutable as the rest.
  IF (NEW.org_id, NEW.id, NEW.deal_id, NEW.reason, NEW.since_on, NEW.raised_at, NEW.assignee_user_id)
     IS DISTINCT FROM (OLD.org_id, OLD.id, OLD.deal_id, OLD.reason, OLD.since_on, OLD.raised_at, OLD.assignee_user_id) THEN
    RAISE EXCEPTION 'NEXT_STEP_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a next step keeps its deal, its reason, its day and its assignee';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'NEXT_STEP_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'a resolved next step never changes';
  END IF;
  IF v_actor IS NOT DISTINCT FROM 'user' THEN
    IF NEW.status = 'done' THEN
      IF NEW.resolved_by IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member marks a next step done in their own name';
      END IF;
    ELSIF NEW.status = 'open' THEN
      -- A snooze: only the time changes, and it is a time between now and the longest snooze (14 days) with a day of slack for the application's
      -- clock against the database's: never the past (an unsnooze) and never the far future (a step buried).
      IF NEW.snoozed_until IS NULL OR NEW.resolved_by IS NOT NULL OR NEW.closed_reason IS NOT NULL
         OR NEW.snoozed_until <= pg_catalog.now() OR NEW.snoozed_until > pg_catalog.now() + pg_catalog.make_interval(days => 15) THEN
        RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a member snoozes a next step to a time within the next 14 days';
      END IF;
    END IF;
  ELSIF v_actor IS NOT DISTINCT FROM 'system' THEN
    IF NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'the system only closes a next step';
    END IF;
  ELSIF v_actor IS NOT NULL THEN
    RAISE EXCEPTION 'NEXT_STEP_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'no actor but a member or the system writes a next step';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The timeline row of a call: the grantor's, no agent
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
    IF v_ctx ->> 'kind' IN ('mcp_engage_write', 'mcp_ads_draft') AND v_ctx ->> 'grantor' IS NOT NULL THEN
      -- A connected app's entry is the person's who connected it (the grant is no org-chart agent, so no agent id fits); the audit row of the call names the grant, client and agent.
      NEW.agent_id := NULL;
      NEW.actor_id := (v_ctx ->> 'grantor')::uuid;
      RETURN NEW;
    END IF;
    NEW.agent_id := (v_ctx ->> 'agent')::uuid;
    NEW.actor_id := NULL;
  ELSE
    NEW.agent_id := NULL;
  END IF;
  RETURN NEW;
END $$;
