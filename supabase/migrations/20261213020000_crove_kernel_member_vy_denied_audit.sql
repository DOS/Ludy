-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up, part 3c (#2822): the refusal of Vy in member mode is audited. When a member-mode run tries a command it may not run (a task,
-- a proposal, anything outside kernel.member_vy.*), the runtime refuses it and writes a 'denied' audit row; until now the write guard refused that
-- row too (its command is not a member-mode command), so the refusal left only a log line. The guard now takes it, narrowly:
--   * outcome 'denied' only, a registered-command-shaped name (lower-case dotted words) and no target or a slug target type;
--   * the detail has the keys code, rule and agentRun and no other, each with the shapes member_vy_audit_detail_ok already enforces (a code from
--     the runtime's own list, a rule from the known list, the run's own id): never text;
--   * a bound: at most 20 denied rows for one run in 10 minutes (member mode does not count refusals in the tally, so the bound lives here). A row
--     past the bound is refused, and the runtime logs the loss and notes it in security_event.
-- The name is not checked against the command registry here: only the runtime writes this row, with the name of a command it has registered.
-- Idempotent; applied files stay untouched. agent_write_guard is restated from 20261213000000 with the one alternative added.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_denied_audit_ok(p_org uuid, p_agent uuid, p_run uuid, p_outcome text, p_command text, p_target text, p_detail jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_outcome IS DISTINCT FROM 'denied' OR p_command IS NULL OR p_command !~ '^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{1,40}){1,4}$' OR pg_catalog.length(p_command) > 100 THEN
    RETURN false;
  END IF;
  IF p_target IS NOT NULL AND p_target !~ '^[a-z][a-z0-9_.]{0,62}$' THEN
    RETURN false;
  END IF;
  IF p_detail IS NULL OR pg_catalog.jsonb_typeof(p_detail) <> 'object'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_detail) k WHERE k NOT IN ('agentRun', 'code', 'rule')) THEN
    RETURN false;
  END IF;
  RETURN (SELECT pg_catalog.count(*) FROM crove_kernel.audit_event a
          WHERE a.org_id = p_org AND a.occurred_at > pg_catalog.now() - interval '10 minutes'
            AND a.actor_type = 'agent' AND a.actor_id = p_agent AND a.outcome = 'denied' AND a.detail ->> 'agentRun' = p_run::text) < 20;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_denied_audit_ok(uuid, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
           AND ((crove_kernel.member_vy_audit_command_ok(NEW.command) AND crove_kernel.member_vy_audit_target_ok(NEW.target_type))
                OR crove_kernel.member_vy_denied_audit_ok(NEW.org_id, v_agent, (v_ctx ->> 'run')::uuid, NEW.outcome, NEW.command, NEW.target_type, NEW.detail))
           AND NEW.input_sha256 ~ '^(k1:)?[0-9a-f]{64}$'
           AND crove_kernel.member_vy_audit_detail_ok(NEW.detail) THEN
          NEW.occurred_at := pg_catalog.now();
          RETURN NEW;
        END IF;
      ELSIF TG_TABLE_NAME = 'idempotency_key' THEN
        IF NEW.actor_key = 'agent:' || v_agent::text || ':' || (v_ctx ->> 'run')
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
