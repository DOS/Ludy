-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove HR (issue #2532, docs/plan/payroll.md section 6.4, ADR-0046): the layout of one bank's bulk-salary file. Idempotent; applied files stay untouched.
--
-- crove_hr.payroll_bank_template  a layout an org sets once per bank: the six columns of the file (sequence, name, account, bank, amount, content) in the order the bank wants,
--                                 each with the header it shows, and the text of the payment's content (`{month}` becomes MM/YYYY). An entity keeps several, one per bank, unique on
--                                 (org, entity, name). Ludy writes a file from it and never initiates a payment. It holds no person's data: the account numbers of the people stay sealed
--                                 on the employee rows and are opened only when a person exports the file (an audited, user-context export, never a worker or a stored job).
--
-- Owners and admins only, in the database and not only in the commands: the same RESTRICTIVE owner_admin and le_scope policies as the other crove_hr tables (20261124100000).
-- A template is configuration, not a record: its columns change and a template may be deleted by a tenant role; the org purge deletes it with the org.
SET LOCAL lock_timeout = '2s';

-- The shape of a layout: an object with a `columns` array of exactly the six columns, each once, each with a header of 1 to 60 characters, and a `content` text of 1 to 140
-- characters whose only brace form is `{month}`.
CREATE OR REPLACE FUNCTION crove_hr.bank_layout_valid(p_layout jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  -- A missing part gives NULL, which a CHECK would let through: the whole answer is false unless every part is true.
  SELECT coalesce(p_layout IS NOT NULL
    AND pg_catalog.jsonb_typeof(p_layout) = 'object'
    AND pg_catalog.jsonb_typeof(p_layout -> 'columns') = 'array'
    AND pg_catalog.jsonb_array_length(p_layout -> 'columns') = 6
    AND (SELECT pg_catalog.count(DISTINCT c ->> 'key') FROM pg_catalog.jsonb_array_elements(p_layout -> 'columns') AS c
         WHERE pg_catalog.jsonb_typeof(c) = 'object'
           AND (c ->> 'key') IN ('sequence', 'name', 'account', 'bank', 'amount', 'content')
           AND pg_catalog.jsonb_typeof(c -> 'header') = 'string'
           AND pg_catalog.length(c ->> 'header') BETWEEN 1 AND 60) = 6
    AND pg_catalog.jsonb_typeof(p_layout -> 'content') = 'string'
    AND pg_catalog.length(p_layout ->> 'content') BETWEEN 1 AND 140
    AND (p_layout ->> 'content') ~ '^([^{}]|\{month\})*$', false)
$$;
REVOKE ALL ON FUNCTION crove_hr.bank_layout_valid(jsonb) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_hr.bank_layout_valid(jsonb) TO crove_tenant;

CREATE TABLE IF NOT EXISTS crove_hr.payroll_bank_template (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- What the org calls it, usually the bank: unique per entity.
  name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 80),
  layout jsonb NOT NULL CHECK (crove_hr.bank_layout_valid(layout)),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT payroll_bank_template_name_uq UNIQUE (org_id, legal_entity_id, name),
  CONSTRAINT payroll_bank_template_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
CREATE INDEX IF NOT EXISTS payroll_bank_template_entity_idx ON crove_hr.payroll_bank_template (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_hr.payroll_bank_template');
-- Only the name, the layout and the stamp change; the entity, the creation and the identity never do. A template may be deleted (the grant stays).
REVOKE UPDATE ON crove_hr.payroll_bank_template FROM crove_tenant;
GRANT UPDATE (name, layout, updated_at) ON crove_hr.payroll_bank_template TO crove_tenant;

-- The row's legal entity: the one the writer names or, naming none, the org's default (as the other crove_hr tables). Fires in replica mode as well.
DROP TRIGGER IF EXISTS b_legal_entity ON crove_hr.payroll_bank_template;
CREATE TRIGGER b_legal_entity BEFORE INSERT ON crove_hr.payroll_bank_template FOR EACH ROW EXECUTE FUNCTION crove_hr.legal_entity_fill();
ALTER TABLE crove_hr.payroll_bank_template ENABLE ALWAYS TRIGGER b_legal_entity;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS le_scope ON crove_hr.payroll_bank_template';
  EXECUTE
    'CREATE POLICY le_scope ON crove_hr.payroll_bank_template AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])) '
    'WITH CHECK (''*'' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))';
  EXECUTE 'DROP POLICY IF EXISTS owner_admin ON crove_hr.payroll_bank_template';
  EXECUTE
    'CREATE POLICY owner_admin ON crove_hr.payroll_bank_template AS RESTRICTIVE FOR ALL TO crove_tenant '
    'USING ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = payroll_bank_template.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin''))) '
    'WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = ''user'' AND EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = payroll_bank_template.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN (''owner'', ''admin'')))';
END $$;
