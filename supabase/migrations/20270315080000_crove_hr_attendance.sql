-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #4447, Stage 5C): Web/PWA 1-click attendance check-in/out, office QR stamp,
-- and monthly attendance rollup to payroll. Zero biometric, FaceID, or photo data stored (PDPL 91/2025/QH15).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_hr.attendance_log (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  check_in_method text NOT NULL DEFAULT 'web' CHECK (check_in_method IN ('web', 'qr', 'manual')),
  worked_minutes integer CHECK (worked_minutes IS NULL OR (worked_minutes >= 0 AND worked_minutes <= 1440)),
  status text NOT NULL DEFAULT 'missing_checkout' CHECK (status IN ('present', 'half_day', 'missing_checkout', 'adjusted')),
  note text CHECK (note IS NULL OR pg_catalog.length(pg_catalog.btrim(note)) BETWEEN 1 AND 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT attendance_log_employee_date_uq UNIQUE (org_id, employee_id, work_date),
  CONSTRAINT attendance_log_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT attendance_log_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id)
    REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT attendance_log_checkout_after_checkin_ck CHECK (
    checked_out_at IS NULL OR checked_in_at IS NULL OR checked_out_at >= checked_in_at
  ),
  CONSTRAINT attendance_log_checkin_required_ck CHECK (checked_in_at IS NOT NULL OR status = 'adjusted')
);

CREATE INDEX IF NOT EXISTS attendance_log_entity_emp_date_idx
  ON crove_hr.attendance_log (org_id, legal_entity_id, employee_id, work_date DESC);

CREATE INDEX IF NOT EXISTS attendance_log_entity_date_idx
  ON crove_hr.attendance_log (org_id, legal_entity_id, work_date DESC);

CREATE INDEX IF NOT EXISTS attendance_log_entity_org_idx
  ON crove_hr.attendance_log (legal_entity_id, org_id);

SELECT crove_kernel.apply_tenant_rls('crove_hr.attendance_log');
REVOKE ALL ON crove_hr.attendance_log FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.attendance_log TO crove_tenant;
GRANT UPDATE (checked_in_at, checked_out_at, check_in_method, worked_minutes, status, note, updated_at)
  ON crove_hr.attendance_log TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.attendance_log;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON crove_hr.attendance_log
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.attendance_log ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION crove_hr.attendance_log_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erased boolean;
  v_admin boolean;
BEGIN
  SELECT e.erased_at IS NOT NULL INTO v_erased
  FROM crove_hr.payroll_employee e
  WHERE e.org_id = NEW.org_id AND e.id = NEW.employee_id;

  -- Allow hr.payroll.employee.erase to clear free-text notes once retained erasure runs.
  IF COALESCE(v_erased, false) THEN
    IF NEW.note IS NULL
       AND OLD.note IS NOT NULL
       AND NEW.checked_in_at IS NOT DISTINCT FROM OLD.checked_in_at
       AND NEW.checked_out_at IS NOT DISTINCT FROM OLD.checked_out_at
       AND NEW.check_in_method IS NOT DISTINCT FROM OLD.check_in_method
       AND NEW.worked_minutes IS NOT DISTINCT FROM OLD.worked_minutes
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'attendance of erased employee cannot be modified' USING ERRCODE = '23514';
  END IF;

  IF crove_kernel.ctx_actor_type() <> 'user' THEN
    RAISE EXCEPTION 'user actor required to update attendance_log' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = NEW.org_id
      AND m.user_id = crove_kernel.ctx_user_id()
      AND m.role IN ('owner', 'admin')
  ) INTO v_admin;

  IF v_admin THEN
    RETURN NEW;
  END IF;

  -- Non-admin linked employees may only check out their own open day once (never overwrite an adjusted or checked-out log).
  IF NOT crove_hr.is_self_employee(NEW.org_id, NEW.employee_id) THEN
    RAISE EXCEPTION 'only HR admin or owning employee may update attendance_log' USING ERRCODE = '42501';
  END IF;

  IF OLD.checked_out_at IS NOT NULL OR OLD.status = 'adjusted' THEN
    RAISE EXCEPTION 'attendance already checked out or adjusted' USING ERRCODE = '23514';
  END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at
     OR NEW.check_in_method IS DISTINCT FROM OLD.check_in_method THEN
    RAISE EXCEPTION 'self checkout cannot alter check-in time or method' USING ERRCODE = '42501';
  END IF;

  IF NEW.checked_out_at IS NULL OR NEW.status NOT IN ('present', 'half_day') THEN
    RAISE EXCEPTION 'self checkout must set checked_out_at and present/half_day status' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.attendance_log_update_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS attendance_log_update_guard ON crove_hr.attendance_log;
