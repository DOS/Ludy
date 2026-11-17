-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects P4 (#2595, ADR-0048, notes plan §3.4): widen crove_notes.link for kernel.task and projects.project targets
-- and allow linking a member's own private to-do to a task, project or other record.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_notes.link
  ALTER COLUMN note_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS todo_id uuid,
  ADD COLUMN IF NOT EXISTS task_id uuid;

ALTER TABLE crove_notes.link
  DROP CONSTRAINT IF EXISTS link_todo_fk,
  ADD CONSTRAINT link_todo_fk
    FOREIGN KEY (org_id, todo_id) REFERENCES crove_notes.todo (org_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS link_task_fk,
  ADD CONSTRAINT link_task_fk
    FOREIGN KEY (org_id, task_id) REFERENCES crove_kernel.task (org_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS link_parent_ck,
  ADD CONSTRAINT link_parent_ck CHECK (
    (note_id IS NOT NULL AND todo_id IS NULL) OR
    (note_id IS NULL AND todo_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS link_target_type_check,
  ADD CONSTRAINT link_target_type_check CHECK (
    target_type IN (
      'kernel.party',
      'kernel.file',
      'kernel.task',
      'finance.purchase_document',
      'finance.journal_entry',
      'crm.booking',
      'projects.project'
    )
  ),
  DROP CONSTRAINT IF EXISTS link_target_ck,
  ADD CONSTRAINT link_target_ck CHECK (
    (target_type = 'kernel.party' AND party_id = target_id AND file_id IS NULL AND task_id IS NULL) OR
    (target_type = 'kernel.file' AND file_id = target_id AND party_id IS NULL AND task_id IS NULL) OR
    (target_type = 'kernel.task' AND task_id = target_id AND party_id IS NULL AND file_id IS NULL) OR
    (target_type IN ('finance.purchase_document', 'finance.journal_entry', 'crm.booking', 'projects.project')
      AND party_id IS NULL AND file_id IS NULL AND task_id IS NULL)
  );

-- G3 index for every foreign key led by org_id.
CREATE INDEX IF NOT EXISTS link_todo_idx ON crove_notes.link (org_id, todo_id);
CREATE INDEX IF NOT EXISTS link_task_idx ON crove_notes.link (org_id, task_id);

-- Partial unique indexes so each note or to-do links to a target at most once.
DROP INDEX IF EXISTS crove_notes.link_note_target_uq;
CREATE UNIQUE INDEX IF NOT EXISTS link_note_target_uq
  ON crove_notes.link (org_id, note_id, target_type, target_id)
  WHERE note_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS link_todo_target_uq
  ON crove_notes.link (org_id, todo_id, target_type, target_id)
  WHERE todo_id IS NOT NULL;

-- Links inherit visibility and write authority from their parent note or private to-do.
-- A private to-do's links stay strictly with its owner; nobody else (owners, admins,
-- viewers, agents or system context included) sees any trace of them.
DROP POLICY IF EXISTS link_read ON crove_notes.link;
CREATE POLICY link_read ON crove_notes.link AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (note_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM crove_notes.note n WHERE n.org_id = link.org_id AND n.id = link.note_id
    ))
    OR
    (todo_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM crove_notes.todo t
      WHERE t.org_id = link.org_id AND t.id = link.todo_id AND t.owner_user_id = (SELECT crove_kernel.ctx_user_id())
    ))
  );

DROP POLICY IF EXISTS link_insert ON crove_notes.link;
CREATE POLICY link_insert ON crove_notes.link AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (note_id IS NOT NULL AND todo_id IS NULL AND EXISTS (
      SELECT 1 FROM crove_notes.note n
      WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    ))
    OR
    (todo_id IS NOT NULL AND note_id IS NULL AND EXISTS (
      SELECT 1 FROM crove_notes.todo t
      WHERE t.org_id = link.org_id AND t.id = link.todo_id AND t.owner_user_id = (SELECT crove_kernel.ctx_user_id())
    ))
  );

DROP POLICY IF EXISTS link_delete ON crove_notes.link;
CREATE POLICY link_delete ON crove_notes.link AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (note_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM crove_notes.note n
      WHERE n.org_id = link.org_id AND n.id = link.note_id AND n.author_user_id = (SELECT crove_kernel.ctx_user_id())
    ))
    OR
    (todo_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM crove_notes.todo t
      WHERE t.org_id = link.org_id AND t.id = link.todo_id AND t.owner_user_id = (SELECT crove_kernel.ctx_user_id())
    ))
  );
