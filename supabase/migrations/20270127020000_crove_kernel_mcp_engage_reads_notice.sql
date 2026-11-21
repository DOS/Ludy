-- SPDX-License-Identifier: AGPL-3.0-only
-- Telling the people who connected an AI app before the Engage reads existed (issue #4069, follow-up of #4068; ADR-0051 decision 2; Platform PO update on the issue: no Platform change, the fix is Engage's own).
--
-- A grant that holds `ludy.read` reads, since #4068 and the E-series after it, the Hộp thư conversations (private messages and email too), the bookings and the ads results. The consent screen names
-- those reads (since #4068, in full since #4176, merged 2026-11-20 15:54 UTC), so a grant made after that was consented to with the reads on screen. A grant made before it was not: its owner is told once,
-- in the app. This step only tells; it widens no scope, changes no grant check and revokes nothing (the person decides on the AI connections screen).
--   crove_kernel.agent_grant.engage_reads_told_at   when the grantor of a live grant made before the cutoff was told (stamped by kernel.mcp.engage_reads_notify, once per grant, never reset).
--   crove_kernel.mcp_engage_reads_to_tell           the worker's scan, across active orgs, of the (org, person) pairs with such a grant not told yet, the person being a member now. Ids only.
--   crove_kernel.mcp_engage_reads_claim             the command's step: stamps that person's untold grants of the org in context and answers how many are company grants and how many member grants (so the
--                                                   notice says which reads each can do). System actor only; the grant table is definer-only, so nothing else writes the stamp.
-- agent_grant is definer-only and its write guard is untouched. No policy, no scope list and no check of mcp_grant_standing changes.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.agent_grant ADD COLUMN IF NOT EXISTS engage_reads_told_at timestamptz;

-- The scan reads this partial index: live grants not told yet, made before the cutoff. It is empty once everyone was told, and a grant made after the cutoff is never in it.
CREATE INDEX IF NOT EXISTS agent_grant_engage_untold_idx ON crove_kernel.agent_grant (org_id, user_id)
  WHERE revoked_at IS NULL AND engage_reads_told_at IS NULL AND created_at < timestamptz '2026-11-20 16:00:00+00';

CREATE OR REPLACE FUNCTION crove_kernel.mcp_engage_reads_to_tell(p_limit int)
RETURNS TABLE (org_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT g.org_id, g.user_id
  FROM crove_kernel.agent_grant g
  JOIN crove_kernel.tenant t ON t.org_id = g.org_id AND t.status = 'active'
  JOIN crove_kernel.tenant_member m ON m.org_id = g.org_id AND m.user_id = g.user_id
  WHERE g.revoked_at IS NULL AND g.engage_reads_told_at IS NULL AND g.created_at < timestamptz '2026-11-20 16:00:00+00'
    AND g.expires_at > pg_catalog.now() AND 'ludy.read' = ANY (g.scopes)
  ORDER BY g.org_id, g.user_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$$;

CREATE OR REPLACE FUNCTION crove_kernel.mcp_engage_reads_claim(p_user uuid)
RETURNS TABLE (company integer, member integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_company integer;
  v_member integer;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- Only a person who is a member now: one who left is told on their return, if the grant still stands then.
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org AND m.user_id = p_user) THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  WITH claimed AS (
    UPDATE crove_kernel.agent_grant g
       SET engage_reads_told_at = pg_catalog.clock_timestamp()
     WHERE g.org_id = v_org AND g.user_id = p_user
       AND g.revoked_at IS NULL AND g.engage_reads_told_at IS NULL AND g.created_at < timestamptz '2026-11-20 16:00:00+00'
       AND g.expires_at > pg_catalog.now() AND 'ludy.read' = ANY (g.scopes)
    RETURNING g.kind
  )
  SELECT pg_catalog.count(*) FILTER (WHERE c.kind = 'company')::integer, pg_catalog.count(*) FILTER (WHERE c.kind = 'member')::integer
    INTO v_company, v_member FROM claimed c;
  RETURN QUERY SELECT v_company, v_member;
END $$;

REVOKE ALL ON FUNCTION crove_kernel.mcp_engage_reads_to_tell(int), crove_kernel.mcp_engage_reads_claim(uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION crove_kernel.mcp_engage_reads_to_tell(int), crove_kernel.mcp_engage_reads_claim(uuid) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_engage_reads_to_tell(int) TO crove_worker;
GRANT EXECUTE ON FUNCTION crove_kernel.mcp_engage_reads_claim(uuid) TO crove_worker;
