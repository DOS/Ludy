-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 6C (#4528): Contract addendums (Phu luc hop dong) and employee asset handover checklist.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS ludy_hr.contract_addendum (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employment_id uuid NULL,
  addendum_number text NOT NULL,
  effective_on date NOT NULL,
  change_summary text NOT NULL,
  previous_pay_rate numeric(14,2) NULL,
  new_pay_rate numeric(14,2) NULL,
  previous_title text NULL,
  new_title text NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'voided')),
  issued_at timestamptz NULL,
  voided_at timestamptz NULL,
  void_reason text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, legal_entity_id, addendum_number),
  FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  FOREIGN KEY (org_id, employment_id)
    REFERENCES ludy_hr.payroll_employment (org_id, id),
  CHECK (char_length(btrim(addendum_number)) BETWEEN 1 AND 80),
  CHECK (char_length(btrim(change_summary)) BETWEEN 1 AND 2000),
  CHECK (previous_pay_rate IS NULL OR previous_pay_rate >= 0),
  CHECK (new_pay_rate IS NULL OR new_pay_rate >= 0),
  CHECK (previous_title IS NULL OR char_length(btrim(previous_title)) BETWEEN 1 AND 200),
  CHECK (new_title IS NULL OR char_length(btrim(new_title)) BETWEEN 1 AND 200),
  CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 1 AND 500),
  CHECK (
    (status = 'draft' AND issued_at IS NULL AND voided_at IS NULL)
    OR (status = 'issued' AND issued_at IS NOT NULL AND voided_at IS NULL)
    OR (status = 'voided' AND voided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS contract_addendum_emp_idx
  ON ludy_hr.contract_addendum (org_id, employee_id, effective_on DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS contract_addendum_employee_fk_idx
  ON ludy_hr.contract_addendum (org_id, legal_entity_id, employee_id);

CREATE INDEX IF NOT EXISTS contract_addendum_employment_idx
  ON ludy_hr.contract_addendum (org_id, employment_id);

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.contract_addendum;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.contract_addendum
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.contract_addendum ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.contract_addendum_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.addendum_number IS DISTINCT FROM OLD.addendum_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HR_ADDENDUM_IMMUTABLE_COLUMN' USING ERRCODE = 'check_violation';
  END IF;

  -- Allow no-op updated_at sweeps regardless of status so RLS matrix and touch updates behave cleanly.
  IF NEW.effective_on IS NOT DISTINCT FROM OLD.effective_on
     AND NEW.change_summary IS NOT DISTINCT FROM OLD.change_summary
     AND NEW.previous_pay_rate IS NOT DISTINCT FROM OLD.previous_pay_rate
     AND NEW.new_pay_rate IS NOT DISTINCT FROM OLD.new_pay_rate
     AND NEW.previous_title IS NOT DISTINCT FROM OLD.previous_title
     AND NEW.new_title IS NOT DISTINCT FROM OLD.new_title
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
     AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
     AND NEW.void_reason IS NOT DISTINCT FROM OLD.void_reason THEN
    RETURN NEW;
  END IF;

  -- Allow PDPL erasure (hr.payroll.employee.erase) ONLY for exact redaction after employee.erased_at is set.
  IF EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = NEW.org_id
       AND e.id = NEW.employee_id
       AND e.erased_at IS NOT NULL
  ) THEN
    IF NEW.effective_on IS NOT DISTINCT FROM OLD.effective_on
       AND NEW.previous_pay_rate IS NOT DISTINCT FROM OLD.previous_pay_rate
       AND NEW.new_pay_rate IS NOT DISTINCT FROM OLD.new_pay_rate
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
       AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at
       AND NEW.change_summary = '[erased]'
       AND NEW.previous_title IS NULL
       AND NEW.new_title IS NULL
       AND NEW.void_reason IS NULL
       AND (
         OLD.change_summary <> '[erased]'
         OR OLD.previous_title IS NOT NULL
         OR OLD.new_title IS NOT NULL
         OR OLD.void_reason IS NOT NULL
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'HR_ADDENDUM_ERASE_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'HR_ADDENDUM_VOIDED' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status <> 'voided'
       OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
       OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
       OR NEW.previous_pay_rate IS DISTINCT FROM OLD.previous_pay_rate
       OR NEW.new_pay_rate IS DISTINCT FROM OLD.new_pay_rate
       OR NEW.previous_title IS DISTINCT FROM OLD.previous_title
       OR NEW.new_title IS DISTINCT FROM OLD.new_title
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'HR_ADDENDUM_ISSUED_IMMUTABLE' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION ludy_hr.contract_addendum_write_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ludy_hr.contract_addendum_write_guard() TO ludy_tenant;

DROP TRIGGER IF EXISTS z_contract_addendum_write_guard ON ludy_hr.contract_addendum;
CREATE TRIGGER z_contract_addendum_write_guard
  BEFORE UPDATE ON ludy_hr.contract_addendum
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.contract_addendum_write_guard();
ALTER TABLE ludy_hr.contract_addendum ENABLE ALWAYS TRIGGER z_contract_addendum_write_guard;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.contract_addendum');
REVOKE ALL ON TABLE ludy_hr.contract_addendum FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON TABLE ludy_hr.contract_addendum TO ludy_tenant;
GRANT UPDATE (
  effective_on,
  change_summary,
  previous_pay_rate,
  new_pay_rate,
  previous_title,
  new_title,
  status,
  issued_at,
  voided_at,
  void_reason,
  updated_at
) ON TABLE ludy_hr.contract_addendum TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.contract_addendum;
CREATE POLICY le_scope ON ludy_hr.contract_addendum AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_addendum_role ON ludy_hr.contract_addendum;
CREATE POLICY hr_addendum_role ON ludy_hr.contract_addendum AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member tm
       WHERE tm.org_id = contract_addendum.org_id
         AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND tm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member tm
       WHERE tm.org_id = contract_addendum.org_id
         AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND tm.role IN ('owner', 'admin')
    )
  );

CREATE TABLE IF NOT EXISTS ludy_hr.employee_asset_handover (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  asset_code text NOT NULL,
  asset_name text NOT NULL,
  serial_number text NULL,
  handed_over_on date NOT NULL,
  returned_on date NULL,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'returned', 'lost_waived')),
  notes text NULL,
  cleared_by uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CHECK (char_length(btrim(asset_code)) BETWEEN 1 AND 64),
  CHECK (char_length(btrim(asset_name)) BETWEEN 1 AND 200),
  CHECK (serial_number IS NULL OR char_length(btrim(serial_number)) BETWEEN 1 AND 120),
  CHECK (notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 1000),
  CHECK (
    (status = 'assigned' AND returned_on IS NULL AND cleared_by IS NULL)
    OR (status = 'returned' AND returned_on IS NOT NULL AND returned_on >= handed_over_on AND cleared_by IS NOT NULL)
    OR (status = 'lost_waived' AND cleared_by IS NOT NULL AND (returned_on IS NULL OR returned_on >= handed_over_on))
  )
);

