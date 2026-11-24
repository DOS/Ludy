-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR (issue #4529, Stage 6D): lightweight quarterly OKRs/goals (company -> department -> individual)
-- with caller-scoped Ludy Cong tac (projects) task linkage, RLS, PDPL erasure handling, and update guards.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Legal entity fill helpers for OKR objectives and key results.
CREATE OR REPLACE FUNCTION ludy_hr.okr_objective_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.department_id IS NOT NULL THEN
    SELECT d.legal_entity_id INTO v_entity
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = NEW.department_id;
  END IF;
  IF v_entity IS NULL AND NEW.owner_employee_id IS NOT NULL THEN
    SELECT e.legal_entity_id INTO v_entity
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = NEW.org_id AND e.id = NEW.owner_employee_id;
  END IF;
  IF v_entity IS NULL THEN
    SELECT le.id INTO v_entity
      FROM ludy_kernel.legal_entity le
     WHERE le.org_id = NEW.org_id AND le.is_default;
  END IF;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_objective_legal_entity_fill() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.okr_key_result_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT o.legal_entity_id INTO v_entity
    FROM ludy_hr.okr_objective o
   WHERE o.org_id = NEW.org_id AND o.id = NEW.objective_id;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_key_result_legal_entity_fill() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

-- 2. Active L1 department manager RLS helpers (archived departments grant zero manager authority).
CREATE OR REPLACE FUNCTION ludy_hr.is_active_dept_manager(p_org_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_department_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM ludy_hr.department d
     WHERE d.org_id = v_org
       AND d.id = p_department_id
       AND d.archived_at IS NULL
       AND d.manager_user_id = v_user
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.is_active_dept_manager(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.is_active_dept_manager(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.has_managed_department(p_org_id uuid, p_legal_entity_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM ludy_hr.department d
     WHERE d.org_id = v_org
       AND d.legal_entity_id = p_legal_entity_id
       AND d.archived_at IS NULL
       AND d.manager_user_id = v_user
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.has_managed_department(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.has_managed_department(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.is_active_dept_manager_of_employee(p_org_id uuid, p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
      JOIN ludy_hr.department d
        ON d.org_id = e.org_id AND d.id = e.department_id
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.erased_at IS NULL
       AND d.archived_at IS NULL
       AND d.manager_user_id = v_user
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.is_active_dept_manager_of_employee(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.is_active_dept_manager_of_employee(uuid, uuid) TO ludy_tenant;

-- 3. Quarterly OKR objectives table (Company -> Department -> Individual).
CREATE TABLE IF NOT EXISTS ludy_hr.okr_objective (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  quarter text NOT NULL CHECK (quarter ~ '^[0-9]{4}-Q[1-4]$'),
  scope text NOT NULL CHECK (scope IN ('company', 'department', 'individual')),
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 300),
  owner_employee_id uuid,
  department_id uuid,
  parent_objective_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT okr_objective_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT okr_objective_owner_fk FOREIGN KEY (org_id, legal_entity_id, owner_employee_id)
    REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT okr_objective_department_fk FOREIGN KEY (org_id, legal_entity_id, department_id)
    REFERENCES ludy_hr.department (org_id, legal_entity_id, id),
  CONSTRAINT okr_objective_parent_fk FOREIGN KEY (org_id, legal_entity_id, parent_objective_id)
    REFERENCES ludy_hr.okr_objective (org_id, legal_entity_id, id)
    ON DELETE SET NULL (parent_objective_id),
  CONSTRAINT okr_objective_scope_dept_ck CHECK (
    (scope <> 'company' OR department_id IS NULL)
    AND (scope <> 'department' OR department_id IS NOT NULL)
  ),
  CONSTRAINT okr_objective_not_self_parent_ck CHECK (parent_objective_id IS NULL OR parent_objective_id <> id)
);

CREATE INDEX IF NOT EXISTS okr_objective_org_quarter_idx
  ON ludy_hr.okr_objective (org_id, legal_entity_id, quarter, scope, status);
CREATE INDEX IF NOT EXISTS okr_objective_owner_idx
  ON ludy_hr.okr_objective (org_id, legal_entity_id, owner_employee_id);
CREATE INDEX IF NOT EXISTS okr_objective_dept_idx
  ON ludy_hr.okr_objective (org_id, legal_entity_id, department_id);
CREATE INDEX IF NOT EXISTS okr_objective_parent_idx
  ON ludy_hr.okr_objective (org_id, legal_entity_id, parent_objective_id);
CREATE INDEX IF NOT EXISTS okr_objective_entity_idx
  ON ludy_hr.okr_objective (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.okr_objective');
REVOKE ALL ON ludy_hr.okr_objective FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON ludy_hr.okr_objective TO ludy_tenant;
GRANT UPDATE (
  quarter,
  scope,
  title,
  owner_employee_id,
  department_id,
  parent_objective_id,
  status,
  updated_at
) ON ludy_hr.okr_objective TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.okr_objective;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON ludy_hr.okr_objective
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.okr_objective_legal_entity_fill();
ALTER TABLE ludy_hr.okr_objective ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.okr_objective_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_parent_scope text;
  v_erased timestamptz;
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

  IF TG_OP = 'INSERT' THEN
    IF NEW.scope = 'individual' AND NEW.owner_employee_id IS NULL THEN
      RAISE EXCEPTION 'individual objective requires owner_employee_id' USING ERRCODE = '23514';
    END IF;
    IF NEW.owner_employee_id IS NOT NULL THEN
      SELECT e.erased_at INTO v_erased
        FROM ludy_hr.payroll_employee e
       WHERE e.org_id = NEW.org_id AND e.id = NEW.owner_employee_id;
      IF v_erased IS NOT NULL THEN
        RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.scope <> OLD.scope THEN
    RAISE EXCEPTION 'objective scope cannot be changed after creation' USING ERRCODE = '42501';
  END IF;

  -- Allow PDPL erasure to clear owner_employee_id after employee.erased_at is stamped.
  IF NEW.owner_employee_id IS NULL AND OLD.owner_employee_id IS NOT NULL THEN
    IF OLD.scope = 'individual' THEN
      SELECT e.erased_at INTO v_erased
        FROM ludy_hr.payroll_employee e
       WHERE e.org_id = OLD.org_id AND e.id = OLD.owner_employee_id;
      IF v_erased IS NULL THEN
        RAISE EXCEPTION 'individual objective requires owner_employee_id until employee erasure' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.owner_employee_id IS NOT NULL AND NEW.owner_employee_id IS DISTINCT FROM OLD.owner_employee_id THEN
    SELECT e.erased_at INTO v_erased
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = NEW.org_id AND e.id = NEW.owner_employee_id;
    IF v_erased IS NOT NULL THEN
      RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_objective_write_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS okr_objective_write_guard ON ludy_hr.okr_objective;
CREATE TRIGGER okr_objective_write_guard BEFORE INSERT OR UPDATE ON ludy_hr.okr_objective
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.okr_objective_write_guard();
ALTER TABLE ludy_hr.okr_objective ENABLE ALWAYS TRIGGER okr_objective_write_guard;

DROP POLICY IF EXISTS le_scope ON ludy_hr.okr_objective;
CREATE POLICY le_scope ON ludy_hr.okr_objective AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_okr_objective_select ON ludy_hr.okr_objective;
DROP POLICY IF EXISTS hr_okr_objective_insert ON ludy_hr.okr_objective;
DROP POLICY IF EXISTS hr_okr_objective_update ON ludy_hr.okr_objective;
DROP POLICY IF EXISTS hr_okr_objective_delete ON ludy_hr.okr_objective;

CREATE POLICY hr_okr_objective_select ON ludy_hr.okr_objective AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_objective.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        okr_objective.scope = 'company'
        AND okr_objective.status IN ('active', 'completed')
        AND (
          ludy_hr.has_linked_employee(okr_objective.org_id, okr_objective.legal_entity_id)
          OR ludy_hr.has_managed_department(okr_objective.org_id, okr_objective.legal_entity_id)
        )
      )
      OR (
        okr_objective.scope = 'department'
        AND okr_objective.department_id IS NOT NULL
        AND (
          ludy_hr.is_active_dept_manager(okr_objective.org_id, okr_objective.department_id)
          OR (
            okr_objective.status IN ('active', 'completed')
            AND ludy_hr.is_self_department(okr_objective.org_id, okr_objective.department_id)
          )
        )
      )
      OR (
        okr_objective.scope = 'individual'
        AND (
          (okr_objective.owner_employee_id IS NOT NULL AND ludy_hr.is_self_employee(okr_objective.org_id, okr_objective.owner_employee_id))
          OR (okr_objective.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(okr_objective.org_id, okr_objective.department_id))
          OR (okr_objective.owner_employee_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(okr_objective.org_id, okr_objective.owner_employee_id))
        )
      )
    )
  );

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
          OR (okr_objective.owner_employee_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(okr_objective.org_id, okr_objective.owner_employee_id))
        )
      )
    )
  );

CREATE POLICY hr_okr_objective_update ON ludy_hr.okr_objective AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
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
          OR (okr_objective.owner_employee_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(okr_objective.org_id, okr_objective.owner_employee_id))
        )
      )
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
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
          OR (okr_objective.department_id IS NULL AND okr_objective.owner_employee_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(okr_objective.org_id, okr_objective.owner_employee_id))
        )
      )
    )
  );