CREATE TRIGGER attendance_log_update_guard
  BEFORE UPDATE ON crove_hr.attendance_log
  FOR EACH ROW EXECUTE FUNCTION crove_hr.attendance_log_update_guard();
ALTER TABLE crove_hr.attendance_log ENABLE ALWAYS TRIGGER attendance_log_update_guard;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON crove_hr.attendance_log';
  EXECUTE
    'CREATE POLICY le_scope ON crove_hr.attendance_log AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
    'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))';

  EXECUTE 'DROP POLICY IF EXISTS hr_attendance_log_select ON crove_hr.attendance_log';
  EXECUTE
    'CREATE POLICY hr_attendance_log_select ON crove_hr.attendance_log AS RESTRICTIVE FOR SELECT TO crove_tenant '
    'USING ('
    '  (SELECT crove_kernel.ctx_actor_type()) = ''user'' '
    '  AND EXISTS ('
    '    SELECT 1 FROM crove_kernel.tenant_member m '
    '    WHERE m.org_id = attendance_log.org_id '
    '      AND m.user_id = (SELECT crove_kernel.ctx_user_id()) '
    '      AND (m.role IN (''owner'', ''admin'') OR (m.role <> ''viewer'' AND crove_hr.is_self_employee(attendance_log.org_id, attendance_log.employee_id)))'
    '  )'
    ')';

  EXECUTE 'DROP POLICY IF EXISTS hr_attendance_log_insert ON crove_hr.attendance_log';
  EXECUTE
    'CREATE POLICY hr_attendance_log_insert ON crove_hr.attendance_log AS RESTRICTIVE FOR INSERT TO crove_tenant '
    'WITH CHECK ('
    '  (SELECT crove_kernel.ctx_actor_type()) = ''user'' '
    '  AND EXISTS ('
    '    SELECT 1 FROM crove_kernel.tenant_member m '
    '    WHERE m.org_id = attendance_log.org_id '
    '      AND m.user_id = (SELECT crove_kernel.ctx_user_id()) '
    '      AND ('
    '        m.role IN (''owner'', ''admin'') '
    '        OR ('
    '          m.role <> ''viewer'' '
    '          AND crove_hr.is_self_employee(attendance_log.org_id, attendance_log.employee_id) '
    '          AND attendance_log.check_in_method IN (''web'', ''qr'') '
    '          AND attendance_log.status IN (''missing_checkout'', ''present'', ''half_day'')'
    '        )'
    '      )'
    '  )'
    ')';

  EXECUTE 'DROP POLICY IF EXISTS hr_attendance_log_update ON crove_hr.attendance_log';
  EXECUTE
    'CREATE POLICY hr_attendance_log_update ON crove_hr.attendance_log AS RESTRICTIVE FOR UPDATE TO crove_tenant '
    'USING ('
    '  (SELECT crove_kernel.ctx_actor_type()) = ''user'' '
    '  AND EXISTS ('
    '    SELECT 1 FROM crove_kernel.tenant_member m '
    '    WHERE m.org_id = attendance_log.org_id '
    '      AND m.user_id = (SELECT crove_kernel.ctx_user_id()) '
    '      AND (m.role IN (''owner'', ''admin'') OR (m.role <> ''viewer'' AND crove_hr.is_self_employee(attendance_log.org_id, attendance_log.employee_id)))'
    '  )'
    ') '
    'WITH CHECK ('
    '  (SELECT crove_kernel.ctx_actor_type()) = ''user'' '
    '  AND EXISTS ('
    '    SELECT 1 FROM crove_kernel.tenant_member m '
    '    WHERE m.org_id = attendance_log.org_id '
    '      AND m.user_id = (SELECT crove_kernel.ctx_user_id()) '
    '      AND ('
    '        m.role IN (''owner'', ''admin'') '
    '        OR ('
    '          m.role <> ''viewer'' '
    '          AND crove_hr.is_self_employee(attendance_log.org_id, attendance_log.employee_id) '
    '          AND attendance_log.check_in_method IN (''web'', ''qr'') '
    '          AND attendance_log.status IN (''present'', ''half_day'')'
    '        )'
    '      )'
    '  )'
    ')';

  EXECUTE 'DROP POLICY IF EXISTS hr_attendance_log_delete ON crove_hr.attendance_log';
  EXECUTE
    'CREATE POLICY hr_attendance_log_delete ON crove_hr.attendance_log AS RESTRICTIVE FOR DELETE TO crove_tenant '
    'USING (false)';
