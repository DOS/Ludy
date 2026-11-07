-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2516, ADR-0045 points 5 and 7, plan stock-and-marketplaces.md section 8.4): the income reports of the marketplaces (Shopee, TikTok Shop, Lazada) a member confirmed, one
-- settlement per platform and period with its lines per order. Idempotent; applied files stay untouched. This file holds what an import stores; posting a settlement as an entry and matching
-- its payout to a bank line come in later files.
--
--   channel_settlement       one income report of one platform and period for one legal entity: the period, the platform's payout reference when the report shows one, and the net the report
--                            states for the whole period. Unique per entity, platform and period, so a re-uploaded report stores nothing twice. Keeps the hash of the file it came from.
--   channel_settlement_line  what the platform paid for one order: the sales, the seller's own discounts, the commission, the service and payment fees, the shipping, the tax the platform withheld,
--                            the refund, any other adjustment and the net. Amounts are decimals of the platform's currency (VND), never floating point; every deduction is stored as a positive
--                            amount and the net must equal what the columns say. Names an order the importer knows (channel_order), never a buyer.
--
-- Both tables have org_id, PRIMARY KEY (org_id, id) and RLS by org and legal entity; owners, admins and members insert (the roles that confirm an import), a viewer reads; no role updates or
-- deletes a row (APPEND-ONLY, like the books they feed). Kept with the books by the org purge.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Settlements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.channel_settlement (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('shopee', 'tiktok_shop', 'lazada')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- The platform's own reference of the payout (a statement or payment id), when the report shows one: what ties it to a bank line.
  payout_ref text CHECK (payout_ref IS NULL OR char_length(payout_ref) BETWEEN 1 AND 120),
  -- The net the report states for the whole period; the importer refuses a report whose lines do not add up to it.
  report_net numeric(20, 4) NOT NULL,
  -- The file the settlement came from: its hash. No foreign key: the file may be deleted (ADR-0045 point 8), the settlement stays.
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_settlement_period_ck CHECK (period_end >= period_start),
  CONSTRAINT channel_settlement_period_uq UNIQUE (org_id, legal_entity_id, platform, period_start, period_end),
  -- Backs the composite key of the lines: their entity is their settlement's.
  CONSTRAINT channel_settlement_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT channel_settlement_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
CREATE INDEX IF NOT EXISTS channel_settlement_entity_idx ON crove_finance.channel_settlement (legal_entity_id, org_id);
-- The Sàn screen lists an entity's settlements newest first.
CREATE INDEX IF NOT EXISTS channel_settlement_period_idx ON crove_finance.channel_settlement (org_id, legal_entity_id, period_end DESC);
SELECT crove_kernel.apply_tenant_rls('crove_finance.channel_settlement', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.channel_settlement;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.channel_settlement
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.channel_settlement ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.channel_settlement;
CREATE POLICY le_scope ON crove_finance.channel_settlement AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS channel_settlement_insert ON crove_finance.channel_settlement;
CREATE POLICY channel_settlement_insert ON crove_finance.channel_settlement AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_settlement.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
SELECT crove_kernel.make_append_only('crove_finance.channel_settlement');

-- ---------------------------------------------------------------------------
-- 2. Lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.channel_settlement_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  -- The order the platform paid for, one the importer knows.
  order_id uuid NOT NULL,
  -- The line inside its settlement: the report's row key (an order can have a sale line and later a refund line).
  line_key text NOT NULL CHECK (char_length(line_key) BETWEEN 1 AND 120),
  sales numeric(20, 4) NOT NULL DEFAULT 0 CHECK (sales >= 0),
  seller_discount numeric(20, 4) NOT NULL DEFAULT 0 CHECK (seller_discount >= 0),
  commission numeric(20, 4) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  service_fee numeric(20, 4) NOT NULL DEFAULT 0 CHECK (service_fee >= 0),
  payment_fee numeric(20, 4) NOT NULL DEFAULT 0 CHECK (payment_fee >= 0),
  shipping numeric(20, 4) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  -- The tax the platform withheld and settles for the seller (Decree 117/2025): only a household seller has one.
  tax_withheld numeric(20, 4) NOT NULL DEFAULT 0 CHECK (tax_withheld >= 0),
  refund numeric(20, 4) NOT NULL DEFAULT 0 CHECK (refund >= 0),
  -- Any other adjustment the report shows, positive or negative, so the net can always be said.
  other numeric(20, 4) NOT NULL DEFAULT 0,
  net numeric(20, 4) NOT NULL,
  source_row int CHECK (source_row IS NULL OR source_row > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_settlement_line_key_uq UNIQUE (org_id, settlement_id, line_key),
  -- What the platform paid is what the columns say.
  CONSTRAINT channel_settlement_line_net_ck CHECK (net = sales - seller_discount - commission - service_fee - payment_fee - shipping - tax_withheld - refund + other),
  CONSTRAINT channel_settlement_line_settlement_fk FOREIGN KEY (org_id, legal_entity_id, settlement_id) REFERENCES crove_finance.channel_settlement (org_id, legal_entity_id, id),
  CONSTRAINT channel_settlement_line_order_fk FOREIGN KEY (org_id, legal_entity_id, order_id) REFERENCES crove_finance.channel_order (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS channel_settlement_line_settlement_idx ON crove_finance.channel_settlement_line (org_id, legal_entity_id, settlement_id);
CREATE INDEX IF NOT EXISTS channel_settlement_line_order_idx ON crove_finance.channel_settlement_line (org_id, legal_entity_id, order_id);
CREATE INDEX IF NOT EXISTS channel_settlement_line_entity_idx ON crove_finance.channel_settlement_line (legal_entity_id, org_id);
SELECT crove_kernel.apply_tenant_rls('crove_finance.channel_settlement_line', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.channel_settlement_line;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, settlement_id ON crove_finance.channel_settlement_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.channel_settlement', 'settlement_id');
ALTER TABLE crove_finance.channel_settlement_line ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.channel_settlement_line;
CREATE POLICY le_scope ON crove_finance.channel_settlement_line AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS channel_settlement_line_insert ON crove_finance.channel_settlement_line;
CREATE POLICY channel_settlement_line_insert ON crove_finance.channel_settlement_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_settlement_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
SELECT crove_kernel.make_append_only('crove_finance.channel_settlement_line');
