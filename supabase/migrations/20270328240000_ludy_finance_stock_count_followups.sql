-- SPDX-License-Identifier: AGPL-3.0-only
-- Follow-ups from the #2681 stock count security review (#2682):
--   1. Enforce the latest confirmed stock count date floor against non-count stock moves
--      dated on or before a confirmed count, and prevent confirming an earlier-dated count
--      after a later confirmed count for any overlapping item.
--   2. Guard draft -> confirmed transitions on ludy_finance.stock_count so raw ludy_tenant
--      sessions cannot forge confirmed_by, spoof confirmed_at, or confirm a nonzero
--      difference without a posting voucher.
--   3. Revoke unused UPDATE column grants (note on ludy_finance.stock_count and
--      counted_quantity on ludy_finance.stock_count_line) from runtime roles.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Revoke unused UPDATE column grants (N3)
-- ---------------------------------------------------------------------------
REVOKE UPDATE (note) ON ludy_finance.stock_count FROM PUBLIC, ludy_tenant;
REVOKE UPDATE (counted_quantity) ON ludy_finance.stock_count_line FROM PUBLIC, ludy_tenant;

DO $$
DECLARE
  v_role name;
BEGIN
  FOR v_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE (rolname LIKE 'ludy\_%' OR rolname LIKE 'crove\_%')
      AND rolname <> current_user
      AND NOT rolsuper
  LOOP
    EXECUTE pg_catalog.format('REVOKE UPDATE (note) ON ludy_finance.stock_count FROM %I', v_role);
    EXECUTE pg_catalog.format('REVOKE UPDATE (counted_quantity) ON ludy_finance.stock_count_line FROM %I', v_role);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Book-quantity match check for voucher-less confirmations (N2)
-- ---------------------------------------------------------------------------
-- True only when the count exists, has at least one line, and every line's counted_quantity
-- equals the item's book quantity on count_date (closing of the latest closed month strictly
-- before count_date's month plus moves from the next day up through count_date).
CREATE OR REPLACE FUNCTION ludy_finance.stock_count_matches_books(p_org uuid, p_count uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count ludy_finance.stock_count%ROWTYPE;
  v_period_id uuid;
  v_from_date date;
BEGIN
  SELECT * INTO v_count FROM ludy_finance.stock_count c WHERE c.org_id = p_org AND c.id = p_count;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ludy_finance.stock_count_line l
    WHERE l.org_id = p_org AND l.legal_entity_id = v_count.legal_entity_id AND l.count_id = p_count
  ) THEN
    RETURN false;
  END IF;
  SELECT p.id, (p.period_month + interval '1 month')::date
  INTO v_period_id, v_from_date
  FROM ludy_finance.stock_period p
  WHERE p.org_id = p_org
    AND p.legal_entity_id = v_count.legal_entity_id
    AND p.period_month < pg_catalog.date_trunc('month', v_count.count_date)::date
  ORDER BY p.period_month DESC
  LIMIT 1;
  RETURN NOT EXISTS (
    SELECT 1
    FROM ludy_finance.stock_count_line l
    WHERE l.org_id = p_org
      AND l.legal_entity_id = v_count.legal_entity_id
      AND l.count_id = p_count
      AND l.counted_quantity IS DISTINCT FROM (
        coalesce((
          SELECT spi.closing_quantity
          FROM ludy_finance.stock_period_item spi
          WHERE v_period_id IS NOT NULL
            AND spi.org_id = p_org
            AND spi.period_id = v_period_id
            AND spi.item_id = l.item_id
        ), 0) +
        coalesce((
          SELECT pg_catalog.sum(m.quantity)
          FROM ludy_finance.stock_move m
          WHERE m.org_id = p_org
            AND m.legal_entity_id = v_count.legal_entity_id
            AND m.item_id = l.item_id
            AND m.move_date <= v_count.count_date
            AND (v_from_date IS NULL OR m.move_date >= v_from_date)
        ), 0)
      )
  );
END $$;
REVOKE ALL ON FUNCTION ludy_finance.stock_count_matches_books(uuid, uuid) FROM PUBLIC, ludy_app, ludy_worker;
GRANT EXECUTE ON FUNCTION ludy_finance.stock_count_matches_books(uuid, uuid) TO ludy_tenant, ludy_definer_tenant;

