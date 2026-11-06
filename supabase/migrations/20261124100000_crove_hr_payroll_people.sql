-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2530, docs/plan/payroll.md sections 6.1 and 6.6, ADR-0046, ADR-0017): the people payroll is run for. Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_employee    the person: a name and an address (pii), the identity number and the bank account number sealed under the person's own subject
--                              key (ADR-0017: `crove:s1:...` text made by ctx.seal under the reference `employee:<id>`; a shred of that key makes both unreadable while
--                              the row stays as it is). No image of an identity document is stored anywhere. An employee is not an org member and has no login.
-- crove_hr.payroll_employment  effective-dated terms: contract type, region, base wage. Append-only in the way contracts are: a raise is a new row, so a past month
--                              recomputes to the same figures. The org purge deletes them with the org (its own guard, as the task comments' and approvals').
-- crove_hr.payroll_dependent   a dependent of an employee: name (pii), relation, the day the deduction starts and, when it stops, the day it ends.
--
-- Owners and admins only, in the database and not only in the commands: besides the tenant policy and the legal-entity scope every table has a second RESTRICTIVE
-- policy, owner_admin, for every command. The actor is a user whose membership role is owner or admin; a member, a viewer, an agent, the system and the worker read
-- and write nothing and cannot tell whether a row exists (plan section 6.6).
--
-- The sealed columns are named identity_sealed and account_sealed, not national_id and bank_account: a name that looks like personal data must be in the personal-data
-- registry (apps/kernel/test/invariant/personal-data.db.test.ts) and a sealed column may not be (SEALED_COLUMNS), and a CHECK keeps a plain number out of them.
SET LOCAL lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS crove_hr;
GRANT USAGE ON SCHEMA crove_hr TO crove_tenant;

-- Which legal entity a new row belongs to (trigger b_legal_entity, as the other modules' tables): an employee takes the entity the writer names or, naming none, the
-- org's default entity as the writer sees it; an employment or a dependent takes its employee's. It runs as the writer, through the writer's own policies, and is
-- enabled ALWAYS, so it fires in replica mode as well. The composite foreign keys then keep every row in its employee's entity.
CREATE OR REPLACE FUNCTION crove_hr.legal_entity_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_NARGS = 1 THEN
    SELECT e.legal_entity_id INTO v_entity FROM crove_hr.payroll_employee e
    WHERE e.org_id = NEW.org_id AND e.id = (pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  ELSE
    SELECT e.id INTO v_entity FROM crove_kernel.legal_entity e WHERE e.org_id = NEW.org_id AND e.is_default;
  END IF;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.legal_entity_fill() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE TABLE IF NOT EXISTS crove_hr.payroll_employee (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  display_name text NOT NULL CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  address text CHECK (address IS NULL OR pg_catalog.length(address) BETWEEN 1 AND 500),
  -- Sealed under the subject key `employee:<id>` (ctx.seal); the shape is checked so a plain number cannot be written here.
  identity_sealed text CHECK (identity_sealed IS NULL OR (pg_catalog.length(identity_sealed) <= 1000 AND identity_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  account_sealed text CHECK (account_sealed IS NULL OR (pg_catalog.length(account_sealed) <= 1000 AND account_sealed ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ended_on date,
  -- Set by the erasure (hr.payroll.employee.erase): the name and address are cleared, the person's key is shredded, and nothing about the person can be edited again.
  erased_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- The target of the composite keys below, so a row cannot name another entity than its employee.
  CONSTRAINT payroll_employee_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT payroll_employee_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT payroll_employee_ended_ck CHECK ((status = 'ended') = (ended_on IS NOT NULL)),
  CONSTRAINT payroll_employee_erased_ck CHECK (erased_at IS NULL OR status = 'ended')
);
CREATE INDEX IF NOT EXISTS payroll_employee_entity_idx ON crove_hr.payroll_employee (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_employee');
-- An employee is never deleted by a tenant role (the org purge deletes as the table owner); the org, the entity and the creation never change.
REVOKE DELETE, UPDATE ON crove_hr.payroll_employee FROM crove_tenant;
GRANT UPDATE (display_name, address, identity_sealed, account_sealed, status, ended_on, erased_at, updated_at) ON crove_hr.payroll_employee TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_hr.payroll_employment (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  effective_from date NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('indefinite', 'fixed_term', 'none')),
  region text NOT NULL CHECK (region IN ('I', 'II', 'III', 'IV')),
  base_wage numeric(20, 2) NOT NULL CHECK (base_wage >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_employment_day_uq UNIQUE (org_id, employee_id, effective_from),
  CONSTRAINT payroll_employment_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_employment_entity_idx ON crove_hr.payroll_employment (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_employment', true);
-- Append-only: reject_mutation for TRUNCATE, and for UPDATE and DELETE the purge-aware guard, which lets the org's purge delete a closing org's rows and nothing else.
SELECT crove_kernel.make_append_only('crove_hr.payroll_employment');
DROP TRIGGER IF EXISTS append_only_row ON crove_hr.payroll_employment;
CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON crove_hr.payroll_employment
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.purge_append_only_guard();

CREATE TABLE IF NOT EXISTS crove_hr.payroll_dependent (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  display_name text NOT NULL CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  relation text NOT NULL CHECK (pg_catalog.length(relation) BETWEEN 1 AND 50),
  registered_on date NOT NULL,
  ended_on date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_dependent_period_ck CHECK (ended_on IS NULL OR ended_on >= registered_on),
  CONSTRAINT payroll_dependent_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_dependent_employee_idx ON crove_hr.payroll_dependent (org_id, legal_entity_id, employee_id);
CREATE INDEX IF NOT EXISTS payroll_dependent_entity_idx ON crove_hr.payroll_dependent (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_dependent');
-- A dependent is registered once; the period ends, and the name is cleared by an erasure (a placeholder), nothing else changes.
REVOKE DELETE, UPDATE ON crove_hr.payroll_dependent FROM crove_tenant;
GRANT UPDATE (display_name, ended_on) ON crove_hr.payroll_dependent TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_employee;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_employee FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.payroll_employee ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_employment;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_employment FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.payroll_employment ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_dependent;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_dependent FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.payroll_dependent ENABLE ALWAYS TRIGGER b_legal_entity;

-- The legal-entity scope and the owner and admin gate, both RESTRICTIVE so they narrow the tenant policy and never widen it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_employee', 'payroll_employment', 'payroll_dependent'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON crove_hr.%I', t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON crove_hr.%I AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))', t);
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS owner_admin ON crove_hr.%I', t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_admin ON crove_hr.%1$I AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %1$I.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
      'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %1$I.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))', t);
  END LOOP;
END $$;
