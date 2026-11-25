-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (issue #3388, ADR-0047 point 7): worker-only org export readers for the content and readers of meetings
-- shared with the whole org (ludy_meetings.transcript_segment, meeting_result, action_item, meeting_reader).
-- Only meetings with visibility = 'org' whose text retention period has not ended (text_retention_date IS NULL or
-- strictly after today in Asia/Ho_Chi_Minh) are included; transcript segments, results, and action items also require
-- stage = 'published' (never drafts). Attendees-only meetings, recordings (audio_segment, meeting_video), and expired
-- or draft rows stay out. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_transcript_export_rows()
RETURNS SETOF ludy_meetings.transcript_segment
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s.*
    FROM ludy_meetings.transcript_segment s
    JOIN ludy_meetings.meeting m ON m.org_id = s.org_id AND m.id = s.meeting_id
    WHERE s.org_id = v_org
      AND m.visibility = 'org'
      AND s.stage = 'published'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
    ORDER BY s.meeting_id, s.start_seconds, s.id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_transcript_export_rows() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_result_export_rows()
RETURNS SETOF ludy_meetings.meeting_result
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT r.*
    FROM ludy_meetings.meeting_result r
    JOIN ludy_meetings.meeting m ON m.org_id = r.org_id AND m.id = r.meeting_id
    WHERE r.org_id = v_org
      AND m.visibility = 'org'
      AND r.stage = 'published'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
    ORDER BY r.created_at, r.id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_result_export_rows() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_action_item_export_rows()
RETURNS SETOF ludy_meetings.action_item
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT i.*
    FROM ludy_meetings.action_item i
    JOIN ludy_meetings.meeting m ON m.org_id = i.org_id AND m.id = i.meeting_id
    WHERE i.org_id = v_org
      AND m.visibility = 'org'
      AND i.stage = 'published'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
    ORDER BY i.meeting_id, i.transcript_seconds NULLS LAST, i.created_at, i.id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_action_item_export_rows() FROM PUBLIC;

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_reader_export_rows()
RETURNS SETOF ludy_meetings.meeting_reader
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT r.*
    FROM ludy_meetings.meeting_reader r
    JOIN ludy_meetings.meeting m ON m.org_id = r.org_id AND m.id = r.meeting_id
    WHERE r.org_id = v_org
      AND m.visibility = 'org'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
    ORDER BY r.meeting_id, r.created_at, r.id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_reader_export_rows() FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION '
      || 'ludy_kernel.meeting_transcript_export_rows(), '
      || 'ludy_kernel.meeting_result_export_rows(), '
      || 'ludy_kernel.meeting_action_item_export_rows(), '
      || 'ludy_kernel.meeting_reader_export_rows() '
      || 'FROM %I',
      r.rolname
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  ludy_kernel.meeting_transcript_export_rows(),
  ludy_kernel.meeting_result_export_rows(),
  ludy_kernel.meeting_action_item_export_rows(),
  ludy_kernel.meeting_reader_export_rows()
  TO ludy_tenant;
