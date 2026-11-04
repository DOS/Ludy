-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2515, ADR-0045 points 4, 5 and 7): the orders of the marketplaces (Shopee, TikTok Shop, Lazada) a member confirmed from a report file, and the stock moves they
-- make. Idempotent; applied files stay untouched.
--
--   channel_order        one order of a platform: the platform, the platform's order number and the day. No buyer data of any kind: the report's buyer columns are never read.
--                        Immutable: a re-uploaded report adds only what is new.
--   channel_order_line   one line of an order: the SKU, the quantity, the amounts and how far it has got (the stage). A line's stage only moves forward (placed, shipped,
--                        completed, returned; cancelled from placed): a re-upload that shows a later stage moves it, one that shows an earlier stage changes nothing. It keeps the hash
--                        of the file it first came from and the file's row number, as provenance.
--   stock_move           gains order_line_id and order_move: a shipment is a move out and a return a move in, each once per order line, so a re-upload never moves stock twice.
--
-- Tenant tables: RLS by org and legal entity, owners, admins and members write (the roles that confirm an import), a viewer reads. Kept with the books by the org purge, like the
-- stock moves that name them.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.channel_order (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('shopee', 'tiktok_shop', 'lazada')),
  order_no text NOT NULL CHECK (char_length(order_no) BETWEEN 1 AND 64),
  ordered_at date,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_order_no_uq UNIQUE (org_id, legal_entity_id, platform, order_no),
  -- Backs the composite key of the lines: their entity is their order's.
  CONSTRAINT channel_order_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT channel_order_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id)
);
CREATE INDEX IF NOT EXISTS channel_order_entity_idx ON crove_finance.channel_order (legal_entity_id, org_id);
-- The orders screen lists an entity's orders newest first.
CREATE INDEX IF NOT EXISTS channel_order_day_idx ON crove_finance.channel_order (org_id, legal_entity_id, ordered_at DESC);
-- SELECT and INSERT only: no UPDATE or DELETE grant for a tenant role.
SELECT crove_kernel.apply_tenant_rls('crove_finance.channel_order', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.channel_order;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.channel_order
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.channel_order ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.channel_order;
CREATE POLICY le_scope ON crove_finance.channel_order AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS channel_order_insert ON crove_finance.channel_order;
CREATE POLICY channel_order_insert ON crove_finance.channel_order AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_order.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- ---------------------------------------------------------------------------
-- 2. Lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.channel_order_line (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  order_id uuid NOT NULL,
  -- The line inside its order: the unit's own item id (Lazada), else the SKU with the variation, else the product name; a repeated key in one order gets "#2" and so on.
  line_key text NOT NULL CHECK (char_length(line_key) BETWEEN 1 AND 120),
  sku text CHECK (sku IS NULL OR char_length(sku) BETWEEN 1 AND 100),
  item_name text CHECK (item_name IS NULL OR char_length(item_name) BETWEEN 1 AND 200),
  quantity numeric(20, 6) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20, 4),
  amount numeric(20, 4),
  -- How far the line has got: stock goes out at shipped (and stays out at completed), comes back with returned; cancelled before shipment moves nothing.
  stage text NOT NULL CHECK (stage IN ('placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown')),
  shipped_at date,
  -- The first file the line came from: its hash and the file's row number. No foreign key: the original file may be deleted (ADR-0045 point 8), the line stays.
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_row int CHECK (source_row IS NULL OR source_row > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT channel_order_line_key_uq UNIQUE (org_id, order_id, line_key),
  CONSTRAINT channel_order_line_order_fk FOREIGN KEY (org_id, legal_entity_id, order_id) REFERENCES crove_finance.channel_order (org_id, legal_entity_id, id)
);
CREATE INDEX IF NOT EXISTS channel_order_line_order_idx ON crove_finance.channel_order_line (org_id, legal_entity_id, order_id);
CREATE INDEX IF NOT EXISTS channel_order_line_entity_idx ON crove_finance.channel_order_line (legal_entity_id, org_id);
-- The lines still to assign to an item are found by SKU.
CREATE INDEX IF NOT EXISTS channel_order_line_sku_idx ON crove_finance.channel_order_line (org_id, legal_entity_id, sku);
SELECT crove_kernel.apply_tenant_rls('crove_finance.channel_order_line');
-- A line is never deleted, and only its stage, shipping day and the time touched change.
REVOKE DELETE, UPDATE ON crove_finance.channel_order_line FROM crove_tenant;
GRANT UPDATE (stage, shipped_at, updated_at) ON crove_finance.channel_order_line TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.channel_order_line;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, order_id ON crove_finance.channel_order_line
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.channel_order', 'order_id');
ALTER TABLE crove_finance.channel_order_line ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.channel_order_line;
CREATE POLICY le_scope ON crove_finance.channel_order_line AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS channel_order_line_insert ON crove_finance.channel_order_line;
CREATE POLICY channel_order_line_insert ON crove_finance.channel_order_line AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_order_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS channel_order_line_update ON crove_finance.channel_order_line;
CREATE POLICY channel_order_line_update ON crove_finance.channel_order_line AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_order_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = channel_order_line.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- A line's stage only moves forward: placed to shipped, completed, returned or cancelled; shipped to completed, returned or cancelled (a failed delivery: the goods come back like a
-- return); completed to returned; an unknown status to any. Cancelled and returned are final. The same stage is no move, and the shipping day is set once, from empty.
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
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.channel_order_line_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS channel_order_line_guard ON crove_finance.channel_order_line;
CREATE TRIGGER channel_order_line_guard BEFORE UPDATE ON crove_finance.channel_order_line FOR EACH ROW EXECUTE FUNCTION crove_finance.channel_order_line_guard();

