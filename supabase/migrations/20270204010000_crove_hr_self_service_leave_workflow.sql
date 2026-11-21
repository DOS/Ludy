-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #4300, Stage 4A Step 1 of 2): employee self-service portal, optional member link and department manager,
-- multi-level leave requests, anti-recursion RLS helpers, per-command RESTRICTIVE policies, and updated org_purge.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Optional link between a payroll employee and an organization member (partial unique per org, NULLs unrestricted).
ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_employee_org_user_uidx
  ON crove_hr.payroll_employee (org_id, user_id) WHERE user_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crove_hr'
       AND c.relname = 'payroll_employee'
       AND con.conname = 'payroll_employee_member_fk'
  ) THEN
    ALTER TABLE crove_hr.payroll_employee
      ADD CONSTRAINT payroll_employee_member_fk
      FOREIGN KEY (org_id, user_id)
      REFERENCES crove_kernel.tenant_member (org_id, user_id)
      ON DELETE SET NULL (user_id);
  END IF;
END $$;
GRANT UPDATE (user_id) ON crove_hr.payroll_employee TO crove_tenant;

-- 2. Optional L1 manager (organization member) on a department.
ALTER TABLE crove_hr.department ADD COLUMN IF NOT EXISTS manager_user_id uuid;
CREATE INDEX IF NOT EXISTS department_org_manager_idx
  ON crove_hr.department (org_id, manager_user_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'crove_hr'
       AND c.relname = 'department'
       AND con.conname = 'department_manager_fk'
  ) THEN
    ALTER TABLE crove_hr.department
      ADD CONSTRAINT department_manager_fk
      FOREIGN KEY (org_id, manager_user_id)
      REFERENCES crove_kernel.tenant_member (org_id, user_id)
      ON DELETE SET NULL (manager_user_id);
  END IF;
END $$;
GRANT UPDATE (manager_user_id) ON crove_hr.department TO crove_tenant;

-- 3. Leave requests with L1 -> final approval state machine.
CREATE TABLE IF NOT EXISTS crove_hr.leave_request (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  department_id uuid,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  start_on date NOT NULL,
  end_on date NOT NULL CHECK (end_on >= start_on),
  kind text NOT NULL CHECK (kind IN ('annual_leave', 'personal_paid', 'unpaid_leave')),
  days numeric(6, 2) NOT NULL CHECK (days > 0 AND days <= 366),
  status text NOT NULL DEFAULT 'pending_final' CHECK (status IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled')),
  l1_approver_user_id uuid,
  l1_acted_at timestamptz,
  final_acted_by uuid,
  final_acted_at timestamptz,
  reason text CHECK (reason IS NULL OR pg_catalog.length(reason) <= 2000),
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 2000),
  payroll_leave_entry_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT leave_request_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT leave_request_department_fk FOREIGN KEY (org_id, legal_entity_id, department_id)
    REFERENCES crove_hr.department (org_id, legal_entity_id, id),
  CONSTRAINT leave_request_leave_entry_fk FOREIGN KEY (org_id, payroll_leave_entry_id)
    REFERENCES crove_hr.payroll_leave_entry (org_id, id)
    ON DELETE SET NULL (payroll_leave_entry_id)
);

CREATE INDEX IF NOT EXISTS leave_request_employee_idx
  ON crove_hr.leave_request (org_id, legal_entity_id, employee_id, month);
CREATE INDEX IF NOT EXISTS leave_request_department_idx
  ON crove_hr.leave_request (org_id, legal_entity_id, department_id, status);
CREATE INDEX IF NOT EXISTS leave_request_leave_entry_idx
  ON crove_hr.leave_request (org_id, payroll_leave_entry_id);
CREATE INDEX IF NOT EXISTS leave_request_entity_idx
  ON crove_hr.leave_request (legal_entity_id, org_id);

