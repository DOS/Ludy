-- SPDX-License-Identifier: AGPL-3.0-only
-- Stage 3 slice 3b-2 (#3425, part of #3403): lightweight recruiting openings and candidate pipeline in crove_hr.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_hr.job_opening (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  title text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 160),
  department_name text CHECK (department_name IS NULL OR pg_catalog.length(pg_catalog.btrim(department_name)) BETWEEN 1 AND 120),
  contract_type text NOT NULL DEFAULT 'indefinite' CHECK (contract_type IN ('indefinite', 'fixed_term', 'none')),
  region text NOT NULL DEFAULT 'I' CHECK (region IN ('I', 'II', 'III', 'IV')),
  pay_function text NOT NULL DEFAULT 'admin' CHECK (pay_function IN ('admin', 'sales', 'production', 'overhead', 'construction')),
  budget_min_wage numeric(20, 2) CHECK (budget_min_wage IS NULL OR budget_min_wage >= 0),
  budget_max_wage numeric(20, 2) CHECK (budget_max_wage IS NULL OR budget_max_wage >= 0),
  required_skills text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT job_opening_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT job_opening_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT job_opening_budget_order CHECK (budget_min_wage IS NULL OR budget_max_wage IS NULL OR budget_max_wage >= budget_min_wage),
  CONSTRAINT job_opening_closed_consistent CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR (status = 'open' AND closed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS job_opening_org_entity_status_idx
  ON crove_hr.job_opening (org_id, legal_entity_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS crove_hr.candidate (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  opening_id uuid,
  display_name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 200),
  email text CHECK (email IS NULL OR pg_catalog.length(email) <= 320),
  phone text CHECK (phone IS NULL OR pg_catalog.length(phone) <= 40),
  stage text NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  years_experience smallint CHECK (years_experience IS NULL OR (years_experience >= 0 AND years_experience <= 80)),
  matched_skills text[] NOT NULL DEFAULT '{}',
  expected_wage numeric(20, 2) CHECK (expected_wage IS NULL OR expected_wage >= 0),
  agreed_wage numeric(20, 2) CHECK (agreed_wage IS NULL OR agreed_wage >= 0),
  planned_start_on date,
  notes text CHECK (notes IS NULL OR pg_catalog.length(notes) <= 2000),
  interview_event_id uuid,
  interview_starts_at timestamptz,
  interview_ends_at timestamptz,
  hired_employee_id uuid,
  erased_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT candidate_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT candidate_opening_fk FOREIGN KEY (org_id, legal_entity_id, opening_id) REFERENCES crove_hr.job_opening (org_id, legal_entity_id, id),
  CONSTRAINT candidate_interview_event_fk FOREIGN KEY (org_id, interview_event_id) REFERENCES crove_kernel.calendar_event (org_id, id),
  CONSTRAINT candidate_hired_employee_fk FOREIGN KEY (org_id, legal_entity_id, hired_employee_id) REFERENCES crove_hr.payroll_employee (org_id, legal_entity_id, id),
  CONSTRAINT candidate_interview_window CHECK (
    (interview_starts_at IS NULL AND interview_ends_at IS NULL) OR
    (interview_starts_at IS NOT NULL AND interview_ends_at IS NOT NULL AND interview_ends_at > interview_starts_at)
  ),
  CONSTRAINT candidate_hired_consistent CHECK (hired_employee_id IS NULL OR stage = 'hired')
);

CREATE INDEX IF NOT EXISTS candidate_org_entity_stage_idx
  ON crove_hr.candidate (org_id, legal_entity_id, stage, updated_at DESC);

CREATE INDEX IF NOT EXISTS candidate_opening_idx
  ON crove_hr.candidate (org_id, legal_entity_id, opening_id)
  WHERE opening_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS candidate_interview_event_idx
  ON crove_hr.candidate (org_id, interview_event_id)
  WHERE interview_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS candidate_hired_employee_idx
  ON crove_hr.candidate (org_id, legal_entity_id, hired_employee_id)
  WHERE hired_employee_id IS NOT NULL;

SELECT crove_kernel.apply_tenant_rls('crove_hr.job_opening');
REVOKE DELETE, UPDATE ON crove_hr.job_opening FROM crove_tenant;
GRANT UPDATE (title, department_name, contract_type, region, pay_function, budget_min_wage, budget_max_wage, required_skills, status, closed_at, updated_at)
  ON crove_hr.job_opening TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.job_opening;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON crove_hr.job_opening
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.job_opening ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON crove_hr.job_opening;
CREATE POLICY le_scope ON crove_hr.job_opening
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS owner_admin ON crove_hr.job_opening;
CREATE POLICY owner_admin ON crove_hr.job_opening
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = job_opening.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = job_opening.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));

SELECT crove_kernel.apply_tenant_rls('crove_hr.candidate');
REVOKE DELETE, UPDATE ON crove_hr.candidate FROM crove_tenant;
GRANT UPDATE (opening_id, display_name, email, phone, stage, years_experience, matched_skills, expected_wage, agreed_wage, planned_start_on, notes, interview_event_id, interview_starts_at, interview_ends_at, hired_employee_id, erased_at, updated_at)
  ON crove_hr.candidate TO crove_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.candidate;
CREATE TRIGGER b_legal_entity
  BEFORE INSERT ON crove_hr.candidate
  FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.candidate ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON crove_hr.candidate;
CREATE POLICY le_scope ON crove_hr.candidate
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));

DROP POLICY IF EXISTS owner_admin ON crove_hr.candidate;
CREATE POLICY owner_admin ON crove_hr.candidate
  AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = candidate.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'user' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = candidate.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin')));
