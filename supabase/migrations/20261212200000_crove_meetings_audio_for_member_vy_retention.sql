-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, M4b review follow-ups (#2863 item 1): crove_meetings.audio_for_member_vy, restated in full from 20261202000000 (same signature, owner and grants; the
-- applied file is not edited) with one more refusal: the meeting's audio_retention_date. Once it is reached the audio is due to be shredded, and the nightly shred may not
-- have run yet; the background run of the recorder's Vy no longer reads the audio in that window (fixed code MEETINGS_AUDIO_EXPIRED, 42501; the kernel command maps it to
-- the same FORBIDDEN as every other refusal of the door). Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.audio_for_member_vy(p_org_id uuid, p_meeting_id uuid)
RETURNS TABLE (
  segment_order integer,
  start_offset_seconds integer,
  length_seconds integer,
  file_id uuid,
  is_english boolean,
  key_id text,
  wrapped_key bytea
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_agent uuid := crove_kernel.ctx_agent_id();
  v_run uuid := crove_kernel.ctx_run_id();
  v_member uuid;
  v_key_id text;
  v_wrapped bytea;
  v_english boolean;
  v_audio_until date;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_agent IS NULL OR v_run IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- The agent must be a member's Vy and active; its member is the one the run acts for.
  SELECT a.member_user_id INTO v_member
  FROM crove_kernel.agent a
  WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active';
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- The run is live and is this agent's; its result row waits and names this meeting for this feature.
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.ai_run r
    JOIN crove_kernel.member_vy_result v ON v.org_id = r.org_id AND v.run_id = r.id
    WHERE r.org_id = v_org AND r.id = v_run AND r.agent_id = v_agent AND r.status = 'running' AND r.expires_at > pg_catalog.now()
      AND v.member_user_id = v_member AND v.status = 'running' AND v.feature = 'meetings.transcribe'
      AND v.subject_type = 'meeting' AND v.subject_id = p_meeting_id
  ) THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- The org is active, and the member is active now (still a member of an acting role with an enabled account and vy.use).
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active')
     OR NOT crove_kernel.member_vy_member_active(v_org, v_member) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  -- The member reads this meeting under the rule media_key_read applies to a user: the recorder reads their own meeting while they hold a base role of owner,
  -- admin or member (is_meeting_reader itself answers for a user context only, so its recorder branch is repeated here). A demotion to viewer mid-run means refuse.
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_member AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  SELECT m.language = 'en', m.audio_retention_date INTO v_english, v_audio_until
  FROM crove_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id AND m.recorder_user_id = v_member
    AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  -- The audio's own retention date (#2863 item 1): past it the audio is due to be shredded, and the nightly shred may not have run yet. media_key_read does not
  -- check it for a user either (the window is the one between the date and the shred); a background run must not widen it, so it stops at the date.
  IF v_audio_until IS NOT NULL AND v_audio_until <= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'MEETINGS_AUDIO_EXPIRED' USING ERRCODE = '42501';
  END IF;
  SELECT k.key_id, k.wrapped_key INTO v_key_id, v_wrapped
  FROM crove_meetings.media_key k
  WHERE k.org_id = v_org AND k.meeting_id = p_meeting_id AND k.kind = 'audio';
  IF v_key_id IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_KEY_SHREDDED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.segment_order, s.start_offset_seconds, s.length_seconds, s.file_id, v_english, v_key_id, v_wrapped
  FROM crove_meetings.audio_segment s
  WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id
  ORDER BY s.segment_order;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.audio_for_member_vy(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.audio_for_member_vy(uuid, uuid) TO crove_worker;
