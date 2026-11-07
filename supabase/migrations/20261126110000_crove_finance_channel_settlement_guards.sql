-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, the Accounting PO's decision R1 on #2729): what keeps a marketplace income report from being counted twice, and the way back from a wrong confirmation. Idempotent;
-- applied files stay untouched. Both tables are append-only and empty (no writer exists yet), so the change is cheap now and would not be later.
--
--   1. A settlement of an entity and platform may not overlap the period of another that still stands (so 1-15 January and then 1-31 January cannot both stand). Only a settlement that has a
--      reversal, or that is itself a reversal, is out of the comparison. The old exact-match UNIQUE is replaced by this rule, which also covers it.
--   2. A sale line (sales > 0, not marked as a later adjustment) may not repeat for the same order and line key in another settlement that still stands.
--   3. The correction path: a settlement a member confirmed by mistake is undone by a REVERSAL, a second settlement with reversal_of set, for the same platform and period, whose report_net is the
--      negative of the original and whose lines mirror ALL of the original's (same order, line key and every amount column) marked as adjustments; a reversal row and its lines go in one transaction, and a
--      constraint trigger deferred to commit refuses a reversal that leaves an original line unmirrored. Nothing is updated or deleted. A reversal is made once per settlement, and a settlement that
--      has a reversal takes no more lines. The posting of a settlement (a later file) counts a reversal's lines negatively, so the two cancel, and the corrected report can then be imported again.
--   4. An adjustment line (adjustment = true) carries no sale (sales = 0, its amounts are refund and other), so marking a line as an adjustment never lets a sale in twice. A sale line is the
--      importer's to key by the platform's own row key; the same sale under another key is the importer's check (its tests), not this file's.
--
-- The checks are triggers (an exclusion constraint cannot ask "has this one been reversed", and Crove runs on any PostgreSQL 17 with no extension). Both take the same advisory lock, one per
-- entity and platform, before they look, so two imports, or a reversal and a line, cannot both pass; an order belongs to one platform, so one lock covers the order checks too and no two locks are
-- ever taken in different orders. The locks protect only at READ COMMITTED (the Runtime's default): a guard refuses to run in a stricter transaction rather than trust a stale snapshot. They are
-- SECURITY INVOKER: they see what the writer sees, and every query names the org and the entity.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.channel_settlement ADD COLUMN IF NOT EXISTS reversal_of uuid;
ALTER TABLE crove_finance.channel_settlement_line ADD COLUMN IF NOT EXISTS adjustment boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_finance.channel_settlement'::regclass AND conname = 'channel_settlement_reversal_fk') THEN
    ALTER TABLE crove_finance.channel_settlement ADD CONSTRAINT channel_settlement_reversal_fk
      FOREIGN KEY (org_id, legal_entity_id, reversal_of) REFERENCES crove_finance.channel_settlement (org_id, legal_entity_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_finance.channel_settlement'::regclass AND conname = 'channel_settlement_reversal_ck') THEN
    ALTER TABLE crove_finance.channel_settlement ADD CONSTRAINT channel_settlement_reversal_ck CHECK (reversal_of IS NULL OR reversal_of <> id);
  END IF;
END $$;
-- Backs the reversal foreign key (every tenant foreign key has an index that leads with its columns); the overlap guard also asks "has this settlement been reversed" by it.
CREATE INDEX IF NOT EXISTS channel_settlement_reversal_fk_idx ON crove_finance.channel_settlement (org_id, legal_entity_id, reversal_of);
-- One reversal per settlement.
CREATE UNIQUE INDEX IF NOT EXISTS channel_settlement_reversal_uq ON crove_finance.channel_settlement (org_id, reversal_of) WHERE reversal_of IS NOT NULL;
-- The overlap rule replaces the exact-match key (a reversal and a corrected re-import share the original's period).
ALTER TABLE crove_finance.channel_settlement DROP CONSTRAINT IF EXISTS channel_settlement_period_uq;

-- ---------------------------------------------------------------------------
-- 2. The guard of a settlement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.channel_settlement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_original crove_finance.channel_settlement%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_ISOLATION' USING ERRCODE = '25000', HINT = 'The settlement guards need READ COMMITTED.';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('channel_settlement:' OPERATOR(pg_catalog.||) NEW.org_id::text OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) NEW.legal_entity_id::text
    OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) NEW.platform, 0));
  IF NEW.reversal_of IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM crove_finance.channel_settlement s
      WHERE s.org_id = NEW.org_id AND s.legal_entity_id = NEW.legal_entity_id AND s.platform = NEW.platform
        AND s.reversal_of IS NULL AND s.period_start <= NEW.period_end AND s.period_end >= NEW.period_start
        AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)
    ) THEN
      RAISE EXCEPTION 'CHANNEL_SETTLEMENT_OVERLAP' USING ERRCODE = '23P01',
        HINT = 'A settlement of this platform already covers part of this period; reverse it first if it was confirmed by mistake.';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_original FROM crove_finance.channel_settlement o
    WHERE o.org_id = NEW.org_id AND o.legal_entity_id = NEW.legal_entity_id AND o.id = NEW.reversal_of;
  IF NOT FOUND OR v_original.reversal_of IS NOT NULL
     OR v_original.platform <> NEW.platform OR v_original.period_start <> NEW.period_start OR v_original.period_end <> NEW.period_end
     OR NEW.report_net <> - v_original.report_net THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_REVERSAL_MISMATCH' USING ERRCODE = '23514',
      HINT = 'A reversal names a settlement (not itself a reversal) of the same platform and period and states the negative of its report_net.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.channel_settlement_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
