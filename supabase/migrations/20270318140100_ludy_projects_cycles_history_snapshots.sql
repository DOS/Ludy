-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #4431: historical cycle task membership and close-time per-task snapshots in ludy_projects.
-- Both tables apply tenant RLS + RESTRICTIVE project_visibility and always read joined with ludy_kernel.task
-- so restricted legal-entity callers never learn hidden-entity counts or points. Idempotent.
SET LOCAL lock_timeout = '2s';

-- 1. Historical cycle membership intervals per task (for carryover & reassignment burndown fidelity).
CREATE TABLE IF NOT EXISTS ludy_projects.project_cycle_task_history (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  task_id uuid NOT NULL,
  story_points integer,
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  left_at timestamptz,
  left_reason text,
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_cycle_task_history_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_task_history_cycle_fk FOREIGN KEY (org_id, project_id, cycle_id)
    REFERENCES ludy_projects.project_cycle (org_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_task_history_task_fk FOREIGN KEY (org_id, task_id)
    REFERENCES ludy_kernel.task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_task_history_points_ck CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100),
  CONSTRAINT project_cycle_task_history_dates_ck CHECK (left_at IS NULL OR left_at >= joined_at),
  CONSTRAINT project_cycle_task_history_left_reason_ck
    CHECK (left_reason IS NULL OR left_reason IN ('reassigned', 'removed_from_project', 'carryover')),
  CONSTRAINT project_cycle_task_history_left_pair_ck CHECK ((left_at IS NULL) = (left_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS project_cycle_task_history_cycle_idx
  ON ludy_projects.project_cycle_task_history (org_id, project_id, cycle_id, joined_at);

CREATE INDEX IF NOT EXISTS project_cycle_task_history_task_idx
  ON ludy_projects.project_cycle_task_history (org_id, task_id, cycle_id);

CREATE UNIQUE INDEX IF NOT EXISTS project_cycle_task_history_active_uq
  ON ludy_projects.project_cycle_task_history (org_id, project_id, task_id)
  WHERE left_at IS NULL;

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.project_cycle_task_history');
REVOKE ALL ON ludy_projects.project_cycle_task_history FROM ludy_app, ludy_worker, ludy_definer_tenant;
DROP POLICY IF EXISTS project_visibility ON ludy_projects.project_cycle_task_history;
CREATE POLICY project_visibility ON ludy_projects.project_cycle_task_history
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

-- 2. Immutable close-time per-task snapshots captured on projects.cycle.complete.
CREATE TABLE IF NOT EXISTS ludy_projects.project_cycle_snapshot (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  project_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_status text NOT NULL,
  story_points integer,
  task_created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  task_done_at timestamptz,
  carried_over boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT project_cycle_snapshot_cycle_task_uq UNIQUE (org_id, cycle_id, task_id),
  CONSTRAINT project_cycle_snapshot_project_fk FOREIGN KEY (org_id, project_id)
    REFERENCES ludy_projects.project (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_snapshot_cycle_fk FOREIGN KEY (org_id, project_id, cycle_id)
    REFERENCES ludy_projects.project_cycle (org_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_snapshot_task_fk FOREIGN KEY (org_id, task_id)
    REFERENCES ludy_kernel.task (org_id, id) ON DELETE CASCADE,
  CONSTRAINT project_cycle_snapshot_status_ck
    CHECK (task_status IN ('todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled')),
  CONSTRAINT project_cycle_snapshot_points_ck CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS project_cycle_snapshot_cycle_idx
  ON ludy_projects.project_cycle_snapshot (org_id, project_id, cycle_id);

CREATE INDEX IF NOT EXISTS project_cycle_snapshot_task_idx
  ON ludy_projects.project_cycle_snapshot (org_id, task_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_projects.project_cycle_snapshot');
REVOKE ALL ON ludy_projects.project_cycle_snapshot FROM ludy_app, ludy_worker, ludy_definer_tenant;
DROP POLICY IF EXISTS project_visibility ON ludy_projects.project_cycle_snapshot;
CREATE POLICY project_visibility ON ludy_projects.project_cycle_snapshot
  AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_projects.actor_bypasses_private_projects())
    OR ludy_projects.project_visible(org_id, project_id)
  )
  WITH CHECK (ludy_projects.project_visible(org_id, project_id));

-- 3. Trigger maintaining project_cycle_task_history on all project_task cycle/point/membership writes.
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
         AND left_at IS NULL;
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
  ELSIF NEW.cycle_id IS NOT NULL AND OLD.story_points IS DISTINCT FROM NEW.story_points THEN
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

DROP TRIGGER IF EXISTS project_task_sync_cycle_history_tr ON ludy_projects.project_task;
CREATE TRIGGER project_task_sync_cycle_history_tr
  AFTER INSERT OR UPDATE OR DELETE ON ludy_projects.project_task
  FOR EACH ROW EXECUTE FUNCTION ludy_projects.sync_project_cycle_task_history();

-- 4. Idempotent backfills for existing cycles and tasks.
INSERT INTO ludy_projects.project_cycle_task_history (
  org_id,
  project_id,
  cycle_id,
  task_id,
  story_points,
  joined_at
)
SELECT
  pt.org_id,
  pt.project_id,
  pt.cycle_id,
  pt.task_id,
  pt.story_points,
  COALESCE(t.created_at, pt.created_at)
FROM ludy_projects.project_task pt
JOIN ludy_kernel.task t
  ON t.org_id = pt.org_id
 AND t.id = pt.task_id
WHERE pt.cycle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM ludy_projects.project_cycle_task_history h
     WHERE h.org_id = pt.org_id
       AND h.project_id = pt.project_id
       AND h.cycle_id = pt.cycle_id
       AND h.task_id = pt.task_id
  )
  AND NOT EXISTS (
    SELECT 1
      FROM ludy_projects.project_cycle_task_history h2
     WHERE h2.org_id = pt.org_id
       AND h2.project_id = pt.project_id
       AND h2.task_id = pt.task_id
       AND h2.left_at IS NULL
  );

INSERT INTO ludy_projects.project_cycle_snapshot (
  org_id,
  project_id,
  cycle_id,
  task_id,
  task_status,
  story_points,
  task_created_at,
  task_done_at,
  carried_over,
  captured_at
)
SELECT
  pt.org_id,
  pt.project_id,
  pc.id,
  pt.task_id,
  t.status,
  pt.story_points,
  t.created_at,
  t.done_at,
  false,
  COALESCE(pc.completed_at, pc.updated_at, pg_catalog.now())
FROM ludy_projects.project_cycle pc
JOIN ludy_projects.project_task pt
  ON pt.org_id = pc.org_id
 AND pt.project_id = pc.project_id
 AND pt.cycle_id = pc.id
JOIN ludy_kernel.task t
  ON t.org_id = pt.org_id
 AND t.id = pt.task_id
WHERE pc.status = 'completed'
ON CONFLICT (org_id, cycle_id, task_id) DO NOTHING;
