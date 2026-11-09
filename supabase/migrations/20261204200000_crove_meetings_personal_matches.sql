-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L5 (#2594, plan L5, ADR-0047 points 7 and 11, ADR-0037 section 5), part 1: the finder in meeting text.
--   crove_meetings.personal_row_ids(kind, value)   the ids of the rows that mention the value and that the caller can read, so the finder reads them by id (below).
--   crove_meetings.personal_matches(kind, value)   per RECORDER: how many meetings, transcript lines, summary and decision rows, action items and titles hold the
--                                                  value, among the rows the caller cannot read (an attendees-only meeting they are no reader of, and every draft that
--                                                  is not theirs). Numbers and the recorder's id only: never text, a title or a meeting id.
-- Why the ids first: row security checks a meeting's readers for every row it reads before any text is tested, so the finder reading 120 000 transcript lines
-- under it spends ten seconds per column on policy checks. Both functions test the text first and check readability on the hits only.
-- Callable in a user context only, checked inside to be an OWNER of the context's org (the personal-data screen runs as that user): an admin, a member, a viewer,
-- an agent and the system context get no answer, because the counts are an oracle for a guessed value (the same rule as crove_notes.private_matches after #1972).
-- What the owner can read is listed by the finder under row security as it is for every other table, so the two never overlap. kind and value are the finder's
-- probe, matched by crove_kernel.text_mentions (20261106200000), which raises on any other shape before a row is read. The pattern is built from a validated value,
-- with no back reference, so the scan is linear in the text. A new function: no applied file is touched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.personal_matches(p_kind text, p_value text)
RETURNS TABLE (recorder_user_id uuid, meetings bigint, lines bigint, results bigint, items bigint, titles bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A value of another shape raises here, before any row is read.
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.meeting_id, s.stage, 'line'::text AS what FROM crove_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT r.meeting_id, r.stage, 'result' FROM crove_meetings.meeting_result r
     WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value))
    UNION ALL
    SELECT i.meeting_id, i.stage, 'item' FROM crove_meetings.action_item i
     WHERE i.org_id = v_org AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    SELECT m.id, NULL::text, 'title' FROM crove_meetings.meeting m
     WHERE m.org_id = v_org AND crove_kernel.text_mentions(m.title, p_kind, p_value)
  )
  SELECT m.recorder_user_id,
         pg_catalog.count(DISTINCT h.meeting_id)::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'line')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'result')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'item')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'title')::bigint
    FROM hits h
    JOIN crove_meetings.meeting m ON m.org_id = v_org AND m.id = h.meeting_id
   -- Only what the caller cannot read: not their own meeting, and not a published row (or a title) of a meeting they are a reader of.
   WHERE NOT (
     crove_meetings.is_meeting_recorder(v_org, h.meeting_id)
     OR (h.stage IS DISTINCT FROM 'draft' AND crove_meetings.is_meeting_reader(v_org, h.meeting_id))
   )
   GROUP BY m.recorder_user_id
   ORDER BY m.recorder_user_id;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.personal_matches(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_matches(text, text) TO crove_tenant;

-- crove_meetings.personal_row_ids(kind, value)   the ids of the rows that mention the value and that the caller can read, per table (1 transcript line, 2 summary/decision
--                                                row, 3 action item, 4 meeting): what the finder reads under row security. Found by the text first and checked for readability
--                                                on the hits only, so a large transcript costs one scan of the text, not a policy check per row. Ids only; an owner or admin's user
--                                                context only. Row security still applies when the finder reads the rows by id.
CREATE OR REPLACE FUNCTION crove_meetings.personal_row_ids(p_kind text, p_value text)
RETURNS TABLE (kind smallint, id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT 1::smallint AS k, s.id AS row_id, s.meeting_id, s.stage FROM crove_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT 2::smallint, r.id, r.meeting_id, r.stage FROM crove_meetings.meeting_result r
     WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value))
    UNION ALL
    SELECT 3::smallint, i.id, i.meeting_id, i.stage FROM crove_meetings.action_item i
     WHERE i.org_id = v_org AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    SELECT 4::smallint, m.id, m.id, NULL::text FROM crove_meetings.meeting m
     WHERE m.org_id = v_org AND crove_kernel.text_mentions(m.title, p_kind, p_value)
  )
  -- At most 1000 ids of each kind (4000 in all), so a flood of transcript lines never crowds out the summary, the items or the titles; the finder lists 200 rows a column and says
  -- when there were more.
  SELECT x.k, x.row_id FROM (
    SELECT h.k, h.row_id, pg_catalog.row_number() OVER (PARTITION BY h.k ORDER BY h.row_id) AS rn FROM hits h
     WHERE crove_meetings.is_meeting_recorder(v_org, h.meeting_id) OR (h.stage IS DISTINCT FROM 'draft' AND crove_meetings.is_meeting_reader(v_org, h.meeting_id))
  ) x
   WHERE x.rn <= 1000
   ORDER BY x.k, x.row_id;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.personal_row_ids(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_row_ids(text, text) TO crove_tenant;
