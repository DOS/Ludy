-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #3506 (follow-up from #2606 / PR #3498):
-- 1) Harden ludy_kernel.task_checklist_valid() whitespace check to trim all 25 ECMAScript/Unicode whitespace
--    characters matching Zod z.string().trim().
-- 2) Add monotonic ludy_kernel.task.revision (with NOT VALID + VALIDATE CONSTRAINT rollout) for backwards-compatible
--    optimistic concurrency checks in kernel.task.update, preserving task_before_insert / task_before_update guardrails.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.task_checklist_valid(p_steps jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- Exact 25 Unicode whitespace / line-terminator code points stripped by ECMAScript String.prototype.trim() / Zod .trim():
  -- U+0009..U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
  v_ws constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_step jsonb;
  v_text text;
BEGIN
  IF p_steps IS NULL OR pg_catalog.jsonb_typeof(p_steps) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_steps) > 50 THEN
    RETURN false;
  END IF;
  FOR v_step IN SELECT value FROM pg_catalog.jsonb_array_elements(p_steps)
  LOOP
    IF pg_catalog.jsonb_typeof(v_step) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(v_step) AS k(key)
      WHERE k.key NOT IN ('text', 'done')
    ) THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(v_step -> 'text') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_step -> 'done') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    v_text := v_step ->> 'text';
    IF pg_catalog.length(pg_catalog.btrim(v_text, v_ws)) = 0
       OR pg_catalog.length(v_text) NOT BETWEEN 1 AND 300 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.task_checklist_valid(jsonb) FROM PUBLIC, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.task_checklist_valid(jsonb) TO ludy_tenant;

ALTER TABLE ludy_kernel.task
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'ludy_kernel' AND t.relname = 'task' AND c.conname = 'task_revision_positive'
  ) THEN
    ALTER TABLE ludy_kernel.task
      ADD CONSTRAINT task_revision_positive CHECK (revision >= 1) NOT VALID;
  END IF;
END $$;

ALTER TABLE ludy_kernel.task
  VALIDATE CONSTRAINT task_revision_positive;

-- Preserve agent write guardrails from 20270319030000 and initialize revision = 1.
CREATE OR REPLACE FUNCTION ludy_kernel.task_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := ludy_kernel.ctx_verified();
  v_found boolean := false;
  v_depth int;
  v_tainted boolean;
  v_run uuid;
  v_lock timestamptz;
  v_position uuid;
  v_source text;
  v_source_ref jsonb;
  v_entity uuid;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT t.request_depth, t.tainted, t.checkout_run_id, t.lock_expires_at, t.source, t.source_ref, t.legal_entity_id
      INTO v_depth, v_tainted, v_run, v_lock, v_source, v_source_ref, v_entity
    FROM ludy_kernel.task t WHERE t.org_id = NEW.org_id AND t.id = NEW.parent_task_id;
    v_found := FOUND;
    IF v_found THEN
      NEW.request_depth := v_depth + 1;
      NEW.tainted := NEW.tainted OR v_tainted;
    END IF;
  END IF;
  IF v_ctx IS NULL THEN
    IF NEW.status = 'done' THEN
      NEW.done_at := COALESCE(NEW.done_at, pg_catalog.now());
    ELSE
      NEW.done_at := NULL;
    END IF;
    NEW.revision := COALESCE(NEW.revision, 1);
    RETURN NEW;
  END IF;
  NEW.created_by_type := v_ctx ->> 'actor';
  NEW.created_by_id := CASE v_ctx ->> 'actor' WHEN 'user' THEN (v_ctx ->> 'user')::uuid WHEN 'agent' THEN (v_ctx ->> 'agent')::uuid END;
  NEW.created_by_run := (v_ctx ->> 'run')::uuid;
  IF v_ctx ->> 'actor' = 'agent' THEN
    NEW.tainted := NEW.tainted OR ludy_kernel.ctx_run_tainted();
    IF NOT v_found OR v_run IS DISTINCT FROM (v_ctx ->> 'run')::uuid OR v_lock IS NULL OR v_lock <= pg_catalog.now() THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    v_position := (v_ctx ->> 'position')::uuid;
    IF NEW.kind = 'delegation' THEN
      IF NEW.assignee_position_id IS NULL OR v_position IS NULL
         OR NOT ludy_kernel.position_in_subtree(NEW.org_id, v_position, NEW.assignee_position_id)
         OR NOT EXISTS (SELECT 1 FROM ludy_kernel.position p
                        WHERE p.org_id = NEW.org_id AND p.id = NEW.assignee_position_id AND p.status <> 'archived')
         -- #1788: the child takes the parent's entity, so its holder must read it.
         OR NOT ludy_kernel.position_reads_legal_entity(NEW.org_id, NEW.assignee_position_id, v_entity) THEN
        RAISE EXCEPTION 'AGENT_DELEGATION_SUBTREE' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.kind = 'escalation' THEN
      IF v_position IS NULL
         OR NEW.assignee_position_id IS DISTINCT FROM ludy_kernel.task_escalation_target(NEW.org_id, v_position, v_entity) THEN
        RAISE EXCEPTION 'AGENT_ESCALATION_TARGET' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'AGENT_TASK_KIND' USING ERRCODE = '42501';
    END IF;
    NEW.source := v_source;
    NEW.source_ref := v_source_ref;
    NEW.source_event_id := NULL;
    NEW.status := 'todo';
    NEW.done_at := NULL;
    NEW.due := NULL;
    NEW.created_at := pg_catalog.now();
    NEW.checkout_run_id := NULL;
    NEW.lock_expires_at := NULL;
    NEW.fence := 0;
    NEW.checklist := '[]'::jsonb;
    NEW.revision := 1;
  ELSE
    IF NEW.status = 'done' THEN
      NEW.done_at := pg_catalog.now();
    ELSE
      NEW.done_at := NULL;
    END IF;
    NEW.revision := 1;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.task_before_insert() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- Preserve agent update guardrails and done_at tracking from 20270319030000 while maintaining monotonic revision.
