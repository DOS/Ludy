-- SPDX-License-Identifier: AGPL-3.0-only
-- HR Stage 5B wave 2 follow-ups (#4488):
-- 1. Enforce overtime_request month vs work_date parity in SQL.
-- 2. Add (org_id, employee_id, month) index on overtime_request for cross-entity monthly totals.
-- 3. Limit onboarding_submission to one active pending submission per employee.
-- 4. Enforce org-level strict L1 overtime approval gate in overtime_request_update_guard().

SET LOCAL lock_timeout = '2s';

CREATE INDEX IF NOT EXISTS overtime_request_org_emp_month_idx
  ON ludy_hr.overtime_request (org_id, employee_id, month);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_submission_one_pending_uq
  ON ludy_hr.onboarding_submission (org_id, employee_id)
  WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_hr.overtime_request'::regclass
      AND conname = 'overtime_request_month_work_date_parity_ck'
  ) THEN
    ALTER TABLE ludy_hr.overtime_request
      ADD CONSTRAINT overtime_request_month_work_date_parity_ck
      CHECK (
        pg_catalog.extract('year'::text, work_date)::integer = pg_catalog.substr(month, 1, 4)::integer
        AND pg_catalog.extract('month'::text, work_date)::integer = pg_catalog.substr(month, 6, 2)::integer
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE ludy_hr.overtime_request
  VALIDATE CONSTRAINT overtime_request_month_work_date_parity_ck;

CREATE OR REPLACE FUNCTION ludy_hr.overtime_request_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Allow hr.payroll.employee.erase to clear free-text PII notes after retention (any status).
  IF NEW.status = OLD.status
     AND NEW.reason IS NULL
     AND NEW.decision_note IS NULL
     AND (OLD.reason IS NOT NULL OR OLD.decision_note IS NOT NULL)
     AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
     AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
     AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
     AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
     AND EXISTS (
       SELECT 1 FROM ludy_hr.payroll_employee e
        WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'rejected', 'cancelled') THEN
    IF NEW.status = OLD.status
       AND NEW.l1_approver_user_id IS NOT DISTINCT FROM OLD.l1_approver_user_id
       AND NEW.l1_acted_at IS NOT DISTINCT FROM OLD.l1_acted_at
       AND NEW.final_acted_by IS NOT DISTINCT FROM OLD.final_acted_by
       AND NEW.final_acted_at IS NOT DISTINCT FROM OLD.final_acted_at
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'overtime request % is already %', OLD.id, OLD.status USING ERRCODE = '42501';
  END IF;

  IF NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'overtime request reason is immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'pending_l1' THEN
    IF NEW.status NOT IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'invalid overtime request transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'pending_final' AND ludy_hr.is_self_employee(OLD.org_id, OLD.employee_id) THEN
      RAISE EXCEPTION 'overtime request L1 self-approval is forbidden' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'approved'
       AND EXISTS (
         SELECT 1
         FROM ludy_kernel.tenant t
         WHERE t.org_id = OLD.org_id
           AND t.hr_overtime_require_l1
       ) THEN
      RAISE EXCEPTION 'overtime request L1 approval is required before final approval' USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status = 'pending_final' THEN
    IF NEW.status NOT IN ('pending_final', 'approved', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'invalid overtime request transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at THEN
      RAISE EXCEPTION 'cannot alter L1 approval fields after %', OLD.status USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status IN ('approved', 'rejected')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND ludy_hr.is_self_employee(OLD.org_id, OLD.employee_id)
     AND NOT ludy_hr.is_sole_owner_org(OLD.org_id) THEN
    RAISE EXCEPTION 'overtime request self-approval is forbidden' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.l1_approver_user_id IS DISTINCT FROM OLD.l1_approver_user_id
       OR NEW.l1_acted_at IS DISTINCT FROM OLD.l1_acted_at
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.final_acted_by IS NOT NULL
       OR NEW.final_acted_at IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled overtime request cannot carry approval fields' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_hr.overtime_request_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.lock_active_department_manager(p_org_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_ok integer;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_department_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_kernel.tenant_member m
    WHERE m.org_id = v_org
      AND m.user_id = v_user
      AND m.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN false;
  END IF;
  SELECT 1
    INTO v_ok
  FROM ludy_hr.department d
  WHERE d.org_id = v_org
    AND d.id = p_department_id
    AND d.archived_at IS NULL
    AND d.manager_user_id = v_user
  FOR SHARE;
  RETURN COALESCE(v_ok = 1, false);
END $$;

REVOKE ALL ON FUNCTION ludy_hr.lock_active_department_manager(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.lock_active_department_manager(uuid, uuid) TO ludy_tenant;
