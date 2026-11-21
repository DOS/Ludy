-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4303 S3a, parent #2520, plan stock-and-marketplaces.md section 8.4): the VAT rate of an entity's marketplace sales, as DATA with an effective date, never a constant in code
-- (the rate moved in 2026: 8% under Resolution 204/2025 until 2026-12-31, then 10%). The sales posting (S3b) splits the output VAT (33311) out of the price with this rate.
--
-- crove_finance.marketplace_vat_rate   per legal entity and effective date: the VAT method of its marketplace sales (`deduction`: the entity declares VAT by deduction, so a sale carries output VAT on
--                                      33311; `none`: it does not, e.g. a household on the percentage method or a direct-method company, so no 33311 line) and, for `deduction`, the rate in percent.
--                                      A row exists only because an owner or admin entered it, so a row IS the person's confirmation: until one covers a month the sales posting holds that month back.
--                                      A change is a new row from its date, never an edit of an earlier one (the books of a closed period keep the rate they were posted with). Tenant roles read and
--                                      insert; nothing updates or deletes a row. One rate for all goods of the entity (a seller with goods at several rates waits for the item-level rate, #4303 option A).
-- Idempotent; applied files stay untouched.
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS crove_finance.marketplace_vat_rate (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  effective_from date NOT NULL CHECK (effective_from >= DATE '2000-01-01'),
  -- `deduction`: output VAT on 33311 at `vat_percent`; `none`: no output VAT line (the rate stays NULL).
  method text NOT NULL CHECK (method IN ('deduction', 'none')),
  -- The rate in percent, a plain number with at most two decimals (8, 10, 5, 0, 8.5).
  vat_percent numeric(5, 2) CHECK (vat_percent IS NULL OR vat_percent BETWEEN 0 AND 100),
  CONSTRAINT marketplace_vat_rate_pair_ck CHECK ((method = 'deduction' AND vat_percent IS NOT NULL) OR (method = 'none' AND vat_percent IS NULL)),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT marketplace_vat_rate_entity_date_uq UNIQUE (org_id, legal_entity_id, effective_from),
  CONSTRAINT marketplace_vat_rate_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT marketplace_vat_rate_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS marketplace_vat_rate_entity_idx ON crove_finance.marketplace_vat_rate (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS marketplace_vat_rate_created_by_idx ON crove_finance.marketplace_vat_rate (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.marketplace_vat_rate');
REVOKE UPDATE, DELETE ON crove_finance.marketplace_vat_rate FROM crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.marketplace_vat_rate;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.marketplace_vat_rate
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.marketplace_vat_rate ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.marketplace_vat_rate;
CREATE POLICY le_scope ON crove_finance.marketplace_vat_rate AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
