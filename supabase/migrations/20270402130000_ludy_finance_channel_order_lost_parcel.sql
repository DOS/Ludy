-- SPDX-License-Identifier: AGPL-3.0-only
-- Ludy finance (#4265, follow-up of #4259 / #4262): track whether a shipped marketplace parcel is flagged lost (system-cancelled after carrier pickup or carrier lost/damaged/scrapped). Idempotent; applied files stay untouched.
--
-- ludy_finance.channel_order_line.lost_parcel
--     Set only while stage = 'shipped' (CHECK). Cleared only when the order later reaches 'returned' or 'completed'. Never moves to 'cancelled' while lost_parcel is true.
-- ludy_finance.channel_order_line_guard()
--     Preserves 20270213100000 rules and adds lost_parcel invariants: a lost parcel stays off 'cancelled' and clears only on 'returned' or 'completed'.
-- ludy_finance.stock_move_order_guard()
--     Preserves 20261124010000 rules and forbids return-to-stock moves while channel_order_line.lost_parcel is true.
SET LOCAL lock_timeout = '2s';

ALTER TABLE ludy_finance.channel_order_line
  ADD COLUMN IF NOT EXISTS lost_parcel boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'channel_order_line_lost_parcel_ck'
      AND conrelid = 'ludy_finance.channel_order_line'::pg_catalog.regclass
  ) THEN
    ALTER TABLE ludy_finance.channel_order_line
      ADD CONSTRAINT channel_order_line_lost_parcel_ck CHECK (NOT lost_parcel OR stage = 'shipped');
  END IF;
END $$;

GRANT UPDATE (lost_parcel) ON ludy_finance.channel_order_line TO ludy_tenant;

CREATE OR REPLACE FUNCTION ludy_finance.channel_order_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       OLD.stage = 'unknown'
       OR (OLD.stage = 'placed' AND NEW.stage IN ('shipped', 'completed', 'returned', 'cancelled'))
       OR (OLD.stage = 'shipped' AND NEW.stage IN ('completed', 'returned', 'cancelled'))
       OR (OLD.stage = 'completed' AND NEW.stage = 'returned')) THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  -- A shipped parcel flagged lost cannot move to cancelled (which would invite restock); it clears only on returned or completed.
  IF OLD.lost_parcel AND NEW.stage = 'cancelled' THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF OLD.lost_parcel AND NOT NEW.lost_parcel AND NEW.stage NOT IN ('completed', 'returned') THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  -- The delivery day is set once, from empty.
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt IS DISTINCT FROM OLD.attempt
     AND (NEW.attempt <> OLD.attempt + 1
          OR NOT EXISTS (
            SELECT 1 FROM ludy_finance.stock_move s
            WHERE s.org_id = OLD.org_id AND s.order_line_id = OLD.id AND s.order_move = 'ship' AND s.order_attempt = OLD.attempt)) THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_ATTEMPT' USING ERRCODE = '23514';
  END IF;
  -- A goods-back decision (#4355): made while the line is returned or cancelled, for its live attempt, once; never changed, cleared or moved to another attempt, and never in the same
  -- update that moves the attempt.
  IF NEW.goods_back IS DISTINCT FROM OLD.goods_back
     OR NEW.goods_back_attempt IS DISTINCT FROM OLD.goods_back_attempt
     OR NEW.goods_back_by IS DISTINCT FROM OLD.goods_back_by
     OR NEW.goods_back_at IS DISTINCT FROM OLD.goods_back_at THEN
    IF NEW.goods_back IS NULL
       OR NEW.stage NOT IN ('returned', 'cancelled')
       OR NEW.attempt IS DISTINCT FROM OLD.attempt
       OR NEW.goods_back_attempt IS DISTINCT FROM NEW.attempt
       OR (OLD.goods_back IS NOT NULL AND OLD.goods_back_attempt = NEW.attempt) THEN
      RAISE EXCEPTION 'CHANNEL_ORDER_RETURN' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.channel_order_line_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_finance.stock_move_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_line uuid;
  v_attempt int;
BEGIN
  IF NEW.source_type = 'order_line' AND NOT EXISTS (
       SELECT 1 FROM ludy_finance.channel_order_line l
       WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id AND l.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'STOCK_ORDER_ENTITY' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'order_line' AND NOT EXISTS (
       SELECT 1 FROM ludy_finance.channel_order_line l
       WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id
         AND ((NEW.order_move = 'ship' AND l.stage IN ('shipped', 'completed', 'returned'))
           OR (NEW.order_move = 'return' AND l.stage IN ('returned', 'cancelled') AND NOT l.lost_parcel))) THEN
    RAISE EXCEPTION 'STOCK_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'order_line' THEN
    -- The line row is held FOR SHARE while its attempt is read. The raise of the attempt (an UPDATE, FOR NO KEY UPDATE) does not conflict with the foreign key's FOR KEY SHARE, so a
    -- plain read could pass a move of the attempt that a transaction not committed yet is leaving, and both would commit with a return the reversal did not know. Held, the insert
    -- waits for that transaction and re-reads the line after it: a raise that committed fails the insert, and a raise that waits for this insert is refused at its commit.
    PERFORM 1 FROM ludy_finance.channel_order_line l
    WHERE l.org_id = NEW.org_id AND l.id = NEW.order_line_id AND l.attempt = NEW.order_attempt
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STOCK_ORDER_ATTEMPT' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source_type = 'reversal' THEN
    SELECT s.order_line_id, s.order_attempt INTO v_line, v_attempt
    FROM ludy_finance.stock_move s
    WHERE s.org_id = NEW.org_id AND s.id = NEW.reverses_move_id AND s.source_type = 'order_line';
    IF FOUND AND NOT EXISTS (
         SELECT 1 FROM ludy_finance.channel_order_line l
         WHERE l.org_id = NEW.org_id AND l.id = v_line AND l.attempt > v_attempt) THEN
      RAISE EXCEPTION 'STOCK_ORDER_REVERSAL' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source_type = 'order_line' AND NEW.order_move = 'return'
     AND NOT EXISTS (
       SELECT 1 FROM ludy_finance.stock_move s
       WHERE s.org_id = NEW.org_id AND s.order_line_id = NEW.order_line_id AND s.order_move = 'ship' AND s.order_attempt = NEW.order_attempt
         AND s.item_id = NEW.item_id AND s.quantity = -NEW.quantity) THEN
    RAISE EXCEPTION 'STOCK_ORDER_RETURN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ludy_finance.stock_move_order_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
