-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #4448, Stage 5B): employee self-service onboarding checklist submissions,
-- 2-level overtime (OT) requests with DB anti-self-approval guard, and end-of-probation reviews.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Shared user-context helper: true only when the caller is the sole owner of the org (zero other owners or admins).
CREATE OR REPLACE FUNCTION crove_hr.is_sole_owner_org(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.role = 'owner'
  ) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = v_org AND m.user_id <> v_user AND m.role IN ('owner', 'admin')
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.is_sole_owner_org(uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.is_sole_owner_org(uuid) TO ludy_tenant;

-- 2. Employee self-service onboarding contact / ID / bank confirmation submissions.
CREATE TABLE IF NOT EXISTS crove_hr.onboarding_submission (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  contact_confirmed boolean NOT NULL DEFAULT false,
  id_confirmed boolean NOT NULL DEFAULT false,
  bank_confirmed boolean NOT NULL DEFAULT false,
  handbook_confirmed boolean NOT NULL DEFAULT false,
  address text CHECK (address IS NULL OR pg_catalog.length(address) <= 500),
  birth_date date CHECK (birth_date IS NULL OR birth_date >= '1900-01-01'),
  national_id_sealed text CHECK (national_id_sealed IS NULL OR (pg_catalog.length(national_id_sealed) <= 1000 AND national_id_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  bank_code text CHECK (bank_code IS NULL OR bank_code ~ '^[A-Z0-9]{2,12}$'),
  bank_account_sealed text CHECK (bank_account_sealed IS NULL OR (pg_catalog.length(bank_account_sealed) <= 1000 AND bank_account_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  tax_code_sealed text CHECK (tax_code_sealed IS NULL OR (pg_catalog.length(tax_code_sealed) <= 1000 AND tax_code_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  insurance_number_sealed text CHECK (insurance_number_sealed IS NULL OR (pg_catalog.length(insurance_number_sealed) <= 1000 AND insurance_number_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  note text CHECK (note IS NULL OR pg_catalog.length(note) <= 2000),
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 2000),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT onboarding_submission_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id)
);

CREATE INDEX IF NOT EXISTS onboarding_submission_employee_idx
  ON crove_hr.onboarding_submission (org_id, legal_entity_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_submission_status_idx
  ON crove_hr.onboarding_submission (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_submission_entity_idx
  ON crove_hr.onboarding_submission (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('crove_hr.onboarding_submission');
REVOKE ALL ON crove_hr.onboarding_submission FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.onboarding_submission TO ludy_tenant;
GRANT UPDATE (
  status,
  address,
  birth_date,
  national_id_sealed,
  bank_code,
  bank_account_sealed,
  tax_code_sealed,
  insurance_number_sealed,
  note,
  decision_note,
  reviewed_by,
  reviewed_at,
  updated_at
) ON crove_hr.onboarding_submission TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.onboarding_submission;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.onboarding_submission
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.onboarding_submission ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_hr.onboarding_submission_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Allow hr.payroll.employee.erase to clear submitted PII / sealed values after retention (any status).
  IF NEW.status = OLD.status
     AND NEW.address IS NULL
     AND NEW.birth_date IS NULL
     AND NEW.national_id_sealed IS NULL
     AND NEW.bank_code IS NULL
     AND NEW.bank_account_sealed IS NULL
     AND NEW.tax_code_sealed IS NULL
     AND NEW.insurance_number_sealed IS NULL
     AND NEW.note IS NULL
     AND NEW.decision_note IS NULL
     AND (
       OLD.address IS NOT NULL
       OR OLD.birth_date IS NOT NULL
       OR OLD.national_id_sealed IS NOT NULL
       OR OLD.bank_code IS NOT NULL
       OR OLD.bank_account_sealed IS NOT NULL
       OR OLD.tax_code_sealed IS NOT NULL
       OR OLD.insurance_number_sealed IS NOT NULL
       OR OLD.note IS NOT NULL
       OR OLD.decision_note IS NOT NULL
     )
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
     AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
     AND EXISTS (
       SELECT 1 FROM crove_hr.payroll_employee e
        WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'rejected', 'cancelled') THEN
    IF NEW.status = OLD.status
       AND NEW.address IS NOT DISTINCT FROM OLD.address
       AND NEW.birth_date IS NOT DISTINCT FROM OLD.birth_date
       AND NEW.national_id_sealed IS NOT DISTINCT FROM OLD.national_id_sealed
       AND NEW.bank_code IS NOT DISTINCT FROM OLD.bank_code
       AND NEW.bank_account_sealed IS NOT DISTINCT FROM OLD.bank_account_sealed
       AND NEW.tax_code_sealed IS NOT DISTINCT FROM OLD.tax_code_sealed
       AND NEW.insurance_number_sealed IS NOT DISTINCT FROM OLD.insurance_number_sealed
       AND NEW.note IS NOT DISTINCT FROM OLD.note
       AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
       AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
       AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'onboarding submission % is already %', OLD.id, OLD.status USING ERRCODE = '42501';
  END IF;

  IF NEW.address IS DISTINCT FROM OLD.address
     OR NEW.birth_date IS DISTINCT FROM OLD.birth_date
     OR NEW.national_id_sealed IS DISTINCT FROM OLD.national_id_sealed
     OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
     OR NEW.bank_account_sealed IS DISTINCT FROM OLD.bank_account_sealed
     OR NEW.tax_code_sealed IS DISTINCT FROM OLD.tax_code_sealed
     OR NEW.insurance_number_sealed IS DISTINCT FROM OLD.insurance_number_sealed
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'onboarding submission payload is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.status NOT IN ('pending', 'approved', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'invalid onboarding submission transition % -> %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.reviewed_by IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled onboarding submission cannot carry review fields' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status IN ('approved', 'rejected') THEN
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'onboarding decision requires reviewer stamp' USING ERRCODE = '42501';
    END IF;
    IF crove_hr.is_self_employee(OLD.org_id, OLD.employee_id)
       AND NOT crove_hr.is_sole_owner_org(OLD.org_id) THEN
      RAISE EXCEPTION 'onboarding submission self-approval is forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.onboarding_submission_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS onboarding_submission_update_guard ON crove_hr.onboarding_submission;
CREATE TRIGGER onboarding_submission_update_guard BEFORE UPDATE ON crove_hr.onboarding_submission
  FOR EACH ROW EXECUTE FUNCTION crove_hr.onboarding_submission_update_guard();
ALTER TABLE crove_hr.onboarding_submission ENABLE ALWAYS TRIGGER onboarding_submission_update_guard;

DROP POLICY IF EXISTS le_scope ON crove_hr.onboarding_submission;
CREATE POLICY le_scope ON crove_hr.onboarding_submission AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_onboarding_submission_select ON crove_hr.onboarding_submission;
DROP POLICY IF EXISTS hr_onboarding_submission_insert ON crove_hr.onboarding_submission;
DROP POLICY IF EXISTS hr_onboarding_submission_update ON crove_hr.onboarding_submission;
DROP POLICY IF EXISTS hr_onboarding_submission_delete ON crove_hr.onboarding_submission;

CREATE POLICY hr_onboarding_submission_select ON crove_hr.onboarding_submission AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = onboarding_submission.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR crove_hr.is_self_employee(onboarding_submission.org_id, onboarding_submission.employee_id)
    )
  );

CREATE POLICY hr_onboarding_submission_insert ON crove_hr.onboarding_submission AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = onboarding_submission.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(onboarding_submission.org_id, onboarding_submission.employee_id)
        AND onboarding_submission.status = 'pending'
        AND onboarding_submission.reviewed_by IS NULL
        AND onboarding_submission.reviewed_at IS NULL
        AND onboarding_submission.decision_note IS NULL
        AND (onboarding_submission.created_by IS NULL OR onboarding_submission.created_by = (SELECT ludy_kernel.ctx_user_id()))
      )
    )
  );

CREATE POLICY hr_onboarding_submission_update ON crove_hr.onboarding_submission AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = onboarding_submission.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(onboarding_submission.org_id, onboarding_submission.employee_id)
        AND onboarding_submission.status = 'pending'
      )
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = onboarding_submission.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(onboarding_submission.org_id, onboarding_submission.employee_id)
        AND onboarding_submission.status = 'cancelled'
        AND onboarding_submission.reviewed_by IS NULL
        AND onboarding_submission.reviewed_at IS NULL
        AND onboarding_submission.decision_note IS NULL
      )
    )
  );

CREATE POLICY hr_onboarding_submission_delete ON crove_hr.onboarding_submission AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = onboarding_submission.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- 3. Overtime requests with 2-level L1 -> final approval state machine and DB anti-self-approval guard.
CREATE TABLE IF NOT EXISTS crove_hr.overtime_request (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  department_id uuid,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  work_date date NOT NULL,
  hours numeric(5, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  day_type text NOT NULL CHECK (day_type IN ('weekday', 'weekend', 'holiday')),
  is_night boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending_final' CHECK (status IN ('pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled')),
  l1_approver_user_id uuid,
  l1_acted_at timestamptz,
  final_acted_by uuid,
  final_acted_at timestamptz,
  reason text CHECK (reason IS NULL OR pg_catalog.length(reason) <= 2000),
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 2000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT overtime_request_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT overtime_request_department_fk FOREIGN KEY (org_id, legal_entity_id, department_id)
    REFERENCES crove_hr.department (org_id, legal_entity_id, id)
);

CREATE INDEX IF NOT EXISTS overtime_request_employee_idx
  ON crove_hr.overtime_request (org_id, legal_entity_id, employee_id, month);
CREATE INDEX IF NOT EXISTS overtime_request_department_idx
  ON crove_hr.overtime_request (org_id, legal_entity_id, department_id, status);
CREATE INDEX IF NOT EXISTS overtime_request_entity_idx
  ON crove_hr.overtime_request (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('crove_hr.overtime_request');
REVOKE ALL ON crove_hr.overtime_request FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.overtime_request TO ludy_tenant;
GRANT UPDATE (
  status,
  l1_approver_user_id,
  l1_acted_at,
  final_acted_by,
  final_acted_at,
  reason,
  decision_note,
  updated_at
) ON crove_hr.overtime_request TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.overtime_request;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.overtime_request
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.overtime_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_hr.overtime_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
       SELECT 1 FROM crove_hr.payroll_employee e
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
    IF NEW.status = 'pending_final' AND crove_hr.is_self_employee(OLD.org_id, OLD.employee_id) THEN
      RAISE EXCEPTION 'overtime request L1 self-approval is forbidden' USING ERRCODE = '42501';
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
     AND crove_hr.is_self_employee(OLD.org_id, OLD.employee_id)
     AND NOT crove_hr.is_sole_owner_org(OLD.org_id) THEN
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
REVOKE ALL ON FUNCTION crove_hr.overtime_request_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS overtime_request_update_guard ON crove_hr.overtime_request;
CREATE TRIGGER overtime_request_update_guard BEFORE UPDATE ON crove_hr.overtime_request
  FOR EACH ROW EXECUTE FUNCTION crove_hr.overtime_request_update_guard();
ALTER TABLE crove_hr.overtime_request ENABLE ALWAYS TRIGGER overtime_request_update_guard;

CREATE OR REPLACE FUNCTION crove_hr.overtime_request_employee_name(p_org_id uuid, p_request_id uuid)
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
  SELECT ot.employee_id, ot.department_id, ot.legal_entity_id
    INTO v_emp_id, v_dept_id, v_le_id
    FROM crove_hr.overtime_request ot
   WHERE ot.org_id = v_org AND ot.id = p_request_id;
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
REVOKE ALL ON FUNCTION crove_hr.overtime_request_employee_name(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.overtime_request_employee_name(uuid, uuid) TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON crove_hr.overtime_request;
CREATE POLICY le_scope ON crove_hr.overtime_request AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_overtime_request_select ON crove_hr.overtime_request;
DROP POLICY IF EXISTS hr_overtime_request_insert ON crove_hr.overtime_request;
DROP POLICY IF EXISTS hr_overtime_request_update ON crove_hr.overtime_request;
DROP POLICY IF EXISTS hr_overtime_request_delete ON crove_hr.overtime_request;

CREATE POLICY hr_overtime_request_select ON crove_hr.overtime_request AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = overtime_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
      OR (
        overtime_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(overtime_request.org_id, overtime_request.department_id)
      )
    )
  );

CREATE POLICY hr_overtime_request_insert ON crove_hr.overtime_request AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = overtime_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
        AND (
          overtime_request.department_id IS NULL
          OR crove_hr.is_self_department(overtime_request.org_id, overtime_request.department_id)
        )
        AND overtime_request.status IN ('pending_l1', 'pending_final')
        AND overtime_request.l1_approver_user_id IS NULL
        AND overtime_request.l1_acted_at IS NULL
        AND overtime_request.final_acted_by IS NULL
        AND overtime_request.final_acted_at IS NULL
        AND overtime_request.decision_note IS NULL
        AND (overtime_request.created_by IS NULL OR overtime_request.created_by = (SELECT ludy_kernel.ctx_user_id()))
      )
    )
  );

