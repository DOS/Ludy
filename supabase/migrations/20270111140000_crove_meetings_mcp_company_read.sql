-- SPDX-License-Identifier: AGPL-3.0-only
-- What a company MCP grant may read of Meetings (#3731, owner decision 2026-11-18, ADR-0051; design and Meetings PO review on the issue). The three read policies are restated with one more way in,
-- for the sealed company context (kind `mcp_company`: an agent-shaped, read-only, tainted R0 context of an owner's or admin's company grant) and for nothing else:
--   meeting          a meeting of visibility 'org', and only with the whole-org scope ('*' in ctx_le_scope, as for a person: an entity-limited context reads no org meeting);
--   meeting_result   a PUBLISHED result of such a meeting;
--   action_item      a PUBLISHED item of such a meeting.
-- Everything else stays out of the context's reach, as today: the transcript, notes, drafts, translations, live lines, readers, consent records and every other table of the module have no such branch,
-- an attendees-only meeting is not read even when the grantor recorded it, a member grant (kind `mcp_member`) has no branch at all, and no write policy changes. The kind is read inline from the sealed
-- context through crove_meetings.sealed_kind(), which returns the kind and names none, so no function names the company kind (the invariant of mcp-company-context holds) and no policy text
-- carries `ctx_verified` beside the role literal 'member' (the net of member-vy-background that looks for a policy reading the sealed member would otherwise match the role list); the existing
-- branch for a person is kept unchanged inside each policy. Idempotent (drop and create, as the first migration of these policies did). Pinned first in test/invariant/mcp-meetings-company.db.test.ts.
SET LOCAL lock_timeout = '2s';

-- The kind of the sealed context of this transaction ('mcp_company', 'mcp_member', or NULL for a person, the system and an org-chart agent). An invoker function: it grants nothing and reads only
-- what ctx_verified() answers (which raises on a context that does not verify), and a policy compares the answer with the kind it names.
CREATE OR REPLACE FUNCTION crove_meetings.sealed_kind() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT crove_kernel.ctx_verified() ->> 'kind'
$$;
REVOKE ALL ON FUNCTION crove_meetings.sealed_kind() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.sealed_kind() TO crove_tenant;

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
      AND (SELECT crove_meetings.sealed_kind()) = 'mcp_company'
      AND visibility = 'org'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
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
      AND (SELECT crove_meetings.sealed_kind()) = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND EXISTS (
        SELECT 1 FROM crove_meetings.meeting m
        WHERE m.org_id = meeting_result.org_id AND m.id = meeting_result.meeting_id AND m.visibility = 'org'
      )
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
      AND crove_kernel.ctx_actor_type() = 'agent'
      AND (SELECT crove_meetings.sealed_kind()) = 'mcp_company'
      AND '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
      AND EXISTS (
        SELECT 1 FROM crove_meetings.meeting m
        WHERE m.org_id = action_item.org_id AND m.id = action_item.meeting_id AND m.visibility = 'org'
      )
    )
  );
