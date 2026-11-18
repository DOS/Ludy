-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings chapters (#3844, owner direction of 2026-11-18, ADR-0049 stage A): "Mục lục", the table of contents of a meeting, each chapter a short title and the second of the transcript line it
-- starts at. This step is the table, typed by hand by the recorder, published with the minutes and read by the meeting's readers; the recorder's own Vy fills it in a later step (the columns
-- `tainted` and `source_run_id` are here now, with the rules, so nothing is added to the table then). Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_chapter  one row per chapter: `stage` draft or published, `position` (1 to 20, in the order of the start), `title` (1 to 80 characters, one line), `start_seconds` (0 to 86400, a
--                                 whole second that the command checks against a real line of the meeting's transcript), `tainted` and `source_run_id` (as meeting_result: a row copied from a Vy
--                                 run is born tainted, the run never changes, only the recorder's review clears the taint). The same rules as meeting_result: the recorder reads and writes drafts and
--                                 reads published rows; a reader of the meeting reads published rows only; a row is born a draft; a published row is not edited (a new draft replaces it at the next publish).
--                                 These rules are in the row policies below, not in the queries, and every policy admits a user context only: an agent context (a member Vy run included), the system
--                                 context and the sealed company context read and write none. A row goes with its meeting (ON DELETE CASCADE: the recorder's delete, an owner's delete, the retention
--                                 shred, the org purge). A title holds no email address and no run of 8 or more digits (the command checks it, on every write), so the personal-data finder's probes
--                                 cannot match it.
-- crove_meetings.meeting_chapter_taint()   the trigger function: the insert and update rules of meeting_result_taint (20261217100000), for this table.
-- crove_meetings.meeting_drafts_due / meeting_draft_purge   restated from 20261230010000 (their newest bodies) with the draft chapters as a fifth source: a draft the recorder never published goes after 30
--                                 days, as every other draft does. Same signatures, worker-only checks and grants.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.meeting_chapter (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published')),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  title text NOT NULL CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 80 AND title OPERATOR(pg_catalog.!~) '[\r\n]'),
  start_seconds integer NOT NULL CHECK (start_seconds BETWEEN 0 AND 86400),
  tainted boolean NOT NULL DEFAULT false,
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_chapter_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_chapter_position_uq UNIQUE (org_id, meeting_id, stage, position),
  CONSTRAINT meeting_chapter_second_uq UNIQUE (org_id, meeting_id, stage, start_seconds)
);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_chapter');
REVOKE UPDATE ON crove_meetings.meeting_chapter FROM crove_tenant;
GRANT UPDATE (title, start_seconds, position, stage, updated_at) ON crove_meetings.meeting_chapter TO crove_tenant;

-- The recorder reads every stage; a reader of the meeting reads published rows only (a user context only: ctx_actor_type() is 'user' for a signed-in member alone).
DROP POLICY IF EXISTS meeting_chapter_read ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_read ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND (crove_meetings.is_meeting_recorder(org_id, meeting_id) OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))));
-- Only the recorder inserts, and only drafts.
DROP POLICY IF EXISTS meeting_chapter_insert ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_insert ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
-- The recorder edits a draft and publishes it (draft to published, the one change of stage); a published row is not edited here.
DROP POLICY IF EXISTS meeting_chapter_update ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_update ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND stage IN ('draft', 'published') AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
-- The recorder deletes a draft of the set, and the published set when they publish another.
DROP POLICY IF EXISTS meeting_chapter_delete ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_delete ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The taint rules of meeting_result (20261217100000), for this table: a row that comes from a run is born tainted and the run never changes; the taint is cleared only by the recorder's review
-- (crove_meetings.draft_review, restated for this table when the chapters run lands) and never set again; a tainted draft is not published. A hand-typed chapter has no run and is never tainted.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_chapter_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage = 'published' AND NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_run_id IS NOT NULL AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_run_id IS DISTINCT FROM OLD.source_run_id THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.tainted IS DISTINCT FROM OLD.tainted AND (NEW.tainted OR current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_meetings.draft_review(uuid,uuid,uuid[])'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF OLD.stage = 'draft' AND NEW.stage = 'published' AND NEW.tainted THEN
    RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_chapter_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS meeting_chapter_taint ON crove_meetings.meeting_chapter;
CREATE TRIGGER meeting_chapter_taint BEFORE INSERT OR UPDATE ON crove_meetings.meeting_chapter
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_chapter_taint();

-- The 30 day draft expiry, with the draft chapters as a source.
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
    UNION ALL
    SELECT c.org_id, c.meeting_id, c.created_at FROM crove_meetings.meeting_chapter c
    WHERE c.stage = 'draft' AND c.created_at < pg_catalog.now() - interval '30 days'
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

-- How many draft rows (of the five tables together) it deleted: a count, never text.
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
  v_n := v_n + v_k;
  -- The draft chapters (#3844): hand-typed or copied from the recorder's own Vy, never published.
  DELETE FROM crove_meetings.meeting_chapter
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) TO crove_worker;