CREATE POLICY hr_overtime_request_update ON crove_hr.overtime_request AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = overtime_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
        AND overtime_request.status IN ('pending_l1', 'pending_final')
      )
      OR (
        overtime_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(overtime_request.org_id, overtime_request.department_id)
        AND NOT crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
        AND overtime_request.status = 'pending_l1'
      )
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1 FROM ludy_kernel.tenant_member m
         WHERE m.org_id = overtime_request.org_id
           AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND m.role IN ('owner', 'admin')
      )
      OR (
        crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
        AND overtime_request.status = 'cancelled'
        AND overtime_request.final_acted_by IS NULL
        AND overtime_request.final_acted_at IS NULL
      )
      OR (
        overtime_request.department_id IS NOT NULL
        AND crove_hr.is_dept_manager(overtime_request.org_id, overtime_request.department_id)
        AND NOT crove_hr.is_self_employee(overtime_request.org_id, overtime_request.employee_id)
        AND overtime_request.status IN ('pending_final', 'rejected')
        AND overtime_request.l1_approver_user_id = (SELECT ludy_kernel.ctx_user_id())
        AND overtime_request.l1_acted_at IS NOT NULL
        AND overtime_request.final_acted_by IS NULL
        AND overtime_request.final_acted_at IS NULL
      )
    )
  );