SELECT crove_kernel.apply_tenant_rls('crove_hr.leave_request');
REVOKE ALL ON crove_hr.leave_request FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.leave_request TO crove_tenant;
GRANT UPDATE (
  status,
  l1_approver_user_id,
  l1_acted_at,
  final_acted_by,
  final_acted_at,
  decision_note,
  payroll_leave_entry_id,
  updated_at
) ON crove_hr.leave_request TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.leave_request;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.leave_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_hr.leave_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status IN ('approved', 'rejected', 'cancelled') THEN
    -- Allow FK ON DELETE SET NULL clearing payroll_leave_entry_id while preserving status and decision fields.
    IF NEW.status = OLD.status
       AND NEW.payroll_leave_entry_id IS NULL
       AND OLD.payroll_leave_entry_id IS NOT NULL
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
      RETURN NEW;
    END IF;
    -- Allow no-op updated_at updates when status and approval fields are unchanged.
    IF NEW.status = OLD.status
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
       AND NEW.payroll_leave_entry_id IS NOT DISTINCT FROM OLD.payroll_leave_entry_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'leave request % is already %', OLD.id, OLD.status USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'pending_l1' THEN
    IF NEW.status NOT IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'invalid leave request transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status = 'pending_final' THEN
    IF NEW.status NOT IN ('pending_final', 'approved', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'invalid leave request transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
      RAISE EXCEPTION 'cannot alter L1 approval fields after %', OLD.status USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.final_acted_by IS NOT NULL
       OR NEW.final_acted_at IS NOT NULL
       OR NEW.payroll_leave_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled leave request cannot carry approval fields' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status <> 'approved' AND NEW.payroll_leave_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'only approved leave requests may link a payroll_leave_entry' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.leave_request_update_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS leave_request_update_guard ON crove_hr.leave_request;
CREATE TRIGGER leave_request_update_guard BEFORE UPDATE ON crove_hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION crove_hr.leave_request_update_guard();
ALTER TABLE crove_hr.leave_request ENABLE ALWAYS TRIGGER leave_request_update_guard;

-- 4. Anti-recursion SECURITY DEFINER STABLE RLS helpers (pinned search_path, user-context gated).
CREATE OR REPLACE FUNCTION crove_hr.is_self_employee(p_org_id uuid, p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_hr.payroll_employee e
     WHERE e.org_id = v_org AND e.id = p_employee_id AND e.user_id = v_user AND e.erased_at IS NULL
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.is_self_employee(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.is_self_employee(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_hr.has_linked_employee(p_org_id uuid, p_legal_entity_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_hr.payroll_employee e
     WHERE e.org_id = v_org AND e.legal_entity_id = p_legal_entity_id AND e.user_id = v_user AND e.erased_at IS NULL
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.has_linked_employee(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.has_linked_employee(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_hr.is_self_department(p_org_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_department_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_hr.payroll_employee e
     WHERE e.org_id = v_org AND e.department_id = p_department_id AND e.user_id = v_user AND e.erased_at IS NULL
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.is_self_department(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.is_self_department(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_hr.is_dept_manager(p_org_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_department_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_hr.department d
     WHERE d.org_id = v_org AND d.id = p_department_id AND d.manager_user_id = v_user
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.is_dept_manager(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.is_dept_manager(uuid, uuid) TO crove_tenant;

CREATE OR REPLACE FUNCTION crove_hr.is_run_published(p_org_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_run_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM crove_hr.payroll_run r
     WHERE r.org_id = v_org AND r.id = p_run_id AND r.status IN ('approved', 'paid', 'closed')
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.is_run_published(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.is_run_published(uuid, uuid) TO crove_tenant;

-- Aggregate department leave overlap count for an employee's own submit warning (returns only a count, zero colleague rows).
CREATE OR REPLACE FUNCTION crove_hr.dept_overlap_leave_count(
  p_org_id uuid,
  p_department_id uuid,
  p_employee_id uuid,
  p_start_on date,
  p_end_on date
) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_department_id IS NULL OR p_employee_id IS NULL OR p_start_on IS NULL OR p_end_on IS NULL THEN
    RETURN 0;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_hr.payroll_employee e
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.department_id = p_department_id
       AND e.user_id = v_user
       AND e.erased_at IS NULL
  ) THEN
    RETURN 0;
  END IF;
  RETURN (
    SELECT pg_catalog.count(*)::integer
      FROM crove_hr.leave_request lr
     WHERE lr.org_id = v_org
       AND lr.department_id = p_department_id
       AND lr.employee_id <> p_employee_id
       AND lr.status IN ('pending_l1', 'pending_final', 'approved')
       AND lr.start_on <= p_end_on
       AND lr.end_on >= p_start_on
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.dept_overlap_leave_count(uuid, uuid, uuid, date, date) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.dept_overlap_leave_count(uuid, uuid, uuid, date, date) TO crove_tenant;

-- Employee's own hire date (MIN effective_from) without exposing payroll_employment wages or contract rows.
CREATE OR REPLACE FUNCTION crove_hr.self_hire_date(p_org_id uuid, p_employee_id uuid)
RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_hire date;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_employee_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crove_hr.payroll_employee e
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.user_id = v_user
       AND e.erased_at IS NULL
       AND (
         '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
         OR e.legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
       )
  ) THEN
    RETURN NULL;
  END IF;
  SELECT pg_catalog.min(pe.effective_from) INTO v_hire
    FROM crove_hr.payroll_employment pe
   WHERE pe.org_id = v_org AND pe.employee_id = p_employee_id;
  RETURN v_hire;
END $$;
REVOKE ALL ON FUNCTION crove_hr.self_hire_date(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.self_hire_date(uuid, uuid) TO crove_tenant;

-- Requester display name for an already-visible leave_request row (owner/admin, linked self, or L1 dept manager).
CREATE OR REPLACE FUNCTION crove_hr.leave_request_employee_name(p_org_id uuid, p_request_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := crove_kernel.ctx_org_id();
  v_actor text := crove_kernel.ctx_actor_type();
  v_user uuid := crove_kernel.ctx_user_id();
  v_role text;
  v_emp_id uuid;
  v_dept_id uuid;
  v_le_id uuid;
  v_name text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_request_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.role INTO v_role
    FROM crove_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN NULL;
  END IF;
  SELECT lr.employee_id, lr.department_id, lr.legal_entity_id
    INTO v_emp_id, v_dept_id, v_le_id
    FROM crove_hr.leave_request lr
   WHERE lr.org_id = v_org AND lr.id = p_request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT (
    '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    OR v_le_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
  ) THEN
    RETURN NULL;
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF NOT (
      crove_hr.is_self_employee(v_org, v_emp_id)
      OR (v_dept_id IS NOT NULL AND crove_hr.is_dept_manager(v_org, v_dept_id))
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT e.display_name INTO v_name
    FROM crove_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = v_emp_id AND e.erased_at IS NULL;
  RETURN v_name;
END $$;
REVOKE ALL ON FUNCTION crove_hr.leave_request_employee_name(uuid, uuid) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.leave_request_employee_name(uuid, uuid) TO crove_tenant;

-- 5. Per-command RESTRICTIVE policies across HR self-service and leave tables.
-- le_scope on leave_request
DROP POLICY IF EXISTS le_scope ON crove_hr.leave_request;
CREATE POLICY le_scope ON crove_hr.leave_request AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

-- payroll_employee: replace owner_admin FOR ALL with per-command policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_employee;
DROP POLICY IF EXISTS hr_employee_select ON crove_hr.payroll_employee;
DROP POLICY IF EXISTS hr_employee_insert ON crove_hr.payroll_employee;
DROP POLICY IF EXISTS hr_employee_update ON crove_hr.payroll_employee;
DROP POLICY IF EXISTS hr_employee_delete ON crove_hr.payroll_employee;

CREATE POLICY hr_employee_select ON crove_hr.payroll_employee AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = payroll_employee.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        payroll_employee.user_id IS NOT NULL
        AND payroll_employee.user_id = (SELECT crove_kernel.ctx_user_id())
        AND payroll_employee.erased_at IS NULL
        AND EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = payroll_employee.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role = 'member'
        )
      )
    )
  );
CREATE POLICY hr_employee_insert ON crove_hr.payroll_employee AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_employee.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_employee_update ON crove_hr.payroll_employee AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_employee.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_employee.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_employee_delete ON crove_hr.payroll_employee AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_employee.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- department: replace owner_admin FOR ALL with per-command policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.department;
DROP POLICY IF EXISTS hr_department_select ON crove_hr.department;
DROP POLICY IF EXISTS hr_department_insert ON crove_hr.department;
DROP POLICY IF EXISTS hr_department_update ON crove_hr.department;
DROP POLICY IF EXISTS hr_department_delete ON crove_hr.department;

CREATE POLICY hr_department_select ON crove_hr.department AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = department.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        EXISTS (
          SELECT 1 FROM crove_kernel.tenant_member m
           WHERE m.org_id = department.org_id
             AND m.user_id = (SELECT crove_kernel.ctx_user_id())
             AND m.role = 'member'
        )
        AND (
          department.manager_user_id = (SELECT crove_kernel.ctx_user_id())
          OR crove_hr.is_self_department(department.org_id, department.id)
        )
      )
    )
  );
CREATE POLICY hr_department_insert ON crove_hr.department AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = department.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_department_update ON crove_hr.department AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = department.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = department.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_department_delete ON crove_hr.department AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = department.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- payroll_run: replace owner_admin FOR ALL with per-command policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_run;
DROP POLICY IF EXISTS hr_payroll_run_select ON crove_hr.payroll_run;
DROP POLICY IF EXISTS hr_payroll_run_insert ON crove_hr.payroll_run;
DROP POLICY IF EXISTS hr_payroll_run_update ON crove_hr.payroll_run;
DROP POLICY IF EXISTS hr_payroll_run_delete ON crove_hr.payroll_run;

CREATE POLICY hr_payroll_run_select ON crove_hr.payroll_run AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = payroll_run.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        payroll_run.status IN ('approved', 'paid', 'closed')
        AND crove_hr.has_linked_employee(payroll_run.org_id, payroll_run.legal_entity_id)
      )
    )
  );
CREATE POLICY hr_payroll_run_insert ON crove_hr.payroll_run AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_run.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_payroll_run_update ON crove_hr.payroll_run AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_run.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_run.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_payroll_run_delete ON crove_hr.payroll_run AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_run.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- payroll_line: replace owner_admin FOR ALL with per-command policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_line;
DROP POLICY IF EXISTS hr_payroll_line_select ON crove_hr.payroll_line;
DROP POLICY IF EXISTS hr_payroll_line_insert ON crove_hr.payroll_line;
DROP POLICY IF EXISTS hr_payroll_line_update ON crove_hr.payroll_line;
DROP POLICY IF EXISTS hr_payroll_line_delete ON crove_hr.payroll_line;

CREATE POLICY hr_payroll_line_select ON crove_hr.payroll_line AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = payroll_line.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_run_published(payroll_line.org_id, payroll_line.run_id)
        AND crove_hr.is_self_employee(payroll_line.org_id, payroll_line.employee_id)
      )
    )
  );
CREATE POLICY hr_payroll_line_insert ON crove_hr.payroll_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_line.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_payroll_line_update ON crove_hr.payroll_line AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_line.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_line.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_payroll_line_delete ON crove_hr.payroll_line AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_line.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- payroll_leave_entry: replace owner_admin FOR ALL with per-command policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_leave_entry;
DROP POLICY IF EXISTS hr_leave_entry_select ON crove_hr.payroll_leave_entry;
DROP POLICY IF EXISTS hr_leave_entry_insert ON crove_hr.payroll_leave_entry;
DROP POLICY IF EXISTS hr_leave_entry_update ON crove_hr.payroll_leave_entry;
DROP POLICY IF EXISTS hr_leave_entry_delete ON crove_hr.payroll_leave_entry;

CREATE POLICY hr_leave_entry_select ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = payroll_leave_entry.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR crove_hr.is_self_employee(payroll_leave_entry.org_id, payroll_leave_entry.employee_id)
    )
  );
CREATE POLICY hr_leave_entry_insert ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_leave_entry.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_leave_entry_update ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_leave_entry.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_leave_entry.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
CREATE POLICY hr_leave_entry_delete ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = payroll_leave_entry.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- leave_request: per-command RESTRICTIVE policies
DROP POLICY IF EXISTS owner_admin ON crove_hr.leave_request;
DROP POLICY IF EXISTS hr_leave_request_select ON crove_hr.leave_request;
DROP POLICY IF EXISTS hr_leave_request_insert ON crove_hr.leave_request;
DROP POLICY IF EXISTS hr_leave_request_update ON crove_hr.leave_request;
DROP POLICY IF EXISTS hr_leave_request_delete ON crove_hr.leave_request;

CREATE POLICY hr_leave_request_select ON crove_hr.leave_request AS RESTRICTIVE FOR SELECT TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = leave_request.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
      OR (
        leave_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(leave_request.org_id, leave_request.department_id)
      )
    )
  );

