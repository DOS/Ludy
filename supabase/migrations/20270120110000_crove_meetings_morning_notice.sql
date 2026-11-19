-- SPDX-License-Identifier: AGPL-3.0-only
-- The opt-in morning notice of the day's meetings (#3955, part B). A member who turns it on gets, once a day at the time they chose (in their own time zone), one in-app notice and one mail that say only
-- how many meetings they have today and link to the meetings page: no title, no name, no word of a brief. Nothing runs Vy.
--
-- crove_meetings.morning_notice: one row per member who turned the notice on (no row, no notice). Private to its member: the row policies show and change a member's own row only, in a user context; the
--   owner, an admin, another member, an agent and the system context read none of it.
-- crove_meetings.morning_notices_due: the worker's sweep. The system context cannot read calendar_agenda (its row policy is a user's own rows), so this worker-only definer is the one place that joins the
--   opt-in rows with the agenda: it returns, for the members whose chosen time has come today (in their zone) and has not gone by more than six hours, the Vietnam-or-own-zone day and the COUNT of their events
--   that start that day on a calendar that reads events, and nothing else (no title, no time, no id of an event). It leaves out a member who left the org, an org with Meetings off, a member who muted the
--   kind and a member already told for that day (the notice's own key, 'morning:<day>', which is also what makes a second dispatch write nothing).
-- Queue: meetings-morning, the sweep's job (it reaches no address; the mail is sent by the mail queues).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.morning_notice (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  -- Minutes after midnight in time_zone: 420 is 07:00.
  send_minute smallint NOT NULL DEFAULT 420 CHECK (send_minute BETWEEN 0 AND 1439),
  -- An IANA name from the member's browser (Asia/Ho_Chi_Minh by default); a name the database does not know is simply never due.
  time_zone text NOT NULL CHECK (pg_catalog.char_length(time_zone) BETWEEN 1 AND 64),
  language text NOT NULL DEFAULT 'vi' CHECK (language ~ '^[a-z]{2}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT morning_notice_user_uq UNIQUE (org_id, user_id)
);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.morning_notice');

DROP POLICY IF EXISTS morning_notice_own ON crove_meetings.morning_notice;
CREATE POLICY morning_notice_own ON crove_meetings.morning_notice AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id())
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND user_id = crove_kernel.ctx_user_id());

CREATE OR REPLACE FUNCTION crove_meetings.morning_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, events integer, english boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH known AS MATERIALIZED (
    -- Only zones the database knows, decided before any time is computed in them: a name it does not know would otherwise fail the whole pass (the planner may compute the local time before it filters).
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language
    FROM crove_meetings.morning_notice n
    WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND n.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z)
  ),
  local AS (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language, pg_catalog.now() AT TIME ZONE n.time_zone AS local_now
    FROM known n
    WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = n.org_id AND m.user_id = n.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      AND crove_kernel.org_app_on(n.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM crove_kernel.notification_mute x
        WHERE x.org_id = n.org_id AND x.user_id = n.user_id AND x.kind = 'meetings.morning'
      )
  ),
  due AS (
    SELECT l.org_id, l.user_id, l.time_zone, l.language, l.local_now::date AS day
    FROM local l
    WHERE (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer >= l.send_minute
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer < l.send_minute + 360
      AND (p_day IS NULL OR l.local_now::date = p_day)
  )
  SELECT d.org_id, d.user_id, d.day, pg_catalog.count(*)::integer, (d.language OPERATOR(pg_catalog.=) 'en')
  FROM due d
  JOIN crove_meetings.calendar_agenda a
    ON a.org_id = d.org_id AND a.user_id = d.user_id
   AND a.starts_at >= (d.day::timestamp AT TIME ZONE d.time_zone)
   AND a.starts_at < ((d.day + 1)::timestamp AT TIME ZONE d.time_zone)
  JOIN crove_kernel.calendar_connection c
    ON c.org_id = a.org_id AND c.id = a.connection_id AND c.status = 'active' AND c.read_events
  WHERE NOT EXISTS (
    SELECT 1 FROM crove_kernel.notification x
    WHERE x.org_id = d.org_id AND x.user_id = d.user_id AND x.dedupe_key = 'morning:' || d.day::text
  )
  GROUP BY d.org_id, d.user_id, d.day, d.language
  ORDER BY d.org_id, d.user_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
REVOKE ALL ON FUNCTION crove_meetings.morning_notices_due(integer, uuid, uuid, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.morning_notices_due(integer, uuid, uuid, date) TO crove_worker;

SELECT crove_jobs.create_queue('meetings-morning', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
