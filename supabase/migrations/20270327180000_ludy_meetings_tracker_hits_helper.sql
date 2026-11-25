-- SPDX-License-Identifier: AGPL-3.0-only
-- One statement of the tracked-word matching rule in SQL, shared by the two features that count tracked words where the worker has no member context (#5019, plan docs/plan/meetings.md L22 x L28).
--
-- ludy_meetings.tracker_hits_in(p_org, p_meeting): for ONE meeting, how often each of the org's tracked words (at most 20) came up in its PUBLISHED transcript lines (at most 20000): a term id and a number,
--   never the word or a line. The rule is the one of modules/meetings/src/tracker-count.ts (whole words, case ignored, punctuation as a space, a term typed with a mark or the letter d with stroke found with its
--   marks only, a term typed without marks found whatever the marks of the line, two hits may share the space between them). It is the matching moved out of ludy_meetings.tracker_alert_hits unchanged.
--   It decides nothing about who may know the count: the CALLER has decided that the meeting may be counted for its purpose (tracker_alert_hits: the system context of the org, the meeting still there, Meetings
--   on, its text period not ended; weekly_notices_due: the meeting is one the member reads). SECURITY INVOKER with EXECUTE for no role but its owner, so it runs only inside those two definers, as their owner.
-- ludy_meetings.tracker_alert_hits(org, meeting, now): restated with the same signature, return columns, context gate, checks and grants; its counting is now one call of the helper.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.tracker_hits_in(p_org uuid, p_meeting uuid)
RETURNS TABLE (term_id uuid, hits integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  WITH terms AS (
    SELECT t.id, t.term FROM ludy_meetings.tracker_term t WHERE t.org_id = p_org ORDER BY t.id LIMIT 20
  ),
  -- A term typed without a mark or the letter đ is looked for in the line without its marks too (tracker-count.ts hasMarks).
  spelled AS (
    SELECT t.id, t.term,
           NOT (normalize(t.term, NFD) COLLATE pg_catalog."pg_c_utf8" ~ '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]|[đĐ]') AS loose
    FROM terms t
  ),
  -- The needle: the term's words, in the spelling it was typed in, single spaces (tracker-count.ts needleOf). A term with no word left is left out.
  needles AS (
    SELECT q.id, q.loose, pg_catalog.btrim(q.words) AS words
    FROM (
      SELECT sp.id, sp.loose,
             pg_catalog.regexp_replace(
               CASE WHEN sp.loose
                 THEN pg_catalog.lower(pg_catalog.translate(pg_catalog.regexp_replace(normalize(sp.term, NFD) COLLATE pg_catalog."pg_c_utf8", '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]+', '', 'g'), 'đĐ', 'dd'))
                 ELSE pg_catalog.lower(normalize(sp.term, NFC) COLLATE pg_catalog."pg_c_utf8")
               END,
               '[^[:alnum:]]+', ' ', 'g') AS words
      FROM spelled sp
    ) q
    WHERE pg_catalog.btrim(q.words) <> ''
  ),
  -- The published lines in the two spellings, a space at each end (tracker-count.ts lineWords). Only these rows are read, and only to count: nothing of them is returned.
  published_lines AS MATERIALIZED (
    SELECT ' ' || pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(normalize(g.text, NFC) COLLATE pg_catalog."pg_c_utf8"), '[^[:alnum:]]+', ' ', 'g')) || ' ' AS strict,
           ' ' || pg_catalog.btrim(pg_catalog.regexp_replace(
                    pg_catalog.lower(pg_catalog.translate(pg_catalog.regexp_replace(normalize(g.text, NFD) COLLATE pg_catalog."pg_c_utf8", '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]+', '', 'g'), 'đĐ', 'dd')),
                    '[^[:alnum:]]+', ' ', 'g')) || ' ' AS plain
    FROM (
      SELECT s.text FROM ludy_meetings.transcript_segment s
      WHERE s.org_id = p_org AND s.meeting_id = p_meeting AND s.stage = 'published'
      ORDER BY s.start_seconds, s.id
      LIMIT 20000
    ) g
  ),
  -- Whole words, a hit may share the space with the next ("a a" holds the word "a" twice): the lookarounds take no characters, so the matches do not eat the spaces between words.
  counted AS (
    SELECT n.id AS id, pg_catalog.sum(pg_catalog.regexp_count(CASE WHEN n.loose THEN l.plain ELSE l.strict END, '(?<= )' || n.words || '(?= )'))::integer AS n
    FROM needles n
    CROSS JOIN published_lines l
    GROUP BY n.id
  )
  SELECT c.id, c.n FROM counted c WHERE c.n > 0
$$;
REVOKE ALL ON FUNCTION ludy_meetings.tracker_hits_in(uuid, uuid) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.tracker_hits_in(uuid, uuid) FROM %I', r.rolname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_meetings.tracker_alert_hits(p_org uuid, p_meeting uuid, p_now timestamptz)
RETURNS TABLE (term_id uuid, hits integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' OR p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NO_CONTEXT' USING ERRCODE = '42501';
  END IF;
  -- The meeting is still there, Meetings is on, and the text day has not been reached on the Vietnam calendar day of p_now (the day the text is shredded counts as ended).
  IF NOT ludy_kernel.org_app_on(v_org, 'meetings') OR NOT EXISTS (
    SELECT 1 FROM ludy_meetings.meeting m
    WHERE m.org_id = v_org AND m.id = p_meeting
      AND (m.text_retention_date IS NULL OR m.text_retention_date > ((p_now AT TIME ZONE 'UTC') + interval '7 hours')::date)
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT h.term_id, h.hits FROM ludy_meetings.tracker_hits_in(v_org, p_meeting) h;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) TO ludy_worker;
