-- SPDX-License-Identifier: AGPL-3.0-only
-- Follow-up of the morning notice (#3955, part B), three small changes:
--   1. A member who leaves the org (or is removed) loses their morning-notice row at once. Before, the row stayed: a member who rejoined later found the old opt-in switched on, and a row of a former member
--      sat in the table until the org was purged. A trigger on crove_kernel.tenant_member deletes it (SECURITY DEFINER: the owner who removes a member cannot see that member's private row, and the row is the
--      member's own); it covers every path that deletes a membership, not only the remove command.
--   2. The count the sweep returns is capped at 1000, the most the mail's merge data accepts (zMorningMail.count), so a calendar with more events in one day cannot make a member's notice fail to build.
--   3. The definer filtered by org and user twice (in `known` and again in `local`); the second copy is dropped.
-- crove_meetings.morning_notices_due is restated whole (CREATE OR REPLACE, same signature, owner and grants); only two things differ from 20270120110000: the `local` CTE no longer repeats the org and user filter, and the count is `LEAST(count(*), 1000)`.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.morning_notice_member_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM crove_meetings.morning_notice n WHERE n.org_id = OLD.org_id AND n.user_id = OLD.user_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.morning_notice_member_removed() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- migration-lint: cross-module the trigger fires on the kernel's membership delete and removes the Meetings row of that member (the cross-module precedent is the Ads token hold trigger on a kernel table)
DROP TRIGGER IF EXISTS tenant_member_drops_morning_notice ON crove_kernel.tenant_member;
-- migration-lint: cross-module the trigger fires on the kernel's membership delete and removes the Meetings row of that member (the cross-module precedent is the Ads token hold trigger on a kernel table)
CREATE TRIGGER tenant_member_drops_morning_notice AFTER DELETE ON crove_kernel.tenant_member
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.morning_notice_member_removed();

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
  SELECT d.org_id, d.user_id, d.day, LEAST(pg_catalog.count(*), 1000)::integer, (d.language OPERATOR(pg_catalog.=) 'en')
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
