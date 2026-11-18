-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #3712 slice 1, plan docs/plan/stock-and-marketplaces.md sections 8.2 and 8.3): a partial return of the goods of a sale. Idempotent; applied files stay untouched.
-- A sale here is a document line or a delivered CRM order line; a marketplace order line has its own return (the platform reports the order returned) and is left out.
-- Today a sale's stock-out can only be reversed whole (a reversal is the exact opposite of one move), so 3 pieces coming back of 10 sold cannot be recorded. This adds the source
-- `sale_return`: a stock-in of the same item that names the sale's stock-out it returns (return_of_move_id). The table stays append-only: undoing a return is the existing `reversal` row.
-- The CHECK constraints are added NOT VALID here (no scan of the table under the lock) and validated in the next file; the new rows are checked from the moment they exist.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS return_of_move_id uuid;

ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_type_check;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_type_check CHECK (source_type IN ('document_line', 'manual', 'reversal', 'order_line', 'count', 'crm_order_line', 'sale_return')) NOT VALID;

-- Each source names what it comes from and nothing else (20261202022500), and now a return: the sale move it returns, taking stock in.
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_ck;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_ck CHECK (
  CASE source_type
    WHEN 'document_line' THEN document_id IS NOT NULL AND line_no IS NOT NULL AND line_attempt IS NOT NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                              AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL AND return_of_move_id IS NULL
    WHEN 'order_line' THEN order_line_id IS NOT NULL AND order_move IS NOT NULL AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL
                           AND ((order_move = 'ship' AND quantity < 0) OR (order_move = 'return' AND quantity > 0))
                           AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL AND return_of_move_id IS NULL
    WHEN 'count' THEN count_line_id IS NOT NULL AND amount IS NOT NULL AND ((quantity > 0 AND amount > 0) OR (quantity < 0 AND amount < 0))
                      AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                      AND crm_order_id IS NULL AND crm_order_line_no IS NULL AND return_of_move_id IS NULL
    WHEN 'crm_order_line' THEN crm_order_id IS NOT NULL AND crm_order_line_no IS NOT NULL AND quantity < 0
                               AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                               AND count_line_id IS NULL AND amount IS NULL AND return_of_move_id IS NULL
    WHEN 'sale_return' THEN return_of_move_id IS NOT NULL AND quantity > 0
                            AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
                            AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL
    ELSE document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL AND order_attempt = 1
         AND count_line_id IS NULL AND amount IS NULL AND crm_order_id IS NULL AND crm_order_line_no IS NULL AND return_of_move_id IS NULL
  END
) NOT VALID;

ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_return_of_fk;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_return_of_fk FOREIGN KEY (org_id, return_of_move_id) REFERENCES crove_finance.stock_move (org_id, id) NOT VALID;
CREATE INDEX IF NOT EXISTS stock_move_return_of_idx ON crove_finance.stock_move (org_id, return_of_move_id) WHERE return_of_move_id IS NOT NULL;

-- What a return may be, and when a sale move may be reversed. Held apart from stock_move_guard (20261123030000), which stays as it is. One writer at a time per sale move (a transaction-level
-- advisory lock), so two returns at once cannot both take the last pieces: the second sees the first's row. A sale move is a stock-out (a document line or a delivered CRM order line); the return is of the same item, the sale move is not reversed, and the live returns (those not reversed) plus this one stay within what was sold. A sale move with a live
-- return is not reversed on its own: the returns are undone first (the void of a document does that).
CREATE OR REPLACE FUNCTION crove_finance.stock_move_return_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sold crove_finance.quantity;
  returned numeric;
BEGIN
  IF NEW.source_type = 'sale_return' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_finance.stock_move_return:' || NEW.org_id::text || ':' || NEW.return_of_move_id::text, 0));
    SELECT o.quantity INTO sold FROM crove_finance.stock_move o
     WHERE o.org_id = NEW.org_id AND o.id = NEW.return_of_move_id AND o.item_id = NEW.item_id AND o.legal_entity_id = NEW.legal_entity_id
       AND o.quantity < 0 AND o.source_type IN ('document_line', 'crm_order_line');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STOCK_RETURN_NOT_SALE' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = NEW.org_id AND r.reverses_move_id = NEW.return_of_move_id) THEN
      RAISE EXCEPTION 'STOCK_RETURN_REVERSED' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(pg_catalog.sum(m.quantity), 0) INTO returned FROM crove_finance.stock_move m
     WHERE m.org_id = NEW.org_id AND m.return_of_move_id = NEW.return_of_move_id AND m.source_type = 'sale_return'
       AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id);
    IF returned + NEW.quantity > -sold THEN
      RAISE EXCEPTION 'STOCK_RETURN_EXCEEDS' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_type = 'reversal' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crove_finance.stock_move_return:' || NEW.org_id::text || ':' || NEW.reverses_move_id::text, 0));
    IF EXISTS (
         SELECT 1 FROM crove_finance.stock_move m
          WHERE m.org_id = NEW.org_id AND m.return_of_move_id = NEW.reverses_move_id AND m.source_type = 'sale_return'
            AND NOT EXISTS (SELECT 1 FROM crove_finance.stock_move r WHERE r.org_id = m.org_id AND r.reverses_move_id = m.id)) THEN
      RAISE EXCEPTION 'STOCK_MOVE_HAS_RETURN' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_move_return_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_move_return_guard ON crove_finance.stock_move;
CREATE TRIGGER stock_move_return_guard BEFORE INSERT ON crove_finance.stock_move FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_move_return_guard();