-- Named c_ so it runs after b_legal_entity has filled the entity.
DROP TRIGGER IF EXISTS c_channel_settlement_guard ON crove_finance.channel_settlement;
CREATE TRIGGER c_channel_settlement_guard BEFORE INSERT ON crove_finance.channel_settlement
  FOR EACH ROW EXECUTE FUNCTION crove_finance.channel_settlement_guard();
ALTER TABLE crove_finance.channel_settlement ENABLE ALWAYS TRIGGER c_channel_settlement_guard;

-- ---------------------------------------------------------------------------
-- 3. The guard of a line
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.channel_settlement_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_settlement crove_finance.channel_settlement%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_ISOLATION' USING ERRCODE = '25000', HINT = 'The settlement guards need READ COMMITTED.';
  END IF;
  SELECT * INTO v_settlement FROM crove_finance.channel_settlement s
    WHERE s.org_id = NEW.org_id AND s.legal_entity_id = NEW.legal_entity_id AND s.id = NEW.settlement_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key refuses a line of a settlement the writer cannot see
  END IF;
  -- The same lock as the settlement guard, taken before the first look at what stands.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('channel_settlement:' OPERATOR(pg_catalog.||) NEW.org_id::text OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) NEW.legal_entity_id::text
    OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) v_settlement.platform, 0));
  -- A line paid for an order of the platform its settlement is of: a Shopee report cannot carry a Lazada order (the order key is per platform, and one lock covers one platform's orders).
  IF EXISTS (
    SELECT 1 FROM crove_finance.channel_order o
    WHERE o.org_id = NEW.org_id AND o.legal_entity_id = NEW.legal_entity_id AND o.id = NEW.order_id AND o.platform <> v_settlement.platform
  ) THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_PLATFORM_MISMATCH' USING ERRCODE = '23514',
      HINT = 'A settlement line names an order of the same platform as its settlement.';
  END IF;
  IF v_settlement.reversal_of IS NOT NULL THEN
    -- A reversal's lines mirror the original's in every amount: the same order, line key and each amount column, marked as adjustments.
    IF NOT NEW.adjustment OR NOT EXISTS (
      SELECT 1 FROM crove_finance.channel_settlement_line l
      WHERE l.org_id = NEW.org_id AND l.legal_entity_id = NEW.legal_entity_id AND l.settlement_id = v_settlement.reversal_of
        AND l.order_id = NEW.order_id AND l.line_key = NEW.line_key
        AND l.sales = NEW.sales AND l.seller_discount = NEW.seller_discount AND l.commission = NEW.commission AND l.service_fee = NEW.service_fee
        AND l.payment_fee = NEW.payment_fee AND l.shipping = NEW.shipping AND l.tax_withheld = NEW.tax_withheld AND l.refund = NEW.refund
        AND l.other = NEW.other AND l.net = NEW.net
    ) THEN
      RAISE EXCEPTION 'CHANNEL_SETTLEMENT_REVERSAL_MISMATCH' USING ERRCODE = '23514',
        HINT = 'A line of a reversal repeats a line of the settlement it reverses, marked as an adjustment.';
    END IF;
    RETURN NEW;
  END IF;
  -- A settlement that has been reversed takes no more lines: they would never be cancelled.
  IF EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = NEW.org_id AND r.legal_entity_id = NEW.legal_entity_id AND r.reversal_of = NEW.settlement_id) THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_REVERSED' USING ERRCODE = '23514',
      HINT = 'This settlement was reversed; import the corrected report as a new settlement.';
  END IF;
  -- An adjustment carries no sale, so it can never be a second way for the same sale in.
  IF NEW.adjustment AND NEW.sales > 0 THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_ADJUSTMENT_SALE' USING ERRCODE = '23514',
      HINT = 'A line marked as a later adjustment has sales 0; its amounts are the refund and the other adjustment.';
  END IF;
  IF NOT NEW.adjustment AND NEW.sales > 0 AND EXISTS (
    SELECT 1 FROM crove_finance.channel_settlement_line l
    JOIN crove_finance.channel_settlement s ON s.org_id = l.org_id AND s.legal_entity_id = l.legal_entity_id AND s.id = l.settlement_id
    WHERE l.org_id = NEW.org_id AND l.legal_entity_id = NEW.legal_entity_id AND l.order_id = NEW.order_id AND l.line_key = NEW.line_key
      AND l.settlement_id <> NEW.settlement_id AND NOT l.adjustment AND l.sales > 0 AND s.reversal_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM crove_finance.channel_settlement r WHERE r.org_id = s.org_id AND r.legal_entity_id = s.legal_entity_id AND r.reversal_of = s.id)
  ) THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_LINE_DUPLICATE' USING ERRCODE = '23505',
      HINT = 'This sale line is already stored in another settlement that stands; reverse that settlement if it was confirmed by mistake.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.channel_settlement_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS c_channel_settlement_line_guard ON crove_finance.channel_settlement_line;
