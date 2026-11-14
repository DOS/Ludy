-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings E2 (issue #3185, plan docs/plan/meetings-integrations.md section 7a, ADR-0049 stage B): the machine translation of a meeting's transcript. The member's own Vy,
-- in a background run over bounded chunks of segments, translates the transcript text that member reads (published lines for a reader, the draft for the recorder); the member's own
-- copy command keeps the checked parts in the private translation row E1 made (#3184). Owner decision of 2026-11-14: a translation is private to the member who asked for it.
-- Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.translation.kind takes 'transcript': one row per member, meeting, target language and source stage, holding every translated part kept so far (the row's own policies,
--    unchanged, already say: the member who asked reads, writes and deletes it, in a user context, for a stage they still read).
-- 2. crove_meetings.transcript_for_member_vy(uuid, uuid, text): the door through which the run reads the text (the one SECURITY DEFINER function of crove_meetings that returns meeting text, and only
--    the text of the lines: no speaker, no time; the readers invariant names it and its exact result). The pattern of audio_for_member_vy (#2578) and live_for_member_vy (#3110):
--    worker login only, the run's own context, the run's waiting result row naming this meeting for the feature meetings.translate, the org active, the member active, and the member
--    reading the stage asked for (the recorder for a draft; the recorder, a listed reader or, for an org meeting, a member of full scope for the published lines) and the meeting inside
--    its text period. It answers the lines of that stage and never anything else; the kernel command that calls it (kernel.member_vy.meeting_audio.open, mode text) audits ids and a count.
-- 3. translation_drop_transcript: when a transcript line of a stage is deleted (a replaced or expired draft, a meeting's removal) or changes stage, the transcript translations of that
--    stage are deleted with it, every member's: nothing translated outlives the text it translated. A corrected line is not deleted: each stored part carries the hash of the line it
--    translated, so the read shows that part as "Bản dịch cũ" when the line changed.
-- 4. translation_drop_stale (E1, 20261231010000) restated with the kind it serves: a summary replaced or published drops the translations of the SUMMARY of that stage only, never a
--    member's transcript translations (those are dropped by their own lines, section 3).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The transcript kind
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.translation DROP CONSTRAINT IF EXISTS translation_kind_check;
ALTER TABLE crove_meetings.translation ADD CONSTRAINT translation_kind_check CHECK (kind IN ('summary', 'transcript'));

-- ---------------------------------------------------------------------------
-- 2. The door: the transcript lines of one stage a translation run may read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_meetings.transcript_for_member_vy(p_org_id uuid, p_meeting_id uuid, p_stage text)
RETURNS TABLE (
  segment_id uuid,
  line_text text,
  is_english boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_agent uuid := crove_kernel.ctx_agent_id();
  v_run uuid := crove_kernel.ctx_run_id();
  v_member uuid;
  v_english boolean;
  v_visibility text;
  v_recorder uuid;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_agent IS NULL OR v_run IS NULL
     OR p_stage NOT IN ('draft', 'published') THEN
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
      AND v.member_user_id = v_member AND v.status = 'running' AND v.feature = 'meetings.translate'
      AND v.subject_type = 'meeting' AND v.subject_id = p_meeting_id
  ) THEN
    RAISE EXCEPTION 'MEETINGS_RUN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- The org is active, and the member is active now (still a member of an acting role with an enabled account and vy.use).
  IF NOT EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org AND t.status = 'active')
     OR NOT crove_kernel.member_vy_member_active(v_org, v_member)
     OR NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = v_member AND m.role IN ('owner', 'admin', 'member')) THEN
    RAISE EXCEPTION 'MEETINGS_NOT_READER' USING ERRCODE = '42501';
  END IF;
  -- The meeting is inside its text period (as every read of its text is).
  SELECT m.language = 'en', m.visibility, m.recorder_user_id INTO v_english, v_visibility, v_recorder
  FROM crove_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id
    AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETINGS_NOT_READER' USING ERRCODE = '42501';
  END IF;
  -- The member reads this stage under the rule of transcript_segment_read, which answers for a user context only (so its branches are repeated here): the recorder reads every stage of
  -- their own meeting, a reader of the meeting reads the published lines only. A reader is a listed one or, for an org meeting, a member of full scope; a draft is the recorder's alone.
  IF v_recorder IS DISTINCT FROM v_member THEN
    IF p_stage = 'draft' THEN
      RAISE EXCEPTION 'MEETINGS_NOT_READER' USING ERRCODE = '42501';
    END IF;
    IF NOT (EXISTS (SELECT 1 FROM crove_meetings.meeting_reader r WHERE r.org_id = v_org AND r.meeting_id = p_meeting_id AND r.user_id = v_member)
            OR (v_visibility = 'org' AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))) THEN
      RAISE EXCEPTION 'MEETINGS_NOT_READER' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
  SELECT s.id, s.text, v_english
  FROM crove_meetings.transcript_segment s
  WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id AND s.stage = p_stage
  ORDER BY s.start_seconds, s.id
  LIMIT 5000;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.transcript_for_member_vy(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.transcript_for_member_vy(uuid, uuid, text) TO crove_worker;

-- ---------------------------------------------------------------------------
-- 3. A transcript translation never outlives the lines it translated
-- ---------------------------------------------------------------------------
-- A definer, because the line that is deleted is the recorder's and the translations dropped are other members'. It deletes by meeting and stage only and returns nothing.
CREATE OR REPLACE FUNCTION crove_meetings.translation_drop_transcript() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'transcript' AND t.source_stage = OLD.stage;
  ELSE
    -- A stage change (a draft published): the translations of the stage it left and of the stage it joins.
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'transcript' AND t.source_stage IN (OLD.stage, NEW.stage);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.translation_drop_transcript() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS transcript_segment_translation_drop ON crove_meetings.transcript_segment;
CREATE TRIGGER transcript_segment_translation_drop AFTER DELETE ON crove_meetings.transcript_segment
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.translation_drop_transcript();
DROP TRIGGER IF EXISTS transcript_segment_translation_stage ON crove_meetings.transcript_segment;
CREATE TRIGGER transcript_segment_translation_stage AFTER UPDATE OF stage ON crove_meetings.transcript_segment
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.translation_drop_transcript();

-- ---------------------------------------------------------------------------
-- 4. E1's drop of stale summary translations names its kind
-- ---------------------------------------------------------------------------
-- Restated from 20261231010000 with one change: the deletes name kind = 'summary'. Same signature, owner, search_path and grants; the triggers that call it are unchanged.
CREATE OR REPLACE FUNCTION crove_meetings.translation_drop_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'summary' AND t.source_stage = OLD.stage;
  ELSE
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'summary' AND t.source_stage IN (OLD.stage, NEW.stage);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.translation_drop_stale() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
