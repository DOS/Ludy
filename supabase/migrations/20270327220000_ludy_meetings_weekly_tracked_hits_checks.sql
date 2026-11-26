-- SPDX-License-Identifier: AGPL-3.0-only
-- Successor of 20270327210100_ludy_meetings_weekly_notice_tracked.sql (#5044, the Platform PO's review notes on #5041): ludy_meetings.weekly_tracked_hits is restated with the same signature and the same body, and
-- gains the checks its sibling tracker_alert_hits has, so it stands on its own and does not lean on its one caller having asked the due definer first:
--   - the org's Meetings app is on (ludy_kernel.org_app_on), the tenant is active and the member's account is not disabled: else NULL (no count), not an error;
--   - the grants are stated the way the other worker definers state them: REVOKE from PUBLIC and, in a loop, from every ludy_% role but the migration's own, then EXECUTE to ludy_worker only.
-- Also a correction of a comment of 20270327210000_ludy_meetings_tracker_hits_helper.sql (an applied file is not edited): the callers of ludy_meetings.tracker_hits_in are the two worker-only definers
-- ludy_meetings.tracker_alert_hits and ludy_meetings.weekly_tracked_hits (that comment names ludy_meetings.weekly_notices_due, which never calls it). Nothing else changes: same context gate (NO_CONTEXT unless the actor
-- is the system and p_org_id is the context's org), same reader rule, 50 newest meetings, 7 days, at most 999, NULL when the org keeps no tracked word.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.weekly_tracked_hits(
  p_org_id uuid,
  p_user_id uuid,
  p_now timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The context gate of tracker_alert_hits and minutes_wake_open: only the system's own command, in the org it asks about. A worker context of another org (or none) cannot ask for a member's count.
  IF ludy_kernel.ctx_org_id() IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR p_org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- Meetings is on for the org, the org is active and the member's account is not disabled: else no count (the due definer decides the same before a notice is ever built; this definer does not rely on that).
  IF NOT ludy_kernel.org_app_on(p_org_id, 'meetings')
     OR NOT EXISTS (SELECT 1 FROM ludy_kernel.tenant t WHERE t.org_id = p_org_id AND t.status = 'active')
     OR NOT EXISTS (SELECT 1 FROM ludy_kernel.user_account u WHERE u.id = p_user_id AND u.disabled_at IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN (
  WITH scoped AS (
    -- The member's scope as enter_context seals it (the same rule as the due definer): the whole org for an owner or an admin, for a member with an org-wide role assignment and for one with no assignment at all;
    -- a member limited to some legal entities reads an org-visible meeting only through a reader row (the policy's '*' branch).
    SELECT (m.role IN ('owner', 'admin')
            OR NOT EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id)
            OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment a WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND a.legal_entity_id IS NULL)) AS whole_org
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = p_org_id AND m.user_id = p_user_id AND m.role IN ('owner', 'admin', 'member')
  ),
  readable AS (
    -- The meetings the weekly counts read for this member (days = 7): readable, started in the last seven days, not past the text date, with a published result or a published action item; newest first.
    SELECT mt.id AS meeting_id,
           pg_catalog.row_number() OVER (ORDER BY mt.started_at DESC, mt.id) AS rn
    FROM scoped s
    JOIN ludy_meetings.meeting mt ON mt.org_id = p_org_id
    WHERE mt.started_at >= COALESCE(p_now, pg_catalog.now()) - pg_catalog.make_interval(days => 7)
      AND (mt.text_retention_date IS NULL OR mt.text_retention_date > (COALESCE(p_now, pg_catalog.now()) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
      AND (
        mt.recorder_user_id = p_user_id
        OR (mt.visibility = 'org' AND s.whole_org)
        OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.user_id = p_user_id)
      )
      AND (
        EXISTS (SELECT 1 FROM ludy_meetings.meeting_result r WHERE r.org_id = mt.org_id AND r.meeting_id = mt.id AND r.stage = 'published')
        OR EXISTS (SELECT 1 FROM ludy_meetings.action_item a WHERE a.org_id = mt.org_id AND a.meeting_id = mt.id AND a.stage = 'published')
      )
  )
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM scoped) AND EXISTS (SELECT 1 FROM ludy_meetings.tracker_term x WHERE x.org_id = p_org_id)
           THEN LEAST(999, COALESCE((
             SELECT pg_catalog.sum(h.hits)
             FROM readable r
             CROSS JOIN LATERAL ludy_meetings.tracker_hits_in(p_org_id, r.meeting_id) h
             WHERE r.rn <= 50
           ), 0))::integer
         END
  );
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz) TO ludy_worker;
