-- SPDX-License-Identifier: AGPL-3.0-only
-- Follow-up of the morning notice (#4085, from the review of #3982), two changes to crove_meetings.morning_notices_due:
--   1. An event cached on two calendar connections of the same member counted twice. The count is now of distinct events: the provider's event id with its start (the same pair on two connections is one meeting;
--      the cap of 1000 stays on top).
--   2. Starvation past the sweep's pass size: the due members came back in (org_id, user_id) order, so if 200 or more of them fail the same way (the sweep takes 200 a pass) the same first 200 came back every
--      pass and the rest never got a turn. The order is now random, so each pass takes a different slice; a member who is not in a failing group is reached within a few passes. The function is VOLATILE for that
--      (it was STABLE); nothing else about it changes (signature, owner, grants, the filters).
-- Not changed, on purpose: `pg_timezone_names` is still scanned once per call (the check "a zone the database knows" has to be made against that list; it takes about 10 ms warm on PostgreSQL 17, so a pass of
-- 200 dispatches adds about two seconds every five minutes, which is cheap today).
-- crove_meetings.morning_notices_due is restated whole (CREATE OR REPLACE, same signature, owner and grants) on top of 20270121130000; only the count expression, the ORDER BY and the volatility differ from it.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.morning_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, events integer, english boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
    WHERE EXISTS (
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
  SELECT d.org_id, d.user_id, d.day, LEAST(pg_catalog.count(DISTINCT (a.external_id, a.starts_at)), 1000)::integer, (d.language OPERATOR(pg_catalog.=) 'en')
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
  -- In no fixed order: a group of members whose notice fails the same way (200 or more with the sweep's pass size) cannot hold the same first rows pass after pass; the rest are reached by chance within a few passes.
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
REVOKE ALL ON FUNCTION crove_meetings.morning_notices_due(integer, uuid, uuid, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.morning_notices_due(integer, uuid, uuid, date) TO crove_worker;
