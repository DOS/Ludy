-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #4582 note 2, from the independent security review of #4536): ludy_meetings.minutes_wake_open(org, meeting, now) answers whether the meeting of a published-minutes wake-up may still be announced.
-- It is a worker-only definer that took the org as an argument and trusted it. Like its sibling ludy_sign.webhook_delivery_get it now also holds the caller
-- to the org of the transaction: the system context must be set (ctx_org_id() is not null and ctx_actor_type() is 'system'), and p_org must be that org, or it raises NO_CONTEXT (42501). The only caller,
-- kernel.mcp.wake.minutes_targets (packages/kernel/src/mcp-wake.ts), runs as the system with the org's context, so nothing it does changes; a call for another org's meeting, or with no context, now fails
-- instead of answering one boolean about it. It only tightens: the answer, the grants (worker's login alone) and the search path are those of 20270317110000_ludy_meetings_minutes_wake_open.sql.
--
-- Body check: the SELECT is the previous definition's, word for word; the function was LANGUAGE sql and is now plpgsql only to be able to raise. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.minutes_wake_open(p_org uuid, p_meeting uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM ludy_meetings.meeting m
    WHERE m.org_id = p_org
      AND m.id = p_meeting
      AND m.visibility = 'org'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > ((p_now AT TIME ZONE 'UTC') + interval '7 hours')::date)
  );
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.minutes_wake_open(uuid, uuid, timestamptz) TO ludy_worker;
