-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L5 follow-ups (#2917, review of #2915): the two personal-data definers of crove_meetings, restated from their bodies in 20261205100000 with two changes (same signatures,
-- owners and grants, so the invariant walk of #2910 and #2914 holds unchanged; the applied file is not edited).
--   N4  A `decisions` element that is not a string (no command writes one today) is matched and redacted as a string element only: a number, a boolean or a nested value is left as it is,
--       where it came back as a JSON string after the redaction.
--       The finder (personal_row_ids, personal_matches, the kernel's column search) still reads `decisions::text`, so to keep it and the erasure agreeing the column now accepts string
--       elements only (a CHECK, added NOT VALID and then validated: no command writes anything else, and the table is not a hot one). The string-element handling below stays as a guard.
--   N5  The lock order. The erasure used to lock the meeting row FOR UPDATE and then its text rows, while a recorder's command (replaceDraft: delete the draft's lines, insert new ones)
--       holds line rows and then needs a FOR KEY SHARE of the meeting row for the insert's foreign key: the two could deadlock. FOR NO KEY UPDATE does not conflict with FOR KEY SHARE,
--       so that insert goes on while the erasure waits for the old lines. The order everywhere is: the meeting row first (FOR SHARE in meetings.transcript.start and meetings.summary.start,
--       FOR NO KEY UPDATE here), then the text rows. The kernel maps a deadlock that still happens (40P01) to a retryable PERSONAL_DATA_BUSY.
SET LOCAL lock_timeout = '2s';

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_meetings.meeting_result'::pg_catalog.regclass AND conname = 'meeting_result_decisions_strings') THEN
    ALTER TABLE crove_meetings.meeting_result
      ADD CONSTRAINT meeting_result_decisions_strings
      CHECK (NOT pg_catalog.jsonb_path_exists(decisions, '$[*] ? (@.type() != "string")')) NOT VALID;
  END IF;
END
$chk$;
ALTER TABLE crove_meetings.meeting_result VALIDATE CONSTRAINT meeting_result_decisions_strings;

CREATE OR REPLACE FUNCTION crove_meetings.personal_notice_items(p_kind text, p_value text)
RETURNS TABLE (meeting_id uuid, recorder_user_id uuid, stamp bigint, key bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_key bytea;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_meetings.notice_key_of(v_org, p_kind, p_value);
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT s.meeting_id, s.stage FROM crove_meetings.transcript_segment s
     WHERE s.org_id = v_org AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
    UNION ALL
    SELECT r.meeting_id, r.stage FROM crove_meetings.meeting_result r
     WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value)
                                 OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND crove_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
    UNION ALL
    SELECT i.meeting_id, i.stage FROM crove_meetings.action_item i
     WHERE i.org_id = v_org AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
    UNION ALL
    SELECT m.id, NULL::text FROM crove_meetings.meeting m WHERE m.org_id = v_org AND crove_kernel.text_mentions(m.title, p_kind, p_value)
  ), unread AS (
    -- Meetings with at least one hit the owner cannot read: not their own meeting, and not a published row (or a title) of a meeting they are a reader of.
    SELECT DISTINCT h.meeting_id FROM hits h
     WHERE NOT (crove_meetings.is_meeting_recorder(v_org, h.meeting_id)
                OR (h.stage IS DISTINCT FROM 'draft' AND crove_meetings.is_meeting_reader(v_org, h.meeting_id)))
  )
  SELECT u.meeting_id, m.recorder_user_id,
         crove_meetings.text_stamp(v_org, u.meeting_id, crove_meetings.is_meeting_recorder(v_org, u.meeting_id), crove_meetings.is_meeting_reader(v_org, u.meeting_id)), v_key
    FROM unread u JOIN crove_meetings.meeting m ON m.org_id = v_org AND m.id = u.meeting_id
   ORDER BY u.meeting_id
   LIMIT 1001;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.personal_notice_items(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_notice_items(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_meetings.personal_erase(p_kind text, p_value text)
RETURNS TABLE (meeting_id uuid, recorder_user_id uuid, lines bigint, results bigint, items bigint, titles bigint, kept bigint, audio_until date, video_until date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
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
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member t
    WHERE t.org_id = v_org AND t.user_id = crove_kernel.ctx_user_id() AND t.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_meetings.notice_key_of(v_org, p_kind, p_value);
  v_hex := pg_catalog.encode(v_key, 'hex');
  -- The notices of this value, read once: each meeting entry '<id>:<stamp>' of an ok notify row written at least 24 hours ago, with the sender and the event that proves a recorder was told.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry', e.v, 'sender', a.actor_id, 'event', a.detail ->> 'event')), '[]'::jsonb) INTO v_notices
    FROM crove_kernel.audit_event a, pg_catalog.jsonb_array_elements_text(a.detail -> 'meetings') e(v)
   WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
     AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
     AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'meeting_key' = v_hex
     AND pg_catalog.jsonb_typeof(a.detail -> 'meetings') = 'array';
  FOR m IN
    WITH hits AS MATERIALIZED (
      SELECT s.meeting_id FROM crove_meetings.transcript_segment s
       WHERE s.org_id = v_org AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
      UNION
      SELECT r.meeting_id FROM crove_meetings.meeting_result r
       WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value)
                                   OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND crove_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
      UNION
      SELECT i.meeting_id FROM crove_meetings.action_item i
       WHERE i.org_id = v_org AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
      UNION
      SELECT x.id FROM crove_meetings.meeting x WHERE x.org_id = v_org AND crove_kernel.text_mentions(x.title, p_kind, p_value)
    )
    SELECT h.meeting_id FROM hits h ORDER BY h.meeting_id
  LOOP
    -- The meeting row and its text rows are locked first, then the stamp is taken, and only the rows locked are changed: a recorder's edit waits for this redaction, and text written after the
    -- lock (or a draft replaced meanwhile) is neither in the stamp a notice saw nor redacted.
    SELECT x.recorder_user_id INTO recorder_user_id FROM crove_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_seg FROM (SELECT s.id FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_res FROM (SELECT r.id FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_itm FROM (SELECT i.id FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
    meeting_id := m.meeting_id;
    v_rec := crove_meetings.is_meeting_recorder(v_org, m.meeting_id);
    v_read := crove_meetings.is_meeting_reader(v_org, m.meeting_id);
    -- A notice is looked for only where the owner cannot read everything (their own meeting needs none).
    v_named := false;
    IF NOT v_rec THEN
      v_stamp := crove_meetings.text_stamp(v_org, m.meeting_id, v_rec, v_read);
      v_named := EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_notices) n(j)
         WHERE n.j ->> 'entry' = m.meeting_id::text || ':' || v_stamp::text
           AND crove_meetings.notice_told(v_org, recorder_user_id, (n.j ->> 'sender')::uuid, n.j ->> 'event'));
    END IF;
    -- A line, summary, decision or item row is redacted when the owner reads it (the recorder's own, or a published row of a meeting they read) or a notice named the meeting at this text.
    WITH done AS (
      UPDATE crove_meetings.transcript_segment s
         SET text = pg_catalog.left(crove_kernel.text_redact(s.text, p_kind, p_value, v_mark), 4000),
             speaker_label = pg_catalog.left(crove_kernel.text_redact(s.speaker_label, p_kind, p_value, v_mark), 80),
             updated_at = pg_catalog.now()
       WHERE s.org_id = v_org AND s.id = ANY (v_seg)
         AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND s.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO lines FROM done;
    -- Decisions one jsonb element at a time, each cut to its own limit (500): only an element that holds the value changes, and the array keeps its shape.
    WITH done AS (
      UPDATE crove_meetings.meeting_result r
         SET summary = pg_catalog.left(crove_kernel.text_redact(r.summary, p_kind, p_value, v_mark), 8000),
             decisions = COALESCE((SELECT pg_catalog.jsonb_agg(CASE WHEN pg_catalog.jsonb_typeof(e.v) = 'string'
                                                                       THEN pg_catalog.to_jsonb(pg_catalog.left(crove_kernel.text_redact(e.v #>> '{}', p_kind, p_value, v_mark), 500))
                                                                       ELSE e.v END ORDER BY e.i)
                                     FROM pg_catalog.jsonb_array_elements(r.decisions) WITH ORDINALITY AS e(v, i)), '[]'::jsonb),
             updated_at = pg_catalog.now()
       WHERE r.org_id = v_org AND r.id = ANY (v_res)
         AND (crove_kernel.text_mentions(r.summary, p_kind, p_value)
              OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND crove_kernel.text_mentions(e.v #>> '{}', p_kind, p_value)))
         AND (v_named OR v_rec OR (v_read AND r.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO results FROM done;
    WITH done AS (
      UPDATE crove_meetings.action_item i
         SET title = pg_catalog.left(crove_kernel.text_redact(i.title, p_kind, p_value, v_mark), 300),
             who_drafted = pg_catalog.left(crove_kernel.text_redact(i.who_drafted, p_kind, p_value, v_mark), 200),
             when_drafted = pg_catalog.left(crove_kernel.text_redact(i.when_drafted, p_kind, p_value, v_mark), 200),
             updated_at = pg_catalog.now()
       WHERE i.org_id = v_org AND i.id = ANY (v_itm)
         AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND i.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO items FROM done;
    -- The title is read by whoever reads the meeting.
    WITH done AS (
      UPDATE crove_meetings.meeting x
         SET title = pg_catalog.left(crove_kernel.text_redact(x.title, p_kind, p_value, v_mark), 200), updated_at = pg_catalog.now()
       WHERE x.org_id = v_org AND x.id = m.meeting_id AND crove_kernel.text_mentions(x.title, p_kind, p_value)
         AND (v_named OR v_read)
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO titles FROM done;
    -- What still mentions the value: rows the owner cannot read and no notice covers at this text (and rows written after the lock).
    SELECT (SELECT pg_catalog.count(*) FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(r.summary, p_kind, p_value)
                     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND crove_kernel.text_mentions(e.v #>> '{}', p_kind, p_value))))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND crove_kernel.text_mentions(x.title, p_kind, p_value))
      INTO kept;
    -- Audio and video stay (a voice cannot be edited out): kept until their retention dates.
    SELECT CASE WHEN EXISTS (SELECT 1 FROM crove_meetings.audio_segment a WHERE a.org_id = v_org AND a.meeting_id = m.meeting_id) THEN x.audio_retention_date END
      INTO audio_until FROM crove_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id;
    SELECT v.video_retention_date INTO video_until FROM crove_meetings.meeting_video v WHERE v.org_id = v_org AND v.meeting_id = m.meeting_id;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.personal_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_erase(text, text) TO crove_tenant;
