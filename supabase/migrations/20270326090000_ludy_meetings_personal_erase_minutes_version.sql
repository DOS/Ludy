-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Meetings (issue #4857, follow-up of #4789): ludy_meetings.personal_erase also deletes the published second-language version of the minutes (ludy_meetings.minutes_version) of every meeting the
-- erasure touches, directly, for parity with the private translation: today the version goes only because the redaction of the original fires the triggers of 20270324250000, so a path that
-- depended on the trigger alone could leave a version that holds the erased value. A version is the recorder's own published copy of the original; the recorder publishes it again from the
-- redacted original, so dropping it loses no source. The other rows, the locks, the counts and the answer's columns are unchanged.
--
-- Body check: restated from its newest definition (20270117160000_crove_meetings_chapters.sql, the schema names the rebrand of 20270316140000 gave it) with exactly one addition, the DELETE of the
-- minutes_version rows after the translation DELETE; same signature, owner, search_path and grants. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

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
      SELECT x.id FROM ludy_meetings.meeting x WHERE x.org_id = v_org AND ludy_kernel.text_mentions(x.title, p_kind, p_value)
      UNION
      SELECT c.meeting_id FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
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
    -- The chapter titles (#3844), read by the recorder (a draft) and the readers (published), redacted by the rule of the rows above; they count with the titles (the answer's columns are a contract).
    WITH done AS (
      UPDATE ludy_meetings.meeting_chapter c
         SET title = pg_catalog.left(ludy_kernel.text_redact(c.title, p_kind, p_value, v_mark), 80), updated_at = pg_catalog.now()
       WHERE c.org_id = v_org AND c.id = ANY (v_chp) AND ludy_kernel.text_mentions(c.title, p_kind, p_value)
         AND (v_named OR v_rec OR (v_read AND c.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
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
         + (SELECT pg_catalog.count(*) FROM ludy_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id AND ludy_kernel.text_mentions(c.title, p_kind, p_value))
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
