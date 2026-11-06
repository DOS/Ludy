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
-- journal_voucher.stock_closing_month  the voucher that posts a month's cost names the month it closes, one per entity and month; a deferred guard on stock_period keeps a month from
--                    existing without that voucher (posted, dated the month's last day, for the month's cost), or with a cost and none. The ledger effect and proposal checks learn the command.
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

-- A month is closed once it is over, and in order: not at or before a month that is closed, and with no move left in the months between the last closed month and this one (a month
-- with no move at all needs no close of its own).
CREATE OR REPLACE FUNCTION crove_finance.stock_period_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_from date;
BEGIN
  IF NEW.period_month + interval '1 month' > current_date THEN
    RAISE EXCEPTION 'STOCK_PERIOD_NOT_ENDED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM crove_finance.stock_period p
       WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month > NEW.period_month) THEN
    RAISE EXCEPTION 'STOCK_PERIOD_ORDER' USING ERRCODE = '23514';
  END IF;
  SELECT (pg_catalog.max(p.period_month) + interval '1 month')::date INTO v_from
  FROM crove_finance.stock_period p
  WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month < NEW.period_month;
  IF EXISTS (
       SELECT 1 FROM crove_finance.stock_move m
       WHERE m.org_id = NEW.org_id AND m.legal_entity_id = NEW.legal_entity_id AND m.move_date < NEW.period_month AND (v_from IS NULL OR m.move_date >= v_from)) THEN
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

-- ---------------------------------------------------------------------------
-- 4. A month's cost is posted by its own voucher
-- ---------------------------------------------------------------------------
-- The voucher of the close names the month it closes, as the closing of a year names its year, one per entity and month. It is dated in that month, is no year closing and names the proposal
-- that approved it (the effect check below ties that proposal to the command).
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS stock_closing_month date;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_stock_closing_month' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_stock_closing_month CHECK (
        stock_closing_month IS NULL
        OR (stock_closing_month = pg_catalog.date_trunc('month', voucher_date)::date AND closing_year IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_stock_closing_uq ON crove_finance.journal_voucher (org_id, legal_entity_id, stock_closing_month) WHERE stock_closing_month IS NOT NULL;

-- By commit (the items of the month are inserted after it), a closed month has the voucher that posted its cost: of the same entity and month, posted as an entry of its date whose debits
-- are the month's cost; and a month with no voucher has no cost, in its total and in what its items say went out. A month never exists without its Dr 632 / Cr stock voucher.
CREATE OR REPLACE FUNCTION crove_finance.stock_period_voucher_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.voucher_id IS NULL THEN
    IF NEW.total_cost <> 0
       OR (SELECT coalesce(pg_catalog.sum(i.out_value), 0) FROM crove_finance.stock_period_item i WHERE i.org_id = NEW.org_id AND i.period_id = NEW.id) <> 0 THEN
      RAISE EXCEPTION 'STOCK_PERIOD_VOUCHER' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
       SELECT 1
       FROM crove_finance.journal_voucher v
       JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL AND e.entry_date = v.voucher_date
       WHERE v.org_id = NEW.org_id AND v.id = NEW.voucher_id AND v.legal_entity_id = NEW.legal_entity_id AND v.stock_closing_month = NEW.period_month
         AND (SELECT coalesce(pg_catalog.sum(l.debit), 0) FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) = NEW.total_cost) THEN
    RAISE EXCEPTION 'STOCK_PERIOD_VOUCHER' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_period_voucher_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_period_voucher_trg ON crove_finance.stock_period;
CREATE CONSTRAINT TRIGGER stock_period_voucher_trg AFTER INSERT ON crove_finance.stock_period
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_period_voucher_check();

-- ---------------------------------------------------------------------------
-- 5. The close is a ledger command (finance.stock.close_period, approval policy 6)
-- ---------------------------------------------------------------------------
-- A journal voucher that names a proposal names one being executed by its own command: the close joins the three that post through postJournalVoucher (20261105120000).
DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.journal_voucher;
CREATE TRIGGER a_effect_proposal BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period');

-- And a ledger proposal moves to 'executed' only when its effect was posted in this transaction (20261105020000): the close's effect is an entry of a journal voucher that names the
-- proposal, like the other three. Redefined as it was, with the command added.
CREATE OR REPLACE FUNCTION crove_finance.ledger_effect_recorded(p_org uuid, p_proposal uuid, p_command text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM crove_kernel.ctx_org_id() THEN
    RETURN false;
  END IF;
  IF NOT coalesce((crove_kernel.approval_command_policy(p_command)).ledger, false) THEN
    RETURN true;
  END IF;
  -- Assigned already: the update this answers for has written.
  v_xact := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xact IS NULL THEN
    RETURN false;
  END IF;
  RETURN CASE
    WHEN p_command = 'finance.journal.reverse' THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_entry e
      WHERE e.org_id = p_org AND e.source_type = 'kernel.proposal' AND e.source_id = p_proposal AND e.reverses_entry_id IS NOT NULL
        AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.purchase.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.purchase_document d
      JOIN crove_finance.journal_entry e ON e.org_id = d.org_id AND e.source_type = 'finance.purchase_document' AND e.source_id = d.id
      WHERE d.org_id = p_org AND d.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command = 'finance.voucher.record' THEN EXISTS (
      SELECT 1 FROM crove_finance.cash_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.cash_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    WHEN p_command IN ('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period') THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    ELSE false
  END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) TO crove_tenant;
