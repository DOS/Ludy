-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings L4a-2 (issue #3110, ADR-0052 decision 2, ADR-0049 stage B): the live transcript preview and the running notes of a meeting being
-- recorded. The pieces of #3109 are transcribed by the recorder's own Vy, window by window; the text lands in the recorder's own Vy result and the
-- recorder's own command copies it here. Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.live_line: one line of the preview ("Bản nháp trực tiếp"). The recorder's alone, like crove_meetings.live_chunk: no reader, no
--    attendee, no owner and no system context reads it. Replaced by the batch transcript and deleted with the meeting.
-- 2. crove_meetings.live_for_member_vy(org, meeting, after_seq, limit): the door of a live notes run, modelled on audio_for_member_vy of
--    20261202000000 with the same checks, for the feature meetings.live_notes and the live pieces: each piece's order, length, file and its own
--    live:<seq> key. Worker login inside the member's sealed context only.
-- 3. crove_meetings.member_vy_media_files() restated from 20261203030000 with one addition: a live notes run reads the file rows of the live pieces
--    of its own meeting, as a transcribe run reads the audio segments of its one meeting. The file policy of 20261203030100 is unchanged.
-- 4. crove_meetings.meeting_discard_transcribe() restated from 20261203100000 with the features meetings.live_notes and meetings.live_summary added, so a meeting's removal
--    cancels a live notes run and deletes its result as it does for transcribe and summary.
-- 5. crove_meetings.meeting_result.feature takes 'meetings.live_notes': the running notes are ordinary draft rows of the recorder, so the accept and
--    publish paths, the 5.3 checks and the taint rules already built apply to them unchanged.
SET LOCAL lock_timeout = '2s';

-- The queue of the live notes windows: one job per window the recorder's tick started (ids and the window's bounds only), never retried by the queue.
SELECT crove_jobs.create_queue('meetings-live-notes', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);

-- ---------------------------------------------------------------------------
-- 1. The preview lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.live_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0 AND seq < 100000),
  start_seconds integer NOT NULL CHECK (start_seconds >= 0),
  end_seconds integer NOT NULL CHECK (end_seconds >= 0),
  -- '' is a silent piece: it marks how far the preview has read (so a silence is not transcribed again) and is never shown.
  text text NOT NULL CHECK (pg_catalog.length(text) BETWEEN 0 AND 4000),
  -- The model's words (a transcription of untrusted audio): tainted for as long as the line exists, and never shown to anyone but the recorder; there is no review that clears it
  -- (the preview is replaced by the batch transcript, never published). The run it was copied from is the taint's source (ADR-0049 decision 4); nullable so a line outlives its run row.
  tainted boolean NOT NULL DEFAULT true CHECK (tainted),
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT live_line_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT live_line_seq_uq UNIQUE (org_id, meeting_id, seq),
  CONSTRAINT live_line_order_ck CHECK (end_seconds >= start_seconds)
);
CREATE INDEX IF NOT EXISTS live_line_meeting_idx ON crove_meetings.live_line (org_id, meeting_id, seq);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.live_line');
REVOKE UPDATE ON crove_meetings.live_line FROM crove_tenant;

-- Only the recorder, and only in a user context: is_meeting_recorder answers false for an agent context (a member Vy run included) and for the system.
DROP POLICY IF EXISTS live_line_read ON crove_meetings.live_line;
CREATE POLICY live_line_read ON crove_meetings.live_line AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

DROP POLICY IF EXISTS live_line_insert ON crove_meetings.live_line;
CREATE POLICY live_line_insert ON crove_meetings.live_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_meetings.is_meeting_recorder(org_id, meeting_id));

