-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2513 part b, ADR-0045 point 2, plan stock-and-marketplaces.md section 8.2): the count of stock (kiểm kê) and the adjustment it makes. Idempotent; applied files stay untouched.
-- A count names the day the stock was counted and, per item, what was counted. Confirming it (the command is in modules/finance/src/stock-count.ts) posts the differences from the books as
-- adjustment moves and as one entry, through the proposal path, in one transaction: a shortage within a norm to 632 and beyond it to 1381, a surplus to 3381.
--
-- stock_count       the header: the day, a draft until it is confirmed or cancelled, the norm for a shortage (a percentage of the book quantity), and the voucher that posted the differences
--                   (empty when nothing differed). Never deleted; a tenant role changes its status, note, who confirmed it and the voucher, and a count that is not a draft is frozen.
-- stock_count_line  what was counted of one item, and the unit cost typed for it when the books have none. Never deleted; a tenant role changes the counted quantity while the count is a draft.
-- stock_move        gains count_line_id and amount: an adjustment is a move of source `count`, one per count line, that carries its own value (signed like its quantity). The books have
--                   no purchase to take the value of a surplus from, so the move holds it, and the month's cost counts it as a value in or out, never as a stock-out priced at the average.
--                   Moves are never reversed once written: a count is corrected by a new count.
-- journal_voucher   gains stock_count_id: the voucher that posts a count names it, one per count; a deferred guard on stock_count keeps a confirmed count from existing without it.
--
-- Quantities are crove_finance.quantity (numeric(20, 6)), amounts numeric(20, 4), never floating point. Both tables have org_id, PRIMARY KEY (org_id, id), RLS with a RESTRICTIVE `le_scope`
-- per legal entity, and a line has its count's entity. The org purge keeps both with the books.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Counts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_count (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  -- The day the stock was counted: not in the future, and in a month that is not closed.
  count_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  note text CHECK (note IS NULL OR pg_catalog.char_length(note) <= 300),
  -- How much of the book quantity of an item may be missing and still go to 632 (the rest of a shortage goes to 1381): a percentage.
  loss_norm_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (loss_norm_percent BETWEEN 0 AND 100),
  -- The members, as ids with no foreign key: removing a member must not update a count that is frozen (the books name their authors the same way).
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  -- The journal voucher that posted the differences: empty for a count with none.
  voucher_id uuid,
  PRIMARY KEY (org_id, id),
  -- Backs the composite key of the lines: their entity is their count's.
  CONSTRAINT stock_count_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT stock_count_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT stock_count_voucher_fk FOREIGN KEY (org_id, voucher_id) REFERENCES crove_finance.journal_voucher (org_id, id),
  CONSTRAINT stock_count_state_ck CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) AND (voucher_id IS NULL OR status = 'confirmed'))
);
CREATE INDEX IF NOT EXISTS stock_count_entity_idx ON crove_finance.stock_count (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS stock_count_date_idx ON crove_finance.stock_count (org_id, legal_entity_id, count_date DESC);
CREATE INDEX IF NOT EXISTS stock_count_voucher_idx ON crove_finance.stock_count (org_id, voucher_id) WHERE voucher_id IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_count');
-- A count is cancelled or confirmed, never deleted; only these columns change.
REVOKE DELETE, UPDATE ON crove_finance.stock_count FROM crove_tenant;
GRANT UPDATE (status, note, confirmed_by, confirmed_at, voucher_id) ON crove_finance.stock_count TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_count;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.stock_count
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.stock_count ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_count;
CREATE POLICY le_scope ON crove_finance.stock_count AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners, admins and members count (the roles that write stock); a viewer only reads. The command is the one write path.
DROP POLICY IF EXISTS stock_count_insert ON crove_finance.stock_count;
CREATE POLICY stock_count_insert ON crove_finance.stock_count AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS stock_count_update ON crove_finance.stock_count;
CREATE POLICY stock_count_update ON crove_finance.stock_count AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A count starts as a draft, on a day that has come and is in a month the stock has not closed; a count that is not a draft is frozen (it was confirmed or cancelled, and either is final).
CREATE OR REPLACE FUNCTION crove_finance.stock_count_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL OR NEW.voucher_id IS NOT NULL THEN
      RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
    END IF;
    IF NEW.count_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
      RAISE EXCEPTION 'STOCK_COUNT_FUTURE' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
         SELECT 1 FROM crove_finance.stock_period p
         WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month >= pg_catalog.date_trunc('month', NEW.count_date)::date) THEN
      RAISE EXCEPTION 'STOCK_COUNT_CLOSED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'STOCK_COUNT_FROZEN' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'draft' AND (NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL OR NEW.voucher_id IS NOT NULL) THEN
    RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND (NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL OR NEW.voucher_id IS NOT NULL) THEN
    RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_count_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_count_guard ON crove_finance.stock_count;
CREATE TRIGGER stock_count_guard BEFORE INSERT OR UPDATE ON crove_finance.stock_count FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_count_guard();

