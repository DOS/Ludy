-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings read opt-in for member-scoped Vy (#5073 Step 2a, ADR-0049 decision 2 amendment):
--   ludy_kernel.member_vy_table            registers the five read-only Meetings tables (meeting, meeting_result, action_item,
--                                          meeting_link, calendar_agenda) with mode = 'read'.
--   ludy_meetings.is_agent_meeting_reader  narrow boolean SECURITY DEFINER helper (no user id parameter) binding an active
--                                          member-scoped agent and its live run in the context org to an active non-viewer
--                                          tenant member (owner, admin, or member), checking recorder, org visibility with '*'
--                                          legal-entity scope, or explicit meeting_reader grant while keeping is_meeting_reader
--                                          and is_meeting_recorder strictly user-only.
--   5 restrictive FOR SELECT policies      meeting_read, meeting_result_read, action_item_read, meeting_link_read, and
--                                          calendar_agenda_read preserve the existing user and mcp_company branches and admit
--                                          member-scoped agent reads restricted to published results/items, active non-viewer
--                                          roles, and the member's legal-entity scope. Write policies stay strictly user-only.
-- Idempotent; applied migrations stay untouched.
SET LOCAL lock_timeout = '2s';

-- migration-lint: cross-module register the five opt-in Meetings read tables in ludy_kernel.member_vy_table (#5073, ADR-0049)
INSERT INTO ludy_kernel.member_vy_table (table_name, mode, adr) VALUES
  ('ludy_meetings.meeting', 'read', 'ADR-0049 decision 2'),
  ('ludy_meetings.meeting_result', 'read', 'ADR-0049 decision 2'),
  ('ludy_meetings.action_item', 'read', 'ADR-0049 decision 2'),
  ('ludy_meetings.meeting_link', 'read', 'ADR-0049 decision 2'),
  ('ludy_meetings.calendar_agenda', 'read', 'ADR-0049 decision 2')
ON CONFLICT (table_name) DO NOTHING;

CREATE OR REPLACE FUNCTION ludy_meetings.is_agent_meeting_reader(
  p_org_id uuid,
  p_meeting_id uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_agent uuid := ludy_kernel.ctx_agent_id();
  v_run uuid := ludy_kernel.ctx_run_id();
  v_user uuid;
  v_vis text;
  v_recorder uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'agent' OR v_agent IS NULL OR v_run IS NULL THEN
    RETURN false;
  END IF;
  SELECT a.member_user_id INTO v_user
  FROM ludy_kernel.agent a
  JOIN ludy_kernel.ai_run r ON r.org_id = a.org_id AND r.agent_id = a.id
  WHERE a.org_id = v_org
    AND a.id = v_agent
    AND a.kind = 'member_vy'
    AND a.status = 'active'
    AND a.member_user_id IS NOT NULL
    AND r.id = v_run
    AND r.status = 'running'
    AND r.expires_at > pg_catalog.now();
  IF v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant t
    JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id
    JOIN ludy_kernel.user_account u ON u.id = m.user_id
    WHERE t.org_id = v_org
      AND t.status = 'active'
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin', 'member')
      AND u.disabled_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  SELECT m.visibility, m.recorder_user_id INTO v_vis, v_recorder
  FROM ludy_meetings.meeting m
  WHERE m.org_id = v_org AND m.id = p_meeting_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_recorder = v_user THEN
    RETURN true;
  END IF;
  IF v_vis = 'org' AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM ludy_meetings.meeting_reader r
    WHERE r.org_id = v_org AND r.meeting_id = p_meeting_id AND r.user_id = v_user
  );
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.is_agent_meeting_reader(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' ESCAPE '\' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.is_agent_meeting_reader(uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.is_agent_meeting_reader(uuid, uuid) TO ludy_tenant;

DROP POLICY IF EXISTS meeting_read ON ludy_meetings.meeting;
CREATE POLICY meeting_read ON ludy_meetings.meeting AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_kernel.ctx_actor_type() = 'user'
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = meeting.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')
      )
      AND (
        recorder_user_id = (SELECT ludy_kernel.ctx_user_id())
        OR (
          visibility = 'org'
          AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
        )
        OR EXISTS (
          SELECT 1 FROM ludy_meetings.meeting_reader r
          WHERE r.org_id = meeting.org_id AND r.meeting_id = meeting.id AND r.user_id = (SELECT ludy_kernel.ctx_user_id())
        )
      )
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND visibility = 'org'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, id)
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, id)
    )
  );

DROP POLICY IF EXISTS meeting_result_read ON ludy_meetings.meeting_result;
CREATE POLICY meeting_result_read ON ludy_meetings.meeting_result AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND ludy_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
  );

DROP POLICY IF EXISTS action_item_read ON ludy_meetings.action_item;
CREATE POLICY action_item_read ON ludy_meetings.action_item AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_meetings.is_meeting_recorder(org_id, meeting_id)
      OR (stage = 'published' AND ludy_meetings.is_meeting_reader(org_id, meeting_id))
    )
    OR (
      stage = 'published'
      AND flags = '[]'::jsonb
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_verified() ->> 'kind') = 'mcp_company'
      AND '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
      AND ludy_meetings.is_org_minutes_meeting(org_id, meeting_id)
    )
    -- member_vy mirrors the member's own published action-item view (unlike org-wide mcp_company, which filters flags = '[]'::jsonb).
    OR (
      stage = 'published'
      AND ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
  );

DROP POLICY IF EXISTS meeting_link_read ON ludy_meetings.meeting_link;
CREATE POLICY meeting_link_read ON ludy_meetings.meeting_link AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    ludy_meetings.is_meeting_reader(org_id, meeting_id)
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND (SELECT ludy_kernel.ctx_acting_user_id()) IS NOT NULL
      AND ludy_meetings.is_agent_meeting_reader(org_id, meeting_id)
    )
  );

DROP POLICY IF EXISTS calendar_agenda_read ON ludy_meetings.calendar_agenda;
CREATE POLICY calendar_agenda_read ON ludy_meetings.calendar_agenda AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (
      ludy_kernel.ctx_actor_type() = 'user'
      AND user_id = ludy_kernel.ctx_user_id()
    )
    OR (
      ludy_kernel.ctx_actor_type() = 'agent'
      AND user_id = (SELECT ludy_kernel.ctx_acting_user_id())
      AND EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
        WHERE m.org_id = calendar_agenda.org_id
          AND m.user_id = (SELECT ludy_kernel.ctx_acting_user_id())
          AND m.role IN ('owner', 'admin', 'member')
      )
    )
  );
