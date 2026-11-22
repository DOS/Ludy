-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects v2 (#4361, docs/plan/projects-v2.md section 4.1, ADR-0056 section 4):
-- opt-in Sprints / Cycles and Story Points on crove_projects.project, crove_projects.project_cycle,
-- and crove_projects.project_task. Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Opt-in project toggles and default cycle length (1 to 4 weeks; default 2, disabled by default).
ALTER TABLE crove_projects.project
  ADD COLUMN IF NOT EXISTS cycles_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cycle_duration_weeks smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS points_enabled boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crove_projects'
       AND c.relname = 'project'
       AND con.conname = 'project_cycle_duration_weeks_ck'
  ) THEN
    ALTER TABLE crove_projects.project
      ADD CONSTRAINT project_cycle_duration_weeks_ck
      CHECK (cycle_duration_weeks BETWEEN 1 AND 4);
  END IF;
END $$;

-- 2. Cycles belonging to one project; at most one active cycle per (org_id, project_id).
CREATE TABLE IF NOT EXISTS crove_projects.project_cycle (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 120 AND name = pg_catalog.btrim(name)),
  goal text CHECK (goal IS NULL OR pg_catalog.length(goal) <= 1000),
  status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed')),
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on >= starts_on),
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_cycle_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_project_id_uq UNIQUE (org_id, project_id, id),
  CONSTRAINT project_cycle_number_uq UNIQUE (org_id, project_id, number)
);

CREATE INDEX IF NOT EXISTS project_cycle_project_idx
  ON crove_projects.project_cycle (org_id, project_id, status, number);

CREATE UNIQUE INDEX IF NOT EXISTS project_cycle_active_uq
  ON crove_projects.project_cycle (org_id, project_id)
  WHERE status = 'active';

SELECT crove_kernel.apply_tenant_rls('crove_projects.project_cycle');

-- 3. Task membership in a cycle (cleared to backlog if upcoming cycle is deleted) and optional story points.
ALTER TABLE crove_projects.project_task
  ADD COLUMN IF NOT EXISTS cycle_id uuid,
  ADD COLUMN IF NOT EXISTS story_points smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crove_projects'
       AND c.relname = 'project_task'
       AND con.conname = 'project_task_story_points_ck'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_story_points_ck
      CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crove_projects'
       AND c.relname = 'project_task'
       AND con.conname = 'project_task_cycle_fk'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_cycle_fk
      FOREIGN KEY (org_id, project_id, cycle_id)
      REFERENCES crove_projects.project_cycle (org_id, project_id, id)
      ON DELETE SET NULL (cycle_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_task_cycle_idx
  ON crove_projects.project_task (org_id, project_id, cycle_id)
  WHERE cycle_id IS NOT NULL;
