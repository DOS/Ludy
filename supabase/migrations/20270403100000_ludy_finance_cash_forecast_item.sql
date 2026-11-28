-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (issue #5326, plan docs/plan/cash-forecast.md "Not built", design approved on the issue): the items the owner enters into the 90-day cash forecast, the way to bring the costs it
-- cannot read (rent, loans, payroll, a one-off) into it. Idempotent; applied files stay untouched.
--
-- ludy_finance.cash_forecast_item   per org and legal entity: a label (the owner's own words, never sent to a model and never written to an audit row), a category (payroll, insurance, tax, rent,
--                                   loan, other: it is what the "left out" line of the forecast drops), the direction of the money (out or in), an amount (VND, above zero), a first date, a
--                                   recurrence (once, monthly or quarterly: the day of the first date each month or third month, a short month on its last day) and an optional end date.
--                                   finance.cash_forecast.item_set (R1, owner and admin, user actors only) creates and edits a row and finance.cash_forecast.item_remove deletes it; both are audited
--                                   (ids, category, direction, recurrence, amount and dates, never the label) and take an advisory lock per entity, so the cap of 100 items an entity (checked in the
--                                   command) holds under concurrent writers. Every member reads, as the forecast is read.
-- The entity of a row is the org's default unless the writer names one (trigger b_legal_entity with legal_entity_fill; the entity never changes after the insert), and le_scope narrows reads and writes
-- to the entities the caller may see, as on every finance table (#1280). Tenant roles read, insert and delete, and update the editable columns only (a column grant: never org_id, id, the entity, the
-- author or the creation date). The agent write guard that apply_tenant_rls installs refuses a write of an agent context. Rows go with the org: ludy_kernel.org_purge is restated with the table added in the next file, 20270403110000_ludy_kernel_org_purge_cash_forecast_item.sql (a ludy_kernel change).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ludy_finance.cash_forecast_item (
  org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND label = pg_catalog.btrim(label) AND label !~ '[[:cntrl:]]'),
  category text NOT NULL CHECK (category IN ('payroll', 'insurance', 'tax', 'rent', 'loan', 'other')),
  direction text NOT NULL CHECK (direction IN ('out', 'in')),
  amount numeric(20, 4) NOT NULL CHECK (amount > 0 AND amount <= 1000000000000000),
  first_date date NOT NULL CHECK (first_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  recurrence text NOT NULL CHECK (recurrence IN ('once', 'monthly', 'quarterly')),
  end_date date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT cash_forecast_item_end_ck CHECK (end_date IS NULL OR (recurrence <> 'once' AND end_date >= first_date)),
  CONSTRAINT cash_forecast_item_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES ludy_kernel.legal_entity (org_id, id),
  CONSTRAINT cash_forecast_item_member_fk FOREIGN KEY (org_id, created_by) REFERENCES ludy_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
-- The foreign keys (G3 fk-index); the forecast and the list read an entity's items by (org, entity).
CREATE INDEX IF NOT EXISTS cash_forecast_item_entity_idx ON ludy_finance.cash_forecast_item (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS cash_forecast_item_created_by_idx ON ludy_finance.cash_forecast_item (org_id, created_by) WHERE created_by IS NOT NULL;

SELECT ludy_kernel.apply_tenant_rls('ludy_finance.cash_forecast_item');
REVOKE ALL ON TABLE ludy_finance.cash_forecast_item FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT SELECT, INSERT, DELETE ON TABLE ludy_finance.cash_forecast_item TO ludy_tenant;
GRANT UPDATE (label, category, direction, amount, first_date, recurrence, end_date, updated_at) ON TABLE ludy_finance.cash_forecast_item TO ludy_tenant;

DROP TRIGGER IF EXISTS b_legal_entity ON ludy_finance.cash_forecast_item;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON ludy_finance.cash_forecast_item
  FOR EACH ROW EXECUTE FUNCTION ludy_finance.legal_entity_fill();
ALTER TABLE ludy_finance.cash_forecast_item ENABLE ALWAYS TRIGGER b_legal_entity;

DROP POLICY IF EXISTS le_scope ON ludy_finance.cash_forecast_item;
CREATE POLICY le_scope ON ludy_finance.cash_forecast_item AS RESTRICTIVE FOR ALL TO ludy_tenant
  USING ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT ludy_kernel.ctx_le_scope())::text[]));
