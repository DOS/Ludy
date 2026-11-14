-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings E2 (issue #3185, plan docs/plan/meetings-integrations.md section 7a, ADR-0049 stage A): the machine translation of a meeting's transcript. The member's own Vy translates the
-- transcript lines that member reads (published lines for a reader, the draft for the recorder) a few chunks at a time, in the member's own request, and the member's own copy command
-- keeps the checked parts in the private translation row E1 made (#3184). Owner decision of 2026-11-14: a translation is private to the member who asked for it. No new table, no new
-- function that reads text. Idempotent; applied files stay untouched.
--
-- 1. crove_meetings.translation.kind takes 'transcript': one row per member, meeting, target language and source stage, holding every translated part kept so far (the row's own policies,
--    unchanged, already say: the member who asked reads, writes and deletes it, in a user context, for a stage they still read).
-- 2. translation_drop_transcript: when a transcript line of a stage is deleted (a replaced or expired draft, a meeting's removal) or changes stage, the transcript translations of that
--    stage are deleted with it, every member's: nothing translated outlives the text it translated. A corrected line is not deleted: each stored part carries the hash of the line it
--    translated, so the read shows that part as "Bản dịch cũ" when the line changed.
-- 3. translation_drop_stale (E1, 20261231010000) restated with the kind it serves: a summary replaced or published drops the translations of the SUMMARY of that stage only, never a
--    member's transcript translations (those are dropped by their own lines, section 2).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The transcript kind
-- ---------------------------------------------------------------------------
ALTER TABLE crove_meetings.translation DROP CONSTRAINT IF EXISTS translation_kind_check;
ALTER TABLE crove_meetings.translation ADD CONSTRAINT translation_kind_check CHECK (kind IN ('summary', 'transcript'));

-- ---------------------------------------------------------------------------
-- 2. A transcript translation never outlives the lines it translated
-- ---------------------------------------------------------------------------
-- A definer, because the line that is deleted is the recorder's and the translations dropped are other members'. It deletes by meeting and stage only and returns nothing.
CREATE OR REPLACE FUNCTION crove_meetings.translation_drop_transcript() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'transcript' AND t.source_stage = OLD.stage;
  ELSE
    -- A stage change (a draft published): the translations of the stage it left and of the stage it joins.
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'transcript' AND t.source_stage IN (OLD.stage, NEW.stage);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.translation_drop_transcript() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS transcript_segment_translation_drop ON crove_meetings.transcript_segment;
CREATE TRIGGER transcript_segment_translation_drop AFTER DELETE ON crove_meetings.transcript_segment
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.translation_drop_transcript();
DROP TRIGGER IF EXISTS transcript_segment_translation_stage ON crove_meetings.transcript_segment;
CREATE TRIGGER transcript_segment_translation_stage AFTER UPDATE OF stage ON crove_meetings.transcript_segment
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION crove_meetings.translation_drop_transcript();

-- ---------------------------------------------------------------------------
-- 3. E1's drop of stale summary translations names its kind
-- ---------------------------------------------------------------------------
-- Restated from 20261231010000 with one change: the deletes name kind = 'summary'. Same signature, owner, search_path and grants; the triggers that call it are unchanged.
CREATE OR REPLACE FUNCTION crove_meetings.translation_drop_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'summary' AND t.source_stage = OLD.stage;
  ELSE
    DELETE FROM crove_meetings.translation t WHERE t.org_id = OLD.org_id AND t.meeting_id = OLD.meeting_id AND t.kind = 'summary' AND t.source_stage IN (OLD.stage, NEW.stage);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.translation_drop_stale() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
