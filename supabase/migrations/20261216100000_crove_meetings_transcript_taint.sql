-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, #2941 (ADR-0049 decision 4, ADR-0047 point 8): the transcript the recorder copies from a Vy result is the model's text, so its rows carry the same taint
-- as the summary and the action items of 20261203100000. Idempotent; applied files stay untouched.
--   transcript_segment.tainted, transcript_segment.source_run_id
--       tainted: true while the text is the model's and nobody has reviewed it; source_run_id: the Vy run the row was copied from (null for what the recorder typed).
--   crove_meetings.transcript_segment_taint()
--       BEFORE INSERT OR UPDATE trigger, the rules of meeting_result_taint: a row is born tainted only by an insert (the recorder's copy of a Vy result), and a published
--       row is never inserted tainted; no update ever sets `tainted`, and only draft_review (compared by the owner of that function, as in 20261203100000) clears it;
--       source_run_id never changes after the insert, for anybody. A correction of the text or the label leaves the row tainted. A draft that is still tainted is
--       never published, whoever asks (no command publishes a transcript today; this holds for the one that will).
--   backfill
--       every existing DRAFT segment is marked tainted (a draft copied from a Vy result before this migration would otherwise look reviewed); the recorder clears the mark by
--       reading the transcript (meetings.draft.review). Published segments are not touched.
--   tainted column grant
--       crove_tenant has no UPDATE on `tainted` or `source_run_id` at all (the column grant of 20261127300000 never named them; this states it).
--   crove_meetings.draft_review(org, meeting, ids)
--       restated in full from 20261203100000 (same signature, owner and grants), now also for transcript segments, and it refuses an id that is a row of ANOTHER meeting of the
--       org (a result, an action item or a transcript segment); an id that is no row at all (a stale one) is ignored as before.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment ADD COLUMN IF NOT EXISTS tainted boolean NOT NULL DEFAULT false;
ALTER TABLE crove_meetings.transcript_segment ADD COLUMN IF NOT EXISTS source_run_id uuid;
REVOKE UPDATE (tainted, source_run_id) ON crove_meetings.transcript_segment FROM crove_tenant;

CREATE OR REPLACE FUNCTION crove_meetings.transcript_segment_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage = 'published' AND NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_run_id IS DISTINCT FROM OLD.source_run_id THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.tainted IS DISTINCT FROM OLD.tainted AND (NEW.tainted OR current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_meetings.draft_review(uuid,uuid,uuid[])'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF OLD.stage = 'draft' AND NEW.stage = 'published' AND NEW.tainted THEN
    RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.transcript_segment_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS transcript_segment_taint ON crove_meetings.transcript_segment;
-- Backfill: a draft segment that exists now may have been copied from a Vy result before the marks existed, so every draft is marked as the model's text until the recorder
-- has read it (the same review as for a summary). Run with the trigger dropped (above) and before it is created (below), so it blocks nothing; published segments are
-- untouched; and the WHERE makes a second run change nothing that is already marked.
UPDATE crove_meetings.transcript_segment SET tainted = true WHERE stage = 'draft' AND NOT tainted;
CREATE TRIGGER transcript_segment_taint BEFORE INSERT OR UPDATE ON crove_meetings.transcript_segment
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.transcript_segment_taint();

CREATE OR REPLACE FUNCTION crove_meetings.draft_review(p_org_id uuid, p_meeting_id uuid, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_results integer := 0;
  v_items integer := 0;
  v_segments integer := 0;
  v_foreign integer;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting_id) THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- No id the caller names is a row of another meeting of the org (a result, an action item or a transcript segment of a meeting that is not this one): refused, never
  -- reviewed. An id that is no row at all (a stale one, for a row a later copy replaced) is ignored as before: that row, if it was replaced, keeps its mark.
  SELECT pg_catalog.count(*) INTO v_foreign FROM (
    SELECT r.id FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id <> p_meeting_id AND r.id = ANY (p_ids)
    UNION ALL
    SELECT i.id FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id <> p_meeting_id AND i.id = ANY (p_ids)
    UNION ALL
    SELECT s.id FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id <> p_meeting_id AND s.id = ANY (p_ids)
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
  RETURN v_results + v_items + v_segments;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) TO crove_app;