-- ---------------------------------------------------------------------------
-- 3. Strengthened stock_count_guard and stock_count_tied (N1 + N2)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ludy_finance.stock_count_guard() RETURNS trigger
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
         SELECT 1 FROM ludy_finance.stock_period p
         WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month >= pg_catalog.date_trunc('month', NEW.count_date)::date) THEN
      RAISE EXCEPTION 'STOCK_COUNT_CLOSED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'STOCK_COUNT_FROZEN' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('draft', 'cancelled') THEN
    IF NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL OR NEW.voucher_id IS NOT NULL THEN
      RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'confirmed' THEN
    RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'STOCK_COUNT_ISOLATION' USING ERRCODE = '25001';
  END IF;
  -- Take the entity's move lock alone so concurrent move inserts cannot race past count confirmation.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy_finance.stock_move:' || NEW.org_id::text || ':' || NEW.legal_entity_id::text, 0));
  IF NEW.count_date > (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'STOCK_COUNT_FUTURE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
       SELECT 1 FROM ludy_finance.stock_period p
       WHERE p.org_id = NEW.org_id AND p.legal_entity_id = NEW.legal_entity_id AND p.period_month >= pg_catalog.date_trunc('month', NEW.count_date)::date) THEN
    RAISE EXCEPTION 'STOCK_COUNT_CLOSED' USING ERRCODE = '23514';
  END IF;
  -- N1: refuse confirming an earlier-dated count when any line item already has a later confirmed count.
  IF EXISTS (
       SELECT 1
       FROM ludy_finance.stock_count_line l
       JOIN ludy_finance.stock_count_line l2 ON l2.org_id = l.org_id AND l2.legal_entity_id = l.legal_entity_id AND l2.item_id = l.item_id
       JOIN ludy_finance.stock_count c2 ON c2.org_id = l2.org_id AND c2.id = l2.count_id
       WHERE l.org_id = NEW.org_id
         AND l.legal_entity_id = NEW.legal_entity_id
         AND l.count_id = NEW.id
         AND c2.id <> NEW.id
         AND c2.legal_entity_id = NEW.legal_entity_id
         AND c2.status = 'confirmed'
         AND c2.count_date > NEW.count_date) THEN
    RAISE EXCEPTION 'STOCK_COUNT_ORDER' USING ERRCODE = '23514';
  END IF;
  -- N2: caller identity must match confirmed_by, and confirmed_at is stamped from the database clock.
  IF ludy_kernel.ctx_actor_type() = 'user' THEN
    IF ludy_kernel.ctx_user_id() IS NULL OR NEW.confirmed_by IS DISTINCT FROM ludy_kernel.ctx_user_id() THEN
      RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.confirmed_by IS NOT NULL THEN
    RAISE EXCEPTION 'STOCK_COUNT_STATE' USING ERRCODE = '23514';
  END IF;
  NEW.confirmed_at := pg_catalog.now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_finance.stock_count_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;

