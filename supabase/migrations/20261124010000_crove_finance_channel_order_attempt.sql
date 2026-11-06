-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2633, ADR-0045 point 5): an order line given the wrong stock item can be unassigned. Idempotent; applied files stay untouched.
-- A marketplace order line (20261123100000) moves stock once: one shipment and one return, through the item a person chose, and a move of an order line was never reversible, so a
-- wrong item or factor stayed. This adds the way back without making the moves editable: the line has an attempt number and so does each of its moves. Unassigning moves the line to
-- the next attempt and reverses the moves of the attempt it leaves; the line is then unassigned again and a new assignment moves stock at the new attempt.
--
-- channel_order_line.attempt   the live attempt, 1 at first; a tenant role may raise it by one, and only while the live attempt has a shipment (a line that names no item has nothing to
--                              unassign). A constraint that is checked at commit refuses a raise that leaves a move of an older attempt without its reversal.
-- stock_move.order_attempt     the attempt of a shipment or a return of an order line, which must be the line's live one; 1 for every other move. A shipment and a return are unique per
--                              line, kind and attempt.
-- A reversal of a move of an order line is admitted only for an attempt the line has left behind, so no statement reverses the live stock of a line by itself.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1);
GRANT UPDATE (attempt) ON crove_finance.channel_order_line TO crove_tenant;
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS order_attempt int NOT NULL DEFAULT 1 CHECK (order_attempt >= 1);

-- One shipment and one return per order line and attempt: a re-uploaded report never moves the stock twice, and a new attempt can move it again. The index doubles as the foreign key's.
DROP INDEX IF EXISTS crove_finance.stock_move_order_uq;
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_order_attempt_uq ON crove_finance.stock_move (org_id, order_line_id, order_move, order_attempt) WHERE order_line_id IS NOT NULL;

-- The line's guard, as it was plus the attempt: it goes up by one and only while the live attempt has a shipment.
CREATE OR REPLACE FUNCTION crove_finance.channel_order_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       OLD.stage = 'unknown'
       OR (OLD.stage = 'placed' AND NEW.stage IN ('shipped', 'completed', 'returned', 'cancelled'))
       OR (OLD.stage = 'shipped' AND NEW.stage IN ('completed', 'returned', 'cancelled'))
       OR (OLD.stage = 'completed' AND NEW.stage = 'returned')) THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt IS DISTINCT FROM OLD.attempt
     AND (NEW.attempt <> OLD.attempt + 1
          OR NOT EXISTS (
            SELECT 1 FROM crove_finance.stock_move s
            WHERE s.org_id = OLD.org_id AND s.order_line_id = OLD.id AND s.order_move = 'ship' AND s.order_attempt = OLD.attempt)) THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_ATTEMPT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Checked at commit: a line that went to the next attempt has no move of an older attempt left without its reversal, so the raise and the reversals are one transaction.
CREATE OR REPLACE FUNCTION crove_finance.channel_order_line_attempt_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM crove_finance.stock_move m
       WHERE m.org_id = NEW.org_id AND m.order_line_id = NEW.id AND m.order_attempt < NEW.attempt
         AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id)) THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_ATTEMPT' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.channel_order_line_attempt_check() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS channel_order_line_attempt_ck ON crove_finance.channel_order_line;
CREATE CONSTRAINT TRIGGER channel_order_line_attempt_ck AFTER UPDATE OF attempt ON crove_finance.channel_order_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.attempt IS DISTINCT FROM OLD.attempt) EXECUTE FUNCTION crove_finance.channel_order_line_attempt_check();

-- The move guard, as it was (entity, stage, return needs its shipment, no reversal of an order-line move on its own) plus the attempt: a shipment or a return is of the line's live
-- attempt, a return needs the shipment of the same attempt, and a reversal of a move of an order line is admitted for an attempt the line has left behind.
CREATE OR REPLACE FUNCTION crove_finance.stock_move_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_line uuid;
  v_attempt int;
BEGIN
  IF NEW.source_type = 'order_line' AND NOT EXISTS (
       SELECT 1 FROM crove_finance.channel_order_line l
       WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id AND l.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'STOCK_ORDER_ENTITY' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'order_line' AND NOT EXISTS (
       SELECT 1 FROM crove_finance.channel_order_line l
       WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id
         AND ((NEW.order_move = 'ship' AND l.stage IN ('shipped', 'completed', 'returned'))
           OR (NEW.order_move = 'return' AND l.stage IN ('returned', 'cancelled')))) THEN
    RAISE EXCEPTION 'STOCK_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'order_line' AND NOT EXISTS (
       SELECT 1 FROM crove_finance.channel_order_line l
       WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id AND l.attempt = NEW.order_attempt) THEN
    RAISE EXCEPTION 'STOCK_ORDER_ATTEMPT' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'reversal' THEN
    SELECT s.order_line_id, s.order_attempt INTO v_line, v_attempt
    FROM crove_finance.stock_move s
    WHERE s.org_id = NEW.org_id AND s.id = NEW.reverses_move_id AND s.source_type = 'order_line';
    IF FOUND AND NOT EXISTS (
         SELECT 1 FROM crove_finance.channel_order_line l
         WHERE l.org_id = NEW.org_id AND l.id = v_line AND l.attempt > v_attempt) THEN
      RAISE EXCEPTION 'STOCK_ORDER_REVERSAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source_type = 'order_line' AND NEW.order_move = 'return'
     AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_move s
       WHERE s.org_id = NEW.org_id AND s.order_line_id = NEW.order_line_id AND s.order_move = 'ship' AND s.order_attempt = NEW.order_attempt
         AND s.item_id = NEW.item_id AND s.quantity = -NEW.quantity) THEN
    RAISE EXCEPTION 'STOCK_ORDER_RETURN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
