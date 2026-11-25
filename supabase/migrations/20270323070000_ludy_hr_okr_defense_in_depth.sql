-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy HR OKR defense-in-depth (#4676):
-- 1. Enforce (org_id, legal_entity_id) via okr_objective_entity_fk on ludy_hr.okr_objective
--    so scope = 'company' rows cannot bypass legal_entity existence under MATCH SIMPLE.
-- 2. Replace SECURITY INVOKER reads of ludy_hr.payroll_employee for user contexts inside
--    ludy_hr.okr_objective_legal_entity_fill and ludy_hr.okr_objective_write_guard
--    with narrow SECURITY DEFINER helpers so L1 department managers cannot bypass the
--    erased-employee trigger guard or fall back to the default legal entity when
--    hr_employee_select hides non-self or erased employee rows, while preserving
--    table-owner / superuser trigger behavior outside user contexts.
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

-- 1. Standalone composite legal_entity FK on ludy_hr.okr_objective + G3 supporting index.
CREATE INDEX IF NOT EXISTS okr_objective_entity_idx
  ON ludy_hr.okr_objective (legal_entity_id, org_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'ludy_hr.okr_objective'::pg_catalog.regclass
       AND c.conname = 'okr_objective_entity_fk'
  ) THEN
    ALTER TABLE ludy_hr.okr_objective
      ADD CONSTRAINT okr_objective_entity_fk
      FOREIGN KEY (org_id, legal_entity_id)
      REFERENCES ludy_kernel.legal_entity (org_id, id);
  END IF;
END $$;

-- 2. Narrow SECURITY DEFINER helpers for OKR objective triggers.
-- Only active inside trigger execution (pg_trigger_depth() >= 1) for a verified user
-- in the matching tenant and legal-entity scope.
CREATE OR REPLACE FUNCTION ludy_hr.okr_employee_legal_entity_id(p_org_id uuid, p_employee_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
  v_entity uuid;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 OR p_org_id IS NULL OR p_employee_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN NULL;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_le_scope IS NULL OR pg_catalog.cardinality(v_le_scope) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN NULL;
  END IF;
  SELECT e.legal_entity_id INTO v_entity
    FROM ludy_hr.payroll_employee e
    LEFT JOIN ludy_hr.department d
      ON d.org_id = e.org_id AND d.id = e.department_id
   WHERE e.org_id = v_org
     AND e.id = p_employee_id
     AND e.erased_at IS NULL
     AND (
       '*' = ANY (v_le_scope)
       OR e.legal_entity_id::text = ANY (v_le_scope)
     )
     AND (
       v_role IN ('owner', 'admin')
       OR e.user_id = v_user
       OR (d.archived_at IS NULL AND d.manager_user_id = v_user)
     );
  RETURN v_entity;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_employee_legal_entity_id(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_employee_legal_entity_id(uuid, uuid) TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.okr_employee_is_erased(p_org_id uuid, p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_actor text := ludy_kernel.ctx_actor_type();
  v_user uuid := ludy_kernel.ctx_user_id();
  v_le_scope text[] := ludy_kernel.ctx_le_scope();
  v_role text;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 OR p_org_id IS NULL OR p_employee_id IS NULL THEN
    RETURN false;
  END IF;
  IF v_org IS NULL OR p_org_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;
  IF v_actor IS DISTINCT FROM 'user' OR v_user IS NULL THEN
    RETURN false;
  END IF;
  IF v_le_scope IS NULL OR pg_catalog.cardinality(v_le_scope) = 0 THEN
    RETURN false;
  END IF;
  SELECT m.role INTO v_role
    FROM ludy_kernel.tenant_member m
   WHERE m.org_id = v_org AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM ludy_hr.payroll_employee e
     WHERE e.org_id = v_org
       AND e.id = p_employee_id
       AND e.erased_at IS NOT NULL
       AND (
         '*' = ANY (v_le_scope)
         OR e.legal_entity_id::text = ANY (v_le_scope)
       )
       AND (
         v_role IN ('owner', 'admin')
         OR EXISTS (
           SELECT 1
             FROM ludy_hr.department d
            WHERE d.org_id = v_org
              AND d.legal_entity_id = e.legal_entity_id
              AND d.archived_at IS NULL
              AND d.manager_user_id = v_user
         )
       )
  );
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_employee_is_erased(uuid, uuid)
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_hr.okr_employee_is_erased(uuid, uuid) TO ludy_tenant;

-- 3. Use narrow SECURITY DEFINER helpers for user contexts in OKR objective triggers.
-- Outside user contexts (table owner / superuser maintenance or non-user tenant calls),
-- fall back to SECURITY INVOKER reads where hr_employee_select still returns 0 rows for ludy_tenant.
CREATE OR REPLACE FUNCTION ludy_hr.okr_objective_legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.department_id IS NOT NULL THEN
    SELECT d.legal_entity_id INTO v_entity
      FROM ludy_hr.department d
     WHERE d.org_id = NEW.org_id AND d.id = NEW.department_id;
  END IF;
  IF v_entity IS NULL AND NEW.owner_employee_id IS NOT NULL THEN
    IF ludy_kernel.ctx_actor_type() = 'user' THEN
      v_entity := ludy_hr.okr_employee_legal_entity_id(NEW.org_id, NEW.owner_employee_id);
    ELSE
      SELECT e.legal_entity_id INTO v_entity
        FROM ludy_hr.payroll_employee e
       WHERE e.org_id = NEW.org_id AND e.id = NEW.owner_employee_id;
    END IF;
  END IF;
  IF v_entity IS NULL THEN
    SELECT le.id INTO v_entity
      FROM ludy_kernel.legal_entity le
     WHERE le.org_id = NEW.org_id AND le.is_default;
  END IF;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_objective_legal_entity_fill()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_hr.okr_objective_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_parent_scope text;
  v_is_erased boolean := false;
BEGIN
  IF NEW.scope = 'company' AND NEW.parent_objective_id IS NOT NULL THEN
    RAISE EXCEPTION 'company objective cannot have a parent objective' USING ERRCODE = '42501';
  END IF;

  IF NEW.parent_objective_id IS NOT NULL THEN
    SELECT o.scope INTO v_parent_scope
      FROM ludy_hr.okr_objective o
     WHERE o.org_id = NEW.org_id
       AND o.legal_entity_id = NEW.legal_entity_id
       AND o.id = NEW.parent_objective_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent objective % not found in legal entity', NEW.parent_objective_id USING ERRCODE = '23503';
    END IF;
    IF NEW.scope = 'department' AND v_parent_scope <> 'company' THEN
      RAISE EXCEPTION 'department objective parent must be a company objective' USING ERRCODE = '42501';
    END IF;
    IF NEW.scope = 'individual' AND v_parent_scope NOT IN ('company', 'department') THEN
      RAISE EXCEPTION 'individual objective parent must be a company or department objective' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.scope = 'individual' AND NEW.owner_employee_id IS NULL THEN
      RAISE EXCEPTION 'individual objective requires owner_employee_id' USING ERRCODE = '23514';
    END IF;
    IF NEW.owner_employee_id IS NOT NULL THEN
      IF ludy_kernel.ctx_actor_type() = 'user' THEN
        v_is_erased := ludy_hr.okr_employee_is_erased(NEW.org_id, NEW.owner_employee_id);
      ELSE
        SELECT EXISTS (
          SELECT 1
            FROM ludy_hr.payroll_employee e
           WHERE e.org_id = NEW.org_id
             AND e.id = NEW.owner_employee_id
             AND e.erased_at IS NOT NULL
        ) INTO v_is_erased;
      END IF;
      IF v_is_erased THEN
        RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.scope <> OLD.scope THEN
    RAISE EXCEPTION 'objective scope cannot be changed after creation' USING ERRCODE = '42501';
  END IF;

  -- Allow PDPL erasure to clear owner_employee_id after employee.erased_at is stamped.
  IF NEW.owner_employee_id IS NULL AND OLD.owner_employee_id IS NOT NULL THEN
    IF OLD.scope = 'individual' THEN
      IF ludy_kernel.ctx_actor_type() = 'user' THEN
        v_is_erased := ludy_hr.okr_employee_is_erased(OLD.org_id, OLD.owner_employee_id);
      ELSE
        SELECT EXISTS (
          SELECT 1
            FROM ludy_hr.payroll_employee e
           WHERE e.org_id = OLD.org_id
             AND e.id = OLD.owner_employee_id
             AND e.erased_at IS NOT NULL
        ) INTO v_is_erased;
      END IF;
      IF NOT v_is_erased THEN
        RAISE EXCEPTION 'individual objective requires owner_employee_id until employee erasure' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.owner_employee_id IS NOT NULL AND NEW.owner_employee_id IS DISTINCT FROM OLD.owner_employee_id THEN
    IF ludy_kernel.ctx_actor_type() = 'user' THEN
      v_is_erased := ludy_hr.okr_employee_is_erased(NEW.org_id, NEW.owner_employee_id);
    ELSE
      SELECT EXISTS (
        SELECT 1
          FROM ludy_hr.payroll_employee e
         WHERE e.org_id = NEW.org_id
           AND e.id = NEW.owner_employee_id
           AND e.erased_at IS NOT NULL
      ) INTO v_is_erased;
    END IF;
    IF v_is_erased THEN
      RAISE EXCEPTION 'cannot assign objective to erased employee' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_hr.okr_objective_write_guard()
  FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
