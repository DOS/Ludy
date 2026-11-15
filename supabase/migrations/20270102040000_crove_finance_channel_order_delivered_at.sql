-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, marketplace rework to the AI consensus of 2026-11-15, slice B): the day an order line was delivered. Idempotent; applied files stay untouched.
--
-- crove_finance.channel_order_line.delivered_at  the day of successful delivery, read from the order report's completion column (the Shopee, TikTok Shop and Lazada profiles). Revenue belongs to
--     the month of this day (working answer A5 of #2520, pending the accountant), so the settlement posting that follows reads it; a line without it is refused there ("chờ ngày giao"), never
--     dated by a guess and never dated by shipped_at. It exists only on a line that has been delivered (completed) or was delivered and then returned (CHECK), is set once from empty
--     (the line's guard), and a later report may give it to a line that has none, never change it, as for shipped_at. A tenant role may update it (column grant), like the stage and the shipping day.
-- crove_finance.channel_order_line_guard()       the body of 20261124010000 (the stage moves forward only, the shipping day and now the delivery day are set once, the attempt goes up by one) with
--     the rule for the delivery day. Nothing else in it changes.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_finance.channel_order_line ADD COLUMN IF NOT EXISTS delivered_at date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'channel_order_line_delivered_ck'
                   AND conrelid = 'crove_finance.channel_order_line'::pg_catalog.regclass) THEN
    ALTER TABLE crove_finance.channel_order_line
      ADD CONSTRAINT channel_order_line_delivered_ck CHECK (delivered_at IS NULL OR stage IN ('completed', 'returned'));
  END IF;
END $$;

GRANT UPDATE (delivered_at) ON crove_finance.channel_order_line TO crove_tenant;

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
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_finance.channel_order_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
