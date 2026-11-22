-- SPDX-License-Identifier: AGPL-3.0-only
-- crove:contract adr=0056
-- Crove Projects v2 Wave 1 (issue #2604, plan docs/plan/projects-v2.md sections 3 and 4.4, ADR-0056 section 1):
-- private projects (visibility = 'org' | 'private') with recursion-free STABLE SECURITY DEFINER helpers,
-- RESTRICTIVE project_visibility policies on crove_projects.*, RESTRICTIVE private_project_scope on
-- crove_kernel.task, and RESTRICTIVE link_private_project_scope on crove_notes.link.
-- Idempotent; applied files stay untouched.

SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_projects.project
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'org',
  DROP CONSTRAINT IF EXISTS project_visibility_check,
  ADD CONSTRAINT project_visibility_check CHECK (visibility IN ('org', 'private')),
  DROP CONSTRAINT IF EXISTS project_template_org_visibility_check,
  ADD CONSTRAINT project_template_org_visibility_check CHECK (NOT is_template OR visibility = 'org');

CREATE INDEX IF NOT EXISTS project_visibility_idx
  ON crove_projects.project (org_id, visibility, updated_at DESC);

-- Evaluates visibility from row attributes passed as arguments (safe in INSERT WITH CHECK and UPDATE NEW
-- checks without querying crove_projects.project recursively). Left owned by the migration runner so RLS on
-- project_member and tenant_member stays bypassed inside the helper; REVOKE/GRANT limits callers to crove_tenant.
CREATE OR REPLACE FUNCTION crove_projects.project_row_visible(
  p_org_id uuid,
  p_id uuid,
  p_visibility text,
  p_owner_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_uid uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF p_visibility = 'org' OR v_actor = 'system' THEN
    RETURN true;
  END IF;
  -- Private projects admit only direct human org sessions (owner/admin/project_member/project owner).
  -- Background/delegated agent contexts return NULL from ctx_user_id() and fail closed.
  v_uid := crove_kernel.ctx_user_id();
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;
  IF v_uid = p_owner_user_id THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM crove_projects.project_member pm
    WHERE pm.org_id = v_org AND pm.project_id = p_id AND pm.user_id = v_uid
  ) OR EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member tm
    WHERE tm.org_id = v_org AND tm.user_id = v_uid AND tm.role IN ('owner', 'admin')
  );
