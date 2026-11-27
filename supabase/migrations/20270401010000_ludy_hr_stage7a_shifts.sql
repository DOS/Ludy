-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR (#5216, Stage 7A): SME shift templates, weekly roster assignments, and 1-step shift swap requests.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Anti-recursion RLS helper: active linked non-erased employee in a given legal entity.
CREATE OR REPLACE FUNCTION ludy_hr.is_active_linked_employee(p_org_id uuid, p_legal_entity_id uuid)
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
    SELECT 1 FROM ludy_hr.payroll_employee e
     WHERE e.org_id = v_org
       AND e.legal_entity_id = p_legal_entity_id
       AND e.user_id = v_user
       AND e.erased_at IS NULL
       AND e.status = 'active'
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.is_active_linked_employee(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.is_active_linked_employee(uuid, uuid) TO ludy_tenant;

-- 2. SME shift templates (configurable minutes, break, grace windows, and overnight crosses_midnight flag).
CREATE TABLE IF NOT EXISTS ludy_hr.shift_template (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(code)) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 200),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  break_minutes integer NOT NULL DEFAULT 60 CHECK (break_minutes BETWEEN 0 AND 480),
  grace_late_minutes integer NOT NULL DEFAULT 15 CHECK (grace_late_minutes BETWEEN 0 AND 120),
  grace_early_minutes integer NOT NULL DEFAULT 15 CHECK (grace_early_minutes BETWEEN 0 AND 120),
  crosses_midnight boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by uuid DEFAULT ludy_kernel.ctx_user_id(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT shift_template_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT shift_template_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT shift_template_duration_ck CHECK (
    (crosses_midnight = true OR end_minute > start_minute)
    AND (
      CASE
        WHEN crosses_midnight THEN 1440 - start_minute + end_minute
        ELSE end_minute - start_minute
      END
    ) > break_minutes
    AND (
      CASE
        WHEN crosses_midnight THEN 1440 - start_minute + end_minute
        ELSE end_minute - start_minute
      END
    ) <= 1440
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shift_template_entity_code_active_uq
  ON ludy_hr.shift_template (org_id, legal_entity_id, code)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS shift_template_entity_list_idx
  ON ludy_hr.shift_template (org_id, legal_entity_id, archived_at, start_minute, code);

CREATE INDEX IF NOT EXISTS shift_template_entity_org_idx
  ON ludy_hr.shift_template (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.shift_template');
REVOKE ALL ON ludy_hr.shift_template FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON ludy_hr.shift_template TO ludy_tenant;
GRANT UPDATE (code, name, start_minute, end_minute, break_minutes, grace_late_minutes, grace_early_minutes, crosses_midnight, archived_at, updated_at)
  ON ludy_hr.shift_template TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.shift_template;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.shift_template
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill();
ALTER TABLE ludy_hr.shift_template ENABLE ALWAYS TRIGGER b_legal_entity;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON ludy_hr.shift_template';
  EXECUTE
    'CREATE POLICY le_scope ON ludy_hr.shift_template AS RESTRICTIVE FOR ALL TO ludy_tenant '
    'USING (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[]))) '
    'WITH CHECK (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])))';

  EXECUTE 'DROP POLICY IF EXISTS shift_template_select ON ludy_hr.shift_template';
  EXECUTE
    'CREATE POLICY shift_template_select ON ludy_hr.shift_template AS RESTRICTIVE FOR SELECT TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_template.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR ludy_hr.is_active_linked_employee(shift_template.org_id, shift_template.legal_entity_id)'
    '  OR ludy_hr.has_managed_department(shift_template.org_id, shift_template.legal_entity_id)'
    '))';

  EXECUTE 'DROP POLICY IF EXISTS shift_template_insert ON ludy_hr.shift_template';
  EXECUTE
    'CREATE POLICY shift_template_insert ON ludy_hr.shift_template AS RESTRICTIVE FOR INSERT TO ludy_tenant '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' '
    '  AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_template.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')) '
    '  AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id())))';

  EXECUTE 'DROP POLICY IF EXISTS shift_template_update ON ludy_hr.shift_template';
  EXECUTE
    'CREATE POLICY shift_template_update ON ludy_hr.shift_template AS RESTRICTIVE FOR UPDATE TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_template.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_template.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';

  EXECUTE 'DROP POLICY IF EXISTS shift_template_delete ON ludy_hr.shift_template';
  EXECUTE
    'CREATE POLICY shift_template_delete ON ludy_hr.shift_template AS RESTRICTIVE FOR DELETE TO ludy_tenant '
    'USING (false)';
END $$;

-- 3. Weekly shift roster assignments (unique per employee + work_date within a legal entity).
CREATE TABLE IF NOT EXISTS ludy_hr.shift_assignment (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  department_id uuid,
  shift_template_id uuid NOT NULL,
  work_date date NOT NULL,
  note text CHECK (note IS NULL OR pg_catalog.length(note) <= 500),
  created_by uuid DEFAULT ludy_kernel.ctx_user_id(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT shift_assignment_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT shift_assignment_entity_emp_date_uq UNIQUE (org_id, legal_entity_id, employee_id, work_date),
  CONSTRAINT shift_assignment_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT shift_assignment_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT shift_assignment_template_fk FOREIGN KEY (org_id, legal_entity_id, shift_template_id) REFERENCES ludy_hr.shift_template (org_id, legal_entity_id, id),
  CONSTRAINT shift_assignment_department_fk FOREIGN KEY (org_id, department_id) REFERENCES ludy_hr.department (org_id, id) ON DELETE SET NULL (department_id)
);

CREATE INDEX IF NOT EXISTS shift_assignment_entity_date_emp_idx
  ON ludy_hr.shift_assignment (org_id, legal_entity_id, work_date, employee_id);

CREATE INDEX IF NOT EXISTS shift_assignment_org_dept_date_idx
  ON ludy_hr.shift_assignment (org_id, department_id, work_date);

CREATE INDEX IF NOT EXISTS shift_assignment_entity_template_idx
  ON ludy_hr.shift_assignment (org_id, legal_entity_id, shift_template_id);

CREATE INDEX IF NOT EXISTS shift_assignment_entity_org_idx
  ON ludy_hr.shift_assignment (legal_entity_id, org_id);

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.shift_assignment');
REVOKE ALL ON ludy_hr.shift_assignment FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT, DELETE ON ludy_hr.shift_assignment TO ludy_tenant;
GRANT UPDATE (employee_id, department_id, shift_template_id, note, updated_at)
  ON ludy_hr.shift_assignment TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.shift_assignment;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.shift_assignment
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('employee_id');
ALTER TABLE ludy_hr.shift_assignment ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.shift_assignment_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_emp_status text;
  v_emp_erased timestamptz;
  v_tpl_archived timestamptz;
  v_dept_entity uuid;
BEGIN
  IF ludy_kernel.ctx_actor_type() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;

  SELECT e.status, e.erased_at INTO v_emp_status, v_emp_erased
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = NEW.org_id AND e.legal_entity_id = NEW.legal_entity_id AND e.id = NEW.employee_id;
  IF NOT FOUND OR v_emp_erased IS NOT NULL OR v_emp_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'cannot assign shift to erased or ended employee' USING ERRCODE = '23514';
  END IF;

  SELECT t.archived_at INTO v_tpl_archived
    FROM ludy_hr.shift_template t
   WHERE t.org_id = NEW.org_id AND t.legal_entity_id = NEW.legal_entity_id AND t.id = NEW.shift_template_id;
  IF NOT FOUND OR v_tpl_archived IS NOT NULL THEN
    RAISE EXCEPTION 'cannot assign archived shift template' USING ERRCODE = '23514';
  END IF;

  IF NEW.department_id IS NOT NULL THEN
    SELECT d.legal_entity_id INTO v_dept_entity
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = NEW.department_id;
    IF NOT FOUND OR v_dept_entity IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'shift assignment department must belong to the same legal entity' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_assignment_insert_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS shift_assignment_insert_guard ON ludy_hr.shift_assignment;
CREATE TRIGGER shift_assignment_insert_guard
  AFTER INSERT ON ludy_hr.shift_assignment
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.shift_assignment_insert_guard();
ALTER TABLE ludy_hr.shift_assignment ENABLE ALWAYS TRIGGER shift_assignment_insert_guard;

CREATE OR REPLACE FUNCTION ludy_hr.shift_assignment_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := ludy_kernel.ctx_user_id();
  v_is_owner boolean := false;
  v_old_erased timestamptz;
  v_new_status text;
  v_new_erased timestamptz;
  v_tpl_archived timestamptz;
  v_dept_entity uuid;
BEGIN
  -- Allow PostgreSQL FK ON DELETE SET NULL(department_id) when a department row is deleted.
  IF OLD.department_id IS NOT NULL
     AND NEW.department_id IS NULL
     AND NEW.org_id = OLD.org_id
     AND NEW.id = OLD.id
     AND NEW.legal_entity_id = OLD.legal_entity_id
     AND NEW.employee_id = OLD.employee_id
     AND NEW.shift_template_id = OLD.shift_template_id
     AND NEW.work_date = OLD.work_date
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at = OLD.created_at
     AND NEW.updated_at >= OLD.updated_at
     AND NOT EXISTS (SELECT 1 FROM ludy_hr.department d WHERE d.org_id = OLD.org_id AND d.id = OLD.department_id) THEN
    RETURN NEW;
  END IF;

  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'user actor required to update shift_assignment' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM ludy_kernel.tenant_member m
     WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role = 'owner'
  ) INTO v_is_owner;

  SELECT e.erased_at INTO v_old_erased
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = OLD.org_id AND e.id = OLD.employee_id;

  IF v_old_erased IS NOT NULL THEN
    IF v_is_owner
       AND NEW.note IS NULL
       AND NEW.org_id = OLD.org_id
       AND NEW.id = OLD.id
       AND NEW.legal_entity_id = OLD.legal_entity_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id
       AND NEW.shift_template_id = OLD.shift_template_id
       AND NEW.work_date = OLD.work_date
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
       AND NEW.created_at = OLD.created_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'shift assignment of erased employee cannot be modified' USING ERRCODE = '23514';
  END IF;

  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    SELECT e.status, e.erased_at INTO v_new_status, v_new_erased
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = NEW.org_id AND e.legal_entity_id = NEW.legal_entity_id AND e.id = NEW.employee_id;
    IF NOT FOUND OR v_new_erased IS NOT NULL OR v_new_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'cannot transfer shift assignment to erased or ended employee' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.shift_template_id IS DISTINCT FROM OLD.shift_template_id THEN
    SELECT t.archived_at INTO v_tpl_archived
      FROM ludy_hr.shift_template t
     WHERE t.org_id = NEW.org_id AND t.legal_entity_id = NEW.legal_entity_id AND t.id = NEW.shift_template_id;
    IF NOT FOUND OR v_tpl_archived IS NOT NULL THEN
      RAISE EXCEPTION 'cannot assign archived shift template' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.department_id IS NOT NULL AND NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    SELECT d.legal_entity_id INTO v_dept_entity
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = NEW.department_id;
    IF NOT FOUND OR v_dept_entity IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'shift assignment department must belong to the same legal entity' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_assignment_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS shift_assignment_update_guard ON ludy_hr.shift_assignment;
CREATE TRIGGER shift_assignment_update_guard
  BEFORE UPDATE ON ludy_hr.shift_assignment
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.shift_assignment_update_guard();
ALTER TABLE ludy_hr.shift_assignment ENABLE ALWAYS TRIGGER shift_assignment_update_guard;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON ludy_hr.shift_assignment';
  EXECUTE
    'CREATE POLICY le_scope ON ludy_hr.shift_assignment AS RESTRICTIVE FOR ALL TO ludy_tenant '
    'USING (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[]))) '
    'WITH CHECK (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])))';

  EXECUTE 'DROP POLICY IF EXISTS shift_assignment_select ON ludy_hr.shift_assignment';
  EXECUTE
    'CREATE POLICY shift_assignment_select ON ludy_hr.shift_assignment AS RESTRICTIVE FOR SELECT TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_assignment.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_assignment.org_id, shift_assignment.department_id))'
    '  OR ludy_hr.is_self_employee(shift_assignment.org_id, shift_assignment.employee_id)'
    '))';

  EXECUTE 'DROP POLICY IF EXISTS shift_assignment_insert ON ludy_hr.shift_assignment';
  EXECUTE
    'CREATE POLICY shift_assignment_insert ON ludy_hr.shift_assignment AS RESTRICTIVE FOR INSERT TO ludy_tenant '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_assignment.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_assignment.org_id, shift_assignment.department_id))'
    ') AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id())))';

  EXECUTE 'DROP POLICY IF EXISTS shift_assignment_update ON ludy_hr.shift_assignment';
  EXECUTE
    'CREATE POLICY shift_assignment_update ON ludy_hr.shift_assignment AS RESTRICTIVE FOR UPDATE TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_assignment.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_assignment.org_id, shift_assignment.department_id))'
    ')) '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_assignment.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_assignment.org_id, shift_assignment.department_id))'
    '))';

  EXECUTE 'DROP POLICY IF EXISTS shift_assignment_delete ON ludy_hr.shift_assignment';
  EXECUTE
    'CREATE POLICY shift_assignment_delete ON ludy_hr.shift_assignment AS RESTRICTIVE FOR DELETE TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_assignment.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_assignment.org_id, shift_assignment.department_id))'
    '))';
