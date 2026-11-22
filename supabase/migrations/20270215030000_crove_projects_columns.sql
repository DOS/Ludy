-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects v2 (#2605, docs/plan/projects-v2.md section 4.2, ADR-0056): opt-in custom board columns per project
-- mapped to canonical crove_kernel.task.status, plus nullable crove_projects.project_task.column_id.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_projects.project_column (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 80 AND name = pg_catalog.btrim(name)),
  task_status text NOT NULL CHECK (task_status IN ('todo', 'in_progress', 'waiting', 'in_review', 'done')),
  color text NOT NULL DEFAULT 'neutral' CHECK (color IN ('neutral', 'primary', 'warning', 'proposal', 'success', 'destructive')),
  wip_limit smallint CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 200),
  sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~ '^[0-9A-Za-z]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_column_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_column_project_id_uq UNIQUE (org_id, project_id, id)
);

CREATE INDEX IF NOT EXISTS project_column_project_idx
  ON crove_projects.project_column (org_id, project_id, sort_key, id);

SELECT crove_kernel.apply_tenant_rls('crove_projects.project_column');

ALTER TABLE crove_projects.project_task
  ADD COLUMN IF NOT EXISTS column_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_projects'
      AND c.relname = 'project_task'
      AND con.conname = 'project_task_column_fk'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_column_fk
      FOREIGN KEY (org_id, project_id, column_id)
      REFERENCES crove_projects.project_column (org_id, project_id, id)
      ON DELETE SET NULL (column_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_task_column_idx
  ON crove_projects.project_task (org_id, project_id, column_id)
  WHERE column_id IS NOT NULL;
