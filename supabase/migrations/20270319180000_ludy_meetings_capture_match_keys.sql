-- SPDX-License-Identifier: AGPL-3.0-only
-- Look up open or ended capture sessions matching canonical call meeting keys for platform recording deduplication
-- without exposing recorder identities, capture kinds, or invisible/expired meetings (ADR-0055 section 3.4, issue #4572).
-- Returns metadata scalars only (`key_index integer, meeting_id uuid`), complying with meetings-readers.db.test.ts.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS capture_session_org_key_idx
  ON ludy_meetings.capture_session (org_id, meeting_key)
  WHERE meeting_key IS NOT NULL;

CREATE OR REPLACE FUNCTION ludy_meetings.capture_session_match_keys(p_keys text[])
RETURNS TABLE (key_index integer, meeting_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_vn_today date := ((pg_catalog.now() AT TIME ZONE 'UTC') + interval '7 hours')::date;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' THEN
    RETURN;
  END IF;
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_keys) > 100 THEN
    RAISE EXCEPTION 'MEETING_PLATFORM_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member tm
    WHERE tm.org_id = v_org AND tm.user_id = v_user AND tm.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT u.ord::integer AS key_index, cs.meeting_id
    FROM pg_catalog.unnest(p_keys) WITH ORDINALITY AS u(meeting_key, ord)
    JOIN ludy_meetings.capture_session cs
      ON cs.org_id = v_org
     AND cs.meeting_key = u.meeting_key
    JOIN ludy_meetings.meeting m
      ON m.org_id = cs.org_id
     AND m.id = cs.meeting_id
    WHERE u.meeting_key ~ '^[0-9a-f]{64}$'
      AND m.started_at IS NOT NULL
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_vn_today)
      AND ludy_meetings.is_meeting_reader(v_org, cs.meeting_id);
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.capture_session_match_keys(text[]) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%') AND rolname <> current_user AND rolname <> 'ludy_tenant' LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.capture_session_match_keys(text[]) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.capture_session_match_keys(text[]) TO ludy_tenant;