CREATE OR REPLACE FUNCTION ludy_kernel.task_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ctx jsonb := ludy_kernel.ctx_verified();
  v_run uuid;
  v_run_expires timestamptz;
  v_ctx_tainted boolean;
BEGIN
  NEW.updated_at := pg_catalog.now();
  IF v_ctx IS NULL OR v_ctx ->> 'actor' IS DISTINCT FROM 'agent' THEN
    IF NEW.status = 'done' THEN
      IF OLD.status IS DISTINCT FROM 'done' THEN
        IF v_ctx IS NULL THEN
          NEW.done_at := COALESCE(NEW.done_at, pg_catalog.now());
        ELSE
          NEW.done_at := pg_catalog.now();
        END IF;
      ELSE
        IF v_ctx IS NULL AND NEW.done_at IS DISTINCT FROM OLD.done_at AND NEW.done_at IS NOT NULL THEN
          NEW.done_at := NEW.done_at;
        ELSE
          NEW.done_at := COALESCE(OLD.done_at, pg_catalog.now());
        END IF;
      END IF;
    ELSE
      NEW.done_at := NULL;
    END IF;
    IF (NEW.title, NEW.description, NEW.checklist, NEW.assignee_position_id, NEW.due, NEW.status)
       IS DISTINCT FROM
       (OLD.title, OLD.description, OLD.checklist, OLD.assignee_position_id, OLD.due, OLD.status) THEN
      NEW.revision := OLD.revision + 1;
    ELSE
      NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
  END IF;
  v_run := (v_ctx ->> 'run')::uuid;
  v_ctx_tainted := ludy_kernel.ctx_run_tainted();
  IF (NEW.org_id, NEW.id, NEW.title, NEW.description, NEW.checklist, NEW.kind, NEW.assignee_position_id, NEW.parent_task_id, NEW.source,
      NEW.source_ref, NEW.source_event_id, NEW.created_by_type, NEW.created_by_id, NEW.created_by_run, NEW.due,
      NEW.request_depth, NEW.created_at, NEW.done_at, NEW.revision)
     IS DISTINCT FROM
     (OLD.org_id, OLD.id, OLD.title, OLD.description, OLD.checklist, OLD.kind, OLD.assignee_position_id, OLD.parent_task_id, OLD.source,
      OLD.source_ref, OLD.source_event_id, OLD.created_by_type, OLD.created_by_id, OLD.created_by_run, OLD.due,
      OLD.request_depth, OLD.created_at, OLD.done_at, OLD.revision) THEN
    RAISE EXCEPTION 'AGENT_TASK_FIELD' USING ERRCODE = '42501';
  END IF;
  NEW.tainted := NEW.tainted OR OLD.tainted OR v_ctx_tainted;
  IF OLD.status IN ('done', 'cancelled') OR NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'AGENT_TASK_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF OLD.checkout_run_id IS NULL OR OLD.lock_expires_at <= pg_catalog.now() THEN
    SELECT r.expires_at INTO v_run_expires FROM ludy_kernel.ai_run r WHERE r.org_id = NEW.org_id AND r.id = v_run;
    IF NEW.checkout_run_id IS DISTINCT FROM v_run OR NEW.fence <> OLD.fence + 1
       OR OLD.assignee_position_id IS DISTINCT FROM (v_ctx ->> 'position')::uuid
       OR NEW.lock_expires_at IS NULL OR NEW.lock_expires_at <= pg_catalog.now()
       OR v_run_expires IS NULL OR NEW.lock_expires_at > v_run_expires
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'todo' AND NEW.status = 'in_progress')) THEN
      RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF OLD.tainted AND NOT v_ctx_tainted THEN
      UPDATE ludy_kernel.ai_run SET tainted = true WHERE org_id = NEW.org_id AND id = v_run AND NOT tainted;
    END IF;
  ELSIF OLD.checkout_run_id IS DISTINCT FROM v_run OR NEW.fence <> OLD.fence
     OR (NEW.checkout_run_id IS NOT NULL AND (NEW.checkout_run_id <> v_run OR NEW.lock_expires_at > OLD.lock_expires_at)) THEN
    RAISE EXCEPTION 'AGENT_LEASE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    NEW.done_at := pg_catalog.now();
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.task_before_update() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
