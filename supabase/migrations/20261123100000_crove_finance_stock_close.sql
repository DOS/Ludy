-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2513, ADR-0045 point 2, plan stock-and-marketplaces.md section 8.3): the close of a month of stock. Idempotent; applied files stay untouched.
-- The close prices every stock-out of the month at the month's weighted average and posts one entry, Dr 632 / Cr the stock accounts, through the proposal path (the command is in
-- modules/finance/src/stock-close.ts); this file holds what it leaves behind and the guard that keeps a closed month closed.
--
-- stock_period       one closed month of one legal entity: the first day of the month, the voucher that posted its cost (empty when nothing went out) and the cost. Unique per entity
--                    and month. APPEND-ONLY, like the books it belongs to: no role updates or deletes a row, and the org purge keeps it with the ledger.
-- stock_period_item  what that month held of one item: opening, in, out and closing quantity and value, and the unit cost the month's average gave (empty when there was no quantity to
--                    spread the value over). Append-only too. A report of a closed month reads these rows, and the month after opens with their closing.
-- stock_move_closed_guard  no move is dated in a month that is closed, or before one: a correction is a move of the open month (the command that writes the move dates it there).
--
-- Quantities are crove_finance.quantity, values numeric(20, 4), the unit cost numeric(28, 10); never floating point. Both tables have org_id, PRIMARY KEY (org_id, id), RLS with a
-- RESTRICTIVE `le_scope` per legal entity, and an item row has its period's entity.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Closed months
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_period (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The first day of the month.
  period_month date NOT NULL CHECK (period_month = pg_catalog.date_trunc('month', period_month)::date),
  -- The journal voucher that posted the cost of goods sold of the month: empty when nothing went out.
  voucher_id uuid,
  total_cost numeric(20, 4) NOT NULL DEFAULT 0,
  -- The member who closed it, as an id with no foreign key: removing a member must not update an append-only row.
  closed_by uuid,
  closed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT stock_period_month_uq UNIQUE (org_id, legal_entity_id, period_month),
  -- Backs the composite key of the items: their entity is their period's.
  CONSTRAINT stock_period_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT stock_period_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT stock_period_voucher_fk FOREIGN KEY (org_id, voucher_id) REFERENCES crove_finance.journal_voucher (org_id, id),
  -- A cost that was posted names the voucher that posted it.
  CONSTRAINT stock_period_voucher_ck CHECK (total_cost = 0 OR voucher_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS stock_period_entity_idx ON crove_finance.stock_period (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS stock_period_voucher_idx ON crove_finance.stock_period (org_id, voucher_id) WHERE voucher_id IS NOT NULL;
-- SELECT and INSERT only: no UPDATE or DELETE grant for a tenant role.
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_period', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_period;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.stock_period
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.stock_period ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_period;
CREATE POLICY le_scope ON crove_finance.stock_period AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners, admins and members close a month (the roles that approve entries); a viewer only reads. The command is the one write path.
DROP POLICY IF EXISTS stock_period_insert ON crove_finance.stock_period;
CREATE POLICY stock_period_insert ON crove_finance.stock_period AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_period.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
SELECT crove_kernel.make_append_only('crove_finance.stock_period');

-- A month is closed once it is over, and in order: the month before has to be closed unless the entity has no move before this one.
CREATE OR REPLACE FUNCTION crove_finance.stock_period_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.period_month + interval '1 month' > pg_catalog.current_date THEN
    RAISE EXCEPTION 'STOCK_PERIOD_NOT_ENDED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM crove_finance.stock_move m
       WHERE m.org_id = NEW.org_id AND m.legal_entity_id = NEW.legal_entity_id AND m.move_date < NEW.period_month)
     AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_period p
       WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month = (NEW.period_month - interval '1 month')::date) THEN
    RAISE EXCEPTION 'STOCK_PERIOD_ORDER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_period_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_period_guard ON crove_finance.stock_period;
CREATE TRIGGER stock_period_guard BEFORE INSERT ON crove_finance.stock_period FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_period_guard();

-- ---------------------------------------------------------------------------
-- 2. What a closed month held of each item
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_period_item (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  period_id uuid NOT NULL,
  item_id uuid NOT NULL,
  opening_quantity crove_finance.quantity NOT NULL DEFAULT 0,
  opening_value numeric(20, 4) NOT NULL DEFAULT 0,
  in_quantity crove_finance.quantity NOT NULL DEFAULT 0,
  in_value numeric(20, 4) NOT NULL DEFAULT 0,
  out_quantity crove_finance.quantity NOT NULL DEFAULT 0,
  out_value numeric(20, 4) NOT NULL DEFAULT 0,
  closing_quantity crove_finance.quantity NOT NULL DEFAULT 0,
  closing_value numeric(20, 4) NOT NULL DEFAULT 0,
  -- (opening value + value in) / (opening quantity + quantity in); empty when there was no quantity to spread it over.
  unit_cost numeric(28, 10),
  PRIMARY KEY (org_id, id),
  CONSTRAINT stock_period_item_uq UNIQUE (org_id, period_id, item_id),
  CONSTRAINT stock_period_item_period_fk FOREIGN KEY (org_id, legal_entity_id, period_id) REFERENCES crove_finance.stock_period (org_id, legal_entity_id, id),
  CONSTRAINT stock_period_item_item_fk FOREIGN KEY (org_id, legal_entity_id, item_id) REFERENCES crove_finance.stock_item (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS stock_period_item_item_idx ON crove_finance.stock_period_item (org_id, legal_entity_id, item_id);
CREATE INDEX IF NOT EXISTS stock_period_item_entity_idx ON crove_finance.stock_period_item (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_period_item', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_period_item;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, period_id ON crove_finance.stock_period_item
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.stock_period', 'period_id');
ALTER TABLE crove_finance.stock_period_item ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_period_item;
CREATE POLICY le_scope ON crove_finance.stock_period_item AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS stock_period_item_insert ON crove_finance.stock_period_item;
CREATE POLICY stock_period_item_insert ON crove_finance.stock_period_item AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_period_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
SELECT crove_kernel.make_append_only('crove_finance.stock_period_item');

-- ---------------------------------------------------------------------------
-- 3. A closed month stays closed
-- ---------------------------------------------------------------------------
-- No move is dated in a month that is closed or before one (months close in order, so that is every month up to the last closed). The entity is the item's, filled by
-- b_legal_entity, which fires first. The org purge deletes no move, so it never meets this.
CREATE OR REPLACE FUNCTION crove_finance.stock_move_closed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM crove_finance.stock_period p
       WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month >= pg_catalog.date_trunc('month', NEW.move_date)::date) THEN
    RAISE EXCEPTION 'STOCK_PERIOD_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_move_closed_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_move_closed_guard ON crove_finance.stock_move;
CREATE TRIGGER stock_move_closed_guard BEFORE INSERT ON crove_finance.stock_move FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_move_closed_guard();