-- ---------------------------------------------------------------------------
-- 2. What was counted
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_count_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  count_id uuid NOT NULL,
  item_id uuid NOT NULL,
  counted_quantity crove_finance.quantity NOT NULL CHECK (counted_quantity >= 0),
  -- The unit cost the person typed for an item the books have no cost for (goods never bought, found in the count): the difference is priced at it. Empty to use the month's average.
  unit_cost numeric(20, 4) CHECK (unit_cost IS NULL OR unit_cost > 0),
  PRIMARY KEY (org_id, id),
  CONSTRAINT stock_count_line_uq UNIQUE (org_id, count_id, item_id),
  CONSTRAINT stock_count_line_count_fk FOREIGN KEY (org_id, legal_entity_id, count_id) REFERENCES crove_finance.stock_count (org_id, legal_entity_id, id),
  CONSTRAINT stock_count_line_item_fk FOREIGN KEY (org_id, legal_entity_id, item_id) REFERENCES crove_finance.stock_item (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS stock_count_line_count_idx ON crove_finance.stock_count_line (org_id, legal_entity_id, count_id);
CREATE INDEX IF NOT EXISTS stock_count_line_item_idx ON crove_finance.stock_count_line (org_id, legal_entity_id, item_id);
CREATE INDEX IF NOT EXISTS stock_count_line_entity_idx ON crove_finance.stock_count_line (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_count_line');
REVOKE DELETE, UPDATE ON crove_finance.stock_count_line FROM crove_tenant;
GRANT UPDATE (counted_quantity) ON crove_finance.stock_count_line TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_count_line;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, count_id ON crove_finance.stock_count_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.stock_count', 'count_id');
ALTER TABLE crove_finance.stock_count_line ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_count_line;
CREATE POLICY le_scope ON crove_finance.stock_count_line AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS stock_count_line_insert ON crove_finance.stock_count_line;
CREATE POLICY stock_count_line_insert ON crove_finance.stock_count_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS stock_count_line_update ON crove_finance.stock_count_line;
CREATE POLICY stock_count_line_update ON crove_finance.stock_count_line AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_count_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A line is entered and changed only while its count is a draft; the count is held while the line is read so it cannot be confirmed in between.
CREATE OR REPLACE FUNCTION crove_finance.stock_count_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM crove_finance.stock_count c WHERE c.org_id = NEW.org_id AND c.id = NEW.count_id AND c.status = 'draft' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOCK_COUNT_FROZEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_count_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_count_line_guard ON crove_finance.stock_count_line;
CREATE TRIGGER stock_count_line_guard BEFORE INSERT OR UPDATE ON crove_finance.stock_count_line FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_count_line_guard();

-- ---------------------------------------------------------------------------
-- 3. The adjustment moves
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS count_line_id uuid;
-- What the adjustment is worth, whole dong, signed like its quantity: a surplus brings value in and a shortage takes it out.
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS amount numeric(20, 4);
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_type_check;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_type_check CHECK (source_type IN ('document_line', 'manual', 'reversal', 'order_line', 'count'));
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_ck;
-- Each source names what it comes from and nothing else: a count line its line and the value of the adjustment, in the direction of the quantity.
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_ck CHECK (
  CASE source_type
    WHEN 'document_line' THEN document_id IS NOT NULL AND line_no IS NOT NULL AND line_attempt IS NOT NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                              AND count_line_id IS NULL AND amount IS NULL
    WHEN 'order_line' THEN order_line_id IS NOT NULL AND order_move IS NOT NULL AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL
                           AND ((order_move = 'ship' AND quantity < 0) OR (order_move = 'return' AND quantity > 0))
                           AND count_line_id IS NULL AND amount IS NULL
    WHEN 'count' THEN count_line_id IS NOT NULL AND amount IS NOT NULL AND ((quantity > 0 AND amount > 0) OR (quantity < 0 AND amount < 0))
                      AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
    ELSE document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
         AND count_line_id IS NULL AND amount IS NULL
  END
);
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_count_line_fk;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_count_line_fk FOREIGN KEY (org_id, count_line_id) REFERENCES crove_finance.stock_count_line (org_id, id);
-- One adjustment per count line. Doubles as the foreign key's index.
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_count_line_uq ON crove_finance.stock_move (org_id, count_line_id) WHERE count_line_id IS NOT NULL;

-- An adjustment is of a count that is confirmed, on the day of the count, of the item of its line and of the count's entity (the item's, filled by b_legal_entity, which fires first); and
-- an adjustment is never reversed: the count that was wrong is put right by a new count.
CREATE OR REPLACE FUNCTION crove_finance.stock_move_count_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.source_type = 'count' AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_count_line l
       JOIN crove_finance.stock_count c ON c.org_id = l.org_id AND c.id = l.count_id
       WHERE l.org_id = NEW.org_id AND l.id = NEW.count_line_id AND l.item_id = NEW.item_id
         AND c.status = 'confirmed' AND c.count_date = NEW.move_date AND c.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'STOCK_COUNT_MOVE' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'reversal' AND EXISTS (
       SELECT 1 FROM crove_finance.stock_move s WHERE s.org_id = NEW.org_id AND s.id = NEW.reverses_move_id AND s.source_type = 'count') THEN
    RAISE EXCEPTION 'STOCK_MOVE_COUNT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_move_count_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_move_count_guard ON crove_finance.stock_move;
CREATE TRIGGER stock_move_count_guard BEFORE INSERT ON crove_finance.stock_move FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_move_count_guard();

-- ---------------------------------------------------------------------------
-- 4. The voucher of a count
-- ---------------------------------------------------------------------------
-- The voucher that posts the differences of a count names it, one per count, and is no year closing and no close of a month of stock; it names the proposal that approved it.
ALTER TABLE crove_finance.journal_voucher ADD COLUMN IF NOT EXISTS stock_count_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_voucher_stock_count' AND conrelid = 'crove_finance.journal_voucher'::regclass) THEN
    ALTER TABLE crove_finance.journal_voucher
      ADD CONSTRAINT journal_voucher_stock_count CHECK (stock_count_id IS NULL OR (closing_year IS NULL AND stock_closing_month IS NULL AND proposal_id IS NOT NULL));
  END IF;
END
$$;
ALTER TABLE crove_finance.journal_voucher DROP CONSTRAINT IF EXISTS journal_voucher_stock_count_fk;
ALTER TABLE crove_finance.journal_voucher ADD CONSTRAINT journal_voucher_stock_count_fk FOREIGN KEY (org_id, stock_count_id) REFERENCES crove_finance.stock_count (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_voucher_stock_count_uq ON crove_finance.journal_voucher (org_id, stock_count_id) WHERE stock_count_id IS NOT NULL;

-- By commit (the voucher and the adjustments are written in the same transaction as the confirmation), a count that was confirmed has the voucher that posted its differences: of the same
-- entity, dated the day of the count, whose debits are what the adjustments are worth; and a count with no voucher has adjustments worth nothing (it had none). A count never exists
-- confirmed without its entry.
CREATE OR REPLACE FUNCTION crove_finance.stock_count_voucher_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_worth numeric;
BEGIN
  SELECT coalesce(pg_catalog.sum(pg_catalog.abs(m.amount)), 0) INTO v_worth
  FROM crove_finance.stock_move m
  JOIN crove_finance.stock_count_line l ON l.org_id = m.org_id AND l.id = m.count_line_id
  WHERE l.org_id = NEW.org_id AND l.count_id = NEW.id;
  IF NEW.voucher_id IS NULL THEN
    IF v_worth <> 0 THEN
      RAISE EXCEPTION 'STOCK_COUNT_VOUCHER' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
       SELECT 1
       FROM crove_finance.journal_voucher v
       JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL AND e.entry_date = v.voucher_date
       WHERE v.org_id = NEW.org_id AND v.id = NEW.voucher_id AND v.legal_entity_id = NEW.legal_entity_id AND v.stock_count_id = NEW.id AND v.voucher_date = NEW.count_date
         AND (SELECT coalesce(pg_catalog.sum(l.debit), 0) FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) = v_worth) THEN
    RAISE EXCEPTION 'STOCK_COUNT_VOUCHER' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_count_voucher_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_count_voucher_trg ON crove_finance.stock_count;
CREATE CONSTRAINT TRIGGER stock_count_voucher_trg AFTER UPDATE ON crove_finance.stock_count
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status = 'draft') EXECUTE FUNCTION crove_finance.stock_count_voucher_check();

