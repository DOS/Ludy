-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #5128 (from #5122 / PR #5060 and PR #5118):
-- 1) Restate ludy_kernel.task_before_update() from 20270328000000 so a context-less (v_ctx IS NULL) transition into
--    'done' clears NEW.completed_by to NULL unless explicitly supplied (NEW.completed_by IS NOT DISTINCT FROM OLD.completed_by),
--    preventing inheritance of any stale OLD.completed_by while preserving explicit context-less backfills and all other invariants.
-- 2) Restate ludy_kernel.task_checklist_valid(jsonb) from 20270323050000 checking length(v_text) NOT BETWEEN 1 AND 300 before
--    btrim(v_text, v_ws) so oversized inputs short-circuit before trimming, preserving identical semantics and ACLs.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- Preserve agent update guardrails, done_at, completed_by, and revision from 20270328000000 while clearing
-- inherited completed_by on context-less transitions into 'done' unless explicitly supplied.
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
          IF NEW.completed_by IS NOT DISTINCT FROM OLD.completed_by THEN
            NEW.completed_by := NULL;
          END IF;
        ELSE
          NEW.done_at := pg_catalog.now();
          NEW.completed_by := CASE WHEN v_ctx ->> 'actor' = 'user' THEN (v_ctx ->> 'user')::uuid ELSE NULL END;
        END IF;
      ELSE
        NEW.done_at := COALESCE(OLD.done_at, pg_catalog.now());
        NEW.completed_by := OLD.completed_by;
      END IF;
    ELSE
      NEW.done_at := NULL;
      NEW.completed_by := NULL;
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
      NEW.request_depth, NEW.created_at, NEW.done_at, NEW.completed_by, NEW.revision)
     IS DISTINCT FROM
     (OLD.org_id, OLD.id, OLD.title, OLD.description, OLD.checklist, OLD.kind, OLD.assignee_position_id, OLD.parent_task_id, OLD.source,
      OLD.source_ref, OLD.source_event_id, OLD.created_by_type, OLD.created_by_id, OLD.created_by_run, OLD.due,
      OLD.request_depth, OLD.created_at, OLD.done_at, OLD.completed_by, OLD.revision) THEN
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
    NEW.completed_by := NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.task_before_update() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- Preserve 25-char Unicode whitespace trim parity from 20270323050000 while checking length(v_text) first.
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
    IF pg_catalog.length(v_text) NOT BETWEEN 1 AND 300 THEN
      RETURN false;
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(v_text, v_ws)) = 0 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.task_checklist_valid(jsonb) FROM PUBLIC, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.task_checklist_valid(jsonb) TO ludy_tenant;