CREATE TRIGGER c_channel_settlement_line_guard BEFORE INSERT ON crove_finance.channel_settlement_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.channel_settlement_line_guard();
ALTER TABLE crove_finance.channel_settlement_line ENABLE ALWAYS TRIGGER c_channel_settlement_line_guard;

-- ---------------------------------------------------------------------------
-- 4. A reversal mirrors every line of its original (checked at commit, so the row and its lines can go in one transaction)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_finance.channel_settlement_reversal_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crove_finance.channel_settlement_line o
    WHERE o.org_id = NEW.org_id AND o.legal_entity_id = NEW.legal_entity_id AND o.settlement_id = NEW.reversal_of
      AND NOT EXISTS (
        SELECT 1 FROM crove_finance.channel_settlement_line m
        WHERE m.org_id = o.org_id AND m.legal_entity_id = o.legal_entity_id AND m.settlement_id = NEW.id
          AND m.order_id = o.order_id AND m.line_key = o.line_key
          AND m.sales = o.sales AND m.seller_discount = o.seller_discount AND m.commission = o.commission AND m.service_fee = o.service_fee
          AND m.payment_fee = o.payment_fee AND m.shipping = o.shipping AND m.tax_withheld = o.tax_withheld AND m.refund = o.refund
          AND m.other = o.other AND m.net = o.net
      )
  ) THEN
    RAISE EXCEPTION 'CHANNEL_SETTLEMENT_REVERSAL_INCOMPLETE' USING ERRCODE = '23514',
      HINT = 'A reversal repeats every line of the settlement it reverses.';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crove_finance.channel_settlement_reversal_complete() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS d_channel_settlement_reversal_complete ON crove_finance.channel_settlement;
CREATE CONSTRAINT TRIGGER d_channel_settlement_reversal_complete AFTER INSERT ON crove_finance.channel_settlement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.reversal_of IS NOT NULL)
  EXECUTE FUNCTION crove_finance.channel_settlement_reversal_complete();
ALTER TABLE crove_finance.channel_settlement ENABLE ALWAYS TRIGGER d_channel_settlement_reversal_complete;
