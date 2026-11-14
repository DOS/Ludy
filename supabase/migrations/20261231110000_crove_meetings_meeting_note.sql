-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings A5 (issue #3163, plan docs/plan/meetings-integrations.md section 4.4): "Ghi chú của tôi", the recorder's own rough notes of a meeting. Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_note  one row per meeting: the recorder's rough notes, typed by hand (or kept from a box on the meeting page). Only the recorder reads, writes and deletes it:
--                              an attendee, an owner, an admin, another member, an agent context (a member Vy run included) and the system context read none, and the table is a
--                              table of its own (not a column of meeting) because the meeting row is read by every reader of the meeting. A row goes with its meeting (ON DELETE CASCADE:
--                              the recorder's delete, an owner's delete, the retention shred at the text date, the org purge). The text is the recorder's own, never the model's, so there
--                              is no taint here; the model's expansion of it is a Vy result the recorder copies into their draft (meetings.summary.copy_result).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_meetings.meeting_note (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  meeting_id uuid NOT NULL,
  body text NOT NULL CHECK (pg_catalog.char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT meeting_note_meeting_fk FOREIGN KEY (org_id, meeting_id) REFERENCES crove_meetings.meeting (org_id, id) ON DELETE CASCADE,
  CONSTRAINT meeting_note_one_uq UNIQUE (org_id, meeting_id)
);

SELECT crove_kernel.apply_tenant_rls('crove_meetings.meeting_note');
REVOKE UPDATE ON crove_meetings.meeting_note FROM crove_tenant;
GRANT UPDATE (body, updated_at) ON crove_meetings.meeting_note TO crove_tenant;

-- The recorder alone, in a user context: is_meeting_recorder answers false for every other member, and ctx_actor_type() is 'user' only for a signed-in member (an agent context,
-- a member Vy run included, and the system context are refused).
DROP POLICY IF EXISTS meeting_note_read ON crove_meetings.meeting_note;
CREATE POLICY meeting_note_read ON crove_meetings.meeting_note AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS meeting_note_insert ON crove_meetings.meeting_note;
CREATE POLICY meeting_note_insert ON crove_meetings.meeting_note AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS meeting_note_update ON crove_meetings.meeting_note;
CREATE POLICY meeting_note_update ON crove_meetings.meeting_note AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id))
  WITH CHECK (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));
DROP POLICY IF EXISTS meeting_note_delete ON crove_meetings.meeting_note;
CREATE POLICY meeting_note_delete ON crove_meetings.meeting_note AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (crove_kernel.ctx_actor_type() = 'user' AND crove_meetings.is_meeting_recorder(org_id, meeting_id));

-- ---------------------------------------------------------------------------
-- The personal-data finder reaches the notes (L5)
-- ---------------------------------------------------------------------------
-- crove_meetings.personal_row_ids restated from 20261204200000 (the newest definition) with one addition, marked below: kind 5 is a rough note whose text holds the value. Same signature,
-- owner, search_path and grants. The notes are the recorder's private text, so a hit counts only for their recorder (the stage is 'draft' for the check below: no reader passes it), the
-- finder then reads the rows by id under row security as for every table, and an owner who is not the recorder gets neither a row nor a count. personal_matches and personal_erase are
-- not restated (their result columns are a contract, and a changed one needs a DROP and an ADR): the notes have two sibling functions below, with the same owner-only rule and the same matcher.
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
    -- The addition: the recorder's rough notes (A5, #3163). Stage 'draft' so only the recorder passes the readability check below.
    SELECT 5::smallint, n.id, n.meeting_id, 'draft'::text FROM crove_meetings.meeting_note n
     WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value)
  )
  -- At most 1000 ids of each kind (5000 in all), so a flood of transcript lines never crowds out the summary, the items, the titles or the notes; the finder lists 200 rows a column and says
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

-- crove_meetings.personal_note_counts(kind, value)  per RECORDER, how many rough notes of THEIR meetings hold the value, among the notes the caller cannot read (every note but the caller's own).
--                                                   Numbers and the recorder's id only: never text or a meeting id. An owner's user context only (the counts are an oracle for a guessed value).
-- crove_meetings.personal_note_erase(kind, value)   redacts the value in the CALLER's own notes (the owner is the recorder: the owner's own erasure is the authority, as for every row they read),
--                                                   returns how many notes it changed and how many other notes still hold the value (private to their recorders, so left). An owner's user context only.
-- Same matcher as personal_matches and personal_erase (crove_kernel.text_mentions and text_redact, which raise on any shape but the finder's probe before a row is read).
CREATE OR REPLACE FUNCTION crove_meetings.personal_note_counts(p_kind text, p_value text)
RETURNS TABLE (recorder_user_id uuid, notes bigint)
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
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  RETURN QUERY
  SELECT m.recorder_user_id, pg_catalog.count(*)::bigint
    FROM crove_meetings.meeting_note n
    JOIN crove_meetings.meeting m ON m.org_id = v_org AND m.id = n.meeting_id
   WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value) AND NOT crove_meetings.is_meeting_recorder(v_org, n.meeting_id)
   GROUP BY m.recorder_user_id
   ORDER BY m.recorder_user_id;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.personal_note_counts(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_note_counts(text, text) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_meetings.personal_note_erase(p_kind text, p_value text)
RETURNS TABLE (erased bigint, kept bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_mark constant text := '[đã xóa]';
BEGIN
  IF v_org IS NULL OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
    WHERE m.org_id = v_org AND m.user_id = crove_kernel.ctx_user_id() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'MEETINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM crove_kernel.text_mention_pattern(p_kind, p_value);
  -- The caller's own notes only: the rows are locked first, so a recorder's edit waits for this redaction.
  WITH mine AS (
    SELECT n.id FROM crove_meetings.meeting_note n
     WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value) AND crove_meetings.is_meeting_recorder(v_org, n.meeting_id)
     ORDER BY n.id FOR NO KEY UPDATE
  ), done AS (
    UPDATE crove_meetings.meeting_note n
       SET body = pg_catalog.left(crove_kernel.text_redact(n.body, p_kind, p_value, v_mark), 8000), updated_at = pg_catalog.now()
      FROM mine WHERE n.org_id = v_org AND n.id = mine.id
    RETURNING 1)
  SELECT pg_catalog.count(*) INTO erased FROM done;
  SELECT pg_catalog.count(*) INTO kept FROM crove_meetings.meeting_note n WHERE n.org_id = v_org AND crove_kernel.text_mentions(n.body, p_kind, p_value);
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.personal_note_erase(text, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.personal_note_erase(text, text) TO crove_tenant;
