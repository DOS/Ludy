-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #4536, from the independent security review of #3824): the wake-up for published minutes checks, when the worker runs the job, that the meeting is still one the minutes may
-- be announced for. The org-visibility test ran only at publish (modules/meetings/src/results.ts) and the job can run up to 24 hours later: a recorder who publishes the minutes of an org-visible meeting
-- and then narrows it to attendees only, deletes it, or lets its text period end before the job runs still had its id sent to every company grant of the org.
-- ludy_meetings.minutes_wake_open(org, meeting, now) answers one boolean: the meeting exists, its visibility is 'org', and its text retention day has not been reached on the Vietnam calendar day of `now`
-- (the day the text is shredded counts as ended, as openMeeting in modules/meetings/src/transcript.ts reads it; a meeting with no text day is open). Nothing else leaves it: no title, no row, no id the
-- caller did not give. The worker's login alone may call it (kernel.mcp.wake.minutes_targets, packages/kernel/src/mcp-wake.ts, runs as the worker), as the other definers the worker's jobs read through.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.minutes_wake_open(p_org uuid, p_meeting uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM ludy_meetings.meeting m
    WHERE m.org_id = p_org
      AND m.id = p_meeting
      AND m.visibility = 'org'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > ((p_now AT TIME ZONE 'UTC') + interval '7 hours')::date)
  )
$$;

REVOKE ALL ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) TO ludy_worker;
