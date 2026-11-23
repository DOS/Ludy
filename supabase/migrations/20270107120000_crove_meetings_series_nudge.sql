-- SPDX-License-Identifier: AGPL-3.0-only
-- The nudge of a meeting series (#3542, part 2): about 30 minutes before the next meeting of a series, each person who still has open items from the previous meeting gets one in-app notice with
-- the count and a link, never a title. This file adds the worker's one read and the queue of the sweep; the notice itself is written by the command meetings.series.nudge through notifyMembers,
-- once per member and occurrence (the notification's own key, the series and the Vietnam day of the start, so an occurrence moved by a few minutes is not told twice), so no table is added.
--
-- crove_meetings.series_nudges_due answers ONLY ids, times and a count (no text), to the worker role alone:
--   * the event is in the member's OWN calendar cache (so they are invited to it), starts within the next 30 minutes and belongs to a series;
--   * the previous meeting is the latest earlier meeting of that series the member can read as the meeting policy says for a recorder or an attendee reader (the policy's org-wide reading
--     needs the member's entity scope, which a definer cannot see, so such a member is simply not nudged: the answer is always a subset of what they may read), and whose text period has not ended;
--   * an item counts when it is published, accepted, its task is still open (todo, in progress, waiting, in review) and the task is with the member now (the holder of its active seat, else the
--     attendee the item was parsed to), the same rule as meetings.series.open_items. A suggestion nobody accepted has no assignee, so it never nudges anyone.
-- With the optional filters (org, member, series, start time) it re-derives one row, which is how the command checks what the job was told instead of trusting it.
CREATE INDEX IF NOT EXISTS calendar_agenda_series_start_idx ON crove_meetings.calendar_agenda (starts_at) WHERE series_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crove_meetings.series_nudges_due(
  p_limit integer,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_series_id uuid DEFAULT NULL,
  p_starts_at timestamptz DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, series_id uuid, previous_meeting_id uuid, starts_at timestamptz, open_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH upcoming AS (
    SELECT a.org_id, a.user_id, a.series_id, pg_catalog.min(a.starts_at) AS starts_at
    FROM crove_meetings.calendar_agenda a
    WHERE a.series_id IS NOT NULL
      AND a.starts_at > pg_catalog.now()
      AND a.starts_at <= pg_catalog.now() + interval '30 minutes'
      AND (p_org_id IS NULL OR a.org_id = p_org_id)
      AND (p_user_id IS NULL OR a.user_id = p_user_id)
      AND (p_series_id IS NULL OR a.series_id = p_series_id)
      AND (p_starts_at IS NULL OR a.starts_at = p_starts_at)
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role IN ('owner', 'admin', 'member')
      )
      -- Only a calendar the member still shares: an expired or switched-off connection leaves its rows in the cache, which may no longer be true (an occurrence cancelled since).
      AND EXISTS (
        SELECT 1 FROM crove_kernel.calendar_connection c
        WHERE c.org_id = a.org_id AND c.id = a.connection_id AND c.status = 'active' AND c.read_events
      )
      -- Not an org that turned Meetings off, and not a member who turned the notice off: they would be listed on every pass and push the others past the limit.
      AND crove_kernel.org_app_on(a.org_id, 'meetings')
      AND NOT EXISTS (
        SELECT 1 FROM crove_kernel.notification_mute x
        WHERE x.org_id = a.org_id AND x.user_id = a.user_id AND x.kind = 'meetings.series_open_items'
      )
    -- The same event in two of a member's calendars is one nudge, and so are two starts of one series on one Vietnam day (the notice's own key).
    GROUP BY a.org_id, a.user_id, a.series_id, pg_catalog.to_char(a.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
  ),
  previous AS (
    SELECT u.org_id, u.user_id, u.series_id, u.starts_at, p.id AS meeting_id
    FROM upcoming u
    CROSS JOIN LATERAL (
      SELECT m.id
      FROM crove_meetings.meeting m
      WHERE m.org_id = u.org_id
        AND m.series_id = u.series_id
        AND coalesce(m.started_at, m.created_at) < u.starts_at
        AND (m.text_retention_date IS NULL OR m.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
        AND (
          m.recorder_user_id = u.user_id
          OR EXISTS (SELECT 1 FROM crove_meetings.meeting_reader r WHERE r.org_id = m.org_id AND r.meeting_id = m.id AND r.user_id = u.user_id)
        )
      ORDER BY coalesce(m.started_at, m.created_at) DESC, m.id DESC
      LIMIT 1
    ) p
  )
  SELECT v.org_id, v.user_id, v.series_id, v.meeting_id, v.starts_at, pg_catalog.count(*)::integer
  FROM previous v
  JOIN crove_meetings.action_item i
    ON i.org_id = v.org_id AND i.meeting_id = v.meeting_id AND i.stage = 'published' AND i.status = 'accepted'
  JOIN crove_kernel.task t
    ON t.org_id = i.org_id AND t.id = i.task_id AND t.status IN ('todo', 'in_progress', 'waiting', 'in_review')
  LEFT JOIN crove_kernel.position s
    ON s.org_id = t.org_id AND s.id = t.assignee_position_id AND s.status = 'active'
  WHERE coalesce(s.holder_user_id, i.who_parsed) = v.user_id
    -- Not one already told: the notice's own key (meetings.series.nudge writes 'series:<series>:<Vietnam day of the start>'), so a pass lists only what is still to send and the limit never starves a later row.
    AND NOT EXISTS (
      SELECT 1 FROM crove_kernel.notification n
      WHERE n.org_id = v.org_id AND n.user_id = v.user_id
        AND n.dedupe_key = 'series:' || v.series_id::text || ':' || pg_catalog.to_char(v.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
    )
  GROUP BY v.org_id, v.user_id, v.series_id, v.meeting_id, v.starts_at
  ORDER BY v.starts_at, v.org_id, v.user_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;
REVOKE ALL ON FUNCTION crove_meetings.series_nudges_due(integer, uuid, uuid, uuid, timestamptz) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.series_nudges_due(integer, uuid, uuid, uuid, timestamptz) TO crove_worker;

-- The worker's sweep, every 5 minutes (apps/kernel/src/meetings-series-nudge.ts).
SELECT crove_jobs.create_queue('meetings-series-nudge', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
