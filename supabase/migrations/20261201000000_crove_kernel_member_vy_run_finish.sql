-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2756, ADR-0049 stage B): how a member's background run is closed. Idempotent; applied files stay untouched.
--   member_vy_run_finish(run, status, error_code)  the worker closes the run of a member's Vy in the org's system context, after the member-mode
--                                                  store has written its result. A member-mode context never touches ai_run (the invariant suite
--                                                  pins that), so the run ends here: succeeded only when the result is ready, failed or cancelled with a
--                                                  fixed code, and a result still running is failed with the same code. It refuses every other caller,
--                                                  and answers whether it closed a run that was still running.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_run_finish(p_run uuid, p_status text, p_error_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_result_status text;
  v_result_private boolean;
BEGIN
  -- The system context of the worker login alone: no user, no agent and no member-mode context closes a run through here.
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEMBER_VY_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'MEMBER_VY_STATUS' USING ERRCODE = '22023';
  END IF;
  -- ai_run.error holds a fixed code, never text, and only a run that did not succeed has one.
  IF (p_status = 'succeeded') <> (p_error_code IS NULL) OR (p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') THEN
    RAISE EXCEPTION 'MEMBER_VY_REASON' USING ERRCODE = '22023';
  END IF;
  -- The run first, then its result: the order the cancel definer and the interactive store take their locks in.
  PERFORM 1 FROM crove_kernel.ai_run r
  JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
  WHERE r.org_id = v_org AND r.id = p_run AND a.kind = 'member_vy' AND r.status = 'running'
  FOR UPDATE OF r;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT v.status, v.private_read INTO v_result_status, v_result_private
  FROM crove_kernel.member_vy_result v WHERE v.org_id = v_org AND v.run_id = p_run FOR UPDATE;
  IF p_status = 'succeeded' AND v_result_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_STATE' USING ERRCODE = '22023';
  END IF;
  -- A ready result is shown to the member: the run that made it is recorded as succeeded, never as failed or cancelled beside it.
  IF p_status <> 'succeeded' AND v_result_status = 'ready' THEN
    RAISE EXCEPTION 'MEMBER_VY_RESULT_STATE' USING ERRCODE = '22023';
  END IF;
  IF p_status <> 'succeeded' AND v_result_status = 'running' THEN
    UPDATE crove_kernel.member_vy_result SET status = 'failed', error_code = p_error_code WHERE org_id = v_org AND run_id = p_run AND status = 'running';
  END IF;
  UPDATE crove_kernel.ai_run SET status = p_status, finished_at = pg_catalog.now(), error = p_error_code, private_read = private_read OR COALESCE(v_result_private, false)
  WHERE org_id = v_org AND id = p_run AND status = 'running';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_run_finish(uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.member_vy_run_finish(uuid, text, text) TO crove_worker;
