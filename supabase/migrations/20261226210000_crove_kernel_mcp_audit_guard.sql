-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 step 3e: command_input_hash accepts the consenting user's key in a sealed MCP context (the audit row of a refusal is hashed for them). The guard lets a sealed MCP context (kind mcp_company or mcp_member) write exactly one thing, the audit row of a call it refused, by the
-- consenting user and naming its own grant; every other write stays refused. Restated whole from 20261217000000 with one new branch; idempotent; applied file untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.command_input_hash(p_actor_key text, p_command text, p_input text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_ipad bytea;
  v_opad bytea;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The actor key and the command are separated by chr(31) and never contain it, so two different triples never
  -- make one message; the input comes last.
  IF p_actor_key IS NULL OR p_command IS NULL OR p_input IS NULL
     OR pg_catalog.strpos(p_actor_key, pg_catalog.chr(31)) > 0 OR pg_catalog.strpos(p_command, pg_catalog.chr(31)) > 0 THEN
    RAISE EXCEPTION 'INPUT_HASH_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  -- The actor key is the context's own, as the runtime builds it: a user context hashes for its user, an agent
  -- context for its agent and run, the system context (the worker's alone) for a system component. So a member's
  -- context cannot hash a guess under another member's key and compare it with that member's audit row.
  IF (CASE crove_kernel.ctx_actor_type()
        WHEN 'user' THEN pg_catalog.lower(p_actor_key) = 'user:' || crove_kernel.ctx_user_id()::text
        -- A sealed MCP context (ADR-0049 step 3e) hashes for the consenting user whose key the runtime builds, read from the seal, never from the argument.
        WHEN 'agent' THEN CASE WHEN (crove_kernel.ctx_verified() ->> 'grantor' IS NOT NULL OR crove_kernel.ctx_mcp_member_id() IS NOT NULL)
          THEN pg_catalog.lower(p_actor_key) = 'user:' || COALESCE(crove_kernel.ctx_verified() ->> 'grantor', crove_kernel.ctx_mcp_member_id()::text)
          ELSE pg_catalog.lower(p_actor_key) = 'agent:' || crove_kernel.ctx_agent_id()::text || ':' || crove_kernel.ctx_run_id()::text END
        WHEN 'system' THEN pg_catalog.starts_with(p_actor_key, 'system:')
        ELSE false
      END) IS NOT TRUE THEN
    RAISE EXCEPTION 'INPUT_HASH_ACTOR' USING ERRCODE = '42501';
  END IF;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN 'k1:' || pg_catalog.encode(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.input.v1' || pg_catalog.chr(31) || v_org::text || pg_catalog.chr(31) || p_actor_key || pg_catalog.chr(31)
      || p_command || pg_catalog.chr(31) || p_input, 'UTF8'))),
    'hex');
END $$;

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