CREATE POLICY hr_overtime_request_delete ON crove_hr.overtime_request AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = overtime_request.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

-- 4. End-of-probation review records with deterministic Projects/attendance evidence snapshot and human decision.
CREATE TABLE IF NOT EXISTS crove_hr.probation_review (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  reviewer_user_id uuid,
  probation_end_on date,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  completed_tasks_count integer NOT NULL DEFAULT 0 CHECK (completed_tasks_count >= 0),
  completed_tasks_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(completed_tasks_snapshot) = 'array'),
  projects_available boolean NOT NULL DEFAULT false,
  attendance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(attendance_snapshot) = 'object'),
  decision text NOT NULL CHECK (decision IN ('pass', 'extend', 'terminate')),
  extended_until date,
  review_note text CHECK (review_note IS NULL OR pg_catalog.length(review_note) <= 4000),
  ai_draft_note text CHECK (ai_draft_note IS NULL OR pg_catalog.length(ai_draft_note) <= 4000),
  decided_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT probation_review_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT probation_review_reviewer_fk FOREIGN KEY (org_id, reviewer_user_id)
    REFERENCES ludy_kernel.tenant_member (org_id, user_id)
    ON DELETE SET NULL (reviewer_user_id)
);

CREATE INDEX IF NOT EXISTS probation_review_employee_idx
  ON crove_hr.probation_review (org_id, legal_entity_id, employee_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS probation_review_reviewer_idx
  ON crove_hr.probation_review (org_id, reviewer_user_id);
CREATE INDEX IF NOT EXISTS probation_review_entity_idx
  ON crove_hr.probation_review (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('crove_hr.probation_review');
REVOKE ALL ON crove_hr.probation_review FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.probation_review TO ludy_tenant;
GRANT UPDATE (
  probation_end_on,
  period_start,
  period_end,
  completed_tasks_count,
  completed_tasks_snapshot,
  projects_available,
  attendance_snapshot,
  decision,
  extended_until,
  review_note,
  ai_draft_note,
  decided_at,
  updated_at
) ON crove_hr.probation_review TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.probation_review;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.probation_review
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.probation_review ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_hr.probation_review_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Allow hr.payroll.employee.erase to clear PII snapshots and review notes after retention.
    IF NEW.org_id = OLD.org_id
       AND NEW.legal_entity_id = OLD.legal_entity_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.reviewer_user_id IS NOT DISTINCT FROM OLD.reviewer_user_id
       AND NEW.probation_end_on IS NOT DISTINCT FROM OLD.probation_end_on
       AND NEW.decision = OLD.decision
       AND NEW.period_start = OLD.period_start
       AND NEW.period_end = OLD.period_end
       AND NEW.completed_tasks_count = OLD.completed_tasks_count
       AND NEW.projects_available = OLD.projects_available
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
       AND NEW.extended_until IS NOT DISTINCT FROM OLD.extended_until
       AND NEW.completed_tasks_snapshot = '[]'::jsonb
       AND NEW.attendance_snapshot = '{}'::jsonb
       AND NEW.review_note IS NULL
       AND NEW.ai_draft_note IS NULL
       AND (
         OLD.completed_tasks_snapshot <> '[]'::jsonb
         OR OLD.attendance_snapshot <> '{}'::jsonb
         OR OLD.review_note IS NOT NULL
         OR OLD.ai_draft_note IS NOT NULL
       )
       AND EXISTS (
         SELECT 1 FROM crove_hr.payroll_employee e
          WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id AND e.erased_at IS NOT NULL
       ) THEN
      RETURN NEW;
    END IF;

    -- Allow probation_review_reviewer_fk ON DELETE SET NULL when kernel.member.remove deletes a member.
    IF OLD.reviewer_user_id IS NOT NULL
       AND NEW.reviewer_user_id IS NULL
       AND NEW.org_id = OLD.org_id
       AND NEW.id = OLD.id
       AND NEW.legal_entity_id = OLD.legal_entity_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.probation_end_on IS NOT DISTINCT FROM OLD.probation_end_on
       AND NEW.period_start = OLD.period_start
       AND NEW.period_end = OLD.period_end
       AND NEW.completed_tasks_count = OLD.completed_tasks_count
       AND NEW.completed_tasks_snapshot = OLD.completed_tasks_snapshot
       AND NEW.projects_available = OLD.projects_available
       AND NEW.attendance_snapshot = OLD.attendance_snapshot
       AND NEW.decision = OLD.decision
       AND NEW.extended_until IS NOT DISTINCT FROM OLD.extended_until
       AND NEW.review_note IS NOT DISTINCT FROM OLD.review_note
       AND NEW.ai_draft_note IS NOT DISTINCT FROM OLD.ai_draft_note
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
       AND NEW.created_at = OLD.created_at
       AND NEW.updated_at = OLD.updated_at THEN
      RETURN NEW;
    END IF;

    -- Allow no-op updated_at updates only; all recorded probation review fields are immutable.
    IF NEW.reviewer_user_id IS NOT DISTINCT FROM OLD.reviewer_user_id
       AND NEW.probation_end_on IS NOT DISTINCT FROM OLD.probation_end_on
       AND NEW.period_start = OLD.period_start
       AND NEW.period_end = OLD.period_end
       AND NEW.completed_tasks_count = OLD.completed_tasks_count
       AND NEW.completed_tasks_snapshot = OLD.completed_tasks_snapshot
       AND NEW.projects_available = OLD.projects_available
       AND NEW.attendance_snapshot = OLD.attendance_snapshot
       AND NEW.decision = OLD.decision
       AND NEW.extended_until IS NOT DISTINCT FROM OLD.extended_until
       AND NEW.review_note IS NOT DISTINCT FROM OLD.review_note
       AND NEW.ai_draft_note IS NOT DISTINCT FROM OLD.ai_draft_note
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'probation review % is immutable once recorded', OLD.id USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT'
     AND crove_hr.is_self_employee(NEW.org_id, NEW.employee_id)
     AND NOT crove_hr.is_sole_owner_org(NEW.org_id) THEN
    RAISE EXCEPTION 'cannot conduct probation review for yourself' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.probation_review_write_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS probation_review_write_guard ON crove_hr.probation_review;
CREATE TRIGGER probation_review_write_guard BEFORE INSERT OR UPDATE ON crove_hr.probation_review
  FOR EACH ROW EXECUTE FUNCTION crove_hr.probation_review_write_guard();
ALTER TABLE crove_hr.probation_review ENABLE ALWAYS TRIGGER probation_review_write_guard;

DROP POLICY IF EXISTS le_scope ON crove_hr.probation_review;
CREATE POLICY le_scope ON crove_hr.probation_review AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_probation_review_select ON crove_hr.probation_review;
DROP POLICY IF EXISTS hr_probation_review_insert ON crove_hr.probation_review;
DROP POLICY IF EXISTS hr_probation_review_update ON crove_hr.probation_review;
DROP POLICY IF EXISTS hr_probation_review_delete ON crove_hr.probation_review;

CREATE POLICY hr_probation_review_select ON crove_hr.probation_review AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = probation_review.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY hr_probation_review_insert ON crove_hr.probation_review AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = probation_review.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY hr_probation_review_update ON crove_hr.probation_review AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = probation_review.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = probation_review.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY hr_probation_review_delete ON crove_hr.probation_review AS RESTRICTIVE FOR DELETE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = probation_review.org_id
         AND m.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND m.role IN ('owner', 'admin')
    )
  );
