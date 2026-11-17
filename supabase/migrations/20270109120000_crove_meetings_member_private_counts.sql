-- SPDX-License-Identifier: AGPL-3.0-only
-- The counts of a member's private meeting rows (#3584, from the review of #3194; ADR-0049): how many machine translations of meetings (crove_meetings.translation) and how many live preview lines
-- of the meetings they recorded (crove_meetings.live_line) each member holds, for the owner before they remove a member and for the erasure's answer, which names what it cannot read.
-- Counts only, ids and numbers, as crove_kernel.member_vy_private_counts() (which keeps its shape: its first file is re-applied by the migration check). The same door: an owner or admin of the
-- org in a user context, or the worker login in the org's system context; no member, no viewer, no agent. Idempotent.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.member_private_counts()
RETURNS TABLE (org_id uuid, member_user_id uuid, translations bigint, live_lines bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    IF NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
      RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  ELSIF crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT v_org, u.uid,
      (SELECT pg_catalog.count(*) FROM crove_meetings.translation t WHERE t.org_id = v_org AND t.member_user_id = u.uid),
      (SELECT pg_catalog.count(*) FROM crove_meetings.live_line l JOIN crove_meetings.meeting lm ON lm.org_id = l.org_id AND lm.id = l.meeting_id WHERE l.org_id = v_org AND lm.recorder_user_id = u.uid)
    FROM (SELECT z.member_user_id AS uid FROM crove_meetings.translation z WHERE z.org_id = v_org
          UNION SELECT wm.recorder_user_id FROM crove_meetings.live_line w JOIN crove_meetings.meeting wm ON wm.org_id = w.org_id AND wm.id = w.meeting_id WHERE w.org_id = v_org) u
    ORDER BY u.uid;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.member_private_counts() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.member_private_counts() TO crove_tenant;
