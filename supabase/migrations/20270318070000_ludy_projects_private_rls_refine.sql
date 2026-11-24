-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects review-followup (#4449, PR #4416 follow-up, ADR-0056, ADR-0057):
-- 1) Remove the org-wide NOT EXISTS (... visibility = 'private') existence oracle from
--    ludy_projects.actor_bypasses_private_projects() so ordinary members cannot infer whether
--    any private project exists in the org.
-- 2) Scope ludy_notes.link link_private_project_scope kernel.task branch strictly to tasks
--    attached to private projects via ludy_projects.task_visible(org_id, target_id, NULL::uuid),
--    leaving non-private kernel.task note links governed by existing note/entity rules even when
--    a private project exists in a multi-LE org.
-- 3) Guard public roadmap item task links (roadmap_item.linked_task_id) against org -> private
--    project transitions and private project attachment in PostgreSQL triggers with matching
--    ludy_projects.project lock ordering (FOR SHARE OF p).
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Remove org-wide private-project existence oracle from actor_bypasses_private_projects()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_projects.actor_bypasses_private_projects() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(
    ctx.org_id IS NOT NULL
    AND ctx.actor IS NOT NULL
    AND (
      ctx.actor = 'system'
      OR (
        ctx.actor = 'user'
        AND ctx.uid IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM ludy_kernel.tenant_member tm
          WHERE tm.org_id = ctx.org_id
            AND tm.user_id = ctx.uid
            AND tm.role IN ('owner', 'admin')
        )
      )
    ),
    false
  )
  FROM (
    SELECT ludy_kernel.ctx_org_id() AS org_id,
           ludy_kernel.ctx_actor_type() AS actor,
           ludy_kernel.ctx_user_id() AS uid
  ) ctx
$$;
REVOKE ALL ON FUNCTION ludy_projects.actor_bypasses_private_projects()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_projects.actor_bypasses_private_projects() TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 2. Scope ludy_notes.link kernel.task check strictly to private-project tasks
-- ---------------------------------------------------------------------------
-- Passing NULL for p_assignee_position_id denies org-chart agent seat bypass on note links while
-- allowing unlinked and org-project tasks regardless of caller legal-entity scope (which remains
-- enforced by note_read, notes.link.add/canOpen, and ludy_kernel.task le_scope).
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4449): scope ludy_notes.link kernel.task branch strictly to tasks in private projects
DROP POLICY IF EXISTS link_private_project_scope ON ludy_notes.link;
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4449): scope ludy_notes.link kernel.task branch strictly to tasks in private projects
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
    OR (target_type = 'kernel.task' AND ludy_projects.task_visible(org_id, target_id, NULL::uuid))
  );

-- ---------------------------------------------------------------------------
-- 3. Guard public roadmap_item.linked_task_id against private projects
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_projects.project_roadmap_privacy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.visibility = 'private'
     AND (
       EXISTS (
         SELECT 1
         FROM ludy_projects.roadmap_board rb
         WHERE rb.org_id = NEW.org_id
           AND rb.project_id = NEW.id
       )
       OR EXISTS (
         SELECT 1
         FROM ludy_projects.project_task pt
         JOIN ludy_projects.roadmap_item ri
           ON ri.org_id = pt.org_id
          AND ri.linked_task_id = pt.task_id
         WHERE pt.org_id = NEW.org_id
           AND pt.project_id = NEW.id
       )
     ) THEN
    RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.project_roadmap_privacy_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS project_roadmap_privacy_guard_tr ON ludy_projects.project;
CREATE TRIGGER project_roadmap_privacy_guard_tr
  AFTER UPDATE OF org_id, visibility ON ludy_projects.project
  FOR EACH ROW
  WHEN (NEW.visibility = 'private')
  EXECUTE FUNCTION ludy_projects.project_roadmap_privacy_guard();

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

      IF v_visibility = 'private' THEN
        RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.roadmap_item_privacy_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS roadmap_item_privacy_guard_tr ON ludy_projects.roadmap_item;
CREATE TRIGGER roadmap_item_privacy_guard_tr
  AFTER INSERT OR UPDATE OF org_id, linked_task_id ON ludy_projects.roadmap_item
  FOR EACH ROW
  WHEN (NEW.linked_task_id IS NOT NULL)
  EXECUTE FUNCTION ludy_projects.roadmap_item_privacy_guard();

CREATE OR REPLACE FUNCTION ludy_projects.project_task_roadmap_privacy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_visibility text;
BEGIN
  -- Lock project FOR SHARE before checking roadmap_item so concurrent
  -- org -> private transitions and roadmap_item inserts serialize without
  -- reversing the roadmap_item -> project_task -> project lock order (#4449).
  SELECT p.visibility
  INTO v_visibility
  FROM ludy_projects.project p
  WHERE p.org_id = NEW.org_id
    AND p.id = NEW.project_id
  FOR SHARE;

  IF v_visibility = 'private'
     AND EXISTS (
       SELECT 1
       FROM ludy_projects.roadmap_item ri
       WHERE ri.org_id = NEW.org_id
         AND ri.linked_task_id = NEW.task_id
     ) THEN
    RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.project_task_roadmap_privacy_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS project_task_roadmap_privacy_guard_tr ON ludy_projects.project_task;
CREATE TRIGGER project_task_roadmap_privacy_guard_tr
  AFTER INSERT OR UPDATE OF org_id, project_id, task_id ON ludy_projects.project_task
  FOR EACH ROW
  EXECUTE FUNCTION ludy_projects.project_task_roadmap_privacy_guard();
