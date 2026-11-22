-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Projects (issue #2599, docs/plan/projects-v2.md section 5.1, ADR-0056 section 5):
-- Add nullable start_on date column to crove_projects.project_task for project Gantt / Timeline view.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_projects.project_task
  ADD COLUMN IF NOT EXISTS start_on date;

CREATE INDEX IF NOT EXISTS project_task_start_on_idx
  ON crove_projects.project_task (org_id, project_id, start_on)
  WHERE start_on IS NOT NULL;
