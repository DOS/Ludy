-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #4678: guard the DELETE branch of ludy_projects.sync_project_cycle_task_history()
-- so cascading project_task deletion during direct DELETE FROM ludy_projects.project under
-- ludy_tenant skips updating project_cycle_task_history once the parent project row is gone
-- (preventing project_visibility WITH CHECK violations while ON DELETE CASCADE removes history).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_projects.sync_project_cycle_task_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cycle_id IS NOT NULL THEN
      INSERT INTO ludy_projects.project_cycle_task_history (
        org_id, project_id, cycle_id, task_id, story_points, joined_at
      ) VALUES (
        NEW.org_id, NEW.project_id, NEW.cycle_id, NEW.task_id, NEW.story_points, pg_catalog.now()
      );
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.cycle_id IS NOT NULL THEN
      UPDATE ludy_projects.project_cycle_task_history
         SET left_at = pg_catalog.now(),
             left_reason = 'removed_from_project'
       WHERE org_id = OLD.org_id
         AND project_id = OLD.project_id
         AND task_id = OLD.task_id
         AND cycle_id = OLD.cycle_id
         AND left_at IS NULL
         AND EXISTS (
           SELECT 1
             FROM ludy_projects.project p
            WHERE p.org_id = OLD.org_id
              AND p.id = OLD.project_id
         );
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.cycle_id IS DISTINCT FROM NEW.cycle_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id THEN
    IF OLD.cycle_id IS NOT NULL THEN
      IF OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.task_id IS DISTINCT FROM NEW.task_id THEN
        v_reason := 'removed_from_project';
      ELSIF EXISTS (
        SELECT 1
          FROM ludy_projects.project_cycle pc
         WHERE pc.org_id = OLD.org_id
           AND pc.project_id = OLD.project_id
           AND pc.id = OLD.cycle_id
           AND pc.status = 'completed'
      ) THEN
        v_reason := 'carryover';
      ELSE
        v_reason := 'reassigned';
      END IF;
      UPDATE ludy_projects.project_cycle_task_history
         SET left_at = pg_catalog.now(),
             left_reason = v_reason
       WHERE org_id = OLD.org_id
         AND project_id = OLD.project_id
         AND task_id = OLD.task_id
         AND cycle_id = OLD.cycle_id
         AND left_at IS NULL;
    END IF;

    IF NEW.cycle_id IS NOT NULL THEN
      INSERT INTO ludy_projects.project_cycle_task_history (
        org_id, project_id, cycle_id, task_id, story_points, joined_at
      ) VALUES (
        NEW.org_id, NEW.project_id, NEW.cycle_id, NEW.task_id, NEW.story_points, pg_catalog.now()
      );
    END IF;
  ELSIF NEW.cycle_id IS NOT NULL
     AND OLD.story_points IS DISTINCT FROM NEW.story_points
     AND NOT EXISTS (
       SELECT 1
         FROM ludy_projects.project_cycle pc
        WHERE pc.org_id = NEW.org_id
          AND pc.project_id = NEW.project_id
          AND pc.id = NEW.cycle_id
          AND pc.status = 'completed'
     ) THEN
    UPDATE ludy_projects.project_cycle_task_history
       SET story_points = NEW.story_points
     WHERE org_id = NEW.org_id
       AND project_id = NEW.project_id
       AND task_id = NEW.task_id
       AND cycle_id = NEW.cycle_id
       AND left_at IS NULL;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_projects.sync_project_cycle_task_history()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
