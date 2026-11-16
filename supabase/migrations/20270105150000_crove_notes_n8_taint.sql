-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes N8 (#1677, ADR-0037, ADR-0049): track accepted Vy runs on notes & to-dos so saved runs stay
-- dismissed and cannot replay. Preserves #1679's crove_notes.note_taint_guard() author-edit clearing trigger.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_notes.note ADD COLUMN IF NOT EXISTS summary_run_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE crove_notes.todo ADD COLUMN IF NOT EXISTS source_run_id uuid;
ALTER TABLE crove_notes.todo ADD COLUMN IF NOT EXISTS source_run_seq integer;

CREATE UNIQUE INDEX IF NOT EXISTS todo_source_run_once_uq
  ON crove_notes.todo (org_id, owner_user_id, source_run_id)
  WHERE source_run_id IS NOT NULL AND source_run_seq = 0;

GRANT UPDATE (summary_run_ids) ON crove_notes.note TO crove_tenant;
