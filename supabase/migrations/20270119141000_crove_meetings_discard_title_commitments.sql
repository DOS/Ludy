-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #3951, a follow-up of #3947 and #3954): the delete trigger also cancels a title run and a commitments run in flight. The recorder's Vy runs that bind to one
-- meeting (the subject of the run is the meeting) are cancelled when the meeting is removed, and their private result row is deleted with it; the list of those features was written
-- before the title suggestion (meetings.title) and the commitments list (meetings.commitments) existed, so a run of theirs in flight at a deletion stayed open until it expired. The result row
-- of those two holds counts only (never a title or a line), so nothing leaked, but the run and its row outlived the meeting. The runs of the other Meetings features (ask, brief, digest,
-- assignee, adherence) take a random subject and never name a meeting, so they are not in the list and need nothing here.
-- This is the body of 20270117210000's crove_meetings.meeting_discard_transcribe() with one change: the two features added to the list, in both statements. Signature, owner, search path
-- and grants are as they were. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    UPDATE crove_kernel.ai_run a SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
    WHERE a.org_id = OLD.org_id AND a.status = 'running'
      AND a.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                   WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters', 'meetings.title', 'meetings.commitments') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id)
    RETURNING a.id AS run_id,
              (SELECT v.feature FROM crove_kernel.member_vy_result v WHERE v.org_id = OLD.org_id AND v.run_id = a.id AND v.subject_type = 'meeting' AND v.subject_id = OLD.id LIMIT 1) AS feature
  LOOP
    INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (OLD.org_id, 'system', NULL, 'meetings.vy.run_cancelled', crove_kernel.uuid_v7(), 'ok', 'kernel.ai_run', r.run_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.run_id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('runId', r.run_id, 'meetingId', OLD.id, 'feature', r.feature, 'reason', 'MEETING_REMOVED'));
  END LOOP;
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters', 'meetings.title', 'meetings.commitments') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
