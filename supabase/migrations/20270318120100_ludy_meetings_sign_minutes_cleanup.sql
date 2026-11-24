-- SPDX-License-Identifier: AGPL-3.0-only
-- Synchronize meeting deletion and retention purge with eSign meeting_minutes envelopes (#4531 Step 2 of 2, Owner Decision A2):
-- Before any DELETE on ludy_meetings.meeting (via meetings.meeting.delete, meetings.meeting.owner_delete,
-- meeting_text_purge, or meeting_replay_shred), collect the meeting visibility and reader list before CASCADE
-- removes meeting_reader, then invoke ludy_sign.cleanup_meeting_minutes_envelopes so:
--   - completed envelopes snapshot retained_org_visible / retained_reader_ids and remain legal records,
--   - unsigned / in-flight envelopes are voided and erased.

SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module invokes ludy_sign.cleanup_meeting_minutes_envelopes before CASCADE deletes meeting_reader (#4531).
CREATE OR REPLACE FUNCTION ludy_meetings.cleanup_sign_minutes_on_meeting_delete() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reader_ids uuid[];
BEGIN
  IF pg_catalog.current_setting('ludy.org_purge', true) = OLD.org_id::text THEN
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ludy_sign.envelope e
    WHERE e.org_id = OLD.org_id
      AND e.source_kind = 'meeting_minutes'
      AND e.source_id = OLD.id
  ) THEN
    RETURN OLD;
  END IF;

  v_reader_ids := ARRAY(
    SELECT DISTINCT u.user_id
    FROM (
      SELECT OLD.recorder_user_id AS user_id
      UNION ALL
      SELECT r.user_id
      FROM ludy_meetings.meeting_reader r
      WHERE r.org_id = OLD.org_id
        AND r.meeting_id = OLD.id
    ) u
    WHERE u.user_id IS NOT NULL
    ORDER BY u.user_id
  );

  PERFORM ludy_sign.cleanup_meeting_minutes_envelopes(
    OLD.org_id,
    OLD.id,
    (OLD.visibility = 'org'),
    COALESCE(v_reader_ids, ARRAY[]::uuid[])
  );

  RETURN OLD;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.cleanup_sign_minutes_on_meeting_delete()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS cleanup_sign_minutes_on_meeting_delete ON ludy_meetings.meeting;
CREATE TRIGGER cleanup_sign_minutes_on_meeting_delete
  BEFORE DELETE ON ludy_meetings.meeting
  FOR EACH ROW
  EXECUTE FUNCTION ludy_meetings.cleanup_sign_minutes_on_meeting_delete();
