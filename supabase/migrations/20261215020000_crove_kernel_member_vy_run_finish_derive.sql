-- SPDX-License-Identifier: AGPL-3.0-only
-- ADR-0049 clean-up, part 3b (#2822): how a member's background run is closed, tightened without changing its signature. Idempotent; applied files
-- stay untouched.
--   member_vy_run_error_code_ok(code)   the fixed words an ai_run.error may hold (exactly the codes the callers emit, the same list as MEMBER_VY_RUN_ERROR_CODES in
--                                       packages/kernel/src/member-vy.ts, which a unit test ties to this one; a code a caller invents is refused, and a new
--                                       one is added in both places, with its invariant case first)
--   member_vy_run_finish(run, status, error_code)   restated from 20261201000000: status may be NULL, and is then DERIVED from the result (a ready
--                                       result closes the run as succeeded, anything else as failed); an explicit status is still checked against
--                                       the result, and 'cancelled' stays the caller's to say. The error code must be on the list.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.member_vy_run_error_code_ok(p_code text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_code = ANY (ARRAY['AGENT_FORBIDDEN', 'AGENT_NOT_ACTIVE', 'AGENT_NOT_MEMBER_VY', 'AGENT_RUN_NOT_LIVE', 'AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'AUDIO_NOT_FOUND', 'FORBIDDEN', 'MEDIA_KEY_SHREDDED', 'MEDIA_KEY_UNAVAILABLE', 'MEETING_NO_AUDIO', 'MEETING_NOT_FOUND', 'MEMBER_NOT_ACTIVE', 'NOT_A_MEMBER', 'RUN_CANCELLED', 'TENANT_NOT_ACTIVE', 'TRANSCRIBE_AUTH', 'TRANSCRIBE_FAILED', 'TRANSCRIBE_INVALID_REQUEST', 'TRANSCRIBE_INVALID_RESPONSE', 'TRANSCRIBE_NETWORK', 'TRANSCRIBE_RATE_LIMIT', 'TRANSCRIBE_TIMEOUT', 'TRANSCRIBE_UNAVAILABLE', 'TRANSCRIPT_EMPTY', 'TRANSCRIPT_RESULT_INVALID', 'TRANSCRIPT_TOO_LONG', 'VY_NOT_ALLOWED'])
$$;
REVOKE ALL ON FUNCTION crove_kernel.member_vy_run_error_code_ok(text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
  -- The status is given only to say cancelled (a cancel is a decision, not something the result shows); NULL derives it below from the result.
  IF p_status IS NOT NULL AND p_status NOT IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'MEMBER_VY_STATUS' USING ERRCODE = '22023';
  END IF;
  -- ai_run.error holds a fixed code from the list, never text.
  IF p_error_code IS NOT NULL AND NOT crove_kernel.member_vy_run_error_code_ok(p_error_code) THEN
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
  -- Derived, never trusted: a ready result is a run that succeeded; anything else the caller does not call cancelled is a run that failed.
  IF p_status IS NULL THEN
    p_status := CASE WHEN v_result_status = 'ready' THEN 'succeeded' ELSE 'failed' END;
  END IF;
  -- Only a run that did not succeed has a code, and it must have one.
  IF (p_status = 'succeeded') <> (p_error_code IS NULL) THEN
    RAISE EXCEPTION 'MEMBER_VY_REASON' USING ERRCODE = '22023';
  END IF;
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
