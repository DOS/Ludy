-- SPDX-License-Identifier: AGPL-3.0-only
-- The weekly meetings notice (#4967) says one more number when the org keeps tracked words (#5019, plan docs/plan/meetings.md L22 x L28): ludy_meetings.weekly_notices_due is restated with ONE more output column,
-- `tracked integer`, the last one: how often the org's tracked words came up in the published transcript lines of the meetings the member reads (the same 50 newest meetings, reader rule and 7 day window as the
-- other numbers), NULL when the org keeps no tracked word, at most 999. The counting is ludy_meetings.tracker_hits_in (20270327180000), the one statement of the matching rule shared with the tracker alert; the function
-- returns a number only (no text, no jsonb, no id). Everything else of the body of 20270327100000 is unchanged, and the grants are the same (REVOKE from PUBLIC and every role, EXECUTE to ludy_worker only).
-- A function cannot gain an output column in place, so the old one is dropped first: no caller selects by position (the sweep and the command name their columns).
SET LOCAL lock_timeout = '2s';

-- crove:contract adr=0047
DROP FUNCTION IF EXISTS ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz);

CREATE OR REPLACE FUNCTION ludy_meetings.weekly_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL,
  p_now timestamptz DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, meetings integer, decisions integer, open_items integer, overdue integer, cut boolean, english boolean, tracked integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH known AS MATERIALIZED (
    -- Only zones the database knows, decided before any time is computed in them: a name it does not know would otherwise fail the whole pass (the planner may compute the local time before it filters).
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language
    FROM ludy_meetings.weekly_notice n
    WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND n.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z)
  ),
  local AS (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language, COALESCE(p_now, pg_catalog.now()) AT TIME ZONE n.time_zone AS local_now
    FROM known n
    JOIN ludy_kernel.tenant t ON t.org_id = n.org_id AND t.status = 'active'
    JOIN ludy_kernel.user_account u ON u.id = n.user_id AND u.disabled_at IS NULL
    WHERE EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = n.org_id AND m.user_id = n.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      AND ludy_kernel.org_app_on(n.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification_mute x
        WHERE x.org_id = n.org_id AND x.user_id = n.user_id AND x.kind = 'meetings.weekly'
      )
  ),
  due AS (
    -- Monday (ISO day 1) in the member's zone, from the chosen time and for six hours after it (a sweep that was down is forgiven within the morning, not the next day).
    SELECT l.org_id, l.user_id, l.time_zone, l.language, l.local_now::date AS day
    FROM local l
    WHERE pg_catalog.date_part('isodow', l.local_now) = 1
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer >= l.send_minute
      AND (pg_catalog.date_part('hour', l.local_now) * 60 + pg_catalog.date_part('minute', l.local_now))::integer < l.send_minute + 360
      AND (p_day IS NULL OR l.local_now::date = p_day)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification x
        WHERE x.org_id = l.org_id AND x.user_id = l.user_id AND x.dedupe_key = 'weekly:' || l.local_now::date::text
      )
  ),
  scoped AS (
    -- The member's scope as enter_context seals it: the whole org for an owner or an admin, for a member with an org-wide role assignment and for one with no assignment at all; a member limited to some
    -- legal entities reads an org-visible meeting only through a reader row (the policy's '*' branch).
    SELECT d.*,
           (m.role IN ('owner', 'admin')
            OR NOT EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = d.org_id AND a.user_id = d.user_id)
            OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = d.org_id AND a.user_id = d.user_id AND a.legal_entity_id IS NULL)) AS whole_org
    FROM due d
    JOIN ludy_kernel.tenant_member m ON m.org_id = d.org_id AND m.user_id = d.user_id
  ),
  readable AS (
    -- The meetings L9 would list for this member (days = 7): readable, started in the last seven days, not past the text date, with a published result or a published action item; newest first, one more
    -- than the limit is ranked so a cut is known.
    SELECT s.org_id, s.user_id, s.day, s.language, s.time_zone, s.whole_org, mt.id AS meeting_id,
           pg_catalog.row_number() OVER (PARTITION BY s.org_id, s.user_id ORDER BY mt.started_at DESC, mt.id) AS rn
    FROM scoped s
    JOIN ludy_meetings.meeting mt ON mt.org_id = s.org_id
    WHERE mt.started_at >= COALESCE(p_now, pg_catalog.now()) - pg_catalog.make_interval(days => 7)
      AND (mt.text_retention_date IS NULL OR mt.text_retention_date > (COALESCE(p_now, pg_catalog.now()) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
      AND (
        mt.recorder_user_id = s.user_id
        OR (mt.visibility = 'org' AND s.whole_org)
        OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.user_id = s.user_id)
      )
      AND (
        EXISTS (SELECT 1 FROM ludy_meetings.meeting_result r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.stage = 'published')
        OR EXISTS (SELECT 1 FROM ludy_meetings.action_item a WHERE a.org_id = mt.org_id AND a.meeting_id = mt.id AND a.stage = 'published')
      )
  ),
  per_meeting AS (
    SELECT r.org_id, r.user_id, r.day, r.language, r.rn,
           -- Non-blank published decisions (L9 drops a blank one).
           COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.meeting_result res, pg_catalog.jsonb_array_elements(res.decisions) e
             WHERE res.org_id = r.org_id AND res.meeting_id = r.meeting_id AND res.stage = 'published'
               AND pg_catalog.jsonb_typeof(e) = 'string' AND (e #>> '{}') ~ '[^[:space:]]'
           ), 0)::integer AS d,
           -- Open published items: no task yet or a task still to do, in progress, waiting or in review (the series' own rule), at most 100 of one meeting.
           LEAST(100, COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.action_item i
             LEFT JOIN ludy_kernel.task t ON t.org_id = i.org_id AND t.id = i.task_id
             -- Only a task the member's own row security shows them (the task policies le_scope and private_project_scope): one they cannot see is absent, so its item counts as open, as it does on the card.
             AND (t.legal_entity_id IS NULL OR r.whole_org OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = t.org_id AND ra.user_id = r.user_id AND ra.legal_entity_id = t.legal_entity_id))
             AND NOT EXISTS (
               SELECT 1 FROM ludy_projects.project_task pt
               JOIN ludy_projects.project pr ON pr.org_id = pt.org_id AND pr.id = pt.project_id
               WHERE pt.org_id = t.org_id AND pt.task_id = t.id AND pr.visibility <> 'org'
                 AND pr.owner_user_id IS DISTINCT FROM r.user_id
                 AND NOT EXISTS (SELECT 1 FROM ludy_projects.project_member pm WHERE pm.org_id = pr.org_id AND pm.project_id = pr.id AND pm.user_id = r.user_id)
                 AND NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant_member tm WHERE tm.org_id = t.org_id AND tm.user_id = r.user_id AND tm.role IN ('owner', 'admin'))
             )
             WHERE i.org_id = r.org_id AND i.meeting_id = r.meeting_id AND i.stage = 'published'
               AND (t.status IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))
           ), 0))::integer AS o,
           -- Of those, the ones whose due day (the task's, in Vietnam's calendar, else the day the item names) is before today.
           LEAST(100, COALESCE((
             SELECT pg_catalog.count(*)
             FROM ludy_meetings.action_item i
             LEFT JOIN ludy_kernel.task t ON t.org_id = i.org_id AND t.id = i.task_id
             -- Only a task the member's own row security shows them (the task policies le_scope and private_project_scope): one they cannot see is absent, so its item counts as open, as it does on the card.
             AND (t.legal_entity_id IS NULL OR r.whole_org OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = t.org_id AND ra.user_id = r.user_id AND ra.legal_entity_id = t.legal_entity_id))
             AND NOT EXISTS (
               SELECT 1 FROM ludy_projects.project_task pt
               JOIN ludy_projects.project pr ON pr.org_id = pt.org_id AND pr.id = pt.project_id
               WHERE pt.org_id = t.org_id AND pt.task_id = t.id AND pr.visibility <> 'org'
                 AND pr.owner_user_id IS DISTINCT FROM r.user_id
                 AND NOT EXISTS (SELECT 1 FROM ludy_projects.project_member pm WHERE pm.org_id = pr.org_id AND pm.project_id = pr.id AND pm.user_id = r.user_id)
                 AND NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant_member tm WHERE tm.org_id = t.org_id AND tm.user_id = r.user_id AND tm.role IN ('owner', 'admin'))
             )
             WHERE i.org_id = r.org_id AND i.meeting_id = r.meeting_id AND i.stage = 'published'
               AND (t.status IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))
               AND COALESCE((t.due AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, i.when_parsed) < (COALESCE(p_now, pg_catalog.now()) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
           ), 0))::integer AS od
    FROM readable r
    WHERE r.rn <= 50
  ),
  sliced AS (
    -- L9's greedy cut: meetings in order, each takes what is left of the 30 decisions and the 30 items.
    SELECT p.*,
           LEAST(p.d, GREATEST(0, 30 - COALESCE(pg_catalog.sum(p.d) OVER (PARTITION BY p.org_id, p.user_id ORDER BY p.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::integer AS d_shown,
           LEAST(p.o, GREATEST(0, 30 - COALESCE(pg_catalog.sum(p.o) OVER (PARTITION BY p.org_id, p.user_id ORDER BY p.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::integer AS o_shown
    FROM per_meeting p
  ),
  totals AS (
    SELECT s.org_id, s.user_id, s.day, s.language,
           (pg_catalog.count(*) FILTER (WHERE s.d_shown > 0 OR s.o_shown > 0))::integer AS meetings,
           pg_catalog.sum(s.d_shown)::integer AS decisions,
           pg_catalog.sum(s.o_shown)::integer AS open_items,
           pg_catalog.sum(s.od)::integer AS overdue_all,
           (pg_catalog.bool_or(s.d_shown < s.d OR s.o_shown < s.o)
            OR EXISTS (SELECT 1 FROM readable x WHERE x.org_id = s.org_id AND x.user_id = s.user_id AND x.rn > 50)) AS cut
    FROM sliced s
    GROUP BY s.org_id, s.user_id, s.day, s.language
  )
  SELECT t.org_id, t.user_id, t.day, t.meetings, t.decisions, t.open_items, LEAST(t.overdue_all, t.open_items), t.cut, (t.language OPERATOR(pg_catalog.=) 'en'),
         -- How often the org's tracked words came up in the published lines of the member's readable meetings (the same 50 as the other numbers): NULL when the org keeps no tracked word (no line, not 0),
         -- else the sum of the shared helper's hits (the one statement of the matching rule), at most 999. Only a number leaves: no word, no line, no meeting id.
         CASE WHEN EXISTS (SELECT 1 FROM ludy_meetings.tracker_term x WHERE x.org_id = t.org_id)
           THEN LEAST(999, COALESCE((SELECT pg_catalog.sum(h.hits) FROM readable r CROSS JOIN LATERAL ludy_meetings.tracker_hits_in(r.org_id, r.meeting_id) h WHERE r.org_id = t.org_id AND r.user_id = t.user_id AND r.rn <= 50), 0))::integer
         END
  FROM totals t
  WHERE t.meetings > 0
  -- A random order, so a pass that cannot finish everyone (the sweep takes 200) reaches a different slice next time and no failing group starves the rest.
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) TO ludy_worker;
