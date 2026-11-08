-- SPDX-License-Identifier: AGPL-3.0-only
-- #2874: the question the file table's meeting-media policy asks for a member Vy run (see 20261203030100_crove_kernel_file_meeting_media_rls.sql).
-- crove_meetings.member_vy_reads_media_file(org, file) answers true only for a segment file of the ONE meeting the sealed context's own run names, under the
-- same checks as audio_for_member_vy (which it calls, so none is repeated). It takes no run or meeting argument, so it cannot be asked about another meeting's
-- file ids: for any other file it answers false exactly as for a file that does not exist. It never raises, writes or audits; it answers a boolean only.
-- Order of checks: the actor and org from the sealed context (no table is read), then the agent's kind (the agent row only), then the run's meeting, then
-- audio_for_member_vy, then the segment. crove_worker inherits crove_tenant (bootstrap: GRANT crove_tenant TO crove_app, crove_worker, both INHERIT), so EXECUTE is
-- granted to crove_tenant alone.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.member_vy_reads_media_file(p_org_id uuid, p_file_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_agent uuid;
  v_run uuid;
  v_meeting uuid;
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_file_id IS NULL THEN
    RETURN false;
  END IF;
  v_agent := crove_kernel.ctx_agent_id();
  v_run := crove_kernel.ctx_run_id();
  IF v_agent IS NULL OR v_run IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.agent a
    WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active'
  ) THEN
    RETURN false;
  END IF;
  -- The meeting is the one the run's own waiting result row names; it is never an argument.
  SELECT v.subject_id INTO v_meeting
  FROM crove_kernel.member_vy_result v
  WHERE v.org_id = v_org AND v.run_id = v_run AND v.feature = 'meetings.transcribe' AND v.subject_type = 'meeting' AND v.status = 'running'
  LIMIT 1;
  IF v_meeting IS NULL THEN
    RETURN false;
  END IF;
  -- The same checks as the audio read (live run, active member who is the meeting's recorder, key not shredded); it refuses with 42501 otherwise.
  PERFORM 1 FROM crove_meetings.audio_for_member_vy(v_org, v_meeting) LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_meetings.audio_segment s
    WHERE s.org_id = v_org AND s.meeting_id = v_meeting AND s.file_id = p_file_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.member_vy_reads_media_file(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.member_vy_reads_media_file(uuid, uuid) TO crove_tenant;
