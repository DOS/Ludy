-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings E1 (issue #3184, plan docs/plan/meetings-integrations.md section 7a, ADR-0049 stage A and decision 8): the machine translation of a meeting's summary. The member's own Vy
-- translates the summary, its decisions and its action item titles between Vietnamese and English (the member clicks, one model call, feature meetings.translate), and the member's own
-- command keeps the checked answer here. Owner decision of 2026-11-14: a translation is private to the member who asked for it. Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.translation: one row per member, meeting, kind ('summary'; the transcript's later), target language and source stage ('draft' or 'published'), with the hash of the source
--    text, the checked segments (jsonb) and the taint (always true: a model's words, with no review that clears it). Read, written and deleted by the member who asked, in a user context,
--    and only while that member still reads the stage they translated (the recorder for a draft, a reader or the recorder for the published summary): an owner or admin who is not a reader,
--    another member, an org-chart agent, a member Vy run and the system context read and write none. No UPDATE (asking again deletes the row and writes a new one).
-- 2. translation_drop_stale: when a summary row or an action item row of a stage is deleted (a replaced or expired draft, a published summary replaced or one day removed, a meeting's
--    draft purge) or changes stage (published by the recorder), the translations of that stage are deleted with it, every member's: nothing translated outlives the text it translated.
--    No command unpublishes a result today; any path that does is covered.
-- 3. crove_meetings.meeting_discard_transcribe() restated from 20261229020000 with the feature meetings.translate added, so a meeting's removal cancels a translation run and deletes its result.
-- 4. crove_meetings.personal_erase(text, text) restated from 20261210300000 with one addition: the translations of every meeting the erasure touches are dropped (not redacted).
-- A meeting's delete, the text retention and the org purge reach the table through its foreign key (the org purge's list is in the next file).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The translations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_meetings.translation (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  -- The member who asked: no foreign key to tenant_member (the rows of a removed member are unreadable, as their Vy results are, and go with the meeting).
  member_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('summary')),
  target_language text NOT NULL CHECK (target_language IN ('vi', 'en')),
  source_stage text NOT NULL CHECK (source_stage IN ('draft', 'published')),
  -- The sha256 of the original text this was made from: a changed original has another hash and the translation then shows as stale.
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  -- The checked segments: [{key, text, state, codes}], a refused segment holds no text. Free text of a model, personal data (the registry says so).
  body jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(body) = 'array' AND pg_catalog.pg_column_size(body) <= 400000),
  -- The model's words: tainted for as long as the row exists, and never shown to anyone but the member who asked. The run it was copied from is the taint's source (ADR-0049 decision 4);
  -- nullable so a row outlives its run row.
  tainted boolean NOT NULL DEFAULT true CHECK (tainted),
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT translation_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT translation_one_uq UNIQUE (org_id, meeting_id, member_user_id, kind, target_language, source_stage)
);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.translation');
REVOKE UPDATE ON crove_meetings.translation FROM crove_tenant;

-- Only the member who asked, in a user context (ctx_user_id is NULL for an agent context, a member Vy run included, and for the system), and only for a stage they read:
-- is_meeting_recorder answers false for anyone but the recorder, is_meeting_reader answers true for the recorder and the meeting's readers (an active member of an acting role).
DROP POLICY IF EXISTS translation_read ON crove_meetings.translation;
CREATE POLICY translation_read ON crove_meetings.translation AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (member_user_id = crove_kernel.ctx_user_id() AND crove_kernel.ctx_actor_type() = 'user'
         AND ((source_stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
              OR (source_stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))));

DROP POLICY IF EXISTS translation_insert ON crove_meetings.translation;
CREATE POLICY translation_insert ON crove_meetings.translation AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (member_user_id = crove_kernel.ctx_user_id() AND crove_kernel.ctx_actor_type() = 'user'
              AND ((source_stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
                   OR (source_stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))));

-- A member may delete their own row even after they stopped reading the meeting.
DROP POLICY IF EXISTS translation_delete ON crove_meetings.translation;
CREATE POLICY translation_delete ON crove_meetings.translation AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (member_user_id = crove_kernel.ctx_user_id() AND crove_kernel.ctx_actor_type() = 'user');

-- ---------------------------------------------------------------------------
-- 2. A translation never outlives the text it translated
-- ---------------------------------------------------------------------------
-- A definer, because the row that is deleted or published is the recorder's and the translations dropped are other members'. It deletes by meeting and stage only and returns nothing.
CREATE OR REPLACE FUNCTION crove_meetings.translation_drop_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.source_stage = OLD.stage;
  ELSE
    -- A stage change (a draft published): the translations of the stage it left, and of the stage it joins (the published text changed).
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.source_stage IN (OLD.stage, NEW.stage);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.translation_drop_stale() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS meeting_result_translation_drop ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_translation_drop AFTER DELETE ON crove_meetings.meeting_result
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.translation_drop_stale();
DROP TRIGGER IF EXISTS meeting_result_translation_stage ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_translation_stage AFTER UPDATE OF stage ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.translation_drop_stale();
DROP TRIGGER IF EXISTS action_item_translation_drop ON crove_meetings.action_item;
CREATE TRIGGER action_item_translation_drop AFTER DELETE ON crove_meetings.action_item
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.translation_drop_stale();
DROP TRIGGER IF EXISTS action_item_translation_stage ON crove_meetings.action_item;
CREATE TRIGGER action_item_translation_stage AFTER UPDATE OF stage ON crove_meetings.action_item
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.translation_drop_stale();

-- ---------------------------------------------------------------------------
-- 3. A meeting's removal reaches a translation run too
-- ---------------------------------------------------------------------------
-- Restated from 20261229020000 (the newest definition) with one change: the feature lists gain meetings.translate. The trigger itself, its audit rows and its grants are unchanged.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    UPDATE crove_kernel.ai_run a SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
    WHERE a.org_id = OLD.org_id AND a.status = 'running'
      AND a.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                   WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id)
    RETURNING a.id AS run_id,
              (SELECT v.feature FROM crove_kernel.member_vy_result v WHERE v.org_id = OLD.org_id AND v.run_id = a.id AND v.subject_type = 'meeting' AND v.subject_id = OLD.id LIMIT 1) AS feature
  LOOP
    INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
    VALUES (OLD.org_id, 'system', NULL, 'meetings.vy.run_cancelled', crove_kernel.uuid_v7(), 'ok', 'kernel.ai_run', r.run_id,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.run_id::text, 'UTF8')), 'hex'),
            pg_catalog.jsonb_build_object('runId', r.run_id, 'meetingId', OLD.id, 'feature', r.feature, 'reason', 'MEETING_REMOVED'));
  END LOOP;
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary', 'meetings.live_notes', 'meetings.live_summary', 'meetings.translate') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. The personal-data erasure drops the translations of a meeting it touches
-- ---------------------------------------------------------------------------
-- Restated from 20261210300000 (the newest definition) with one addition, marked below; same signature, owner, search_path and grants.
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
    -- The machine translations of this meeting (#3184), every member's, are DROPPED, not redacted: a redacted original would leave the translated name behind, and a name cannot be located
    -- reliably in another language. They are the member's own derived copies (asking again makes a new one), so dropping loses no source. The meeting row is locked above, so a translation
    -- being kept at this moment (meetings.translation.copy_result) either finished first (and is dropped here) or waits and finds its original redacted (its hash no longer matches).
    DELETE FROM crove_meetings.translation x WHERE x.org_id = v_org AND x.meeting_id = m.meeting_id;
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
