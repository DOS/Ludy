-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #2863, items 5 and 10): the delete trigger audits each live run it cancels. Until now only the delete command was audited, and its row names the
-- meeting, so the run a deletion stopped (a transcription or a summary the recorder's Vy was working on) left no row of its own. Idempotent; applied files stay untouched.
-- This is the body of 20261203100000's crove_meetings.meeting_discard_transcribe() with one change: the cancelled runs are returned and one audit row is written for each,
-- as the system, naming the run, the meeting and the feature (ids only: no title, no text). In a user context (the recorder's own delete, the owner's compliance delete)
-- the audit stamp trigger names the acting member on the row, as it does for every audit row written there; a system context adds its worker instance. Signature, owner,
-- search path and grants are as they were.
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
                   WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id)
    RETURNING a.id AS run_id,
              (SELECT v.feature FROM crove_kernel.member_vy_result v WHERE v.org_id = OLD.org_id AND v.run_id = a.id AND v.subject_type = 'meeting' AND v.subject_id = OLD.id LIMIT 1) AS feature
  LOOP
    INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (OLD.org_id, 'system', NULL, 'meetings.vy.run_cancelled', crove_kernel.uuid_v7(), 'ok', 'kernel.ai_run', r.run_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.run_id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('runId', r.run_id, 'meetingId', OLD.id, 'feature', r.feature, 'reason', 'MEETING_REMOVED'));
  END LOOP;
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
