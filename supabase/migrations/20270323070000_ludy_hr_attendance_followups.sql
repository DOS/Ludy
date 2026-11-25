-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR (#4486, #4447/#4463 follow-up):
-- 1. Optional contractual scheduled_hours_per_day on ludy_hr.payroll_employment for VN Labor Code Art. 112 hourly paid holidays.
-- 2. Tighten ludy_hr.attendance_log_update_guard actor checks for erased-employee note clearing and self check-out note preservation.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_hr.payroll_employment
  ADD COLUMN IF NOT EXISTS scheduled_hours_per_day numeric(5, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'ludy_hr.payroll_employment'::regclass
      AND conname = 'payroll_employment_scheduled_hours_per_day_ck'
  ) THEN
    ALTER TABLE ludy_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_scheduled_hours_per_day_ck
      CHECK (
        scheduled_hours_per_day IS NULL
        OR (scheduled_hours_per_day > 0 AND scheduled_hours_per_day <= 24)
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION ludy_hr.attendance_log_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erased boolean;
  v_is_owner boolean := false;
  v_admin boolean := false;
  v_expected_minutes integer;
  v_expected_status text;
BEGIN
  IF ludy_kernel.ctx_actor_type() = 'user'
     AND ludy_kernel.ctx_org_id() IS NOT DISTINCT FROM NEW.org_id THEN
    SELECT
      EXISTS (
        SELECT 1
        FROM ludy_kernel.tenant_member m
        WHERE m.org_id = NEW.org_id
          AND m.user_id = ludy_kernel.ctx_user_id()
          AND m.role = 'owner'
      ),
      EXISTS (
        SELECT 1
        FROM ludy_kernel.tenant_member m
        WHERE m.org_id = NEW.org_id
          AND m.user_id = ludy_kernel.ctx_user_id()
          AND m.role IN ('owner', 'admin')
      )
    INTO v_is_owner, v_admin;
  END IF;

  SELECT e.erased_at IS NOT NULL INTO v_erased
  FROM ludy_hr.payroll_employee e
  WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id;

  -- Allow only an org owner user actor (hr.payroll.employee.erase) to clear free-text notes once retained erasure runs.
  IF COALESCE(v_erased, false) THEN
    IF NEW.note IS NULL
       AND OLD.note IS NOT NULL
       AND NEW.org_id = OLD.org_id
       AND NEW.id = OLD.id
       AND NEW.legal_entity_id = OLD.legal_entity_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.work_date = OLD.work_date
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
       AND NEW.created_at = OLD.created_at
       AND NEW.checked_in_at IS NOT DISTINCT FROM OLD.checked_in_at
       AND NEW.checked_out_at IS NOT DISTINCT FROM OLD.checked_out_at
       AND NEW.check_in_method IS NOT DISTINCT FROM OLD.check_in_method
       AND NEW.worked_minutes IS NOT DISTINCT FROM OLD.worked_minutes
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      IF v_is_owner THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'only org owner erase actor may clear notes of erased employee' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'attendance of erased employee cannot be modified' USING ERRCODE = '23514';
  END IF;

  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user'
     OR ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'user actor required to update attendance_log' USING ERRCODE = '42501';
  END IF;

  IF v_admin THEN
    RETURN NEW;
  END IF;

  -- Non-admin linked employees may only close their own active missing_checkout shift once with exact computed minutes/status.
  IF NOT ludy_hr.is_active_self_employee(NEW.org_id, NEW.employee_id) THEN
    RAISE EXCEPTION 'only HR admin or active owning employee may update attendance_log' USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'missing_checkout' OR OLD.checked_in_at IS NULL OR OLD.checked_out_at IS NOT NULL THEN
    RAISE EXCEPTION 'attendance already checked out or adjusted' USING ERRCODE = '23514';
  END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
     OR NEW.check_in_method IS DISTINCT FROM OLD.check_in_method THEN
    RAISE EXCEPTION 'self checkout cannot alter check-in time or method' USING ERRCODE = '42501';
  END IF;

  IF OLD.note IS NOT NULL AND NEW.note IS NULL THEN
    RAISE EXCEPTION 'self checkout cannot clear existing attendance note' USING ERRCODE = '42501';
  END IF;

  IF NEW.checked_out_at IS NULL
     OR NEW.checked_out_at < OLD.checked_in_at
     OR pg_catalog.abs(pg_catalog.date_part('epoch', NEW.checked_out_at - pg_catalog.now())) > 300 THEN
    RAISE EXCEPTION 'self checkout must set checked_out_at within server window' USING ERRCODE = '23514';
  END IF;

  IF OLD.work_date < ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)
     OR OLD.work_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'self checkout only allowed for today or yesterday shift' USING ERRCODE = '23514';
  END IF;

  v_expected_minutes := LEAST(1440, GREATEST(0, pg_catalog.floor(pg_catalog.date_part('epoch', NEW.checked_out_at - OLD.checked_in_at) / 60)))::integer;
  v_expected_status := CASE WHEN v_expected_minutes >= 360 THEN 'present' ELSE 'half_day' END;

  IF NEW.worked_minutes IS DISTINCT FROM v_expected_minutes
     OR NEW.status IS DISTINCT FROM v_expected_status THEN
    RAISE EXCEPTION 'self checkout worked_minutes and status must match server duration calculation' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_hr.attendance_log_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
