-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove Projects (issue #2591, plan docs/plan/projects.md sections 4.1 and 6, ADR-0048): projects that group kernel
-- tasks, project members for filters and seat picking, and one-project-per-task membership pointing to
-- crove_kernel.task. Idempotent; applied files stay untouched.
--
-- crove_projects.project         a project: name, optional description, owner (a member; NULL falls back to the org's
--                                owners after the member is removed) and status (active, on_hold, done, archived).
-- crove_projects.project_member  members on a project; membership is for filters, seat picking and nudges, never access
--                                (every member and viewer of the org reads every project, decision D-2). Cascades when
--                                the project or the org membership is deleted.
-- crove_projects.project_task    which project a task belongs to, at most one per task, with a foreign key to
--                                crove_kernel.task so kernel.task gains no column.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_projects;
GRANT USAGE ON SCHEMA crove_projects TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_projects.project (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 200 AND name = pg_catalog.btrim(name)),
  description text CHECK (description IS NULL OR pg_catalog.length(description) <= 2000),
  -- NULL: falls back to the org's owners when the member who owned the project is removed.
  owner_user_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'done', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_owner_fk FOREIGN KEY (org_id, owner_user_id)
    REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (owner_user_id)
);
CREATE INDEX IF NOT EXISTS project_owner_idx ON crove_projects.project (org_id, owner_user_id);
CREATE INDEX IF NOT EXISTS project_status_idx ON crove_projects.project (org_id, status, updated_at DESC);
SELECT crove_kernel.apply_tenant_rls('crove_projects.project');

CREATE TABLE IF NOT EXISTS crove_projects.project_member (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_member_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_member_member_fk FOREIGN KEY (org_id, user_id)
    REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT project_member_uq UNIQUE (org_id, project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_member_user_idx ON crove_projects.project_member (org_id, user_id);
SELECT crove_kernel.apply_tenant_rls('crove_projects.project_member');

CREATE TABLE IF NOT EXISTS crove_projects.project_task (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_task_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_task_task_fk FOREIGN KEY (org_id, task_id)
    REFERENCES crove_kernel.task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_task_task_uq UNIQUE (org_id, task_id)
);
CREATE INDEX IF NOT EXISTS project_task_project_idx ON crove_projects.project_task (org_id, project_id, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_projects.project_task');
