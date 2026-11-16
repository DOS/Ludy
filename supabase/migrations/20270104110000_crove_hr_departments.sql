-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #3412, Part of #3403 Stage 3 Slice 3a; docs/plan/crove-os-kernel.md Phase 7, ADR-0046):
-- Departments per legal entity and optional employee department and job-title assignment. Idempotent; applied files stay untouched.
--
-- crove_hr.department          optional team structure per legal entity, each with a default pay_function.
--                              SME zero-setup default: employees keep department_id NULL and job_title NULL until an owner/admin assigns them.
--                              Owners and admins only, in the database and not only in the commands: matching RESTRICTIVE le_scope and owner_admin policies.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_hr.department (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 120),
  code text CHECK (code IS NULL OR (pg_catalog.length(pg_catalog.btrim(code)) BETWEEN 1 AND 32 AND code ~ '^[A-Za-z0-9._-]+$')),
  pay_function text NOT NULL DEFAULT 'admin' CHECK (pay_function IN ('admin', 'sales', 'production', 'overhead', 'construction')),
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT department_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT department_entity_name_uq UNIQUE (org_id, legal_entity_id, name),
  CONSTRAINT department_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);

CREATE INDEX IF NOT EXISTS department_entity_idx ON crove_hr.department (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.department');
REVOKE DELETE, UPDATE ON crove_hr.department FROM crove_tenant;
GRANT UPDATE (name, code, pay_function, archived_at, updated_at) ON crove_hr.department TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.department;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.department FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.department ENABLE ALWAYS TRIGGER b_legal_entity;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON crove_hr.department';
  EXECUTE
    'CREATE POLICY le_scope ON crove_hr.department AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
    'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))';
  EXECUTE 'DROP POLICY IF EXISTS owner_admin ON crove_hr.department';
  EXECUTE
    'CREATE POLICY owner_admin ON crove_hr.department AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = department.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
    'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = department.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';
END $$;

ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS department_id uuid;
ALTER TABLE crove_hr.payroll_employee ADD COLUMN IF NOT EXISTS job_title text
  CHECK (job_title IS NULL OR pg_catalog.length(pg_catalog.btrim(job_title)) BETWEEN 1 AND 160);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_employee'
      AND con.conname = 'payroll_employee_department_fk'
  ) THEN
    ALTER TABLE crove_hr.payroll_employee
      ADD CONSTRAINT payroll_employee_department_fk
      FOREIGN KEY (org_id, legal_entity_id, department_id)
      REFERENCES crove_hr.department (org_id, legal_entity_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payroll_employee_department_idx ON crove_hr.payroll_employee (org_id, legal_entity_id, department_id);
GRANT UPDATE (department_id, job_title) ON crove_hr.payroll_employee TO crove_tenant;
