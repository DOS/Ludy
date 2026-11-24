-- SPDX-License-Identifier: AGPL-3.0-only
-- HR Stage 6B (#4527): salary advance requests, retro/offset payroll adjustments, and business trip requests.
-- Every table carries org_id, composite PRIMARY KEY (org_id, id), legal_entity_id with le_scope,
-- apply_tenant_rls, restrictive CRUD policies, column-scoped UPDATE grants, PDPL erasure update paths,
-- atomic active non-archived department L1 authority, and DB anti-self-approval guards.
SET LOCAL lock_timeout = '2s';

-- Active (non-archived) department manager check for L1 approval authority and RLS.
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

-- Server-side initial status resolver for self-submitted 2-level Stage 6B requests.
-- Returns 'pending_l1' when the employee's active department has a non-self active manager; otherwise 'pending_final'.
CREATE OR REPLACE FUNCTION ludy_hr.two_level_request_initial_status(
  p_org_id uuid,
  p_employee_id uuid,
  p_department_id uuid
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_emp_dept_id uuid;
  v_mgr_id uuid;
  v_archived_at timestamptz;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_employee_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN NULL;
  END IF;
  SELECT e.department_id INTO v_emp_dept_id
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = p_employee_id AND e.user_id = v_user AND e.erased_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF p_department_id IS DISTINCT FROM v_emp_dept_id THEN
    RETURN NULL;
  END IF;
  IF p_department_id IS NULL THEN
    RETURN 'pending_final';
  END IF;
  SELECT d.manager_user_id, d.archived_at INTO v_mgr_id, v_archived_at
    FROM ludy_hr.department d
   WHERE d.org_id = v_org AND d.id = p_department_id;
  IF NOT FOUND OR v_archived_at IS NOT NULL OR v_mgr_id IS NULL OR v_mgr_id = v_user THEN
    RETURN 'pending_final';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_mgr_id AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN 'pending_final';
  END IF;
  RETURN 'pending_l1';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.two_level_request_initial_status(uuid, uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.two_level_request_initial_status(uuid, uuid, uuid) TO ludy_tenant;

-- 1. Salary advance requests (2-level approval -> monthly draft payroll advance deduction Cr 141 / Dr 334).
CREATE TABLE IF NOT EXISTS ludy_hr.salary_advance_request (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  department_id uuid,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text CHECK (reason IS NULL OR pg_catalog.length(reason) <= 2000),
  status text NOT NULL DEFAULT 'pending_l1' CHECK (status IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled')),
  l1_approver_user_id uuid,
  l1_acted_at timestamptz,
  final_acted_by uuid,
  final_acted_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 1000),
  payroll_run_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT salary_advance_request_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT salary_advance_request_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT salary_advance_request_department_fk FOREIGN KEY (org_id, department_id) REFERENCES ludy_hr.department (org_id, id) ON DELETE SET NULL,
  CONSTRAINT salary_advance_request_payroll_run_fk FOREIGN KEY (org_id, legal_entity_id, payroll_run_id) REFERENCES ludy_hr.payroll_run (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS salary_advance_request_entity_status_idx
  ON ludy_hr.salary_advance_request (org_id, legal_entity_id, status, month, created_at DESC);
CREATE INDEX IF NOT EXISTS salary_advance_request_employee_month_idx
  ON ludy_hr.salary_advance_request (org_id, legal_entity_id, employee_id, month);
CREATE INDEX IF NOT EXISTS salary_advance_request_dept_status_idx
  ON ludy_hr.salary_advance_request (org_id, department_id, status);
CREATE INDEX IF NOT EXISTS salary_advance_request_run_idx
  ON ludy_hr.salary_advance_request (org_id, legal_entity_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.salary_advance_request;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON ludy_hr.salary_advance_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.salary_advance_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.salary_advance_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_emp_user_id uuid;
  v_emp_erased_at timestamptz;
  v_mgr_id uuid;
  v_dept_archived_at timestamptz;
  v_sole_owner boolean;
  v_is_self_or_creator boolean;
  v_has_active_non_self_mgr boolean := false;
BEGIN
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'salary_advance_request: a user context is required' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;

  -- Allow PDPL erasure to clear free-text PII after employee.erased_at is set.
  IF v_role IN ('owner', 'admin')
     AND NEW.status = OLD.status
     AND NEW.reason IS NULL
     AND NEW.decision_note IS NULL
     AND (OLD.reason IS NOT NULL OR OLD.decision_note IS NOT NULL)
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id
     AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
     AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id
     AND NEW.month IS NOT DISTINCT FROM OLD.month
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
     AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
     AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
     AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
     AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND EXISTS (
       SELECT 1 FROM ludy_hr.payroll_employee e
        WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'salary_advance_request: immutable fields cannot change' USING ERRCODE = '42501';
  END IF;

  -- Terminal states (rejected / cancelled) are frozen except updated_at-only no-ops by owner/admin.
  IF OLD.status IN ('rejected', 'cancelled') THEN
    IF NEW.status = OLD.status
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
       AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'salary_advance_request: terminal request cannot be modified' USING ERRCODE = '42501';
  END IF;

  -- Approved requests are frozen except linking/unlinking payroll_run_id to a draft run by owner/admin.
  IF OLD.status = 'approved' THEN
    IF NEW.status = 'approved'
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
      IF NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
        RETURN NEW;
      END IF;
      IF v_role IN ('owner', 'admin')
         AND (
           OLD.payroll_run_id IS NULL OR EXISTS (
             SELECT 1 FROM ludy_hr.payroll_run r
              WHERE r.org_id = OLD.org_id AND r.legal_entity_id = OLD.legal_entity_id
                AND r.id = OLD.payroll_run_id AND r.status = 'draft'
           )
         )
         AND (
           NEW.payroll_run_id IS NULL OR EXISTS (
             SELECT 1 FROM ludy_hr.payroll_run r
              WHERE r.org_id = OLD.org_id AND r.legal_entity_id = OLD.legal_entity_id
                AND r.id = NEW.payroll_run_id AND r.status = 'draft'
           )
         ) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'salary_advance_request: approved request cannot change status or decision' USING ERRCODE = '42501';
  END IF;

  -- No-op timestamp touch on pending rows (e.g. RLS matrix probe).
  IF NEW.status = OLD.status
     AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
     AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
     AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
     AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
     AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
    RETURN NEW;
  END IF;

  SELECT e.user_id, e.erased_at INTO v_emp_user_id, v_emp_erased_at
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = OLD.employee_id;

  IF v_emp_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'salary_advance_request: erased employee request cannot transition' USING ERRCODE = '42501';
  END IF;

  IF OLD.department_id IS NOT NULL THEN
    SELECT d.manager_user_id, d.archived_at INTO v_mgr_id, v_dept_archived_at
      FROM ludy_hr.department d
     WHERE d.org_id = v_org AND d.id = OLD.department_id;
    IF FOUND
       AND v_dept_archived_at IS NULL
       AND v_mgr_id IS NOT NULL
       AND v_mgr_id IS DISTINCT FROM v_emp_user_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
          WHERE m.org_id = v_org AND m.user_id = v_mgr_id AND m.role IN ('owner', 'admin', 'member')
       ) THEN
      v_has_active_non_self_mgr := true;
    END IF;
  END IF;

  v_sole_owner := ludy_hr.is_sole_owner_org(v_org);
  v_is_self_or_creator := (v_user = v_emp_user_id OR v_user = OLD.created_by);

  IF NEW.payroll_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'salary_advance_request: only approved requests can link payroll_run_id' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF OLD.status NOT IN ('pending_l1', 'pending_final') THEN
      RAISE EXCEPTION 'salary_advance_request: invalid cancel transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at
       OR NEW.final_acted_by IS DISTINCT FROM OLD.final_acted_by
       OR NEW.final_acted_at IS DISTINCT FROM OLD.final_acted_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note THEN
      RAISE EXCEPTION 'salary_advance_request: cancel cannot alter approval fields' USING ERRCODE = '42501';
    END IF;
    IF v_role IN ('owner', 'admin') OR (v_user = v_emp_user_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'salary_advance_request: caller cannot cancel request' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'pending_final' AND OLD.status = 'pending_l1' THEN
    IF NEW.l1_approver_user_id IS DISTINCT FROM v_user
       OR NEW.l1_acted_at IS NULL
       OR NEW.final_acted_by IS NOT NULL
       OR NEW.final_acted_at IS NOT NULL THEN
      RAISE EXCEPTION 'salary_advance_request: invalid L1 transition columns' USING ERRCODE = '42501';
    END IF;
    IF v_is_self_or_creator AND NOT v_sole_owner THEN
      RAISE EXCEPTION 'salary_advance_request: self-approval forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_has_active_non_self_mgr THEN
      IF v_mgr_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'salary_advance_request: only active department manager can L1 approve' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF v_role IN ('owner', 'admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'salary_advance_request: L1 approval requires active department manager or admin fallback' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'approved' THEN
    IF OLD.status <> 'pending_final' THEN
      RAISE EXCEPTION 'salary_advance_request: final approval requires pending_final' USING ERRCODE = '42501';
    END IF;
    IF v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'salary_advance_request: final approval requires owner or admin' USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
      RAISE EXCEPTION 'salary_advance_request: L1 fields cannot change during final approval' USING ERRCODE = '42501';
    END IF;
    IF NEW.final_acted_by IS DISTINCT FROM v_user OR NEW.final_acted_at IS NULL THEN
      RAISE EXCEPTION 'salary_advance_request: final_acted_by must match caller' USING ERRCODE = '42501';
    END IF;
    IF v_is_self_or_creator AND NOT v_sole_owner THEN
      RAISE EXCEPTION 'salary_advance_request: self-approval forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'rejected' THEN
    IF OLD.status NOT IN ('pending_l1', 'pending_final') THEN
      RAISE EXCEPTION 'salary_advance_request: invalid reject transition' USING ERRCODE = '42501';
    END IF;
    IF v_role IN ('owner', 'admin') THEN
      IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
         OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
        RAISE EXCEPTION 'salary_advance_request: reject cannot alter L1 fields' USING ERRCODE = '42501';
      END IF;
      IF NEW.final_acted_by IS DISTINCT FROM v_user OR NEW.final_acted_at IS NULL THEN
        RAISE EXCEPTION 'salary_advance_request: reject final_acted_by must match caller' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'pending_l1' AND v_has_active_non_self_mgr AND v_mgr_id = v_user AND NOT v_is_self_or_creator THEN
      IF NEW.l1_approver_user_id IS DISTINCT FROM v_user
         OR NEW.l1_acted_at IS NULL
         OR NEW.final_acted_by IS NOT NULL
         OR NEW.final_acted_at IS NOT NULL THEN
        RAISE EXCEPTION 'salary_advance_request: L1 reject must stamp l1_approver_user_id' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'salary_advance_request: caller cannot reject request' USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'salary_advance_request: disallowed status transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.salary_advance_request_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS salary_advance_request_update_guard ON ludy_hr.salary_advance_request;
CREATE TRIGGER salary_advance_request_update_guard BEFORE UPDATE ON ludy_hr.salary_advance_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.salary_advance_request_update_guard();
ALTER TABLE ludy_hr.salary_advance_request ENABLE ALWAYS TRIGGER salary_advance_request_update_guard;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.salary_advance_request');
REVOKE DELETE, UPDATE ON ludy_hr.salary_advance_request FROM ludy_tenant;
GRANT UPDATE (
  status,
  l1_approver_user_id,
  l1_acted_at,
  final_acted_by,
  final_acted_at,
  decision_note,
  payroll_run_id,
  reason,
  updated_at
) ON ludy_hr.salary_advance_request TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.salary_advance_request;
CREATE POLICY le_scope ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS salary_advance_request_select ON ludy_hr.salary_advance_request;
CREATE POLICY salary_advance_request_select ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = salary_advance_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  );

DROP POLICY IF EXISTS salary_advance_request_insert ON ludy_hr.salary_advance_request;
CREATE POLICY salary_advance_request_insert ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id()))
    AND (
      (
        EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = salary_advance_request.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
        AND status IN ('pending_l1', 'pending_final')
        AND l1_approver_user_id IS NULL
        AND l1_acted_at IS NULL
        AND final_acted_by IS NULL
        AND final_acted_at IS NULL
        AND payroll_run_id IS NULL
      )
      OR (
        ludy_hr.is_self_employee(org_id, employee_id)
        AND created_by = (SELECT ludy_kernel.ctx_user_id())
        AND status = ludy_hr.two_level_request_initial_status(org_id, employee_id, department_id)
        AND l1_approver_user_id IS NULL
        AND l1_acted_at IS NULL
        AND final_acted_by IS NULL
        AND final_acted_at IS NULL
        AND decision_note IS NULL
        AND payroll_run_id IS NULL
      )
    )
  );

DROP POLICY IF EXISTS salary_advance_request_update ON ludy_hr.salary_advance_request;
CREATE POLICY salary_advance_request_update ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = salary_advance_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = salary_advance_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  );

DROP POLICY IF EXISTS salary_advance_request_delete ON ludy_hr.salary_advance_request;
CREATE POLICY salary_advance_request_delete ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (false);

-- 2. Payroll adjustment items: retro_pay (truy linh -> taxable gross addition) & offset_deduction (bu tru -> net deduction Cr 3388 / Dr 334).
CREATE TABLE IF NOT EXISTS ludy_hr.payroll_adjustment_item (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('retro_pay', 'offset_deduction')),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text CHECK (reason IS NULL OR pg_catalog.length(reason) <= 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 1000),
  payroll_run_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_adjustment_item_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT payroll_adjustment_item_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT payroll_adjustment_item_payroll_run_fk FOREIGN KEY (org_id, legal_entity_id, payroll_run_id) REFERENCES ludy_hr.payroll_run (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_adjustment_item_entity_month_idx
  ON ludy_hr.payroll_adjustment_item (org_id, legal_entity_id, month, status, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_adjustment_item_employee_month_idx
  ON ludy_hr.payroll_adjustment_item (org_id, legal_entity_id, employee_id, month);
CREATE INDEX IF NOT EXISTS payroll_adjustment_item_run_idx
  ON ludy_hr.payroll_adjustment_item (org_id, legal_entity_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.payroll_adjustment_item;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON ludy_hr.payroll_adjustment_item
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.payroll_adjustment_item ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.payroll_adjustment_item_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_emp_user_id uuid;
  v_emp_erased_at timestamptz;
  v_sole_owner boolean;
BEGIN
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'payroll_adjustment_item: a user context is required' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'payroll_adjustment_item: owner or admin required' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status
     AND NEW.reason IS NULL
     AND NEW.decision_note IS NULL
     AND (OLD.reason IS NOT NULL OR OLD.decision_note IS NOT NULL)
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id
     AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
     AND NEW.month IS NOT DISTINCT FROM OLD.month
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
     AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND EXISTS (
       SELECT 1 FROM ludy_hr.payroll_employee e
        WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payroll_adjustment_item: immutable fields cannot change' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('rejected', 'cancelled') THEN
    IF NEW.status = OLD.status
       AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
       AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
       AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payroll_adjustment_item: terminal item cannot be modified' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'approved' THEN
    IF NEW.status = 'approved'
       AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
       AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
      IF NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
        RETURN NEW;
      END IF;
      IF v_role IN ('owner', 'admin')
         AND (
           OLD.payroll_run_id IS NULL OR EXISTS (
             SELECT 1 FROM ludy_hr.payroll_run r
              WHERE r.org_id = OLD.org_id AND r.legal_entity_id = OLD.legal_entity_id
                AND r.id = OLD.payroll_run_id AND r.status = 'draft'
           )
         )
         AND (
           NEW.payroll_run_id IS NULL OR EXISTS (
             SELECT 1 FROM ludy_hr.payroll_run r
              WHERE r.org_id = OLD.org_id AND r.legal_entity_id = OLD.legal_entity_id
                AND r.id = NEW.payroll_run_id AND r.status = 'draft'
           )
         ) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'payroll_adjustment_item: approved item cannot change decision' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
     AND NEW.payroll_run_id IS NOT DISTINCT FROM OLD.payroll_run_id THEN
    RETURN NEW;
  END IF;

  SELECT e.user_id, e.erased_at INTO v_emp_user_id, v_emp_erased_at
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = OLD.employee_id;
  IF v_emp_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_adjustment_item: erased employee item cannot transition' USING ERRCODE = '42501';
  END IF;

  v_sole_owner := ludy_hr.is_sole_owner_org(v_org);

  IF NEW.payroll_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_adjustment_item: only approved items can link payroll_run_id' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'approved' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'payroll_adjustment_item: approval requires pending' USING ERRCODE = '42501';
    END IF;
    IF NEW.reviewed_by IS DISTINCT FROM v_user OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'payroll_adjustment_item: reviewed_by must match caller' USING ERRCODE = '42501';
    END IF;
    IF (v_user = v_emp_user_id OR v_user = OLD.created_by) AND NOT v_sole_owner THEN
      RAISE EXCEPTION 'payroll_adjustment_item: self-approval forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'rejected' THEN
    IF OLD.status <> 'pending' OR NEW.reviewed_by IS DISTINCT FROM v_user OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'payroll_adjustment_item: invalid reject transition' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'payroll_adjustment_item: invalid cancel transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note THEN
      RAISE EXCEPTION 'payroll_adjustment_item: cancel cannot alter approval fields' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'payroll_adjustment_item: disallowed status transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.payroll_adjustment_item_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS payroll_adjustment_item_update_guard ON ludy_hr.payroll_adjustment_item;
CREATE TRIGGER payroll_adjustment_item_update_guard BEFORE UPDATE ON ludy_hr.payroll_adjustment_item
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.payroll_adjustment_item_update_guard();
ALTER TABLE ludy_hr.payroll_adjustment_item ENABLE ALWAYS TRIGGER payroll_adjustment_item_update_guard;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.payroll_adjustment_item');
REVOKE DELETE, UPDATE ON ludy_hr.payroll_adjustment_item FROM ludy_tenant;
GRANT UPDATE (
  status,
  reviewed_by,
  reviewed_at,
  decision_note,
  payroll_run_id,
  reason,
  updated_at
) ON ludy_hr.payroll_adjustment_item TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.payroll_adjustment_item;
CREATE POLICY le_scope ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS payroll_adjustment_item_select ON ludy_hr.payroll_adjustment_item;
CREATE POLICY payroll_adjustment_item_select ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = payroll_adjustment_item.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS payroll_adjustment_item_insert ON ludy_hr.payroll_adjustment_item;
CREATE POLICY payroll_adjustment_item_insert ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id()))
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = payroll_adjustment_item.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
    AND status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND payroll_run_id IS NULL
  );

DROP POLICY IF EXISTS payroll_adjustment_item_update ON ludy_hr.payroll_adjustment_item;
CREATE POLICY payroll_adjustment_item_update ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = payroll_adjustment_item.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = payroll_adjustment_item.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS payroll_adjustment_item_delete ON ludy_hr.payroll_adjustment_item;
CREATE POLICY payroll_adjustment_item_delete ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (false);

-- 3. Business trip requests (2-level approval with L1 active dept manager + final owner/admin approval).
CREATE TABLE IF NOT EXISTS ludy_hr.business_trip_request (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  department_id uuid,
  destination text CHECK (destination IS NULL OR pg_catalog.length(destination) <= 200),
  purpose text CHECK (purpose IS NULL OR pg_catalog.length(purpose) <= 2000),
  start_on date NOT NULL,
  end_on date NOT NULL,
  estimated_allowance numeric(14, 2) NOT NULL DEFAULT 0 CHECK (estimated_allowance >= 0),
  status text NOT NULL DEFAULT 'pending_l1' CHECK (status IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled')),
  l1_approver_user_id uuid,
  l1_acted_at timestamptz,
  final_acted_by uuid,
  final_acted_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT business_trip_request_dates_ck CHECK (end_on >= start_on),
  CONSTRAINT business_trip_request_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT business_trip_request_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT business_trip_request_department_fk FOREIGN KEY (org_id, department_id) REFERENCES ludy_hr.department (org_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS business_trip_request_entity_status_idx
  ON ludy_hr.business_trip_request (org_id, legal_entity_id, status, start_on DESC);
CREATE INDEX IF NOT EXISTS business_trip_request_employee_idx
  ON ludy_hr.business_trip_request (org_id, legal_entity_id, employee_id, start_on DESC);
CREATE INDEX IF NOT EXISTS business_trip_request_dept_status_idx
  ON ludy_hr.business_trip_request (org_id, department_id, status);

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.business_trip_request;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON ludy_hr.business_trip_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.business_trip_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.business_trip_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_role text;
  v_emp_user_id uuid;
  v_emp_erased_at timestamptz;
  v_mgr_id uuid;
  v_dept_archived_at timestamptz;
  v_sole_owner boolean;
  v_is_self_or_creator boolean;
  v_has_active_non_self_mgr boolean := false;
BEGIN
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL OR v_org IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'business_trip_request: a user context is required' USING ERRCODE = '42501';
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;

  IF v_role IN ('owner', 'admin')
     AND NEW.status = OLD.status
     AND NEW.destination IS NULL
     AND NEW.purpose IS NULL
     AND NEW.decision_note IS NULL
     AND (OLD.destination IS NOT NULL OR OLD.purpose IS NOT NULL OR OLD.decision_note IS NOT NULL)
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id
     AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id
     AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id
     AND NEW.start_on IS NOT DISTINCT FROM OLD.start_on
     AND NEW.end_on IS NOT DISTINCT FROM OLD.end_on
     AND NEW.estimated_allowance IS NOT DISTINCT FROM OLD.estimated_allowance
     AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
     AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
     AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
     AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND EXISTS (
       SELECT 1 FROM ludy_hr.payroll_employee e
        WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.destination IS DISTINCT FROM OLD.destination
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.start_on IS DISTINCT FROM OLD.start_on
     OR NEW.end_on IS DISTINCT FROM OLD.end_on
     OR NEW.estimated_allowance IS DISTINCT FROM OLD.estimated_allowance
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'business_trip_request: immutable fields cannot change' USING ERRCODE = '42501';
  END IF;

  IF OLD.status IN ('approved', 'rejected', 'cancelled') THEN
    IF NEW.status = OLD.status
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.destination IS NOT DISTINCT FROM OLD.destination
       AND NEW.purpose IS NOT DISTINCT FROM OLD.purpose
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'business_trip_request: terminal request cannot be modified' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status
     AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
     AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
     AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
     AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
     AND NEW.destination IS NOT DISTINCT FROM OLD.destination
     AND NEW.purpose IS NOT DISTINCT FROM OLD.purpose
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
    RETURN NEW;
  END IF;

  SELECT e.user_id, e.erased_at INTO v_emp_user_id, v_emp_erased_at
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = OLD.employee_id;

  IF v_emp_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'business_trip_request: erased employee request cannot transition' USING ERRCODE = '42501';
  END IF;

  IF OLD.department_id IS NOT NULL THEN
    SELECT d.manager_user_id, d.archived_at INTO v_mgr_id, v_dept_archived_at
      FROM ludy_hr.department d
     WHERE d.org_id = v_org AND d.id = OLD.department_id;
    IF FOUND
       AND v_dept_archived_at IS NULL
       AND v_mgr_id IS NOT NULL
       AND v_mgr_id IS DISTINCT FROM v_emp_user_id
       AND EXISTS (
         SELECT 1 FROM ludy_kernel.tenant_member m
          WHERE m.org_id = v_org AND m.user_id = v_mgr_id AND m.role IN ('owner', 'admin', 'member')
       ) THEN
      v_has_active_non_self_mgr := true;
    END IF;
  END IF;

  v_sole_owner := ludy_hr.is_sole_owner_org(v_org);
  v_is_self_or_creator := (v_user = v_emp_user_id OR v_user = OLD.created_by);

  IF NEW.status = 'cancelled' THEN
    IF OLD.status NOT IN ('pending_l1', 'pending_final') THEN
      RAISE EXCEPTION 'business_trip_request: invalid cancel transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at
       OR NEW.final_acted_by IS DISTINCT FROM OLD.final_acted_by
       OR NEW.final_acted_at IS DISTINCT FROM OLD.final_acted_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note THEN
      RAISE EXCEPTION 'business_trip_request: cancel cannot alter approval fields' USING ERRCODE = '42501';
    END IF;
    IF v_role IN ('owner', 'admin') OR (v_user = v_emp_user_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'business_trip_request: caller cannot cancel request' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'pending_final' AND OLD.status = 'pending_l1' THEN
    IF NEW.l1_approver_user_id IS DISTINCT FROM v_user
       OR NEW.l1_acted_at IS NULL
       OR NEW.final_acted_by IS NOT NULL
       OR NEW.final_acted_at IS NOT NULL THEN
      RAISE EXCEPTION 'business_trip_request: invalid L1 transition columns' USING ERRCODE = '42501';
    END IF;
    IF v_is_self_or_creator AND NOT v_sole_owner THEN
      RAISE EXCEPTION 'business_trip_request: self-approval forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_has_active_non_self_mgr THEN
      IF v_mgr_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'business_trip_request: only active department manager can L1 approve' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF v_role IN ('owner', 'admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'business_trip_request: L1 approval requires active department manager or admin fallback' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'approved' THEN
    IF OLD.status <> 'pending_final' THEN
      RAISE EXCEPTION 'business_trip_request: final approval requires pending_final' USING ERRCODE = '42501';
    END IF;
    IF v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'business_trip_request: final approval requires owner or admin' USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
      RAISE EXCEPTION 'business_trip_request: L1 fields cannot change during final approval' USING ERRCODE = '42501';
    END IF;
    IF NEW.final_acted_by IS DISTINCT FROM v_user OR NEW.final_acted_at IS NULL THEN
      RAISE EXCEPTION 'business_trip_request: final_acted_by must match caller' USING ERRCODE = '42501';
    END IF;
    IF v_is_self_or_creator AND NOT v_sole_owner THEN
      RAISE EXCEPTION 'business_trip_request: self-approval forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'rejected' THEN
    IF OLD.status NOT IN ('pending_l1', 'pending_final') THEN
      RAISE EXCEPTION 'business_trip_request: invalid reject transition' USING ERRCODE = '42501';
    END IF;
    IF v_role IN ('owner', 'admin') THEN
      IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
         OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
        RAISE EXCEPTION 'business_trip_request: reject cannot alter L1 fields' USING ERRCODE = '42501';
      END IF;
      IF NEW.final_acted_by IS DISTINCT FROM v_user OR NEW.final_acted_at IS NULL THEN
        RAISE EXCEPTION 'business_trip_request: reject final_acted_by must match caller' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'pending_l1' AND v_has_active_non_self_mgr AND v_mgr_id = v_user AND NOT v_is_self_or_creator THEN
      IF NEW.l1_approver_user_id IS DISTINCT FROM v_user
         OR NEW.l1_acted_at IS NULL
         OR NEW.final_acted_by IS NOT NULL
         OR NEW.final_acted_at IS NOT NULL THEN
        RAISE EXCEPTION 'business_trip_request: L1 reject must stamp l1_approver_user_id' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'business_trip_request: caller cannot reject request' USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'business_trip_request: disallowed status transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.business_trip_request_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS business_trip_request_update_guard ON ludy_hr.business_trip_request;
CREATE TRIGGER business_trip_request_update_guard BEFORE UPDATE ON ludy_hr.business_trip_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.business_trip_request_update_guard();
ALTER TABLE ludy_hr.business_trip_request ENABLE ALWAYS TRIGGER business_trip_request_update_guard;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.business_trip_request');
REVOKE DELETE, UPDATE ON ludy_hr.business_trip_request FROM ludy_tenant;
GRANT UPDATE (
  status,
  l1_approver_user_id,
  l1_acted_at,
  final_acted_by,
  final_acted_at,
  decision_note,
  destination,
  purpose,
  updated_at
) ON ludy_hr.business_trip_request TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.business_trip_request;
CREATE POLICY le_scope ON ludy_hr.business_trip_request AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS business_trip_request_select ON ludy_hr.business_trip_request;
CREATE POLICY business_trip_request_select ON ludy_hr.business_trip_request AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = business_trip_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  );

DROP POLICY IF EXISTS business_trip_request_insert ON ludy_hr.business_trip_request;
CREATE POLICY business_trip_request_insert ON ludy_hr.business_trip_request AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id()))
    AND (
      (
        EXISTS (
          SELECT 1 FROM ludy_kernel.tenant_member m
           WHERE m.org_id = business_trip_request.org_id
             AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND m.role IN ('owner', 'admin')
        )
        AND status IN ('pending_l1', 'pending_final')
        AND l1_approver_user_id IS NULL
        AND l1_acted_at IS NULL
        AND final_acted_by IS NULL
        AND final_acted_at IS NULL
      )
      OR (
        ludy_hr.is_self_employee(org_id, employee_id)
        AND created_by = (SELECT ludy_kernel.ctx_user_id())
        AND status = ludy_hr.two_level_request_initial_status(org_id, employee_id, department_id)
        AND l1_approver_user_id IS NULL
        AND l1_acted_at IS NULL
        AND final_acted_by IS NULL
        AND final_acted_at IS NULL
        AND decision_note IS NULL
      )
    )
  );

DROP POLICY IF EXISTS business_trip_request_update ON ludy_hr.business_trip_request;
CREATE POLICY business_trip_request_update ON ludy_hr.business_trip_request AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = business_trip_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = business_trip_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR ludy_hr.is_self_employee(org_id, employee_id)
      OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(org_id, department_id))
    )
  );

DROP POLICY IF EXISTS business_trip_request_delete ON ludy_hr.business_trip_request;
CREATE POLICY business_trip_request_delete ON ludy_hr.business_trip_request AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (false);

-- Display-name reader for Stage 6B requests (scoped strictly to owner/admin, self, or active dept manager).
CREATE OR REPLACE FUNCTION ludy_hr.hr_stage6b_request_employee_name(
  p_org_id uuid,
  p_request_kind text,
  p_request_id uuid
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
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
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN NULL;
  END IF;
  IF p_request_kind = 'salary_advance' THEN
    SELECT r.employee_id, r.department_id, r.legal_entity_id
      INTO v_emp_id, v_dept_id, v_le_id
      FROM ludy_hr.salary_advance_request r
     WHERE r.org_id = v_org AND r.id = p_request_id;
  ELSIF p_request_kind = 'business_trip' THEN
    SELECT r.employee_id, r.department_id, r.legal_entity_id
      INTO v_emp_id, v_dept_id, v_le_id
      FROM ludy_hr.business_trip_request r
     WHERE r.org_id = v_org AND r.id = p_request_id;
  ELSE
    RETURN NULL;
  END IF;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT (
    '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
    OR v_le_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
  ) THEN
    RETURN NULL;
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF NOT (
      ludy_hr.is_self_employee(v_org, v_emp_id)
      OR (v_dept_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_dept_id))
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT e.display_name INTO v_name
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = v_emp_id AND e.erased_at IS NULL;
  RETURN v_name;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.hr_stage6b_request_employee_name(uuid, text, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.hr_stage6b_request_employee_name(uuid, text, uuid) TO ludy_tenant;

-- Narrow non-draft payroll lock reader for Stage 6B commands (returns only a boolean so
-- non-linked department managers without payroll_run SELECT access still hit HR_RUN_NOT_DRAFT).
CREATE OR REPLACE FUNCTION ludy_hr.hr_stage6b_payroll_run_locked(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_month text
)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL OR p_month IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (
    '*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
    OR p_legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[])
  ) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM ludy_hr.payroll_run r
     WHERE r.org_id = v_org
       AND r.legal_entity_id = p_legal_entity_id
       AND r.month = p_month
       AND r.status <> 'draft'
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.hr_stage6b_payroll_run_locked(uuid, uuid, text) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.hr_stage6b_payroll_run_locked(uuid, uuid, text) TO ludy_tenant;

-- Insert guard running AFTER INSERT (so RLS WITH CHECK enforces tenant/actor isolation first):
-- block erased-employee inserts and cross-entity department links across Stage 6B tables.
CREATE OR REPLACE FUNCTION ludy_hr.stage6b_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row jsonb := pg_catalog.to_jsonb(NEW);
  v_emp_id uuid := (v_row ->> 'employee_id')::uuid;
  v_dept_id uuid := NULLIF(v_row ->> 'department_id', '')::uuid;
  v_erased_at timestamptz;
  v_dept_le uuid;
BEGIN
  SELECT e.erased_at INTO v_erased_at
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = NEW.org_id AND e.id = v_emp_id;
  IF NOT FOUND OR v_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'stage6b_insert_guard: employee missing or erased' USING ERRCODE = '42501';
  END IF;
  IF v_dept_id IS NOT NULL THEN
    SELECT d.legal_entity_id INTO v_dept_le
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = v_dept_id;
    IF NOT FOUND OR v_dept_le IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'stage6b_insert_guard: department entity mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.stage6b_insert_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS c_stage6b_insert_guard ON ludy_hr.salary_advance_request;
CREATE TRIGGER c_stage6b_insert_guard AFTER INSERT ON ludy_hr.salary_advance_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.stage6b_insert_guard();
ALTER TABLE ludy_hr.salary_advance_request ENABLE ALWAYS TRIGGER c_stage6b_insert_guard;

DROP TRIGGER IF EXISTS c_stage6b_insert_guard ON ludy_hr.payroll_adjustment_item;
CREATE TRIGGER c_stage6b_insert_guard AFTER INSERT ON ludy_hr.payroll_adjustment_item
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.stage6b_insert_guard();
ALTER TABLE ludy_hr.payroll_adjustment_item ENABLE ALWAYS TRIGGER c_stage6b_insert_guard;

DROP TRIGGER IF EXISTS c_stage6b_insert_guard ON ludy_hr.business_trip_request;
CREATE TRIGGER c_stage6b_insert_guard AFTER INSERT ON ludy_hr.business_trip_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.stage6b_insert_guard();
ALTER TABLE ludy_hr.business_trip_request ENABLE ALWAYS TRIGGER c_stage6b_insert_guard;
