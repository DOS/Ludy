-- SPDX-License-Identifier: AGPL-3.0-only
-- Daily Vy prep lines worker sweep definers and queue (#5073 Step 2b-2, ADR-0049):
--   1. ludy_meetings.morning_brief_daily_due: worker-only definer returning scalar metadata only
--      (no text, no jsonb) for opted-in members (morning_notice.enabled = true, content = 'full',
--      vy_lines = true) inside the 60-minute pre-send / 360-minute post-send window with active
--      calendar_agenda events, excluding already-notified days, active/succeeded/recent-failed runs,
--      missing vy.use permission, paused/retired member_vy agents, kill switches, and exhausted budgets.
--   2. ludy_meetings.morning_brief_active_connections: worker-only definer returning active
--      read_events calendar connection IDs for a member.
--   3. Queue meetings-brief-daily with standard policy and kernel-job.dlq dead-letter queue.
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_daily_due(
  p_limit integer DEFAULT 200,
  p_org_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_day date DEFAULT NULL
)
RETURNS TABLE (org_id uuid, user_id uuid, day date, window_from timestamptz, window_to timestamptz, english boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' OR ludy_kernel.ctx_actor_type() = 'agent' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH known AS MATERIALIZED (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language
    FROM ludy_meetings.morning_notice n
    WHERE n.enabled = true
      AND n.content = 'full'
      AND n.vy_lines = true
      AND (p_org_id IS NULL OR n.org_id = p_org_id)
      AND (p_user_id IS NULL OR n.user_id = p_user_id)
      AND n.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z)
  ),
  local AS (
    SELECT n.org_id, n.user_id, n.send_minute, n.time_zone, n.language,
           (pg_catalog.now() AT TIME ZONE n.time_zone) AS local_now
    FROM known n
    JOIN ludy_kernel.tenant t
      ON t.org_id = n.org_id AND t.status = 'active'
    JOIN ludy_kernel.tenant_member m
      ON m.org_id = n.org_id AND m.user_id = n.user_id AND m.role IN ('owner', 'admin', 'member')
    JOIN ludy_kernel.user_account u
      ON u.id = n.user_id AND u.disabled_at IS NULL
    LEFT JOIN LATERAL (
      SELECT a.id, a.status
      FROM ludy_kernel.agent a
      WHERE a.org_id = n.org_id
        AND a.kind = 'member_vy'
        AND a.member_user_id = n.user_id
      LIMIT 1
    ) ag ON true
    WHERE ludy_kernel.org_app_on(n.org_id, 'meetings')
      AND ludy_kernel.member_vy_member_active(n.org_id, n.user_id)
      AND (ag.id IS NULL OR ag.status = 'active')
      AND NOT ludy_kernel.global_kill_switch_on('ai')
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.kill_switch k
        WHERE k.org_id = n.org_id
          AND k.released_at IS NULL
          AND (
            k.scope = 'org'
            OR (k.scope = 'module' AND k.target = 'meetings')
            OR (ag.id IS NOT NULL AND k.scope = 'agent' AND k.target = ag.id::text)
          )
      )
      AND NOT ludy_kernel.ai_budget_exhausted(n.org_id, 'meetings', ag.id)
      AND NOT EXISTS (
        SELECT 1 FROM ludy_kernel.notification_mute x
        WHERE x.org_id = n.org_id AND x.user_id = n.user_id AND x.kind = 'meetings.morning'
      )
  ),
  windows AS (
    SELECT l.org_id,
           l.user_id,
           l.language,
           d.cand_day AS day,
           (d.cand_day::timestamp AT TIME ZONE l.time_zone) AS window_from,
           ((d.cand_day + 1)::timestamp AT TIME ZONE l.time_zone) AS window_to,
           ((d.cand_day::timestamp + pg_catalog.make_interval(mins => l.send_minute)) AT TIME ZONE l.time_zone) AS send_at
    FROM local l
    CROSS JOIN LATERAL (VALUES (l.local_now::date), ((l.local_now::date + 1)::date)) AS d(cand_day)
  )
  SELECT w.org_id,
         w.user_id,
         w.day,
         w.window_from,
         w.window_to,
         (w.language OPERATOR(pg_catalog.=) 'en')
  FROM windows w
  WHERE pg_catalog.now() >= w.send_at - interval '60 minutes'
    AND pg_catalog.now() < w.send_at + interval '360 minutes'
    AND (p_day IS NULL OR w.day = p_day)
    AND EXISTS (
      SELECT 1
      FROM ludy_meetings.calendar_agenda a
      JOIN ludy_kernel.calendar_connection c
        ON c.org_id = a.org_id AND c.id = a.connection_id
      WHERE a.org_id = w.org_id
        AND a.user_id = w.user_id
        AND a.starts_at >= w.window_from
        AND a.starts_at < w.window_to
        AND c.status = 'active'
        AND c.read_events = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM ludy_kernel.notification x
      WHERE x.org_id = w.org_id AND x.user_id = w.user_id AND x.dedupe_key = 'morning:' || w.day::text
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ludy_kernel.ai_run r
      JOIN ludy_kernel.agent ag
        ON ag.org_id = r.org_id AND ag.id = r.agent_id
      WHERE r.org_id = w.org_id
        AND ag.kind = 'member_vy'
        AND ag.member_user_id = w.user_id
        AND r.feature = 'meetings.brief_daily'
        AND r.started_at >= w.window_from - interval '2 hours'
        AND (
          r.status IN ('running', 'succeeded')
          OR (r.status = 'failed' AND r.started_at >= pg_catalog.now() - interval '60 minutes')
        )
    )
  ORDER BY pg_catalog.random()
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_daily_due(integer, uuid, uuid, date) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_daily_due(integer, uuid, uuid, date) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_daily_due(integer, uuid, uuid, date) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_brief_active_connections(
  p_org_id uuid,
  p_user_id uuid
) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' OR ludy_kernel.ctx_actor_type() = 'agent' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR p_org_id IS NULL
     OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id
  FROM ludy_kernel.calendar_connection c
  WHERE c.org_id = p_org_id
    AND c.user_id = p_user_id
    AND c.status = 'active'
    AND c.read_events = true
  ORDER BY c.id;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_active_connections(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_brief_active_connections(uuid, uuid) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_brief_active_connections(uuid, uuid) TO ludy_worker;

SELECT ludy_jobs.create_queue('meetings-brief-daily', '{"policy":"standard","deadLetter":"kernel-job.dlq"}'::jsonb);