DROP POLICY IF EXISTS hr_okr_objective_delete ON ludy_hr.okr_objective;

-- 4. Anti-recursion SECURITY DEFINER RLS helpers for okr_key_result referencing okr_objective.
CREATE OR REPLACE FUNCTION ludy_hr.can_read_okr_objective(p_org_id uuid, p_objective_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_le_id uuid;
  v_scope text;
  v_owner_emp_id uuid;
  v_dept_id uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_objective_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  END IF;
  SELECT o.legal_entity_id, o.scope, o.owner_employee_id, o.department_id, o.status
    INTO v_le_id, v_scope, v_owner_emp_id, v_dept_id, v_status
    FROM ludy_hr.okr_objective o
   WHERE o.org_id = v_org AND o.id = p_objective_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_scope = 'company' THEN
    RETURN v_status IN ('active', 'completed')
      AND (ludy_hr.has_linked_employee(v_org, v_le_id) OR ludy_hr.has_managed_department(v_org, v_le_id));
  ELSIF v_scope = 'department' THEN
    RETURN v_dept_id IS NOT NULL
      AND (
        ludy_hr.is_active_dept_manager(v_org, v_dept_id)
        OR (v_status IN ('active', 'completed') AND ludy_hr.is_self_department(v_org, v_dept_id))
      );
  ELSIF v_scope = 'individual' THEN
    RETURN (v_owner_emp_id IS NOT NULL AND ludy_hr.is_self_employee(v_org, v_owner_emp_id))
      OR (v_dept_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_dept_id))
      OR (v_owner_emp_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(v_org, v_owner_emp_id));
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.can_read_okr_objective(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.can_read_okr_objective(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.can_manage_okr_objective(p_org_id uuid, p_objective_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_scope text;
  v_owner_emp_id uuid;
  v_dept_id uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_objective_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  END IF;
  SELECT o.scope, o.owner_employee_id, o.department_id
    INTO v_scope, v_owner_emp_id, v_dept_id
    FROM ludy_hr.okr_objective o
   WHERE o.org_id = v_org AND o.id = p_objective_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_scope = 'department' THEN
    RETURN v_dept_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_dept_id);
  ELSIF v_scope = 'individual' THEN
    RETURN (v_dept_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_dept_id))
      OR (v_owner_emp_id IS NOT NULL AND ludy_hr.is_active_dept_manager_of_employee(v_org, v_owner_emp_id));
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.can_manage_okr_objective(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.can_manage_okr_objective(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.is_self_okr_objective(p_org_id uuid, p_objective_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_scope text;
  v_owner_emp_id uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_objective_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  SELECT o.scope, o.owner_employee_id, o.status
    INTO v_scope, v_owner_emp_id, v_status
    FROM ludy_hr.okr_objective o
   WHERE o.org_id = v_org AND o.id = p_objective_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN v_scope = 'individual'
    AND v_status = 'active'
    AND v_owner_emp_id IS NOT NULL
    AND ludy_hr.is_self_employee(v_org, v_owner_emp_id);
END $$;
REVOKE ALL ON FUNCTION ludy_hr.is_self_okr_objective(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.is_self_okr_objective(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.is_okr_objective_erased(p_org_id uuid, p_objective_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_owner_emp_id uuid;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_objective_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT o.owner_employee_id INTO v_owner_emp_id
    FROM ludy_hr.okr_objective o
   WHERE o.org_id = v_org AND o.id = p_objective_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_owner_emp_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM ludy_hr.payroll_employee e
     WHERE e.org_id = v_org AND e.id = v_owner_emp_id AND e.erased_at IS NOT NULL
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.is_okr_objective_erased(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.is_okr_objective_erased(uuid, uuid) TO ludy_tenant;

-- Active non-sensitive employee identity rows visible to the caller for OKR assignment & display
-- (owner/admin in le_scope, linked self employee, or active L1 department manager's team; zero rows for unlinked members/viewers).
CREATE OR REPLACE FUNCTION ludy_hr.okr_visible_employees(p_org_id uuid)
RETURNS TABLE (
  id uuid,
  legal_entity_id uuid,
  department_id uuid,
  display_name text,
  job_title text,
  status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT e.id, e.legal_entity_id, e.department_id, e.display_name, e.job_title, e.status
      FROM ludy_hr.payroll_employee e
      LEFT JOIN ludy_hr.department d
        ON d.org_id = e.org_id AND d.id = e.department_id
     WHERE e.org_id = v_org
       AND e.erased_at IS NULL
       AND (
         '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
         OR e.legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
       )
       AND (
         v_role IN ('owner', 'admin')
         OR e.user_id = v_user
         OR (d.archived_at IS NULL AND d.manager_user_id = v_user)
       )
     ORDER BY e.display_name ASC, e.id ASC;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_visible_employees(uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_visible_employees(uuid) TO ludy_tenant;

-- 5. Quarterly OKR key results table (NUMERIC metrics + optional Ludy Cong tac project/task linkage).
CREATE TABLE IF NOT EXISTS ludy_hr.okr_key_result (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 300),
  metric_type text NOT NULL CHECK (metric_type IN ('percent', 'number', 'currency', 'boolean', 'project_tasks')),
  target_value numeric(14, 2) NOT NULL CHECK (target_value >= 0 AND (metric_type = 'project_tasks' OR target_value > 0)),
  current_value numeric(14, 2) NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  unit text CHECK (unit IS NULL OR (pg_catalog.length(pg_catalog.btrim(unit)) >= 1 AND pg_catalog.length(unit) <= 32)),
  linked_project_id uuid,
  linked_task_ids text[] NOT NULL DEFAULT '{}'::text[] CHECK (pg_catalog.cardinality(linked_task_ids) <= 50),
  progress_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
  last_checkin_note text CHECK (last_checkin_note IS NULL OR pg_catalog.length(last_checkin_note) <= 2000),
  last_checkin_at timestamptz,
  last_checkin_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT okr_key_result_objective_fk FOREIGN KEY (org_id, legal_entity_id, objective_id)
    REFERENCES ludy_hr.okr_objective (org_id, legal_entity_id, id)
    ON DELETE CASCADE,
  CONSTRAINT okr_key_result_checkin_by_fk FOREIGN KEY (org_id, last_checkin_by)
    REFERENCES ludy_kernel.tenant_member (org_id, user_id)
    ON DELETE SET NULL (last_checkin_by)
);

CREATE INDEX IF NOT EXISTS okr_key_result_objective_idx
  ON ludy_hr.okr_key_result (org_id, legal_entity_id, objective_id, created_at ASC);
CREATE INDEX IF NOT EXISTS okr_key_result_project_idx
  ON ludy_hr.okr_key_result (org_id, linked_project_id)
  WHERE linked_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS okr_key_result_checkin_by_idx
  ON ludy_hr.okr_key_result (org_id, last_checkin_by)
  WHERE last_checkin_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS okr_key_result_entity_idx
  ON ludy_hr.okr_key_result (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.okr_key_result');
REVOKE ALL ON ludy_hr.okr_key_result FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT, DELETE ON ludy_hr.okr_key_result TO ludy_tenant;
GRANT UPDATE (
  title,
  metric_type,
  target_value,
  current_value,
  unit,
  linked_project_id,
  linked_task_ids,
  progress_pct,
  last_checkin_note,
  last_checkin_at,
  last_checkin_by,
  updated_at
) ON ludy_hr.okr_key_result TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.okr_key_result;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON ludy_hr.okr_key_result
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.okr_key_result_legal_entity_fill();
ALTER TABLE ludy_hr.okr_key_result ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.okr_key_result_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
REVOKE ALL ON FUNCTION ludy_hr.okr_key_result_write_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS okr_key_result_write_guard ON ludy_hr.okr_key_result;
CREATE TRIGGER okr_key_result_write_guard BEFORE UPDATE ON ludy_hr.okr_key_result
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.okr_key_result_write_guard();
ALTER TABLE ludy_hr.okr_key_result ENABLE ALWAYS TRIGGER okr_key_result_write_guard;

DROP POLICY IF EXISTS le_scope ON ludy_hr.okr_key_result;
CREATE POLICY le_scope ON ludy_hr.okr_key_result AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_okr_key_result_select ON ludy_hr.okr_key_result;
DROP POLICY IF EXISTS hr_okr_key_result_insert ON ludy_hr.okr_key_result;
DROP POLICY IF EXISTS hr_okr_key_result_update ON ludy_hr.okr_key_result;
DROP POLICY IF EXISTS hr_okr_key_result_delete ON ludy_hr.okr_key_result;

CREATE POLICY hr_okr_key_result_select ON ludy_hr.okr_key_result AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_key_result.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.can_read_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
    )
  );

CREATE POLICY hr_okr_key_result_insert ON ludy_hr.okr_key_result AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (okr_key_result.created_by IS NULL OR okr_key_result.created_by = (SELECT ludy_kernel.ctx_user_id()))
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_key_result.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.can_manage_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
    )
  );

CREATE POLICY hr_okr_key_result_update ON ludy_hr.okr_key_result AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_key_result.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.can_manage_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
      OR ludy_hr.is_self_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_key_result.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.can_manage_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
      OR ludy_hr.is_self_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
    )
  );

CREATE POLICY hr_okr_key_result_delete ON ludy_hr.okr_key_result AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = okr_key_result.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.can_manage_okr_objective(okr_key_result.org_id, okr_key_result.objective_id)
    )
  );
