-- SPDX-License-Identifier: AGPL-3.0-only
-- Alerts when a tracked keyword comes up in a new meeting (#4873, builds on the keyword trackers of #4818). A member who turns it on is told, once per meeting, which tracked words are in the
-- transcript lines the recorder published for them to read, and how often: counted by code, with no model and no text in the notice.
--
-- ludy_meetings.tracker_alert: one row per member who opted in (no row, no alert; off by default). Private to its member: the row policy shows and changes a member's own row only, in a user context; an
--   owner, an admin, another member, an agent context and the system context read none of it (the worker reads it through the definer below). It holds no word, no meeting and no text; its one setting is the language of the mail.
-- ludy_meetings.tracker_alert_recipients(org, meeting, now, after, limit) and ludy_meetings.tracker_alert_hits(org, meeting, now): the two worker-only definers the alert's dispatch asks. The system context cannot read
--   meeting rows or terms, and the reader rule must be decided for each recipient, not for the caller, so these are the one place that does both. NO TEXT LEAVES THE DATABASE (ADR-0047, the invariant that no meetings
--   definer returns meeting text): the recipients come back as ids (and whether they chose English), and the words are COUNTED INSIDE the database over the PUBLISHED transcript lines (at most 20000), returning
--   only a term id and a number. Both answer nothing unless the meeting still exists, Meetings is on for the org and its text period has not ended (as minutes_wake_open reads it).
--   recipients: the opted-in members of an active org who are an owner, admin or member with an enabled account, are not the recorder, and read the meeting now (it is shared with the org and their scope is the
--     whole org, or they are one of its readers); in id order, after p_after, at most p_limit (at most 500) a call, so the dispatch pages through all of them.
--   hits: for each of the org's tracked words (at most 20) that comes up, how many times. The counting is the Trackers card's (modules/meetings/src/tracker-count.ts) written in SQL: whole words, case ignored,
--     punctuation read as a space, a hit may share the space with the next, and marks follow what the owner typed (a term with a Vietnamese mark or the letter đ is found with its marks only, a term typed
--     without marks is found whatever the marks of the line). It runs in the pg_c_utf8 collation so the letter classes and case folding are Unicode's whatever the cluster's default; a test holds the two
--     implementations to the same counts on the same fixtures.
--   Like minutes_wake_open each holds the caller to the system context of the same org (ctx_org_id() is set, the actor is 'system' and p_org is that org), or raises NO_CONTEXT (42501). Worker's login alone.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_meetings.tracker_alert (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  user_id uuid NOT NULL,
  -- The language of the member's mail, chosen where they turned the alert on (the morning notice does the same); the row is added or removed, never edited.
  language text NOT NULL DEFAULT 'vi' CHECK (language IN ('vi', 'en')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT tracker_alert_user_uq UNIQUE (org_id, user_id)
);

SELECT ludy_kernel.apply_tenant_rls('ludy_meetings.tracker_alert');
-- A row is added or removed, never edited.
REVOKE UPDATE ON ludy_meetings.tracker_alert FROM ludy_tenant;

DROP POLICY IF EXISTS tracker_alert_own ON ludy_meetings.tracker_alert;
CREATE POLICY tracker_alert_own ON ludy_meetings.tracker_alert AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (ludy_kernel.ctx_actor_type() = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()))
  WITH CHECK (ludy_kernel.ctx_actor_type() = 'user' AND user_id = (SELECT ludy_kernel.ctx_user_id()));

CREATE OR REPLACE FUNCTION ludy_meetings.tracker_alert_recipients(p_org uuid, p_meeting uuid, p_now timestamptz, p_after uuid, p_limit integer)
RETURNS TABLE (user_id uuid, english boolean)
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
  RETURN QUERY
  SELECT a.user_id, a.language = 'en'
  FROM ludy_meetings.tracker_alert a
  JOIN ludy_meetings.meeting mt ON mt.org_id = a.org_id AND mt.id = p_meeting
  WHERE a.org_id = v_org
    AND (p_after IS NULL OR a.user_id > p_after)
    -- The recorder published it; they are not told about their own publish.
    AND mt.recorder_user_id IS DISTINCT FROM a.user_id
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
      JOIN ludy_kernel.tenant t ON t.org_id = m.org_id AND t.status = 'active'
      WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role IN ('owner', 'admin', 'member')
    )
    AND EXISTS (SELECT 1 FROM ludy_kernel.user_account u WHERE u.id = a.user_id AND u.disabled_at IS NULL)
    -- The reader rule, for this member: the meeting is shared with the org and their context carries the all-entities scope (enter_context: an owner or admin, a member with an org-wide role or with no role assignment
    -- at all; one whose assignments all name a legal entity is scoped to those and reads no org-shared meeting), or they are one of its readers (an owner or admin has no extra right, ADR-0047).
    AND ((mt.visibility = 'org' AND (
          EXISTS (SELECT 1 FROM ludy_kernel.tenant_member sm WHERE sm.org_id = a.org_id AND sm.user_id = a.user_id AND sm.role IN ('owner', 'admin'))
          OR EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = a.org_id AND ra.user_id = a.user_id AND ra.legal_entity_id IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ludy_kernel.role_assignment ra WHERE ra.org_id = a.org_id AND ra.user_id = a.user_id)
        )) OR EXISTS (SELECT 1 FROM ludy_meetings.meeting_reader rd WHERE rd.org_id = a.org_id AND rd.meeting_id = p_meeting AND rd.user_id = a.user_id))
  ORDER BY a.user_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 500));
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
  RETURN QUERY
  WITH terms AS (
    SELECT t.id, t.term FROM ludy_meetings.tracker_term t WHERE t.org_id = v_org ORDER BY t.id LIMIT 20
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
      WHERE s.org_id = v_org AND s.meeting_id = p_meeting AND s.stage = 'published'
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
  SELECT c.id, c.n FROM counted c WHERE c.n > 0;
END $$;

REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_recipients(uuid, uuid, timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_recipients(uuid, uuid, timestamptz, uuid, integer) FROM %I', r.rolname);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.tracker_alert_recipients(uuid, uuid, timestamptz, uuid, integer) TO ludy_worker;
GRANT EXECUTE ON FUNCTION ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz) TO ludy_worker;
