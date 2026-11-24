-- SPDX-License-Identifier: AGPL-3.0-only
-- Projects review follow-ups (#4689, #4678, #4431, #4449, #2604):
-- 1) Make companion project/roadmap/acceptance privacy guards fail closed on
--    visibility IS DISTINCT FROM 'org' (project_roadmap_privacy_guard + trigger WHEN,
--    project_task_roadmap_privacy_guard, roadmap_board_guard, project_no_private_with_acceptance,
--    and ludy_sign.check_project_acceptance_source).
-- 2) Update ludy_projects.sync_project_cycle_task_history() (carrying forward #4678's DELETE
--    guard) so left_reason = 'carryover' is recorded only when project_cycle_snapshot has
--    carried_over = true, and post-close cycle removals via set_cycle record 'reassigned'.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Fail-closed visibility checks on companion privacy guards (#4689)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ludy_projects.project_roadmap_privacy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'org'
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
  WHEN (NEW.visibility IS DISTINCT FROM 'org')
  EXECUTE FUNCTION ludy_projects.project_roadmap_privacy_guard();

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
  -- org -> non-org transitions and roadmap_item inserts serialize without
  -- reversing the roadmap_item -> project_task -> project lock order (#4449).
  SELECT p.visibility
  INTO v_visibility
  FROM ludy_projects.project p
  WHERE p.org_id = NEW.org_id
    AND p.id = NEW.project_id
  FOR SHARE;

  IF (NOT FOUND OR v_visibility IS DISTINCT FROM 'org')
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

CREATE OR REPLACE FUNCTION ludy_projects.roadmap_board_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_origin text;
  v_port_text text;
  v_port integer;
  v_proj record;
BEGIN
  IF NEW.embed_allowed_origins IS NULL THEN
    RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGINS' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(pg_catalog.array_length(NEW.embed_allowed_origins, 1), 0) > 20 THEN
    RAISE EXCEPTION 'ROADMAP_TOO_MANY_EMBED_ORIGINS' USING ERRCODE = '23514';
  END IF;
  FOREACH v_origin IN ARRAY NEW.embed_allowed_origins LOOP
    IF v_origin IS NULL
       OR v_origin !~ '^https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$' THEN
      RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGIN' USING ERRCODE = '23514';
    END IF;
    v_port_text := (pg_catalog.regexp_match(v_origin, ':([0-9]{1,5})$'))[1];
    IF v_port_text IS NOT NULL THEN
      v_port := v_port_text::integer;
      IF v_port < 1 OR v_port > 65535 THEN
        RAISE EXCEPTION 'ROADMAP_INVALID_EMBED_ORIGIN' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  IF NEW.project_id IS NOT NULL THEN
    SELECT p.id, p.is_template, p.visibility
    INTO v_proj
    FROM ludy_projects.project p
    WHERE p.org_id = NEW.org_id
      AND p.id = NEW.project_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ROADMAP_PROJECT_NOT_FOUND' USING ERRCODE = '23503';
    END IF;
    IF v_proj.is_template THEN
      RAISE EXCEPTION 'ROADMAP_TEMPLATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    IF v_proj.visibility IS DISTINCT FROM 'org' THEN
      RAISE EXCEPTION 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.roadmap_board_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_projects.project_no_private_with_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'org' THEN
    IF EXISTS (
      SELECT 1 FROM ludy_sign.envelope e
      WHERE e.org_id = NEW.org_id
        AND e.source_kind = 'project_acceptance'
        AND e.source_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'PROJECT_PRIVATE_ACCEPTANCE_EXISTS' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_projects.project_no_private_with_acceptance()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4689): fail closed when project visibility is distinct from org
CREATE OR REPLACE FUNCTION ludy_sign.check_project_acceptance_source(p_org_id uuid, p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_visibility text;
  v_owner uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_project_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT p.visibility, p.owner_user_id INTO v_visibility, v_owner
  FROM ludy_projects.project p
  WHERE p.org_id = v_org
    AND p.id = p_project_id
    AND p.is_template = false
  FOR SHARE;
  IF NOT FOUND OR NOT ludy_projects.project_row_visible(v_org, p_project_id, v_visibility, v_owner) THEN
    RETURN 0;
  END IF;
  IF v_visibility IS DISTINCT FROM 'org' THEN
    RETURN 1;
  END IF;
  RETURN 2;
END $$;
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4689): revoke default execute on ludy_sign helper
REVOKE ALL ON FUNCTION ludy_sign.check_project_acceptance_source(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
-- migration-lint: cross-module ADR-0056 section 1 (#2604, #4689): allow ludy_tenant to check project acceptance source visibility
GRANT EXECUTE ON FUNCTION ludy_sign.check_project_acceptance_source(uuid, uuid) TO ludy_tenant;

-- ---------------------------------------------------------------------------
-- 2. Cycle history carryover vs post-close reassignment (#4689, #4678)
-- ---------------------------------------------------------------------------

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
          FROM ludy_projects.project_cycle_snapshot s
         WHERE s.org_id = OLD.org_id
           AND s.project_id = OLD.project_id
           AND s.cycle_id = OLD.cycle_id
           AND s.task_id = OLD.task_id
           AND s.carried_over = true
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
