-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2531, docs/plan/payroll.md sections 6.2 and 6.3, ADR-0046): the monthly pay run. Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_run   one month of one legal entity: draft until an owner or admin approves it (a person, with a fresh second factor), then frozen. At most one run per
--                        entity and month. `approval` keeps what the approval rested on: the rules the lines used with their status and source, the totals and the
--                        fingerprint of the figures that were shown.
-- crove_hr.payroll_line  one person's month (kind `pay`) or a signed correction of an approved month, carried in a later run (kind `adjustment`). A `pay` line holds the month's
--                        inputs (typed, or copied from last month where they recur), the calculator's figures as facts and its breakdown, so a payslip is a view of
--                        stored facts, never a recomputation. When the calculator refuses a person's month the line says why and holds no figure.
--
-- Frozen: a draft run and its lines change; an approved run and its lines never do (a guard trigger on both tables, which lets only a closing org's purge delete them, as the
-- employment rows). A correction is an adjustment line in a later run.
--
-- Owners and admins only, in the database and not only in the commands: the same RESTRICTIVE owner_admin policy as the people tables (20261124100000).
SET LOCAL lock_timeout = '2s';

-- A line takes its run's legal entity when the writer names none (the run's own trigger does the same with the org's default entity).
CREATE OR REPLACE FUNCTION crove_hr.legal_entity_fill_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_entity uuid;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.legal_entity_id INTO v_entity FROM crove_hr.payroll_run r WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id;
  NEW.legal_entity_id := v_entity;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_hr.legal_entity_fill_run() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

