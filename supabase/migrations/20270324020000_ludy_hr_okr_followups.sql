-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR OKR follow-ups (#4679, closing #4751 thread PRRT_kwDOT_fCws67uovu):
-- 1. Add narrow SECURITY DEFINER helpers ludy_hr.okr_employee_in_department(uuid, uuid, uuid) and
--    ludy_hr.okr_department_owner_allowed(uuid, uuid, uuid) so active L1 managers cannot assign
--    or update individual or department objectives with out-of-department or PDPL-erased employees,
--    checked uniformly BEFORE okr_employee_is_erased so active out-of-department rows and
--    PDPL-erased (department_id IS NULL) rows fail identically with zero intra-LE erasure oracle,
--    and align hr_okr_objective_insert WITH CHECK with hr_okr_objective_update on department_id IS NULL.
-- 2. Narrow ludy_hr.okr_employee_is_erased(uuid, uuid) in user context to owner/admin only
--    (removing intra-LE department-manager probing), and block reopening or reassigning erased individual objectives.
-- 3. Enforce member scope and actor parity for ludy_hr.okr_key_result.last_checkin_by on INSERT/UPDATE,
--    preserving NULL on superuser/PDPL erasure, kernel.member.remove FK cleanup, and maintenance paths.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_hr.okr_employee_in_department(
  p_org_id uuid,
  p_department_id uuid,
  p_employee_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 OR p_org_id IS NULL OR p_department_id IS NULL OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF v_le_scope IS NULL OR pg_catalog.cardinality(v_le_scope) = 0 THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
      JOIN ludy_hr.department d
        ON d.org_id = e.org_id
       AND d.id = p_department_id
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.department_id = p_department_id
       AND e.legal_entity_id = d.legal_entity_id
       AND e.erased_at IS NULL
       AND d.archived_at IS NULL
       AND (
         '*' = ANY (v_le_scope)
         OR (
           e.legal_entity_id::text = ANY (v_le_scope)
           AND d.legal_entity_id::text = ANY (v_le_scope)
         )
       )
       AND (
         v_role IN ('owner', 'admin')
         OR d.manager_user_id = v_user
       )
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_employee_in_department(uuid, uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_employee_in_department(uuid, uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.okr_department_owner_allowed(
  p_org_id uuid,
  p_department_id uuid,
  p_employee_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 OR p_org_id IS NULL OR p_department_id IS NULL OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF v_le_scope IS NULL OR pg_catalog.cardinality(v_le_scope) = 0 THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
      JOIN ludy_hr.department d
        ON d.org_id = e.org_id
       AND d.id = p_department_id
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.legal_entity_id = d.legal_entity_id
       AND e.erased_at IS NULL
       AND d.archived_at IS NULL
       AND (
         '*' = ANY (v_le_scope)
         OR (
           e.legal_entity_id::text = ANY (v_le_scope)
           AND d.legal_entity_id::text = ANY (v_le_scope)
         )
       )
       AND (
         v_role IN ('owner', 'admin')
         OR (
           d.manager_user_id = v_user
           AND (
             e.department_id = p_department_id
             OR e.user_id = v_user
             OR EXISTS (
               SELECT 1
                 FROM ludy_hr.department ed
                WHERE ed.org_id = e.org_id
                  AND ed.id = e.department_id
                  AND ed.legal_entity_id = d.legal_entity_id
                  AND ed.archived_at IS NULL
                  AND ed.manager_user_id = v_user
             )
           )
         )
       )
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_department_owner_allowed(uuid, uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_department_owner_allowed(uuid, uuid, uuid) TO ludy_tenant;

-- Narrow user-context check to owner/admin only so non-admin department managers cannot
-- probe intra-LE erasure status across departments.
CREATE OR REPLACE FUNCTION ludy_hr.okr_employee_is_erased(p_org_id uuid, p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 OR p_org_id IS NULL OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF v_le_scope IS NULL OR pg_catalog.cardinality(v_le_scope) = 0 THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.erased_at IS NOT NULL
       AND (
         '*' = ANY (v_le_scope)
         OR e.legal_entity_id::text = ANY (v_le_scope)
       )
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_employee_is_erased(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_employee_is_erased(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.okr_objective_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_parent_scope text;
  v_is_admin boolean := false;
  v_is_erased boolean := false;
BEGIN
  IF NEW.scope = 'company' AND NEW.parent_objective_id IS NOT NULL THEN
    RAISE EXCEPTION 'company objective cannot have a parent objective' USING ERRCODE = '42501';
  END IF;

  IF NEW.parent_objective_id IS NOT NULL THEN
    SELECT o.scope INTO v_parent_scope
      FROM ludy_hr.okr_objective o
     WHERE o.org_id = NEW.org_id
       AND o.legal_entity_id = NEW.legal_entity_id
       AND o.id = NEW.parent_objective_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent objective % not found in legal entity', NEW.parent_objective_id USING ERRCODE = '23503';
    END IF;
    IF NEW.scope = 'department' AND v_parent_scope <> 'company' THEN
      RAISE EXCEPTION 'department objective parent must be a company objective' USING ERRCODE = '42501';
    END IF;
    IF NEW.scope = 'individual' AND v_parent_scope NOT IN ('company', 'department') THEN
      RAISE EXCEPTION 'individual objective parent must be a company or department objective' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_actor = 'user' AND v_user IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id
         AND m.user_id = v_user
         AND m.role IN ('owner', 'admin')
    ) INTO v_is_admin;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.scope = 'individual' AND NEW.owner_employee_id IS NULL THEN
      RAISE EXCEPTION 'individual objective requires owner_employee_id' USING ERRCODE = '23514';
    END IF;
    IF v_actor = 'user' THEN
      IF NOT v_is_admin THEN
        -- Check L1 manager department alignment BEFORE any erasure check so active out-of-department
        -- employees and PDPL-erased (department_id IS NULL) rows fail uniformly with zero oracle.
        IF NEW.scope = 'individual'
           AND NEW.owner_employee_id IS NOT NULL
           AND NEW.department_id IS NOT NULL
           AND NOT ludy_hr.okr_employee_in_department(NEW.org_id, NEW.department_id, NEW.owner_employee_id) THEN
          RAISE EXCEPTION 'individual objective owner must belong to target department' USING ERRCODE = '42501';
        END IF;
        IF NEW.scope = 'department'
           AND NEW.owner_employee_id IS NOT NULL
           AND (
             NEW.department_id IS NULL
             OR NOT ludy_hr.okr_department_owner_allowed(NEW.org_id, NEW.department_id, NEW.owner_employee_id)
           ) THEN
          RAISE EXCEPTION 'department objective owner must belong to target department' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.owner_employee_id IS NOT NULL AND ludy_hr.okr_employee_is_erased(NEW.org_id, NEW.owner_employee_id) THEN
        RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.owner_employee_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM ludy_hr.payroll_employee e
         WHERE e.org_id = NEW.org_id
           AND e.id = NEW.owner_employee_id
           AND e.erased_at IS NOT NULL
      ) INTO v_is_erased;
      IF v_is_erased THEN
        RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.scope <> OLD.scope THEN
    RAISE EXCEPTION 'objective scope cannot be changed after creation' USING ERRCODE = '42501';
  END IF;

  IF OLD.scope = 'individual' AND OLD.owner_employee_id IS NULL THEN
    IF NEW.owner_employee_id IS NOT NULL THEN
      RAISE EXCEPTION 'cannot reassign erased individual objective' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'archived' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'cannot reopen erased individual objective' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Allow PDPL erasure (owner/admin or superuser/non-user) to clear owner_employee_id after employee.erased_at is stamped.
  IF NEW.owner_employee_id IS NULL AND OLD.owner_employee_id IS NOT NULL THEN
    IF OLD.scope = 'individual' THEN
      IF v_actor = 'user' THEN
        v_is_erased := v_is_admin AND ludy_hr.okr_employee_is_erased(OLD.org_id, OLD.owner_employee_id);
      ELSE
        SELECT EXISTS (
          SELECT 1
            FROM ludy_hr.payroll_employee e
           WHERE e.org_id = OLD.org_id
             AND e.id = OLD.owner_employee_id
             AND e.erased_at IS NOT NULL
        ) INTO v_is_erased;
      END IF;
      IF NOT v_is_erased THEN
        RAISE EXCEPTION 'individual objective requires owner_employee_id until employee erasure' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF v_actor = 'user' AND NOT v_is_admin THEN
    IF NEW.scope = 'individual'
       AND NEW.owner_employee_id IS NOT NULL
       AND NEW.department_id IS NOT NULL
       AND NOT ludy_hr.okr_employee_in_department(NEW.org_id, NEW.department_id, NEW.owner_employee_id) THEN
      RAISE EXCEPTION 'individual objective owner must belong to target department' USING ERRCODE = '42501';
    END IF;
    IF NEW.scope = 'department'
       AND NEW.owner_employee_id IS NOT NULL
       AND (
         NEW.owner_employee_id IS DISTINCT FROM OLD.owner_employee_id
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
       )
       AND (
         NEW.department_id IS NULL
         OR NOT ludy_hr.okr_department_owner_allowed(NEW.org_id, NEW.department_id, NEW.owner_employee_id)
       ) THEN
      RAISE EXCEPTION 'department objective owner must belong to target department' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.owner_employee_id IS NOT NULL AND NEW.owner_employee_id IS DISTINCT FROM OLD.owner_employee_id THEN
    IF v_actor = 'user' THEN
      v_is_erased := ludy_hr.okr_employee_is_erased(NEW.org_id, NEW.owner_employee_id);
    ELSE
      SELECT EXISTS (
        SELECT 1
          FROM ludy_hr.payroll_employee e
         WHERE e.org_id = NEW.org_id
           AND e.id = NEW.owner_employee_id
           AND e.erased_at IS NOT NULL
      ) INTO v_is_erased;
    END IF;
    IF v_is_erased THEN
      RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_objective_write_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP POLICY IF EXISTS hr_okr_objective_insert ON ludy_hr.okr_objective;
CREATE POLICY hr_okr_objective_insert ON ludy_hr.okr_objective AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (okr_objective.created_by IS NULL OR okr_objective.created_by = (SELECT ludy_kernel.ctx_user_id()))
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_objective.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        okr_objective.scope = 'department'
        AND okr_objective.department_id IS NOT NULL
        AND ludy_hr.is_active_dept_manager(okr_objective.org_id, okr_objective.department_id)
      )
      OR (
        okr_objective.scope = 'individual'
        AND (
          (okr_objective.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(okr_objective.org_id, okr_objective.department_id))
          OR (
            okr_objective.department_id IS NULL
            AND okr_objective.owner_employee_id IS NOT NULL
            AND ludy_hr.is_active_dept_manager_of_employee(okr_objective.org_id, okr_objective.owner_employee_id)
          )
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION ludy_hr.okr_key_result_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Allow FK ON DELETE SET NULL(last_checkin_by) when kernel.member.remove deletes a member.
    IF OLD.last_checkin_by IS NOT NULL
       AND NEW.last_checkin_by IS NULL
       AND NEW.title = OLD.title
       AND NEW.metric_type = OLD.metric_type
       AND NEW.target_value = OLD.target_value
       AND NEW.current_value = OLD.current_value
       AND NEW.unit IS NOT DISTINCT FROM OLD.unit
       AND NEW.linked_project_id IS NOT DISTINCT FROM OLD.linked_project_id
       AND NEW.linked_task_ids = OLD.linked_task_ids
       AND NEW.progress_pct = OLD.progress_pct
       AND NEW.last_checkin_note IS NOT DISTINCT FROM OLD.last_checkin_note
       AND NEW.last_checkin_at IS NOT DISTINCT FROM OLD.last_checkin_at
       AND NEW.updated_at = OLD.updated_at THEN
      RETURN NEW;
    END IF;

    -- Allow hr.payroll.employee.erase to clear check-in notes on erased employee objectives.
    IF NEW.last_checkin_note IS NULL
       AND OLD.last_checkin_note IS NOT NULL
       AND NEW.title = OLD.title
       AND NEW.metric_type = OLD.metric_type
       AND NEW.target_value = OLD.target_value
       AND NEW.current_value = OLD.current_value
       AND NEW.unit IS NOT DISTINCT FROM OLD.unit
       AND NEW.linked_project_id IS NOT DISTINCT FROM OLD.linked_project_id
       AND NEW.linked_task_ids = OLD.linked_task_ids
       AND NEW.progress_pct = OLD.progress_pct
       AND NEW.last_checkin_at IS NOT DISTINCT FROM OLD.last_checkin_at
       AND NEW.last_checkin_by IS NOT DISTINCT FROM OLD.last_checkin_by
       AND ludy_hr.is_okr_objective_erased(OLD.org_id, OLD.objective_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Validate last_checkin_by member scope and actor parity (#4679 item 8).
  IF v_actor = 'user' THEN
    IF (TG_OP = 'INSERT' AND NEW.last_checkin_by IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.last_checkin_by IS DISTINCT FROM OLD.last_checkin_by) THEN
      IF v_user IS NULL OR NEW.last_checkin_by IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'last_checkin_by must match current user' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM ludy_kernel.tenant_member m
         WHERE m.org_id = NEW.org_id
           AND m.user_id = NEW.last_checkin_by
           AND m.role IN ('owner', 'admin', 'member')
      ) THEN
        RAISE EXCEPTION 'last_checkin_by must be an active org member' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.last_checkin_by IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id
         AND m.user_id = NEW.last_checkin_by
         AND m.role IN ('owner', 'admin', 'member')
    ) THEN
      RAISE EXCEPTION 'last_checkin_by must be an active org member' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Non-manager linked employees performing self check-ins may update check-in fields only.
    IF NOT ludy_hr.can_manage_okr_objective(OLD.org_id, OLD.objective_id) THEN
      IF NEW.title IS DISTINCT FROM OLD.title
         OR NEW.metric_type IS DISTINCT FROM OLD.metric_type
         OR NEW.target_value IS DISTINCT FROM OLD.target_value
         OR NEW.unit IS DISTINCT FROM OLD.unit
         OR NEW.linked_project_id IS DISTINCT FROM OLD.linked_project_id
         OR NEW.linked_task_ids IS DISTINCT FROM OLD.linked_task_ids THEN
        RAISE EXCEPTION 'self check-in cannot modify key result definition or target' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_key_result_write_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS okr_key_result_write_guard ON ludy_hr.okr_key_result;
CREATE TRIGGER okr_key_result_write_guard BEFORE INSERT OR UPDATE ON ludy_hr.okr_key_result
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.okr_key_result_write_guard();
ALTER TABLE ludy_hr.okr_key_result ENABLE ALWAYS TRIGGER okr_key_result_write_guard;
