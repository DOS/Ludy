-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings integrations C2 (#3174, PR A of the transcript-only import): whose transcription a transcript line is. Idempotent; applied files stay untouched.
--   crove_meetings.transcript_segment.source
--       'ludy' (Ludy's own transcription, or what the recorder typed: every row before this migration) or 'google_meet' (the transcript Google Meet wrote, taken by the import).
--       Set only by the INSERT of the recorder's own command; crove_tenant has no UPDATE on it (the column grant of 20261127300000 names text, speaker_label, corrected and
--       updated_at only, and this migration adds nothing to it), so a correction of a line's text keeps the label of the transcription it began as. The CHECK is added NOT VALID and
--       validated in the next file, so the migration holds no long lock on a big table (the new column has a constant default, so every existing row is 'ludy').
--   crove_meetings.transcript_segment_taint()
--       the body of 20261217100000 with two more rules, so the database backs the label and not only the command: a row whose source is not 'ludy' is born tainted (an insert with
--       `source <> 'ludy' AND NOT tainted` is refused, whoever inserts it), and `source` never changes after the insert, for anybody. Same signature, owner and grants.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.transcript_segment ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ludy';
ALTER TABLE crove_meetings.transcript_segment DROP CONSTRAINT IF EXISTS transcript_segment_source_check;
ALTER TABLE crove_meetings.transcript_segment ADD CONSTRAINT transcript_segment_source_check CHECK (source IN ('ludy', 'google_meet')) NOT VALID;

CREATE OR REPLACE FUNCTION crove_meetings.transcript_segment_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stage = 'published' AND NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_run_id IS NOT NULL AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    -- Text another party transcribed (the label of an import) is born unread, whoever inserts it: the recorder reads it before anything is published.
    IF NEW.source <> 'ludy' AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION crove_meetings.transcript_segment_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
