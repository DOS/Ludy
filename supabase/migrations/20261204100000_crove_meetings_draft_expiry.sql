-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings M6 part C (#2580): a draft the recorder never published goes after 30 days (ADR-0047 point 8, ADR-0049's rule for results).
--   crove_meetings.meeting_drafts_due(p_limit)            the meetings that hold a draft row older than 30 days (worker only, ids only)
--   crove_meetings.meeting_draft_purge(p_org_id, p_meeting_id)  deletes those draft rows of one meeting in the org's own system context
-- Only rows of stage 'draft' go, each by one statement that tests the stage and the age itself, so a row the recorder published a moment before (or while)
-- the statement runs is never deleted: in READ COMMITTED a statement that meets a row another transaction just changed re-reads it and drops it from the
-- match. Published rows follow the meeting's text date (meetings_due). The 30 days count from the row's created_at; an edit of a row in place does not move it, while a new transcription or a saved summary replaces rows and so starts the count again. An accepted draft item is deleted too, and the task made from it keeps a link to an item that is gone.
-- Nothing here edits an applied function: both are new. No index: the scan runs once a night over small tables.

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.meeting_drafts_due(p_limit integer)
RETURNS TABLE (org_id uuid, meeting_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.org_id, d.meeting_id
  FROM (
    SELECT r.org_id, r.meeting_id, r.created_at FROM crove_meetings.meeting_result r
    WHERE r.stage = 'draft' AND r.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT a.org_id, a.meeting_id, a.created_at FROM crove_meetings.action_item a
    WHERE a.stage = 'draft' AND a.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT s.org_id, s.meeting_id, s.created_at FROM crove_meetings.transcript_segment s
    WHERE s.stage = 'draft' AND s.created_at < pg_catalog.now() - interval '30 days'
  ) d
  -- Only orgs a system context can enter (active, or offboarding before its purge).
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status IN ('active', 'offboarding')
  GROUP BY d.org_id, d.meeting_id
  ORDER BY pg_catalog.min(d.created_at), d.org_id, d.meeting_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_drafts_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_drafts_due(integer) TO crove_worker;

-- How many draft rows (of the three tables together) it deleted: a count, never text.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_draft_purge(p_org_id uuid, p_meeting_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_meetings.action_item
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  DELETE FROM crove_meetings.meeting_result
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  DELETE FROM crove_meetings.transcript_segment
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) TO crove_worker;
