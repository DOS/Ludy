-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, #2951 (from the security review of #2949, ADR-0049 decision 4): the INSERT branch of the taint triggers. A row that names a Vy run (source_run_id) is the
-- model's text, so it is born tainted: an insert with `source_run_id IS NOT NULL AND NOT tainted` is refused, for transcript_segment, meeting_result and action_item alike (the
-- copy commands write exactly tainted rows with their run, so nothing legitimate is refused). The rule is for the INSERT only: draft_review clears the mark later and the row keeps
-- the run it came from. The three trigger functions are restated in full from their newest definitions (20261203100000 for meeting_result and action_item, 20261216100000 for
-- transcript_segment; the applied files are not edited); the update rules are unchanged, and meeting_result and action_item, which had an UPDATE trigger only, now fire on INSERT too.
-- Idempotent.
SET LOCAL lock_timeout = '2s';


CREATE OR REPLACE FUNCTION crove_meetings.meeting_result_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_run_id IS NOT NULL AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
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
DROP TRIGGER IF EXISTS meeting_result_taint ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_taint BEFORE INSERT OR UPDATE ON crove_meetings.meeting_result
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_result_taint();

CREATE OR REPLACE FUNCTION crove_meetings.action_item_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_run_id IS NOT NULL AND NOT NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
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
DROP TRIGGER IF EXISTS action_item_taint ON crove_meetings.action_item;
CREATE TRIGGER action_item_taint BEFORE INSERT OR UPDATE ON crove_meetings.action_item
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.action_item_taint();

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

REVOKE ALL ON FUNCTION crove_meetings.meeting_result_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_meetings.action_item_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
REVOKE ALL ON FUNCTION crove_meetings.transcript_segment_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
