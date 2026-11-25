-- SPDX-License-Identifier: AGPL-3.0-only
-- HR Stage 6B (#4597) non-blocking security and UX follow-ups:
-- 1. Harden NULL ctx_le_scope() checks (IS NOT TRUE instead of IF NOT (...)) across Stage 6B and audited Stage 5 HR helpers.
-- 2. Make ludy_hr.hr_stage6b_payroll_run_locked fail closed (RAISE 42501) on invalid caller context, scope, or role.
-- 3. Add narrow ludy_hr.hr_stage6b_locked_payroll_months helper for proactive self-service locked-month UI hints without granting payroll_run SELECT.
-- 4. Tighten Stage 6B INSERT RLS policies to require created_by IS NOT NULL AND created_by = ctx_user_id() while setting DEFAULT ludy_kernel.ctx_user_id() on created_by.
SET LOCAL lock_timeout = '2s';

-- 1. Stage 6B display-name reader: NULL-safe le_scope and authorization checks (IS NOT TRUE).
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
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
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
  IF (
    '*' = ANY (v_le_scope)
    OR v_le_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF (
      ludy_hr.is_self_employee(v_org, v_emp_id)
      OR (v_dept_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_dept_id))
    ) IS NOT TRUE THEN
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

-- 2. Stage 6B payroll lock reader: fail closed (RAISE 42501) on invalid context, NULL/out-of-scope le_scope, or unauthorized role/entity.
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
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'hr_stage6b_payroll_run_locked: invalid organization, entity, or month context' USING ERRCODE = '42501';
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'hr_stage6b_payroll_run_locked: a user context is required' USING ERRCODE = '42501';
  END IF;
  IF (
    '*' = ANY (v_le_scope)
    OR p_legal_entity_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'hr_stage6b_payroll_run_locked: legal entity outside caller scope' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'hr_stage6b_payroll_run_locked: insufficient role' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'member' THEN
    IF NOT EXISTS (
      SELECT 1 FROM ludy_hr.payroll_employee e
       WHERE e.org_id = v_org
         AND e.legal_entity_id = p_legal_entity_id
         AND e.user_id = v_user
         AND e.erased_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM ludy_hr.department d
       WHERE d.org_id = v_org
         AND d.legal_entity_id = p_legal_entity_id
         AND d.manager_user_id = v_user
         AND d.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'hr_stage6b_payroll_run_locked: caller has no HR scope in legal entity' USING ERRCODE = '42501';
    END IF;
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

-- 3. Narrow locked-month list reader for proactive Stage 6B self-service hints (returns only YYYY-MM strings, never run IDs or amounts).
CREATE OR REPLACE FUNCTION ludy_hr.hr_stage6b_locked_payroll_months(
  p_org_id uuid,
  p_legal_entity_id uuid
)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'hr_stage6b_locked_payroll_months: invalid organization or entity context' USING ERRCODE = '42501';
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RAISE EXCEPTION 'hr_stage6b_locked_payroll_months: a user context is required' USING ERRCODE = '42501';
  END IF;
  IF (
    '*' = ANY (v_le_scope)
    OR p_legal_entity_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'hr_stage6b_locked_payroll_months: legal entity outside caller scope' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'hr_stage6b_locked_payroll_months: insufficient role' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'member' THEN
    IF NOT EXISTS (
      SELECT 1 FROM ludy_hr.payroll_employee e
       WHERE e.org_id = v_org
         AND e.legal_entity_id = p_legal_entity_id
         AND e.user_id = v_user
         AND e.erased_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM ludy_hr.department d
       WHERE d.org_id = v_org
         AND d.legal_entity_id = p_legal_entity_id
         AND d.manager_user_id = v_user
         AND d.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'hr_stage6b_locked_payroll_months: caller has no HR scope in legal entity' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(
    ARRAY(
      SELECT r.month
        FROM ludy_hr.payroll_run r
       WHERE r.org_id = v_org
         AND r.legal_entity_id = p_legal_entity_id
         AND r.status <> 'draft'
       ORDER BY r.month DESC
       LIMIT 120
    ),
    ARRAY[]::text[]
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.hr_stage6b_locked_payroll_months(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.hr_stage6b_locked_payroll_months(uuid, uuid) TO ludy_tenant;

-- 4. Audited Stage 4C / Stage 5 HR helpers with the same IF NOT (... ctx_le_scope() ...) NULL fail-open pattern.
-- Stage 5B overtime_request RLS policies stay untouched for Wave 2 (#4488).
CREATE OR REPLACE FUNCTION ludy_hr.leave_request_employee_name(p_org_id uuid, p_request_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
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
  SELECT lr.employee_id, lr.department_id, lr.legal_entity_id
    INTO v_emp_id, v_dept_id, v_le_id
    FROM ludy_hr.leave_request lr
   WHERE lr.org_id = v_org AND lr.id = p_request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF (
    '*' = ANY (v_le_scope)
    OR v_le_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF (
      ludy_hr.is_self_employee(v_org, v_emp_id)
      OR (v_dept_id IS NOT NULL AND ludy_hr.is_dept_manager(v_org, v_dept_id))
    ) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT e.display_name INTO v_name
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = v_emp_id AND e.erased_at IS NULL;
  RETURN v_name;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.leave_request_employee_name(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.leave_request_employee_name(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.verify_attendance_qr(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_qr_secret_hash text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_matched boolean := false;
BEGIN
  PERFORM pg_catalog.set_config('ludy_hr.qr_verified_hash', '', true);

  IF v_actor IS DISTINCT FROM 'user'
     OR v_user IS NULL
     OR v_org IS NULL
     OR v_org IS DISTINCT FROM p_org_id
     OR p_legal_entity_id IS NULL
     OR p_qr_secret_hash IS NULL THEN
    RETURN false;
  END IF;

  IF (
    '*' = ANY (v_le_scope)
    OR p_legal_entity_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = p_org_id
      AND m.user_id = v_user
      AND m.role <> 'viewer'
  ) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ludy_hr.payroll_employee e
    WHERE e.org_id = p_org_id
      AND e.legal_entity_id = p_legal_entity_id
      AND e.user_id = v_user
      AND e.erased_at IS NULL
      AND e.status = 'active'
  ) THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM ludy_hr.attendance_qr_config c
    WHERE c.org_id = p_org_id
      AND c.legal_entity_id = p_legal_entity_id
      AND c.active
      AND c.qr_secret_hash = p_qr_secret_hash
  ) INTO v_matched;

  IF v_matched THEN
    PERFORM pg_catalog.set_config('ludy_hr.qr_verified_hash', p_qr_secret_hash, true);
  END IF;

  RETURN v_matched;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.verify_attendance_qr(uuid, uuid, text) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.verify_attendance_qr(uuid, uuid, text) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.overtime_request_employee_name(p_org_id uuid, p_request_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
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
  SELECT ot.employee_id, ot.department_id, ot.legal_entity_id
    INTO v_emp_id, v_dept_id, v_le_id
    FROM ludy_hr.overtime_request ot
   WHERE ot.org_id = v_org AND ot.id = p_request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF (
    '*' = ANY (v_le_scope)
    OR v_le_id::text = ANY (v_le_scope)
  ) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF (
      ludy_hr.is_self_employee(v_org, v_emp_id)
      OR (v_dept_id IS NOT NULL AND ludy_hr.is_dept_manager(v_org, v_dept_id))
    ) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT e.display_name INTO v_name
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = v_emp_id AND e.erased_at IS NULL;
  RETURN v_name;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.overtime_request_employee_name(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.overtime_request_employee_name(uuid, uuid) TO ludy_tenant;

-- 5. Stage 6B admin INSERT policy hardening: require created_by IS NOT NULL AND created_by = ctx_user_id()
-- across all three Stage 6B tables so an admin cannot omit or NULL out created_by to evade anti-self-approval.
-- Column DEFAULT ludy_kernel.ctx_user_id() stamps omitted created_by for valid user-context inserts while
-- explicit NULL or spoofed user IDs are rejected with 42501 by the restrictive RLS WITH CHECK policy.
ALTER TABLE ludy_hr.salary_advance_request ALTER COLUMN created_by SET DEFAULT ludy_kernel.ctx_user_id();
ALTER TABLE ludy_hr.payroll_adjustment_item ALTER COLUMN created_by SET DEFAULT ludy_kernel.ctx_user_id();
ALTER TABLE ludy_hr.business_trip_request ALTER COLUMN created_by SET DEFAULT ludy_kernel.ctx_user_id();

DROP POLICY IF EXISTS salary_advance_request_insert ON ludy_hr.salary_advance_request;
CREATE POLICY salary_advance_request_insert ON ludy_hr.salary_advance_request AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND created_by IS NOT NULL
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
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

DROP POLICY IF EXISTS payroll_adjustment_item_insert ON ludy_hr.payroll_adjustment_item;
CREATE POLICY payroll_adjustment_item_insert ON ludy_hr.payroll_adjustment_item AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND created_by IS NOT NULL
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
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

DROP POLICY IF EXISTS business_trip_request_insert ON ludy_hr.business_trip_request;
CREATE POLICY business_trip_request_insert ON ludy_hr.business_trip_request AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND created_by IS NOT NULL
    AND created_by = (SELECT ludy_kernel.ctx_user_id())
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
        AND status = ludy_hr.two_level_request_initial_status(org_id, employee_id, department_id)
        AND l1_approver_user_id IS NULL
        AND l1_acted_at IS NULL
        AND final_acted_by IS NULL
        AND final_acted_at IS NULL
        AND decision_note IS NULL
      )
    )
  );
