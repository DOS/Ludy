-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2580, ADR-0047 point 8, ADR-0049 decision 8, meetings plan M6, part B1): what the recorder's Vy summary needs of the database.
-- Idempotent; applied files stay untouched.
--
-- crove_meetings.meeting_result_taint(), action_item_taint()
--     BEFORE UPDATE triggers. `tainted` marks text the model wrote and nobody has edited since. A row is born tainted only by an insert (the recorder's
--     copy of a Vy result, meetings.summary.copy_result); an update never makes a row tainted, and clears the mark only together with a change of the
--     text it marks (the summary or the decisions of a result, the title of an item), so the recorder's own edit makes the text theirs and nothing
--     else, not even a column grant, can wash the mark off or put it on.
-- crove_meetings.meeting_discard_transcribe()
--     as in 20261202000000, now also for the feature meetings.summary: a meeting's removal (the recorder's delete, an owner's compliance delete, the text
--     purge, a shred replay) cancels the live summary runs for it and deletes their result rows, a finished result that was never copied included.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_meetings.meeting_result_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tainted IS DISTINCT FROM OLD.tainted THEN
    IF NEW.tainted THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.summary IS NOT DISTINCT FROM OLD.summary AND NEW.decisions IS NOT DISTINCT FROM OLD.decisions THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_result_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS meeting_result_taint ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_taint BEFORE UPDATE ON crove_meetings.meeting_result
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_result_taint();

CREATE OR REPLACE FUNCTION crove_meetings.action_item_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tainted IS DISTINCT FROM OLD.tainted THEN
    IF NEW.tainted OR NEW.title IS NOT DISTINCT FROM OLD.title THEN
      RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.action_item_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS action_item_taint ON crove_meetings.action_item;
CREATE TRIGGER action_item_taint BEFORE UPDATE ON crove_meetings.action_item
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.action_item_taint();

CREATE OR REPLACE FUNCTION crove_meetings.meeting_discard_transcribe() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE crove_kernel.ai_run r SET status = 'cancelled', finished_at = pg_catalog.now(), error = 'MEETING_REMOVED'
  WHERE r.org_id = OLD.org_id AND r.status = 'running'
    AND r.id IN (SELECT v.run_id FROM crove_kernel.member_vy_result v
                 WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id);
  DELETE FROM crove_kernel.member_vy_result v
  WHERE v.org_id = OLD.org_id AND v.feature IN ('meetings.transcribe', 'meetings.summary') AND v.subject_type = 'meeting' AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.meeting_discard_transcribe() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