END $$;

CREATE TABLE IF NOT EXISTS crove_hr.attendance_qr_config (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  qr_secret_hash text NOT NULL CHECK (qr_secret_hash ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT attendance_qr_config_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);

CREATE INDEX IF NOT EXISTS attendance_qr_config_org_entity_idx
  ON crove_hr.attendance_qr_config (org_id, legal_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_qr_config_active_entity_uq
  ON crove_hr.attendance_qr_config (org_id, legal_entity_id)
  WHERE active;

CREATE INDEX IF NOT EXISTS attendance_qr_config_entity_idx
  ON crove_hr.attendance_qr_config (legal_entity_id, org_id);

SELECT crove_kernel.apply_tenant_rls('crove_hr.attendance_qr_config');
REVOKE ALL ON crove_hr.attendance_qr_config FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT SELECT, INSERT ON crove_hr.attendance_qr_config TO crove_tenant;
GRANT UPDATE (active, updated_at) ON crove_hr.attendance_qr_config TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.attendance_qr_config;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON crove_hr.attendance_qr_config
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.attendance_qr_config ENABLE ALWAYS TRIGGER b_legal_entity;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON crove_hr.attendance_qr_config';
  EXECUTE
    'CREATE POLICY le_scope ON crove_hr.attendance_qr_config AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
    'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))';

  EXECUTE 'DROP POLICY IF EXISTS owner_admin ON crove_hr.attendance_qr_config';
  EXECUTE
    'CREATE POLICY owner_admin ON crove_hr.attendance_qr_config AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = attendance_qr_config.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
    'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = attendance_qr_config.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';

  EXECUTE 'DROP POLICY IF EXISTS hr_attendance_qr_config_delete ON crove_hr.attendance_qr_config';
  EXECUTE
    'CREATE POLICY hr_attendance_qr_config_delete ON crove_hr.attendance_qr_config AS RESTRICTIVE FOR DELETE TO crove_tenant '
    'USING (false)';
END $$;

-- Verifies a caller's presented QR secret hash against the active entity QR config without granting direct SELECT on attendance_qr_config to non-admin members.
CREATE OR REPLACE FUNCTION crove_hr.verify_attendance_qr(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_qr_secret_hash text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF crove_kernel.ctx_actor_type() <> 'user'
     OR crove_kernel.ctx_org_id() IS DISTINCT FROM p_org_id
     OR p_legal_entity_id IS NULL
     OR p_qr_secret_hash IS NULL THEN
    RETURN false;
  END IF;

  IF NOT (
    '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
    OR p_legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
  ) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crove_kernel.tenant_member m
    WHERE m.org_id = p_org_id
      AND m.user_id = crove_kernel.ctx_user_id()
      AND m.role <> 'viewer'
  ) THEN
    RETURN false;
  END IF;

  IF NOT crove_hr.has_linked_employee(p_org_id, p_legal_entity_id) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM crove_hr.attendance_qr_config c
    WHERE c.org_id = p_org_id
      AND c.legal_entity_id = p_legal_entity_id
      AND c.active
      AND c.qr_secret_hash = p_qr_secret_hash
  );
END $$;
REVOKE ALL ON FUNCTION crove_hr.verify_attendance_qr(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.verify_attendance_qr(uuid, uuid, text) TO crove_tenant;
