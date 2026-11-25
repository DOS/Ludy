-- SPDX-License-Identifier: AGPL-3.0-only
-- The opt-in weekly notice of the week's meetings (#4967, Proposal 3 of the research on #932, step 1 of 2; step 0 registered the table in the RLS matrix). A member who turns it on gets, each Monday at the time
-- they chose (in their own time zone), one in-app notice and one mail that say only how many meetings of the last seven days they can read with something published, how many decisions were published, how many
-- action items are still open and how many of those are overdue, and link to the "this week" card of the meetings page (L9, meetings.digest.facts). No title, no name, no word of a decision: nothing here runs Vy.
--
-- ludy_meetings.weekly_notice: one row per member who turned the notice on (no row, no notice). Private to its member, as ludy_meetings.morning_notice: the row policy shows and changes a member's own row only,
--   in a user context; the owner, an admin, another member, an agent and the system context read none of it.
-- ludy_meetings.weekly_notices_due: the worker's sweep. The system context reads no meeting, result or item (their policies are a person's), so this worker-only definer is the one place that joins the opt-in rows
--   with the meetings. It states, in SQL, the rule a person's row security states for meeting_read (the recorder, or an org-visible meeting for a member whose scope is the whole org, or a reader row; a member of
--   the org, never one who left) and L9's own filters (started in the last seven days, not past its text date, something published), and returns NUMBERS only: the Monday (in the member's zone), the count of
--   meetings, of published decisions, of open items and of overdue ones, whether a limit cut them, and the language. No title, no id of a meeting, no text, no jsonb (a definer returns no text to the worker).
--   It leaves out a member who left the org, a disabled account, an org with Meetings off, an org that is not active (offboarding), a member who muted the kind, a member already told for that Monday (the notice's own key,
--   'weekly:<monday>', which is also what makes a second dispatch write nothing), and a week with nothing L9 would show.
-- A task's status is read the way the member's own row security shows it (the card reads tasks as the member): a task outside their legal-entity scope or in a private project they are not part of is treated as absent,
-- so the numbers never tell a member whether a task they cannot read was closed or is overdue.
-- The limits are L9's (50 meetings, 30 decisions and 30 open items in all, newest meeting first, 100 items of one meeting): counts that were cut say so, so the mail can say "at least".
-- p_now is the instant the rule is read at (the clock when it is NULL, which is all the sweep ever passes): it lets the tests read the week at a Monday. It names no row and widens nothing: the function is
-- worker-only, and the one command that calls it with an instant runs only in the system's context.
-- Queue: meetings-weekly, the sweep's job (it reaches no address; the mail is sent by the mail queues).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.weekly_notice (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  -- Minutes after midnight in time_zone on the Monday: 480 is 08:00.
  send_minute smallint NOT NULL DEFAULT 480 CHECK (send_minute BETWEEN 0 AND 1439),
  -- An IANA name from the member's browser (Asia/Ho_Chi_Minh by default); a name the database does not know is simply never due.
  time_zone text NOT NULL CHECK (pg_catalog.char_length(time_zone) BETWEEN 1 AND 64),
  language text NOT NULL DEFAULT 'vi' CHECK (language ~ '^[a-z]{2}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT weekly_notice_user_uq UNIQUE (org_id, user_id)
);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.weekly_notice');

DROP POLICY IF EXISTS weekly_notice_own ON ludy_meetings.weekly_notice;
CREATE POLICY weekly_notice_own ON ludy_meetings.weekly_notice AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND user_id = ludy_kernel.ctx_user_id())
  WITH CHECK (ludy_kernel.ctx_actor_type() = 'user' AND user_id = ludy_kernel.ctx_user_id());

-- A member who leaves the org (or is removed) loses their weekly-notice row at once, as the morning notice's row does (20270121165000): a trigger on ludy_kernel.tenant_member deletes it (SECURITY DEFINER: the owner
-- who removes a member cannot see that member's private row, and the row is the member's own); it covers every path that deletes a membership, not only the remove command. The save takes the membership row
-- FOR KEY SHARE (modules/meetings/src/weekly.ts), so a save cannot land after the cleanup.
CREATE OR REPLACE FUNCTION ludy_meetings.weekly_notice_member_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM ludy_meetings.weekly_notice n WHERE n.org_id = OLD.org_id AND n.user_id = OLD.user_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_notice_member_removed() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- migration-lint: cross-module the trigger fires on the kernel's membership delete and removes the Meetings row of that member (the cross-module precedent is the morning notice's trigger, 20270121165000)
DROP TRIGGER IF EXISTS tenant_member_drops_weekly_notice ON ludy_kernel.tenant_member;
-- migration-lint: cross-module the trigger fires on the kernel's membership delete and removes the Meetings row of that member (the cross-module precedent is the morning notice's trigger, 20270121165000)
CREATE TRIGGER tenant_member_drops_weekly_notice AFTER DELETE ON ludy_kernel.tenant_member
  FOR EACH ROW EXECUTE FUNCTION ludy_meetings.weekly_notice_member_removed();

CREATE OR REPLACE FUNCTION ludy_meetings.weekly_notices_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL,
  p_now timestamptz DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, meetings integer, decisions integer, open_items integer, overdue integer, cut boolean, english boolean)
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
  SELECT t.org_id, t.user_id, t.day, t.meetings, t.decisions, t.open_items, LEAST(t.overdue_all, t.open_items), t.cut, (t.language OPERATOR(pg_catalog.=) 'en')
  FROM totals t
  WHERE t.meetings > 0
  -- A random order, so a pass that cannot finish everyone (the sweep takes 200) reaches a different slice next time and no failing group starves the rest.
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_meetings.weekly_notices_due(integer, uuid, uuid, date, timestamptz) TO ludy_worker;

SELECT ludy_jobs.create_queue('meetings-weekly', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