END $$;

-- 4. 1-step shift swap requests with DB anti-self-approval, L1 dept manager authority, and PDPL erasure path.
CREATE TABLE IF NOT EXISTS ludy_hr.shift_swap_request (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  requester_employee_id uuid NOT NULL,
  target_employee_id uuid NOT NULL,
  requester_assignment_id uuid NOT NULL,
  target_assignment_id uuid,
  department_id uuid,
  work_date date NOT NULL,
  reason text CHECK (reason IS NULL OR pg_catalog.length(reason) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR pg_catalog.length(decision_note) <= 1000),
  created_by uuid DEFAULT ludy_kernel.ctx_user_id(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT shift_swap_request_distinct_emp_ck CHECK (requester_employee_id <> target_employee_id),
  CONSTRAINT shift_swap_request_distinct_assign_ck CHECK (target_assignment_id IS NULL OR target_assignment_id <> requester_assignment_id),
  CONSTRAINT shift_swap_request_decision_ck CHECK (
    (status IN ('pending', 'cancelled') AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT shift_swap_request_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT shift_swap_request_requester_fk FOREIGN KEY (org_id, legal_entity_id, requester_employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT shift_swap_request_target_fk FOREIGN KEY (org_id, legal_entity_id, target_employee_id) REFERENCES ludy_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT shift_swap_request_req_assign_fk FOREIGN KEY (org_id, legal_entity_id, requester_assignment_id) REFERENCES ludy_hr.shift_assignment (org_id, legal_entity_id, id),
  CONSTRAINT shift_swap_request_tgt_assign_fk FOREIGN KEY (org_id, legal_entity_id, target_assignment_id) REFERENCES ludy_hr.shift_assignment (org_id, legal_entity_id, id) ON DELETE SET NULL (target_assignment_id),
  CONSTRAINT shift_swap_request_department_fk FOREIGN KEY (org_id, department_id) REFERENCES ludy_hr.department (org_id, id) ON DELETE SET NULL (department_id)
);

CREATE INDEX IF NOT EXISTS shift_swap_request_entity_status_date_idx
  ON ludy_hr.shift_swap_request (org_id, legal_entity_id, status, work_date DESC);

CREATE INDEX IF NOT EXISTS shift_swap_request_requester_idx
  ON ludy_hr.shift_swap_request (org_id, requester_employee_id, work_date DESC);

CREATE INDEX IF NOT EXISTS shift_swap_request_target_idx
  ON ludy_hr.shift_swap_request (org_id, target_employee_id, work_date DESC);

CREATE INDEX IF NOT EXISTS shift_swap_request_entity_req_assign_idx
  ON ludy_hr.shift_swap_request (org_id, legal_entity_id, requester_assignment_id);

CREATE INDEX IF NOT EXISTS shift_swap_request_entity_tgt_assign_idx
  ON ludy_hr.shift_swap_request (org_id, legal_entity_id, target_assignment_id)
  WHERE target_assignment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shift_swap_request_dept_idx
  ON ludy_hr.shift_swap_request (org_id, department_id, status);

CREATE INDEX IF NOT EXISTS shift_swap_request_entity_org_idx
  ON ludy_hr.shift_swap_request (legal_entity_id, org_id);

CREATE UNIQUE INDEX IF NOT EXISTS shift_swap_request_pending_req_assign_uq
  ON ludy_hr.shift_swap_request (org_id, legal_entity_id, requester_assignment_id)
  WHERE status = 'pending';

SELECT ludy_kernel.apply_tenant_rls('ludy_hr.shift_swap_request');
REVOKE ALL ON ludy_hr.shift_swap_request FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT ON ludy_hr.shift_swap_request TO ludy_tenant;
GRANT UPDATE (status, decided_by, decided_at, decision_note, reason, updated_at)
  ON ludy_hr.shift_swap_request TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_hr.shift_swap_request;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON ludy_hr.shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.legal_entity_fill('requester_employee_id');
ALTER TABLE ludy_hr.shift_swap_request ENABLE ALWAYS TRIGGER b_legal_entity;

CREATE OR REPLACE FUNCTION ludy_hr.shift_swap_request_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_req_status text;
  v_req_erased timestamptz;
  v_tgt_status text;
  v_tgt_erased timestamptz;
  v_req_emp uuid;
  v_req_date date;
  v_tgt_emp uuid;
  v_tgt_date date;
  v_dept_entity uuid;
BEGIN
  IF ludy_kernel.ctx_actor_type() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM ludy_kernel.ctx_org_id() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_note IS NOT NULL THEN
    RAISE EXCEPTION 'new shift swap request must start pending without decision fields' USING ERRCODE = '23514';
  END IF;

  SELECT e.status, e.erased_at INTO v_req_status, v_req_erased
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = NEW.org_id AND e.legal_entity_id = NEW.legal_entity_id AND e.id = NEW.requester_employee_id;
  IF NOT FOUND OR v_req_erased IS NOT NULL OR v_req_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'requester employee must be active and not erased' USING ERRCODE = '23514';
  END IF;

  SELECT e.status, e.erased_at INTO v_tgt_status, v_tgt_erased
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = NEW.org_id AND e.legal_entity_id = NEW.legal_entity_id AND e.id = NEW.target_employee_id;
  IF NOT FOUND OR v_tgt_erased IS NOT NULL OR v_tgt_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'target employee must be active and not erased' USING ERRCODE = '23514';
  END IF;

  SELECT a.employee_id, a.work_date INTO v_req_emp, v_req_date
    FROM ludy_hr.shift_assignment a
   WHERE a.org_id = NEW.org_id AND a.legal_entity_id = NEW.legal_entity_id AND a.id = NEW.requester_assignment_id;
  IF NOT FOUND OR v_req_emp IS DISTINCT FROM NEW.requester_employee_id OR v_req_date IS DISTINCT FROM NEW.work_date THEN
    RAISE EXCEPTION 'requester assignment must match requester employee and work date' USING ERRCODE = '23514';
  END IF;

  IF NEW.target_assignment_id IS NOT NULL THEN
    SELECT a.employee_id, a.work_date INTO v_tgt_emp, v_tgt_date
      FROM ludy_hr.shift_assignment a
     WHERE a.org_id = NEW.org_id AND a.legal_entity_id = NEW.legal_entity_id AND a.id = NEW.target_assignment_id;
    IF NOT FOUND OR v_tgt_emp IS DISTINCT FROM NEW.target_employee_id OR v_tgt_date IS DISTINCT FROM NEW.work_date THEN
      RAISE EXCEPTION 'target assignment must match target employee and work date' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.department_id IS NOT NULL THEN
    SELECT d.legal_entity_id INTO v_dept_entity
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = NEW.department_id;
    IF NOT FOUND OR v_dept_entity IS DISTINCT FROM NEW.legal_entity_id THEN
      RAISE EXCEPTION 'shift swap department must belong to the same legal entity' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_swap_request_insert_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS shift_swap_request_insert_guard ON ludy_hr.shift_swap_request;
CREATE TRIGGER shift_swap_request_insert_guard
  AFTER INSERT ON ludy_hr.shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.shift_swap_request_insert_guard();
ALTER TABLE ludy_hr.shift_swap_request ENABLE ALWAYS TRIGGER shift_swap_request_insert_guard;

CREATE OR REPLACE FUNCTION ludy_hr.shift_swap_request_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user uuid := ludy_kernel.ctx_user_id();
  v_is_owner boolean := false;
  v_is_admin boolean := false;
  v_is_l1_mgr boolean := false;
  v_any_erased boolean := false;
  v_req_user uuid;
  v_tgt_user uuid;
BEGIN
  -- Allow PostgreSQL FK ON DELETE SET NULL(target_assignment_id) or (department_id) when referenced row is removed.
  IF OLD.target_assignment_id IS NOT NULL
     AND NEW.target_assignment_id IS NULL
     AND NEW.org_id = OLD.org_id
     AND NEW.id = OLD.id
     AND NEW.legal_entity_id = OLD.legal_entity_id
     AND NEW.requester_employee_id = OLD.requester_employee_id
     AND NEW.target_employee_id = OLD.target_employee_id
     AND NEW.requester_assignment_id = OLD.requester_assignment_id
     AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id
     AND NEW.work_date = OLD.work_date
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.status = OLD.status
     AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at = OLD.created_at
     AND NEW.updated_at >= OLD.updated_at
     AND NOT EXISTS (SELECT 1 FROM ludy_hr.shift_assignment a WHERE a.org_id = OLD.org_id AND a.legal_entity_id = OLD.legal_entity_id AND a.id = OLD.target_assignment_id) THEN
    RETURN NEW;
  END IF;

  IF OLD.department_id IS NOT NULL
     AND NEW.department_id IS NULL
     AND NEW.org_id = OLD.org_id
     AND NEW.id = OLD.id
     AND NEW.legal_entity_id = OLD.legal_entity_id
     AND NEW.requester_employee_id = OLD.requester_employee_id
     AND NEW.target_employee_id = OLD.target_employee_id
     AND NEW.requester_assignment_id = OLD.requester_assignment_id
     AND NEW.target_assignment_id IS NOT DISTINCT FROM OLD.target_assignment_id
     AND NEW.work_date = OLD.work_date
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.status = OLD.status
     AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at = OLD.created_at
     AND NEW.updated_at >= OLD.updated_at
     AND NOT EXISTS (SELECT 1 FROM ludy_hr.department d WHERE d.org_id = OLD.org_id AND d.id = OLD.department_id) THEN
    RETURN NEW;
  END IF;

  IF ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'user' OR ludy_kernel.ctx_org_id() IS DISTINCT FROM NEW.org_id OR v_user IS NULL THEN
    RAISE EXCEPTION 'user actor required to update shift_swap_request' USING ERRCODE = '42501';
  END IF;

  SELECT
    EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role = 'owner'
    ),
    EXISTS (
      SELECT 1 FROM ludy_kernel.tenant_member m
       WHERE m.org_id = NEW.org_id AND m.user_id = v_user AND m.role IN ('owner', 'admin')
    )
    INTO v_is_owner, v_is_admin;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.requester_employee_id IS DISTINCT FROM OLD.requester_employee_id
     OR NEW.target_employee_id IS DISTINCT FROM OLD.target_employee_id
     OR NEW.requester_assignment_id IS DISTINCT FROM OLD.requester_assignment_id
     OR NEW.target_assignment_id IS DISTINCT FROM OLD.target_assignment_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable shift swap fields cannot be changed' USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM ludy_hr.payroll_employee e
     WHERE e.org_id = OLD.org_id
       AND e.id IN (OLD.requester_employee_id, OLD.target_employee_id)
       AND e.erased_at IS NOT NULL
  ) INTO v_any_erased;

  -- PDPL erasure path: owner clears free-text PII and cancels pending swaps for erased employees.
  IF v_any_erased THEN
    IF v_is_owner
       AND NEW.reason IS NULL
       AND NEW.decision_note IS NULL
       AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
       AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
       AND (
         (OLD.status = 'pending' AND NEW.status = 'cancelled')
         OR (OLD.status IN ('approved', 'rejected', 'cancelled') AND NEW.status = OLD.status)
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'shift swap of erased employee cannot be modified' USING ERRCODE = '23514';
  END IF;

  IF NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'shift swap reason cannot be modified' USING ERRCODE = '23514';
  END IF;

  -- No-op metadata touch while pending (e.g. RLS matrix probe).
  IF OLD.status = 'pending'
     AND NEW.status = 'pending'
     AND NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
     AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
     AND NEW.decision_note IS NOT DISTINCT FROM OLD.decision_note THEN
    IF v_is_admin THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid shift swap no-op update' USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'only pending shift swap requests can transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_note IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled shift swap cannot set decision fields' USING ERRCODE = '23514';
    END IF;
    IF v_is_admin OR ludy_hr.is_active_self_employee(OLD.org_id, OLD.requester_employee_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'only requester or HR admin may cancel pending shift swap' USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('approved', 'rejected') THEN
    IF NEW.decided_by IS DISTINCT FROM v_user OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'decision must record acting user and timestamp' USING ERRCODE = '23514';
    END IF;

    v_is_l1_mgr := OLD.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(OLD.org_id, OLD.department_id);
    IF NOT (v_is_admin OR v_is_l1_mgr) THEN
      RAISE EXCEPTION 'only active L1 department manager or HR admin may decide shift swap' USING ERRCODE = '42501';
    END IF;

    SELECT e.user_id INTO v_req_user
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = OLD.org_id AND e.id = OLD.requester_employee_id;
    SELECT e.user_id INTO v_tgt_user
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = OLD.org_id AND e.id = OLD.target_employee_id;

    IF (v_user IS NOT DISTINCT FROM v_req_user OR v_user IS NOT DISTINCT FROM v_tgt_user OR v_user IS NOT DISTINCT FROM OLD.created_by)
       AND NOT ludy_hr.is_sole_owner_org(OLD.org_id) THEN
      RAISE EXCEPTION 'cannot decide own shift swap request unless sole owner' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported shift swap transition' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_swap_request_update_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

DROP TRIGGER IF EXISTS shift_swap_request_update_guard ON ludy_hr.shift_swap_request;
CREATE TRIGGER shift_swap_request_update_guard
  BEFORE UPDATE ON ludy_hr.shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION ludy_hr.shift_swap_request_update_guard();
ALTER TABLE ludy_hr.shift_swap_request ENABLE ALWAYS TRIGGER shift_swap_request_update_guard;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON ludy_hr.shift_swap_request';
  EXECUTE
    'CREATE POLICY le_scope ON ludy_hr.shift_swap_request AS RESTRICTIVE FOR ALL TO ludy_tenant '
    'USING (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[]))) '
    'WITH CHECK (''*'' = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])) OR legal_entity_id::text = ANY (COALESCE((SELECT ludy_kernel.ctx_le_scope())::text[], ARRAY[]::text[])))';

  EXECUTE 'DROP POLICY IF EXISTS shift_swap_request_select ON ludy_hr.shift_swap_request';
  EXECUTE
    'CREATE POLICY shift_swap_request_select ON ludy_hr.shift_swap_request AS RESTRICTIVE FOR SELECT TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_swap_request.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_swap_request.org_id, shift_swap_request.department_id))'
    '  OR ludy_hr.is_self_employee(shift_swap_request.org_id, shift_swap_request.requester_employee_id)'
    '  OR ludy_hr.is_self_employee(shift_swap_request.org_id, shift_swap_request.target_employee_id)'
    '))';

  EXECUTE 'DROP POLICY IF EXISTS shift_swap_request_insert ON ludy_hr.shift_swap_request';
  EXECUTE
    'CREATE POLICY shift_swap_request_insert ON ludy_hr.shift_swap_request AS RESTRICTIVE FOR INSERT TO ludy_tenant '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_swap_request.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR ludy_hr.is_active_self_employee(shift_swap_request.org_id, shift_swap_request.requester_employee_id)'
    ') AND (created_by IS NULL OR created_by = (SELECT ludy_kernel.ctx_user_id())))';

  EXECUTE 'DROP POLICY IF EXISTS shift_swap_request_update ON ludy_hr.shift_swap_request';
  EXECUTE
    'CREATE POLICY shift_swap_request_update ON ludy_hr.shift_swap_request AS RESTRICTIVE FOR UPDATE TO ludy_tenant '
    'USING ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_swap_request.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_swap_request.org_id, shift_swap_request.department_id))'
    '  OR ludy_hr.is_active_self_employee(shift_swap_request.org_id, shift_swap_request.requester_employee_id)'
    ')) '
    'WITH CHECK ((SELECT ludy_kernel.ctx_actor_type()) = ''user'' AND ('
    '  EXISTS (SELECT 1 FROM ludy_kernel.tenant_member m WHERE m.org_id = shift_swap_request.org_id AND m.user_id = (SELECT ludy_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))'
    '  OR (department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(shift_swap_request.org_id, shift_swap_request.department_id))'
    '  OR ludy_hr.is_active_self_employee(shift_swap_request.org_id, shift_swap_request.requester_employee_id)'
    '))';

  EXECUTE 'DROP POLICY IF EXISTS shift_swap_request_delete ON ludy_hr.shift_swap_request';
  EXECUTE
    'CREATE POLICY shift_swap_request_delete ON ludy_hr.shift_swap_request AS RESTRICTIVE FOR DELETE TO ludy_tenant '
    'USING (false)';
END $$;

-- 5. Scoped SECURITY DEFINER helpers for roster visibility, erase-race row locking, and leave/trip conflict checks.
CREATE OR REPLACE FUNCTION ludy_hr.shift_visible_employees(p_org_id uuid, p_legal_entity_id uuid)
RETURNS TABLE (
  id uuid,
  legal_entity_id uuid,
  department_id uuid,
  display_name text,
  status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
  v_linked boolean := false;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL THEN
    RETURN;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN;
  END IF;
  IF NOT (
    '*' = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
    OR p_legal_entity_id::text = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
  ) THEN
    RETURN;
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN;
  END IF;

  v_linked := ludy_hr.is_active_linked_employee(v_org, p_legal_entity_id);

  RETURN QUERY
  SELECT e.id, e.legal_entity_id, e.department_id, e.display_name, e.status
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org
     AND e.legal_entity_id = p_legal_entity_id
     AND e.erased_at IS NULL
     AND e.status = 'active'
     AND (
       v_role IN ('owner', 'admin')
       OR v_linked
       OR (e.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, e.department_id))
     )
   ORDER BY e.display_name ASC, e.id ASC;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_visible_employees(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.shift_visible_employees(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.lock_shift_employee_active(p_org_id uuid, p_employee_id uuid)
RETURNS TABLE (
  id uuid,
  legal_entity_id uuid,
  department_id uuid,
  display_name text,
  status text,
  is_erased boolean,
  user_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
  v_row ludy_hr.payroll_employee%ROWTYPE;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_employee_id IS NULL THEN
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

  SELECT e.* INTO v_row
    FROM ludy_hr.payroll_employee e
   WHERE e.org_id = v_org AND e.id = p_employee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT (
    '*' = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
    OR v_row.legal_entity_id::text = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
  ) THEN
    RETURN;
  END IF;

  IF NOT (
    v_role IN ('owner', 'admin')
    OR v_row.user_id IS NOT DISTINCT FROM v_user
    OR (v_row.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, v_row.department_id))
    OR ludy_hr.is_active_linked_employee(v_org, v_row.legal_entity_id)
  ) THEN
    RETURN;
  END IF;

  id := v_row.id;
  legal_entity_id := v_row.legal_entity_id;
  department_id := v_row.department_id;
  display_name := CASE WHEN v_row.erased_at IS NULL THEN v_row.display_name ELSE NULL END;
  status := v_row.status;
  is_erased := v_row.erased_at IS NOT NULL;
  user_id := v_row.user_id;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.lock_shift_employee_active(uuid, uuid) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.lock_shift_employee_active(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.shift_unavailable_employee_dates(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_start date,
  p_end date
)
RETURNS TABLE (
  employee_id uuid,
  source text,
  start_on date,
  end_on date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN;
  END IF;
  IF NOT (
    '*' = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
    OR p_legal_entity_id::text = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
  ) THEN
    RETURN;
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN;
  END IF;
  IF v_role = 'member' AND NOT ludy_hr.has_managed_department(v_org, p_legal_entity_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT l.employee_id, 'leave'::text AS source, l.start_on, l.end_on
    FROM ludy_hr.leave_request l
   WHERE l.org_id = v_org
     AND l.legal_entity_id = p_legal_entity_id
     AND l.status = 'approved'
     AND l.start_on <= p_end
     AND l.end_on >= p_start
     AND (v_role IN ('owner', 'admin') OR (l.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, l.department_id)))
  UNION ALL
  SELECT t.employee_id, 'trip'::text AS source, t.start_on, t.end_on
    FROM ludy_hr.business_trip_request t
   WHERE t.org_id = v_org
     AND t.legal_entity_id = p_legal_entity_id
     AND t.status = 'approved'
     AND t.start_on <= p_end
     AND t.end_on >= p_start
     AND (v_role IN ('owner', 'admin') OR (t.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, t.department_id)));
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_unavailable_employee_dates(uuid, uuid, date, date) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.shift_unavailable_employee_dates(uuid, uuid, date, date) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.resolve_self_shift_swap_target(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_target_employee_id uuid,
  p_work_date date
)
RETURNS TABLE (
  assignment_id uuid,
  shift_template_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL OR p_target_employee_id IS NULL OR p_work_date IS NULL THEN
    RETURN;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN;
  END IF;
  IF NOT (
    '*' = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
    OR p_legal_entity_id::text = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
  ) THEN
    RETURN;
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN;
  END IF;
  IF v_role = 'member' AND NOT ludy_hr.is_active_linked_employee(v_org, p_legal_entity_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id AS assignment_id, a.shift_template_id
    FROM ludy_hr.shift_assignment a
    JOIN ludy_hr.payroll_employee e
      ON e.org_id = a.org_id
     AND e.legal_entity_id = a.legal_entity_id
     AND e.id = a.employee_id
   WHERE a.org_id = v_org
     AND a.legal_entity_id = p_legal_entity_id
     AND a.employee_id = p_target_employee_id
     AND a.work_date = p_work_date
     AND e.erased_at IS NULL
     AND e.status = 'active';
END $$;
REVOKE ALL ON FUNCTION ludy_hr.resolve_self_shift_swap_target(uuid, uuid, uuid, date) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.resolve_self_shift_swap_target(uuid, uuid, uuid, date) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.shift_swap_assignment_labels(
  p_org_id uuid,
  p_legal_entity_id uuid,
  p_assignment_ids uuid[]
)
RETURNS TABLE (
  assignment_id uuid,
  shift_template_id uuid,
  shift_code text,
  shift_name text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org OR p_legal_entity_id IS NULL OR p_assignment_ids IS NULL OR pg_catalog.cardinality(p_assignment_ids) = 0 THEN
    RETURN;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN;
  END IF;
  IF NOT (
    '*' = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
    OR p_legal_entity_id::text = ANY (COALESCE(v_le_scope, ARRAY[]::text[]))
  ) THEN
    RETURN;
  END IF;

  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id AS assignment_id, a.shift_template_id, t.code AS shift_code, t.name AS shift_name
    FROM ludy_hr.shift_assignment a
    JOIN ludy_hr.shift_template t
      ON t.org_id = a.org_id
     AND t.legal_entity_id = a.legal_entity_id
     AND t.id = a.shift_template_id
   WHERE a.org_id = v_org
     AND a.legal_entity_id = p_legal_entity_id
     AND a.id = ANY (p_assignment_ids)
     AND EXISTS (
       SELECT 1
         FROM ludy_hr.shift_swap_request s
        WHERE s.org_id = v_org
          AND s.legal_entity_id = p_legal_entity_id
          AND (a.id = s.requester_assignment_id OR a.id = s.target_assignment_id)
          AND (
            v_role IN ('owner', 'admin')
            OR (s.department_id IS NOT NULL AND ludy_hr.is_active_dept_manager(v_org, s.department_id))
            OR ludy_hr.is_self_employee(v_org, s.requester_employee_id)
            OR ludy_hr.is_self_employee(v_org, s.target_employee_id)
          )
     );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.shift_swap_assignment_labels(uuid, uuid, uuid[]) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.shift_swap_assignment_labels(uuid, uuid, uuid[]) TO ludy_tenant;
