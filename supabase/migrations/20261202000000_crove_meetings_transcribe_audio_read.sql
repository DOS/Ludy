-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2578, M4b, ADR-0049 decision 8, ADR-0047 point 3): how the recorder's background Vy reads the recorder's own recording.
-- Idempotent; applied files stay untouched.
--   crove_meetings.audio_for_member_vy(org, meeting)
--       The one read door a member-scoped run has on a meeting table. It answers the audio segments of ONE meeting (the file ids, the order, the
--       offsets and lengths, whether the language is English) and the wrapped media key, never plaintext and no text: the file rows (a file row is
--       visible to every member) are read by the caller by those ids, and the bytes are fetched and decrypted by the worker. It answers only when all
--       of these hold, each read here and none taken from the caller:
--         - the caller is the worker login, in the sealed context of a member-scoped agent (actor 'agent'); the run is the context's own run;
--         - the run is running and not expired, belongs to a member_vy agent that is active, and its result row (still running) names this
--           meeting as its subject, for the feature meetings.transcribe;
--         - the org is active; the agent's member is the meeting's recorder, is active now (member_vy_member_active: a member, an acting role, an enabled
--           account, vy.use) and holds the base role that lets a recorder read their meeting (the rule media_key_read applies to a user); the meeting's text period has not ended;
--         - the audio key has not been shredded.
--       Anything else is refused with 42501 and a fixed code. One meeting per call; there is no list form. The sealed member is never read here:
--       the member is the agent row's (the invariant suite pins that nothing but the pinned policies reads the seal).
--       The read is audited by the command that calls it (kernel.member_vy.meeting_audio.open, ids only).
--   the queue meetings-transcribe: one job per run the recorder starts (ids only: org, meeting, run, the recorder's Vy).
SET LOCAL lock_timeout = '2s';

SELECT crove_jobs.create_queue('meetings-transcribe', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);

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
  SELECT m.language = 'en' INTO v_english
  FROM crove_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id AND m.recorder_user_id = v_member
    AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
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

-- A meeting's removal reaches the transcription that was made from it (ADR-0047 point 7: erasure reaches every copy the org controls).
--   crove_meetings.meeting_discard_transcribe()   BEFORE DELETE on a meeting, whatever deletes it (the recorder, an owner's compliance delete, the text
--                                                 purge, a shred replay): the live meetings.transcribe runs for that meeting are cancelled (MEETING_REMOVED,
--                                                 so the worker's next entry is refused) and their member_vy_result rows are deleted, a finished result that was
--                                                 never copied included. The run is locked first and then its result, the order the cancel definer takes.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_kernel.ai_run r SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
  WHERE r.org_id = OLD.org_id AND r.status = 'running'
    AND r.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                 WHERE v.org_id = OLD.org_id AND v.feature = 'meetings.transcribe' AND v.subject_type = 'meeting' AND v.subject_id = OLD.id);
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature = 'meetings.transcribe' AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS meeting_discard_transcribe ON crove_meetings.meeting;
CREATE TRIGGER meeting_discard_transcribe BEFORE DELETE ON crove_meetings.meeting
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_discard_transcribe();
