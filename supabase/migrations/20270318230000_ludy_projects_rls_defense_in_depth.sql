-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects review-followup (#4631, #4449, ADR-0056, ADR-0057):
-- 1) Tighten ludy_notes.link link_private_project_scope WITH CHECK (leaving USING unchanged) so
--    direct SQL INSERTs for target_type = 'kernel.task' require a caller-visible ludy_kernel.task row
--    alongside ludy_projects.task_visible(org_id, target_id, NULL::uuid).
-- 2) Make ludy_projects.roadmap_item_privacy_guard() fail closed when v_project_id IS NULL or
--    v_visibility IS DISTINCT FROM 'org'.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Tighten ludy_notes.link link_private_project_scope WITH CHECK alone
-- ---------------------------------------------------------------------------
-- Keep USING unchanged so existing links to non-private tasks outside a user's legal-entity
-- scope stay readable (available: false) and removable via notes.link.remove.
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4449, #4631): tighten link_private_project_scope WITH CHECK to require visible ludy_kernel.task alongside task_visible()
DROP POLICY IF EXISTS link_private_project_scope ON ludy_notes.link;
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4449, #4631): tighten link_private_project_scope WITH CHECK to require visible ludy_kernel.task alongside task_visible()
CREATE POLICY link_private_project_scope ON ludy_notes.link AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR target_type NOT IN ('projects.project', 'kernel.task')
    OR (SELECT ludy_projects.actor_bypasses_private_projects())
    OR (target_type = 'projects.project' AND ludy_projects.project_visible(org_id, target_id))
    OR (target_type = 'kernel.task' AND ludy_projects.task_visible(org_id, target_id, NULL::uuid))
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'system'
    OR target_type NOT IN ('projects.project', 'kernel.task')
    OR (target_type = 'projects.project' AND ludy_projects.project_visible(org_id, target_id))
    OR (
      target_type = 'kernel.task'
      AND EXISTS (
        SELECT 1
        FROM ludy_kernel.task t
        WHERE t.org_id = link.org_id
          AND t.id = link.target_id
      )
      AND ludy_projects.task_visible(org_id, target_id, NULL::uuid)
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Fail-closed visibility check in ludy_projects.roadmap_item_privacy_guard()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_projects.roadmap_item_privacy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_project_id uuid;
  v_visibility text;
BEGIN
  IF NEW.linked_task_id IS NOT NULL THEN
    -- Lock project_task before project in two separate statements so PostgreSQL
    -- READ COMMITTED EvalPlanQual re-fetches updated project_id instead of
    -- dropping a joined row (#4449).
    SELECT pt.project_id
    INTO v_project_id
    FROM ludy_projects.project_task pt
    WHERE pt.org_id = NEW.org_id
      AND pt.task_id = NEW.linked_task_id
    FOR SHARE;

    IF v_project_id IS NOT NULL THEN
      SELECT p.visibility
      INTO v_visibility
      FROM ludy_projects.project p
      WHERE p.org_id = NEW.org_id
        AND p.id = v_project_id
      FOR SHARE;
    END IF;

    IF v_project_id IS NULL OR v_visibility IS DISTINCT FROM 'org' THEN
      RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.roadmap_item_privacy_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