CREATE INDEX IF NOT EXISTS employee_asset_handover_emp_idx
  ON ludy_hr.employee_asset_handover (org_id, employee_id, status, handed_over_on DESC);

CREATE INDEX IF NOT EXISTS employee_asset_handover_employee_fk_idx
  ON ludy_hr.employee_asset_handover (org_id, legal_entity_id, employee_id);

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.employee_asset_handover;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.employee_asset_handover
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.employee_asset_handover ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.employee_asset_handover_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.asset_code IS DISTINCT FROM OLD.asset_code
     OR NEW.handed_over_on IS DISTINCT FROM OLD.handed_over_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HR_ASSET_IMMUTABLE_COLUMN' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.asset_name IS NOT DISTINCT FROM OLD.asset_name
     AND NEW.serial_number IS NOT DISTINCT FROM OLD.serial_number
     AND NEW.returned_on IS NOT DISTINCT FROM OLD.returned_on
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.notes IS NOT DISTINCT FROM OLD.notes
     AND NEW.cleared_by IS NOT DISTINCT FROM OLD.cleared_by THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = NEW.org_id
       AND e.id = NEW.employee_id
       AND e.erased_at IS NOT NULL
  ) THEN
    IF NEW.asset_name IS NOT DISTINCT FROM OLD.asset_name
       AND NEW.returned_on IS NOT DISTINCT FROM OLD.returned_on
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.cleared_by IS NOT DISTINCT FROM OLD.cleared_by
       AND NEW.serial_number IS NULL
       AND NEW.notes IS NULL
       AND (OLD.serial_number IS NOT NULL OR OLD.notes IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'HR_ASSET_ERASE_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'assigned' THEN
    RAISE EXCEPTION 'HR_ASSET_ALREADY_CLEARED' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.asset_name IS DISTINCT FROM OLD.asset_name
     OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
     OR NEW.status NOT IN ('returned', 'lost_waived') THEN
    RAISE EXCEPTION 'HR_ASSET_INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION ludy_hr.employee_asset_handover_write_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ludy_hr.employee_asset_handover_write_guard() TO ludy_tenant;

DROP TRIGGER IF EXISTS z_employee_asset_handover_write_guard ON ludy_hr.employee_asset_handover;
CREATE TRIGGER z_employee_asset_handover_write_guard
  BEFORE UPDATE ON ludy_hr.employee_asset_handover
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.employee_asset_handover_write_guard();
ALTER TABLE ludy_hr.employee_asset_handover ENABLE ALWAYS TRIGGER z_employee_asset_handover_write_guard;

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.employee_asset_handover');
REVOKE ALL ON TABLE ludy_hr.employee_asset_handover FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON TABLE ludy_hr.employee_asset_handover TO ludy_tenant;
GRANT UPDATE (
  asset_name,
  serial_number,
  returned_on,
  status,
  notes,
  cleared_by,
  updated_at
) ON TABLE ludy_hr.employee_asset_handover TO ludy_tenant;

DROP POLICY IF EXISTS le_scope ON ludy_hr.employee_asset_handover;
CREATE POLICY le_scope ON ludy_hr.employee_asset_handover AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS hr_asset_select ON ludy_hr.employee_asset_handover;
CREATE POLICY hr_asset_select ON ludy_hr.employee_asset_handover AS RESTRICTIVE FOR SELECT TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND (
      EXISTS (
        SELECT 1
          FROM ludy_kernel.tenant_member tm
         WHERE tm.org_id = employee_asset_handover.org_id
           AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
           AND tm.role IN ('owner', 'admin')
      )
      OR (
        EXISTS (
          SELECT 1
            FROM ludy_kernel.tenant_member tm
           WHERE tm.org_id = employee_asset_handover.org_id
             AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
             AND tm.role = 'member'
        )
        AND ludy_hr.is_self_employee(org_id, employee_id)
      )
    )
  );

DROP POLICY IF EXISTS hr_asset_write_insert ON ludy_hr.employee_asset_handover;
CREATE POLICY hr_asset_write_insert ON ludy_hr.employee_asset_handover AS RESTRICTIVE FOR INSERT TO ludy_tenant
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member tm
       WHERE tm.org_id = employee_asset_handover.org_id
         AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND tm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS hr_asset_write_update ON ludy_hr.employee_asset_handover;
CREATE POLICY hr_asset_write_update ON ludy_hr.employee_asset_handover AS RESTRICTIVE FOR UPDATE TO ludy_tenant
  USING (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member tm
       WHERE tm.org_id = employee_asset_handover.org_id
         AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND tm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    (SELECT ludy_kernel.ctx_actor_type()) = 'user'
    AND EXISTS (
      SELECT 1
        FROM ludy_kernel.tenant_member tm
       WHERE tm.org_id = employee_asset_handover.org_id
         AND tm.user_id = (SELECT ludy_kernel.ctx_user_id())
         AND tm.role IN ('owner', 'admin')
    )
  );
