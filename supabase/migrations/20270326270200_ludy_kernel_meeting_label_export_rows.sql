-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy kernel (issue #4955, ADR-0047 point 7): the worker-only org export reader for the labels of the meetings shared with the whole org (ludy_meetings.meeting_label, 20270326270000), as
-- ludy_kernel.meeting_link_export_rows() does for the links. Only meetings with visibility = 'org' whose text retention period has not ended (text_retention_date IS NULL or strictly after today in
-- Asia/Ho_Chi_Minh) are included; the labels of an attendees-only meeting stay out. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.meeting_label_export_rows()
RETURNS SETOF ludy_meetings.meeting_label
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.*
    FROM ludy_meetings.meeting_label l
    JOIN ludy_meetings.meeting m ON m.org_id = l.org_id AND m.id = l.meeting_id
    WHERE l.org_id = v_org
      AND m.visibility = 'org'
      AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
    ORDER BY l.meeting_id, l.created_at, l.id;
END $$;
REVOKE ALL ON FUNCTION ludy_kernel.meeting_label_export_rows() FROM PUBLIC;

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
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_kernel.meeting_label_export_rows() FROM %I', r.rolname);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION ludy_kernel.meeting_label_export_rows() TO ludy_worker;
