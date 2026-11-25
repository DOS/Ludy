-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #5010, plan L28): the delete trigger also cancels a label suggestion run in flight. The feature `meetings.label_suggest` (the recorder's Vy suggests up to three labels for a meeting from its title
-- and the labels the recorder already reads) starts its run with subject_type 'meeting' and the meeting's id, but the list of those features, last written in 20270324010000 (deal update), does not name it: a run in flight at
-- a deletion would stay open until it expired (at most 30 minutes), and its counts-only result row would stay in member_vy_result. No prose leaks (the row holds counts only), but the run and its row would outlive the
-- meeting, which the rule "a meeting's delete drops its Vy runs and results" does not allow. The runs of the features that take a random subject never name a meeting and need no entry.
-- This is the body of 20270324010000's meeting_discard_transcribe() with ONE change: `meetings.label_suggest` added to the list, in both statements. Signature, owner and search path are as they were;
-- the function is the trigger's and nobody's to call, so it keeps no EXECUTE for any login role. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    UPDATE ludy_kernel.ai_run a SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
    WHERE a.org_id = OLD.org_id AND a.status = 'running'
      AND a.id IN (SELECT v.run_id FROM ludy_kernel.member_vy_result v
                   WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters', 'meetings.title', 'meetings.commitments', 'meetings.followup_note', 'meetings.deal_update', 'meetings.label_suggest') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id)
    RETURNING a.id AS run_id,
              (SELECT v.feature FROM ludy_kernel.member_vy_result v WHERE v.org_id = OLD.org_id AND v.run_id = a.id AND v.subject_type = 'meeting' AND v.subject_id = OLD.id LIMIT 1) AS feature
  LOOP
    INSERT INTO ludy_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (OLD.org_id, 'system', NULL, 'meetings.vy.run_cancelled', ludy_kernel.uuid_v7(), 'ok', 'kernel.ai_run', r.run_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.run_id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('runId', r.run_id, 'meetingId', OLD.id, 'feature', r.feature, 'reason', 'MEETING_REMOVED'));
  END LOOP;
  DELETE FROM ludy_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate', 'meetings.chapters', 'meetings.title', 'meetings.commitments', 'meetings.followup_note', 'meetings.deal_update', 'meetings.label_suggest') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION ludy_meetings.meeting_discard_transcribe() FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.meeting_discard_transcribe() FROM %I', r.rolname);
  END LOOP;
END $$;
