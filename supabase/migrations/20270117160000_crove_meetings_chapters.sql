-- SPDX-License-Identifier: AGPL-3.0-only
-- Meetings chapters (#3844, owner direction of 2026-11-18, ADR-0049 stage A): "Mục lục", the table of contents of a meeting, each chapter a short title and the second of the transcript line it
-- starts at. This step is the table, typed by hand by the recorder, published with the minutes and read by the meeting's readers; the recorder's own Vy fills it in a later step (the columns
-- `tainted` and `source_run_id` are here now, with the rules, so nothing is added to the table then). Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_chapter  one row per chapter: `stage` draft or published, `position` (1 to 20, in the order of the start), `title` (1 to 80 characters, one line), `start_seconds` (0 to 86400, a
--                                 whole second that the command checks against a real line of the meeting's transcript), `tainted` and `source_run_id` (as meeting_result: a row copied from a Vy
--                                 run is born tainted, the run never changes, only the recorder's review clears the taint). The same rules as meeting_result: the recorder reads and writes drafts and
--                                 reads published rows; a reader of the meeting reads published rows only; a row is born a draft; a published row is not edited (a new draft replaces it at the next publish).
--                                 These rules are in the row policies below, not in the queries, and every policy admits a user context only: an agent context (a member Vy run included), the system
--                                 context and the sealed company context read and write none. A row goes with its meeting (ON DELETE CASCADE: the recorder's delete, an owner's delete, the retention
--                                 shred, the org purge). A title may name a person: the command refuses an email address and a run of 8 or more digits in it, but the finder and the
--                                 erasure reach it anyway (last section), as they reach the title of a meeting.
-- crove_meetings.meeting_chapter_taint()   the trigger function: the insert and update rules of meeting_result_taint (20261217100000), for this table.
-- crove_meetings.personal_row_ids / personal_matches / personal_erase   restated so the personal-data finder and the erasure reach the chapter titles (last section), whatever the probes can match.
-- crove_meetings.text_stamp / personal_notice_items   restated so the notice path reaches the chapter titles (end of the file).
-- crove_meetings.meeting_drafts_due / meeting_draft_purge   restated from 20261230010000 (their newest bodies) with the draft chapters as a fifth source: a draft the recorder never published goes after 30
--                                 days, as every other draft does. Same signatures, worker-only checks and grants.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.meeting_chapter (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published')),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  title text NOT NULL CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 80 AND title OPERATOR(pg_catalog.!~) '[\r\n]'),
  start_seconds integer NOT NULL CHECK (start_seconds BETWEEN 0 AND 86400),
  tainted boolean NOT NULL DEFAULT false,
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_chapter_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_chapter_position_uq UNIQUE (org_id, meeting_id, stage, position),
  CONSTRAINT meeting_chapter_second_uq UNIQUE (org_id, meeting_id, stage, start_seconds)
);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_chapter');
REVOKE UPDATE ON crove_meetings.meeting_chapter FROM crove_tenant;
GRANT UPDATE (title, start_seconds, position, stage, updated_at) ON crove_meetings.meeting_chapter TO crove_tenant;

-- The recorder reads every stage; a reader of the meeting reads published rows only (a user context only: ctx_actor_type() is 'user' for a signed-in member alone).
DROP POLICY IF EXISTS meeting_chapter_read ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_read ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND (crove_meetings.is_meeting_recorder(org_id, meeting_id) OR (stage = 'published' AND crove_meetings.is_meeting_reader(org_id, meeting_id))));
-- Only the recorder inserts, and only drafts.
DROP POLICY IF EXISTS meeting_chapter_insert ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_insert ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
-- The recorder edits a draft and publishes it (draft to published, the one change of stage); a published row is not edited here.
DROP POLICY IF EXISTS meeting_chapter_update ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_update ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND stage = 'draft' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND stage IN ('draft', 'published') AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
-- The recorder deletes a draft of the set, and the published set when they publish another.
DROP POLICY IF EXISTS meeting_chapter_delete ON crove_meetings.meeting_chapter;
CREATE POLICY meeting_chapter_delete ON crove_meetings.meeting_chapter AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- The taint rules of meeting_result (20261217100000), for this table: a row that comes from a run is born tainted and the run never changes; the taint is cleared only by the recorder's review
-- (crove_meetings.draft_review, restated for this table when the chapters run lands) and never set again; a tainted draft is not published. A hand-typed chapter has no run and is never tainted.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_chapter_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage = 'published' AND NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_run_id IS NOT NULL AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_run_id IS DISTINCT FROM OLD.source_run_id THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.tainted IS DISTINCT FROM OLD.tainted AND (NEW.tainted OR current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_meetings.draft_review(uuid,uuid,uuid[])'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF OLD.stage = 'draft' AND NEW.stage = 'published' AND NEW.tainted THEN
    RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_chapter_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS meeting_chapter_taint ON crove_meetings.meeting_chapter;
CREATE TRIGGER meeting_chapter_taint BEFORE INSERT OR UPDATE ON crove_meetings.meeting_chapter
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_chapter_taint();

-- The 30 day draft expiry, with the draft chapters as a source.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_drafts_due(p_limit integer)
RETURNS TABLE (org_id uuid, meeting_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')) OR crove_kernel.ctx_actor_type() IS NOT NULL THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.org_id, d.meeting_id
  FROM (
    SELECT r.org_id, r.meeting_id, r.created_at FROM crove_meetings.meeting_result r
    WHERE r.stage = 'draft' AND r.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT a.org_id, a.meeting_id, a.created_at FROM crove_meetings.action_item a
    WHERE a.stage = 'draft' AND a.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT s.org_id, s.meeting_id, s.created_at FROM crove_meetings.transcript_segment s
    WHERE s.stage = 'draft' AND s.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT l.org_id, l.meeting_id, l.created_at FROM crove_meetings.live_line l
    WHERE l.created_at < pg_catalog.now() - interval '30 days'
    UNION ALL
    SELECT c.org_id, c.meeting_id, c.created_at FROM crove_meetings.meeting_chapter c
    WHERE c.stage = 'draft' AND c.created_at < pg_catalog.now() - interval '30 days'
  ) d
  -- Only orgs a system context can enter (active, or offboarding before its purge).
  JOIN crove_kernel.tenant t ON t.org_id = d.org_id AND t.status IN ('active', 'offboarding')
  GROUP BY d.org_id, d.meeting_id
  ORDER BY pg_catalog.min(d.created_at), d.org_id, d.meeting_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_drafts_due(integer) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_drafts_due(integer) TO crove_worker;

-- How many draft rows (of the five tables together) it deleted: a count, never text.
CREATE OR REPLACE FUNCTION crove_meetings.meeting_draft_purge(p_org_id uuid, p_meeting_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  IF (NOT pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER'))
     OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'system'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'MEETINGS_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  DELETE FROM crove_meetings.action_item
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  DELETE FROM crove_meetings.meeting_result
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  DELETE FROM crove_meetings.transcript_segment
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  -- The live preview (#3125): the recorder's tainted lines of a recording that never finished.
  DELETE FROM crove_meetings.live_line
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  -- The draft chapters (#3844): hand-typed or copied from the recorder's own Vy, never published.
  DELETE FROM crove_meetings.meeting_chapter
  WHERE org_id = p_org_id AND meeting_id = p_meeting_id AND stage = 'draft' AND created_at < pg_catalog.now() - interval '30 days';
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.meeting_draft_purge(uuid, uuid) TO crove_worker;

-- ---------------------------------------------------------------------------
-- The personal-data finder and the erasure reach the chapter titles (#3844)
-- ---------------------------------------------------------------------------
-- A chapter title may name a person, so the finder and the erasure treat it as they treat the title of a meeting, whatever the probes can match (a title is refused an email address and a run of
-- 8 or more digits by the command today; this does not rest on that rule). Three restatements, each from its newest definition, with the same signature, owner, search_path, grants and result columns
-- (the columns are a contract: a chapter title counts as a title):
--   personal_row_ids (20261231110000)  kind 6, a chapter, listed where the caller can read it (the recorder a draft, the readers a published one), by id, for an owner or an admin.
--   personal_matches (20261204200000)  the chapters the owner cannot read, counted per recorder as titles.
--   personal_erase   (20261231010000)  a chapter title that holds the value is redacted by the rule of the other rows (the owner reads it, or a notice named the meeting at this text), the chapters are locked
--                                      with the meeting's other text rows, counted in `titles`, and the ones still holding the value in `kept`.
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
    UNION ALL
    -- The chapters of a meeting (#3844): kind 6. A draft chapter is read by the recorder alone, a published one by the readers, as the readability check below decides.
    SELECT 6::smallint, c.id, c.meeting_id, c.stage FROM crove_meetings.meeting_chapter c
     WHERE c.org_id = v_org AND crove_kernel.text_mentions(c.title, p_kind, p_value)
    UNION ALL
    -- The addition: the recorder's rough notes (A5, #3163). Stage 'draft' so only the recorder passes the readability check below.
    SELECT 5::smallint, n.id, n.meeting_id, 'draft'::text FROM crove_meetings.meeting_note n
     WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value)
  )
  -- At most 1000 ids of each kind (6000 in all), so a flood of transcript lines never crowds out the summary, the items, the titles, the notes or the chapters; the finder lists 200 rows a column and says
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
REVOKE ALL ON FUNCTION crove_meetings.personal_row_ids(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_row_ids(text, text) TO crove_tenant;

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
    UNION ALL
    -- The chapters of a meeting (#3844) count as titles: the answer's columns are a contract, and a chapter title is the title of a part of the meeting.
    SELECT c.meeting_id, c.stage, 'title' FROM crove_meetings.meeting_chapter c
     WHERE c.org_id = v_org AND crove_kernel.text_mentions(c.title, p_kind, p_value)
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
REVOKE ALL ON FUNCTION crove_meetings.personal_matches(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_matches(text, text) TO crove_tenant;

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
  v_chp uuid[];
  v_n bigint;
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
      UNION
      SELECT c.meeting_id FROM crove_meetings.meeting_chapter c WHERE c.org_id = v_org AND crove_kernel.text_mentions(c.title, p_kind, p_value)
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
    SELECT COALESCE(pg_catalog.array_agg(l.id), '{}'::uuid[]) INTO v_chp FROM (SELECT c.id FROM crove_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id FOR NO KEY UPDATE) l;
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
    -- The chapter titles (#3844), read by the recorder (a draft) and the readers (published), redacted by the rule of the rows above; they count with the titles (the answer's columns are a contract).
    WITH done AS (
      UPDATE crove_meetings.meeting_chapter c
         SET title = pg_catalog.left(crove_kernel.text_redact(c.title, p_kind, p_value, v_mark), 80), updated_at = pg_catalog.now()
       WHERE c.org_id = v_org AND c.id = ANY (v_chp) AND crove_kernel.text_mentions(c.title, p_kind, p_value)
         AND (v_named OR v_rec OR (v_read AND c.stage <> 'draft'))
      RETURNING 1)
    SELECT pg_catalog.count(*) INTO v_n FROM done;
    titles := titles + v_n;
    -- What still mentions the value: rows the owner cannot read and no notice covers at this text (and rows written after the lock).
    SELECT (SELECT pg_catalog.count(*) FROM crove_meetings.transcript_segment s WHERE s.org_id = v_org AND s.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(s.text, p_kind, p_value) OR crove_kernel.text_mentions(s.speaker_label, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting_result r WHERE r.org_id = v_org AND r.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(r.summary, p_kind, p_value)
                     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r.decisions) e(v) WHERE pg_catalog.jsonb_typeof(e.v) = 'string' AND crove_kernel.text_mentions(e.v #>> '{}', p_kind, p_value))))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.action_item i WHERE i.org_id = v_org AND i.meeting_id = m.meeting_id
                AND (crove_kernel.text_mentions(i.title, p_kind, p_value) OR crove_kernel.text_mentions(i.who_drafted, p_kind, p_value) OR crove_kernel.text_mentions(i.when_drafted, p_kind, p_value)))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting x WHERE x.org_id = v_org AND x.id = m.meeting_id AND crove_kernel.text_mentions(x.title, p_kind, p_value))
         + (SELECT pg_catalog.count(*) FROM crove_meetings.meeting_chapter c WHERE c.org_id = v_org AND c.meeting_id = m.meeting_id AND crove_kernel.text_mentions(c.title, p_kind, p_value))
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
REVOKE ALL ON FUNCTION crove_meetings.personal_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_erase(text, text) TO crove_tenant;

-- The notice path reaches the chapter titles too (#3844): without it a chapter the owner cannot read could never be named in a notice, and the erasure would keep it for ever.
--   text_stamp           (20261205100000)  the chapters the owner cannot read are part of the stamp (kind 5), so a chapter edited after a notice moves the stamp and the notice no longer covers it.
--   personal_notice_items (20261210300000)  a meeting whose mention is in a chapter title is listed, by the rule of the other rows.
-- Each restated from its newest definition with only those lines added; same signatures, owners, search_path and grants.
CREATE OR REPLACE FUNCTION crove_meetings.text_stamp(p_org uuid, p_meeting uuid, p_rec boolean, p_read boolean)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ipad bytea;
  v_opad bytea;
  v_text text;
BEGIN
  SELECT k.k_ipad, k.k_opad INTO v_ipad, v_opad FROM crove_kernel.mail_hash_key k WHERE k.id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAIL_HASH_KEY_MISSING' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(pg_catalog.string_agg(t.v, pg_catalog.chr(31) ORDER BY t.k, t.id), '') INTO v_text
    FROM (
      SELECT 1 AS k, s.id::text AS id, s.stage || pg_catalog.chr(30) || s.speaker_label || pg_catalog.chr(30) || s.text AS v
        FROM crove_meetings.transcript_segment s
       WHERE s.org_id = p_org AND s.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND s.stage <> 'draft'))
      UNION ALL
      SELECT 2, r.id::text, r.stage || pg_catalog.chr(30) || r.summary || pg_catalog.chr(30) || r.decisions::text
        FROM crove_meetings.meeting_result r
       WHERE r.org_id = p_org AND r.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND r.stage <> 'draft'))
      UNION ALL
      SELECT 3, i.id::text, i.stage || pg_catalog.chr(30) || i.title || pg_catalog.chr(30) || i.who_drafted || pg_catalog.chr(30) || i.when_drafted
        FROM crove_meetings.action_item i
       WHERE i.org_id = p_org AND i.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND i.stage <> 'draft'))
      UNION ALL
      SELECT 4, m.id::text, m.title FROM crove_meetings.meeting m WHERE m.org_id = p_org AND m.id = p_meeting AND NOT p_read
      UNION ALL
      -- The chapter titles (#3844), by the rule of the other rows: the ones the owner cannot read.
      SELECT 5, c.id::text, c.stage || pg_catalog.chr(30) || c.title
        FROM crove_meetings.meeting_chapter c
       WHERE c.org_id = p_org AND c.meeting_id = p_meeting AND NOT (p_rec OR (p_read AND c.stage <> 'draft'))
    ) t;
  RETURN ('x' || pg_catalog.encode(pg_catalog.substr(
    pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || pg_catalog.convert_to(
      'crove.meetings.stamp.v1' || pg_catalog.chr(31) || p_org::text || pg_catalog.chr(31) || p_meeting::text || pg_catalog.chr(31) || v_text, 'UTF8'))), 1, 8), 'hex'))::bit(64)::bigint;
END $$;
REVOKE ALL ON FUNCTION crove_meetings.text_stamp(uuid, uuid, boolean, boolean) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

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
    UNION ALL
    -- The chapter titles (#3844): a meeting whose only mention is in a chapter the owner cannot read is listed too, so its recorder can be told.
    SELECT c.meeting_id, c.stage FROM crove_meetings.meeting_chapter c WHERE c.org_id = v_org AND crove_kernel.text_mentions(c.title, p_kind, p_value)
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
