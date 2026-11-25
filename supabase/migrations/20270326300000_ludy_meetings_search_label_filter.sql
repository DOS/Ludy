-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L2 (#2589), labels (#4955), #4965: the search across meetings filters by a label of the meeting on the server, so a page is filled with the hits of the labelled meetings, where it used to be cut
-- afterwards in the browser (a page could hold fewer hits, or none, though more lay on the next pages).
--   ludy_meetings.search_segment_ids(q, limit, offset, label)   new: the body of the function below as 20270326240000 left it (one stage per meeting for the recorder), with one more argument. A label (NULL: none)
--       keeps only the meetings that carry it (the same label whatever the case: the unique index of the labels is on lower(label)), in the early way and in the old way alike; the label is looked up by that index
--       per meeting, so no index is added. A label of 0 or more than 40 characters is refused (22023). Which meetings the caller reads, the text date, the order, the paging and the answer (ids only) are unchanged.
--   ludy_meetings.search_segment_ids(q, limit, offset)           restated as the call of the one above with no label: the same signature, owner, search_path and grants as before, so every caller (the question
--       box of Ask Vy among them) and every test of it stays as it was.
-- Same owner, search_path and grants for both: revoked from PUBLIC and every ludy_ role, then EXECUTE to ludy_tenant. Numbers and ids only. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.search_segment_ids(p_query text, p_limit integer, p_offset integer, p_label text)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_today date := (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
  v_q tsquery;
  v_label text;
  v_ids uuid[] := '{}';
  v_seen integer := 0;
  v_visited integer := 0;
  v_exhausted boolean := true;
  v_meeting record;
  v_stage text;
  v_line record;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_query IS NULL OR p_limit IS NULL OR p_offset IS NULL OR p_limit < 1 OR p_limit > 51 OR p_offset < 0 OR p_offset > 200 THEN
    RAISE EXCEPTION 'MEETINGS_SEARCH_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A label filter (#4965): the label as the unique index of the labels folds it (lower case, no edge spaces), 1 to 40 characters; none is no filter. Only the meetings that carry it are looked at, in the early way
  -- and in the old way alike, so a page is filled with the hits of the labelled meetings and never cut after the page was read. A label is read by the people who read its meeting, who are the ones this function
  -- keeps, so the check below adds no door.
  IF p_label IS NOT NULL THEN
    v_label := pg_catalog.lower(pg_catalog.btrim(p_label));
    IF pg_catalog.char_length(v_label) NOT BETWEEN 1 AND 40 THEN
      RAISE EXCEPTION 'MEETINGS_SEARCH_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Nothing left to match once folded (only marks or punctuation), or no word of two characters or more (a one-letter prefix would match most lines of every org
  -- before the org is filtered): no hit, and no row is read.
  v_q := ludy_kernel.search_query(pg_catalog.left(p_query, 200));
  IF v_q IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(ludy_kernel.search_fold(pg_catalog.left(p_query, 200)), ' ')) AS w WHERE pg_catalog.char_length(w) >= 2
  ) THEN
    RETURN;
  END IF;
  -- The early way: the meetings the caller reads, newest first, and in each the lines that hold the words in their order, until the page is full or the limits above are reached.
  FOR v_meeting IN
    SELECT m.id AS meeting_id, m.recorder_user_id = v_user AS is_recorder
      FROM ludy_meetings.meeting m
     WHERE m.org_id = v_org
       AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
       AND (v_label IS NULL OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_label l WHERE l.org_id = m.org_id AND l.meeting_id = m.id AND pg_catalog.lower(l.label) = v_label))
     ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.id
  LOOP
    -- At most 300 meetings looked at, readable or not (a readability check costs about as much as a small query), so a caller who reads few meetings does not pay a check for every meeting of the org.
    v_seen := v_seen + 1;
    IF v_seen > 300 THEN
      v_exhausted := false;
      EXIT;
    END IF;
    IF NOT (v_meeting.is_recorder OR ludy_meetings.is_meeting_reader(v_org, v_meeting.meeting_id)) THEN
      CONTINUE;
    END IF;
    v_visited := v_visited + 1;
    IF v_visited > 40 THEN
      v_exhausted := false;
      EXIT;
    END IF;
    -- One stage per meeting (#4940), the rule of the transcript page and the file: the recorder reads their working draft while one exists, else the published lines; any other reader the published lines.
    v_stage := CASE WHEN v_meeting.is_recorder AND EXISTS (
      SELECT 1 FROM ludy_meetings.transcript_segment d WHERE d.org_id = v_org AND d.meeting_id = v_meeting.meeting_id AND d.stage = 'draft'
    ) THEN 'draft' ELSE 'published' END;
    -- (x.search || '') is not the indexed column, so the planner reads this meeting's lines by their own index and never the org-wide index over the words, which costs more than the lines of one meeting.
    FOR v_line IN
      SELECT x.id AS seg_id
        FROM ludy_meetings.transcript_segment x
       WHERE x.org_id = v_org AND x.meeting_id = v_meeting.meeting_id AND (x.search || ''::tsvector) @@ v_q AND x.stage = v_stage
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
  -- The old way (20261226000000, with the same one stage per meeting), for words that 40 meetings did not fill: every line that holds the words, found by the index.
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.id AS seg_id, s.meeting_id, s.stage, s.start_seconds
      FROM ludy_meetings.transcript_segment s
     WHERE s.org_id = v_org AND s.search @@ v_q
  ), readable AS MATERIALIZED (
    -- One readability check per meeting with a hit, not per line, and none for the caller's own meetings (the member role was checked above).
    SELECT m.id AS meeting_id, COALESCE(m.started_at, m.created_at) AS held_at, m.recorder_user_id = v_user AS is_recorder,
           CASE WHEN m.recorder_user_id = v_user AND EXISTS (
             SELECT 1 FROM ludy_meetings.transcript_segment d WHERE d.org_id = v_org AND d.meeting_id = m.id AND d.stage = 'draft'
           ) THEN 'draft' ELSE 'published' END AS stage
      FROM ludy_meetings.meeting m
     WHERE m.org_id = v_org
       AND m.id IN (SELECT h.meeting_id FROM hits h)
       AND (m.text_retention_date IS NULL OR m.text_retention_date > v_today)
       AND (v_label IS NULL OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_label l WHERE l.org_id = m.org_id AND l.meeting_id = m.id AND pg_catalog.lower(l.label) = v_label))
       AND (m.recorder_user_id = v_user OR ludy_meetings.is_meeting_reader(v_org, m.id))
  )
  SELECT h.seg_id
    FROM hits h
    JOIN readable r ON r.meeting_id = h.meeting_id
   WHERE h.stage = r.stage
   ORDER BY r.held_at DESC, r.meeting_id, h.start_seconds, h.seg_id
   OFFSET p_offset LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer, text) FROM PUBLIC;
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
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_meetings.search_segment_ids(p_query text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id FROM ludy_meetings.search_segment_ids(p_query, p_limit, p_offset, NULL::text) s;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer) FROM PUBLIC;
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
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.search_segment_ids(text, integer, integer) TO ludy_tenant;