CREATE POLICY hr_leave_request_insert ON crove_hr.leave_request AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = leave_request.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
        AND (
          leave_request.department_id IS NULL
          OR crove_hr.is_self_department(leave_request.org_id, leave_request.department_id)
        )
        AND leave_request.status IN ('pending_l1', 'pending_final')
        AND leave_request.l1_approver_user_id IS NULL
        AND leave_request.l1_acted_at IS NULL
        AND leave_request.final_acted_by IS NULL
        AND leave_request.final_acted_at IS NULL
        AND leave_request.decision_note IS NULL
        AND leave_request.payroll_leave_entry_id IS NULL
        AND (leave_request.created_by IS NULL OR leave_request.created_by = (SELECT crove_kernel.ctx_user_id()))
      )
    )
  );

CREATE POLICY hr_leave_request_update ON crove_hr.leave_request AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = leave_request.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
        AND leave_request.status IN ('pending_l1', 'pending_final')
      )
      OR (
        leave_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(leave_request.org_id, leave_request.department_id)
        AND NOT crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
        AND leave_request.status = 'pending_l1'
      )
    )
  )
  WITH CHECK (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM crove_kernel.tenant_member m
         WHERE m.org_id = leave_request.org_id
           AND m.user_id = (SELECT crove_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
        AND leave_request.status = 'cancelled'
        AND leave_request.final_acted_by IS NULL
        AND leave_request.final_acted_at IS NULL
        AND leave_request.payroll_leave_entry_id IS NULL
      )
      OR (
        leave_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(leave_request.org_id, leave_request.department_id)
        AND NOT crove_hr.is_self_employee(leave_request.org_id, leave_request.employee_id)
        AND leave_request.status IN ('pending_final', 'rejected')
        AND leave_request.l1_approver_user_id = (SELECT crove_kernel.ctx_user_id())
        AND leave_request.l1_acted_at IS NOT NULL
        AND leave_request.final_acted_by IS NULL
        AND leave_request.final_acted_at IS NULL
        AND leave_request.payroll_leave_entry_id IS NULL
      )
    )
  );

CREATE POLICY hr_leave_request_delete ON crove_hr.leave_request AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING (
    (SELECT crove_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM crove_kernel.tenant_member m
       WHERE m.org_id = leave_request.org_id
         AND m.user_id = (SELECT crove_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

