-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy Notes (issue #3453, ADR-0047 point 7, ADR-0049): immediately discard private Vy results and cancel
-- live Vy runs bound to a note when that note is deleted from ludy_notes.note (trash purge, former-member
-- purge, PDPL private erasure, or direct delete). Matches meeting_discard_transcribe lock order: lock/cancel
-- ludy_kernel.ai_run first, then delete ludy_kernel.member_vy_result.
-- Covers both legacy/project subject_type 'note' (projects.tasks_from_note) and 'notes.note'
-- (notes.summary, notes.todo_suggest, projects.tasks_from_source).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_notes.note_discard_vy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1
     FROM ludy_kernel.ai_run r
    WHERE r.org_id = OLD.org_id
      AND r.status = 'running'
      AND r.id IN (
        SELECT v.run_id
          FROM ludy_kernel.member_vy_result v
         WHERE v.org_id = OLD.org_id
           AND v.subject_type IN ('note', 'notes.note')
           AND v.subject_id = OLD.id
      )
    ORDER BY r.id
    FOR UPDATE OF r;
  UPDATE ludy_kernel.ai_run r
     SET status = 'cancelled',
         finished_at = pg_catalog.now(),
         error = 'NOTE_REMOVED'
   WHERE r.org_id = OLD.org_id
     AND r.status = 'running'
     AND r.id IN (
       SELECT v.run_id
         FROM ludy_kernel.member_vy_result v
        WHERE v.org_id = OLD.org_id
          AND v.subject_type IN ('note', 'notes.note')
          AND v.subject_id = OLD.id
     );
  DELETE FROM ludy_kernel.member_vy_result v
   WHERE v.org_id = OLD.org_id
     AND v.subject_type IN ('note', 'notes.note')
     AND v.subject_id = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION ludy_notes.note_discard_vy()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname
      FROM pg_catalog.pg_roles
     WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
       AND rolname <> current_user
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ludy_notes.note_discard_vy() FROM %I', r.rolname);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS note_discard_vy_tr ON ludy_notes.note;
CREATE TRIGGER note_discard_vy_tr BEFORE DELETE ON ludy_notes.note
  FOR EACH ROW EXECUTE FUNCTION ludy_notes.note_discard_vy();
