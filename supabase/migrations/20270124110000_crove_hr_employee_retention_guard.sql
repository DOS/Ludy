-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2691, follow-up N2 from #2689 security review): enforce the 10-year retention window on crove_hr.payroll_employee in PostgreSQL.
-- Refuses setting erased_at before the retention period has passed (ended_on + 10 years in Vietnam UTC+7 calendar day, matching retentionEnds in
-- modules/hr/src/employees.ts) and freezes erased_at, ended_on, and status once erased_at is set.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_hr.employee_retention_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_end_year int;
  v_target_year int;
  v_until date;
  v_vn_day date;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.erased_at IS NOT NULL THEN
    IF NEW.erased_at IS NULL THEN
      RAISE EXCEPTION 'erased employee record cannot clear erased_at' USING ERRCODE = '23514';
    END IF;
    IF NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
      RAISE EXCEPTION 'erased employee record cannot change erased_at' USING ERRCODE = '23514';
    END IF;
    IF NEW.ended_on IS DISTINCT FROM OLD.ended_on THEN
      RAISE EXCEPTION 'erased employee record cannot change ended_on' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'erased employee record cannot change status' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.erased_at IS NOT NULL THEN
    IF NEW.status IS DISTINCT FROM 'ended' OR NEW.ended_on IS NULL THEN
      RAISE EXCEPTION 'employee cannot be erased before employment has ended' USING ERRCODE = '23514';
    END IF;
    v_end_year := extract(year FROM NEW.ended_on)::int;
    v_target_year := v_end_year + 10;
    IF extract(month FROM NEW.ended_on)::int = 2
       AND extract(day FROM NEW.ended_on)::int = 29
       AND NOT ((v_target_year % 4 = 0 AND v_target_year % 100 <> 0) OR (v_target_year % 400 = 0)) THEN
      v_until := pg_catalog.make_date(v_target_year, 3, 1);
    ELSE
      v_until := (NEW.ended_on + interval '10 years')::date;
    END IF;
    v_vn_day := ((NEW.erased_at AT TIME ZONE 'UTC') + interval '7 hours')::date;
    IF v_vn_day <= v_until THEN
      RAISE EXCEPTION 'employee retention period has not passed (ended_on %, retention until %)', NEW.ended_on, v_until USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_hr.employee_retention_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS b_employee_retention ON crove_hr.payroll_employee;
CREATE TRIGGER b_employee_retention BEFORE INSERT OR UPDATE ON crove_hr.payroll_employee
  FOR EACH ROW EXECUTE FUNCTION crove_hr.employee_retention_guard();
