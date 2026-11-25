-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #4899, ADR-0047 point 3): the recorder's publish shares the transcript lines too. Idempotent; applied files stay untouched.
--
-- Until now nothing moved a transcript line to `published`: 20261127300000 grants the tenant role UPDATE on (text, speaker_label, corrected, updated_at) only, and its row policies let it update and delete
-- DRAFT lines alone, with a check that the row is still a draft afterwards, so no command could flip a line, nor replace the lines of an earlier publish. Readers of a meeting read published lines only
-- (transcript_segment_read), so a reader who was not the recorder saw no line of any transcript. The migration of 20261216100000 already says "a draft that is still tainted is never published ... this
-- holds for the one that will": this is that one.
--
-- ludy_meetings.transcript_publish(org, meeting)
--   The recorder's own publish, called by meetings.result.publish in the recorder's user context (the same context rules as draft_review: the org of the transaction, a signed-in user, the meeting's
--   recorder). The draft lines of the meeting are locked first (the nightly expiry then waits for this publish, or has already deleted them, and then the lines published before are not replaced by
--   nothing); with none it answers 0 and touches nothing. Otherwise a draft line that is still tainted (the model's, unread: draft_review clears the mark) refuses the whole publish
--   (MEETINGS_DRAFT_NOT_REVIEWED); else the lines published before are deleted (one published transcript a meeting, as for the summary and the chapters) and the draft lines become published, and it
--   answers how many. Nothing else changes: the text, the order, the labels and the marks of a line are the same, and the triggers of the table (the taint rules, the drop of a private translation of
--   a transcript that a stage change makes stale) run as for any other stage change. A definer, as draft_review is: the tenant role may not set `stage` or delete a published line.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.transcript_publish(p_org_id uuid, p_meeting_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_moved integer;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_PUBLISH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT ludy_meetings.is_meeting_recorder(v_org, p_meeting_id) THEN
    RAISE EXCEPTION 'MEETINGS_PUBLISH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The meeting row first, then its lines: the order the erasure and a meeting's delete take (defence in depth; the command holds it too, before it calls this).
  PERFORM 1 FROM ludy_meetings.meeting WHERE org_id = v_org AND id = p_meeting_id FOR NO KEY UPDATE;
  PERFORM 1 FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id AND s.stage = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF EXISTS (SELECT 1 FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id AND s.stage = 'draft' AND s.tainted) THEN
    RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
  END IF;
  DELETE FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id AND s.stage = 'published';
  UPDATE ludy_meetings.transcript_segment s SET stage = 'published', updated_at = pg_catalog.now()
  WHERE s.org_id = v_org AND s.meeting_id = p_meeting_id AND s.stage = 'draft';
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION ludy_meetings.transcript_publish(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.transcript_publish(uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.transcript_publish(uuid, uuid) TO ludy_app;
