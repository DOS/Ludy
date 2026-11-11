-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2587, ADR-0047 point 7): what the org export carries of the links of meetings (crove_meetings.meeting_link, 20261222000000): those of the meetings
-- shared with the whole org, as crove_kernel.meeting_export_rows() does for the meetings; never a link of an attendees-only meeting. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_kernel.meeting_link_export_rows()
RETURNS SETOF crove_meetings.meeting_link LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.* FROM crove_meetings.meeting_link l
    JOIN crove_meetings.meeting m ON m.org_id = l.org_id AND m.id = l.meeting_id
    WHERE l.org_id = v_org AND m.visibility = 'org'
    ORDER BY l.created_at, l.id;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.meeting_link_export_rows() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_kernel.meeting_link_export_rows() TO crove_tenant;
