-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Projects (issue #2610, docs/plan/projects.md section 7): manual card ordering in a project board column via
-- fractional sort_key on crove_projects.project_task (nullable for zero-setup backwards compatibility; lazily
-- initialized from default due/created order on first reorder). Never alters crove_kernel.task.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_projects.project_task
  ADD COLUMN IF NOT EXISTS sort_key text COLLATE "C";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_projects'
      AND c.relname = 'project_task'
      AND con.conname = 'project_task_sort_key_ck'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_sort_key_ck
      CHECK (sort_key IS NULL OR sort_key ~ '^[0-9A-Za-z]{1,200}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_task_project_sort_idx
  ON crove_projects.project_task (org_id, project_id, sort_key, task_id);
