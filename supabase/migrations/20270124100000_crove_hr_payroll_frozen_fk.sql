-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2720, review follow-up of #2531 / PR #2719): defence in depth for crove_hr.payroll_run and crove_hr.payroll_line.
-- Idempotent; applied files stay untouched.
--
-- 1. H4 + N1 (crove_hr.payroll_frozen_guard):
--    - Lock the parent crove_hr.payroll_run row FOR SHARE when checking a line write so under READ COMMITTED a concurrent raw
--      INSERT, UPDATE or DELETE on crove_hr.payroll_line waits behind hr.payroll.run.approve's UPDATE on crove_hr.payroll_run
--      and re-reads the committed 'approved' status instead of landing in a just-approved month.
--    - Refuse DELETE of kind = 'adjustment' lines even while the carrying run is a draft, unless crove_kernel.org_purge is running:
--      tenant DELETE on crove_hr.payroll_line exists only so recalculating a draft run can drop stale kind = 'pay' lines.
-- 2. H5b (composite foreign keys on crove_hr.payroll_line):
--    - Add UNIQUE (org_id, employee_id, id) on crove_hr.payroll_employment and widen payroll_line_employment_fk (plus its partial
--      index) to (org_id, employee_id, employment_id), so a line cannot name an employment row of another employee. Under MATCH SIMPLE,
--      nullable employment_id stays allowed when NULL and is strictly bound to (org_id, employee_id) when non-null.
--    - Widen payroll_line_adjusts_fk (plus its partial index) to (org_id, legal_entity_id, adjusts_run_id) referencing
--      crove_hr.payroll_run (org_id, legal_entity_id, id), so an adjustment line cannot reference a run of another legal entity.
SET LOCAL lock_timeout = '2s';

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
  -- payroll_line: lock the parent run FOR SHARE so a concurrent raw line write under READ COMMITTED blocks behind an
  -- approval's UPDATE of crove_hr.payroll_run and then observes the committed 'approved' status.
  SELECT r.status INTO v_status FROM crove_hr.payroll_run r
  WHERE r.org_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END
    AND r.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END
  FOR SHARE;
  -- An insert whose run the writer cannot see (another org's, one that does not exist) is left to the table's own checks, which come after this trigger: the row-level policies
  -- refuse the other org's row and the composite foreign key the missing run. An update or a delete only reaches a line the writer sees, whose run is visible the same way.
  IF v_status IS NULL AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF v_status = 'draft' AND (TG_OP <> 'UPDATE' OR (OLD.run_id = NEW.run_id AND OLD.employee_id = NEW.employee_id AND OLD.kind = NEW.kind)) THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.kind = 'adjustment' THEN
        RAISE EXCEPTION 'payroll adjustment line % cannot be deleted', OLD.id USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payroll line % belongs to a run that is frozen once approved', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION crove_hr.payroll_frozen_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = 'crove_hr.payroll_employment'::pg_catalog.regclass
      AND con.conname = 'payroll_employment_employee_id_uq'
  ) THEN
    ALTER TABLE crove_hr.payroll_employment
      ADD CONSTRAINT payroll_employment_employee_id_uq UNIQUE (org_id, employee_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_line_employment_idx'
      AND i.indnkeyatts = 3
  ) THEN
    DROP INDEX IF EXISTS crove_hr.payroll_line_employment_idx;
    CREATE INDEX payroll_line_employment_idx
      ON crove_hr.payroll_line (org_id, employee_id, employment_id)
      WHERE employment_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'crove_hr'
      AND c.relname = 'payroll_line_adjusts_idx'
      AND i.indnkeyatts = 3
  ) THEN
    DROP INDEX IF EXISTS crove_hr.payroll_line_adjusts_idx;
    CREATE INDEX payroll_line_adjusts_idx
      ON crove_hr.payroll_line (org_id, legal_entity_id, adjusts_run_id)
      WHERE adjusts_run_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = 'crove_hr.payroll_line'::pg_catalog.regclass
      AND con.conname = 'payroll_line_employment_fk'
      AND pg_catalog.cardinality(con.conkey) = 3
  ) THEN
    ALTER TABLE crove_hr.payroll_line DROP CONSTRAINT IF EXISTS payroll_line_employment_fk;
    ALTER TABLE crove_hr.payroll_line
      ADD CONSTRAINT payroll_line_employment_fk
      FOREIGN KEY (org_id, employee_id, employment_id)
      REFERENCES crove_hr.payroll_employment (org_id, employee_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = 'crove_hr.payroll_line'::pg_catalog.regclass
      AND con.conname = 'payroll_line_adjusts_fk'
      AND pg_catalog.cardinality(con.conkey) = 3
  ) THEN
    ALTER TABLE crove_hr.payroll_line DROP CONSTRAINT IF EXISTS payroll_line_adjusts_fk;
    ALTER TABLE crove_hr.payroll_line
      ADD CONSTRAINT payroll_line_adjusts_fk
      FOREIGN KEY (org_id, legal_entity_id, adjusts_run_id)
      REFERENCES crove_hr.payroll_run (org_id, legal_entity_id, id);
  END IF;
END $$;
