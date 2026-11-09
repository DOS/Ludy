-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings L5 (#2594, plan L5, ADR-0047 points 2 and 7, ADR-0037 section 5), part 2: the erasure in meeting text.
--   crove_meetings.personal_notice_items(kind, value)   the meetings whose text holds the value in rows the OWNER cannot read, with their recorder, the stamp of their text now and the
--                                                        notice key of the value, for the owner's notice (kernel.personal_data.notify). Ids, a number and a key, never text.
--   crove_meetings.personal_erase(kind, value)          replaces every whole mention of the value with the erasure mark, in place, in the text rows of the meetings that hold it,
--                                                        and answers, per meeting, how many rows it changed, how many still mention the value and the dates audio and video are kept to.
-- Two classes of row (the answer to the owner's request, as for shared and private notes, ADR-0037 section 5):
--   (a) a row the owner reads (their own meeting, a published row of a meeting they are a reader of): redacted at once; the owner's R3 erasure is the authority, as it is for a
--       shared note, and nothing is lost but the mention;
--   (b) a row the owner cannot read (an attendees-only meeting they are no reader of, a draft that is not theirs): redacted only when an earlier notice named its meeting at the text
--       it has now (the stamp: a hash of the meeting's text rows, which moves on any edit, so text the recorder changed after the notice stays until a new notice), and its recorder
--       was told at least 24 hours ago (the notification of that notice, or the recorder is the owner who sent it). The owner reads none of it; the rest stays and is counted.
-- Whether a row is readable is decided by the exact RLS functions (is_meeting_recorder, is_meeting_reader) plus the draft rule (only the recorder reads a draft), as in
-- personal_row_ids (20261204200000). Nothing but the text columns changes: a draft's `tainted` mark, the stage, the reader list, the audio, the video, the files and the Vy results are
-- untouched (the taint triggers only refuse a change of the mark, which this never makes, so a tainted draft stays unpublishable until its recorder has read it). Both are callable in a
-- user context only, checked inside to be an OWNER of the context's org; the erasure runs inside kernel.personal_data.erase, through Runtime.execute, with its audit row. The pattern is
-- built from a validated value, with no back reference, so the scans are linear in the text. At most 500 meetings are redacted in one call (run the erasure again for more). New functions
-- and helpers: no applied file is touched, and no helper is callable by a login role.
SET LOCAL lock_timeout = '2s';

-- The notice key of a value in an org: an HMAC-SHA256 under the deployment's hash key over a domain label, the org, the kind and the value, so a notice for one person never covers the
-- erasure of another, and the key reveals nothing of the value. A helper, executable by no login role.
CREATE OR REPLACE FUNCTION crove_meetings.notice_key_of(p_org uuid, p_kind text, p_value text)
RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_value text;
BEGIN
  v_value := CASE WHEN p_kind = 'digits' AND p_value ~ '^84[0-9]{9,10}$' THEN '0' || pg_catalog.substr(p_value, 3) ELSE p_value END;
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
    'crove.meetings.notice.v1' || pg_catalog.chr(31) || p_org::text || pg_catalog.chr(31) || p_kind || pg_catalog.chr(31) || v_value, 'UTF8')));