DROP POLICY IF EXISTS live_line_delete ON crove_meetings.live_line;
CREATE POLICY live_line_delete ON crove_meetings.live_line AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- 2. The door of a live notes run
-- ---------------------------------------------------------------------------
-- The pieces of one meeting a live notes run may read, after a given order, oldest first. Every check of audio_for_member_vy, for this feature: the
-- worker login, the sealed agent context, the agent being this member's active Vy, the run live and its result row waiting for THIS meeting and
-- feature, the org active, the member active and still of an acting role, the meeting the member's own and not past its text date. Each piece
-- carries its own key (media_key kind live:<seq>, #3109), so a piece whose key is shredded is left out instead of failing the whole window.
CREATE OR REPLACE FUNCTION crove_meetings.live_for_member_vy(
  p_org_id uuid,
  p_meeting_id uuid,
  p_after_seq integer,
  p_limit integer
)
RETURNS TABLE (
  seq integer,
  length_seconds integer,
  start_offset_seconds integer,
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
  v_english boolean;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_agent IS NULL OR v_run IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT a.member_user_id INTO v_member
  FROM crove_kernel.agent a
  WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active';
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.ai_run r
    JOIN crove_kernel.member_vy_result v ON v.org_id = r.org_id AND v.run_id = r.id
    WHERE r.org_id = v_org AND r.id = v_run AND r.agent_id = v_agent AND r.status = 'running' AND r.expires_at > pg_catalog.now()
      AND v.member_user_id = v_member AND v.status = 'running' AND v.feature = 'meetings.live_notes'
      AND v.subject_type = 'meeting' AND v.subject_id = p_meeting_id
  ) THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active')
     OR NOT crove_kernel.member_vy_member_active(v_org, v_member) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_member AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;
  SELECT m.language = 'en' INTO v_english
  FROM crove_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id AND m.recorder_user_id = v_member AND m.live_notes
    AND m.audio_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETINGS_NOT_RECORDER' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- start_offset_seconds: where the piece begins in the recording, the sum of the lengths of the pieces before it (the recorder's own clock, never measured).
  SELECT c.seq, c.length_seconds,
         (SELECT COALESCE(SUM(x.length_seconds), 0)::integer FROM crove_meetings.live_chunk x WHERE x.org_id = c.org_id AND x.meeting_id = c.meeting_id AND x.seq < c.seq),
         c.file_id, v_english, k.key_id, k.wrapped_key
  FROM crove_meetings.live_chunk c
  JOIN crove_meetings.media_key k ON k.org_id = c.org_id AND k.meeting_id = c.meeting_id AND k.kind = 'live:' OPERATOR(pg_catalog.||) c.seq::text
  WHERE c.org_id = v_org AND c.meeting_id = p_meeting_id AND c.seq > p_after_seq
  ORDER BY c.seq
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.live_for_member_vy(uuid, uuid, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.live_for_member_vy(uuid, uuid, integer, integer) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 3. The file rows a run may read: the audio segments of a transcribe run, the live pieces of a live notes run
-- ---------------------------------------------------------------------------
-- Restated from 20261203030000 (the only migration that defines it) with one addition: when the waiting result row is a live notes one, the files are
-- the live pieces of that meeting instead of its audio segments. Everything else, the order of the checks included, is unchanged, and the function
-- still never raises, writes or audits. The file table's policy (20261203030100) calls it once per statement and is untouched.
CREATE OR REPLACE FUNCTION crove_meetings.member_vy_media_files()
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_agent uuid;
  v_run uuid;
  v_meeting uuid;
  v_feature text;
BEGIN
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_org IS NULL THEN
    RETURN;
  END IF;
  v_agent := crove_kernel.ctx_agent_id();
  v_run := crove_kernel.ctx_run_id();
  IF v_agent IS NULL OR v_run IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.agent a
    WHERE a.org_id = v_org AND a.id = v_agent AND a.kind = 'member_vy' AND a.status = 'active'
  ) THEN
    RETURN;
  END IF;
  SELECT v.subject_id, v.feature INTO v_meeting, v_feature
  FROM crove_kernel.member_vy_result v
  WHERE v.org_id = v_org AND v.run_id = v_run AND v.feature IN ('meetings.transcribe', 'meetings.live_notes') AND v.subject_type = 'meeting' AND v.status = 'running'
  ORDER BY v.created_at, v.id
  LIMIT 1;
  IF v_meeting IS NULL THEN
    RETURN;
  END IF;
  IF v_feature = 'meetings.live_notes' THEN
    PERFORM 1 FROM crove_meetings.live_for_member_vy(v_org, v_meeting, -1, 1) LIMIT 1;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    RETURN QUERY
      SELECT c.file_id FROM crove_meetings.live_chunk c WHERE c.org_id = v_org AND c.meeting_id = v_meeting ORDER BY c.seq;
    RETURN;
  END IF;
  PERFORM 1 FROM crove_meetings.audio_for_member_vy(v_org, v_meeting) LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT s.file_id FROM crove_meetings.audio_segment s WHERE s.org_id = v_org AND s.meeting_id = v_meeting ORDER BY s.segment_order;
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.member_vy_media_files() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.member_vy_media_files() TO crove_tenant;

-- ---------------------------------------------------------------------------
-- 4. A meeting's removal reaches its live notes run too
-- ---------------------------------------------------------------------------
-- Restated from 20261203100000 (the newest definition) with one change: the feature list gains meetings.live_notes and meetings.live_summary. The trigger itself is unchanged.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_kernel.ai_run r SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
  WHERE r.org_id = OLD.org_id AND r.status = 'running'
    AND r.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                 WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id);
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 5. The running notes are draft rows of the recorder, written under their own feature
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.meeting_result DROP CONSTRAINT IF EXISTS meeting_result_feature_check;
ALTER TABLE crove_meetings.meeting_result ADD CONSTRAINT meeting_result_feature_check CHECK (feature IN ('manual', 'meetings.summary', 'meetings.live_notes'));
