-- SPDX-License-Identifier: AGPL-3.0-only
-- Tighten what the sealed company context reads of Meetings (#3790, notes N1 of the post-merge security review of #3745). The first migration (20270115190000) let the context read every row of an org-visible
-- meeting, and the query narrowed it; the database should hold the line itself. This migration only tightens (no new way in, no write policy changes):
--   meeting          an org-visible meeting only when it has a PUBLISHED result and its text period has not ended (text_retention_date is null, or later than today in Vietnam, the day the commands and the nightly
--                    job use); a draft-only or past-period meeting is no longer read, though a purge may not have run yet;
--   meeting_result   a published result of such a meeting (as before, now with the period);
--   action_item      a published item of such a meeting that no flag marks (`flags = '[]'`), as the query already leaves out a flagged item: a person reviews it in the app.
-- One definer, crove_meetings.is_org_minutes_meeting(org, meeting), holds the shared test (org visibility, a published result, the text period). It is needed because the meeting policy reads the result and the
-- result policy reads the meeting, which Postgres refuses as infinite recursion; the module's other definers (is_meeting_reader, is_meeting_recorder) break the same cycle the same way. It reads the context
-- only through its org and actor type (an agent actor; a person has the branches of the first migration), names no kind, and returns a boolean. The kind itself stays an inline comparison in the three policies
-- (`ctx_verified() ->> 'kind'`), the exact exception the invariants allow; nothing here adds one.
-- What stays readable, stated plainly: the company context still reads whole rows of a meeting it may read, so the columns of that row (the recorder's id, the consent columns, extension_token_id, the
-- retention dates, the template name and the rest) are reachable at the database layer for those meetings; the query projection is what leaves them out (its keys are pinned in
-- meetings-mcp-projection.db.test.ts). The consent records and the readers are other tables and have no branch. The earlier comment saying consent records are out of reach meant those tables, not the consent
-- columns of the meeting row.
-- Idempotent (create or replace, drop and create). Pinned in test/invariant/mcp-meetings-company.db.test.ts.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.is_org_minutes_meeting(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  -- A person reads through the policies' own branches; only an agent context asks this.
  IF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM crove_meetings.meeting m
    JOIN crove_meetings.meeting_result r ON r.org_id = m.org_id AND r.meeting_id = m.id AND r.stage = 'published'
    WHERE m.org_id = v_org
      AND m.id = p_meeting_id
      AND m.visibility = 'org'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
  );
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.is_org_minutes_meeting(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crove_meetings.is_org_minutes_meeting(uuid, uuid) TO crove_tenant;

DROP POLICY IF EXISTS meeting_read ON crove_meetings.meeting;
CREATE POLICY meeting_read ON crove_meetings.meeting AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (
      crove_kernel.ctx_actor_type() = 'user'
      AND EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')
      )
      AND (
        recorder_user_id = (SELECT crove_kernel.ctx_user_id())
        OR (
          visibility = 'org'
          AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
        )
        OR EXISTS (
          SELECT 1 FROM crove_meetings.meeting_reader r
          WHERE r.org_id = meeting.org_id AND r.meeting_id = meeting.id AND r.user_id = (SELECT crove_kernel.ctx_user_id())
        )
      )
    )
    OR (
      crove_kernel.ctx_actor_type() = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND visibility = 'org'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND crove_meetings.is_org_minutes_meeting(org_id, id)
    )
  );

DROP POLICY IF EXISTS meeting_result_read ON crove_meetings.meeting_result;
CREATE POLICY meeting_result_read ON crove_meetings.meeting_result AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (
      crove_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND crove_kernel.ctx_actor_type() = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND crove_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
  );

DROP POLICY IF EXISTS action_item_read ON crove_meetings.action_item;
CREATE POLICY action_item_read ON crove_meetings.action_item AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (
      crove_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND flags = '[]'::jsonb
      AND crove_kernel.ctx_actor_type() = 'agent'
      AND (SELECT crove_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND crove_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
  );
