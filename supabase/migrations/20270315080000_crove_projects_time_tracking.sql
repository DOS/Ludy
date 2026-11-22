-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects v2 Wave 2 (#2600, docs/plan/projects-v2.md section 5.2): lean time tracking and billable hours.
-- Creates crove_projects.time_entry with single-active-timer partial unique index, member departure retention
-- (ON DELETE SET NULL), task detachment retention (ON DELETE SET NULL), template-project guard triggers,
-- apply_tenant_rls, and RESTRICTIVE project_visibility policy (#2604 parity).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_projects.time_entry (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  task_id uuid,
  user_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_minutes integer,
  billable boolean NOT NULL DEFAULT false,
  hourly_rate NUMERIC(18, 2),
  note text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT time_entry_ended_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT time_entry_duration_range CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 14400),
  CONSTRAINT time_entry_running_match CHECK ((ended_at IS NULL) = (duration_minutes IS NULL)),
  CONSTRAINT time_entry_hourly_rate_nonneg CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  CONSTRAINT time_entry_note_len CHECK (note IS NULL OR pg_catalog.length(note) <= 500),
  CONSTRAINT time_entry_project_fk
    FOREIGN KEY (org_id, project_id)
    REFERENCES crove_projects.project (org_id, id)
    ON DELETE CASCADE,
  CONSTRAINT time_entry_task_fk
    FOREIGN KEY (org_id, project_id, task_id)
    REFERENCES crove_projects.project_task (org_id, project_id, task_id)
    ON DELETE SET NULL (task_id),
  CONSTRAINT time_entry_user_fk
    FOREIGN KEY (org_id, user_id)
    REFERENCES crove_kernel.tenant_member (org_id, user_id)
    ON DELETE SET NULL (user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS time_entry_running_uq
  ON crove_projects.time_entry (org_id, user_id)
  WHERE ended_at IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS time_entry_project_idx
  ON crove_projects.time_entry (org_id, project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS time_entry_task_idx
  ON crove_projects.time_entry (org_id, project_id, task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS time_entry_user_idx
  ON crove_projects.time_entry (org_id, user_id, started_at DESC)
  WHERE user_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_projects.time_entry');

-- Prevent attaching time entries to template projects or flipping a project with time entries into a template.
CREATE OR REPLACE FUNCTION crove_projects.time_entry_not_on_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_is_template boolean;
BEGIN
  SELECT p.is_template INTO v_is_template
    FROM crove_projects.project p
   WHERE p.org_id = NEW.org_id
     AND p.id = NEW.project_id
     FOR SHARE;
  IF COALESCE(v_is_template, false) THEN
    RAISE EXCEPTION 'PROJECT_TEMPLATE_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.time_entry_not_on_template()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS time_entry_not_on_template ON crove_projects.time_entry;
CREATE TRIGGER time_entry_not_on_template
  BEFORE INSERT OR UPDATE OF org_id, project_id ON crove_projects.time_entry
  FOR EACH ROW EXECUTE FUNCTION crove_projects.time_entry_not_on_template();

CREATE OR REPLACE FUNCTION crove_projects.project_template_no_time_entries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.is_template THEN
    PERFORM 1
      FROM crove_projects.time_entry te
     WHERE te.org_id = NEW.org_id
       AND te.project_id = NEW.id;
    IF FOUND THEN
      RAISE EXCEPTION 'PROJECT_TEMPLATE_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.project_template_no_time_entries()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS project_template_no_time_entries ON crove_projects.project;
CREATE TRIGGER project_template_no_time_entries
  BEFORE INSERT OR UPDATE OF is_template ON crove_projects.project
  FOR EACH ROW EXECUTE FUNCTION crove_projects.project_template_no_time_entries();

DROP POLICY IF EXISTS project_visibility ON crove_projects.time_entry;
CREATE POLICY project_visibility ON crove_projects.time_entry
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    (SELECT crove_projects.actor_bypasses_private_projects())
    OR crove_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (crove_projects.project_visible(org_id, project_id));
