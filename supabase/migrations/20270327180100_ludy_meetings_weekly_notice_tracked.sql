-- SPDX-License-Identifier: AGPL-3.0-only
-- The weekly meetings notice (#4967) says one more number when the org keeps tracked words (#5019, plan docs/plan/meetings.md L22 x L28): how often those words came up in the published transcript lines of the
-- meetings the member reads (the same 50 newest meetings, reader rule and 7 day window as the other numbers). It is a NEW worker-only definer, ludy_meetings.weekly_tracked_hits, and ludy_meetings.weekly_notices_due
-- (20270327100000) is left exactly as it is: a function cannot gain an output column in place, and a dropped and recreated one cannot be replayed by the migration replay (each file must re-apply on its own).
-- The command calls it for the one member the due definer just returned, never the sweep's listing, because up to 50 meetings x 20000 lines x 20 terms for each of 200 members could outrun the worker's statement
-- timeout and keep every org from its notice. The counting is ludy_meetings.tracker_hits_in (20270327180000), the one statement of the matching rule shared with the tracker alert. It returns a number only
-- (no text, no jsonb, no id): NULL when the org keeps no tracked word or the member is not an active member, else at most 999. Grants as the other worker definers: EXECUTE to ludy_worker only.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.weekly_tracked_hits(
  p_org_id uuid,
  p_user_id uuid,
  p_now timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
$$;
REVOKE ALL ON FUNCTION ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz) TO ludy_worker;
