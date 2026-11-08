-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings (issue #2580, ADR-0047 point 8, ADR-0049 decisions 4 and 8, meetings plan M6, part B1): what the recorder's Vy summary needs of the database.
-- Idempotent; applied files stay untouched.
--
-- meeting_result.source_run_id, action_item.source_run_id
--     the Vy run a model-written row was copied from (null for what the recorder typed): the row's source, set by the recorder's own copy command.
-- crove_meetings.meeting_result_taint(), action_item_taint()
--     BEFORE UPDATE triggers. `tainted` marks text the model wrote and nobody has reviewed. A row is born tainted only by an insert (the recorder's copy of a
--     Vy result, meetings.summary.copy_result); no update ever makes a row tainted; the tenant context (crove_tenant, which every user request runs as) cannot
--     change the mark at all, and only draft_review below clears it; and a draft that is still tainted is never published, whoever asks. The clear check
--     compares current_user with the owner of draft_review (inside the definer that is the owner; in a user request it is the login role). It therefore trusts
--     every function owned by that role, which today is the migration role that owns every definer of this schema, and only draft_review writes `tainted`;
--     a superuser and a session in replica mode can also bypass it, which is outside the threat model of a user request.
-- crove_meetings.draft_review(org, meeting, ids)
--     the recorder's explicit "I read this": clears the mark on the draft rows of their own meeting that the caller names by id (so a row copied in another tab
--     after the recorder last looked, which has an id they never saw, keeps its mark). The edit command calls it for the one item whose title the recorder just
--     changed, and meetings.draft.review for the rows the screen showed. User context only, recorder only.
-- tainted column grant
--     crove_tenant has no UPDATE on `tainted` at all (defence in depth beside the triggers).
-- crove_meetings.meeting_discard_transcribe()
--     as in 20261202000000, now also for the feature meetings.summary: a meeting's removal (the recorder's delete, an owner's compliance delete, the text
--     purge, a shred replay) cancels the live summary runs for it and deletes their result rows, a finished result that was never copied included.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_meetings.meeting_result ADD COLUMN IF NOT EXISTS source_run_id uuid;
ALTER TABLE crove_meetings.action_item ADD COLUMN IF NOT EXISTS source_run_id uuid;

-- No user request changes the mark by a column grant either: the triggers below and draft_review are the only way.
REVOKE UPDATE (tainted) ON crove_meetings.meeting_result, crove_meetings.action_item FROM crove_tenant;

CREATE OR REPLACE FUNCTION crove_meetings.meeting_result_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
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
DROP TRIGGER IF EXISTS meeting_result_taint ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_taint BEFORE UPDATE ON crove_meetings.meeting_result
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.meeting_result_taint();

CREATE OR REPLACE FUNCTION crove_meetings.action_item_taint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tainted IS DISTINCT FROM OLD.tainted AND (NEW.tainted OR current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_meetings.draft_review(uuid,uuid,uuid[])'::pg_catalog.regprocedure)) THEN
    RAISE EXCEPTION 'MEETINGS_TAINT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF OLD.stage = 'draft' AND NEW.stage = 'published' AND NEW.tainted THEN
    RAISE EXCEPTION 'MEETINGS_DRAFT_NOT_REVIEWED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.action_item_taint() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS action_item_taint ON crove_meetings.action_item;
CREATE TRIGGER action_item_taint BEFORE UPDATE ON crove_meetings.action_item
  FOR EACH ROW EXECUTE FUNCTION crove_meetings.action_item_taint();

-- The recorder's explicit review of the draft: only a user context, only the meeting's recorder, only draft rows, and only the rows the caller names. The count is
-- how many rows lost the mark.
CREATE OR REPLACE FUNCTION crove_meetings.draft_review(p_org_id uuid, p_meeting_id uuid, p_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_user uuid := crove_kernel.ctx_user_id();
  v_results integer := 0;
  v_items integer := 0;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR crove_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT crove_meetings.is_meeting_recorder(v_org, p_meeting_id) THEN
    RAISE EXCEPTION 'MEETINGS_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE crove_meetings.meeting_result SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_results = ROW_COUNT;
  UPDATE crove_meetings.action_item SET tainted = false, updated_at = pg_catalog.now()
  WHERE org_id = v_org AND meeting_id = p_meeting_id AND id = ANY (p_ids) AND stage = 'draft' AND tainted;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  RETURN v_results + v_items;
END;
$$;
REVOKE ALL ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_meetings.draft_review(uuid, uuid, uuid[]) TO crove_app;

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