-- ---------------------------------------------------------------------------
-- 3. Stock moves from order lines
-- ---------------------------------------------------------------------------
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS order_line_id uuid;
-- ship: the stock a shipped line takes out (negative); return: what a returned line brings back (positive). Each once per order line.
ALTER TABLE crove_finance.stock_move ADD COLUMN IF NOT EXISTS order_move text CHECK (order_move IN ('ship', 'return'));
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_type_check;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_type_check CHECK (source_type IN ('document_line', 'manual', 'reversal', 'order_line'));
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_source_ck;
-- Each source names what it comes from and nothing else: a document line its document, line and try; an order line its order line and which move it is; a manual move or a
-- reversal none of them.
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_source_ck CHECK (
  CASE source_type
    WHEN 'document_line' THEN document_id IS NOT NULL AND line_no IS NOT NULL AND line_attempt IS NOT NULL AND order_line_id IS NULL AND order_move IS NULL
    WHEN 'order_line' THEN order_line_id IS NOT NULL AND order_move IS NOT NULL AND document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL
                           AND ((order_move = 'ship' AND quantity < 0) OR (order_move = 'return' AND quantity > 0))
    ELSE document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL AND order_line_id IS NULL AND order_move IS NULL
  END
);
ALTER TABLE crove_finance.stock_move DROP CONSTRAINT IF EXISTS stock_move_order_line_fk;
ALTER TABLE crove_finance.stock_move ADD CONSTRAINT stock_move_order_line_fk FOREIGN KEY (org_id, order_line_id) REFERENCES crove_finance.channel_order_line (org_id, id);
-- One shipment and one return per order line: a re-uploaded report never moves the stock twice. Doubles as the foreign key's index.
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_order_uq ON crove_finance.stock_move (org_id, order_line_id, order_move) WHERE order_line_id IS NOT NULL;

-- A return needs the shipment it brings back, and a move of an order line is of the item the line is assigned to (the same item for both) and of the line's own legal entity. A shipment
-- is of a line that has shipped (shipped, completed, or returned, which a first report may show a line as), and a return of a line that came back (returned, or cancelled after it
-- shipped); a placed, unknown or cancelled-before-shipping line moves nothing. A move of an order line is never reversed on its own: the line's stage decides what comes back, and a
-- reversed shipment would leave the line shipped with nothing left to move.
CREATE OR REPLACE FUNCTION crove_finance.stock_move_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  IF NEW.source_type = 'reversal' AND EXISTS (
       SELECT 1 FROM crove_finance.stock_move s
       WHERE s.org_id = NEW.org_id AND s.id = NEW.reverses_move_id AND s.source_type = 'order_line') THEN
    RAISE EXCEPTION 'STOCK_ORDER_REVERSAL' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'order_line' AND NEW.order_move = 'return'
     AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_move s
       WHERE s.org_id = NEW.org_id AND s.order_line_id = NEW.order_line_id AND s.order_move = 'ship' AND s.item_id = NEW.item_id AND s.quantity = -NEW.quantity) THEN
    RAISE EXCEPTION 'STOCK_ORDER_RETURN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_move_order_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_move_order_guard ON crove_finance.stock_move;
CREATE TRIGGER stock_move_order_guard BEFORE INSERT ON crove_finance.stock_move FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_move_order_guard();