CREATE OR REPLACE FUNCTION ludy_finance.stock_count_tied(p_org uuid, p_count uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_count ludy_finance.stock_count%ROWTYPE;
  v_worth numeric;
BEGIN
  SELECT * INTO v_count FROM ludy_finance.stock_count c WHERE c.org_id = p_org AND c.id = p_count;
  IF NOT FOUND OR v_count.status <> 'confirmed' THEN
    RETURN false;
  END IF;
  SELECT coalesce(pg_catalog.sum(pg_catalog.abs(m.amount)), 0) INTO v_worth
  FROM ludy_finance.stock_move m
  JOIN ludy_finance.stock_count_line l ON l.org_id = m.org_id AND l.id = m.count_line_id
  WHERE l.org_id = p_org AND l.count_id = p_count;
  IF v_count.voucher_id IS NULL THEN
    RETURN v_worth = 0 AND ludy_finance.stock_count_matches_books(p_org, p_count);
  END IF;
  RETURN v_worth > 0 AND EXISTS (
    SELECT 1
    FROM ludy_finance.journal_voucher v
    JOIN ludy_finance.journal_entry e ON e.org_id = v.org_id AND e.source_type = 'finance.journal_voucher' AND e.source_id = v.id AND e.reverses_entry_id IS NULL AND e.entry_date = v.voucher_date
    WHERE v.org_id = p_org AND v.id = v_count.voucher_id AND v.legal_entity_id = v_count.legal_entity_id AND v.stock_count_id = v_count.id AND v.voucher_date = v_count.count_date
      AND NOT EXISTS (SELECT 1 FROM ludy_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id AND l.account_code NOT IN ('632', '1381', '3381') AND l.account_code NOT LIKE '156%')
      AND (SELECT coalesce(pg_catalog.sum(l.debit), 0) FROM ludy_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) = v_worth);
END $$;
REVOKE ALL ON FUNCTION ludy_finance.stock_count_tied(uuid, uuid) FROM PUBLIC, ludy_app, ludy_worker;
GRANT EXECUTE ON FUNCTION ludy_finance.stock_count_tied(uuid, uuid) TO ludy_tenant, ludy_definer_tenant;

-- ---------------------------------------------------------------------------
-- 4. Confirmed stock count date floor for stock moves (N1)
-- ---------------------------------------------------------------------------
-- Fires after b_legal_entity and before stock_move_closed_guard so every move writer
-- takes the ludy_finance advisory lock before stock_move_closed_guard's lock.
CREATE OR REPLACE FUNCTION ludy_finance.c_stock_move_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'STOCK_COUNT_ISOLATION' USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('ludy_finance.stock_move:' || NEW.org_id::text || ':' || NEW.legal_entity_id::text, 0));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_finance.c_stock_move_lock() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
DROP TRIGGER IF EXISTS c_stock_move_lock ON ludy_finance.stock_move;
CREATE TRIGGER c_stock_move_lock BEFORE INSERT ON ludy_finance.stock_move FOR EACH ROW EXECUTE FUNCTION ludy_finance.c_stock_move_lock();

CREATE OR REPLACE FUNCTION ludy_finance.stock_move_count_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.source_type = 'count' THEN
    IF NOT EXISTS (
         SELECT 1 FROM ludy_finance.stock_count_line l
         JOIN ludy_finance.stock_count c ON c.org_id = l.org_id AND c.id = l.count_id
         WHERE l.org_id = NEW.org_id AND l.legal_entity_id = NEW.legal_entity_id AND l.id = NEW.count_line_id AND l.item_id = NEW.item_id
           AND c.status = 'confirmed' AND c.voucher_id IS NOT NULL AND c.count_date = NEW.move_date AND c.legal_entity_id = NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'STOCK_COUNT_MOVE' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
         SELECT 1
         FROM ludy_finance.stock_count_line l2
         JOIN ludy_finance.stock_count c2 ON c2.org_id = l2.org_id AND c2.id = l2.count_id
         WHERE l2.org_id = NEW.org_id
           AND l2.legal_entity_id = NEW.legal_entity_id
           AND l2.item_id = NEW.item_id
           AND c2.legal_entity_id = NEW.legal_entity_id
           AND c2.status = 'confirmed'
           AND c2.count_date > NEW.move_date) THEN
      RAISE EXCEPTION 'STOCK_COUNT_ORDER' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
       SELECT 1
       FROM ludy_finance.stock_count_line l
       JOIN ludy_finance.stock_count c ON c.org_id = l.org_id AND c.id = l.count_id
       WHERE l.org_id = NEW.org_id
         AND l.legal_entity_id = NEW.legal_entity_id
         AND l.item_id = NEW.item_id
         AND c.legal_entity_id = NEW.legal_entity_id
         AND c.status = 'confirmed'
         AND c.count_date >= NEW.move_date) THEN
    RAISE EXCEPTION 'STOCK_COUNT_MOVE_DATE' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'reversal' AND EXISTS (
       SELECT 1 FROM ludy_finance.stock_move s WHERE s.org_id = NEW.org_id AND s.id = NEW.reverses_move_id AND s.source_type = 'count') THEN
    RAISE EXCEPTION 'STOCK_MOVE_COUNT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ludy_finance.stock_move_count_guard() FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
