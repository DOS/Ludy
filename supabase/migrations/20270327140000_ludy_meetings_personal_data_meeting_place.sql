-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #5014, refs #5013): the place of a meeting is personal data. The recorder types it (ludy_meetings.meeting.place, one line of 1 to 200 characters, cleaned as a title is), and it may name or describe a
-- person or an address, so the personal-data finder and the erasure treat it as they treat the title of the meeting, the same rule and the same readers, counted with the titles; the columns of every answer stay as they were.
-- Five restatements, each from its newest definition (all five from 20270326280000_ludy_meetings_personal_data_meeting_label.sql) with only the place lines added; the same signatures, owners, search_path, grants and result columns.
-- The stamp's domain string 'crove.meetings.stamp.v1' stays as it is, and a meeting with no place adds no row to the stamp, so a stamp a notice already holds keeps its value for such a meeting.
--   personal_row_ids       the title and the place of a meeting are one hit of kind 4 (the meeting), listed where the caller can read the meeting; the finder reads the row by id and tests each registered column.
--   personal_matches       a place the owner cannot read is counted per recorder as a title (one count per text value).
--   text_stamp             a place the owner cannot read is part of the stamp (kind 7), so a place added or changed after a notice moves the stamp and the notice no longer covers it.
--   personal_notice_items  a meeting whose only mention is in a place the owner cannot read is listed, so its recorder can be told.
--   personal_erase         a place that holds the value is redacted by the rule of the title (the recorder, a reader, or a notice that named the meeting at this text), cut to 200 characters, counted in `titles`,
--                          and the ones still holding the value are counted in `kept`.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_meetings.personal_row_ids(p_kind text, p_value text)
RETURNS TABLE (kind smallint, id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT 1::smallint AS k, s.id AS row_id, s.meeting_id, s.stage FROM ludy_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT 2::smallint, r.id, r.meeting_id, r.stage FROM ludy_meetings.meeting_result r
     WHERE r.org_id = v_org AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value) OR ludy_kernel.text_mentions(r.decisions::text, p_kind, p_value))
    UNION ALL
    SELECT 3::smallint, i.id, i.meeting_id, i.stage FROM ludy_meetings.action_item i
     WHERE i.org_id = v_org AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    -- The title and the place of the meeting (#5014) are one hit of kind 4: the finder reads the row by id and tests each registered column of it, the place being read by whoever reads the title.
    SELECT 4::smallint, m.id, m.id, NULL::text FROM ludy_meetings.meeting m
     WHERE m.org_id = v_org AND (ludy_kernel.text_mentions(m.title, p_kind, p_value) OR ludy_kernel.text_mentions(m.place, p_kind, p_value))
    UNION ALL
    -- The chapters of a meeting (#3844): kind 6. A draft chapter is read by the recorder alone, a published one by the readers, as the readability check below decides.
    SELECT 6::smallint, c.id, c.meeting_id, c.stage FROM ludy_meetings.meeting_chapter c
     WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
    UNION ALL
    -- The addition: the recorder's rough notes (A5, #3163). Stage 'draft' so only the recorder passes the readability check below.
    SELECT 5::smallint, n.id, n.meeting_id, 'draft'::text FROM ludy_meetings.meeting_note n
     WHERE n.org_id = v_org AND ludy_kernel.text_mentions(n.body, p_kind, p_value)
    UNION ALL
    -- The labels of a meeting (#4964): kind 7, read by the recorder and the readers of the meeting, as its title is (no stage, so a draft rule never hides one).
    SELECT 7::smallint, l.id, l.meeting_id, NULL::text FROM ludy_meetings.meeting_label l
     WHERE l.org_id = v_org AND ludy_kernel.text_mentions(l.label, p_kind, p_value)
  )
  -- At most 1000 ids of each kind (7000 in all), so a flood of transcript lines never crowds out the summary, the items, the titles, the notes, the chapters or the labels; the finder lists 200 rows a column and says
  -- when there were more.
  SELECT x.k, x.row_id FROM (
    SELECT h.k, h.row_id, pg_catalog.row_number() OVER (PARTITION BY h.k ORDER BY h.row_id) AS rn FROM hits h
     WHERE ludy_meetings.is_meeting_recorder(v_org, h.meeting_id) OR (h.stage IS DISTINCT FROM 'draft' AND ludy_meetings.is_meeting_reader(v_org, h.meeting_id))
  ) x
   WHERE x.rn <= 1000
   ORDER BY x.k, x.row_id;
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.personal_row_ids(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.personal_row_ids(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.personal_row_ids(text, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_meetings.personal_matches(p_kind text, p_value text)
RETURNS TABLE (recorder_user_id uuid, meetings bigint, lines bigint, results bigint, items bigint, titles bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- A value of another shape raises here, before any row is read.
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.meeting_id, s.stage, 'line'::text AS what FROM ludy_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT r.meeting_id, r.stage, 'result' FROM ludy_meetings.meeting_result r
     WHERE r.org_id = v_org AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value) OR ludy_kernel.text_mentions(r.decisions::text, p_kind, p_value))
    UNION ALL
    SELECT i.meeting_id, i.stage, 'item' FROM ludy_meetings.action_item i
     WHERE i.org_id = v_org AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    SELECT m.id, NULL::text, 'title' FROM ludy_meetings.meeting m
     WHERE m.org_id = v_org AND ludy_kernel.text_mentions(m.title, p_kind, p_value)
    UNION ALL
    -- The place of a meeting (#5014) counts as a title too, for the same reason, one count per text value as the erasure counts them; it is read by whoever reads the title.
    SELECT m.id, NULL::text, 'title' FROM ludy_meetings.meeting m
     WHERE m.org_id = v_org AND ludy_kernel.text_mentions(m.place, p_kind, p_value)
    UNION ALL
    -- The chapters of a meeting (#3844) count as titles: the answer's columns are a contract, and a chapter title is the title of a part of the meeting.
    SELECT c.meeting_id, c.stage, 'title' FROM ludy_meetings.meeting_chapter c
     WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
    UNION ALL
    -- The labels of a meeting (#4964) count as titles too, for the same reason; a label has no stage, so the readers of the meeting read it.
    SELECT l.meeting_id, NULL::text, 'title' FROM ludy_meetings.meeting_label l
     WHERE l.org_id = v_org AND ludy_kernel.text_mentions(l.label, p_kind, p_value)
  )
  SELECT m.recorder_user_id,
         pg_catalog.count(DISTINCT h.meeting_id)::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'line')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'result')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'item')::bigint,
         pg_catalog.count(*) FILTER (WHERE h.what = 'title')::bigint
    FROM hits h
    JOIN ludy_meetings.meeting m ON m.org_id = v_org AND m.id = h.meeting_id
   -- Only what the caller cannot read: not their own meeting, and not a published row (or a title) of a meeting they are a reader of.
   WHERE NOT (
     ludy_meetings.is_meeting_recorder(v_org, h.meeting_id)
     OR (h.stage IS DISTINCT FROM 'draft' AND ludy_meetings.is_meeting_reader(v_org, h.meeting_id))
   )
   GROUP BY m.recorder_user_id
   ORDER BY m.recorder_user_id;
END;
$$;
REVOKE ALL ON FUNCTION ludy_meetings.personal_matches(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.personal_matches(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.personal_matches(text, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_meetings.text_stamp(p_org uuid, p_meeting uuid, p_rec boolean, p_read boolean)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_text text;
BEGIN
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM ludy_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(pg_catalog.string_agg(t.v, pg_catalog.chr(31) ORDER BY t.k, t.id), '') INTO v_text
    FROM (
      SELECT 1 AS k, s.id::text AS id, s.stage || pg_catalog.chr(30) || s.speaker_label || pg_catalog.chr(30) || s.text AS v
        FROM ludy_meetings.transcript_segment s
       WHERE s.org_id = p_org AND s.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND s.stage <> 'draft'))
      UNION ALL
      SELECT 2, r.id::text, r.stage || pg_catalog.chr(30) || r.summary || pg_catalog.chr(30) || r.decisions::text
        FROM ludy_meetings.meeting_result r
       WHERE r.org_id = p_org AND r.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND r.stage <> 'draft'))
      UNION ALL
      SELECT 3, i.id::text, i.stage || pg_catalog.chr(30) || i.title || pg_catalog.chr(30) || i.who_drafted || pg_catalog.chr(30) || i.when_drafted
        FROM ludy_meetings.action_item i
       WHERE i.org_id = p_org AND i.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND i.stage <> 'draft'))
      UNION ALL
      SELECT 4, m.id::text, m.title FROM ludy_meetings.meeting m WHERE m.org_id = p_org AND m.id = p_meeting AND NOT p_read
      UNION ALL
      -- The chapter titles (#3844), by the rule of the other rows: the ones the owner cannot read.
      SELECT 5, c.id::text, c.stage || pg_catalog.chr(30) || c.title
        FROM ludy_meetings.meeting_chapter c
       WHERE c.org_id = p_org AND c.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND c.stage <> 'draft'))
      UNION ALL
      -- The labels (#4964), by the same rule: the ones the owner cannot read (a label is read by the recorder and the readers of the meeting).
      SELECT 6, l.id::text, l.label
        FROM ludy_meetings.meeting_label l
       WHERE l.org_id = p_org AND l.meeting_id = p_meeting AND NOT (p_rec OR p_read)
      UNION ALL
      -- The place (#5014), by the rule of the title: the one the owner cannot read. A meeting with no place adds no row, so a stamp a notice already holds keeps its value.
      SELECT 7, m.id::text, m.place FROM ludy_meetings.meeting m WHERE m.org_id = p_org AND m.id = p_meeting AND NOT p_read AND m.place IS NOT NULL
    ) t;
  RETURN ('x' || pg_catalog.encode(pg_catalog.substr(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.meetings.stamp.v1' || pg_catalog.chr(31) || p_org::text || pg_catalog.chr(31) || p_meeting::text || pg_catalog.chr(31) || v_text, 'UTF8'))), 1, 8), 'hex'))::bit(64)::bigint;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.text_stamp(uuid, uuid, boolean, boolean) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.text_stamp(uuid, uuid, boolean, boolean) FROM %I', r.rolname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ludy_meetings.personal_notice_items(p_kind text, p_value text)
RETURNS TABLE (meeting_id uuid, recorder_user_id uuid, stamp bigint, key bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_key bytea;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = ludy_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  v_key := ludy_meetings.notice_key_of(v_org, p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.meeting_id, s.stage FROM ludy_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT r.meeting_id, r.stage FROM ludy_meetings.meeting_result r
     WHERE r.org_id = v_org AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
                                 OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
    UNION ALL
    SELECT i.meeting_id, i.stage FROM ludy_meetings.action_item i
     WHERE i.org_id = v_org AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    SELECT m.id, NULL::text FROM ludy_meetings.meeting m WHERE m.org_id = v_org AND (ludy_kernel.text_mentions(m.title, p_kind, p_value) OR ludy_kernel.text_mentions(m.place, p_kind, p_value))
    UNION ALL
    -- The chapter titles (#3844): a meeting whose only mention is in a chapter the owner cannot read is listed too, so its recorder can be told.
    SELECT c.meeting_id, c.stage FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
    UNION ALL
    -- The labels (#4964): a meeting whose only mention is in a label the owner cannot read is listed too (a label has no stage).
    SELECT l.meeting_id, NULL::text FROM ludy_meetings.meeting_label l WHERE l.org_id = v_org AND ludy_kernel.text_mentions(l.label, p_kind, p_value)
  ), unread AS (
    -- Meetings with at least one hit the owner cannot read: not their own meeting, and not a published row (or a title) of a meeting they are a reader of.
    SELECT DISTINCT h.meeting_id FROM hits h
     WHERE NOT (ludy_meetings.is_meeting_recorder(v_org, h.meeting_id)
                OR (h.stage IS DISTINCT FROM 'draft' AND ludy_meetings.is_meeting_reader(v_org, h.meeting_id)))
  )
  SELECT u.meeting_id, m.recorder_user_id,
         ludy_meetings.text_stamp(v_org, u.meeting_id, ludy_meetings.is_meeting_recorder(v_org, u.meeting_id), ludy_meetings.is_meeting_reader(v_org, u.meeting_id)), v_key
    FROM unread u JOIN ludy_meetings.meeting m ON m.org_id = v_org AND m.id = u.meeting_id
   ORDER BY u.meeting_id
   LIMIT 1001;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.personal_notice_items(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.personal_notice_items(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.personal_notice_items(text, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_meetings.personal_erase(p_kind text, p_value text)
RETURNS TABLE (meeting_id uuid, recorder_user_id uuid, lines bigint, results bigint, items bigint, titles bigint, kept bigint, audio_until date, video_until date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_key bytea;
  v_hex text;
  v_mark constant text := '[đã xóa]';
  v_notices jsonb;
  m record;
  v_rec boolean;
  v_read boolean;
  v_stamp bigint;
  v_named boolean;
  v_seg uuid[];
  v_res uuid[];
  v_itm uuid[];
  v_chp uuid[];
  v_lbl uuid[];
  v_n bigint;
BEGIN
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member t
    WHERE t.org_id = v_org AND t.user_id = ludy_kernel.ctx_user_id() AND t.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM ludy_kernel.text_mention_pattern(p_kind, p_value);
  v_key := ludy_meetings.notice_key_of(v_org, p_kind, p_value);
  v_hex := pg_catalog.encode(v_key, 'hex');
  -- The notices of this value, read once: each meeting entry '<id>:<stamp>' of an ok notify row written at least 24 hours ago, with the sender and the event that proves a recorder was told.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry', e.v, 'sender', a.actor_id, 'event', a.detail ->> 'event')), '[]'::jsonb) INTO v_notices
    FROM ludy_kernel.audit_event a, pg_catalog.jsonb_array_elements_text(a.detail -> 'meetings') e(v)
   WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
     AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
     AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'meeting_key' = v_hex
     AND pg_catalog.jsonb_typeof(a.detail -> 'meetings') = 'array';
  FOR m IN
    WITH hits AS MATERIALIZED (
      SELECT s.meeting_id FROM ludy_meetings.transcript_segment s
       WHERE s.org_id = v_org AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
      UNION
      SELECT r.meeting_id FROM ludy_meetings.meeting_result r
       WHERE r.org_id = v_org AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
                                   OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
      UNION
      SELECT i.meeting_id FROM ludy_meetings.action_item i
       WHERE i.org_id = v_org AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
      UNION
      SELECT x.id FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND (ludy_kernel.text_mentions(x.title, p_kind, p_value) OR ludy_kernel.text_mentions(x.place, p_kind, p_value))
      UNION
      SELECT c.meeting_id FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
      UNION
      SELECT l.meeting_id FROM ludy_meetings.meeting_label l WHERE l.org_id = v_org AND ludy_kernel.text_mentions(l.label, p_kind, p_value)
    )
    SELECT h.meeting_id FROM hits h ORDER BY h.meeting_id
  LOOP
    -- The meeting row and its text rows are locked first, then the stamp is taken, and only the rows locked are changed: a recorder's edit waits for this redaction, and text written after the
    -- lock (or a draft replaced meanwhile) is neither in the stamp a notice saw nor redacted.
    SELECT x.recorder_user_id INTO recorder_user_id FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_seg FROM (SELECT s.id FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_res FROM (SELECT r.id FROM ludy_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_itm FROM (SELECT i.id FROM ludy_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_chp FROM (SELECT c.id FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_lbl FROM (SELECT b.id FROM ludy_meetings.meeting_label b WHERE b.org_id = v_org AND b.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    -- The machine translations of this meeting (#3184), every member's, are DROPPED, not redacted: a redacted original would leave the translated name behind, and a name cannot be located
    -- reliably in another language. They are the member's own derived copies (asking again makes a new one), so dropping loses no source. The meeting row is locked above, so a translation
    -- being kept at this moment (meetings.translation.copy_result) either finished first (and is dropped here) or waits and finds its original redacted (its hash no longer matches).
    DELETE FROM ludy_meetings.translation x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
    -- The published second-language version of the minutes (#4777, minutes_version) is dropped too, directly and not only through the triggers that drop it when its original changes (#4857): the same
    -- reasoning as the translations above (a name cannot be located reliably in another language, and the recorder publishes a version again from the redacted original), so no path depends on the trigger alone.
    DELETE FROM ludy_meetings.minutes_version x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
    meeting_id := m.meeting_id;
    v_rec := ludy_meetings.is_meeting_recorder(v_org, m.meeting_id);
    v_read := ludy_meetings.is_meeting_reader(v_org, m.meeting_id);
    -- A notice is looked for only where the owner cannot read everything (their own meeting needs none).
    v_named := false;
    IF NOT v_rec THEN
      v_stamp := ludy_meetings.text_stamp(v_org, m.meeting_id, v_rec, v_read);
      v_named := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_notices) n(j)
         WHERE n.j ->> 'entry' = m.meeting_id::text || ':' || v_stamp::text
           AND ludy_meetings.notice_told(v_org, recorder_user_id, (n.j ->> 'sender')::uuid, n.j ->> 'event'));
    END IF;
    -- A line, summary, decision or item row is redacted when the owner reads it (the recorder's own, or a published row of a meeting they read) or a notice named the meeting at this text.
    WITH done AS (
      UPDATE ludy_meetings.transcript_segment s
         SET text = pg_catalog.left(ludy_kernel.text_redact(s.text, p_kind, p_value, v_mark), 4000),
             speaker_label = pg_catalog.left(ludy_kernel.text_redact(s.speaker_label, p_kind, p_value, v_mark), 80),
             updated_at = pg_catalog.now()
       WHERE s.org_id = v_org AND s.id = ANY (v_seg)
         AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND s.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO lines FROM done;
    -- Decisions one jsonb element at a time, each cut to its own limit (500): only an element that holds the value changes, and the array keeps its shape.
    WITH done AS (
      UPDATE ludy_meetings.meeting_result r
         SET summary = pg_catalog.left(ludy_kernel.text_redact(r.summary, p_kind, p_value, v_mark), 8000),
             decisions = COALESCE((SELECT pg_catalog.jsonb_agg(CASE WHEN pg_catalog.jsonb_typeof(e.v) = 'string'
                                                                       THEN pg_catalog.to_jsonb(pg_catalog.left(ludy_kernel.text_redact(e.v #>> '{}', p_kind, p_value, v_mark), 500))
                                                                       ELSE e.v END ORDER BY e.i)
                                     FROM pg_catalog.jsonb_array_elements(r.decisions) WITH ORDINALITY AS e(v, i)), '[]'::jsonb),
             updated_at = pg_catalog.now()
       WHERE r.org_id = v_org AND r.id = ANY (v_res)
         AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
              OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
         AND (v_named OR v_rec OR (v_read AND r.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO results FROM done;
    WITH done AS (
      UPDATE ludy_meetings.action_item i
         SET title = pg_catalog.left(ludy_kernel.text_redact(i.title, p_kind, p_value, v_mark), 300),
             who_drafted = pg_catalog.left(ludy_kernel.text_redact(i.who_drafted, p_kind, p_value, v_mark), 200),
             when_drafted = pg_catalog.left(ludy_kernel.text_redact(i.when_drafted, p_kind, p_value, v_mark), 200),
             updated_at = pg_catalog.now()
       WHERE i.org_id = v_org AND i.id = ANY (v_itm)
         AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND i.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO items FROM done;
    -- The title is read by whoever reads the meeting.
    WITH done AS (
      UPDATE ludy_meetings.meeting x
         SET title = pg_catalog.left(ludy_kernel.text_redact(x.title, p_kind, p_value, v_mark), 200), updated_at = pg_catalog.now()
       WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.title, p_kind, p_value)
         AND (v_named OR v_read)
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO titles FROM done;
    -- The place (#5014), read by whoever reads the title and redacted by its rule (the recorder, a reader, or a notice that named the meeting at this text); it counts with the titles.
    -- The new text is cut to the column's limit of 200 characters, and a redacted value is never empty, so the column's own check holds.
    WITH done AS (
      UPDATE ludy_meetings.meeting x
         SET place = pg_catalog.left(ludy_kernel.text_redact(x.place, p_kind, p_value, v_mark), 200), updated_at = pg_catalog.now()
       WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.place, p_kind, p_value)
         AND (v_named OR v_read)
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
    titles := titles + v_n;
    -- The chapter titles (#3844), read by the recorder (a draft) and the readers (published), redacted by the rule of the rows above; they count with the titles (the answer's columns are a contract).
    WITH done AS (
      UPDATE ludy_meetings.meeting_chapter c
         SET title = pg_catalog.left(ludy_kernel.text_redact(c.title, p_kind, p_value, v_mark), 80), updated_at = pg_catalog.now()
       WHERE c.org_id = v_org AND c.id = ANY (v_chp) AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
         AND (v_named OR v_rec OR (v_read AND c.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
    titles := titles + v_n;
    -- The labels (#4964), read by the recorder and the readers, redacted by the rule of the title (the recorder, a reader, or a notice that named the meeting at this text); they count with the titles.
    -- A label is never edited by a member, and the unique index folds the case, so a redaction that would leave a label equal to another one of the meeting (two labels that held the value become the same
    -- text, or a label that held it becomes one already there) drops the later row instead of changing it: the one kept is a label that held nothing of the value, else the oldest. A dropped label
    -- counts too. The new text is cut to the column's limit of 40 characters and trimmed, so the row's own check holds.
    -- A label.add of the recorder that runs at the same moment and lands on the same text as a redaction hits the unique index and aborts this whole erasure (23505): it fails closed, nothing is half erased,
    -- and asking again works. A label is added under the recorder's own lock, so this is a narrow race and not a case worth a retry loop inside the function.
    WITH cand AS (
      SELECT b.id, b.created_at,
             (ludy_kernel.text_mentions(b.label, p_kind, p_value) AND (v_named OR v_rec OR v_read)) AS chg,
             CASE WHEN ludy_kernel.text_mentions(b.label, p_kind, p_value) AND (v_named OR v_rec OR v_read)
                  THEN pg_catalog.btrim(pg_catalog.left(ludy_kernel.text_redact(b.label, p_kind, p_value, v_mark), 40))
                  ELSE b.label END AS nl
        FROM ludy_meetings.meeting_label b
       WHERE b.org_id = v_org AND b.id = ANY (v_lbl)
    ), ranked AS (
      SELECT c.id, c.chg, c.nl,
             pg_catalog.row_number() OVER (PARTITION BY pg_catalog.lower(c.nl) ORDER BY c.chg, c.created_at, c.id) AS rn
        FROM cand c
    ), gone AS (
      DELETE FROM ludy_meetings.meeting_label b USING ranked r
       WHERE b.org_id = v_org AND b.id = r.id AND r.chg AND r.rn > 1
      RETURNING 1
    ), upd AS (
      UPDATE ludy_meetings.meeting_label b SET label = r.nl FROM ranked r
       WHERE b.org_id = v_org AND b.id = r.id AND r.chg AND r.rn = 1
      RETURNING 1
    )
    SELECT (SELECT pg_catalog.count(*) FROM gone) + (SELECT pg_catalog.count(*) FROM upd) INTO v_n;
    titles := titles + v_n;
    -- What still mentions the value: rows the owner cannot read and no notice covers at this text (and rows written after the lock).
    SELECT (SELECT pg_catalog.count(*) FROM ludy_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(s.text, p_kind, p_value) OR ludy_kernel.text_mentions(s.speaker_label, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(r.summary, p_kind, p_value)
                     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND ludy_kernel.text_mentions(e.v #>> '{}', p_kind, p_value))))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id
                AND (ludy_kernel.text_mentions(i.title, p_kind, p_value) OR ludy_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR ludy_kernel.text_mentions(i.when_drafted, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.title, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND ludy_kernel.text_mentions(x.place, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id AND ludy_kernel.text_mentions(c.title, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_label b WHERE b.org_id = v_org AND b.meeting_id = m.meeting_id AND ludy_kernel.text_mentions(b.label, p_kind, p_value))
      INTO kept;
    -- Audio and video stay (a voice cannot be edited out): kept until their retention dates.
    SELECT CASE WHEN EXISTS (SELECT 1 FROM ludy_meetings.audio_segment a WHERE a.org_id = v_org AND a.meeting_id = m.meeting_id) THEN x.audio_retention_date END
      INTO audio_until FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id;
    SELECT v.video_retention_date INTO video_until FROM ludy_meetings.meeting_video v WHERE v.org_id = v_org AND v.meeting_id = m.meeting_id;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ludy_meetings.personal_erase(text, text) FROM PUBLIC;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'ludy\_%' AND rolname <> current_user LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_meetings.personal_erase(text, text) FROM %I', r.rolname);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION ludy_meetings.personal_erase(text, text) TO ludy_tenant;
