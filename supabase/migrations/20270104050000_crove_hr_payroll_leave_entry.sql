-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #3394, #2540 slice 1c-2, docs/plan/payroll.md section 5 rows 3 & 6.7, section 7, ADR-0046): monthly employee leave ledger. Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_leave_entry  one employee's monthly leave entry by kind (opening_balance, annual_leave, personal_paid, unpaid_leave), unique on (org_id, employee_id, month, kind).
--                               Supports 0.5-day increments (numeric(6, 2), 0..366). Owners and admins only, in the database and not only in the commands (RESTRICTIVE owner_admin and le_scope).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_hr.payroll_leave_entry (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('opening_balance', 'annual_leave', 'personal_paid', 'unpaid_leave')),
  days numeric(6, 2) NOT NULL CHECK (days >= 0 AND days <= 366),
  approved boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_leave_entry_slot_uq UNIQUE (org_id, employee_id, month, kind),
  CONSTRAINT payroll_leave_entry_employee_fk FOREIGN KEY (org_id, legal_entity_id, employee_id) REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_leave_entry_employee_idx ON crove_hr.payroll_leave_entry (org_id, legal_entity_id, employee_id, month);
CREATE INDEX IF NOT EXISTS payroll_leave_entry_entity_idx ON crove_hr.payroll_leave_entry (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_leave_entry');
REVOKE UPDATE ON crove_hr.payroll_leave_entry FROM crove_tenant;
GRANT UPDATE (days, approved, updated_at) ON crove_hr.payroll_leave_entry TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_leave_entry;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_leave_entry FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill('employee_id');
ALTER TABLE crove_hr.payroll_leave_entry ENABLE ALWAYS TRIGGER b_legal_entity;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON crove_hr.payroll_leave_entry';
  EXECUTE
    'CREATE POLICY le_scope ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
    'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))';
  EXECUTE 'DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_leave_entry';
  EXECUTE
    'CREATE POLICY owner_admin ON crove_hr.payroll_leave_entry AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = payroll_leave_entry.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
    'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = payroll_leave_entry.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';
END $$;
