-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L4a follow-up (#3125, review of #3110): the live transcript preview (crove_meetings.live_line) goes on the 30 day draft expiry of 20261204100000.
-- The preview is the transcription of a recording that may never finish (the tab was closed and the final audio never uploaded): until now it stayed until the
-- meeting was deleted, the org was purged or a batch transcript replaced it. It is a draft by nature (tainted, the recorder's alone, never published), so it
-- follows the rule of the other drafts: 30 days from the line's created_at, an edit does not move it (a line is never updated).
--   crove_meetings.meeting_drafts_due(p_limit)                  restated from 20261204100000 (its newest body) with live_line as a fourth source
--   crove_meetings.meeting_draft_purge(p_org_id, p_meeting_id)  restated from 20261204100000 with the delete of the meeting's live lines past 30 days
-- Both keep their signature, their worker-only checks and their grants; only the lines above are added. The count the purge answers includes the lines. A
-- meeting that holds only preview lines (no summary, no action item, no draft transcript) is found by the due list, which is the case this closes.
-- Idempotent; applied files stay untouched.

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
    UNION ALL
    SELECT l.org_id, l.meeting_id, l.created_at FROM crove_meetings.live_line l
    WHERE l.created_at < pg_catalog.now() - interval '30 days'
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

-- How many draft rows (of the four tables together) it deleted: a count, never text.
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
  v_n := v_n + v_k;
  -- The live preview (#3125): the recorder's tainted lines of a recording that never finished.
  DELETE FROM crove_meetings.live_line
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) TO crove_worker;
