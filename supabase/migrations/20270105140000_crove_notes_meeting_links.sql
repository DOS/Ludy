-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Notes (issue #1679, plan docs/plan/notes.md step N10): widen crove_notes.link for meetings.meeting
-- and guard crove_notes.note.tainted so only the author can clear it, and only when editing title or body.
-- Idempotent; applied files stay untouched. Zero cross-module foreign keys.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_notes.link
  DROP CONSTRAINT IF EXISTS link_target_type_check,
  ADD CONSTRAINT link_target_type_check CHECK (
    target_type IN (
      'kernel.party',
      'kernel.file',
      'kernel.task',
      'finance.purchase_document',
      'finance.journal_entry',
      'crm.booking',
      'projects.project',
      'meetings.meeting'
    )
  ),
  DROP CONSTRAINT IF EXISTS link_target_ck,
  ADD CONSTRAINT link_target_ck CHECK (
    (target_type = 'kernel.party' AND party_id = target_id AND file_id IS NULL AND task_id IS NULL) OR
    (target_type = 'kernel.file' AND file_id = target_id AND party_id IS NULL AND task_id IS NULL) OR
    (target_type = 'kernel.task' AND task_id = target_id AND party_id IS NULL AND file_id IS NULL) OR
    (target_type IN ('finance.purchase_document', 'finance.journal_entry', 'crm.booking', 'projects.project', 'meetings.meeting')
      AND party_id IS NULL AND file_id IS NULL AND task_id IS NULL)
  );

-- Allow crove_tenant to update tainted under the author-only, content-edit-required guard below.
GRANT UPDATE (tainted) ON crove_notes.note TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_notes.note_taint_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tainted IS DISTINCT FROM OLD.tainted AND OLD.author_user_id IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
    RAISE EXCEPTION 'NOTES_TAINT_AUTHOR_ONLY' USING ERRCODE = '42501';
  END IF;
  IF OLD.tainted AND NOT NEW.tainted AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.body IS NOT DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'NOTES_TAINT_EDIT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_notes.note_taint_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS b_taint ON crove_notes.note;
CREATE TRIGGER b_taint BEFORE UPDATE OF tainted ON crove_notes.note
  FOR EACH ROW EXECUTE FUNCTION crove_notes.note_taint_guard();
