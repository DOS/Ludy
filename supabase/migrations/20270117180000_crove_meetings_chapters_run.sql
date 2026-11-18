-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (#3844, step 3): the recorder's Vy writes the table of contents. No new table (crove_meetings.meeting_chapter is 20270117160000); three restated or replaced objects.
-- 1. crove_meetings.draft_review(uuid, uuid, uuid[]) restated from 20261216100000 (its newest definition) with one addition: the draft chapters among the given ids lose the mark that says the model
--    wrote them, and are counted in the returned integer. Same signature, owner, search_path and grants; it stays the only function that clears a taint (meeting_chapter_taint checks its owner).
--    The foreign-id guard now also covers chapters of another meeting.
-- 2. crove_meetings.meeting_discard_transcribe() restated from 20261231010000 (its newest definition) with meetings.chapters added to both feature lists, so a meeting's removal cancels a chapters run
--    in flight and deletes its private result. The trigger, its audit rows and its grants are unchanged.
-- 3. The title CHECK of meeting_chapter (#3882) takes the character class of the minutes templates (20270109090000): controls, the line and paragraph separators, bidi and zero-width characters, invisible
--    fillers and tag characters, beside CR and LF. Added NOT VALID and validated after a scrub of any title that holds one (none can exist from the commands; the scrub only keeps the validation from failing).
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.draft_review(p_org_id uuid, p_meeting_id uuid, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_results integer := 0;
  v_items integer := 0;
  v_segments integer := 0;
  v_chapters integer := 0;
  v_foreign integer;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting_id) THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- No id the caller names is a row of another meeting of the org (a result, an action item, a transcript segment or a chapter of a meeting that is not this one): refused, never
  -- reviewed. An id that is no row at all (a stale one, for a row a later copy replaced) is ignored as before: that row, if it was replaced, keeps its mark.
  SELECT pg_catalog.count(*) INTO v_foreign FROM (
    SELECT r.id FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id <> p_meeting_id AND r.id = ANY (p_ids)
    UNION ALL
    SELECT i.id FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id <> p_meeting_id AND i.id = ANY (p_ids)
    UNION ALL
    SELECT s.id FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id <> p_meeting_id AND s.id = ANY (p_ids)
    UNION ALL
    SELECT c.id FROM crove_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id <> p_meeting_id AND c.id = ANY (p_ids)
  ) AS k;
  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_meetings.meeting_result SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_results = ROW_COUNT;
  UPDATE crove_meetings.action_item SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  UPDATE crove_meetings.transcript_segment SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_segments = ROW_COUNT;
  -- The chapters (#3844): the one addition.
  UPDATE crove_meetings.meeting_chapter SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_chapters = ROW_COUNT;
  RETURN v_results + v_items + v_segments + v_chapters;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) TO crove_app;

CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    UPDATE crove_kernel.ai_run a SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
    WHERE a.org_id = OLD.org_id AND a.status = 'running'
      AND a.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                   WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id)
    RETURNING a.id AS run_id,
              (SELECT v.feature FROM crove_kernel.member_vy_result v WHERE v.org_id = OLD.org_id AND v.run_id = a.id AND v.subject_type = 'meeting' AND v.subject_id = OLD.id LIMIT 1) AS feature
  LOOP
    INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (OLD.org_id, 'system', NULL, 'meetings.vy.run_cancelled', crove_kernel.uuid_v7(), 'ok', 'kernel.ai_run', r.run_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.run_id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('runId', r.run_id, 'meetingId', OLD.id, 'feature', r.feature, 'reason', 'MEETING_REMOVED'));
  END LOOP;
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- The title CHECK (#3882). A title that holds a character of the class is cleaned first, so the validation below cannot fail on an old row; a title that would be empty becomes a dash.
UPDATE crove_meetings.meeting_chapter
   SET title = COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(title, '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]', '', 'g')), ''), '-')
 WHERE title OPERATOR(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]';
ALTER TABLE crove_meetings.meeting_chapter DROP CONSTRAINT IF EXISTS meeting_chapter_title_check;
ALTER TABLE crove_meetings.meeting_chapter ADD CONSTRAINT meeting_chapter_title_check
  CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 80 AND title OPERATOR(pg_catalog.!~) '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u2800\u3164\ufeff\ufff9-\ufffb\U000e0000-\U000e007f]') NOT VALID;
ALTER TABLE crove_meetings.meeting_chapter VALIDATE CONSTRAINT meeting_chapter_title_check;
