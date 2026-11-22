-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Projects (issue #2601, docs/plan/projects-v2.md section 4.3, ADR-0056 section 3):
-- Task dependencies (blocks / blocked_by cycle-free DAG) isolated from crove_kernel.task.parent_task_id.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'crove_projects'
       AND t.relname = 'project_task'
       AND c.conname = 'project_task_project_task_uq'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_project_task_uq UNIQUE (org_id, project_id, task_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crove_projects.task_dependency (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  blocker_task_id uuid NOT NULL,
  blocked_task_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT task_dependency_no_self CHECK (blocker_task_id <> blocked_task_id),
  CONSTRAINT task_dependency_edge_uq UNIQUE (org_id, blocker_task_id, blocked_task_id),
  CONSTRAINT task_dependency_project_fk
    FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id)
    ON DELETE CASCADE,
  CONSTRAINT task_dependency_blocker_fk
    FOREIGN KEY (org_id, project_id, blocker_task_id)
    REFERENCES crove_projects.project_task (org_id, project_id, task_id)
    ON DELETE CASCADE,
  CONSTRAINT task_dependency_blocked_fk
    FOREIGN KEY (org_id, project_id, blocked_task_id)
    REFERENCES crove_projects.project_task (org_id, project_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS task_dependency_project_idx
  ON crove_projects.task_dependency (org_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS task_dependency_blocker_idx
  ON crove_projects.task_dependency (org_id, project_id, blocker_task_id);
CREATE INDEX IF NOT EXISTS task_dependency_blocked_idx
  ON crove_projects.task_dependency (org_id, project_id, blocked_task_id);

SELECT crove_kernel.apply_tenant_rls('crove_projects.task_dependency');

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('crove_projects.project_visible(uuid, uuid)') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS project_visibility ON crove_projects.task_dependency';
    EXECUTE
      'CREATE POLICY project_visibility ON crove_projects.task_dependency AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (crove_projects.project_visible(org_id, project_id)) '
      'WITH CHECK (crove_projects.project_visible(org_id, project_id))';
  END IF;
END $$;
