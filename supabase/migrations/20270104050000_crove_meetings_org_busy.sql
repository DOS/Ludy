-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Meetings (issue #3310, ADR-0053 slice c, C3a): what keeps Meetings from being switched off for an org. Idempotent; applied files stay untouched.
--
-- crove_meetings.org_busy_reasons(org, window_hours) answers the reasons Meetings is busy for the org of the caller's context: 'recording' (a ready meeting not ended
-- and started within the window a recording can last) and 'import' (a recording of a meeting platform being fetched or waiting to be claimed). kernel.org.set_app
-- asks it when an owner or admin turns Meetings off. It is a definer because the rows are not the switcher's to read: a meeting is visible only to its recorder and
-- readers (the meeting_read policy) and a platform recording only to its member, so a recording another member started would not be seen under the switcher's own
-- context, and the switch would cut it off. It answers codes only, never a row, and refuses an org other than the context's.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.org_busy_reasons(p_org uuid, p_window_hours integer)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reasons text[] := '{}';
BEGIN
  IF crove_kernel.ctx_org_id() IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RAISE EXCEPTION 'MEETINGS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  IF p_window_hours IS NULL OR p_window_hours NOT BETWEEN 1 AND 48 THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_meetings.meeting m
    WHERE m.org_id = p_org AND m.status = 'ready' AND m.ended_at IS NULL AND m.started_at > pg_catalog.now() - pg_catalog.make_interval(hours => p_window_hours)
  ) THEN
    v_reasons := pg_catalog.array_append(v_reasons, 'recording'::text);
  END IF;
  IF EXISTS (
    SELECT 1 FROM crove_kernel.meeting_platform_recording r WHERE r.org_id = p_org AND r.status IN ('importing', 'staged', 'claimed')
  ) THEN
    v_reasons := pg_catalog.array_append(v_reasons, 'import'::text);
  END IF;
  RETURN v_reasons;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.org_busy_reasons(uuid, integer) FROM PUBLIC, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.org_busy_reasons(uuid, integer) TO crove_tenant;
