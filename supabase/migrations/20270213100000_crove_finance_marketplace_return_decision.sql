-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #4355, rule 8 of #2520, the stock side of a marketplace return): a person says whether the goods of a returned marketplace line came back. Idempotent; applied files stay untouched.
--
-- crove_finance.channel_order_line.goods_back, goods_back_attempt, goods_back_by, goods_back_at
--     The decision on a line that came back (stage returned, or cancelled after it shipped): 'back' (the goods are in the seller's hands again, a stock-in is written with it) or 'not_back' (a
--     refund-only claim, a loss: nothing moves). The platform's status is only the hint that offers the question. The decision is stored with the attempt of the line it was made for, the
--     member who made it and the time: all four are null or all four are set (CHECK). A line taken back from its item (a new attempt) is asked again for that attempt. Forward-only: no row is
--     rewritten here, a line that already has an automatic return move keeps it and is simply not offered (the offer needs "no return move yet").
-- crove_finance.channel_order_line_guard()
--     The body of 20270102040000 (the stage moves forward only, the shipping and delivery days are set once, the attempt goes up by one) with one more rule and nothing else changed: a decision
--     is set only while the line is returned or cancelled, only for the line's live attempt, only from empty or from an earlier attempt, and is never changed or cleared for the live attempt.
--     A tenant role may update the four columns (column grant), like the stage; the update policy already limits writers to owners, admins and members.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS goods_back text;
ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS goods_back_attempt integer;
ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS goods_back_by uuid;
ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS goods_back_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'channel_order_line_goods_back_ck'
                   AND conrelid = 'crove_finance.channel_order_line'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.channel_order_line
      ADD CONSTRAINT channel_order_line_goods_back_ck CHECK (
        (goods_back IS NULL AND goods_back_attempt IS NULL AND goods_back_by IS NULL AND goods_back_at IS NULL)
        OR (goods_back IN ('back', 'not_back') AND goods_back_attempt >= 1 AND goods_back_by IS NOT NULL AND goods_back_at IS NOT NULL)
      );
  END IF;
END $$;

GRANT UPDATE (goods_back, goods_back_attempt, goods_back_by, goods_back_at) ON crove_finance.channel_order_line TO crove_tenant;

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
  -- The delivery day is set once, from empty.
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'CHANNEL_ORDER_STAGE' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt IS DISTINCT FROM OLD.attempt
     AND (NEW.attempt <> OLD.attempt + 1
          OR NOT EXISTS (
            SELECT 1 FROM crove_finance.stock_move s
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

REVOKE ALL ON FUNCTION crove_finance.channel_order_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