-- ---------------------------------------------------------------------------
-- 5. The confirmation is a ledger command (finance.stock.count_confirm, approval policy 7)
-- ---------------------------------------------------------------------------
-- A journal voucher that names a proposal names one being executed by its own command: the count joins the four that post through postJournalVoucher.
DROP TRIGGER IF EXISTS a_effect_proposal ON crove_finance.journal_voucher;
CREATE TRIGGER a_effect_proposal BEFORE INSERT ON crove_finance.journal_voucher
  FOR EACH ROW EXECUTE FUNCTION crove_finance.effect_proposal_check('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period', 'finance.stock.count_confirm');

-- A ledger proposal moves to 'executed' only when its effect was posted in this transaction (20261105020000): the count's effect is an entry of a journal voucher that names the proposal.
-- Redefined as it was, with the command added.
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
    WHEN p_command IN ('finance.journal_voucher.record', 'finance.closing.record', 'finance.depreciation.record', 'finance.stock.close_period', 'finance.stock.count_confirm') THEN EXISTS (
      SELECT 1 FROM crove_finance.journal_voucher v
      JOIN crove_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id
      WHERE v.org_id = p_org AND v.proposal_id = p_proposal AND e.created_xact_id = v_xact AND e.created_xact_start = pg_catalog.now())
    ELSE false
  END;
END $$;
REVOKE ALL ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_finance.ledger_effect_recorded(uuid, uuid, text) TO crove_tenant;