END $$;
REVOKE ALL ON FUNCTION crove_projects.project_row_visible(uuid, uuid, text, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.project_row_visible(uuid, uuid, text, uuid) TO crove_tenant;

-- Looks up a project's visibility and owner with RLS bypassed so policies on child tables and cross-module
-- links never trigger RLS recursion back into crove_projects.project.
CREATE OR REPLACE FUNCTION crove_projects.project_visible(
  p_org_id uuid,
  p_project_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_visibility text;
  v_owner uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_project_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  SELECT p.visibility, p.owner_user_id
    INTO v_visibility, v_owner
  FROM crove_projects.project p
  WHERE p.org_id = v_org AND p.id = p_project_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN crove_projects.project_row_visible(v_org, p_project_id, v_visibility, v_owner);
END $$;
REVOKE ALL ON FUNCTION crove_projects.project_visible(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.project_visible(uuid, uuid) TO crove_tenant;

-- Tasks linked to a private project are hidden from non-members, except an org-chart agent (which always carries
-- a non-null ctx_position_id(), whereas member_vy and mcp_member seal position = null) working a task assigned
-- to its own position_id. Unlinked and org-project tasks remain unaffected.
CREATE OR REPLACE FUNCTION crove_projects.task_visible(
  p_org_id uuid,
  p_task_id uuid,
  p_assignee_position_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_project_id uuid;
  v_visibility text;
  v_owner uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_task_id IS NULL OR v_actor IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor = 'system' THEN
    RETURN true;
  END IF;
  SELECT pt.project_id, p.visibility, p.owner_user_id
    INTO v_project_id, v_visibility, v_owner
  FROM crove_projects.project_task pt
  JOIN crove_projects.project p
    ON p.org_id = pt.org_id AND p.id = pt.project_id
  WHERE pt.org_id = v_org AND pt.task_id = p_task_id;
  IF NOT FOUND OR v_visibility = 'org' THEN
    RETURN true;
  END IF;
  IF v_actor = 'agent'
     AND crove_kernel.ctx_position_id() IS NOT NULL
     AND p_assignee_position_id = crove_kernel.ctx_position_id() THEN
    RETURN true;
  END IF;
  RETURN crove_projects.project_row_visible(v_org, v_project_id, v_visibility, v_owner);
END $$;
REVOKE ALL ON FUNCTION crove_projects.task_visible(uuid, uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.task_visible(uuid, uuid, uuid) TO crove_tenant;

DROP POLICY IF EXISTS project_visibility ON crove_projects.project;
CREATE POLICY project_visibility ON crove_projects.project AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_projects.project_row_visible(org_id, id, visibility, owner_user_id))
  WITH CHECK (crove_projects.project_row_visible(org_id, id, visibility, owner_user_id));

DROP POLICY IF EXISTS project_visibility ON crove_projects.project_member;
CREATE POLICY project_visibility ON crove_projects.project_member AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_projects.project_visible(org_id, project_id))
  WITH CHECK (crove_projects.project_visible(org_id, project_id));

DROP POLICY IF EXISTS project_visibility ON crove_projects.project_task;
CREATE POLICY project_visibility ON crove_projects.project_task AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_projects.project_visible(org_id, project_id))
  WITH CHECK (crove_projects.project_visible(org_id, project_id));

-- migration-lint: cross-module Owner decision A2 (ADR-0056, #2604): isolate tasks linked to private projects
DROP POLICY IF EXISTS private_project_scope ON crove_kernel.task;
-- migration-lint: cross-module Owner decision A2 (ADR-0056, #2604): isolate tasks linked to private projects
CREATE POLICY private_project_scope ON crove_kernel.task AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (crove_projects.task_visible(org_id, id, assignee_position_id))
  WITH CHECK (crove_projects.task_visible(org_id, id, assignee_position_id));

-- migration-lint: cross-module ADR-0056 section 1 (#2604): hide crove_notes.link rows pointing to private projects or private project tasks from non-members
DROP POLICY IF EXISTS link_private_project_scope ON crove_notes.link;
-- migration-lint: cross-module ADR-0056 section 1 (#2604): hide crove_notes.link rows pointing to private projects or private project tasks from non-members
CREATE POLICY link_private_project_scope ON crove_notes.link AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR target_type NOT IN ('projects.project', 'kernel.task')
    OR (target_type = 'projects.project' AND crove_projects.project_visible(org_id, target_id))
    OR (target_type = 'kernel.task' AND EXISTS (
      SELECT 1 FROM crove_kernel.task t
      WHERE t.org_id = link.org_id AND t.id = link.target_id
    ))
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR target_type NOT IN ('projects.project', 'kernel.task')
    OR (target_type = 'projects.project' AND crove_projects.project_visible(org_id, target_id))
    OR (target_type = 'kernel.task' AND EXISTS (
      SELECT 1 FROM crove_kernel.task t
      WHERE t.org_id = link.org_id AND t.id = link.target_id
    ))
  );

-- ---------------------------------------------------------------------------
-- 5. Close eSign project_acceptance leak path for private projects
-- ---------------------------------------------------------------------------
-- Shared eSign acceptance envelopes expose project titles, completed tasks, PDFs,
-- public/direct signer links, and Finance invoice handoffs across the org.
-- Disallow creating project_acceptance envelopes on private projects and disallow
-- switching an org project to private once a project_acceptance envelope exists.

CREATE OR REPLACE FUNCTION crove_projects.project_acceptance_org_only(p_org_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_visibility text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_project_id IS NULL THEN
    RETURN false;
  END IF;
  IF crove_kernel.ctx_actor_type() = 'system' THEN
    RETURN true;
  END IF;
  SELECT p.visibility INTO v_visibility
  FROM crove_projects.project p
  WHERE p.org_id = v_org AND p.id = p_project_id;
  RETURN FOUND AND v_visibility = 'org' AND crove_projects.project_visible(v_org, p_project_id);
END $$;
REVOKE ALL ON FUNCTION crove_projects.project_acceptance_org_only(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.project_acceptance_org_only(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_projects.has_project_acceptance_envelope(p_org_id uuid, p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_project_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN crove_projects.project_visible(v_org, p_project_id) AND EXISTS (
    SELECT 1 FROM crove_sign.envelope e
    WHERE e.org_id = v_org
      AND e.source_kind = 'project_acceptance'
      AND e.source_id = p_project_id
  );
END $$;
REVOKE ALL ON FUNCTION crove_projects.has_project_acceptance_envelope(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.has_project_acceptance_envelope(uuid, uuid) TO crove_tenant;

-- migration-lint: cross-module ADR-0056 section 1 (#2604): expose caller-scoped project visibility state to crove_sign without cross-module TypeScript SQL
CREATE OR REPLACE FUNCTION crove_sign.check_project_acceptance_source(p_org_id uuid, p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_visibility text;
  v_owner uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_project_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT p.visibility, p.owner_user_id INTO v_visibility, v_owner
  FROM crove_projects.project p
  WHERE p.org_id = v_org AND p.id = p_project_id;
  IF NOT FOUND OR NOT crove_projects.project_row_visible(v_org, p_project_id, v_visibility, v_owner) THEN
    RETURN 0;
  END IF;
  IF v_visibility = 'private' THEN
    RETURN 1;
  END IF;
  RETURN 2;
END $$;
-- migration-lint: cross-module ADR-0056 section 1 (#2604): revoke default execute on crove_sign helper
REVOKE ALL ON FUNCTION crove_sign.check_project_acceptance_source(uuid, uuid)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
-- migration-lint: cross-module ADR-0056 section 1 (#2604): allow crove_tenant to check project acceptance source visibility
GRANT EXECUTE ON FUNCTION crove_sign.check_project_acceptance_source(uuid, uuid) TO crove_tenant;

-- migration-lint: cross-module ADR-0056 section 1 (#2604): prevent switching an org project with existing project_acceptance eSign envelopes to private
CREATE OR REPLACE FUNCTION crove_projects.project_no_private_with_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.visibility IS DISTINCT FROM 'private' AND NEW.visibility = 'private' THEN
    IF EXISTS (
      SELECT 1 FROM crove_sign.envelope e
      WHERE e.org_id = NEW.org_id
        AND e.source_kind = 'project_acceptance'
        AND e.source_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'PROJECT_PRIVATE_ACCEPTANCE_EXISTS' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_projects.project_no_private_with_acceptance()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS project_no_private_with_acceptance ON crove_projects.project;
CREATE TRIGGER project_no_private_with_acceptance
  BEFORE UPDATE OF visibility ON crove_projects.project
  FOR EACH ROW EXECUTE FUNCTION crove_projects.project_no_private_with_acceptance();

-- migration-lint: cross-module ADR-0056 section 1 (#2604): forbid project_acceptance eSign envelopes on private projects
DROP POLICY IF EXISTS project_acceptance_org_only ON crove_sign.envelope;
-- migration-lint: cross-module ADR-0056 section 1 (#2604): forbid project_acceptance eSign envelopes on private projects
CREATE POLICY project_acceptance_org_only ON crove_sign.envelope AS RESTRICTIVE FOR ALL TO crove_tenant
  USING (
    source_kind <> 'project_acceptance'
    OR crove_projects.project_acceptance_org_only(org_id, source_id)
  )
  WITH CHECK (
    source_kind <> 'project_acceptance'
    OR crove_projects.project_acceptance_org_only(org_id, source_id)
  );
