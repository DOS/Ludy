-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L2 (#2589, plan L2, ADR-0047 point 2 and its "Revisit when" on search): a folded search over the transcript lines a member reads.
--   crove_meetings.transcript_segment.search     the folded words of a line's text, a STORED GENERATED column, so it is never a second copy to keep in sync: it is
--                                                recomputed by every UPDATE of the text (a correction, a personal-data erase) and goes with its row (the meeting's delete,
--                                                the retention purge, the shred, the org purge: all cascades). Built with the folding finance search already uses
--                                                (crove_kernel.search_vector, migration 20261023060000: Vietnamese marks and đ removed, lower case), so "chiet khau" finds
--                                                "chiết khấu". No extension is added (the repo uses no pg_trgm or unaccent).
--   transcript_segment_search_idx                GIN over it. transcript_segment is not one of the hot tables of AGENTS.md (audit_event, outbox, crove_jobs), so a plain
--                                                CREATE INDEX IF NOT EXISTS applies.
--   crove_meetings.search_segment_ids(q, limit, offset)
--                                                the ids of the lines that hold every typed word (as a word prefix) and that the caller reads, newest meeting first.
-- Why a definer for the ids: row security checks a meeting's readers for every row it reads before any other test, and tsvector @@ is not leakproof, so a search under it
-- cannot use the GIN index first and pays the policy functions for every line of the org (ten seconds per 120 000 lines, measured for the L5 finder). The function finds the
-- hits by the index first and checks readability once per meeting that has a hit; the query (modules/meetings/src/search.ts) then reads the lines by id under row security,
-- which decides again for every row it returns. Callable in a user context only, of an owner, admin or member of the context's org (a viewer, an agent and the system
-- context raise 42501). The rule is the one transcript_segment_read states: the recorder reads every stage of their own meeting, any other reader only published lines;
-- an owner or admin who is no reader of an attendees-only meeting finds nothing in it. A meeting whose text period has ended (text_retention_date reached, in Vietnam's
-- day, as openMeeting decides) is left out before the nightly purge runs. Ids only, at most 51 a call, from offset 0 to 200, so no text and no unbounded answer leaves it.
-- A new column and a new function: no applied file is touched, and the return type is uuid, inside the definer walk of meetings-readers.db.test.ts.
SET LOCAL lock_timeout = '2s';

-- Adding a stored generated column rewrites the table once; row triggers do not fire for that.
ALTER TABLE crove_meetings.transcript_segment
  ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS (crove_kernel.search_vector(text)) STORED;

CREATE INDEX IF NOT EXISTS transcript_segment_search_idx ON crove_meetings.transcript_segment USING gin (search);

CREATE OR REPLACE FUNCTION crove_meetings.search_segment_ids(p_query text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
  v_q tsquery;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_query IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_limit < 1 OR p_limit > 51 OR p_offset < 0 OR p_offset > 200 THEN
    RAISE EXCEPTION 'MEETINGS_SEARCH_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Nothing left to match once folded (only marks or punctuation): no hit, and no row is read.
  v_q := crove_kernel.search_query(pg_catalog.left(p_query, 200));
  IF v_q IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.id AS seg_id, s.meeting_id, s.stage, s.start_seconds
      FROM crove_meetings.transcript_segment s
     WHERE s.org_id = v_org AND s.search @@ v_q
  ), readable AS MATERIALIZED (
    -- One readability check per meeting with a hit, not per line, and none for the caller's own meetings (the member role was checked above).
    SELECT m.id AS meeting_id, COALESCE(m.started_at, m.created_at) AS held_at, m.recorder_user_id = v_user AS is_recorder
      FROM crove_meetings.meeting m
     WHERE m.org_id = v_org
       AND m.id IN (SELECT h.meeting_id FROM hits h)
       AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
       AND (m.recorder_user_id = v_user OR crove_meetings.is_meeting_reader(v_org, m.id))
  )
  SELECT h.seg_id
    FROM hits h
    JOIN readable r ON r.meeting_id = h.meeting_id
   WHERE r.is_recorder OR h.stage = 'published'
   ORDER BY r.held_at DESC, r.meeting_id, h.start_seconds, h.seg_id
   OFFSET p_offset LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.search_segment_ids(text, integer, integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.search_segment_ids(text, integer, integer) TO crove_tenant;