CREATE TABLE IF NOT EXISTS crove_hr.payroll_run (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The pay month, YYYY-MM: the rules in force on its first day apply.
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- `paid` and `closed` belong to the posting and payment builds (#2532); this build writes draft and approved.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'closed')),
  -- Working days of the month under the contract (26, 22, ...): the divisor of unpaid days.
  working_days numeric(4, 1) NOT NULL CHECK (working_days > 0 AND working_days <= 31),
  approved_by uuid,
  approved_at timestamptz,
  approval jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- The target of the composite key of the lines, so a line cannot name another entity than its run.
  CONSTRAINT payroll_run_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT payroll_run_month_uq UNIQUE (org_id, legal_entity_id, month),
  CONSTRAINT payroll_run_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT payroll_run_approved_ck CHECK ((status = 'draft') = (approved_at IS NULL AND approved_by IS NULL AND approval IS NULL))
);
CREATE INDEX IF NOT EXISTS payroll_run_entity_idx ON crove_hr.payroll_run (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_run');
-- A run is never deleted by a tenant role (the org purge deletes as the table owner); only these columns change, and only while it is a draft (the guard below).
REVOKE DELETE, UPDATE ON crove_hr.payroll_run FROM crove_tenant;
GRANT UPDATE (working_days, status, approved_by, approved_at, approval, updated_at) ON crove_hr.payroll_run TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_hr.payroll_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  -- The terms the figures were computed from (a `pay` line); the rows are append-only, so the line recomputes to the same figures.
  employment_id uuid,
  kind text NOT NULL DEFAULT 'pay' CHECK (kind IN ('pay', 'adjustment')),
  -- `refused`: the calculator did not compute this person's month (refusal says why); the run cannot be approved with such a line.
  status text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'refused')),
  -- The month's inputs of a `pay` line (allowances, overtime, unpaid days, bonus, deductions ...): a JSON object shaped by the contract (zHrPayrollInputs).
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(inputs) = 'object'),
  gross numeric(20, 2),
  employee_insurance numeric(20, 2),
  employer_insurance numeric(20, 2),
  union_fee numeric(20, 2),
  taxable_income numeric(20, 2),
  pit numeric(20, 2),
  net numeric(20, 2),
  employer_cost numeric(20, 2),
  -- The calculator's breakdown, its checks and the rules it used (id, kind, key, effective date, status then): the facts a payslip shows.
  breakdown jsonb CHECK (breakdown IS NULL OR pg_catalog.jsonb_typeof(breakdown) = 'object'),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(checks) = 'array'),
  rules_used jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(rules_used) = 'array'),
  refusal text CHECK (refusal IS NULL OR pg_catalog.length(refusal) BETWEEN 1 AND 500),
  -- An adjustment line: the approved run it corrects and why.
  adjusts_run_id uuid,
  note text CHECK (note IS NULL OR pg_catalog.length(note) BETWEEN 1 AND 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_line_run_fk FOREIGN KEY (org_id, legal_entity_id, run_id) REFERENCES crove_hr.payroll_run (org_id, legal_entity_id, id),
  CONSTRAINT payroll_line_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT payroll_line_employment_fk FOREIGN KEY (org_id, employment_id) REFERENCES crove_hr.payroll_employment (org_id, id),
  CONSTRAINT payroll_line_adjusts_fk FOREIGN KEY (org_id, adjusts_run_id) REFERENCES crove_hr.payroll_run (org_id, id),
  -- A calculated line holds every figure; a refused one holds none and says why.
  CONSTRAINT payroll_line_figures_ck CHECK (
    (status = 'calculated' AND refusal IS NULL AND gross IS NOT NULL AND employee_insurance IS NOT NULL AND employer_insurance IS NOT NULL AND union_fee IS NOT NULL
      AND taxable_income IS NOT NULL AND pit IS NOT NULL AND net IS NOT NULL AND employer_cost IS NOT NULL)
    OR (status = 'refused' AND refusal IS NOT NULL AND gross IS NULL AND employee_insurance IS NULL AND employer_insurance IS NULL AND union_fee IS NULL
      AND taxable_income IS NULL AND pit IS NULL AND net IS NULL AND employer_cost IS NULL)
  ),
  -- A `pay` line names its terms; an adjustment names the run it corrects and says why, and is always calculated.
  CONSTRAINT payroll_line_kind_ck CHECK (
    (kind = 'pay' AND adjusts_run_id IS NULL AND note IS NULL)
    OR (kind = 'adjustment' AND adjusts_run_id IS NOT NULL AND note IS NOT NULL AND status = 'calculated' AND employment_id IS NULL)
  )
);
-- One pay line per person and run; the adjustments of a person are as many as the corrections.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_line_pay_uq ON crove_hr.payroll_line (org_id, run_id, employee_id) WHERE kind = 'pay';
-- The composite foreign keys' own indexes (a partial one counts only when its predicate is `col IS NOT NULL`).
CREATE INDEX IF NOT EXISTS payroll_line_run_idx ON crove_hr.payroll_line (org_id, legal_entity_id, run_id);
CREATE INDEX IF NOT EXISTS payroll_line_employee_idx ON crove_hr.payroll_line (org_id, legal_entity_id, employee_id);
CREATE INDEX IF NOT EXISTS payroll_line_employment_idx ON crove_hr.payroll_line (org_id, employment_id) WHERE employment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payroll_line_adjusts_idx ON crove_hr.payroll_line (org_id, adjusts_run_id) WHERE adjusts_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payroll_line_entity_idx ON crove_hr.payroll_line (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_line');
-- A line is never deleted by a tenant role; the identity, the run, the person and the creation never change.
REVOKE DELETE, UPDATE ON crove_hr.payroll_line FROM crove_tenant;
GRANT UPDATE (employment_id, status, inputs, gross, employee_insurance, employer_insurance, union_fee, taxable_income, pit, net, employer_cost, breakdown, checks, rules_used, refusal, updated_at)
  ON crove_hr.payroll_line TO crove_tenant;

-- The freeze. A run is inserted as a draft and changes only while it is one; a line is written, changed and removed only while its run is a draft. An approved run and its lines are
-- deleted by one caller only, the closing org's purge (the checks of crove_kernel.purge_append_only_guard, as the employment rows: the role that owns org_purge, the
-- transaction-local mark it sets around these deletes, the worker login in the org's system context, the org offboarding). Nested, so every other caller meets only the error.
CREATE OR REPLACE FUNCTION crove_hr.payroll_frozen_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE'
     AND (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = CURRENT_USER) = (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_kernel.org_purge(integer)'::pg_catalog.regprocedure)
     AND pg_catalog.current_setting('crove.org_purge', true) = OLD.org_id::text THEN
    IF pg_catalog.pg_has_role(SESSION_USER, 'crove_worker', 'MEMBER')
       AND crove_kernel.ctx_actor_type() = 'system'
       AND crove_kernel.ctx_org_id() = OLD.org_id
       AND EXISTS (SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = OLD.org_id AND t.status = 'offboarding') THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payroll_run' THEN
    IF TG_OP = 'INSERT' AND NEW.status = 'draft' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'draft' THEN
      RETURN NEW;
    END IF;
    -- A draft is not yet a record (a tenant role holds no DELETE on the table anyway); only an approved run is kept.
    IF TG_OP = 'DELETE' AND OLD.status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payroll run % is frozen once approved', CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END USING ERRCODE = '42501';
  END IF;
  -- payroll_line: the status of the run it belongs to, as the writer sees it (owners and admins see every run of their org).
  SELECT r.status INTO v_status FROM crove_hr.payroll_run r
  WHERE r.org_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END AND r.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  -- An insert whose run the writer cannot see (another org's, one that does not exist) is left to the table's own checks, which come after this trigger: the row-level policies
  -- refuse the other org's row and the composite foreign key the missing run. An update or a delete only reaches a line the writer sees, whose run is visible the same way.
  IF v_status IS NULL AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF v_status = 'draft' AND (TG_OP <> 'UPDATE' OR (OLD.run_id = NEW.run_id AND OLD.employee_id = NEW.employee_id AND OLD.kind = NEW.kind)) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payroll line % belongs to a run that is frozen once approved', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION crove_hr.payroll_frozen_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS frozen_row ON crove_hr.payroll_run;
CREATE TRIGGER frozen_row BEFORE INSERT OR UPDATE OR DELETE ON crove_hr.payroll_run FOR EACH ROW EXECUTE FUNCTION crove_hr.payroll_frozen_guard();
DROP TRIGGER IF EXISTS frozen_row ON crove_hr.payroll_line;
CREATE TRIGGER frozen_row BEFORE INSERT OR UPDATE OR DELETE ON crove_hr.payroll_line FOR EACH ROW EXECUTE FUNCTION crove_hr.payroll_frozen_guard();
-- Both guards fire in replica mode as well.
ALTER TABLE crove_hr.payroll_run ENABLE ALWAYS TRIGGER frozen_row;
ALTER TABLE crove_hr.payroll_line ENABLE ALWAYS TRIGGER frozen_row;

-- The row's legal entity: the org's default for a run, the run's for a line. Both fire in replica mode as well.
DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_run;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_run FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.payroll_run ENABLE ALWAYS TRIGGER b_legal_entity;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_line;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_line FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill_run();
ALTER TABLE crove_hr.payroll_line ENABLE ALWAYS TRIGGER b_legal_entity;

-- The legal-entity scope and the owner and admin gate, both RESTRICTIVE so they narrow the tenant policy and never widen it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_run', 'payroll_line'] LOOP
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS le_scope ON crove_hr.%I', t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY le_scope ON crove_hr.%I AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
      'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))', t);
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS owner_admin ON crove_hr.%I', t);
    EXECUTE pg_catalog.format(
      'CREATE POLICY owner_admin ON crove_hr.%I AS RESTRICTIVE FOR ALL TO crove_tenant '
      'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %I.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
      'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = %I.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))', t, t, t);
  END LOOP;
END $$;
