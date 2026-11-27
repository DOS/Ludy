-- SPDX-License-Identifier: AGPL-3.0-only
-- Worker-only and member_briefing scalar/metadata helper definers for Slice A2 (#5080, ADR-0049):
--   1. ludy_meetings.morning_notice_is_full(uuid, uuid): system-only boolean check for full briefing opt-in.
--   2. ludy_meetings.morning_briefing_window(date): member_briefing-only window bounds, local today, and vy_lines flag.
--   3. ludy_meetings.morning_briefing_active_connections(): member_briefing-only active calendar connection ids.
--   4. ludy_meetings.morning_briefing_task_flags(uuid[], date): member_briefing-only open/overdue/mine/due_on flags for
--      published action items on readable meetings (ZERO task title/text returned; ADR-0049 line 339).
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.morning_notice_is_full(
  p_org_id uuid,
  p_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (ludy_kernel.ctx_verified() ->> 'kind') = 'member_briefing' THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM p_org_id
     OR p_org_id IS NULL
     OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM ludy_meetings.morning_notice mn
    WHERE mn.org_id = p_org_id
      AND mn.user_id = p_user_id
      AND mn.enabled = true
      AND mn.content = 'full'
  );
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_notice_is_full(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_notice_is_full(uuid, uuid) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_notice_is_full(uuid, uuid) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_briefing_window(
  p_day date
) RETURNS TABLE (window_from timestamptz, window_to timestamptz, today date, vy_lines boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_briefing_user_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'agent'
     OR (ludy_kernel.ctx_verified() ->> 'kind') IS DISTINCT FROM 'member_briefing'
     OR v_org IS NULL
     OR v_user IS NULL
     OR p_day IS NULL THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT (p_day::timestamp AT TIME ZONE mn.time_zone),
         ((p_day + 1)::timestamp AT TIME ZONE mn.time_zone),
         (pg_catalog.now() AT TIME ZONE mn.time_zone)::date,
         mn.vy_lines
  FROM ludy_meetings.morning_notice mn
  WHERE mn.org_id = v_org
    AND mn.user_id = v_user
    AND mn.enabled = true
    AND mn.content = 'full'
    AND mn.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z);
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_window(date) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_window(date) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_briefing_window(date) TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_briefing_active_connections()
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_briefing_user_id();
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'agent'
     OR (ludy_kernel.ctx_verified() ->> 'kind') IS DISTINCT FROM 'member_briefing'
     OR v_org IS NULL
     OR v_user IS NULL THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.id
  FROM ludy_kernel.calendar_connection c
  WHERE c.org_id = v_org
    AND c.user_id = v_user
    AND c.status = 'active'
    AND c.read_events = true
  ORDER BY c.id;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_active_connections() FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_active_connections() FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_briefing_active_connections() TO ludy_worker;

CREATE OR REPLACE FUNCTION ludy_meetings.morning_briefing_task_flags(
  p_meeting_ids uuid[],
  p_today date
) RETURNS TABLE (action_item_id uuid, is_open boolean, is_overdue boolean, is_mine boolean, due_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_briefing_user_id();
  v_ids uuid[];
  v_tz text;
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER')
     OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'agent'
     OR (ludy_kernel.ctx_verified() ->> 'kind') IS DISTINCT FROM 'member_briefing'
     OR v_org IS NULL
     OR v_user IS NULL THEN
    RAISE EXCEPTION 'AGENT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_meeting_ids IS NULL OR COALESCE(pg_catalog.cardinality(p_meeting_ids), 0) = 0 THEN
    RETURN;
  END IF;
  v_ids := p_meeting_ids[1:50];
  IF v_ids IS NULL OR COALESCE(pg_catalog.cardinality(v_ids), 0) = 0 THEN
    RETURN;
  END IF;

  SELECT mn.time_zone INTO v_tz
  FROM ludy_meetings.morning_notice mn
  WHERE mn.org_id = v_org
    AND mn.user_id = v_user
    AND mn.enabled = true
    AND mn.content = 'full'
    AND mn.time_zone IN (SELECT z.name FROM pg_catalog.pg_timezone_names z);
  IF v_tz IS NULL THEN
    v_tz := 'Asia/Ho_Chi_Minh';
  END IF;

  RETURN QUERY
  SELECT i.id AS action_item_id,
         COALESCE(t.id IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'), true) AS is_open,
         COALESCE(
           (t.id IS NULL OR t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))
           AND COALESCE((t.due AT TIME ZONE v_tz)::date, i.when_parsed) IS NOT NULL
           AND p_today IS NOT NULL
           AND COALESCE((t.due AT TIME ZONE v_tz)::date, i.when_parsed) < p_today,
           false
         ) AS is_overdue,
         (COALESCE(p.holder_user_id, i.who_parsed) IS NOT DISTINCT FROM v_user) AS is_mine,
         COALESCE((t.due AT TIME ZONE v_tz)::date, i.when_parsed) AS due_on
  FROM ludy_meetings.action_item i
  JOIN ludy_meetings.meeting mt
    ON mt.org_id = i.org_id
   AND mt.id = i.meeting_id
   AND (mt.text_retention_date IS NULL OR mt.text_retention_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
  LEFT JOIN ludy_kernel.task t
    ON t.org_id = i.org_id
   AND t.id = i.task_id
   AND (
     t.legal_entity_id IS NULL
     OR '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
     OR t.legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
   )
   AND NOT EXISTS (
     SELECT 1
     FROM ludy_projects.project_task pt
     JOIN ludy_projects.project pr ON pr.org_id = pt.org_id AND pr.id = pt.project_id
     WHERE pt.org_id = t.org_id
       AND pt.task_id = t.id
       AND pr.visibility <> 'org'
       AND pr.owner_user_id IS DISTINCT FROM v_user
       AND NOT EXISTS (
         SELECT 1
         FROM ludy_projects.project_member pm
         WHERE pm.org_id = pr.org_id AND pm.project_id = pr.id AND pm.user_id = v_user
       )
       AND NOT EXISTS (
         SELECT 1
         FROM ludy_kernel.tenant_member tm
         WHERE tm.org_id = t.org_id AND tm.user_id = v_user AND tm.role IN ('owner', 'admin')
       )
   )
  LEFT JOIN ludy_kernel.position p
    ON p.org_id = t.org_id
   AND p.id = t.assignee_position_id
   AND p.status = 'active'
  WHERE i.org_id = v_org
    AND i.meeting_id = ANY (v_ids)
    AND i.stage = 'published'
    AND ludy_meetings.is_briefing_meeting_reader(v_org, i.meeting_id, v_user);
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_task_flags(uuid[], date) FROM PUBLIC;
DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.morning_briefing_task_flags(uuid[], date) FROM %I', v_role);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.morning_briefing_task_flags(uuid[], date) TO ludy_worker;
