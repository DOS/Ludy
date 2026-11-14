-- SPDX-License-Identifier: AGPL-3.0-only
-- Member Vy (#3058, ADR-0049): a run whose result is already stored `ready` is closed as `succeeded`, never cancelled. Idempotent; applied files stay untouched.
--   member_vy_runs_cancel(agents, user, module, reason)   restated from 20261128110000 with the same signature, return type, caller check, search_path, owner and grants. Only the
--                                       way the runs are ended changes. A background run's text is stored `ready` in one transaction and the worker's member_vy_run_finish closes the run in
--                                       another, so in between the run reads `running` beside a `ready` result. The old single UPDATE cancelled it all the same (a kill switch, an agent pause, a role
--                                       change to viewer or a loss of vy.use that lands in that gap), which left a cancelled run beside a ready result, a state member_vy_run_finish refuses to record
--                                       (20261215020000). Now each matching running run is taken one by one in id order: the run row is locked first, then its result row (the order finish and the
--                                       store take, so a store in progress is waited for, and the result is read in a statement of its own, which sees what the store committed). A result that is
--                                       `ready` closes the run as `succeeded`, with the result's private_read carried over as finish does, and is not counted; every other run is cancelled as before.
--                                       The count is still the number of runs it cancelled. The second statement (failing the results still running of cancelled runs) is as it was.
-- Not a skip: a skipped run would stay `running` and ai_run_one_running_feature_uq would refuse the next start of that feature for ever if the worker died between the store and the
-- finish; closing it heals that, as the supersede of kernel.member_vy.run.start does (restated in the same change, in TypeScript).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_runs_cancel(p_agent_ids uuid[], p_user uuid, p_module text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_n bigint := 0;
  v_run uuid;
  v_result_status text;
  v_result_private boolean;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- ai_run.error holds a fixed code, never text.
  IF p_reason IS NULL OR p_reason !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'MEMBER_VY_REASON' USING ERRCODE = '22023';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    -- The system context of the worker login only, as member_vy_private_counts asks.
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  FOR v_run IN
    SELECT r.id FROM crove_kernel.ai_run r
    JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
    WHERE r.org_id = v_org AND r.status = 'running' AND a.kind = 'member_vy'
      AND ((p_agent_ids IS NOT NULL AND r.agent_id = ANY (p_agent_ids))
           OR (p_user IS NOT NULL AND a.member_user_id = p_user)
           OR (p_module IS NOT NULL AND r.module = p_module))
    ORDER BY r.id
    FOR UPDATE OF r
  LOOP
    -- The run row is held; the result is read now, in a statement of its own, so a store that was in progress has committed.
    v_result_status := NULL;
    v_result_private := NULL;
    SELECT v.status, v.private_read INTO v_result_status, v_result_private
    FROM crove_kernel.member_vy_result v WHERE v.org_id = v_org AND v.run_id = v_run FOR UPDATE;
    IF v_result_status = 'ready' THEN
      -- A ready result is shown to the member: the run that made it is recorded as succeeded, never as cancelled beside it.
      UPDATE crove_kernel.ai_run SET status = 'succeeded', finished_at = pg_catalog.now(), error = NULL, private_read = private_read OR COALESCE(v_result_private, false)
      WHERE org_id = v_org AND id = v_run AND status = 'running';
    ELSE
      UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = pg_catalog.now(), error = p_reason
      WHERE org_id = v_org AND id = v_run AND status = 'running';
      v_n := v_n + 1;
    END IF;
  END LOOP;
  UPDATE crove_kernel.member_vy_result v SET status = 'failed', error_code = 'RUN_CANCELLED'
  WHERE v.org_id = v_org AND v.status = 'running'
    AND EXISTS (SELECT 1 FROM crove_kernel.ai_run r WHERE r.org_id = v.org_id AND r.id = v.run_id AND r.status = 'cancelled');
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_runs_cancel(uuid[], uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_runs_cancel(uuid[], uuid, text, text) TO crove_tenant;