END $$;
REVOKE ALL ON FUNCTION crove_meetings.notice_key_of(uuid, text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- A hash of the text rows of one meeting (transcript lines and labels, summary and decisions, items, title), as a number: it moves on any change of that text, whatever the row's
-- updated_at says, so a notice names the text it saw. A helper, executable by no login role.
CREATE OR REPLACE FUNCTION crove_meetings.text_stamp(p_org uuid, p_meeting uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(('x' || pg_catalog.substr(pg_catalog.md5(pg_catalog.string_agg(t.v, pg_catalog.chr(31) ORDER BY t.k, t.id)), 1, 16))::bit(64)::bigint, 0)
    FROM (
      SELECT 1 AS k, s.id::text AS id, s.stage || pg_catalog.chr(30) || s.speaker_label || pg_catalog.chr(30) || s.text AS v
        FROM crove_meetings.transcript_segment s WHERE s.org_id = p_org AND s.meeting_id = p_meeting
      UNION ALL
      SELECT 2, r.id::text, r.stage || pg_catalog.chr(30) || r.summary || pg_catalog.chr(30) || r.decisions::text
        FROM crove_meetings.meeting_result r WHERE r.org_id = p_org AND r.meeting_id = p_meeting
      UNION ALL
      SELECT 3, i.id::text, i.stage || pg_catalog.chr(30) || i.title || pg_catalog.chr(30) || i.who_drafted || pg_catalog.chr(30) || i.when_drafted
        FROM crove_meetings.action_item i WHERE i.org_id = p_org AND i.meeting_id = p_meeting
      UNION ALL
      SELECT 4, m.id::text, m.title FROM crove_meetings.meeting m WHERE m.org_id = p_org AND m.id = p_meeting
    ) t
$$;
REVOKE ALL ON FUNCTION crove_meetings.text_stamp(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- Whether a notice reached a recorder at least 24 hours ago: the owner who sent it (never notified of their own action), or a member with the notice's notification written that long
-- ago (kernel.notification.dispatch writes it from the event the notice emitted). A helper, executable by no login role.
CREATE OR REPLACE FUNCTION crove_meetings.notice_told(p_org uuid, p_recorder uuid, p_sender uuid, p_event text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_recorder = p_sender
      OR (p_event IS NOT NULL AND EXISTS (
            SELECT 1 FROM crove_kernel.notification x
             WHERE x.org_id = p_org AND x.user_id = p_recorder AND x.kind = 'kernel.personal_data_notice'
               AND x.dedupe_key = 'personal_data_notice:' || p_event
               AND x.created_at <= pg_catalog.now() - interval '24 hours'))
$$;
REVOKE ALL ON FUNCTION crove_meetings.notice_told(uuid, uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
     WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value))
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
  SELECT u.meeting_id, m.recorder_user_id, crove_meetings.text_stamp(v_org, u.meeting_id), v_key
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
  v_mark constant text := '[đã xóa]';
  m record;
  v_rec boolean;
  v_read boolean;
  v_stamp bigint;
  v_named boolean;
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member t
    WHERE t.org_id = v_org AND t.user_id = crove_kernel.ctx_user_id() AND t.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  v_key := crove_meetings.notice_key_of(v_org, p_kind, p_value);
  FOR m IN
    WITH hits AS MATERIALIZED (
      SELECT s.meeting_id FROM crove_meetings.transcript_segment s
       WHERE s.org_id = v_org AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
      UNION
      SELECT r.meeting_id FROM crove_meetings.meeting_result r
       WHERE r.org_id = v_org AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value))
      UNION
      SELECT i.meeting_id FROM crove_meetings.action_item i
       WHERE i.org_id = v_org AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value))
      UNION
      SELECT x.id FROM crove_meetings.meeting x WHERE x.org_id = v_org AND crove_kernel.text_mentions(x.title, p_kind, p_value)
    )
    SELECT h.meeting_id FROM hits h ORDER BY h.meeting_id LIMIT 500
  LOOP
    -- The meeting row is locked first, so a recorder's edit that locks it waits for this redaction (and the stamp below is of the text this redacts).
    SELECT x.recorder_user_id INTO recorder_user_id FROM crove_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    meeting_id := m.meeting_id;
    v_rec := crove_meetings.is_meeting_recorder(v_org, m.meeting_id);
    v_read := crove_meetings.is_meeting_reader(v_org, m.meeting_id);
    v_stamp := crove_meetings.text_stamp(v_org, m.meeting_id);
    v_named := EXISTS (
      SELECT 1 FROM crove_kernel.audit_event a
       WHERE a.org_id = v_org AND a.command = 'kernel.personal_data.notify' AND a.outcome = 'ok'
         AND a.occurred_at <= pg_catalog.now() - interval '24 hours'
         AND pg_catalog.jsonb_typeof(a.detail) = 'object' AND a.detail ->> 'meeting_key' = pg_catalog.encode(v_key, 'hex')
         AND pg_catalog.jsonb_typeof(a.detail -> 'meetings') = 'array' AND (a.detail -> 'meetings') ? (m.meeting_id::text || ':' || v_stamp::text)
         AND crove_meetings.notice_told(v_org, recorder_user_id, a.actor_id, a.detail ->> 'event'));
    -- A line, summary, decision or item row is redacted when the owner reads it (the recorder's own, or a published row of a meeting they read) or a notice named the meeting at this text.
    WITH done AS (
      UPDATE crove_meetings.transcript_segment s
         SET text = pg_catalog.left(crove_kernel.text_redact(s.text, p_kind, p_value, v_mark), 4000),
             speaker_label = pg_catalog.left(crove_kernel.text_redact(s.speaker_label, p_kind, p_value, v_mark), 80),
             updated_at = pg_catalog.now()
       WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
         AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND s.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO lines FROM done;
    WITH done AS (
      UPDATE crove_meetings.meeting_result r
         SET summary = pg_catalog.left(crove_kernel.text_redact(r.summary, p_kind, p_value, v_mark), 8000),
             decisions = COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(crove_kernel.text_redact(e.v, p_kind, p_value, v_mark)) ORDER BY e.i)
                                     FROM pg_catalog.jsonb_array_elements_text(r.decisions) WITH ORDINALITY AS e(v, i)), '[]'::jsonb),
             updated_at = pg_catalog.now()
       WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
         AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value))
         AND (v_named OR v_rec OR (v_read AND r.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO results FROM done;
    WITH done AS (
      UPDATE crove_meetings.action_item i
         SET title = pg_catalog.left(crove_kernel.text_redact(i.title, p_kind, p_value, v_mark), 300),
             who_drafted = pg_catalog.left(crove_kernel.text_redact(i.who_drafted, p_kind, p_value, v_mark), 200),
             when_drafted = pg_catalog.left(crove_kernel.text_redact(i.when_drafted, p_kind, p_value, v_mark), 200),
             updated_at = pg_catalog.now()
       WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id
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
    -- What still mentions the value: rows the owner cannot read and no notice covers at this text.
    SELECT (SELECT pg_catalog.count(*) FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(r.summary, p_kind, p_value) OR crove_kernel.text_mentions(r.decisions::text, p_kind, p_value)))
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
