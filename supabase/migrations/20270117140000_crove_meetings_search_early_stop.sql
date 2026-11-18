-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L2 (#2589) and A3 (#3161): the search stops at the first page when a word is common, instead of reading every line that holds it (#3843).
--   crove_meetings.search_segment_ids(q, limit, offset)   restated from 20261226000000 with the same signature, owner, search_path, grants, checks and answer; only how it finds the page changes.
-- Why: the definer collected every line of the org that holds the typed words (a MATERIALIZED set), then asked which meetings the caller reads, then sorted all the readable hits by meeting date to
-- return the first 21. A common word ("giá" in a sales company) matches most lines of a large org, so a page cost the whole org's hits: 0.4 to 0.65 s a search and 0.8 to 1.7 s a question to Vy
-- (up to seven passes) on 2 000 meetings and 500 000 lines, whoever asked and however few meetings they read. The answer is the first page of an ordered list, newest meeting first, so it can be read
-- in that order and stopped as soon as the page is full.
-- How, and what does not change:
--   - Which lines are returned, and in which order, are exactly what they were: the lines that hold every typed word, in a meeting the caller reads (the recorder: every stage of their own meeting;
--     any other reader: published lines of a meeting they read; an owner or admin who is no reader finds nothing; a meeting past its text date is left out), newest meeting first (the meeting's held
--     date, then its id), then the line's start, then its id; from the offset, at most the limit. The readability test is the same expression, and it is applied again by row security when the query
--     reads the returned ids (modules/meetings/src/search.ts), as before.
--   - First the meetings are visited in the order of the answer, at most 300 looked at and at most 40 of them that the caller reads, and in each the lines that hold the words are taken in their order, until the page (offset and limit)
--     is full. A common word fills the page in the first meetings. When those meetings were not enough (the words are rare, or are held mostly by meetings the caller cannot read), the old way is used: all the
--     lines that hold the words found by the index, the readable meetings among those with a hit, one sort. It is the cheaper way when little matches, and it is the statement that was here before,
--     unchanged, so the answer is the same by construction; the early way only ever returns the same first lines.
-- Numbers and ids only, as before. A restated function: the applied file is untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.search_segment_ids(p_query text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
  v_q tsquery;
  v_ids uuid[] := '{}';
  v_seen integer := 0;
  v_visited integer := 0;
  v_exhausted boolean := true;
  v_meeting record;
  v_line record;
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
  -- Nothing left to match once folded (only marks or punctuation), or no word of two characters or more (a one-letter prefix would match most lines of every org
  -- before the org is filtered): no hit, and no row is read.
  v_q := crove_kernel.search_query(pg_catalog.left(p_query, 200));
  IF v_q IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(crove_kernel.search_fold(pg_catalog.left(p_query, 200)), ' ')) AS w WHERE pg_catalog.char_length(w) >= 2
  ) THEN
    RETURN;
  END IF;
  -- The early way: the meetings the caller reads, newest first, and in each the lines that hold the words in their order, until the page is full or the limits above are reached.
  FOR v_meeting IN
    SELECT m.id AS meeting_id, m.recorder_user_id = v_user AS is_recorder
      FROM crove_meetings.meeting m
     WHERE m.org_id = v_org
       AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
     ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.id
  LOOP
    -- At most 300 meetings looked at, readable or not (a readability check costs about as much as a small query), so a caller who reads few meetings does not pay a check for every meeting of the org.
    v_seen := v_seen + 1;
    IF v_seen > 300 THEN
      v_exhausted := false;
      EXIT;
    END IF;
    IF NOT (v_meeting.is_recorder OR crove_meetings.is_meeting_reader(v_org, v_meeting.meeting_id)) THEN
      CONTINUE;
    END IF;
    v_visited := v_visited + 1;
    IF v_visited > 40 THEN
      v_exhausted := false;
      EXIT;
    END IF;
    -- (x.search || '') is not the indexed column, so the planner reads this meeting's lines by their own index and never the org-wide index over the words, which costs more than the lines of one meeting.
    FOR v_line IN
      SELECT x.id AS seg_id
        FROM crove_meetings.transcript_segment x
       WHERE x.org_id = v_org AND x.meeting_id = v_meeting.meeting_id AND (x.search || ''::tsvector) @@ v_q AND (v_meeting.is_recorder OR x.stage = 'published')
       ORDER BY x.start_seconds, x.id
    LOOP
      v_ids := v_ids || v_line.seg_id;
      EXIT WHEN pg_catalog.cardinality(v_ids) >= p_offset + p_limit;
    END LOOP;
    EXIT WHEN pg_catalog.cardinality(v_ids) >= p_offset + p_limit;
  END LOOP;
  -- The page is full, or every meeting the caller reads was visited: the answer is complete.
  IF v_exhausted OR pg_catalog.cardinality(v_ids) >= p_offset + p_limit THEN
    RETURN QUERY SELECT u.seg_id FROM pg_catalog.unnest(v_ids) WITH ORDINALITY AS u(seg_id, n) ORDER BY u.n OFFSET p_offset LIMIT p_limit;
    RETURN;
  END IF;
  -- The old way (20261226000000), for words that 40 meetings did not fill: every line that holds the words, found by the index.
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
